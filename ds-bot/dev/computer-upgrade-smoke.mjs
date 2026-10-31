// Real Docker migration with isolated homes and temporary image variants; no model credentials.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createComputerService } from '../src/host/computer/service.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'

const image = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Pass the prepared local image ID.')
const run = promisify(execFile)
const docker = args => run('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })
const temporary = await mkdtemp(join(tmpdir(), '.dsh-test-cua-upgrade-'))
const createdImages = []
let service, record, provider
const timings = []
const timed = async (name, work) => {
  const start = performance.now()
  const result = await work()
  timings.push({ name, ms: Math.round(performance.now() - start) })
  return result
}
try {
  for (const user of ['1000:1000', 'root']) {
    const container = `dsbot-image-fixture-${randomUUID()}`
    await docker(['create', '--name', container, image])
    try {
      const built = await docker(['commit', '--change', `LABEL org.ds-bot.test=${randomUUID()}`, '--change', `USER ${user}`, container])
      createdImages.push(built.stdout.trim())
    } finally { await docker(['rm', '-v', container]) }
  }
  const [candidate, invalid] = createdImages
  provider = createBrokerProvider({ entrypoint: resolve('computer-runtime/broker/main.mjs'), image, images: createdImages })
  const rt = { home: temporary, config: {}, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'fixture' ? { id } : undefined }
  service = createComputerService(rt, provider)
  record = await service.bind({ botId: 'fixture', grant: 'observe', expectedRevision: 0 })
  const name = `dsbot-${record.id}`
  const manage = method => service.manage(method, { botId: 'fixture', expectedGeneration: record.generation })
  const storage = async (method, extra = {}) => {
    const result = await service.storage(method, { botId: 'fixture', expectedGeneration: record.generation, ...extra })
    record = result.computers[0]
    return result
  }
  const marker = value => docker(['exec', name, 'python3', '-c', `from pathlib import Path;Path('/home/cua/version-marker').write_text(${JSON.stringify(value)})`])
  const readMarker = async () => (await docker(['exec', name, 'cat', '/home/cua/version-marker'])).stdout
  await timed('cached-start', () => manage('start'))
  await marker('original-profile')
  for (let i = 0; i < 10; i++) await timed('screenshot', () => service.preview({ botId: 'fixture', expectedGeneration: record.generation }))
  await manage('stop')
  await assert.rejects(storage('upgrade', { targetImage: invalid }))
  assert.equal(record.runtimeImage, image)
  await storage('recover')
  await manage('start')
  assert.equal(await readMarker(), 'original-profile')
  await manage('stop')
  for (const checkpoint of (await service.state()).checkpoints) await storage('delete-checkpoint', { checkpointId: checkpoint.id })
  console.log('PASS: incompatible candidate is rejected and original home remains readable')
  await timed('upgrade', () => storage('upgrade', { targetImage: candidate }))
  assert.equal(record.runtimeImage, candidate)
  assert.deepEqual(record.previousImages, { original: image })
  await manage('start')
  assert.equal((JSON.parse((await docker(['inspect', name])).stdout)[0]).Image, candidate)
  assert.equal(await readMarker(), 'original-profile')
  await marker('upgraded-profile')
  await manage('stop')
  await storage('rollback', { homeRevision: null })
  await manage('start')
  assert.equal((JSON.parse((await docker(['inspect', name])).stdout)[0]).Image, image)
  assert.equal(await readMarker(), 'original-profile')
  console.log('PASS: upgrade copies data and rollback opens the original image with its original profile')
  await manage('stop')
  await storage('delete-home', { homeRevision: record.previousHomes[0] })
  for (const checkpoint of (await service.state()).checkpoints) await storage('delete-checkpoint', { checkpointId: checkpoint.id })
  const upgrade = provider.upgrade
  provider.upgrade = async (...args) => { await upgrade(...args); throw new Error('reply lost after candidate health') }
  await assert.rejects(storage('upgrade', { targetImage: candidate }), /reply lost/)
  provider.upgrade = upgrade
  assert.equal((await service.state()).computers[0].recoveryPending, true)
  await storage('recover')
  await manage('start')
  assert.equal(await readMarker(), 'original-profile')
  console.log('PASS: unpublished successful candidate is discarded on recovery; source bytes remain authoritative')
  const shots = timings.filter(item => item.name === 'screenshot').map(item => item.ms).sort((a, b) => a - b)
  console.log(JSON.stringify({ timings, screenshotP95Ms: shots[Math.ceil(shots.length * 0.95) - 1], samples: shots.length }))
} finally {
  await service?.dispose()
  if (record) {
    const containers = (await docker(['ps', '-aq', '--filter', `label=org.ds-bot.computer.id=${record.id}`])).stdout.trim().split('\n').filter(Boolean)
    for (const name of containers) await docker(['rm', '-f', name])
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=org.ds-bot.computer.id=${record.id}`])).stdout.trim().split('\n').filter(Boolean)
    for (const volume of volumes) await docker(['volume', 'rm', volume])
  }
  for (const id of createdImages.reverse()) await docker(['image', 'rm', id])
  await rm(temporary, { recursive: true, force: true })
}
