import { randomUUID } from 'node:crypto'
import { cursorOf, diffSnapshot, hasChanges, streamVersion } from '../shared/sync.js'

const encoder = new TextEncoder()
const errorResponse = (error, status = 503) => new Response(JSON.stringify({ error }), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})
const frameBytes = (event, value) => encoder.encode(
  `${event === 'patch' || event === 'snapshot' ? `id: ${cursorOf(value)}\n` : ''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)

export function createMonitorFeed(getService, environment = globalThis, limits = {}) {
  const options = { entries: 128, bytes: 1024 * 1024, queueBytes: 1024 * 1024,
    clients: 16, pollMs: 5000, heartbeatMs: 15000, leaseMs: 60000, ...limits }
  const clients = new Set()
  let disposed = false, generation = 0, revision = 0, collecting, readController, current, service, epoch, scopeKey, seq = 0
  let history = [], historyBytes = 0, pollTimer, notifyTimer, heartbeatTimer

  const envelope = () => ({ schemaVersion: streamVersion, scopeKey, epoch, seq })
  const stopTimers = () => {
    environment.clearTimeout(pollTimer)
    environment.clearTimeout(notifyTimer)
    environment.clearTimeout(heartbeatTimer)
    pollTimer = notifyTimer = heartbeatTimer = undefined
  }
  const leave = client => {
    clients.delete(client)
    client.signal.removeEventListener('abort', client.abort)
    environment.clearTimeout(client.lease)
    try { client.controller.close() } catch { /* already cancelled */ }
    if (!clients.size) { stopTimers(); readController?.abort() }
  }
  const send = (client, bytes) => {
    if (!clients.has(client)) return
    if ((client.controller.desiredSize ?? 0) < bytes.byteLength) { leave(client); return }
    try { client.controller.enqueue(bytes) } catch { leave(client) }
  }
  const broadcast = bytes => { for (const client of clients) send(client, bytes) }
  const reset = () => {
    current = service = undefined
    epoch = scopeKey = undefined
    seq = 0
    history = []
    historyBytes = 0
  }
  const fail = error => {
    const code = ['bridge-missing', 'incompatible'].includes(error.message) ? error.message : 'unavailable'
    broadcast(frameBytes('fault', { error: code }))
    for (const client of clients) leave(client)
    reset()
  }
  const read = () => {
    if (collecting) return collecting
    const own = generation
    const startedRevision = revision
    const source = getService()
    const controller = new AbortController()
    readController = controller
    const timeout = environment.setTimeout(() => controller.abort(), 9000)
    const task = (async () => {
      if (!source) throw new Error('bridge-missing')
      if (source.version !== 2) throw new Error('incompatible')
      const snapshot = await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('unavailable'))
        controller.signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => source.snapshot()).then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', abort))
      })
      if (disposed || own !== generation) throw new Error('unavailable')
      if (getService() !== source) throw new Error('bridge-missing')
      if (snapshot?.version !== 2) throw new Error('incompatible')
      if (!current || service !== source || snapshot.workspaceId !== current.workspaceId
        || snapshot.readOnly !== current.readOnly) {
        epoch = randomUUID()
        scopeKey = randomUUID()
        seq = 0
        history = []
        historyBytes = 0
        service = source
        current = snapshot
        broadcast(frameBytes('snapshot', { ...envelope(), snapshot }))
        broadcast(frameBytes('ready', { ...envelope(), capturedAt: current.capturedAt }))
      } else {
        const patch = diffSnapshot(current, snapshot)
        const changed = hasChanges(patch, current)
        current = snapshot
        if (changed) {
          seq++
          const bytes = frameBytes('patch', { ...envelope(), ...patch })
          history.push({ seq, bytes })
          historyBytes += bytes.byteLength
          while (history.length > options.entries || historyBytes > options.bytes) {
            historyBytes -= history.shift().bytes.byteLength
          }
          broadcast(bytes)
        }
      }
      return current
    })()
    collecting = task
    task.finally(() => {
      environment.clearTimeout(timeout)
      if (readController === controller) readController = undefined
      if (collecting === task) collecting = undefined
      if (revision !== startedRevision) queueRead()
    }).catch(() => {})
    return task
  }

  const schedule = () => {
    if (!clients.size || disposed) return
    if (pollTimer === undefined) pollTimer = environment.setTimeout(async () => {
      pollTimer = undefined
      try { await read() } catch (error) { fail(error) }
      schedule()
    }, options.pollMs)
    if (heartbeatTimer === undefined) heartbeatTimer = environment.setTimeout(() => {
      heartbeatTimer = undefined
      broadcast(frameBytes('ready', { ...envelope(), capturedAt: current?.capturedAt }))
      schedule()
    }, options.heartbeatMs)
  }

  function queueRead() {
    if (disposed || !clients.size || notifyTimer !== undefined) return
    notifyTimer = environment.setTimeout(async () => {
      notifyTimer = undefined
      try { await read() } catch (error) { fail(error) }
    }, 150)
  }

  return {
    invalidate() {
      if (!clients.size || disposed) return
      revision++
      queueRead()
    },
    async open(request) {
      if (request.headers.get('sec-fetch-site') === 'cross-site') return errorResponse('forbidden', 403)
      if (request.method !== 'GET') return errorResponse('method', 405)
      if (disposed || request.signal.aborted) return errorResponse('unavailable')
      if (clients.size >= options.clients) return errorResponse('stream-busy', 429)
      try { await read() } catch (error) {
        fail(error)
        return errorResponse(['bridge-missing', 'incompatible'].includes(error.message) ? error.message : 'unavailable',
          error.message === 'incompatible' ? 409 : 503)
      }
      if (disposed || request.signal.aborted || clients.size >= options.clients) return errorResponse('unavailable')
      let client
      const body = new ReadableStream({
        start(controller) {
          client = { controller, signal: request.signal, abort: () => leave(client) }
          clients.add(client)
          request.signal.addEventListener('abort', client.abort, { once: true })
          const cursor = request.headers.get('last-event-id')
          const colon = cursor?.lastIndexOf(':') ?? -1
          const previous = colon >= 0 ? Number(cursor.slice(colon + 1)) : -1
          const replay = history.filter(item => item.seq > previous)
          const resume = cursor?.slice(0, colon) === epoch && Number.isSafeInteger(previous)
            && previous >= 0 && previous <= seq
            && (previous === seq || replay[0]?.seq === previous + 1)
          if (resume) for (const item of replay) send(client, item.bytes)
          else send(client, frameBytes('snapshot', { ...envelope(), snapshot: current }))
          send(client, frameBytes('ready', { ...envelope(), capturedAt: current.capturedAt }))
          // Reopening periodically lets the authenticated carrier recheck expiry.
          if (clients.has(client)) client.lease = environment.setTimeout(() => leave(client), options.leaseMs)
          schedule()
        },
        cancel() { if (client) leave(client) },
      }, { highWaterMark: options.queueBytes, size: chunk => chunk.byteLength })
      return new Response(body, { headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      } })
    },
    dispose() {
      disposed = true
      generation++
      readController?.abort()
      for (const client of clients) leave(client)
      stopTimers()
      reset()
    },
  }
}
