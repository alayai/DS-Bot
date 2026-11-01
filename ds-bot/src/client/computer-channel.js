import { streamFailure } from '../shared/computer-stream.js'

const ROUTE = 'api/ds-bot/computer-viewer'
export function viewerSocketUrl(path, base = globalThis.document?.baseURI, transport = globalThis.__DSH_TRANSPORT__?.streamBaseUrl) {
  if (path !== '/api/ds-bot/computer-viewer/socket') return null
  // The desktop page is dsh-app:// and cannot open a socket from that document.
  // DSH already publishes the host origin used by its own streams.
  const selected = typeof transport === 'string' && transport ? transport : base
  if (!selected) return null
  try {
    const origin = new URL(selected)
    if (!['http:', 'https:'].includes(origin.protocol)) return null
    const url = new URL(path.slice(1), origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch { return null }
}

// Public noVNC raw-channel adapter: authenticated WebSocket when the host exposes
// one, otherwise the same owner-only Fetch route used by the desktop shell.
export class ComputerChannel {
  constructor(botId, generation, fetcher = globalThis.fetch, options = {}) {
    this.readyState = 0
    this.binaryType = 'arraybuffer'
    this.protocol = ''
    this.onopen = this.onmessage = this.onclose = this.onerror = null
    this.controller = new AbortController()
    this.fetcher = (...args) => fetcher(...args)
    this.options = options
    this.queue = []
    this.queuedBytes = 0
    this.writing = false
    this.transport = 'fetch'
    this.start = setTimeout(() => { void this.open(botId, generation) }, 0)
  }
  async request(operation, args = {}) {
    let response
    try {
      response = await this.fetcher(ROUTE, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, id: this.id, ...args }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(operation === 'heartbeat' ? 3000 : 30_000)]),
      })
    } catch (error) { throw streamFailure(error?.name === 'TimeoutError' ? 'timeout' : 'network') }
    if (!response.ok) {
      let error
      try { error = (await response.json()).error } catch {}
      throw streamFailure(error, response.status)
    }
    return response
  }
  async open(botId, generation) {
    try {
      const args = { botId, generation, ...(this.options.controlToken ? { controlToken: this.options.controlToken } : {}) }
      const result = await (await this.request('open', args)).json()
      this.id = result.id
      this.interactive = result.interactive === true
      if (this.options.controlToken && !this.interactive) throw streamFailure('control')
      if (this.readyState === 3) { this.release(); return }
      const url = !this.options.forceFetch && viewerSocketUrl(result.webSocket, this.options.base)
      if (url && (this.options.WebSocket ?? globalThis.WebSocket)) {
        if (await this.attachSocket(url)) return
        if (this.readyState === 3) return
        // A proxy can fail after the server already claimed the old session.
        // Retire it before starting the independent Fetch fallback.
        await this.request('close').catch(() => {})
        const fallback = await (await this.request('open', args)).json()
        this.id = fallback.id
        this.interactive = fallback.interactive === true
        if (this.options.controlToken && !this.interactive) throw streamFailure('control')
        if (this.readyState === 3) { this.release(); return }
      }
      this.readyState = 1
      this.keepControl()
      this.onopen?.()
      while (this.readyState === 1) {
        const data = await (await this.request('read')).arrayBuffer()
        if (this.readyState === 1 && data.byteLength) this.onmessage?.({ data })
      }
    } catch (error) { this.close(error) }
  }
  attachSocket(url) {
    return new Promise(resolve => {
      const Socket = this.options.WebSocket ?? globalThis.WebSocket
      let socket, settled = false, claimed = false, received = 0
      const finish = result => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.controller.signal.removeEventListener('abort', cancel)
        resolve(result)
      }
      const fallback = () => { if (socket) { socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null; socket.close() }; finish(false) }
      const cancel = () => fallback()
      const timer = setTimeout(fallback, 3000)
      this.controller.signal.addEventListener('abort', cancel, { once: true })
      try {
        socket = new Socket(url)
        this.socket = socket
        socket.binaryType = 'arraybuffer'
        socket.onopen = () => socket.send(JSON.stringify({ id: this.id }))
        socket.onmessage = event => {
          try {
            if (typeof event.data === 'string') {
              if (claimed || !JSON.parse(event.data).ready) throw streamFailure('protocol')
              claimed = true
              this.transport = 'websocket'
              this.readyState = 1
              this.keepControl()
              this.onopen?.()
              finish(true)
            } else {
              if (!claimed || this.readyState !== 1) return
              this.onmessage?.({ data: event.data })
              if (this.readyState === 1) socket.send(JSON.stringify({ ack: ++received }))
            }
          } catch (error) { this.close(error?.code ? error : 'protocol'); finish(true) }
        }
        socket.onerror = () => { if (!claimed) fallback(); else this.close('network') }
        socket.onclose = event => {
          if (!claimed) fallback()
          else this.close(streamFailure(event.reason || 'closed'))
        }
      } catch { fallback() }
    })
  }
  send(data) {
    if (this.readyState !== 1 || this.queuedBytes + data.byteLength > 65536) { this.close('protocol'); return }
    if (this.transport === 'websocket') {
      if (this.socket.bufferedAmount + data.byteLength > 65536) { this.close('network'); return }
      try { this.socket.send(data) } catch { this.close('network') }
      return
    }
    this.queue.push(new Uint8Array(data))
    this.queuedBytes += data.byteLength
    void this.flush()
  }
  keepControl() {
    if (!this.interactive || this.heartbeat) return
    this.heartbeat = setInterval(() => {
      if (this.heartbeatPending || this.readyState !== 1) return
      this.heartbeatPending = true
      void this.request('heartbeat').catch(error => this.close(error))
        .finally(() => { this.heartbeatPending = false })
    }, 2000)
  }
  async flush() {
    if (this.writing || this.readyState !== 1) return
    this.writing = true
    try {
      while (this.queue.length && this.readyState === 1) {
        let binary = ''
        for (const bytes of this.queue.splice(0)) for (const byte of bytes) binary += String.fromCharCode(byte)
        this.queuedBytes = 0
        await this.request('write', { data: btoa(binary) })
      }
    } catch (error) { this.close(error) }
    finally { this.writing = false }
  }
  release() {
    if (!this.id) return
    void this.fetcher(ROUTE, { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'close', id: this.id }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    this.id = null
  }
  close(error) {
    if (this.readyState === 3) return
    this.error = error ? streamFailure(error) : null
    this.readyState = 3
    clearTimeout(this.start)
    clearInterval(this.heartbeat)
    this.controller.abort()
    if (this.socket) { this.socket.onclose = this.socket.onerror = null; this.socket.close() }
    this.queue.length = 0
    this.queuedBytes = 0
    this.release()
    const event = { code: error ? 4000 : 1000, reason: this.error?.code ?? '', wasClean: !error }
    // Match WebSocket: noVNC finishes entering its closing state before this event.
    void Promise.resolve().then(() => this.onclose?.(event))
  }
}
