import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const fail = code => { throw Object.assign(new Error(code), { code: `bothub/${code}` }) }
const statusOf = record => ({
  commandId: record.commandId, status: record.status === 'pending' ? 'unknown' : record.status,
  sessionId: record.sessionId, groupId: record.groupId, entityId: record.entityId,
  createdAt: record.createdAt, ...(record.error ? { error: record.error } : {}),
})
const recognized = error => typeof error?.code === 'string' && error.code.startsWith('bothub/')
  ? error.code.slice(7) : 'unavailable'

export function createMonitorCommands(rt, lifetime) {
  const path = typeof rt.home === 'string' ? join(rt.home, 'bothub-commands.json') : null
  let ledger, loading, writing = Promise.resolve()
  const active = new Map()
  const controller = () => rt.ctx.get('sessionController')
  const check = (request, writable = false) => {
    if (lifetime.aborted) fail('unavailable')
    if (writable && rt.readOnly() !== undefined) fail('read-only')
    if (request.workspaceId !== (rt.state.workspaceId ?? null)) fail('scope-changed')
    const bot = rt.own(rt.state.bots, request.entityId)
    if (!bot) fail('not-found')
    if (request.groupId !== null) {
      const room = rt.own(rt.state.rooms, request.groupId)
      if (!room?.members.includes(bot.id)) fail('not-found')
      return room.id
    }
    return rt.chatOf(bot.id)
  }
  const load = () => loading ??= (async () => {
    if (!path) fail('command-store')
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.commands) || parsed.commands.length > 2048
        || parsed.commands.some(r => !uuid(r?.commandId) || !id(r.entityId) || !id(r.sessionId)
          || !(r.groupId === null || id(r.groupId)) || !(r.workspaceId === null || id(r.workspaceId))
          || !/^[0-9a-f]{64}$/.test(r.hash) || !Number.isFinite(r.createdAt)
          || !['pending', 'accepted', 'rejected', 'unknown'].includes(r.status))
        || new Set(parsed.commands.map(r => r.commandId)).size !== parsed.commands.length) fail('command-store')
      ledger = new Map(parsed.commands.map(r => [r.commandId, r]))
    } catch (error) {
      if (error?.code !== 'ENOENT') fail('command-store')
      ledger = new Map()
    }
  })()
  const save = async next => {
    if (lifetime.aborted || rt.readOnly() !== undefined) fail('read-only')
    await mkdir(rt.home, { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, commands: [...next.values()] }), 'utf8')
        await file.sync()
      } finally { await file.close() }
      const writable = () => { if (lifetime.aborted || rt.readOnly() !== undefined) fail('read-only') }
      writable()
      await replaceFile(temp, path, writable)
      ledger = next
    } finally { await unlink(temp).catch(() => {}) }
  }
  const serial = operation => {
    const result = writing.then(operation)
    writing = result.catch(() => {})
    return result
  }
  const persist = record => serial(async () => {
    await load()
    const next = new Map(ledger)
    next.set(record.commandId, record)
    await save(next)
  })
  const evidence = async record => {
    const api = controller()
    if (!api?.projections || !api?.page) return false
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(5000)])
    const matches = message => message?.source?.kind === 'user' && message.source.rpcId === record.commandId
    const projection = await api.projections({ sessionId: record.sessionId }, signal)
    if (projection?.kind !== 'sequenced') return false
    const inbox = projection.values?.inbox
    if (['next-turn', 'next-step'].some(key => inbox?.[key]?.some(matches))) return true
    const page = await api.page({
      address: { kind: 'session', sessionId: record.sessionId },
      throughSeq: projection.asOfSeq, maxMessages: 32,
    }, signal)
    return page.records.some(row => row.type === 'event'
      && (row.event.type === 'user/message' && matches(row.event.data)
        || row.event.type === 'agent/inbox/spliced' && row.event.data?.inserted?.some(matches)))
  }
  const receipt = async commandId => {
    if (!uuid(commandId)) fail('invalid')
    await rt.refresh()
    await load()
    const record = ledger.get(commandId)
    if (!record) fail('not-found')
    check(record)
    if (active.has(commandId)) return { ...statusOf(record), status: 'submitting' }
    if (['pending', 'unknown'].includes(record.status)) {
      let found = false
      try {
        found = await evidence(record)
      } catch { /* No evidence is not evidence of non-delivery. Never replay here. */ }
      await rt.refresh()
      check(record)
      if (found) {
        const accepted = { ...record, status: 'accepted' }
        if (rt.readOnly() === undefined) await persist(accepted).catch(() => {})
        check(record)
        return statusOf(accepted)
      }
    }
    return statusOf(record)
  }
  const send = async request => {
    if (!uuid(request?.commandId) || !id(request.entityId)
      || !(request.groupId === null || id(request.groupId))
      || !(request.workspaceId === null || id(request.workspaceId))
      || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4000) fail('invalid')
    const text = request.text.trim()
    const hash = createHash('sha256').update(JSON.stringify([request.workspaceId, request.entityId, request.groupId, text])).digest('hex')
    await rt.refresh()
    check(request, true)
    if (!controller()?.prompt) fail('send-unavailable')
    const running = active.get(request.commandId)
    if (running) {
      if (running.hash !== hash) fail('command-conflict')
      return running.promise
    }
    if (active.size >= 32) fail('command-busy')
    const execute = async () => {
      const reserved = await serial(async () => {
        await load()
        const existing = ledger.get(request.commandId)
        if (existing) {
          if (existing.hash !== hash) fail('command-conflict')
          return { record: existing, fresh: false }
        }
        if (ledger.size >= 2048) fail('command-capacity')
        const record = {
          commandId: request.commandId, workspaceId: request.workspaceId,
          entityId: request.entityId, groupId: request.groupId, hash,
          sessionId: check(request, true), status: 'pending', createdAt: Date.now(),
        }
        const next = new Map(ledger)
        next.set(record.commandId, record)
        await save(next)
        return { record, fresh: true }
      })
      const { record } = reserved
      if (!reserved.fresh) return statusOf(record)
      let dispatched = false
      try {
        await rt.ensureCapabilities(record.sessionId)
        if (check(request, true) !== record.sessionId) fail('target-changed')
        dispatched = true
        const result = await controller().prompt({
          requestId: record.commandId, sessionId: record.sessionId, mode: 'queue',
          content: [{ type: 'text', text }],
        }, AbortSignal.any([lifetime, AbortSignal.timeout(30000)]))
        if (result?.accepted !== true) fail('unavailable')
        const accepted = { ...record, status: 'accepted' }
        await persist(accepted)
        return statusOf(accepted)
      } catch (error) {
        const result = { ...record, status: dispatched ? 'unknown' : 'rejected',
          ...(dispatched ? {} : { error: recognized(error) }) }
        await persist(result).catch(() => {})
        return statusOf(result)
      }
    }
    const promise = execute().finally(() => active.delete(request.commandId))
    active.set(request.commandId, { hash, promise })
    return promise
  }
  return { send, receipt }
}
