// Only temporary team storage and objects labelled with its generated Computer id.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createComputerSetup } from '../src/host/computer/setup.js'
import { loadSetupRuntime } from '../src/host/computer/setup-runtime.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'
import { createComputerService } from '../src/host/computer/service.js'
const image = process.env.CUA_TEST_IMAGE
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const run = promisify(execFile), docker = async args => (await run('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout
const home = await mkdtemp(join(tmpdir(), '.dsh-test-cua-management-'))
const rt = { home, config: {}, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'management-test' ? { id } : null }
const setup = createComputerSetup(rt, config => { rt.computer = createComputerService(rt, createBrokerProvider(config)) })
let record, name
async function current() { return (await rt.computer.state()).computers[0] }
async function manage(method) { record = await current(); return rt.computer.manage(method, { botId: record.botId, expectedGeneration: record.generation }) }
async function policy(network, domains = []) {
  await manage('stop'); record = await current()
  await rt.computer.storage('configure', { botId: record.botId, expectedGeneration: record.generation, policy: { cpu: 1, memoryMiB: 1024, network, domains } })
  record = await current(); await manage('start')
}
async function backup(method, args = {}) { record = await current(); return rt.computer.portable.command(method, { botId: record.botId, expectedGeneration: record.generation, ...args }) }
async function settled() {
  for (let i = 0; i < 300; i++) { const state = await rt.computer.portable.state(); if (!state.busy) return state.job; await delay(200) }
  throw Error('Backup timed out')
}
try {
  const tools = await loadSetupRuntime(), engine = await tools.discover()
  await mkdir(join(home, 'computers'))
  await writeFile(join(home, 'computers/setup.json'), JSON.stringify({ version: 1, config: { engine, image, recipe: tools.recipe } }))
  await setup.restore(); record = await rt.computer.bind({ botId: 'management-test', grant: 'observe', expectedRevision: 0 }); name = `dsbot-${record.id}`
  await policy('offline')
  const info = JSON.parse(await docker(['inspect', name]))[0]
  assert.equal(info.HostConfig.Memory, 1024 ** 3); assert.equal(info.HostConfig.NanoCpus, 1e9); assert.equal(info.HostConfig.NetworkMode, 'none')
  await assert.rejects(docker(['exec', name, 'python3', '-c', "import socket;socket.create_connection(('1.1.1.1',443),2)"]))
  await docker(['exec', name, 'python3', '-c', "from pathlib import Path;Path('/home/cua/management-marker').write_text('original marker')"])
  console.log('PASS: configured CPU/RAM and offline isolation')
  await policy('restricted', ['example.com'])
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/management-marker'])).trim(), 'original marker')
  const probe = async url => docker(['exec', name, 'python3', '-c', `import urllib.request;print(urllib.request.urlopen(${JSON.stringify(url)},timeout=12).status)`])
  assert.equal((await probe('https://example.com')).trim(), '200')
  await assert.rejects(probe('https://example.org'))
  await assert.rejects(probe('http://169.254.169.254'))
  await assert.rejects(docker(['exec', name, 'python3', '-c', "import socket;socket.create_connection(('1.1.1.1',443),2)"]))
  await assert.rejects(docker(['exec', name, 'python3', '-c', "import socket;socket.getaddrinfo('example.org',443)"]))
  assert.match(await docker(['exec', name, 'cat', '/home/cua/.dsbot-restricted-browser/user.js']), /network.proxy.type/)
  console.log('PASS: allowed HTTPS succeeds; other domains, metadata IP, direct egress and external DNS fail')
  await policy('open')
  await assert.rejects(docker(['inspect', `dsbot-proxy-${record.id}`]))
  await assert.rejects(docker(['network', 'inspect', `dsbot-net-${record.id}`]))
  await manage('stop')
  await backup('export'); let job = await settled(); assert.equal(job.status, 'ready', job.error)
  const bytes = await readFile(join(home, 'computers', 'portable', `${job.id}.dsbackup`))
  assert.equal(bytes.length, job.bytes)
  await backup('cancel', { id: job.id })
  await manage('start'); await docker(['exec', name, 'python3', '-c', "from pathlib import Path;Path('/home/cua/management-marker').write_text('changed marker')"]); await manage('stop')
  let state = await backup('upload', { bytes: bytes.length }); job = state.job
  for (let offset = 0; offset < bytes.length; offset += state.chunkSize) await backup('write', { id: job.id, offset, data: bytes.subarray(offset, offset + state.chunkSize).toString('base64') })
  await backup('import', { id: job.id, confirm: true }); job = await settled(); assert.equal(job.status, 'completed', job.error)
  await manage('start'); assert.equal((await docker(['exec', name, 'cat', '/home/cua/management-marker'])).trim(), 'original marker')
  record = await current(); assert.equal(record.previousHomes.length, 1)
  console.log('PASS: streamed external backup restores verified content into a new home and retains the old home')
  await manage('stop'); await backup('cancel', { id: job.id })
  const saved = JSON.parse(await readFile(join(home, 'computers', 'registry.json'))).computers[record.id].homeRevision
  const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1
  state = await backup('upload', { bytes: damaged.length }); job = state.job
  for (let offset = 0; offset < damaged.length; offset += state.chunkSize) await backup('write', { id: job.id, offset, data: damaged.subarray(offset, offset + state.chunkSize).toString('base64') })
  await backup('import', { id: job.id, confirm: true }); job = await settled(); assert.equal(job.status, 'failed')
  record = await current(); assert.equal(record.recoveryPending, true)
  await rt.computer.storage('recover', { botId: record.botId, expectedGeneration: record.generation })
  assert.equal(JSON.parse(await readFile(join(home, 'computers', 'registry.json'))).computers[record.id].homeRevision, saved)
  await manage('start'); assert.equal((await docker(['exec', name, 'cat', '/home/cua/management-marker'])).trim(), 'original marker')
  console.log('PASS: corrupt import is rejected, recovery cleans staging and current home remains intact')

} finally {
  await rt.computer?.dispose().catch(() => {}); await setup.dispose().catch(() => {})
  if (record) {
    // Names/labels are generated by this isolated test; never use global prune.
    await docker(['rm', '-f', name]).catch(() => {})
    await docker(['rm', '-f', `dsbot-proxy-${record.id}`]).catch(() => {})
    await docker(['network', 'rm', `dsbot-net-${record.id}`]).catch(() => {})
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=org.ds-bot.computer.id=${record.id}`])).trim().split(/\s+/).filter(Boolean)
    for (const volume of volumes) await docker(['volume', 'rm', volume])
  }
  await rm(home, { recursive: true, force: true })
}
