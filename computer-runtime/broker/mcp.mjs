import { spawn } from 'node:child_process'

export class McpClient {
  constructor(command, args, options = {}) {
    this.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.pending = new Map()
    this.sequence = 0
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 12 * 1024 * 1024) return this.fail()
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { this.fail(); return }
        const entry = this.pending.get(message.id)
        if (!entry) continue
        if (message.error) entry.reject(new Error('The CUA transport refused a request.'))
        else entry.resolve(message.result)
      }
    })
    this.child.on('error', () => this.fail())
    this.child.on('exit', () => this.fail())
    this.child.stdin.on('error', () => this.fail())
  }
  fail() {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) entry.reject(new Error('The CUA transport closed. Input may have executed.'))
    this.child.kill()
  }
  send(value) {
    if (this.closed) throw new Error('The CUA transport is closed.')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  request(method, params, signal) {
    signal?.throwIfAborted()
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
      }
      const done = callback => value => { cleanup(); callback(value) }
      const abort = () => {
        try { this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) } catch {}
        this.pending.get(id)?.reject(new Error('The CUA request was cancelled; its effect may be unknown.'))
        // A cancellation notification is not a driver acknowledgement. Retire
        // this transport; the Broker must revoke guest input before reuse.
        this.fail()
      }
      const timer = setTimeout(abort, 30_000)
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { this.pending.get(id)?.reject(error) }
    })
  }
  async initialize(signal) {
    await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'ds-bot-computer', version: '1' },
    }, signal)
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  async call(name, args, signal) {
    const response = await this.request('tools/call', { name, arguments: args }, signal)
    if (response?.isError) throw new Error('The CUA tool refused the action.')
    if (response?.structuredContent) return response.structuredContent
    for (const content of response?.content ?? []) {
      if (content.type !== 'text') continue
      try { return JSON.parse(content.text) } catch {}
    }
    throw new Error('The CUA tool returned no structured result.')
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.fail()
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 2000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
