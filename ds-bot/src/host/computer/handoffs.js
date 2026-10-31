import { createHash } from 'node:crypto'
import { refused } from './contract.js'

const open = item => ['pending', 'queued', 'sending', 'unknown'].includes(item.status)
const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex')

export function createComputerHandoffs(rt, { store, ready, owner, assigned, available, barrier, administration, human, hasHuman, controls, stillOwns, claim }) {
  const cancellations = new Map()
  const cancelled = new Set()
  const stamp = item => JSON.stringify([item.sourceSessionId, item.roomId, destination(item)].map(id => cancellations.get(id) ?? 0))
  function destination(item) {
    if (!rt.botOf(item.botId)) return undefined
    if (item.roomId) {
      const room = rt.roomOf(item.roomId)
      if (rt.botOf(item.botId).private || !room?.members?.includes(item.botId)) return undefined
      return room.sessions?.[item.botId]
    }
    return rt.chatOf?.(item.botId)
  }
  async function list() {
    const snapshot = await store.load()
    return Object.values(snapshot.handoffs ?? {}).filter(item => open(item) && destination(item) && snapshot.computers[item.computerId]?.generation === item.generation && !snapshot.computers[item.computerId]?.archived).map(item => ({
      id: item.id, botId: item.botId, sourceSessionId: item.sourceSessionId,
      ...(item.roomId ? { roomId: item.roomId } : {}),
      reason: item.reason, note: item.note, status: item.status, outcome: item.outcome, at: item.at,
    }))
  }
  async function request(args, exec) {
    await ready()
    const who = owner(exec)
    if (!['login', 'captcha', 'payment', 'other'].includes(args.reason)
      || typeof args.note !== 'string' || !args.note.trim() || args.note.length > 1000
      || typeof exec.callId !== 'string' || !exec.callId) throw refused('invalid', 'Provide a reason and a note of at most 1000 characters.')
    return administration(who.botId, async () => {
      const record = await assigned(who.botId)
      const id = digest([record.id, record.generation, who.sessionId, who.turnId, exec.callId])
      const snapshot = await store.load()
      const previous = snapshot.handoffs?.[id]
      if (previous) {
        if (previous.reason !== args.reason || previous.note !== args.note) throw refused('conflict', 'This takeover request already has different content.')
        exec.concludeTurn?.()
        return { requestId: id, status: previous.status }
      }
      await stillOwns(record, who)
      exec.signal?.throwIfAborted()
      available(record)
      claim(record, who)
      if (Object.values(snapshot.handoffs ?? {}).some(item => item.computerId === record.id && open(item))) throw refused('busy', 'A desktop help request is already open.')
      const group = rt.groupOwners.get(who.sessionId)
      const work = rt.workOf?.(rt.live.get(who.sessionId)?.info)
      const item = {
        id, computerId: record.id, generation: record.generation, botId: who.botId,
        sourceSessionId: who.sessionId, turnId: who.turnId,
        ...(group ? { roomId: group.roomId } : {}), ...(work ? { work } : {}),
        reason: args.reason, note: args.note, status: 'pending', at: Date.now(),
      }
      const version = stamp(item)
      await store.update(draft => {
        exec.signal?.throwIfAborted()
        if (version !== stamp(item)) throw refused('cancelled', 'The desktop request was cancelled.')
        draft.handoffs ??= {}
        if (Object.keys(draft.handoffs).length >= 1000) throw refused('journal-full', 'The desktop help journal is full.')
        draft.handoffs[id] = item
        draft.computers[record.id].humanPaused = true
      })
      await barrier(record, 'human')
      if (version !== stamp(item)) throw refused('cancelled', 'The desktop request was cancelled.')
      exec.concludeTurn?.()
      return { requestId: id, status: 'pending', text: 'The desktop is paused. The user can open Private desktop, take control, then choose Done or Skip. End this turn and wait.' }
    })
  }
  async function seen(item, agent) {
    const messages = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]
    if (messages.some(message => message.source?.exchangeId === item.id)) return true
    if (!rt.eventsBackwards) return false
    for await (const event of rt.eventsBackwards(item.targetSessionId, AbortSignal.timeout(10_000), Infinity)) {
      if (event.type === 'user/message' && event.data?.source?.exchangeId === item.id) return true
    }
    return false
  }
  async function answer(args) {
    await ready()
    return administration(args.botId, async () => {
      const record = await assigned(args.botId)
      let item = (await store.load()).handoffs?.[args.requestId]
      if (!item || item.botId !== args.botId) throw refused('invalid', 'Unknown desktop help request.')
      if (!['done', 'skip'].includes(args.outcome)) throw refused('invalid', 'Choose done or skip.')
      if (item.outcome && item.outcome !== args.outcome) throw refused('conflict', 'This request already has a different answer.')
      if (item.status === 'delivered') return { status: 'delivered' }
      const version = stamp(item)
      const targetSessionId = destination(item)
      if (item.status === 'cancelled' || !targetSessionId || record.generation !== item.generation
        || record.id !== item.computerId || record.archived) throw refused('stale-generation', 'This desktop request is no longer current.')
      if (item.status === 'pending') {
        if (args.outcome === 'done' || hasHuman(record.id)) human(record, args.controlToken)
        await barrier(record)
        await store.update(draft => {
          if (version !== stamp(item) || draft.handoffs[item.id].status !== 'pending') throw refused('cancelled', 'The desktop request was cancelled.')
          draft.computers[record.id].humanPaused = false
          Object.assign(draft.handoffs[item.id], { status: 'queued', outcome: args.outcome, targetSessionId })
        })
        controls.set(record.id, 'none')
        item = (await store.load()).handoffs[item.id]
      }
      if (item.targetSessionId !== targetSessionId) throw refused('stale-generation', 'The conversation changed during delivery. Continue in the chat.')
      const agent = await rt.resolveAgent(targetSessionId)
      if (item.status === 'sending' || item.status === 'unknown') {
        if (await seen(item, agent)) {
          await store.update(draft => { if (draft.handoffs[item.id].status !== 'cancelled') draft.handoffs[item.id].status = 'delivered' })
          return { status: 'delivered' }
        }
        throw refused('result-unknown', 'The continuation may have been sent. It will not be replayed; continue in the original chat.')
      }
      await rt.ensureCapabilities?.(targetSessionId)
      const current = await assigned(item.botId)
      if (current.generation !== item.generation || current.id !== item.computerId || destination(item) !== targetSessionId) {
        throw refused('stale-generation', 'The desktop or conversation changed before delivery.')
      }
      await store.update(draft => {
        if (version !== stamp(item) || draft.handoffs[item.id].status !== 'queued') throw refused('cancelled', 'The desktop request was cancelled.')
        draft.handoffs[item.id].status = 'sending'
      })
      try {
        await rt.deliver({
          toId: item.botId, sessionId: targetSessionId, exchangeId: item.id, computerHandoff: item.id,
          ...(item.roomId ? { role: 'room', roomId: item.roomId, note: 'desktop help answered' } : { role: 'resume', ...(item.work ? { work: item.work } : {}) }),
          text: `The user ${item.outcome === 'done' ? 'reports completing' : 'skipped'} your desktop help request (${item.reason}): ${item.note}\nObserve the desktop again before acting. This answer is not evidence that an operation succeeded.`,
        })
        await store.update(draft => { if (draft.handoffs[item.id].status !== 'cancelled') draft.handoffs[item.id].status = 'delivered' })
      } catch {
        await store.update(draft => { if (draft.handoffs[item.id].status !== 'cancelled') draft.handoffs[item.id].status = 'unknown' })
        throw refused('result-unknown', 'The continuation outcome is unknown. Retry only to check delivery; input will not be replayed.')
      }
      return { status: 'delivered' }
    })
  }
  async function validateDelivery(id, sessionId) {
    await ready()
    const item = (await store.load()).handoffs?.[id]
    if (!item || !['sending', 'unknown', 'delivered'].includes(item.status) || item.targetSessionId !== sessionId) {
      throw refused('cancelled', 'The desktop continuation is no longer pending.')
    }
    const record = await assigned(item.botId)
    if (record.id !== item.computerId || record.generation !== item.generation) throw refused('stale-generation', 'The desktop changed before continuation.')
    const version = stamp(item)
    // Delivery calls this synchronously immediately before inbox insertion, including restart resends.
    return () => {
      const latest = store.snapshot()
      if (cancelled.has(id) || latest?.handoffs?.[id]?.status === 'cancelled'
        || latest?.computers?.[record.id]?.generation !== record.generation
        || rt.readOnly() !== undefined || version !== stamp(item) || destination(item) !== sessionId || controls.get(record.id) !== 'none') {
        throw refused('cancelled', 'The desktop continuation was cancelled or its destination changed.')
      }
    }
  }
  async function cancel(sessionId) {
    cancellations.set(sessionId, (cancellations.get(sessionId) ?? 0) + 1)
    const snapshot = store.snapshot() ?? await store.load()
    const matches = Object.values(snapshot.handoffs ?? {}).filter(item => open(item) && [item.sourceSessionId, item.roomId, item.targetSessionId, destination(item)].includes(sessionId))
    for (const item of matches) cancelled.add(item.id)
    for (const item of matches) {
      await store.update(draft => {
        const current = draft.handoffs[item.id]
        if (open(current)) current.status = 'cancelled'
      })
    }
  }
  return { list, request, answer, cancel, validateDelivery }
}
