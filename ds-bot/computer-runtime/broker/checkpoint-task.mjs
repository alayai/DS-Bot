import { spawn } from 'node:child_process'

// Consume bounded JSON lines instead of retaining a large copy's whole output.
export function checkpointTask(executable, args, request, { signal, env, onProgress, timeout = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { signal, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '', result, failure
    const timer = setTimeout(() => {
      failure = new Error('Desktop storage operation timed out.')
      child.kill()
    }, timeout)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', text => {
      try {
        buffer += text
        if (buffer.length > 65536) throw new Error('Invalid storage progress.')
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const value = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if (value.progress) {
            const p = value.progress
            if (!['checking', 'copying', 'verifying'].includes(p.stage)
              || ![p.doneBytes, p.totalBytes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1024 ** 4)) throw new Error('Invalid storage progress.')
            onProgress?.(p)
          } else {
            if (result !== undefined) throw new Error('Duplicate storage result.')
            result = value
          }
        }
      } catch (error) { failure = error; child.kill() }
    })
    child.stderr.resume()
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0 || buffer.trim() || !result) reject(failure ?? new Error('Desktop storage copy failed. Check available space and the checkpoint limit.'))
      else if (typeof result.error === 'string') reject(Object.assign(new Error(result.error.slice(0, 300)), { public: true }))
      else resolve(result)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}
