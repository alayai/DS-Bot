import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerSetup } from '../src/host/computer/setup.js'
import { createComputerService } from '../src/host/computer/service.js'
import { createFakeComputer } from '../src/host/computer/providers/fake.js'
import { loadSetupRuntime } from '../src/host/computer/setup-runtime.js'
import { discoverEngine, engineEnvironment, validateEngine } from '../../computer-runtime/engine.mjs'
import { assertLocalEndpoint } from '../../computer-runtime/broker/boundary.mjs'
import { brokerLaunch } from '../src/host/computer/providers/transport.js'
import { setTimeout as delay } from 'node:timers/promises'

const image = `sha256:${'a'.repeat(64)}`
const engine = { kind: 'docker', executable: 'docker', endpoint: 'unix:///var/run/docker.sock', id: 'fixture-engine' }
const recipe = 'b'.repeat(64)
const until = async read => {
  for (let i = 0; i < 1000; i++) { if (await read()) return; await delay(5) }
  assert.fail('The setup task did not settle')
}
async function fixture(t, config = {}, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-setup-'))
  let readOnly
  const calls = []
  let available = false, build, discoveryError
  const fake = createFakeComputer()
  const rt = {
    home, config, load: async () => {}, readOnly: () => readOnly,
    botOf: id => ['a', 'b'].includes(id) ? { id } : undefined, save: async () => { calls.push('save') },
    isBotSession: () => false, live: new Map(), groupOwners: new Map(),
  }
  const runtime = {
    recipe, validate: value => assert.deepEqual(value, engine),
    discover: async saved => { calls.push(['discover', saved]); if (discoveryError) throw new Error(discoveryError); return engine },
    image: async () => { calls.push('image'); if (!available) throw new Error('missing'); return image },
    prepare: async (_engine, options) => {
      calls.push('build')
      options.log('Downloading layer\npassword=fixture-secret\n')
      if (build) await build(options)
      available = true
      return image
    },
    broker: (selected, id) => ({ selected, id }),
  }
  const activate = async broker => {
    calls.push(['activate', broker])
    rt.computer ??= createComputerService(rt, fake)
  }
  const setup = createComputerSetup(rt, activate, { runtime: async () => runtime, ...options })
  t.after(async () => { await setup.dispose(); await rt.computer?.dispose(); await rm(home, { recursive: true, force: true }) })
  return {
    setup, rt, calls, runtime, activate, home,
    available: () => { available = true },
    build: fn => { build = fn },
    discoveryError: value => { discoveryError = value },
    readOnly: () => { readOnly = 'another host' },
    settled: () => until(async () => !(await setup.state()).busy),
  }
}

test('opening setup only detects the environment and never creates a task or Computer', async t => {
  const h = await fixture(t)
  const state = await h.setup.state()
  assert.equal(state.environment.ready, true)
  assert.equal(state.enabled, false)
  assert.equal(h.rt.computer, undefined)
  assert.deepEqual(h.calls.map(call => call[0]), ['discover'])
  await assert.rejects(readFile(join(h.home, 'computers/setup.json')), { code: 'ENOENT' })
})

test('prepare persists its selected engine, builds once, starts observe-only and verifies a screenshot', async t => {
  const h = await fixture(t)
  let release
  h.build(() => new Promise(resolve => { release = resolve }))
  const first = await h.setup.prepare({ botId: 'a' })
  await until(() => release)
  const again = await h.setup.prepare({ botId: 'a' })
  assert.equal(first.job.id, again.job.id)
  await assert.rejects(h.setup.prepare({ botId: 'b' }), /another Bot/)
  const saved = JSON.parse(await readFile(join(h.home, 'computers/setup.json')))
  assert.deepEqual(saved.selection, engine)
  assert.equal(saved.job.phase, 'preparing-image')
  assert.ok(!(await h.setup.state()).job.log.includes('fixture-secret'))
  release()
  await h.settled()
  const state = await h.setup.state()
  assert.equal(state.job.phase, 'ready')
  assert.equal(h.calls.filter(call => call === 'build').length, 1)
  const record = (await h.rt.computer.state()).computers[0]
  assert.equal(record.phase, 'ready')
  assert.equal(record.grant, 'observe')
  assert.equal(record.approvalMode, 'required')
  assert.equal(state.job.log.includes('fixture-secret'), false)
  assert.equal(h.setup.pending(), false)
})

test('cancel fences stale task IDs, retains cached layers and permits a clean retry', async t => {
  const h = await fixture(t)
  let waiting = false
  h.build(({ signal }) => new Promise((resolve, reject) => {
    waiting = true
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const { job } = await h.setup.prepare({ botId: 'a' })
  await until(() => waiting)
  await assert.rejects(h.setup.cancel({ jobId: 'old' }), /changed/)
  await h.setup.cancel({ jobId: job.id })
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'cancelled')
  assert.equal(h.rt.computer, undefined)
  h.build(undefined)
  await h.setup.prepare({ botId: 'a', jobId: job.id })
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'ready')
  const selections = h.calls.filter(call => Array.isArray(call) && call[0] === 'discover')
  assert.ok(selections.some(call => call[1]?.id === engine.id))
})

test('restoring saved runtime does not replay unfinished preparation or launch a desktop', async t => {
  const h = await fixture(t)
  await mkdir(join(h.home, 'computers'))
  await writeFile(join(h.home, 'computers/setup.json'), JSON.stringify({
    version: 1, config: { engine, image, recipe },
    job: { id: 'interrupted', botId: 'a', phase: 'starting-desktop' },
  }))
  await h.setup.restore()
  const state = await h.setup.state()
  assert.equal(state.job.phase, 'interrupted')
  assert.equal(state.enabled, true)
  assert.equal((await h.rt.computer.state()).computers.length, 0)
  assert.equal(h.calls.includes('build'), false)
})

test('explicit disable, explicit runtime, read-only host and legacy homes cannot be bypassed by setup', async t => {
  for (const config of [{ computer: { enabled: false } }, { computer: { enabled: true } }]) {
    const h = await fixture(t, config)
    await assert.rejects(h.setup.prepare({ botId: 'a' }))
    assert.equal(h.calls.includes('build'), false)
  }
  const read = await fixture(t)
  read.readOnly()
  await assert.rejects(read.setup.prepare({ botId: 'a' }), /does not own/)
  const legacy = await fixture(t)
  await mkdir(join(legacy.home, 'computers'))
  await writeFile(join(legacy.home, 'computers/registry.json'), JSON.stringify({ computers: { existing: {} } }))
  await assert.rejects(legacy.setup.prepare({ botId: 'a' }), /original runtime/)
  assert.equal(legacy.calls.includes('build'), false)
})

test('loss of team ownership during build never enables a provider', async t => {
  const h = await fixture(t)
  h.build(async () => { h.readOnly() })
  await h.setup.prepare({ botId: 'a' })
  await h.settled()
  assert.equal(h.rt.computer, undefined)
  assert.equal((await h.setup.state()).job.phase, 'failed')
})

test('engine discovery accepts local Windows pipes and refuses remote contexts or changed daemon identity', async () => {
  const windowsEngine = { ...engine, executable: 'docker.exe', endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine' }
  validateEngine(windowsEngine, 'win32')
  for (const endpoint of ['npipe:////remote/pipe/docker_engine', 'tcp://127.0.0.1:2375', 'ssh://localhost', 'npipe:////./pipe/other']) {
    assert.throws(() => assertLocalEndpoint(endpoint, 'win32'))
  }
  let id = engine.id
  const argsSeen = []
  const execute = async (selected, args) => {
    argsSeen.push(args)
    if (args[0] === 'context') return { stdout: JSON.stringify(windowsEngine.endpoint) }
    assert.equal(selected.endpoint, windowsEngine.endpoint)
    return { stdout: JSON.stringify({ OSType: 'linux', Architecture: 'x86_64', ID: id }) }
  }
  const options = { execute, platform: 'win32', arch: 'x64', source: {} }
  const selected = await discoverEngine(undefined, options)
  assert.equal(selected.id, id)
  argsSeen.length = 0
  await discoverEngine(selected, options)
  assert.deepEqual(argsSeen.map(args => args[0]), ['info'])
  id = 'other-engine'
  await assert.rejects(discoverEngine(selected, options), /engine changed/)
  const env = engineEnvironment(selected, { PATH: 'fixture', DOCKER_HOST: 'remote', DOCKER_CONTEXT: 'remote', API_KEY: 'never-pass' })
  assert.deepEqual(env, { PATH: 'fixture', DOCKER_HOST: windowsEngine.endpoint })
})

test('native Windows Broker uses the bundled host path and keeps the selected engine out of shell commands', () => {
  const config = { image, native: true, entrypoint: 'C:\\Program Files\\DS Bot\\broker\\main.mjs', engine }
  assert.deepEqual(brokerLaunch(config, 'win32'), { entrypoint: config.entrypoint, args: [image], engine })
  assert.throws(() => brokerLaunch({ ...config, entrypoint: 'relative.mjs' }, 'win32'))
  assert.throws(() => brokerLaunch({ ...config, wsl: {} }, 'win32'))
})

test('the shipped plugin resolves and validates its own runtime without an app launcher', async () => {
  const payload = await loadSetupRuntime()
  assert.match(payload.recipe, /^[a-f0-9]{64}$/)
  assert.ok(payload.broker(engine, image).entrypoint.endsWith('computer-runtime/broker/main.mjs'))
})


test('engine choice is saved before building and cannot silently move existing desktop data', async t => {
  const h = await fixture(t)
  const selected = { ...engine, kind: 'podman' }
  h.runtime.validate = value => assert.equal(value.kind, 'podman')
  h.runtime.discover = async (saved, kind) => {
    assert.equal(kind, 'podman')
    if (saved) assert.deepEqual(saved, selected)
    return selected
  }
  await h.setup.prepare({ botId: 'a', engineKind: 'podman' })
  await h.settled()
  assert.equal((await h.setup.state()).engine, 'podman')
  const saved = JSON.parse(await readFile(join(h.home, 'computers/setup.json')))
  assert.equal(saved.job.engineKind, 'podman')
  assert.equal(saved.config.engine.kind, 'podman')
  await assert.rejects(h.setup.prepare({ botId: 'a', engineKind: 'docker' }), /original desktop engine/)
  await assert.rejects(h.setup.state({ engineKind: 'docker' }), /original desktop engine/)
})

test('Windows machine preparation requires an explicit user operation and survives as an interrupted task', async t => {
  const h = await fixture(t, {}, { platform: 'win32' })
  let started = false
  h.runtime.startRuntime = async (_engine, { signal }) => {
    started = true
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  await h.setup.state({ engineKind: 'podman' })
  assert.equal(started, false)
  await h.setup.prepare({ botId: 'a', engineKind: 'podman', prepareRuntime: true })
  await until(() => started)
  const saved = JSON.parse(await readFile(join(h.home, 'computers/setup.json')))
  assert.equal(saved.job.phase, 'preparing-runtime')
  assert.equal(saved.job.prepareRuntime, true)
  const { job } = await h.setup.state()
  await h.setup.cancel({ jobId: job.id })
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'cancelled')
  assert.equal(h.rt.computer, undefined)
})

test('a newer package does not relabel an existing pinned image as the new recipe', async t => {
  const h = await fixture(t)
  h.available()
  await mkdir(join(h.home, 'computers'))
  await writeFile(join(h.home, 'computers/setup.json'), JSON.stringify({ version: 1, config: { engine, image, recipe } }))
  h.runtime.recipe = 'c'.repeat(64)
  await h.setup.prepare({ botId: 'a' })
  await h.settled()
  const saved = JSON.parse(await readFile(join(h.home, 'computers/setup.json')))
  assert.equal(saved.config.image, image)
  assert.equal(saved.config.recipe, recipe)
  assert.equal(h.calls.includes('build'), false)
})

test('retry after host restart retains the explicitly selected machine preparation step', async t => {
  const h = await fixture(t, {}, { platform: 'win32' })
  await mkdir(join(h.home, 'computers'))
  await writeFile(join(h.home, 'computers/setup.json'), JSON.stringify({
    version: 1, job: { id: 'rebooted', botId: 'a', engineKind: 'podman', prepareRuntime: true, phase: 'preparing-runtime' },
  }))
  let machineStarts = 0
  h.runtime.startRuntime = async () => { machineStarts++ }
  h.runtime.discover = async () => ({ ...engine, kind: 'podman' })
  const state = await h.setup.state()
  assert.equal(state.job.phase, 'interrupted')
  assert.equal(machineStarts, 0)
  await h.setup.prepare({ botId: 'a', jobId: state.job.id })
  await h.settled()
  assert.equal(machineStarts, 1)
  assert.equal((await h.setup.state()).job.phase, 'ready')
})

test('Windows installation persists consent and resumes after a new boot without replaying WSL', async t => {
  const h = await fixture(t, {}, { platform: 'win32' })
  let status = { bootId: '2026-11-01T01:00:00.000Z', wslReady: false, engineInstalled: false, wingetAvailable: true }
  const installs = []
  let opens = 0
  h.runtime.systemStatus = async () => status
  h.runtime.installSystem = async (_, component) => {
    const saved = JSON.parse(await readFile(join(h.home, 'computers/setup.json')))
    assert.equal(saved.job.systemStep, component)
    installs.push(component)
    if (component === 'engine') status.engineInstalled = true
  }
  h.runtime.openEngine = async () => { opens++ }
  await assert.rejects(h.setup.prepare({ botId: 'a', installSystem: true }), /Confirm/)
  await h.setup.prepare({ botId: 'a', installSystem: true, installConsent: true })
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'waiting-restart')
  await h.setup.resume()
  assert.deepEqual(installs, ['wsl'])
  status = { ...status, bootId: '2026-11-01T02:00:00.000Z', wslReady: true }
  await Promise.all([h.setup.resume(), h.setup.resume()])
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'ready')
  assert.deepEqual(installs, ['wsl', 'engine'])
  assert.equal(opens, 1)
})

test('cancelled restart waiting does not resume; changing engines needs new installation consent', async t => {
  const h = await fixture(t, {}, { platform: 'win32' })
  let status = { bootId: '2026-11-01T01:00:00.000Z', wslReady: false }
  let installs = 0
  h.runtime.systemStatus = async () => status
  h.runtime.installSystem = async () => { installs++ }
  await h.setup.prepare({ botId: 'a', installSystem: true, installConsent: true })
  await h.settled()
  const { job } = await h.setup.state()
  await assert.rejects(h.setup.prepare({ botId: 'a', jobId: job.id, engineKind: 'podman' }), /Confirm/)
  await h.setup.cancel({ jobId: job.id })
  status = { ...status, bootId: '2026-11-01T02:00:00.000Z', wslReady: true }
  await h.setup.resume()
  assert.equal((await h.setup.state()).job.phase, 'cancelled')
  assert.equal(installs, 1)
})

test('host restart reconciles an uncertain engine installer without replay or premature image preparation', async t => {
  const h = await fixture(t, {}, { platform: 'win32' })
  await mkdir(join(h.home, 'computers'))
  await writeFile(join(h.home, 'computers/setup.json'), JSON.stringify({ version: 1,
    job: { id: 'saved', botId: 'a', engineKind: 'docker', phase: 'installing-system',
      installSystem: true, resumeAfterRestart: true, systemStep: 'engine' } }))
  let installed = false, opens = 0
  h.runtime.systemStatus = async () => ({ bootId: '2026-11-01T01:00:00.000Z', wslReady: true, engineInstalled: installed })
  h.runtime.installSystem = async () => assert.fail('Uncertain installation must not replay')
  h.runtime.openEngine = async () => { opens++ }
  await h.setup.restore()
  assert.equal((await h.setup.state()).job.phase, 'interrupted')
  assert.equal(h.calls.includes('build'), false)
  installed = true
  await h.setup.resume()
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'ready')
  assert.equal(opens, 1)
})

test('waiting for Docker never repeatedly opens it and missing winget produces a useful failure', async t => {
  const h = await fixture(t, {}, { platform: 'win32' })
  let installed = false, opens = 0
  h.runtime.systemStatus = async () => ({ bootId: '2026-11-01T01:00:00.000Z', wslReady: true, engineInstalled: installed, wingetAvailable: false })
  h.runtime.openEngine = async () => { opens++ }
  await h.setup.prepare({ botId: 'a', installSystem: true, installConsent: true })
  await h.settled()
  assert.match((await h.setup.state()).job.error, /App Installer/)
  installed = true
  h.discoveryError('engine is starting')
  await h.setup.prepare({ botId: 'a', installSystem: true, installConsent: true })
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'waiting-runtime')
  await h.setup.resume()
  assert.equal(opens, 1)
  h.discoveryError(null)
  await h.setup.resume()
  await h.settled()
  assert.equal((await h.setup.state()).job.phase, 'ready')
  assert.equal(opens, 1)
})
