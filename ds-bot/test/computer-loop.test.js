import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionStore } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { install } from '../src/host/computer.js'
import { createFakeComputer } from '../src/host/computer/providers/fake.js'

test('real DSH agent loop sends a Computer screenshot to its next model request and exports a file', { timeout: 20000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-computer-loop-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime]) await ctx.plugin(plugin)
  const attachments = new LocalAttachmentStore(ctx, { dshHome: home })
  const requests = []
  class Mock extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
    async *stream(options) {
      requests.push(options)
      const number = requests.length
      if (number <= 4) {
        const name = ['computer_observe', 'computer_import', 'computer_export', 'computer_request_takeover'][number - 1]
        const args = number === 1 ? {} : number === 2 ? { attachmentId: source.attachmentId, name: 'loop.txt' } : number === 3 ? { name: 'loop.txt' } : { reason: 'other', note: 'Review the artifact on the desktop.' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: `call-${number}`, name, argumentsDelta: JSON.stringify(args) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Artifact delivered.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Mock())
  ctx.provide('approval', { request: async () => 'allowed-once' })
  const provider = createFakeComputer()
  const rt = {
    ctx, home, config: { computer: { enabled: true }, computerProvider: provider },
    load: async () => {}, readOnly: () => undefined,
    isBotSession: id => id === 'fixture', selfOf: () => 'fixture',
    botOf: id => id === 'fixture' ? { id, name: 'Fixture' } : undefined,
    chatOf: () => 'fixture', groupOwners: new Map(), live: new Map(), warn: () => {},
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') rt.live.set(session.id, { turn: event.data.turn })
  })
  install(rt)
  const record = await rt.computer.bind({ botId: 'fixture', grant: 'operate', expectedRevision: 0 })
  await rt.computer.manage('start', { botId: 'fixture', expectedGeneration: record.generation })
  const source = await attachments.saveFile({ data: Buffer.from('round trip through the agent'), name: 'source.txt' })
  await ctx.plugin(AgentLoop)
  const handle = await ctx.agents.create({ sessionId: 'fixture', agentOptions: { provider: 'fixture', model: 'vision' } })
  const ended = new Promise(resolve => ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') resolve(event.data) }))
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Observe, import the attachment, and export it.' }, { type: 'file', attachment: source },
  ] }))
  const end = await ended
  assert.equal(requests.length, 4, JSON.stringify(end))
  const image = requests[1].messages.flatMap(message => message.content).find(block => block.type === 'image')
  assert.ok(image, 'the next adapter request contains an image, not JSON describing an image')
  const rendered = handle.agent.session.deriveMessages().filter(message => message.role === 'tool')
  assert.ok(rendered.every(message => message.isError !== true), JSON.stringify(rendered))
  const file = rendered.flatMap(message => message.content).find(block => block.type === 'file')?.attachment
  assert.equal(file?.name, 'loop.txt')
  const chunks = []
  for await (const chunk of attachments.readFileStream(file)) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), 'round trip through the agent')
  assert.ok(Object.isFrozen(requests[1]))
  const pending = (await rt.computer.handoffs.list())[0]
  assert.ok(pending, 'the real takeover tool concludes its turn and leaves a durable request')
  rt.resolveAgent = async () => handle.agent
  rt.deliver = async args => {
    const validate = await rt.computer.handoffs.validateDelivery(args.computerHandoff, args.sessionId)
    validate()
    handle.agent.followup(createUserMessage({ source: { kind: 'bot', role: args.role, exchangeId: args.exchangeId }, content: [{ type: 'text', text: args.text }] }))
    await ctx.sessions.flush(handle.agent.session)
  }
  const resumed = new Promise(resolve => ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') resolve(event.data) }))
  await rt.computer.handoffs.answer({ botId: 'fixture', requestId: pending.id, outcome: 'skip' })
  await resumed
  assert.equal(requests.length, 5)
  assert.ok(requests[4].messages.some(message => message.source?.exchangeId === pending.id))
  assert.equal((await rt.computer.handoffs.list()).length, 0)
  await handle.dispose()
})

test('real DSH loop claims queued desktop work and records explicit completion without replay', { timeout: 20000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-task-loop-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime]) await ctx.plugin(plugin)
  new LocalAttachmentStore(ctx, { dshHome: home })
  let taskId, requests = 0, trigger
  class TaskModel extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
    async *stream() {
      requests++
      if (requests > 4) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Stop the fixture.' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: `task-call-${requests}`, name: requests === 1 ? 'computer_observe' : 'computer_task_update',
        argumentsDelta: JSON.stringify(requests === 1 ? {} : { taskId, status: 'completed', note: 'Observed the screenshot and verified the requested desktop state.' }) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new TaskModel())
  const rt = { ctx, home, config: { computer: { enabled: true }, computerProvider: createFakeComputer() }, load: async () => {}, readOnly: () => undefined,
    isBotSession: id => id === 'queue-fixture', selfOf: () => 'queue-fixture', botOf: id => id === 'queue-fixture' ? { id } : undefined,
    chatOf: () => 'queue-fixture', groupOwners: new Map(), live: new Map(), warn: () => {} }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') { trigger = event.data.source; const live = rt.live.get(session.id); if (live) live.info = trigger }
    if (event.type === 'turn/start') rt.live.set(session.id, { turn: event.data.turn, info: trigger })
  })
  install(rt)
  const record = await rt.computer.bind({ botId: 'queue-fixture', grant: 'observe', expectedRevision: 0 })
  await rt.computer.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  await ctx.plugin(AgentLoop)
  const handle = await ctx.agents.create({ sessionId: 'queue-fixture', agentOptions: { provider: 'fixture', model: 'vision' } })
  rt.resolveAgent = async () => handle.agent
  rt.deliver = async args => {
    const validate = await rt.computer.tasks.validateDelivery(args.computerTask, args.sessionId)
    validate()
    handle.agent.followup(createUserMessage({ source: { kind: 'ds-bot', role: 'resume', exchangeId: args.exchangeId }, content: [{ type: 'text', text: args.text }] }))
    await ctx.sessions.flush(handle.agent.session)
  }
  const [task] = await rt.computer.tasks.command('add', { botId: record.botId, expectedGeneration: record.generation, goal: 'Observe the desktop and report verification.' })
  taskId = task.id
  const ended = new Promise(resolve => ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') resolve(event.data) }))
  await rt.computer.tasks.tick(); const end = await ended
  assert.equal(requests, 2, JSON.stringify({end,messages:handle.agent.session.deriveMessages()}))
  assert.equal((await rt.computer.tasks.list(record.botId))[0].status, 'completed')
  await rt.computer.tasks.tick(); assert.equal(requests, 2)
})
