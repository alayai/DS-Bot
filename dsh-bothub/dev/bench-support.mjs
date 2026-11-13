import { spawn } from 'node:child_process'
import { open, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export function benchOptions(root, [name, web = '3196', mock = '8896', mode = 'probe']) {
  if (!/^bothub-[a-z0-9-]+$/.test(name ?? '')) throw new Error('Use a fresh bothub-<name> bench')
  const ports = [web, mock].map(value => {
    if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535 || +value === 3080) throw new Error('Use unprivileged test ports other than 3080')
    return +value
  })
  if (ports[0] === ports[1]) throw new Error('Web and mock ports must differ')
  if (!['probe', 'full'].includes(mode)) throw new Error('Bench mode must be probe or full')
  return { name, web: ports[0], mock: ports[1], mode, home: join(root, `.dsh-test-${name}`) }
}

export async function packageSource(path, directory) {
  if (!path) return `file:${directory.replaceAll('\\', '/')}`
  if (!isAbsolute(path) || !path.endsWith('.tgz') || !(await stat(path)).isFile()) throw new Error('Bench package must be an existing absolute .tgz file')
  return `file:${path.replaceAll('\\', '/')}`
}

export async function checkPort(port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

// Windows owns a kernel job handle, POSIX owns a process group. No historical PID tree walks.
export class BenchProcesses {
  children = []
  async start(executable, args, { cwd, env, log }) {
    if (this.stopPromise) throw new Error('Bench processes already stopped')
    const output = await open(log, 'a', 0o600)
    try {
      const payload = Buffer.from(JSON.stringify({ executable, args })).toString('base64')
      const child = spawn(process.execPath, [fileURLToPath(new URL('./bench-supervisor.cjs', import.meta.url)), payload], {
        cwd, env, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', output.fd, output.fd, 'ipc'],
      })
      const item = { child, ended: false, cleaned: false }
      let initialized
      const startup = new Promise(resolve => { initialized = resolve })
      item.done = new Promise(resolve => { item.resolve = resolve })
      item.closed = new Promise(resolve => {
        child.once('error', error => { item.error = error })
        child.once('close', (code, signal) => {
          item.ended = true
          initialized()
          if (!item.result) {
            item.result = { code: code === 0 ? 1 : code, signal, error: item.error ?? { code: 'SUPERVISOR' } }
            item.resolve(item.result)
          }
          resolve()
        })
      })
      child.on('message', message => {
        if (message?.kind === 'started' || message?.kind === 'done') initialized()
        if (message?.kind === 'cleaned') item.cleaned = true
        if (message?.kind === 'cleanup-error') item.cleanupError = message.detail || message.error || 'Unknown cleanup failure'
        if (message?.kind !== 'done' || item.result) return
        item.result = { ...message, error: message.error ? { code: message.error } : undefined }
        item.resolve(item.result)
      })
      this.children.push(item)
      // PowerShell compilation belongs to startup, not the target's execution/readiness budget.
      const startupTimer = new AbortController()
      const started = await Promise.race([startup.then(() => true), delay(15000, false, { signal: startupTimer.signal }).catch(() => false)])
      startupTimer.abort()
      if (!started) throw new Error('Bench launcher startup timed out')
      return item
    } finally { await output.close() }
  }
  async wait(item, timeout, signal) {
    const cancel = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
    await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Bench command timed out or was interrupted'))
      cancel.addEventListener('abort', abort, { once: true })
      if (cancel.aborted) abort()
      item.done.then(result => {
        cancel.removeEventListener('abort', abort)
        if (result.code === 0 && !result.error) resolve()
        else reject(new Error('Bench child failed (' + (result.error?.code ?? result.code ?? result.signal) + '); inspect its private test log'))
      })
    })
  }
  async ready(item, log, marker, timeout, signal) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (item.ended || item.result) throw new Error('Bench child exited before readiness; inspect its private test log')
      if ((await readFile(log, 'utf8')).includes(marker)) return
      await delay(50, undefined, { signal })
    }
    throw new Error('Bench startup timed out; inspect its private test log')
  }
  stop() {
    if (!this.stopPromise) this.stopPromise = this.stopAll()
    return this.stopPromise
  }
  async stopAll() {
    const errors = []
    for (const item of [...this.children].reverse()) {
      if (process.platform === 'win32') {
        if (!item.ended && item.child.connected) {
          item.child.send({ kind: 'cleanup' }, error => { if (error) item.cleanupError = error.message })
        }
      } else if (!item.ended && item.child.pid) {
        try { process.kill(-item.child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') errors.push(error.message) }
      }
      const timer = new AbortController()
      const closed = await Promise.race([item.closed.then(() => true), delay(15000, false, { signal: timer.signal }).catch(() => false)])
      timer.abort()
      if (!closed) errors.push('Bench supervisor did not close; cleanup unverified')
      // Startup failure runs no target. Otherwise require the Job's zero-live-process acknowledgement.
      if (process.platform === 'win32' && (item.cleanupError || (!item.cleaned && !item.result?.error))) {
        errors.push('Could not clean detached bench descendants' + (item.cleanupError ? ': ' + item.cleanupError : ''))
      }
    }
    if (errors.length) throw new Error(errors.join('; '))
  }
}
