// Optional bench instrumentation. It never reads headers, query strings, bodies
// or socket payloads, and does not change HTTP timeout/connection behavior.
import { channel } from 'node:diagnostics_channel'
import { appendFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'

export function httpDiagnostics(file) {
  let stopped = false, sequence = 0
  const sockets = new WeakMap()
  const requests = new WeakMap()
  const subscriptions = []
  const listeners = new Set()
  const write = value => {
    if (stopped) return
    try { appendFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid, ...value }) + '\n', { mode: 0o600 }) }
    catch { /* A diagnostic file failure must not change the request outcome. */ }
  }
  const once = (target, name, listener) => {
    const remove = () => { target.removeListener(name, wrapped); listeners.delete(remove) }
    const wrapped = (...args) => { remove(); listener(...args) }
    listeners.add(remove)
    target.once(name, wrapped)
    return remove
  }
  const socketId = socket => {
    if (!sockets.has(socket)) {
      const id = ++sequence
      sockets.set(socket, id)
      const end = once(socket, 'end', () => write({ event: 'socket-end', socket: id }))
      once(socket, 'close', hadError => { end(); write({ event: 'socket-close', socket: id, hadError: Boolean(hadError) }) })
    }
    return sockets.get(socket)
  }
  const target = path => ['/api/bot', '/api/ds-bot/computer-viewer'].includes(path?.split('?')[0])
  const subscribe = (name, callback) => {
    const entry = channel(name)
    entry.subscribe(callback)
    subscriptions.push(() => entry.unsubscribe(callback))
  }
  subscribe('http.server.request.start', ({ request, response, server }) => {
    if (!target(request.url)) return
    const id = socketId(request.socket), began = Date.now()
    write({ event: 'server-start', socket: id, path: request.url.split('?')[0],
      socketTimeout: request.socket.timeout, serverTimeout: server.timeout,
      requestTimeout: server.requestTimeout, keepAliveTimeout: server.keepAliveTimeout })
    const aborted = once(request, 'aborted', () => write({ event: 'request-aborted', socket: id, ms: Date.now() - began }))
    once(response, 'close', () => {
      aborted()
      write({ event: 'response-close', socket: id, ms: Date.now() - began, finished: response.writableFinished, status: response.statusCode })
    })
  })
  subscribe('undici:client:sendHeaders', ({ request, socket }) => {
    if (!target(request.path)) return
    const id = socketId(socket)
    requests.set(request, { id, began: Date.now() })
    write({ event: 'client-send', socket: id, path: request.path.split('?')[0] })
  })
  subscribe('undici:request:trailers', ({ request }) => {
    const entry = requests.get(request)
    if (entry) write({ event: 'client-complete', socket: entry.id, ms: Date.now() - entry.began })
  })
  subscribe('undici:request:error', ({ request, error }) => {
    const entry = requests.get(request)
    // Arbitrary Error messages may include URLs or provider content.
    const code = typeof error?.code === 'string' && /^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(error.code) ? error.code : 'UNKNOWN'
    if (entry) write({ event: 'client-error', socket: entry.id, ms: Date.now() - entry.began, code })
  })
  const lag = monitorEventLoopDelay({ resolution: 20 })
  lag.enable()
  const timer = setInterval(() => {
    if (lag.max > 1e9) write({ event: 'event-loop-lag', maxMs: Math.round(lag.max / 1e6) })
    lag.reset()
  }, 1000)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
    lag.disable()
    for (const unsubscribe of subscriptions) unsubscribe()
    for (const remove of listeners) remove()
  }
}

if (process.env.DS_BOT_HTTP_DIAGNOSTICS) httpDiagnostics(`${process.env.DS_BOT_HTTP_DIAGNOSTICS}-${process.pid}.jsonl`)
