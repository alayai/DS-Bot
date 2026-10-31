// Explicit Linux smoke of a packaged payload. All resources belong to a fresh test identity.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { verifyComputerRuntime } from '../src/computer-runtime.mjs'
import { createBrokerProvider } from '../../ds-bot/src/host/computer/providers/broker.js'

const [directory, image] = process.argv.slice(2)
if (!directory || !/^sha256:[a-f0-9]{64}$/.test(image ?? '') || process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Usage (Linux x64): node scripts/check-computer-runtime.mjs PAYLOAD_DIRECTORY IMMUTABLE_IMAGE_ID')
}
const runtime = verifyComputerRuntime(resolve(directory))
const provider = createBrokerProvider({ entrypoint: runtime.entrypoint, image })
const record = { id: `cmp_${randomUUID()}`, botId: 'packaged-smoke', generation: 1, runtimeImage: image }
const name = `dsbot-${record.id}`
const volume = `${name}-home`
const run = promisify(execFile)
const docker = args => run('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 })
let failure
try {
  await provider.start(record)
  const frame = await provider.observe(record, { fence: 'packaged-probe' })
  assert.equal(frame.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(frame.width > 0 && frame.height > 0)
  const data = Buffer.from('packaged-runtime-roundtrip').toString('base64')
  await provider.files(record, { operation: 'write', name: 'probe.txt', data })
  await provider.stop(record)
  await provider.start(record)
  assert.equal((await provider.files(record, { operation: 'read', name: 'probe.txt' })).data, data)
  assert.equal((await provider.inspect(record)).image, image)
  console.log(`PASS: packaged Broker screenshot and persistent file roundtrip (${join(resolve(directory), 'broker', 'main.mjs')})`)
} catch (error) { failure = error }
async function cleanup() {
  const errors = []
  await provider.stop(record).catch(() => {})
  await provider.dispose().catch(error => errors.push(error))
  await docker(['rm', '-f', name]).catch(error => errors.push(error))
  try {
    let owned
    try { owned = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0] }
    catch (error) { if (!/no such volume/i.test(error.stderr ?? '')) throw error }
    if (owned) {
      assert.equal(owned.Labels?.['org.ds-bot.computer.id'], record.id)
      await docker(['volume', 'rm', volume])
    }
  } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Computer smoke resource cleanup failed.')
}
try { await cleanup() }
catch (error) { failure = failure ? new AggregateError([failure, error], 'Computer payload smoke and cleanup failed.') : error }
if (failure) throw failure
