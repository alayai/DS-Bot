import { randomUUID } from 'node:crypto'
import { refused } from './contract.js'
import { nextOccurrence, validateRepeat, taskLimits } from './task-schedule.js'
const ACTIVE = ['sending', 'running', 'unknown']
const HELD = ['paused', 'interrupted', 'needs-review', 'unknown']
const DONE = ['completed', 'failed', 'cancelled']
const prefix = 'cua-task-'
const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000
const queueOrder = (a, b) => (a.runAt ?? a.at) - (b.runAt ?? b.at) || a.at - b.at
function expired(item, now) {
  const limits = taskLimits(item), started = item.startedAt ?? item.at
  return now - started >= limits.maxRunMs ? 'Task time limit reached.'
    : now - (item.progressAt ?? started) >= limits.stallMs ? 'No progress was reported before the timeout.' : null
}
export function validateTasks(tasks, computers) {
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks) || Object.keys(tasks).length > 500) throw refused('store-invalid', 'Invalid desktop task queue.')
  for (const [id, item] of Object.entries(tasks)) {
    if (item?.repeat !== undefined) validateRepeat(item.repeat)
    if (item) taskLimits(item)
    if (!item || item.id !== id || !/^[a-f0-9-]{36}$/.test(id) || !computers[item.computerId] || computers[item.computerId].botId !== item.botId
      || !Number.isSafeInteger(item.generation) || item.generation < 1 || !Number.isFinite(item.at)
      || (item.runAt !== undefined && (!Number.isSafeInteger(item.runAt) || item.runAt < item.at || (!item.repeat && item.runAt > item.at + MAX_DELAY_MS)))
      || (item.repeat && item.runAt === undefined)
      || ['startedAt', 'progressAt', 'endedAt'].some(key => item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key] < 0))
      || (item.step !== undefined && (typeof item.step !== 'string' || item.step.length > 200))
      || (item.waitReason !== undefined && (typeof item.waitReason !== 'string' || item.waitReason.length > 500))
      || (item.progress !== undefined && (!Number.isInteger(item.progress) || item.progress < 0 || item.progress > 100))
      || (item.runs !== undefined && (!Number.isSafeInteger(item.runs) || item.runs < 0))
      || (item.resumeOnce !== undefined && (item.resumeOnce !== true || !item.repeat))
      || (item.history !== undefined && (!Array.isArray(item.history) || item.history.length > 20 || item.history.some(result =>
        !result || !['completed', 'failed'].includes(result.status) || !Number.isSafeInteger(result.at) || typeof result.note !== 'string' || result.note.length > 2000)))
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
export function createDesktopTasks(rt, { store, ready, assigned, owner, administration, barrier, controls, provider, now = Date.now }) {
  let recovered = false, ticking = false, closed = false
  const all = () => Object.values(store.snapshot()?.tasks ?? {})
  const clearAttempt = item => {
    for (const key of ['attempt', 'turnId', 'sessionId', 'startedAt', 'progressAt', 'endedAt', 'waitReason', 'progress', 'step']) delete item[key]
  }
  async function initialize() {
    await ready()
    if (!recovered) {
      recovered = true
      try { if (all().some(item => ACTIVE.includes(item.status))) await store.update(draft => { for (const item of Object.values(draft.tasks ?? {})) if (ACTIVE.includes(item.status)) {
        item.status = 'interrupted'; item.endedAt ??= now(); item.waitReason = 'DSH restarted during this attempt. Review before resuming.'
      } }) }
      catch (e) { recovered = false; throw e }
    }
    const stale = all().filter(item => !DONE.includes(item.status) && item.status !== 'interrupted' && store.snapshot()?.computers[item.computerId]?.generation !== item.generation)
    if (stale.length) await store.update(draft => { for (const item of stale) if (draft.tasks[item.id] && !DONE.includes(draft.tasks[item.id].status)) {
      Object.assign(draft.tasks[item.id], { status: 'interrupted', endedAt: now(), waitReason: 'The desktop changed. Review before resuming.' })
    } })
  }
  function guard(who) {
    const info = rt.live.get(who.sessionId)?.info
    const item = all().find(item => item.attempt === info?.exchangeId)
    if (info?.exchangeId?.startsWith(prefix) && (!item || item.status !== 'running' || item.sessionId !== who.sessionId || item.turnId !== who.turnId || store.snapshot()?.computers[item.computerId]?.generation !== item.generation)) throw refused('task-paused', 'This desktop task is no longer running. Do not replay its actions.')
    if (item?.status === 'running' && expired(item, now())) throw refused('task-paused', expired(item, now()))
    const blocking = all().find(item => item.botId === who.botId && [...ACTIVE, ...HELD].includes(item.status))
    if (blocking && (blocking.id !== item?.id || blocking.status !== 'running')) throw refused('task-paused', 'The desktop task queue is paused or owned by another turn. Review it in Private desktop.')
  }
  async function list(botId) {
    await initialize()
    const items = all().filter(item => item.botId === botId).sort(queueOrder)
    let phase
    if (items.some(item => item.status === 'queued' && (item.runAt ?? 0) <= now())) {
      try { phase = (await provider.inspect(await assigned(botId))).phase } catch { phase = 'unavailable' }
    }
    const record = Object.values(store.snapshot()?.computers ?? {}).find(r => r.botId === botId && !r.archived)
    return items.map(item => ({ ...item, elapsedMs: item.startedAt === undefined ? 0 : Math.max(0, (item.endedAt ?? now()) - item.startedAt),
      ...(item.status !== 'queued' ? {} : { queueReason: item.runAt > now() ? 'scheduled'
        : items.some(other => [...ACTIVE, ...HELD].includes(other.status)) ? 'previous-task'
          : !record || record.grant === 'off' ? 'access-off'
            : controls.get(item.computerId) !== 'none' ? 'control-held'
              : phase !== 'ready' ? 'desktop-stopped'
                : rt.live.get(rt.chatOf(botId))?.turn !== undefined ? 'bot-busy' : 'waiting-dispatch' }) }))
  }
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
        const at = now(), repeat = args.repeat === undefined ? undefined : validateRepeat(args.repeat)
        if (repeat && args.runAt !== undefined) throw refused('invalid', 'Choose either a one-time date or a repeating schedule.')
        const runAt = repeat ? nextOccurrence(repeat, at) : args.runAt
        if (runAt !== undefined) {
          if (!Number.isSafeInteger(runAt) || runAt <= at || runAt > at + MAX_DELAY_MS) {
            throw refused('invalid', 'Choose a future time within one year.')
          }
        }
        const entry = { id: randomUUID(), computerId: record.id, botId: record.botId, generation: record.generation, goal: args.goal.trim(), status: 'queued', at,
          ...taskLimits(args), ...(repeat ? { repeat } : {}), ...(runAt === undefined ? {} : { runAt }) }
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
        await store.update(draft => {
          const current = draft.tasks[item.id]
          Object.assign(current, { status: 'queued', generation: record.generation })
          clearAttempt(current)
          if (current.repeat) { current.runAt = now(); current.resumeOnce = true }
        })
        return
      }
      if (!['pause', 'cancel'].includes(method) || DONE.includes(item.status)) throw refused('invalid', 'This task cannot be changed.')
      await store.update(draft => {
        const current = draft.tasks[item.id]
        current.status = method === 'pause' ? 'paused' : 'cancelled'
        current.endedAt = now()
        current.waitReason = method === 'pause' ? 'Paused by the user.' : 'Cancelled by the user.'
      })
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
        || expired(item, now()) || rt.chatOf(item.botId) !== sessionId || controls.get(item.computerId) !== 'none') throw refused('cancelled', 'The desktop task delivery is no longer current.')
    }
    check(); return check
  }
  async function tick() {
    if (closed || ticking) return
    ticking = true
    try {
      await initialize()
      for (const item of all().filter(item => item.status === 'running' || item.status === 'sending')) {
        const reason = expired(item, now())
        if (!reason) continue
        await administration(item.botId, async () => {
          const changed = await store.update(draft => {
            const current = draft.tasks[item.id]
            if (!current || !['sending', 'running'].includes(current.status) || current.attempt !== item.attempt) return false
            current.status = 'paused'; current.waitReason = reason; current.endedAt = now(); return true
          })
          if (changed) { await barrier(await assigned(item.botId)); await stopDelivery(item); controls.set(item.computerId, 'none') }
        })
      }
      for (const botId of new Set(all().filter(item => item.status === 'queued').map(item => item.botId))) {
        const delivery = await administration(botId, async () => {
          if (all().some(item => item.botId === botId && [...ACTIVE, ...HELD].includes(item.status))) return
          const item = all().filter(item => item.botId === botId && item.status === 'queued' && (item.runAt === undefined || item.runAt <= now()))
            .sort(queueOrder)[0]
          if (!item) return
          const record = await assigned(botId)
          if (record.id !== item.computerId || record.generation !== item.generation) { await store.update(draft => { draft.tasks[item.id].status = 'interrupted' }); return }
          if (item.repeat?.missed === 'skip' && !item.resumeOnce && now() - item.runAt > 300000) {
            await store.update(draft => { draft.tasks[item.id].runAt = nextOccurrence(item.repeat, now()); draft.tasks[item.id].waitReason = 'Missed occurrence skipped.' })
            return
          }
          const sessionId = rt.chatOf(botId)
          if (!sessionId || rt.live.get(sessionId)?.turn !== undefined || record.grant === 'off' || controls.get(record.id) !== 'none' || store.snapshot()?.lifecycle?.[record.id]) return
          if ((await provider.inspect(record)).phase !== 'ready') return
          const agent = await rt.resolveAgent(sessionId)
          if ((agent.inbox?.nextTurn?.length ?? 0) || (agent.inbox?.nextStep?.length ?? 0) || rt.live.get(sessionId)?.turn !== undefined) return
          const attempt = `${prefix}${randomUUID()}`
          await store.update(draft => {
            Object.assign(draft.tasks[item.id], { status: 'sending', sessionId, attempt, startedAt: now(), progressAt: now() })
            for (const key of ['turnId', 'endedAt', 'resumeOnce', 'waitReason']) delete draft.tasks[item.id][key]
          })
          return { taskId: item.id, message: { toId: botId, sessionId, role: 'resume', exchangeId: attempt, computerTask: attempt,
              text: `Desktop task ${item.id}\n${item.goal}\n${item.note ? `Previous progress (verify before continuing): ${item.note}\n` : ''}Observe the desktop before acting. Never repeat actions whose outcome is unknown. Report meaningful progress, current step and waiting reasons with computer_task_update (taskId: ${item.id}); report an explicit completed/failed result with evidence. Progress timeout: ${taskLimits(item).stallMs / 60000} minutes; total time limit: ${taskLimits(item).maxRunMs / 60000} minutes. A turn ending does not complete the task. This task only controls Computer tools; assisted mode does not isolate other tools.` } }
        }).catch(() => null)
        if (!delivery) continue
        let timer
        try {
          await Promise.race([rt.deliver(delivery.message), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Desktop task delivery timed out.')), 30_000); timer.unref?.()
          })])
        } catch {
          await store.update(draft => { const item = draft.tasks[delivery.taskId]; if (item?.status === 'sending' && item.attempt === delivery.message.exchangeId) {
            item.status = 'unknown'; item.endedAt = now(); item.waitReason = 'Delivery result is unknown. Review before resuming.'
          } })
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
        || !['progress', 'waiting', 'completed', 'failed'].includes(args.status) || typeof args.note !== 'string' || !args.note.trim() || args.note.length > 2000
        || (args.step !== undefined && (typeof args.step !== 'string' || args.step.length > 200))
        || (args.progress !== undefined && (!Number.isInteger(args.progress) || args.progress < 0 || args.progress > 100))
        || (args.waitReason !== undefined && (typeof args.waitReason !== 'string' || args.waitReason.length > 500))) throw refused('invalid', 'Report a result for the current desktop task with a note of at most 2000 characters.')
      const done = ['completed', 'failed'].includes(args.status)
      if (done) await barrier(record)
      await store.update(draft => {
        const current = draft.tasks[item.id]
        if (current.status !== 'running' || current.attempt !== item.attempt || draft.computers[item.computerId].generation !== item.generation) throw refused('cancelled', 'The desktop task changed before its result was saved.')
        if (current.note !== args.note || (args.step !== undefined && current.step !== args.step) || (args.progress !== undefined && current.progress !== args.progress)) current.progressAt = now()
        current.note = args.note
        if (args.step !== undefined) current.step = args.step
        if (args.progress !== undefined) current.progress = args.progress
        current.waitReason = args.status === 'waiting' ? args.waitReason || args.note.slice(0, 500) : ''
        if (done) {
          current.status = args.status; current.endedAt = now(); current.runs = (current.runs ?? 0) + 1
          current.history = [...(current.history ?? []), { at: now(), status: args.status, note: args.note }].slice(-20)
          if (current.repeat && args.status === 'completed') {
            current.status = 'queued'; current.runAt = nextOccurrence(current.repeat, now())
            clearAttempt(current); delete current.note
          }
        }
      })
      if (done) { controls.set(record.id, 'none'); exec.concludeTurn?.() }
      return { status: args.status }
    })
  }
  async function endTurn(sessionId, turnId) {
    if (!recovered || !all().some(item => item.status === 'running' && item.sessionId === sessionId && item.turnId === turnId)) return
    await store.update(draft => { for (const item of Object.values(draft.tasks ?? {})) if (item.status === 'running' && item.sessionId === sessionId && item.turnId === turnId) { item.status = 'needs-review'; item.endedAt = now(); item.waitReason = 'The turn ended without an explicit result.' } })
  }
  async function interruptItems(items) {
    for (const item of items) {
      const changed = await store.update(draft => {
        if (!ACTIVE.includes(draft.tasks[item.id]?.status)) return false
        Object.assign(draft.tasks[item.id], { status: 'interrupted', endedAt: now(), waitReason: 'Desktop control was interrupted. Review before resuming.' }); return true
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
