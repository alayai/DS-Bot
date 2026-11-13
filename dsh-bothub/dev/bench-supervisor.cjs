const { spawn } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

const spec = JSON.parse(Buffer.from(process.argv[2], 'base64').toString())
const windows = process.platform === 'win32'
const marker = `DSH_${randomUUID()}:`
const send = value => { if (process.connected) process.send(value, error => { if (error) stop() }) }
let cleaned = false, resultSent = false, stopping = false, startupFailed = false
let child
if (windows) {
  const payload = Buffer.from(JSON.stringify({ ...spec, marker })).toString('base64')
  const script = readFileSync(join(__dirname, 'bench-job.ps1'), 'utf8').replace('@@PAYLOAD@@', payload)
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  })
  let pending = ''
  child.stdout.on('data', chunk => {
    pending += chunk.toString()
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      if (!line.startsWith(marker)) { process.stdout.write(line + '\n'); continue }
      const message = JSON.parse(line.slice(marker.length))
      if (message.kind === 'done') resultSent = true
      if (message.kind === 'done' && message.error) startupFailed = true
      if (message.kind === 'cleaned') cleaned = true
      send(message)
    }
  })
  child.stdin.on('error', error => send({ kind: 'cleanup-error', detail: error.message }))
} else {
  child = spawn(spec.executable, spec.args, { stdio: 'inherit' })
  child.once('spawn', () => send({ kind: 'started' }))
  child.once('exit', (code, signal) => {
    resultSent = true
    send({ kind: 'done', code, signal })
  })
}
child.once('error', error => {
  resultSent = true
  send({ kind: 'done', error: error.code })
})
child.once('close', (code, signal) => {
  if (!windows) return // keep process group leader alive until stop
  if (!resultSent) send({ kind: 'done', code: 1, error: 'LAUNCHER', signal })
  if (!cleaned && !startupFailed && stopping) send({ kind: 'cleanup-error', detail: `Job launcher closed without cleanup acknowledgement (${code})` })
  process.exitCode = cleaned ? 0 : 1
  if (process.connected) process.disconnect()
})
process.on('message', message => {
  if (message?.kind === 'cleanup') stop()
})
process.on('disconnect', stop)
function stop() {
  if (stopping) return
  stopping = true
  if (windows) child.stdin.end('stop\n')
  else {
    // BenchProcesses starts us as the leader of an owned, detached process group.
    // Kill the whole group, including this supervisor, if its parent cannot clean it.
    process.kill(-process.pid, 'SIGKILL')
  }
}
