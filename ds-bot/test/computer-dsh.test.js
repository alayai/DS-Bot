import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { createRuntime } from '../index.js'
import { createFakeComputer } from '../src/host/computer/providers/fake.js'
import { browserOutput } from '../src/host/browser/mount.js'
import { encodePng } from '../src/office/png.js'
import { fakeContext } from './fake-ctx.js'

async function host(t, enabled = true, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-computer-host-'))
  await writeFile(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 0, mainBotIds: ['a'],
    bots: { a: { id: 'a', sessionId: 'a', name: 'Alpha', createdAt: 1 } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
  }))
  const ctx = fakeContext()
  let route
  ctx.connection.fetch.register = value => { route = value; return () => {} }
  const rt = createRuntime(ctx, { home, computer: { enabled }, computerProvider: createFakeComputer(), ...options })
  await rt.load()
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  async function call(endpoint, payload = {}) {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  return { ctx, rt, call }
}

test('disabled Computer feature adds no tools, service or mutable API', async t => {
  const h = await host(t, false)
  assert.equal(h.rt.computer, undefined)
  assert.ok(![...h.ctx.registeredTools.keys()].some(name => name.startsWith('computer_')))
  assert.equal((await h.call('computer-start', { botId: 'a', expectedGeneration: 1 })).error.code, 'bot/computer-off')
  assert.equal((await h.call('computer-reconnect', { botId: 'a', expectedGeneration: 1 })).error.code, 'bot/computer-off')
  assert.equal((await h.call('computer-setup-prepare', { botId: 'a' })).error.code, 'bot/computer-off')
})

test('desktop service recovery is a user management endpoint, not a model tool', async t => {
  let restarts = 0
  const provider = Object.assign(createFakeComputer(), { recoverySupported: true, reconnect: async () => { restarts++ } })
  const h = await host(t, true, { computerProvider: provider })
  await h.ctx.emitAsync('agent/created', { agent: h.ctx.scopeAgent('a') })
  assert.ok(!h.ctx.registeredTools.has('computer_reconnect'))
  await h.call('computer-bind', { botId: 'a', expectedRevision: 0 })
  const state = (await h.call('computer-state')).value
  const args = { botId: 'a', expectedGeneration: 1, expectedRecovery: state.recovery.version }
  assert.equal((await h.call('computer-reconnect', args)).ok, true)
  assert.equal((await h.call('computer-reconnect', args)).ok, false)
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = (await h.call('computer-state')).value
    if (value.recovery.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal((await h.call('computer-state')).value.recovery.status, 'completed')
  assert.equal(restarts, 1)
})

test('installed plugin setup enables scoped tools and reports capability changes in unchanged state replies', async t => {
  const image = `sha256:${'a'.repeat(64)}`
  const h = await host(t, undefined, {
    computer: {},
    computerSetupOptions: { runtime: async () => ({
      recipe: 'b'.repeat(64), validate: () => {},
      discover: async () => ({ kind: 'docker' }), image: async () => image,
      broker: () => ({}),
    }) },
  })
  assert.equal(h.rt.computer, undefined)
  await h.ctx.emitAsync('agent/created', { agent: h.ctx.scopeAgent('a') })
  assert.ok(!h.ctx.registeredTools.has('computer_act'))
  assert.equal((await h.call('computer-setup-prepare', { botId: 'a' })).ok, true)
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await h.call('computer-setup-state')
    if (!state.value.busy) {
      assert.equal(state.value.job.phase, 'ready', state.value.job.error)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(h.rt.computer)
  await h.ctx.emitAsync('agent/created', { agent: h.ctx.scopeAgent('a') })
  assert.ok(h.ctx.registeredTools.has('computer_act'))
  const state = await h.call('state', { since: h.rt.state.revision })
  assert.equal(state.value.unchanged, true)
  assert.equal(state.value.computer, true)
  assert.equal(state.value.computerPreparing, false)
})

test('Computer tools are scoped to Bot agents and management uses the authenticated channel', async t => {
  const h = await host(t)
  assert.ok(!h.ctx.registeredTools.has('computer_act'))
  await h.ctx.emitAsync('agent/created', { agent: h.ctx.scopeAgent('unowned') })
  assert.ok(!h.ctx.registeredTools.has('computer_act'))
  await h.ctx.emitAsync('agent/created', { agent: h.ctx.scopeAgent('a') })
  assert.ok(h.ctx.registeredTools.has('computer_act'))
  assert.ok(!h.ctx.registeredTools.has('computer_bind'))
  const initial = await h.call('computer-state')
  assert.equal(initial.ok, true)
  assert.equal((await h.call('computer-bind', { botId: 'a', expectedRevision: initial.value.revision })).ok, true)
  assert.equal((await h.call('computer-start', { botId: 'a', expectedGeneration: 1 })).value.computers[0].phase, 'ready')
  const takeover = (await h.call('computer-takeover', { botId: 'a', expectedGeneration: 1 })).value
  assert.equal(takeover.computers[0].control, 'human')
  assert.equal((await h.call('computer-release', { botId: 'a', expectedGeneration: 1, controlToken: takeover.controlToken })).value.computers[0].control, 'none')
  assert.equal((await h.call('computer-stop', { botId: 'a', expectedGeneration: 1 })).value.computers[0].phase, 'stopped')
  const deletion = await h.call('delete-bot', { id: 'a' })
  assert.equal(deletion.ok, false)
  assert.equal((await h.call('computer-state')).value.computers[0].archived, false)
})

test('DSH public guard denies direct and nested dispatch despite a later allow listener', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  const tools = new ToolRuntime(ctx)
  let ran = 0
  tools.register(defineTool({
    name: 'probe_input', description: 'Test dispatch policy.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { ran += 1; return 'executed' },
  }))
  tools.guard(exec => exec.name === 'probe_input' ? 'revoked' : undefined)
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  const invoke = extra => tools.execute({
    name: 'probe_input', arguments: {}, callId: 'call', signal: new AbortController().signal, ...extra,
  })
  assert.equal((await invoke()).isError, true)
  // Use an execution token minted by the public executor, as the PTC bridge does.
  let nested
  tools.register(defineTool({
    name: 'probe_outer', description: 'Dispatch one nested call.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, exec) => {
      nested = await invoke({ parent: exec.token, rootCallId: exec.callId })
      return 'settled'
    },
  }))
  await tools.execute({ name: 'probe_outer', arguments: {}, callId: 'outer', signal: new AbortController().signal })
  assert.equal(nested.isError, true)
  assert.equal(ran, 0)
})

test('DSH scoped tools inherit into children but execution guards can deny the child', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  const tools = new ToolRuntime(ctx)
  const a = { id: 'a' }, b = { id: 'b' }, child = { id: 'child' }
  const scoped = createScope(ctx, a)
  bindScopeParent(child, a)
  scoped.ctx.tools.register(defineTool({
    name: 'probe_desktop', description: 'Test scoped access.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'ok',
  }))
  tools.guard(exec => exec.name === 'probe_desktop' && exec.agent?.id !== 'a' ? 'no child grant' : undefined)
  assert.ok(tools.schemas(a).some(tool => tool.name === 'probe_desktop'))
  assert.ok(!tools.schemas(b).some(tool => tool.name === 'probe_desktop'))
  assert.ok(tools.schemas(child).some(tool => tool.name === 'probe_desktop'))
  const result = await tools.execute({
    name: 'probe_desktop', arguments: {}, callId: 'child-call', agent: child, signal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
})

test('real DSH attachment storage and tool rendering preserve image references and normalized dimensions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-computer-attachment-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  const attachments = new LocalAttachmentStore(ctx, { dshHome: home, normalizedImageMaxPixels: 1024 })
  const attachment = await attachments.saveImage({
    mediaType: 'image/png', name: 'Computer probe',
    data: encodePng({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 255) }),
  })
  assert.equal(attachment.width, 32)
  assert.equal(attachment.height, 32)
  const tools = new ToolRuntime(ctx)
  tools.register(defineTool({
    name: 'probe_image', description: 'Test durable image output.', parameters: {},
    output: browserOutput, execute: async () => ({ text: 'frame', attachment }),
  }))
  const result = await tools.execute({
    name: 'probe_image', arguments: {}, callId: 'image-call', signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.deepEqual(result.content.find(block => block.type === 'image')?.attachment, attachment)
  assert.ok(!JSON.stringify(result).includes('base64'))
})
