const savedKey = 'dsh-bothub.pending-messages'
const empty = Object.freeze({ draft: '', phase: 'idle', command: null, receipt: null, error: null })
export const messageKey = target => JSON.stringify([target.workspaceId, target.entityId, target.groupId])
const rejected = new Set(['invalid', 'read-only', 'not-found', 'scope-changed', 'command-conflict',
  'target-changed', 'command-capacity', 'command-busy', 'command-store', 'send-unavailable', 'unauthorized'])

export async function messageRequest(payload, signal) {
  const response = await fetch('api/bothub', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = rejected.has(body?.error) ? body.error
      : [401, 403].includes(response.status) ? 'unauthorized' : 'unavailable'
    throw Object.assign(new Error(code), { code })
  }
  if (!body?.receipt || body.receipt.commandId !== payload.commandId
    || !['submitting', 'unknown', 'rejected', 'accepted'].includes(body.receipt.status)
    || typeof body.receipt.sessionId !== 'string') throw new Error('unavailable')
  return body.receipt
}

export function createMessageStore(call = messageRequest, environment = globalThis) {
  let entries = new Map(), disposed = false
  const listeners = new Set(), requests = new Set()
  try {
    const saved = JSON.parse(environment.sessionStorage.getItem(savedKey) ?? '[]')
    if (Array.isArray(saved)) for (const command of saved.slice(0, 64)) {
      if (typeof command?.commandId !== 'string' || command.commandId.length !== 36
        || typeof command.entityId !== 'string' || command.entityId.length > 256
        || !(command.groupId === null || typeof command.groupId === 'string' && command.groupId.length <= 256)
        || !(command.workspaceId === null || typeof command.workspaceId === 'string' && command.workspaceId.length <= 256)) continue
      const target = { commandId: command.commandId, entityId: command.entityId, groupId: command.groupId, workspaceId: command.workspaceId }
      entries.set(messageKey(target), { ...empty, command: target, phase: 'unknown', restore: true })
    }
  } catch { /* Drafts and sending still work when session storage is unavailable. */ }
  const get = target => entries.get(messageKey(target)) ?? empty
  const capacity = target => entries.has(messageKey(target)) || entries.size < 64
  const publish = (target, value) => {
    if (disposed || !capacity(target)) return
    entries = new Map(entries)
    if (value === empty) entries.delete(messageKey(target))
    else entries.set(messageKey(target), value)
    try {
      environment.sessionStorage.setItem(savedKey, JSON.stringify([...entries.values()].flatMap(entry => entry.command ? [entry.command] : [])))
    } catch { /* Only identifiers are saved; message text stays in memory. */ }
    for (const listener of listeners) listener()
  }
  const perform = async (target, action) => {
    const current = get(target)
    if (disposed || !capacity(target) || current.phase === 'submitting' || current.checking) return
    if (action === 'send' && (current.phase === 'unknown' || !current.draft.trim() || current.draft.length > 4000)) return
    const command = action === 'send'
      ? { ...target, commandId: environment.crypto.randomUUID() } : current.command
    if (!command) return
    const controller = new AbortController()
    requests.add(controller)
    const timeout = environment.setTimeout(() => controller.abort(), 40000)
    publish(target, { ...current, command, restore: false, error: null,
      ...(action === 'send' ? { phase: 'submitting', receipt: null } : { checking: true }) })
    try {
      const receipt = await call(action === 'send'
        ? { action, ...command, text: current.draft } : { action, commandId: command.commandId }, controller.signal)
      if (disposed) return
      if (receipt.commandId !== command.commandId || receipt.entityId !== target.entityId || receipt.groupId !== target.groupId) throw new Error('unavailable')
      const phase = receipt.status === 'submitting' ? 'unknown' : receipt.status
      publish(target, { ...get(target), phase, receipt, checking: false,
        draft: phase === 'accepted' ? '' : current.draft,
        error: phase === 'rejected' ? rejected.has(receipt.error) ? receipt.error : 'unavailable' : null })
      return receipt
    } catch (error) {
      const refused = action === 'send' && rejected.has(error.code)
      publish(target, { ...get(target), phase: refused ? 'rejected' : 'unknown', checking: false,
        command: refused ? null : command, error: refused ? error.code : 'receipt-unknown' })
    } finally {
      environment.clearTimeout(timeout)
      requests.delete(controller)
    }
  }
  return {
    getSnapshot: () => entries,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    get, capacity,
    draft(target, draft) {
      const current = get(target)
      if (['submitting', 'unknown'].includes(current.phase) || current.checking) return
      publish(target, { ...empty, draft: draft.slice(0, 4000) })
    },
    send: target => perform(target, 'send'),
    check: target => perform(target, 'receipt'),
    clear(target) {
      if (get(target).phase === 'submitting' || get(target).checking) return
      publish(target, empty)
    },
    dispose() {
      disposed = true
      for (const controller of requests) controller.abort()
      listeners.clear()
      entries.clear()
    },
  }
}
