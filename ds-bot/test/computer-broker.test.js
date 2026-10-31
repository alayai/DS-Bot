import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { McpClient } from '../../computer-runtime/broker/mcp.mjs'
import { assertContainer, assertLocalEndpoint, assertVolume, assertHomeImage } from '../../computer-runtime/broker/boundary.mjs'
import { driverInput, driverReceipt } from '../../computer-runtime/broker/input.mjs'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'

const image = `sha256:${'a'.repeat(64)}`
const target = { record: { id: 'cmp_fixture', botId: 'bot' }, volume: 'dsbot-fixture-home' }
function container() {
  return {
    Image: image,
    Config: { User: '1000:1000', Labels: {
      'org.ds-bot.computer.id': target.record.id,
      'org.ds-bot.computer.owner': target.record.botId, 'org.ds-bot.computer.protocol': '1',
    } },
    HostConfig: {
      NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3, NanoCpus: 2_000_000_000,
      PidsLimit: 512, RestartPolicy: { Name: 'no' },
    },
    Mounts: [{ Name: target.volume, Destination: '/home/cua', Type: 'volume', RW: true }],
  }
}

test('Broker refuses changed ownership, resource limits, host access and runtime images', () => {
  assertContainer(container(), target, image)
  for (const change of [
    value => { value.Config.Labels['org.ds-bot.computer.owner'] = 'other' },
    value => { value.Image = 'another-image' },
    value => { value.Config.User = 'root' },
    value => { value.HostConfig.NetworkMode = 'host' },
    value => { value.HostConfig.Memory = 0 },
    value => { value.HostConfig.MemorySwap = -1 },
    value => { value.HostConfig.NanoCpus = 0 },
    value => { value.HostConfig.PidsLimit = -1 },
    value => { value.HostConfig.Privileged = true },
    value => { value.HostConfig.DeviceRequests = [{ Capabilities: [['gpu']] }] },
    value => { value.HostConfig.SecurityOpt.push('seccomp=unconfined') },
    value => { value.HostConfig.RestartPolicy.Name = 'always' },
    value => { value.Mounts[0].Type = 'bind' },
    value => { value.Mounts.push({ Destination: '/var/run/docker.sock' }) },
    value => { value.HostConfig.PortBindings = { '5901/tcp': [{ HostPort: '5901' }] } },
  ]) {
    const value = container()
    change(value)
    assert.throws(() => assertContainer(value, target, image))
  }
})

test('named volumes cannot hide bind, network or unowned storage', () => {
  const volume = { Name: target.volume, Driver: 'local', Labels: { 'org.ds-bot.computer.id': target.record.id }, Options: null }
  assertVolume(volume, target)
  for (const patch of [
    { Labels: {} }, { Driver: 'nfs' }, { Name: 'another-volume' },
    { Options: { type: 'none', o: 'bind', device: '/home/user' } },
  ]) assert.throws(() => assertVolume({ ...volume, ...patch }, target))
  assertLocalEndpoint('unix:///var/run/docker.sock', 'linux')
  for (const endpoint of ['ssh://remote', 'tcp://localhost:2375', 'unix://', null]) assert.throws(() => assertLocalEndpoint(endpoint))
})

test('CUA input is a bounded allowlist and never promotes an unverifiable receipt to success', () => {
  const frame = { capture_id: 'capture-fixture', screenshot_width: 100, screenshot_height: 100 }
  const input = action => driverInput([action], frame)
  assert.equal(input({ type: 'click', x: 1, y: 2 }).args.capture_id, frame.capture_id)
  assert.deepEqual(input({ type: 'text', text: 'fixture' }), { name: 'type_text', args: { scope: 'desktop', text: 'fixture' } })
  assert.equal(input({ type: 'key', key: 'ArrowLeft' }).args.key, 'left')
  assert.equal(input({ type: 'scroll', x: 1, y: 2, deltaY: -3 }).args.direction, 'up')
  for (const action of [
    { type: 'click', x: 100, y: 1 }, { type: 'key', key: '__proto__' },
    { type: 'text', text: 'x', command: 'host-exec' }, { type: 'text', text: '\0' },
    { type: 'scroll', x: 1, y: 2, deltaY: 51 }, { type: 'revoke' },
  ]) assert.throws(() => input(action))
  assert.throws(() => driverInput([{ type: 'key', key: 'Tab' }, { type: 'key', key: 'Tab' }], frame))
  for (const result of [{ effect: 'unverifiable' }, {}, { error: 'lost after dispatch' }, undefined]) {
    assert.equal(driverReceipt(result).outcome, 'unknown')
  }
  assert.equal(driverReceipt({ effect: 'refused' }).outcome, 'rejected')
})

test('cancelling MCP retires the connection and rejects other pending work', async t => {
  const client = new McpClient(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'])
  t.after(() => client.close())
  const abort = new AbortController()
  const first = client.request('tools/call', {}, abort.signal)
  const second = client.request('tools/call', {})
  const failures = Promise.all([assert.rejects(first, /cancelled/), assert.rejects(second, /transport closed/)])
  abort.abort()
  await failures
  assert.equal(client.pending.size, 0)
  await assert.rejects(client.request('tools/call', {}), /transport is closed/)
})

test('malformed MCP output cannot leave a pending request or a reusable input transport', async t => {
  const client = new McpClient(process.execPath, ['-e', 'process.stdin.on("data", () => process.stdout.write("invalid-json\\n"))'])
  t.after(() => client.close())
  await assert.rejects(client.request('tools/call', {}), /transport closed/)
  assert.equal(client.pending.size, 0)
  assert.equal(client.closed, true)
})

test('Broker IPC disconnection rejects pending requests and forbids automatic reconnection', { skip: process.platform !== 'linux' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-broker-'))
  const entrypoint = join(home, 'fixture.mjs')
  await writeFile(entrypoint, `
process.on('message', message => {
  if (message.method === 'start') { process.disconnect(); return }
  process.send({ id: message.id, ok: true, value: { phase: 'stopped' } })
})
`)
  const provider = createBrokerProvider({ entrypoint, image })
  t.after(async () => { await provider.dispose(); await rm(home, { recursive: true, force: true }) })
  assert.equal((await provider.inspect(target.record)).phase, 'stopped')
  await assert.rejects(provider.start(target.record), /disconnected/)
  assert.throws(() => provider.inspect(target.record), /Restart the host/)
})

test('Windows Broker launch uses fixed WSL argv without a command shell', async () => {
  const { brokerLaunch } = await import('../src/host/computer/providers/transport.js')
  const config = { image, entrypoint: '/mnt/d/with spaces/broker.mjs', wsl: { distribution: 'Ubuntu-24.04', node: '/usr/bin/node' } }
  assert.deepEqual(brokerLaunch(config, 'win32'), {
    command: 'wsl.exe', args: ['--distribution', 'Ubuntu-24.04', '--exec', '/usr/bin/node', '/mnt/d/with spaces/broker.mjs', image, '--stdio'],
  })
  for (const patch of [{ wsl: null }, { entrypoint: 'C:\\host.js' }, { image: 'latest' }, { wsl: { ...config.wsl, distribution: 'bad\nname' } }, { wsl: { ...config.wsl, distribution: '--help' } }]) {
    assert.throws(() => brokerLaunch({ ...config, ...patch }, 'win32'))
  }
})

test('a removed container cannot make its old home eligible for an unrelated image', () => {
  const pinned = `sha256:${'a'.repeat(64)}`
  const other = `sha256:${'b'.repeat(64)}`
  const volume = { Labels: { 'org.ds-bot.computer.image': pinned } }
  assertHomeImage(volume, {}, pinned)
  assertHomeImage({ Labels: {} }, { runtimeImage: pinned }, pinned)
  assertHomeImage({ Labels: {} }, {}, pinned, pinned)
  assert.throws(() => assertHomeImage(volume, {}, other), /another desktop image/)
  assert.throws(() => assertHomeImage(volume, { runtimeImage: other }, pinned), /another desktop image/)
  assert.throws(() => assertHomeImage({ Labels: {} }, {}, pinned), /cannot be verified/)
})

test('upgrade image IDs remain a bounded ordered argv value on Windows and Linux', async () => {
  const { brokerLaunch } = await import('../src/host/computer/providers/transport.js')
  const candidate = `sha256:${'b'.repeat(64)}`
  const config = { entrypoint: '/runtime/broker.mjs', image, images: [image, candidate], wsl: { distribution: 'Ubuntu', node: '/usr/bin/node' } }
  assert.equal(brokerLaunch(config, 'win32').args.at(-1), JSON.stringify([image, candidate]))
  assert.deepEqual(brokerLaunch(config, 'linux').args, [image, '--ipc', JSON.stringify([image, candidate])])
  for (const images of ['not-an-array', ['mutable:tag'], Array(5).fill(candidate)]) assert.throws(() => brokerLaunch({ ...config, images }, 'linux'))
})
