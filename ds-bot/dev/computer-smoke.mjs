// Public DSH tool/attachment runtime → plugin → IPC Broker → guest MCP → fixture.
// Uses no model credentials. The scripted calls do not test visual-model reasoning.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { install } from '../src/host/computer.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'

const image = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Pass the immutable id of the locally built development image.')
const root = resolve(import.meta.dirname, '../..')
const home = await mkdtemp(join(root, '.dsh-test-computer-'))
const run = promisify(execFile)
const docker = args => run('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
const ctx = new Context()
let record
let rt
let approvals = 0
try {
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  ctx.provide('approval', { request: async () => {
    approvals++
    const frame = await rt.computer.preview({ botId: record.botId, expectedGeneration: record.generation })
    assert.equal(frame.width, 1280)
    return 'allowed-once'
  } })
  const attachments = new LocalAttachmentStore(ctx, { dshHome: home })
  const tools = new ToolRuntime(ctx)
  const messages = []
  const agent = {
    id: 'fixture-bot',
    session: {
      id: 'fixture-bot', requestHeader: () => ({ config: { provider: 'fixture', model: 'vision' } }),
      deriveMessages: () => messages,
    },
  }
  agent.ctx = createScope(ctx, agent).ctx
  rt = {
    ctx, home, config: { computer: { enabled: true, broker: { entrypoint: join(root, 'computer-runtime/broker/main.mjs'), image } } },
    load: async () => {}, readOnly: () => undefined,
    isBotSession: id => id === agent.id, selfOf: id => id === agent.id ? id : undefined,
    botOf: id => id === agent.id ? { id, name: 'Fixture Bot' } : undefined,
    groupOwners: new Map(), live: new Map([[agent.id, { turn: 1 }]]), warn: () => {},
  }
  const broker = createBrokerProvider(rt.config.computer.broker)
  rt.config.computerProvider = broker
  install(rt)
  await ctx.parallel('agent/created', { agent })
  record = await rt.computer.bind({ botId: agent.id, grant: 'operate', expectedRevision: 0 })
  const name = `dsbot-${record.id}`
  let controlToken
  const manage = async method => {
    const result = await rt.computer.manage(method, { botId: agent.id, expectedGeneration: record.generation, controlToken })
    controlToken = result.controlToken ?? controlToken
    return result
  }
  let sequence = 0
  async function tool(name, args = {}) {
    const result = await tools.execute({
      name, arguments: args, callId: `fixture-${++sequence}`, agent, signal: AbortSignal.timeout(45_000),
    })
    if (result.isError) throw new Error(`Computer tool failed: ${JSON.stringify(result.content)}`)
    messages.push({ role: 'tool', content: result.content })
    return result
  }
  await manage('start')
  const diagnostics = await rt.computer.diagnostics({ botId: agent.id, expectedGeneration: record.generation })
  assert.equal(diagnostics.network, 'open')
  assert.equal(diagnostics.storage.hardQuota, false)
  assert.ok(diagnostics.storage.freeBytes > 0)
  const interfaces = JSON.parse((await docker(['exec', name, 'python3', '-c', 'import json,socket;print(json.dumps([name for _,name in socket.if_nameindex()]))'])).stdout)
  assert.ok(interfaces.includes('lo'))
  assert.ok(interfaces.some(name => name !== 'lo'))
  console.log('PASS: storage diagnostics read the actual runtime filesystem; the guest has a non-loopback interface')
  console.log('PASS: plugin starts a labelled non-root desktop with open egress through the Broker')
  const fixture = await readFile(join(root, 'computer-runtime/test/fixture.py'), 'utf8')
  // Fixture setup is test-only. These Docker operations are never model tools.
  await docker(['exec', name, 'python3', '-c', `from pathlib import Path;Path('/tmp/fixture.py').write_text(${JSON.stringify(fixture)})`])
  await docker(['exec', '-d', name, 'python3', '/tmp/fixture.py'])
  await docker(['exec', name, 'mkdir', '-p', '/tmp/dsbot-firefox'])
  await docker(['exec', name, 'python3', '-c', 'from pathlib import Path;Path("/tmp/dsbot-firefox/user.js").write_text(\'user_pref("browser.shell.checkDefaultBrowser", false);\\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\\nuser_pref("browser.aboutwelcome.enabled", false);\\n\')'])
  await docker(['exec', '-d', name, 'firefox', '--kiosk', '--no-remote', '--profile', '/tmp/dsbot-firefox', 'http://127.0.0.1:8765/'])
  let pageReady = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await docker(['exec', name, 'sh', '-c', 'test -f /tmp/dsbot-fixture-ready && echo ready || true'])
    if (result.stdout.includes('ready')) { pageReady = true; break }
    await delay(500)
  }
  assert.ok(pageReady, 'the offline fixture window is ready')
  await delay(1500)
  const observed = await tool('computer_observe')
  const frame = JSON.parse(observed.value.text)
  assert.equal(frame.width, 1280)
  assert.equal(frame.height, 800)
  assert.ok(observed.content.some(block => block.type === 'image' && block.attachment?.attachmentId))
  console.log('PASS: real CUA PNG becomes a DSH image attachment with matching coordinates')
  const acted = await input({ type: 'click', x: 100, y: 72 })
  assert.equal(JSON.parse(acted.value).outcome, 'unknown')
  let marker
  for (let attempt = 0; attempt < 20; attempt++) {
    try { marker = (await docker(['exec', name, 'cat', '/tmp/dsbot-fixture-marker'])).stdout; break } catch { await delay(250) }
  }
  assert.equal(marker, '1')
  console.log('PASS: unverifiable driver receipt stays unknown; an independent marker proves exactly one click')
  console.log('PASS: real read-only preview remains available during approval, then model input succeeds')
  async function input(action) {
    // Only an explicit pre-dispatch stale-frame refusal is safe to retry. An
    // unknown receipt returns immediately and must be checked by the fixture.
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(500)
      const observation = await tool('computer_observe')
      await rt.computer.preview({ botId: agent.id, expectedGeneration: record.generation })
      try {
        return await tool('computer_act', { observationId: JSON.parse(observation.value.text).observationId, actions: [action] })
      } catch (error) {
        if (!error.message.includes('The desktop changed before input.') || attempt === 4) throw error
      }
    }
  }
  async function marked(file, expected) {
    for (let attempt = 0; attempt < 30; attempt++) {
      let value
      try { value = (await docker(['exec', name, 'cat', `/tmp/dsbot-fixture-${file}`])).stdout } catch {}
      if (expected(value)) return
      await delay(100)
    }
    assert.fail(`No independent ${file} marker`)
  }
  await input({ type: 'click', x: 100, y: 175 })
  record = await rt.computer.bind({
    botId: agent.id, grant: 'operate', approvalMode: 'yolo',
    expectedRevision: (await rt.computer.state()).revision,
  })
  const previousApprovals = approvals
  await input({ type: 'text', text: 'cua-fixture-text' })
  await marked('text', value => value === 'cua-fixture-text')
  await input({ type: 'key', key: 'Enter' })
  await marked('key', value => value === 'cua-fixture-text')
  await input({ type: 'key', key: 'a', modifiers: ['Control'] })
  await input({ type: 'text', text: 'chord-replaced' })
  await marked('text', value => value === 'chord-replaced')
  await input({ type: 'click', x: 480, y: 340, count: 2 })
  await marked('double', value => value === 'double')
  await input({ type: 'drag', x: 80, y: 490, toX: 450, toY: 490, durationMs: 700 })
  await marked('drag', value => value === 'dragged')
  console.log('PASS: Control+A replacement, double-click and held drag produce independent browser markers')
  await input({ type: 'scroll', x: 500, y: 400, deltaY: 3 })
  await marked('scroll', value => Number(value) > 0)
  console.log('PASS: text, keyboard and scroll input produce independent browser markers')
  assert.equal(approvals, previousApprovals)
  console.log('PASS: YOLO executes real input without requesting approval')
  await manage('takeover')
  const blocked = await tools.execute({
    name: 'computer_observe', arguments: {}, callId: 'blocked', agent, signal: AbortSignal.timeout(10_000),
  })
  assert.equal(blocked.isError, true)
  const human = { botId: agent.id, expectedGeneration: record.generation, controlToken }
  await rt.computer.preview(human)
  const imported = Buffer.from('desktop-transfer-fixture').toString('base64')
  await rt.computer.files({ ...human, operation: 'write', name: 'roundtrip.txt', data: imported })
  assert.equal((await rt.computer.files({ ...human, operation: 'read', name: 'roundtrip.txt' })).data, imported)
  let clicked = false
  for (let attempt = 0; attempt < 5; attempt++) {
    const frame = await rt.computer.preview(human)
    try {
      const args = { ...human, frameId: frame.frameId, requestId: `human-${attempt}`, actions: [{ type: 'key', key: 'Home' }] }
      const response = await rt.computer.humanAct(args)
      assert.equal(response.outcome, 'unknown')
      assert.deepEqual(await rt.computer.humanAct(args), response)
      clicked = true
      break
    } catch (error) {
      if (error.code !== 'bot/computer-stale-observation') throw error
      await delay(250)
    }
  }
  assert.ok(clicked, 'human input dispatch settled')
  await manage('release')
  await tool('computer_observe')
  console.log('PASS: preview preserves model captures; human control, file roundtrip and return to model observation work')
  const modelData = Buffer.alloc(1024 * 1024 + 17, 73)
  const source = await attachments.saveFile({ data: modelData, name: 'source.txt' })
  messages.push({ role: 'user', content: [{ type: 'file', attachment: source }] })
  assert.equal(JSON.parse((await tool('computer_import', { attachmentId: source.attachmentId, name: 'model.txt' })).value).outcome, 'completed')
  const exported = await tool('computer_export', { name: 'model.txt' })
  const reference = exported.content.find(block => block.type === 'file').attachment
  const chunks = []
  for await (const chunk of attachments.readFileStream(reference)) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), modelData)
  console.log('PASS: model import/export moves a 1 MiB attachment through chunked guest transfer with checksum verification')
  await docker(['exec', name, 'python3', '-c', 'from pathlib import Path;Path("/home/cua/dsbot-persistence-probe").write_text("preserved")'])
  await manage('stop')
  await manage('start')
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'preserved')
  await tool('computer_observe')
  console.log('PASS: takeover blocks model observation; stop/start preserves the dedicated home')
  await manage('stop')
  const saved = await rt.computer.storage('checkpoint', { botId: agent.id, expectedGeneration: record.generation })
  const checkpoint = saved.checkpoints[0]
  await manage('start')
  await docker(['exec', name, 'python3', '-c', 'from pathlib import Path;Path("/home/cua/dsbot-persistence-probe").write_text("changed")'])
  await manage('stop')
  const restored = await rt.computer.storage('restore', { botId: agent.id, expectedGeneration: record.generation, checkpointId: checkpoint.id })
  record = restored.computers[0]
  await manage('start')
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'preserved')
  await manage('stop')
  const recreated = await rt.computer.storage('recreate', { botId: agent.id, expectedGeneration: record.generation })
  record = recreated.computers[0]
  await manage('start')
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'preserved')
  console.log('PASS: checkpoint restore stages a verified home; recreate preserves files and saves a backup')
  await manage('stop')
  const storage = async (method, extra = {}) => {
    const result = await rt.computer.storage(method, { botId: agent.id, expectedGeneration: record.generation, ...extra })
    record = result.computers[0]
    return result
  }
  await storage('rollback', { homeRevision: null })
  await manage('start')
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'changed')
  await manage('stop')
  const discarded = record.previousHomes[0]
  await storage('delete-home', { homeRevision: discarded })
  await assert.rejects(docker(['volume', 'inspect', `dsbot-${record.id}-home-${discarded}`]))
  await storage('delete-checkpoint', { checkpointId: checkpoint.id })
  const refreshed = await storage('checkpoint')
  assert.equal(refreshed.checkpoints.length, 2)
  await storage('prune-journal')
  await manage('start')
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'changed')
  console.log('PASS: rollback restores the old home; explicit cleanup frees backup capacity and preserves active bytes')
  await manage('stop')
  const restore = broker.restore
  let staging
  broker.restore = async (target, options) => {
    staging = options.homeRevision
    await restore(target, options)
    throw new Error('synthetic disconnect after staging')
  }
  await assert.rejects(storage('restore', { checkpointId: refreshed.checkpoints[0].id }), /synthetic disconnect/)
  broker.restore = restore
  assert.ok((await docker(['volume', 'inspect', `dsbot-${record.id}-home-${staging}`])).stdout)
  await storage('recover')
  await assert.rejects(docker(['volume', 'inspect', `dsbot-${record.id}-home-${staging}`]))
  await manage('start')
  assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'changed')
  console.log('PASS: an interrupted restore removes only its journaled staging volume and retains the authoritative home')
  const incompatible = createBrokerProvider({ ...rt.config.computer.broker, image: `sha256:${'b'.repeat(64)}` })
  try {
    await assert.rejects(incompatible.start(record), /pinned to another image/)
    assert.equal((await docker(['exec', name, 'cat', '/home/cua/dsbot-persistence-probe'])).stdout, 'changed')
  } finally { await incompatible.dispose() }
  console.log('PASS: a different configured image cannot adopt or mutate the existing desktop home')
} finally {
  await ctx.fiber.dispose()
  if (record) {
    await docker(['rm', '-f', `dsbot-${record.id}`]).catch(() => {})
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=org.ds-bot.computer.id=${record.id}`])).stdout.trim().split('\n').filter(Boolean)
    for (const volume of volumes) await docker(['volume', 'rm', volume]).catch(() => {})
  }
  await rm(home, { recursive: true, force: true })
}
