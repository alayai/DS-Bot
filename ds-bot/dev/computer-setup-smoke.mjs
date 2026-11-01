// Native Node → shipped plugin payload → Broker → selected local engine. No user DSH data.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createComputerSetup } from '../src/host/computer/setup.js'
import { createComputerService } from '../src/host/computer/service.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'
import { discoverEngine, runEngine, preparePodmanMachine } from '../computer-runtime/engine.mjs'
import { loadSetupRuntime } from '../src/host/computer/setup-runtime.js'

const home = await mkdtemp(join(resolve(import.meta.dirname, '../..'), '.dsh-test-setup-'))
const rt = {
  home, config: {}, load: async () => {}, save: async () => {}, readOnly: () => undefined,
  botOf: id => id === 'setup-smoke' ? { id, name: 'Setup smoke' } : undefined,
  isBotSession: () => false, live: new Map(), groupOwners: new Map(),
}
const setup = createComputerSetup(rt, config => {
  rt.computer ??= createComputerService(rt, createBrokerProvider(config))
})
let engine, record, phase
const cancelOnly = process.argv.includes('--cancel')
const cachedImage = process.argv.slice(2).find(value => value.startsWith('sha256:'))
const reportPath = process.argv.find(value => value.startsWith('--report='))?.slice('--report='.length)
const engineKind = process.argv.includes('--engine=podman') ? 'podman' : 'docker'
try {
  if (process.argv.includes('--prepare-runtime')) {
    assert.equal(engineKind, 'podman')
    await preparePodmanMachine(undefined, { log: text => process.stdout.write(text) })
  }
  engine = await discoverEngine(undefined, { kind: engineKind })
  if (cachedImage) {
    const runtime = await loadSetupRuntime()
    const image = await runtime.image(engine, cachedImage)
    await mkdir(join(home, 'computers'))
    await writeFile(join(home, 'computers/setup.json'), JSON.stringify({
      version: 1, config: { engine, image, recipe: runtime.recipe },
    }))
    console.log('Using an explicitly supplied cached image; this run does not prove first download.')
  }
  const state = await setup.state({ engineKind })
  assert.equal(state.environment.ready, true)
  assert.equal(rt.computer, undefined)
  await setup.prepare({ botId: 'setup-smoke', engineKind })
  const deadline = Date.now() + 20 * 60_000
  for (;;) {
    const current = await setup.state()
    if (current.job.phase !== phase) {
      phase = current.job.phase
      console.log(`${process.platform}: ${phase}`)
    }
    if (cancelOnly && phase === 'preparing-image') await setup.cancel({ jobId: current.job.id })
    if (!current.busy) {
      if (cancelOnly) {
        assert.equal(phase, 'cancelled', current.job.error)
        console.log(`PASS: actual ${process.platform} ${engineKind} preparation cancels and releases the process tree`)
        break
      }
      if (phase !== 'ready') console.error(current.job.log)
      assert.equal(phase, 'ready', current.job.error)
      break
    }
    if (Date.now() >= deadline) throw new Error('Setup smoke timed out.')
    await delay(500)
  }
  if (!cancelOnly) {
    record = (await rt.computer.state()).computers[0]
    assert.equal(record.grant, 'observe')
    const args = () => ({ botId: record.botId, expectedGeneration: record.generation })
    const preview = await rt.computer.preview(args())
    assert.ok(preview.data.length > 100)
    const ticket = await rt.computer.manage('takeover', args())
    const control = () => ({ ...args(), controlToken: ticket.controlToken })
    await rt.computer.files({ ...control(), operation: 'write', name: 'setup-proof.txt', data: Buffer.from('native setup').toString('base64') })
    const contents = await rt.computer.files({ ...control(), operation: 'read', name: 'setup-proof.txt' })
    assert.equal(Buffer.from(contents.data, 'base64').toString(), 'native setup')
    await rt.computer.manage('release', control())
    await rt.computer.manage('stop', args())
    const backup = await rt.computer.storage('checkpoint', args())
    assert.equal(backup.checkpoints.length, 1)
    await rt.computer.manage('start', args())
    assert.equal((await rt.computer.preview(args())).width, preview.width)
    const journal = JSON.parse(await readFile(join(home, 'computers/setup.json'), 'utf8'))
    assert.equal(journal.config.engine.id, engine.id)
    assert.equal(journal.job.phase, 'ready')
    console.log(`PASS: installed payload discovery, ${cachedImage ? 'cached image verification' : 'image preparation'}, native Broker, screenshot, transfer, checkpoint and resume`)
  }
} finally {
  await setup.dispose()
  await rt.computer?.dispose()
  try {
    const registry = JSON.parse(await readFile(join(home, 'computers/registry.json'), 'utf8'))
    for (const saved of Object.values(registry.computers)) {
      if (!/^cmp_[a-f0-9-]{36}$/.test(saved.id)) throw new Error('Invalid fixture identity.')
      await runEngine(engine, ['rm', '-f', `dsbot-${saved.id}`]).catch(() => {})
      const volumes = (await runEngine(engine, ['volume', 'ls', '-q', '--filter', `label=org.ds-bot.computer.id=${saved.id}`])).stdout.trim().split(/\r?\n/).filter(Boolean)
      for (const volume of volumes) await runEngine(engine, ['volume', 'rm', volume])
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await rm(home, { recursive: true, force: true })
}
if (reportPath) {
  assert.equal(cancelOnly, false, 'A cancelled setup cannot produce passing image evidence.')
  assert.ok(cachedImage, 'Release smoke evidence requires an explicit immutable image ID.')
  await writeFile(reportPath, `${JSON.stringify({ version: 1, passed: true, image: cachedImage,
    checks: ['screenshot', 'file-roundtrip', 'checkpoint', 'restart'] }, null, 2)}\n`, { flag: 'wx' })
}
