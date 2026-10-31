import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverEngine, engineCommand, engineEnvironment, preparePodmanMachine, validateEngine } from '../../computer-runtime/engine.mjs'
import { normalizePodman, podmanMachine } from '../../computer-runtime/podman.mjs'
import { assertContainer } from '../../computer-runtime/broker/boundary.mjs'

const machine = () => ({
  Name: 'ds-bot', Created: '2026-11-01T00:00:00Z', Rootful: true, State: 'running',
  SSHConfig: { Port: 51234, IdentityPath: 'C:\\Users\\fixture\\.ssh\\podman-machine' },
})
const info = () => ({
  host: { os: 'linux', arch: 'amd64', hostname: 'ds-bot', security: { rootless: false }, cgroupVersion: 'v2' },
  store: { graphRoot: '/var/lib/containers/storage', graphDriverName: 'overlay' },
})
function discovery() {
  const calls = []
  let current = machine(), details = info()
  const execute = async (engine, args) => {
    calls.push({ engine, args })
    if (args[0] === 'machine') return { stdout: JSON.stringify([current]) }
    assert.equal(engine.endpoint, `ssh://root@127.0.0.1:${current.SSHConfig.Port}/run/podman/podman.sock`)
    return { stdout: JSON.stringify(details) }
  }
  const options = { platform: 'win32', arch: 'x64', kind: 'podman', execute, source: {} }
  return { calls, options, machine: value => { current = value }, info: value => { details = value } }
}

test('Podman binds Windows commands to the inspected local machine and retains the image store', async () => {
  const h = discovery()
  const selected = await discoverEngine(undefined, h.options)
  assert.equal(selected.kind, 'podman')
  assert.match(selected.id, /^[a-f0-9]{64}$/)
  assert.deepEqual(selected.machine, { name: 'ds-bot', created: machine().Created })
  assert.deepEqual(await discoverEngine(selected, h.options), selected)
  assert.throws(() => validateEngine({ ...selected, executable: 'docker.exe' }, 'win32'))
  for (const endpoint of [
    'ssh://root@remote:51234/run/podman/podman.sock',
    'ssh://root@127.0.0.1:51234/other.sock',
    'ssh://root:password@127.0.0.1:51234/run/podman/podman.sock',
    'tcp://127.0.0.1:51234',
  ]) assert.throws(() => validateEngine({ ...selected, endpoint }, 'win32'))
  h.machine({ ...machine(), Created: '2026-11-02T00:00:00Z' })
  await assert.rejects(discoverEngine(selected, h.options), /machine changed/)
  h.machine(machine())
  h.info({ ...info(), store: { ...info().store, graphRoot: '/other-store' } })
  await assert.rejects(discoverEngine(selected, h.options), /engine changed/)
  await assert.rejects(discoverEngine(selected, { ...h.options, kind: 'docker' }), /original desktop engine/)
})

test('Podman rejects stopped, rootless, non-Linux and resource-limit-incompatible engines', async () => {
  const h = discovery()
  h.machine({ ...machine(), State: 'stopped' })
  await assert.rejects(discoverEngine(undefined, h.options), { code: 'podman-machine-stopped' })
  h.machine({ ...machine(), Rootful: false })
  await assert.rejects(discoverEngine(undefined, h.options), /rootful/)
  h.machine(machine())
  for (const patch of [{ os: 'windows' }, { arch: 'arm64' }, { cgroupVersion: 'v1' }, { security: { rootless: true } }]) {
    h.info({ ...info(), host: { ...info().host, ...patch } })
    await assert.rejects(discoverEngine(undefined, h.options), /cgroup v2/)
  }
})

test('every Podman subprocess uses fixed connection argv and excludes ambient remote settings', async () => {
  const h = discovery()
  const selected = await discoverEngine(undefined, h.options)
  const prefix = ['--remote', '--url', selected.endpoint, '--identity', selected.identity]
  for (const args of [['exec', '-i', 'owned', 'python3'], ['run', '--rm', 'image'], ['volume', 'inspect', 'home']]) {
    assert.deepEqual(engineCommand(selected, args), [...prefix, ...args])
  }
  assert.deepEqual(engineEnvironment(selected, {
    PATH: 'bin', CONTAINER_HOST: 'ssh://remote', CONTAINER_SSHKEY: 'other-key',
    DOCKER_HOST: 'remote', DOCKER_CONTEXT: 'remote', API_KEY: 'redacted-fixture',
  }), { PATH: 'bin' })
  const create = engineCommand(selected, ['create', '--log-opt', 'max-file=2', '--log-opt', 'max-size=5m', 'image'])
  assert.ok(create.includes('k8s-file'))
  assert.ok(create.includes('max-size=5m'))
  assert.ok(!create.includes('max-file=2'))
})

test('Podman representation normalization does not supply missing isolation settings', () => {
  const id = 'a'.repeat(64), image = `sha256:${id}`
  const target = { record: { id: 'fixture', botId: 'owner' }, volume: 'home' }
  const container = () => ({
    Image: id, Config: { User: '1000:1000', Labels: {
      'org.ds-bot.computer.id': 'fixture', 'org.ds-bot.computer.owner': 'owner', 'org.ds-bot.computer.protocol': '1',
    } },
    HostConfig: { NetworkMode: 'none', CapDrop: ['all'], SecurityOpt: ['no-new-privileges=true'],
      Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3, NanoCpus: 0, CpuPeriod: 100000, CpuQuota: 200000,
      PidsLimit: 512, RestartPolicy: { Name: '' } },
    Mounts: [{ Name: 'home', Destination: '/home/cua', Type: 'volume', RW: true }],
  })
  const normalized = value => JSON.parse(normalizePodman(['inspect', 'owned'], JSON.stringify([value])))[0]
  assertContainer(normalized(container()), target, image)
  for (const change of [
    value => { value.HostConfig.SecurityOpt = [] },
    value => { value.HostConfig.SecurityOpt.push('seccomp=unconfined') },
    value => { value.HostConfig.CapDrop = [] },
    value => { value.HostConfig.CpuQuota = 0 },
    value => { value.HostConfig.MemorySwap = -1 },
    value => { value.HostConfig.NetworkMode = 'host' },
    value => { value.Mounts.push({ Type: 'bind', Destination: '/host' }) },
  ]) {
    const value = container(); change(value)
    assert.throws(() => assertContainer(normalized(value), target, image))
  }
})

test('Podman machine preparation creates only the fixed dedicated machine and never replaces a saved one', async () => {
  const tasks = []
  let rows = []
  const execute = async (_engine, args) => ({ stdout: JSON.stringify(args[1] === 'list' ? rows : [machine()]) })
  const options = { platform: 'win32', execute, task: async (_engine, args) => { tasks.push(args) } }
  await preparePodmanMachine(undefined, {}, options)
  assert.deepEqual(tasks.map(args => args.slice(0, 2)), [['machine', 'init'], ['machine', 'start']])
  assert.ok(tasks[0].includes('--rootful'))
  assert.ok(tasks.every(args => args.at(-1) === 'ds-bot'))
  tasks.length = 0
  rows = [machine()]
  await preparePodmanMachine(undefined, {}, options)
  assert.equal(tasks.length, 0)
  const saved = { kind: 'podman', executable: 'podman.exe', ...podmanMachine(machine()), id: 'fixture' }
  rows = []
  await assert.rejects(preparePodmanMachine(saved, {}, options), /will not be recreated/)
  assert.equal(tasks.length, 0)
  await assert.rejects(preparePodmanMachine({ ...saved, kind: 'docker' }, {}, options), /existing desktop engine/)
})

test('Linux Podman discovery rejects network endpoints and pins a rootful local socket', async () => {
  const execute = async () => ({ stdout: JSON.stringify(info()) })
  const options = { kind: 'podman', platform: 'linux', arch: 'x64', execute, source: {} }
  const selected = await discoverEngine(undefined, options)
  assert.equal(selected.endpoint, 'unix:///run/podman/podman.sock')
  await assert.rejects(discoverEngine(undefined, { ...options, source: { CONTAINER_HOST: 'ssh://remote' } }), /local Unix socket/)
})
