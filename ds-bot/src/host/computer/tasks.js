import { randomUUID } from 'node:crypto'
import { refused } from './contract.js'
const ACTIVE = ['sending', 'running', 'unknown']
const HELD = ['paused', 'interrupted', 'needs-review', 'unknown']
const DONE = ['completed', 'failed', 'cancelled']
const prefix = 'cua-task-'
export function validateTasks(tasks, computers) {
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks) || Object.keys(tasks).length > 500) throw refused('store-invalid', 'Invalid desktop task queue.')
  for (const [id, item] of Object.entries(tasks)) {
    if (!item || item.id !== id || !/^[a-f0-9-]{36}$/.test(id) || !computers[item.computerId] || computers[item.computerId].botId !== item.botId
      || !Number.isSafeInteger(item.generation) || item.generation < 1 || !Number.isFinite(item.at)
      || !['queued', ...ACTIVE, ...HELD, ...DONE].includes(item.status)
      || typeof item.goal !== 'string' || !item.goal.trim() || item.goal.length > 4000
      || (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 2000))
      || (item.attempt !== undefined && !/^cua-task-[a-f0-9-]{36}$/.test(item.attempt))
      || (item.sessionId !== undefined && typeof item.sessionId !== 'string')
      || (ACTIVE.includes(item.status) && (!item.attempt || !item.sessionId))
      || (item.status === 'running' && !Number.isSafeInteger(item.turnId))
      || (item.turnId !== undefined && !Number.isSafeInteger(item.turnId))) throw refused('store-invalid', 'Invalid desktop task record.')
  }
}
export function createDesktopTasks(rt, { store, ready, assigned, owner, administration, barrier, controls, provider }) {
  let recovered = false, ticking = false, closed = false
  const all = () => Object.values(store.snapshot()?.tasks ?? {})
  async function initialize() {
    await ready()
    if (!recovered) {
      recovered = true
      try { if (all().some(item => ACTIVE.includes(item.status))) await store.update(draft => { for (const item of Object.values(draft.tasks ?? {})) if (ACTIVE.includes(item.status)) item.status = 'interrupted' }) }
      catch (e) { recovered = false; throw e }
    }
    const stale = all().filter(item => !DONE.includes(item.status) && item.status !== 'interrupted' && store.snapshot()?.computers[item.computerId]?.generation !== item.generation)
    if (stale.length) await store.update(draft => { for (const item of stale) if (draft.tasks[item.id] && !DONE.includes(draft.tasks[item.id].status)) draft.tasks[item.id].status = 'interrupted' })
  }
  function guard(who) {
    const info = rt.live.get(who.sessionId)?.info
    const item = all().find(item => item.attempt === info?.exchangeId)
    if (info?.exchangeId?.startsWith(prefix) && (!item || item.status !== 'running' || item.sessionId !== who.sessionId || item.turnId !== who.turnId || store.snapshot()?.computers[item.computerId]?.generation !== item.generation)) throw refused('task-paused', 'This desktop task is no longer running. Do not replay its actions.')
    const blocking = all().find(item => item.botId === who.botId && [...ACTIVE, ...HELD].includes(item.status))
    if (blocking && (blocking.id !== item?.id || blocking.status !== 'running')) throw refused('task-paused', 'The desktop task queue is paused or owned by another turn. Review it in Private desktop.')
  }
  async function list(botId) { await initialize(); return all().filter(item => item.botId === botId).sort((a, b) => a.at - b.at) }
  async function stopDelivery(item) {
    if (!item.sessionId || !item.attempt) return
    const agent = await rt.resolveAgent(item.sessionId)
    for (const message of [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]) {
      if (message.source?.exchangeId === item.attempt) agent.inbox.remove(message.id)
    }
    const live = rt.live.get(item.sessionId)
    if (live?.info?.exchangeId === item.attempt && (item.turnId === undefined || live.turn === item.turnId)) await agent.cancel({ kind: 'user' })
    await rt.ctx.sessions.flush(agent.session)
  }
  async function command(method, args) {
    await initialize()
    await administration(args.botId, async () => {
      const record = await assigned(args.botId)
      if (record.generation !== args.expectedGeneration) throw refused('stale-generation', 'Refresh the desktop task queue.')
      const item = store.snapshot()?.tasks?.[args.id]
      if (method === 'add') {
        if (typeof args.goal !== 'string' || !args.goal.trim() || args.goal.length > 4000) throw refused('invalid', 'Enter a desktop task of at most 4000 characters.')
        if (all().length >= 500) throw refused('resource-limit', 'Clear completed desktop tasks before adding another.')
        const entry = { id: randomUUID(), computerId: record.id, botId: record.botId, generation: record.generation, goal: args.goal.trim(), status: 'queued', at: Date.now() }
        await store.update(draft => { draft.tasks ??= {}; draft.tasks[entry.id] = entry })
        return
      }
      if (!item || item.botId !== record.botId || item.computerId !== record.id) throw refused('invalid', 'Unknown desktop task.')
      if (method === 'remove') {
        if (!DONE.includes(item.status)) throw refused('invalid', 'Only finished tasks can be removed.')
        // Keep a tombstone for any old delivery id in the conversation: the prefix guard rejects it.
        await store.update(draft => { delete draft.tasks[item.id] }); return
      }
      if (method === 'resume') {
        if (![...HELD, 'failed'].includes(item.status) || args.confirm !== true) throw refused('invalid', 'Review the desktop and confirm resuming this task.')
        await stopDelivery(item)
        if (rt.live.get(item.sessionId)?.turn !== undefined) throw refused('busy', 'Wait for the previous Bot turn to finish before resuming.')
        if ((await provider.inspect(record)).phase !== 'ready' || controls.get(record.id) !== 'none') throw refused('not-ready', 'Start the desktop and give back control before resuming.')
        await store.update(draft => { Object.assign(draft.tasks[item.id], { status: 'queued', generation: record.generation }); delete draft.tasks[item.id].attempt; delete draft.tasks[item.id].turnId; delete draft.tasks[item.id].sessionId })
        return
      }
      if (!['pause', 'cancel'].includes(method) || DONE.includes(item.status)) throw refused('invalid', 'This task cannot be changed.')
      await store.update(draft => { draft.tasks[item.id].status = method === 'pause' ? 'paused' : 'cancelled' })
      if (item.attempt) {
        await barrier(record)
        await stopDelivery(item)
        controls.set(record.id, 'none')
      }
    })
    return list(args.botId)
  }
  async function validateDelivery(attempt, sessionId) {
    await initialize()
    const check = () => {
      const item = all().find(item => item.attempt === attempt), snapshot = store.snapshot()
      if (closed || rt.readOnly() !== undefined || !item || item.status !== 'sending' || item.sessionId !== sessionId
        || snapshot.computers[item.computerId]?.generation !== item.generation || snapshot.computers[item.computerId]?.archived
        || rt.chatOf(item.botId) !== sessionId || controls.get(item.computerId) !== 'none') throw refused('cancelled', 'The desktop task delivery is no longer current.')
    }
    check(); return check
  }
  async function tick() {
    if (closed || ticking) return
    ticking = true
    try {
      await initialize()
      for (const botId of new Set(all().filter(item => item.status === 'queued').map(item => item.botId))) {
        const delivery = await administration(botId, async () => {
          if (all().some(item => item.botId === botId && [...ACTIVE, ...HELD].includes(item.status))) return
          const item = all().find(item => item.botId === botId && item.status === 'queued'), record = await assigned(botId)
          if (!item) return
          if (record.id !== item.computerId || record.generation !== item.generation) { await store.update(draft => { draft.tasks[item.id].status = 'interrupted' }); return }
          const sessionId = rt.chatOf(botId)
          if (!sessionId || rt.live.get(sessionId)?.turn !== undefined || record.grant === 'off' || controls.get(record.id) !== 'none' || store.snapshot()?.lifecycle?.[record.id]) return
          if ((await provider.inspect(record)).phase !== 'ready') return
          const agent = await rt.resolveAgent(sessionId)
          if ((agent.inbox?.nextTurn?.length ?? 0) || (agent.inbox?.nextStep?.length ?? 0) || rt.live.get(sessionId)?.turn !== undefined) return
          const attempt = `${prefix}${randomUUID()}`
          await store.update(draft => { Object.assign(draft.tasks[item.id], { status: 'sending', sessionId, attempt }); delete draft.tasks[item.id].turnId })
          return { taskId: item.id, message: { toId: botId, sessionId, role: 'resume', exchangeId: attempt, computerTask: attempt,
              text: `Desktop task ${item.id}\n${item.goal}\n${item.note ? `Previous progress (verify before continuing): ${item.note}\n` : ''}Observe the desktop before acting. Never repeat actions whose outcome is unknown. Report progress and an explicit completed/failed result with computer_task_update (taskId: ${item.id}). A turn ending does not complete the task. This task only controls Computer tools; assisted mode does not isolate other tools.` } }
        }).catch(() => null)
        if (!delivery) continue
        let timer
        try {
          await Promise.race([rt.deliver(delivery.message), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Desktop task delivery timed out.')), 30_000); timer.unref?.()
          })])
        } catch {
          await store.update(draft => { const item = draft.tasks[delivery.taskId]; if (item?.status === 'sending' && item.attempt === delivery.message.exchangeId) item.status = 'unknown' })
        } finally { clearTimeout(timer) }
      }
    } finally { ticking = false }
  }
  async function enter(agent) {
    await initialize()
    const sessionId = agent?.session?.id ?? agent?.id, live = rt.live.get(sessionId)
    if (!live?.info?.exchangeId?.startsWith(prefix)) return
    const item = all().find(item => item.attempt === live.info.exchangeId)
    if (!item || !['sending', 'running'].includes(item.status) || item.sessionId !== sessionId) return
    const record = await assigned(item.botId)
    if (record.id !== item.computerId || record.generation !== item.generation || !Number.isSafeInteger(live.turn) || (item.status === 'running' && item.turnId !== live.turn)) return
    await store.update(draft => { const current = draft.tasks[item.id]; if ((current.status === 'sending' || (current.status === 'running' && current.turnId === live.turn)) && current.attempt === live.info.exchangeId) { current.status = 'running'; current.turnId = live.turn } })
  }
  async function report(args, exec) {
    await initialize(); const who = owner(exec)
    return administration(who.botId, async () => {
      const item = store.snapshot()?.tasks?.[args.taskId], record = await assigned(who.botId)
      guard(who)
      if (!item || item.status !== 'running' || item.botId !== who.botId || item.sessionId !== who.sessionId || item.turnId !== who.turnId || item.generation !== record.generation
        || !['progress', 'completed', 'failed'].includes(args.status) || typeof args.note !== 'string' || !args.note.trim() || args.note.length > 2000) throw refused('invalid', 'Report a result for the current desktop task with a note of at most 2000 characters.')
      if (args.status !== 'progress') await barrier(record)
      await store.update(draft => { const current = draft.tasks[item.id]; if (current.status !== 'running' || current.attempt !== item.attempt || draft.computers[item.computerId].generation !== item.generation) throw refused('cancelled', 'The desktop task changed before its result was saved.'); current.note = args.note; if (args.status !== 'progress') current.status = args.status })
      if (args.status !== 'progress') { controls.set(record.id, 'none'); exec.concludeTurn?.() }
      return { status: args.status }
    })
  }
  async function endTurn(sessionId, turnId) {
    if (!recovered || !all().some(item => item.status === 'running' && item.sessionId === sessionId && item.turnId === turnId)) return
    await store.update(draft => { for (const item of Object.values(draft.tasks ?? {})) if (item.status === 'running' && item.sessionId === sessionId && item.turnId === turnId) item.status = 'needs-review' })
  }
  async function interruptItems(items) {
    for (const item of items) {
      const changed = await store.update(draft => {
        if (!ACTIVE.includes(draft.tasks[item.id]?.status)) return false
        draft.tasks[item.id].status = 'interrupted'; return true
      })
      if (!changed) continue
      const record = await assigned(item.botId)
      await barrier(record); await stopDelivery(item); controls.set(record.id, 'none')
    }
  }
  async function interrupt(sessionId) {
    if (!recovered) return
    await interruptItems(all().filter(item => item.sessionId === sessionId && ACTIVE.includes(item.status)))
  }
  async function interruptComputer(id) {
    await initialize()
    await interruptItems(all().filter(item => item.computerId === id && ACTIVE.includes(item.status)))
  }
  return { list, command, tick, enter, guard, report, endTurn, interrupt, interruptComputer, validateDelivery, dispose: () => { closed = true } }
}
