// Real Docker restart regression; creates and removes only a dedicated desktop.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'

const image = process.env.CUA_TEST_IMAGE
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const id = `cmp_${randomUUID()}`
const name = `dsbot-${id}`
const record = { id, botId: 'restart-fixture', generation: 1, runtimeImage: image }
const provider = createBrokerProvider({ image, native: true,
  entrypoint: fileURLToPath(new URL('../computer-runtime/broker/main.mjs', import.meta.url)) })
const execute = promisify(execFile)
const docker = args => execute('docker', args, { timeout: 30_000, windowsHide: true })
const inspect = async () => JSON.parse((await docker(['inspect', name])).stdout)[0]
const marker = randomUUID()
async function verify() {
  const shot = await provider.preview(record, { signal: AbortSignal.timeout(30_000) })
  assert.deepEqual(shot.data.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'))
  assert.equal(shot.width, 1280)
  assert.equal(shot.height, 800)
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/restart-marker'])).stdout, marker)
}
try {
  await provider.start(record)
  await docker(['exec', name, 'python3', '-c',
    `from pathlib import Path;Path('/home/cua/restart-marker').write_text('${marker}')`])
  await verify()
  const first = await inspect()
  await provider.start(record)
  assert.equal((await inspect()).Id, first.Id, 'starting a running desktop must leave it running')
  // An abrupt exit retains X1-lock and X1 in the stopped writable layer.
  await docker(['kill', '--signal', 'KILL', name])
  assert.equal((await inspect()).State.Running, false)
  await provider.start(record)
  await verify()
  const restarted = await inspect()
  assert.notEqual(restarted.Id, first.Id)
  assert.equal(restarted.Mounts[0].Name, first.Mounts[0].Name)
  await provider.stop(record)
  await provider.start(record)
  await verify()
  console.log('PASS: crash restart and stop/start capture real frames and retain the same home marker; running start is idempotent')
} finally {
  try { await provider.dispose() }
  finally {
    await docker(['rm', '-f', name])
    await docker(['volume', 'rm', `${name}-home`])
  }
}
