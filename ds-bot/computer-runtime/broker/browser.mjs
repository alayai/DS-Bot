import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { engineCommand, engineEnvironment } from '../engine.mjs'

export async function createBrowserBridge(value, { engine, executable }) {
  const code = await readFile(new URL('./browser.py', import.meta.url), 'utf8')
  const child = spawn(executable, engineCommand(engine, ['exec', '-i', '--user', '1000:1000', value.name,
    'python3', '-u', '-c', code, value.record.policy?.network === 'restricted' ? 'restricted' : 'open']), {
    ...(engine ? { env: engineEnvironment(engine) } : {}), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  })
  let pending, buffer = '', closed = false, closing
  const exited = new Promise(resolve => child.once('close', () => { closed = true; pending?.reject(Error('Browser bridge disconnected.')); resolve() }))
  child.on('error', () => { closed = true; pending?.reject(Error('Browser bridge could not start.')) })
  child.stdin.on('error', () => { pending?.reject(Error('Browser bridge input closed.')) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', data => {
    buffer += data
    if (buffer.length > 256000) { pending?.reject(Error('Browser reply exceeded its limit.')); child.stdin.destroy(); return }
    const end = buffer.indexOf('\n')
    if (end < 0) return
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    try {
      const result = JSON.parse(line)
      if (result.ok) pending?.resolve(result.value)
      else if (result.rejected) pending?.resolve({ outcome: 'rejected', completedActions: 0, error: result.error })
      else pending?.reject(Error('Browser result is unconfirmed.'))
    } catch { pending?.reject(Error('Invalid browser reply.')) }
  })
  function close() {
    closing ??= (async () => {
      child.stdin.end()
      let timer
      try {
        await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => {
          child.kill('SIGKILL'); reject(Error('Browser bridge shutdown could not be confirmed.'))
        }, 12000); timer.unref?.() })])
      } finally { clearTimeout(timer) }
    })()
    return closing
  }
  async function call(method, args, signal) {
    if (closed || closing || pending) throw Error('Browser bridge is unavailable.')
    signal?.throwIfAborted()
    let abort, timer
    try {
      return await new Promise((resolve, reject) => {
        pending = { resolve, reject }
        abort = () => { reject(Error('Browser operation interrupted.')); void close().catch(() => {}) }
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, 25000); timer.unref?.()
        child.stdin.write(`${JSON.stringify({ method, ...args })}\n`)
      })
    } finally { signal?.removeEventListener('abort', abort); clearTimeout(timer); pending = null }
  }
  return { call, close, get closed() { return closed || Boolean(closing) } }
}
