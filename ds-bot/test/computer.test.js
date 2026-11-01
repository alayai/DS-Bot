import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createComputerService } from '../src/host/computer/service.js'
import { createLeases } from '../src/host/computer/leases.js'
import { checkActions, checkFrame } from '../src/host/computer/contract.js'
import { createFakeComputer } from '../src/host/computer/providers/fake.js'
import { install as installApprovals } from '../src/host/approvals.js'

const fails = code => error => error.code === `bot/computer-${code}`
async function setup(t, { provider = createFakeComputer(), options } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-computer-'))
  const owners = new Map([['a', 'a'], ['a-group', 'a'], ['b', 'b']])
  const bots = { a: { id: 'a', name: 'Alpha' }, b: { id: 'b', name: 'Beta' } }
  const room = { id: 'r', members: ['a', 'b'] }
  const messages = new Map()
  let attachment = 0
  let readOnly
  const services = {
    approval: { request: async () => 'allowed-once' },
    attachments: {
      async saveImage({ data, mediaType }) {
        return { attachmentId: `sha256:${++attachment}`, mediaType, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
      },
    },
  }
  const rt = {
    home, config: {}, load: async () => {}, readOnly: () => readOnly,
    selfOf: id => owners.get(id), isBotSession: id => owners.has(id),
    botOf: id => bots[id], roomOf: id => id === 'r' ? room : undefined,
    groupOwners: new Map([['a-group', { botId: 'a', roomId: 'r' }]]),
    live: new Map([...owners.keys()].map(id => [id, { turn: 1 }])),
    ctx: {
      get: name => services[name],
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    },
  }
  const service = createComputerService(rt, provider, options)
  t.after(async () => {
    await service.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const exec = (sessionId = 'a', callId = 'c1', extra = {}) => ({
    callId, ...extra,
    agent: {
      id: sessionId,
      session: {
        id: sessionId,
        requestHeader: () => ({ config: { provider: 'mock', model: 'vision' } }),
        deriveMessages: () => messages.get(sessionId) ?? [],
      },
    },
  })
  async function bind(botId = 'a', grant = 'operate') {
    return service.bind({ botId, grant, expectedRevision: (await service.state()).revision })
  }
  async function start(botId = 'a', grant = 'operate') {
    const record = await bind(botId, grant)
    await service.manage('start', { botId, expectedGeneration: record.generation })
    return record
  }
  let controlToken
  async function manage(method, botId = 'a') {
    const record = (await service.state()).computers.find(item => item.botId === botId && !item.archived)
    const result = await service.manage(method, { botId, expectedGeneration: record.generation, controlToken })
    controlToken = result.controlToken ?? controlToken
    return result
  }
  async function observe(sessionId = 'a') {
    const result = await service.observe(exec(sessionId))
    messages.set(sessionId, [{ content: [{ type: 'image', attachment: result.attachment }] }])
    return JSON.parse(result.text)
  }
  const click = frame => ({ observationId: frame.observationId, actions: [{ type: 'click', x: 3, y: 4 }] })
  return { service, provider, rt, services, exec, bind, start, manage, observe, click, home, messages, bots, room, owners, readOnly: value => { readOnly = value } }
}

test('Computer starts only on an explicit management request and survives service reload', async t => {
  const h = await setup(t)
  const record = await h.bind()
  assert.equal((await h.service.status(h.exec())).phase, 'stopped')
  await assert.rejects(h.observe(), fails('not-ready'))
  assert.equal(h.provider.calls.length, 0)
  await h.manage('start')
  assert.equal((await h.service.status(h.exec())).phase, 'ready')
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.state()).computers[0].id, record.id)
})

test('off, unknown Sessions, archived parts and subagents cannot reach the provider', async t => {
  const h = await setup(t)
  await assert.rejects(h.observe(), fails('off'))
  await h.start()
  for (const id of ['unknown', 'old-part', 'child']) {
    await assert.rejects(h.service.observe(h.exec(id)), fails('owner-denied'))
  }
  assert.equal(h.provider.calls.length, 0)
})

test('same Bot own/group Sessions serialize while another Bot uses its own desktop', async t => {
  const h = await setup(t)
  const a = await h.start()
  const b = await h.start('b')
  await h.observe()
  await assert.rejects(h.observe('a-group'), fails('busy'))
  await h.observe('b')
  assert.notEqual(a.id, b.id)
  await assert.rejects(h.service.release(h.exec('a-group')), fails('busy'))
  await h.service.release(h.exec())
  await h.observe('a-group')
})

test('input requires successful image persistence and image visibility in this Session', async t => {
  const h = await setup(t)
  await h.start()
  const frame = await h.observe()
  h.messages.clear()
  await assert.rejects(h.service.act(h.click(frame), h.exec()), fails('stale-observation'))
  h.services.attachments.saveImage = async () => { throw new Error('disk full') }
  await assert.rejects(h.observe(), fails('observation-unavailable'))
  await assert.rejects(h.service.act(h.click(frame), h.exec()), fails('stale-observation'))
  assert.equal(h.provider.calls.filter(call => call.method === 'perform').length, 0)
})

test('text-only and unknown models cannot obtain pixel observations', async t => {
  const h = await setup(t)
  await h.start()
  for (const info of [{ inputModalities: ['text'] }, {}]) {
    h.rt.ctx.llm.resolveModelInfo = async () => info
    await assert.rejects(h.observe(), fails('vision-required'))
  }
  assert.equal(h.provider.calls.length, 0)
})

test('observe-only grants cannot perform input and bindings reject unverified isolation', async t => {
  const h = await setup(t)
  await h.start('a', 'observe')
  const frame = await h.observe()
  await assert.rejects(h.service.act(h.click(frame), h.exec()), fails('policy-denied'))
  await assert.rejects(h.service.bind({
    botId: 'a', executionPolicy: 'computer-only', expectedRevision: (await h.service.state()).revision,
  }), fails('policy-denied'))
})

test('approved actions invalidate coordinates and duplicate call ids do not repeat input', async t => {
  const h = await setup(t)
  const record = await h.start()
  const args = h.click(await h.observe())
  const result = await h.service.act(args, h.exec())
  assert.equal(result.outcome, 'completed')
  assert.deepEqual(await h.service.act(args, h.exec()), result)
  assert.equal(h.provider.targets.get(record.id).actions.length, 1)
  await assert.rejects(h.service.act(args, h.exec('a', 'c2')), fails('stale-observation'))
  await assert.rejects(h.service.act({ ...args, actions: [{ type: 'key', key: 'Enter' }] }, h.exec()), fails('conflict'))
})

test('driver failure after input records unknown and does not replay on retry or reload', async t => {
  const provider = createFakeComputer()
  const perform = provider.perform
  provider.perform = async (...args) => { await perform(...args); throw new Error('response lost') }
  const h = await setup(t, { provider })
  const record = await h.start()
  const args = h.click(await h.observe())
  assert.equal((await h.service.act(args, h.exec())).outcome, 'unknown')
  assert.equal((await h.service.act(args, h.exec())).outcome, 'unknown')
  const second = createComputerService(h.rt, provider)
  t.after(() => second.dispose())
  assert.equal((await second.act(args, h.exec())).outcome, 'unknown')
  assert.equal(provider.targets.get(record.id).actions.length, 1)
})

test('unfinished receipts become unknown after a host restart', async t => {
  const h = await setup(t)
  await h.start()
  const args = h.click(await h.observe())
  await h.service.act(args, h.exec())
  const path = join(h.home, 'computers/registry.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  Object.values(saved.operations)[0].outcome = 'pending'
  await writeFile(path, JSON.stringify(saved))
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.act(args, h.exec())).outcome, 'unknown')
})

test('human takeover stops observation, rejects input and invalidates old coordinates', async t => {
  const h = await setup(t)
  await h.start()
  const args = h.click(await h.observe())
  await h.manage('takeover')
  assert.equal((await h.service.status(h.exec())).control, 'human')
  await assert.rejects(h.observe(), fails('human-control'))
  await assert.rejects(h.service.act(args, h.exec()), fails('human-control'))
  await h.manage('release')
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
  await h.observe()
})

test('explicit startup invalidates any observation from the previous desktop lifetime', async t => {
  const h = await setup(t)
  await h.start()
  const args = h.click(await h.observe())
  await h.manage('start')
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
  await h.observe()
})

test('takeover during a pending provider call waits for revocation and never confirms stale input', async t => {
  let entered
  const inside = new Promise(resolve => { entered = resolve })
  const provider = createFakeComputer({
    beforePerform: async ({ signal }) => {
      entered()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
  })
  const h = await setup(t, { provider })
  const record = await h.start()
  const pending = h.service.act(h.click(await h.observe()), h.exec())
  await inside
  await h.manage('takeover')
  assert.equal((await pending).outcome, 'unknown')
  assert.equal(provider.targets.get(record.id).actions.length, 0)
  assert.equal((await h.service.status(h.exec())).control, 'human')
})

test('revocation failure keeps the desktop blocked', async t => {
  const h = await setup(t)
  await h.start()
  await h.observe()
  h.provider.revoke = async () => { throw new Error('offline') }
  await assert.rejects(h.manage('takeover'), fails('revoke-failed'))
  assert.equal((await h.service.status(h.exec())).control, 'blocked')
  await assert.rejects(h.observe(), fails('human-control'))
})

test('a rejected or unavailable approval causes no input', async t => {
  const h = await setup(t)
  await h.start()
  const args = h.click(await h.observe())
  h.services.approval.request = async () => 'rejected'
  await assert.rejects(h.service.act(args, h.exec()), fails('approval-denied'))
  delete h.services.approval
  await assert.rejects(h.service.act(args, h.exec()), fails('approval-required'))
  assert.equal(h.provider.calls.filter(call => call.method === 'perform').length, 0)
})

async function setApproval(h, approvalMode, grant = 'operate') {
  return h.service.bind({ botId: 'a', grant, approvalMode, expectedRevision: (await h.service.state()).revision })
}

test('YOLO skips approval for this desktop, persists, and never replays unknown input', async t => {
  const h = await setup(t)
  const original = await h.start()
  const record = await setApproval(h, 'yolo')
  assert.equal(record.id, original.id)
  delete h.services.approval
  const perform = h.provider.perform
  h.provider.perform = async (...args) => { await perform(...args); throw new Error('receipt lost') }
  const args = h.click(await h.observe())
  assert.equal((await h.service.act(args, h.exec())).outcome, 'unknown')
  assert.equal((await h.service.act(args, h.exec())).outcome, 'unknown')
  assert.equal(h.provider.targets.get(record.id).actions.length, 1)
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.state()).computers[0].approvalMode, 'yolo')
})

test('YOLO retains observe-only, stale-frame, owner and human-control checks', async t => {
  const h = await setup(t)
  await h.start()
  const record = await setApproval(h, 'yolo')
  delete h.services.approval
  const args = h.click(await h.observe())
  await assert.rejects(h.service.act(args, h.exec('unknown')), fails('owner-denied'))
  h.provider.targets.get(record.id).actions.push({ type: 'external-change' })
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
  await h.manage('takeover')
  await assert.rejects(h.observe(), fails('human-control'))
  await setApproval(h, 'yolo', 'observe')
  await assert.rejects(h.service.act(h.click(await h.observe()), h.exec()), fails('policy-denied'))
  assert.equal(h.provider.calls.some(call => call.method === 'perform'), false)
})

test('switching off YOLO invalidates old coordinates and restores approval', async t => {
  const h = await setup(t)
  await h.start()
  await setApproval(h, 'yolo')
  const old = h.click(await h.observe())
  await setApproval(h, 'required')
  await assert.rejects(h.service.act(old, h.exec()), fails('stale-observation'))
  h.services.approval.request = async () => 'rejected'
  await assert.rejects(h.service.act(h.click(await h.observe()), h.exec()), fails('approval-denied'))
  await assert.rejects(h.service.act({ ...h.click(await h.observe()), approvalMode: 'yolo' }, h.exec()), fails('approval-denied'))
  await assert.rejects(setApproval(h, 'arbitrary'), fails('policy-denied'))
})

test('older records without an approval mode still require approval', async t => {
  const h = await setup(t)
  const record = await h.start()
  const path = join(h.home, 'computers/registry.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  delete saved.computers[record.id].approvalMode
  await writeFile(path, JSON.stringify(saved))
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.state()).computers[0].approvalMode, 'required')
  const observed = await second.observe(h.exec())
  h.messages.set('a', [{ content: [{ type: 'image', attachment: observed.attachment }] }])
  delete h.services.approval
  await assert.rejects(second.act(h.click(JSON.parse(observed.text)), h.exec()), fails('approval-required'))
})

test('a pending user approval renews its lease while keeping other Sessions out', async t => {
  const h = await setup(t, { options: { ttl: 120 } })
  await h.start()
  h.services.approval.request = async () => {
    await delay(300)
    await assert.rejects(h.observe('a-group'), fails('busy'))
    return 'allowed-once'
  }
  assert.equal((await h.service.act(h.click(await h.observe()), h.exec())).outcome, 'completed')
})

test('Computer approvals use the group bridge while another Bot can continue', async t => {
  const h = await setup(t)
  let middleware
  let requested
  const waiting = new Promise(resolve => { requested = resolve })
  h.rt.ctx.on = (event, handler) => { if (event === 'approval/request') middleware = handler }
  h.rt.chatOwners = new Map([['a', 'a'], ['b', 'b']])
  installApprovals(h.rt)
  h.services.approval.request = request => {
    const result = middleware(request, () => 'allowed-once')
    if (request.agent.id === 'a-group') requested()
    return result
  }
  await h.start()
  await h.start('b')
  const pending = h.service.act(h.click(await h.observe('a-group')), h.exec('a-group'))
  await waiting
  const card = h.rt.approvalsView()[0]
  assert.equal(card.roomId, 'r')
  assert.equal(card.botId, 'a')
  assert.equal(card.tool, 'computer_act')
  assert.equal(card.answerable, true)
  assert.equal((await h.service.act(h.click(await h.observe('b')), h.exec('b'))).outcome, 'completed')
  h.rt.answerApproval(card.id, 'allow')
  assert.equal((await pending).outcome, 'completed')
  assert.deepEqual(h.rt.approvalsView(), [])
  assert.throws(() => h.rt.answerApproval(card.id, 'allow'), /no longer open/)
})

test('approval never authorizes changed desktop contents', async t => {
  const h = await setup(t)
  const record = await h.start()
  const args = h.click(await h.observe())
  h.services.approval.request = async () => {
    h.provider.targets.get(record.id).actions.push({ type: 'external-change' })
    return 'allowed-once'
  }
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
  assert.equal(h.provider.calls.filter(call => call.method === 'perform').length, 0)
})

test('grant changes during approval revoke the old action', async t => {
  let entered, answer
  const inside = new Promise(resolve => { entered = resolve })
  const h = await setup(t)
  await h.start()
  h.services.approval.request = async ({ signal }) => {
    entered()
    return new Promise(resolve => {
      answer = resolve
      signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
    })
  }
  const pending = h.service.act(h.click(await h.observe()), h.exec())
  const rejected = assert.rejects(pending)
  await inside
  await h.bind('a', 'observe')
  answer('allowed-once')
  await rejected
  assert.equal(h.provider.calls.filter(call => call.method === 'perform').length, 0)
})

test('turn end, group departure and context compaction cannot leave usable old coordinates', async t => {
  const h = await setup(t)
  await h.start()
  let args = h.click(await h.observe())
  await h.service.endTurn('a')
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
  args = h.click(await h.observe('a-group'))
  h.room.members = ['b']
  await assert.rejects(h.service.act(args, h.exec('a-group')), fails('owner-denied'))
  await h.service.endTurn('a-group')
  args = h.click(await h.observe())
  h.messages.get('a')[0].content[0].offloaded = true
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
})

test('turn completion releases ownership even after an action consumes its frame', async t => {
  const h = await setup(t)
  await h.start()
  await h.service.act(h.click(await h.observe()), h.exec())
  await assert.rejects(h.service.release(h.exec('a-group')), fails('busy'))
  await h.service.endTurn('a')
  await h.observe('a-group')
})

test('expired leases cannot act and late releases cannot revoke a replacement', () => {
  let time = 0
  const leases = createLeases({ now: () => time, ttl: 30 })
  const computer = { id: 'a', generation: 1 }
  const first = leases.acquire(computer, { sessionId: 'a', turnId: 1 })
  time = 31
  assert.throws(() => leases.check(first), fails('stale-lease'))
  const next = leases.acquire(computer, { sessionId: 'b', turnId: 2 })
  assert.equal(leases.release(first), false)
  leases.check(next)
})

test('invalid coordinates and unrecognized action fields never reach the provider', () => {
  for (const actions of [
    [], [{ type: 'click', x: -1, y: 0 }], [{ type: 'click', x: 10, y: 0 }],
    [{ type: 'text', text: '' }], [{ type: 'key', key: 'Meta+R' }],
    [{ type: 'click', x: 1, y: 1, botId: 'b' }], [{ type: 'scroll', x: 1, y: 1, deltaY: Infinity }],
    [{ type: '__proto__' }], [{ type: 'toString' }],
  ]) assert.throws(() => checkActions(actions, { width: 10, height: 10 }))
  assert.throws(() => checkFrame({ data: Buffer.alloc(1) }), fails('observation-unavailable'))
})

test('concurrent settings writes use revisions and do not create duplicate ownership', async t => {
  const h = await setup(t)
  const results = await Promise.allSettled([
    h.service.bind({ botId: 'a', expectedRevision: 0 }),
    h.service.bind({ botId: 'a', expectedRevision: 0 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await h.service.state()).computers.length, 1)
})

test('Bot deletion archives the desktop without reassigning its data', async t => {
  const h = await setup(t)
  const original = await h.start()
  await h.observe()
  await h.service.archive('a')
  await assert.rejects(h.observe(), fails('off'))
  const replacement = await h.bind()
  assert.notEqual(replacement.id, original.id)
  assert.equal((await h.service.state()).computers.find(item => item.id === original.id).archived, true)
})

test('loss of the home lock fails closed before touching the provider', async t => {
  const h = await setup(t)
  await h.start()
  h.readOnly('owned elsewhere')
  await assert.rejects(h.observe(), fails('read-only'))
  assert.equal(h.provider.calls.length, 0)
})

test('corrupt metadata is preserved and never silently reset', async t => {
  const h = await setup(t)
  await h.start()
  const path = join(h.home, 'computers/registry.json')
  await writeFile(path, '{broken')
  const second = createComputerService(h.rt, h.provider)
  await assert.rejects(second.state())
  assert.equal(await readFile(path, 'utf8'), '{broken')
  let disposed = false
  h.provider.dispose = async () => { disposed = true }
  await assert.rejects(second.dispose())
  assert.equal(disposed, true)
})

test('operation journal does not retain entered text or screenshot bytes', async t => {
  const h = await setup(t)
  await h.start()
  const frame = await h.observe()
  await h.service.act({
    observationId: frame.observationId, actions: [{ type: 'text', text: 'fixture-private-text-123' }],
  }, h.exec())
  const saved = await readFile(join(h.home, 'computers/registry.json'), 'utf8')
  assert.ok(!saved.includes('fixture-private-text-123'))
  assert.ok(!saved.includes('data:image'))
})

test('coordinates follow DSH normalized attachment dimensions', async t => {
  const h = await setup(t)
  const record = await h.start()
  h.services.attachments.saveImage = async () => ({
    attachmentId: 'sha256:normalized', mediaType: 'image/jpeg', width: 32, height: 24, bytes: 100,
  })
  const frame = await h.observe()
  assert.equal(frame.width, 32)
  assert.equal(frame.scaleX, 2)
  await h.service.act(h.click(frame), h.exec())
  assert.deepEqual(h.provider.targets.get(record.id).actions[0], { type: 'click', x: 6, y: 8 })
})

test('a failed fresh observation invalidates the previous frame', async t => {
  const h = await setup(t)
  await h.start()
  const args = h.click(await h.observe())
  h.provider.observe = async () => { throw new Error('driver offline') }
  await assert.rejects(h.observe())
  await assert.rejects(h.service.act(args, h.exec()), fails('stale-observation'))
})

test('a delayed end event from an old turn cannot revoke the new turn lease', async t => {
  const h = await setup(t)
  await h.start()
  await h.observe()
  await h.service.endTurn('a', 1)
  h.rt.live.set('a', { turn: 2 })
  const frame = await h.observe()
  await h.service.endTurn('a', 1)
  assert.equal((await h.service.act(h.click(frame), h.exec())).outcome, 'completed')
})

test('read-only previews never consume the model observation binding', async t => {
  const h = await setup(t)
  const record = await h.start()
  const frame = await h.observe()
  const preview = await h.service.preview({ botId: 'a', expectedGeneration: record.generation })
  assert.equal(preview.width, 64)
  assert.equal((await h.service.act(h.click(frame), h.exec())).outcome, 'completed')
})

test('read-only preview stays available while a model action waits for approval', async t => {
  let allow
  let requested
  const waiting = new Promise(resolve => { requested = resolve })
  const h = await setup(t)
  h.services.approval.request = () => new Promise(resolve => { allow = resolve; requested() })
  const record = await h.start()
  const frame = await h.observe()
  const pending = h.service.act(h.click(frame), h.exec())
  await waiting
  const preview = await h.service.preview({ botId: 'a', expectedGeneration: record.generation })
  assert.equal(preview.width, 64)
  allow('allowed-once')
  assert.equal((await pending).outcome, 'completed')
})

test('approval drains the in-flight preview before model input and rejects overlapping previews', async t => {
  const h = await setup(t)
  const record = await h.start()
  const frame = await h.observe()
  let allow, requested, finish, entered
  const waiting = new Promise(resolve => { requested = resolve })
  const capturing = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { finish = resolve })
  h.services.approval.request = () => new Promise(resolve => { allow = resolve; requested() })
  const preview = h.provider.preview.bind(h.provider)
  h.provider.preview = async (...args) => { entered(); await held; return preview(...args) }
  const pending = h.service.act(h.click(frame), h.exec())
  await waiting
  const args = { botId: 'a', expectedGeneration: record.generation }
  const shot = h.service.preview(args)
  await capturing
  await assert.rejects(h.service.preview(args), fails('busy'))
  allow('allowed-once')
  await delay(0)
  assert.equal(h.provider.targets.get(record.id).actions.length, 0)
  await assert.rejects(h.service.preview(args), fails('busy'))
  finish()
  assert.equal((await shot).width, 64)
  assert.equal((await pending).outcome, 'completed')
})

test('takeover cancels an approval preview and cannot publish its revoked frame', async t => {
  const h = await setup(t)
  const record = await h.start()
  const frame = await h.observe()
  let requested, entered
  const waiting = new Promise(resolve => { requested = resolve })
  const capturing = new Promise(resolve => { entered = resolve })
  h.services.approval.request = ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve('denied'), { once: true })
    requested()
  })
  const preview = h.provider.preview.bind(h.provider)
  h.provider.preview = async (record, options) => {
    const result = await preview(record, options)
    entered()
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    return result
  }
  const pending = h.service.act(h.click(frame), h.exec())
  const rejected = assert.rejects(pending)
  await waiting
  const shot = h.service.preview({ botId: 'a', expectedGeneration: record.generation })
  const revoked = assert.rejects(shot)
  await capturing
  await h.manage('takeover')
  await Promise.all([rejected, revoked])
  assert.equal(h.provider.targets.get(record.id).actions.length, 0)
  assert.equal((await h.service.state()).computers[0].control, 'human')
})

test('human tokens are window-specific, expire without resuming the Bot, and reject late releases', async t => {
  let time = 1000
  const h = await setup(t, { options: { now: () => time } })
  const record = await h.start()
  const args = { botId: 'a', expectedGeneration: record.generation }
  const first = (await h.service.manage('takeover', args)).controlToken
  assert.ok(first)
  await assert.rejects(h.service.manage('release', args), fails('stale-control'))
  const second = (await h.service.manage('takeover', args)).controlToken
  assert.notEqual(first, second)
  await assert.rejects(h.service.preview({ ...args, controlToken: first }), fails('stale-control'))
  await assert.rejects(h.service.manage('release', { ...args, controlToken: first }), fails('stale-control'))
  time += 60001
  await assert.rejects(h.service.preview({ ...args, controlToken: second }), fails('stale-control'))
  await assert.rejects(h.observe(), fails('human-control'))
  assert.equal((await h.service.state()).computers[0].humanExpired, true)
  await h.service.manage('stop', args)
  await h.service.manage('start', args)
  await h.observe()
})

test('human input uses a current displayed frame and duplicate requests never replay', async t => {
  const h = await setup(t)
  const record = await h.start()
  const args = { botId: 'a', expectedGeneration: record.generation }
  const { controlToken } = await h.service.manage('takeover', args)
  const current = { ...args, controlToken }
  const frame = await h.service.preview(current)
  const input = { ...current, frameId: frame.frameId, requestId: 'click-1', actions: [{ type: 'click', x: 2, y: 3 }] }
  await assert.rejects(h.service.humanAct({ ...input, controlToken: 'other' }), fails('stale-control'))
  assert.equal((await h.service.humanAct(input)).outcome, 'completed')
  assert.equal((await h.service.humanAct(input)).outcome, 'completed')
  assert.equal(h.provider.targets.get(record.id).actions.length, 1)
  await assert.rejects(h.service.humanAct({ ...input, requestId: 'click-2' }), fails('stale-observation'))
  await h.service.manage('release', current)
  await assert.rejects(h.service.humanAct(input), fails('stale-control'))
})

test('stale, changed and replaced human frames cannot input', async t => {
  let time = 100
  const h = await setup(t, { options: { now: () => time } })
  const record = await h.start()
  const args = { botId: 'a', expectedGeneration: record.generation }
  args.controlToken = (await h.service.manage('takeover', args)).controlToken
  const input = frame => h.service.humanAct({ ...args, frameId: frame.frameId, requestId: 'input', actions: [{ type: 'key', key: 'Enter' }] })
  let frame = await h.service.preview(args)
  time += 5001
  await assert.rejects(input(frame), fails('stale-observation'))
  frame = await h.service.preview(args)
  await h.service.preview(args)
  await assert.rejects(input(frame), fails('stale-observation'))
  frame = await h.service.preview(args)
  h.provider.targets.get(record.id).actions.push({ type: 'external-change' })
  await assert.rejects(input(frame), fails('stale-observation'))
  assert.equal(h.provider.calls.filter(call => call.method === 'perform').length, 0)
})

test('file transfer requires current human ownership and rejects traversal and oversized input', async t => {
  const h = await setup(t)
  const record = await h.start()
  const args = { botId: 'a', expectedGeneration: record.generation }
  await assert.rejects(h.service.files({ ...args, operation: 'list' }), fails('stale-control'))
  args.controlToken = (await h.service.manage('takeover', args)).controlToken
  for (const name of ['../private', '/absolute', 'folder/file', 'folder\\file', '.hidden', 'bad\0name']) {
    await assert.rejects(h.service.files({ ...args, operation: 'write', name, data: 'YQ==' }), fails('invalid'))
  }
  await assert.rejects(h.service.files({ ...args, operation: 'write', name: 'big', data: Buffer.alloc(262145).toString('base64') }), fails('invalid'))
  await h.service.files({ ...args, operation: 'write', name: 'note.txt', data: 'YQ==' })
  assert.equal((await h.service.files({ ...args, operation: 'read', name: 'note.txt' })).data, 'YQ==')
  assert.equal((await h.service.files({ ...args, operation: 'list' })).files.length, 1)
  await h.service.manage('release', args)
  await assert.rejects(h.service.files({ ...args, operation: 'list' }), fails('stale-control'))
})

test('disabling a Computer revokes control, stops it and preserves its identity and files', async t => {
  const h = await setup(t)
  const record = await h.start()
  const args = { botId: 'a', expectedGeneration: record.generation }
  args.controlToken = (await h.service.manage('takeover', args)).controlToken
  await h.service.files({ ...args, operation: 'write', name: 'kept', data: 'YQ==' })
  const disabled = await h.bind('a', 'off')
  assert.equal(disabled.id, record.id)
  assert.equal((await h.service.state()).computers[0].phase, 'stopped')
  await assert.rejects(h.observe(), fails('off'))
  await assert.rejects(h.service.preview(args), fails('stale-generation'))
  const enabled = await h.bind()
  assert.equal(enabled.id, record.id)
  assert.equal(h.provider.targets.get(record.id).files.get('kept'), 'YQ==')
})

test('host restart preserves a human pause but never restores its input token', async t => {
  const h = await setup(t)
  const record = await h.start()
  const args = { botId: 'a', expectedGeneration: record.generation }
  args.controlToken = (await h.service.manage('takeover', args)).controlToken
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.state()).computers[0].control, 'human')
  await assert.rejects(second.observe(h.exec()), fails('human-control'))
  await assert.rejects(second.preview(args), fails('stale-control'))
})

function attachment(h, sessionId = 'a', text = 'desktop artifact') {
  const ref = { attachmentId: 'sha256:fixture-file', name: 'source.txt', bytes: Buffer.byteLength(text) }
  h.messages.set(sessionId, [{ content: [{ type: 'file', attachment: ref }] }])
  h.services.attachments.readFileStream = async function* (value) { assert.deepEqual(value, ref); yield Buffer.from(text) }
  h.services.attachments.saveFile = async ({ data, name }) => ({ attachmentId: 'sha256:export', name, bytes: data.length })
  return ref
}
function deliveries(h) {
  const sent = []
  h.room.sessions = { a: 'a-group' }
  h.rt.chatOf = id => id
  h.rt.resolveAgent = async () => ({ inbox: { nextTurn: [], nextStep: [] } })
  h.rt.deliver = async args => { sent.push(args) }
  return sent
}
const help = { reason: 'login', note: 'Sign in, then return here.' }

test('model file tools import current-context attachments, export refs and deduplicate writes', async t => {
  const h = await setup(t)
  await h.start()
  const ref = attachment(h)
  const args = { attachmentId: ref.attachmentId, name: 'result.txt' }
  const first = await h.service.modelFiles('import', args, h.exec())
  assert.equal(first.outcome, 'completed')
  assert.deepEqual(await h.service.modelFiles('import', args, h.exec()), first)
  assert.equal((await h.service.modelFiles('list', {}, h.exec())).files[0].name, 'result.txt')
  const output = await h.service.modelFiles('export', { name: 'result.txt' }, h.exec())
  assert.equal(output.file.bytes, ref.bytes)
  assert.equal(output.file.name, 'result.txt')
  await assert.rejects(h.service.modelFiles('import', { ...args, name: 'other' }, h.exec()), fails('conflict'))
  await h.service.release(h.exec())
  await assert.rejects(h.service.modelFiles('import', args, h.exec('a-group')), fails('owner-denied'))
})

test('model import respects approval, observe grants, offloaded refs and human pauses', async t => {
  const h = await setup(t)
  await h.start()
  const ref = attachment(h)
  const args = { attachmentId: ref.attachmentId, name: 'result.txt' }
  h.services.approval.request = async () => 'denied'
  await assert.rejects(h.service.modelFiles('import', args, h.exec()), fails('approval-denied'))
  h.messages.get('a')[0].content[0].offloaded = true
  await assert.rejects(h.service.modelFiles('import', args, h.exec()), fails('owner-denied'))
  await h.bind('a', 'observe')
  await assert.rejects(h.service.modelFiles('import', args, h.exec()), fails('policy-denied'))
  await h.manage('takeover')
  await assert.rejects(h.service.modelFiles('export', { name: 'result.txt' }, h.exec()), fails('human-control'))
})

test('model import records ambiguous writes and never retries them', async t => {
  const h = await setup(t)
  await h.start()
  const ref = attachment(h)
  let writes = 0
  h.provider.files = async () => { writes++; throw new Error('lost reply') }
  const args = { attachmentId: ref.attachmentId, name: 'result.txt' }
  const result = await h.service.modelFiles('import', args, h.exec())
  assert.equal(result.outcome, 'unknown')
  assert.deepEqual(await h.service.modelFiles('import', args, h.exec()), result)
  assert.equal(writes, 1)
})

test('desktop handoff pauses observation, requires control for Done, resumes exactly once in own chat', async t => {
  const h = await setup(t)
  await h.start()
  const sent = deliveries(h)
  let ended = 0
  const exec = h.exec('a', 'help', { concludeTurn: () => ended++ })
  const result = await h.service.handoffs.request(help, exec)
  assert.equal(ended, 1)
  assert.equal((await h.service.handoffs.request(help, exec)).requestId, result.requestId)
  await assert.rejects(h.observe(), fails('human-control'))
  const args = { botId: 'a', requestId: result.requestId, outcome: 'done' }
  await assert.rejects(h.service.handoffs.answer(args), fails('stale-control'))
  const control = await h.manage('takeover')
  await h.service.handoffs.answer({ ...args, controlToken: control.controlToken })
  await h.service.handoffs.answer(args)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionId, 'a')
  assert.equal(sent[0].role, 'resume')
  assert.match(sent[0].text, /not evidence/)
  assert.equal((await h.service.handoffs.list()).length, 0)
  await h.observe()
})

test('group handoff follows the current group part and never resumes in own chat', async t => {
  const h = await setup(t)
  await h.start()
  const sent = deliveries(h)
  const result = await h.service.handoffs.request(help, h.exec('a-group'))
  h.room.sessions.a = 'a-group-next'
  await h.service.handoffs.answer({ botId: 'a', requestId: result.requestId, outcome: 'skip' })
  assert.equal(sent[0].sessionId, 'a-group-next')
  assert.equal(sent[0].roomId, 'r')
  assert.equal(sent[0].role, 'room')
})

test('pending handoff survives host restart while cancelled, rebound and departed requests cannot resume', async t => {
  const h = await setup(t)
  await h.start()
  const sent = deliveries(h)
  const result = await h.service.handoffs.request(help, h.exec('a-group'))
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.handoffs.list())[0].id, result.requestId)
  assert.equal((await second.state()).computers[0].control, 'human')
  h.room.members = ['b']
  await assert.rejects(second.handoffs.answer({ botId: 'a', requestId: result.requestId, outcome: 'skip' }), fails('stale-generation'))
  h.room.members = ['a', 'b']
  await second.handoffs.cancel('r')
  await assert.rejects(second.handoffs.answer({ botId: 'a', requestId: result.requestId, outcome: 'skip' }), fails('stale-generation'))
  assert.equal(sent.length, 0)
})

test('a queued continuation retries preflight failures but never resends an ambiguous delivery', async t => {
  const h = await setup(t)
  await h.start()
  deliveries(h)
  const result = await h.service.handoffs.request(help, h.exec())
  const args = { botId: 'a', requestId: result.requestId, outcome: 'skip' }
  h.rt.resolveAgent = async () => { throw new Error('temporarily offline') }
  await assert.rejects(h.service.handoffs.answer(args), /temporarily offline/)
  assert.equal((await h.service.handoffs.list())[0].status, 'queued')
  const agent = { inbox: { nextTurn: [] } }
  h.rt.resolveAgent = async () => agent
  let dispatches = 0
  h.rt.deliver = async () => { dispatches++; throw new Error('lost acknowledgement') }
  await assert.rejects(h.service.handoffs.answer(args), fails('result-unknown'))
  h.rt.unreadOf = () => [{ exchangeId: result.requestId }]
  await assert.rejects(h.service.handoffs.answer(args), fails('result-unknown'))
  assert.equal(dispatches, 1, 'a resume queue note is not proof of dispatch')
  agent.inbox.nextTurn.push({ source: { exchangeId: result.requestId } })
  assert.equal((await h.service.handoffs.answer(args)).status, 'delivered')
  assert.equal(dispatches, 1)
})

test('cancellation or group departure while resolving the destination prevents continuation', async t => {
  for (const change of ['cancel', 'leave']) {
    const h = await setup(t)
    await h.start()
    const sent = deliveries(h)
    const result = await h.service.handoffs.request(help, h.exec('a-group'))
    h.rt.resolveAgent = async () => {
      if (change === 'cancel') await h.service.handoffs.cancel('r')
      else h.room.members = ['b']
      return { inbox: {} }
    }
    await assert.rejects(h.service.handoffs.answer({ botId: 'a', requestId: result.requestId, outcome: 'skip' }),
      fails(change === 'cancel' ? 'cancelled' : 'stale-generation'))
    assert.equal(sent.length, 0)
  }
})

test('running desktop quota serializes concurrent starts and allows reuse after stopping', async t => {
  const h = await setup(t)
  await h.bind('a')
  await h.bind('b')
  const original = h.provider.start
  let unblock
  h.provider.start = async (...args) => { await new Promise(resolve => { unblock = resolve }); return original(...args) }
  const starting = h.manage('start', 'a')
  while (!unblock) await delay(1)
  await assert.rejects(h.manage('start', 'b'), fails('busy'))
  unblock()
  await starting
  h.provider.start = original
  h.rt.config.computer = { maxRunning: 1 }
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  await second.state()
  await assert.rejects(second.manage('start', { botId: 'b', expectedGeneration: 1 }), fails('resource-limit'))
  await second.manage('stop', { botId: 'a', expectedGeneration: 1 })
  await second.manage('start', { botId: 'b', expectedGeneration: 1 })
  assert.equal((await second.state()).limits.maxRunning, 1)
})

test('idle shutdown retains files and excludes active turns and human-controlled desktops', async t => {
  let clock = 0
  const h = await setup(t, { options: { now: () => clock } })
  const a = await h.start('a')
  await h.start('b')
  await h.provider.files(a, { operation: 'write', name: 'keep.txt', data: 'eA==' })
  await h.observe('a')
  await h.manage('takeover', 'b')
  clock = 1_000_000
  await h.service.reapIdle()
  assert.equal((await h.service.state()).computers.filter(item => item.phase === 'ready').length, 2)
  await h.service.endTurn('a', 1)
  await h.service.reapIdle()
  assert.equal((await h.service.status(h.exec())).phase, 'stopped')
  await h.manage('start', 'a')
  assert.equal((await h.provider.files(a, { operation: 'read', name: 'keep.txt' })).data, 'eA==')
})

function storageProvider(h) {
  const copies = new Map()
  h.provider.checkpoint = async (record, { checkpointId }) => {
    copies.set(checkpointId, new Map(h.provider.targets.get(record.id).files ?? []))
    return { hash: 'a'.repeat(64), bytes: 10, entries: 1, skipped: 0 }
  }
  h.provider.restore = async (record, { checkpointId }) => {
    h.provider.targets.get(record.id).files = new Map(copies.get(checkpointId))
  }
  h.provider.recreate = async () => {}
  h.provider.rollback = async () => {}
  h.provider.cleanup = async (_, options) => { copies.delete(options.checkpointId); return { removed: true } }
}

test('checkpoint recovery requires stopped desktops, retains the old home and invalidates stale management', async t => {
  const h = await setup(t)
  storageProvider(h)
  const record = await h.start()
  await h.provider.files(record, { operation: 'write', name: 'keep', data: 'eA==' })
  const args = { botId: 'a', expectedGeneration: record.generation }
  await assert.rejects(h.service.storage('checkpoint', args), fails('not-stopped'))
  await h.manage('stop')
  const saved = await h.service.storage('checkpoint', args)
  h.provider.targets.get(record.id).files.set('keep', 'eQ==')
  const restored = await h.service.storage('restore', { ...args, checkpointId: saved.checkpoints[0].id })
  assert.equal(restored.computers[0].generation, record.generation + 1)
  const metadata = JSON.parse(await readFile(join(h.home, 'computers/registry.json'), 'utf8')).computers[record.id]
  assert.ok(metadata.homeRevision)
  assert.deepEqual(metadata.previousHomes, [null])
  assert.equal(h.provider.targets.get(record.id).files.get('keep'), 'eA==')
  await assert.rejects(h.service.manage('start', args), fails('stale-generation'))
  await h.bind('a', 'observe')
  const rebound = JSON.parse(await readFile(join(h.home, 'computers/registry.json'), 'utf8')).computers[record.id]
  assert.equal(rebound.homeRevision, metadata.homeRevision)
  assert.deepEqual(rebound.previousHomes, [null])
})

test('failed restore never publishes a new home; recreate requires a successful checkpoint', async t => {
  const h = await setup(t)
  storageProvider(h)
  const record = await h.start()
  await h.manage('stop')
  const args = { botId: 'a', expectedGeneration: record.generation }
  const saved = await h.service.storage('checkpoint', args)
  h.provider.restore = async () => { throw new Error('hash mismatch') }
  await assert.rejects(h.service.storage('restore', { ...args, checkpointId: saved.checkpoints[0].id }), /hash mismatch/)
  assert.equal((await h.service.state()).computers[0].generation, record.generation)
  await assert.rejects(h.service.storage('recreate', args), fails('recovery-required'))
  await h.service.storage('recover', args)
  args.expectedGeneration = (await h.service.state()).computers[0].generation
  let removed = false
  h.provider.checkpoint = async () => { throw new Error('disk full') }
  h.provider.recreate = async () => { removed = true }
  await assert.rejects(h.service.storage('recreate', args), /disk full/)
  assert.equal(removed, false)
})

test('checkpoint journal is bounded and rejects another desktop backup', async t => {
  const h = await setup(t)
  storageProvider(h)
  const a = await h.start('a')
  const b = await h.start('b')
  await h.manage('stop', 'a')
  await h.manage('stop', 'b')
  const args = { botId: 'a', expectedGeneration: a.generation }
  const saved = await h.service.storage('checkpoint', args)
  await h.service.storage('checkpoint', args)
  await assert.rejects(h.service.storage('checkpoint', args), fails('resource-limit'))
  await assert.rejects(h.service.storage('restore', { botId: 'b', expectedGeneration: b.generation, checkpointId: saved.checkpoints[0].id }), fails('invalid'))
})

test('the final inbox guard blocks cancelled continuations, including restart resends', async t => {
  const h = await setup(t)
  await h.start()
  deliveries(h)
  const request = await h.service.handoffs.request(help, h.exec('a-group'))
  let queued = false
  h.rt.deliver = async args => {
    const validate = await h.service.handoffs.validateDelivery(args.computerHandoff, args.sessionId)
    await h.service.handoffs.cancel('r')
    validate()
    queued = true
  }
  await assert.rejects(h.service.handoffs.answer({ botId: 'a', requestId: request.requestId, outcome: 'skip' }), fails('result-unknown'))
  assert.equal(queued, false)
  await assert.rejects(h.service.handoffs.validateDelivery(request.requestId, 'a-group'), fails('cancelled'))
})

test('explicit stop cancels a pending desktop help card', async t => {
  const h = await setup(t)
  await h.start()
  const sent = deliveries(h)
  const request = await h.service.handoffs.request(help, h.exec())
  await h.manage('stop')
  assert.equal((await h.service.handoffs.list()).length, 0)
  await assert.rejects(h.service.handoffs.answer({ botId: 'a', requestId: request.requestId, outcome: 'skip' }), fails('stale-generation'))
  assert.equal(sent.length, 0)
})

test('storage cleanup frees capacity and rollback exchanges retained homes without deleting either', async t => {
  const h = await setup(t)
  storageProvider(h)
  await h.start()
  await h.manage('stop')
  const storage = async (method, extra = {}) => h.service.storage(method, { botId: 'a', expectedGeneration: (await h.service.state()).computers[0].generation, ...extra })
  const saved = await storage('checkpoint')
  const checkpointId = saved.checkpoints[0].id
  await storage('checkpoint')
  await assert.rejects(storage('checkpoint'), fails('resource-limit'))
  await storage('delete-checkpoint', { checkpointId: saved.checkpoints[0].id })
  const replacement = await storage('checkpoint')
  assert.equal(replacement.checkpoints.length, 2)
  const restored = await storage('restore', { checkpointId: replacement.checkpoints[0].id })
  const revision = restored.computers[0].previousHomes
  assert.deepEqual(revision, [null])
  const switched = await storage('rollback', { homeRevision: null })
  assert.equal(switched.computers[0].previousHomes.length, 1)
  assert.notEqual(switched.computers[0].previousHomes[0], null)
  await assert.rejects(storage('delete-home', { homeRevision: null }), fails('invalid'))
  await storage('delete-home', { homeRevision: switched.computers[0].previousHomes[0] })
  assert.deepEqual((await h.service.state()).computers[0].previousHomes, [])
  await assert.rejects(storage('restore', { checkpointId }), fails('invalid'))
})

test('interrupted restore is reconciled on restart; failed cleanup cannot bypass recovery', async t => {
  const h = await setup(t)
  storageProvider(h)
  const record = await h.start()
  await h.manage('stop')
  const args = { botId: 'a', expectedGeneration: record.generation }
  const saved = await h.service.storage('checkpoint', args)
  let staged
  h.provider.restore = async (_, options) => { staged = options.homeRevision; throw new Error('host disconnected after staging') }
  await assert.rejects(h.service.storage('restore', { ...args, checkpointId: saved.checkpoints[0].id }), /disconnected/)
  const registry = JSON.parse(await readFile(join(h.home, 'computers/registry.json'), 'utf8'))
  assert.equal(registry.lifecycle[record.id].homeRevision, staged)
  assert.equal(registry.computers[record.id].homeRevision, undefined)
  h.provider.cleanup = async () => { throw new Error('volume still referenced') }
  await h.service.dispose()
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  assert.equal((await second.state()).computers[0].recoveryPending, true)
  await second.manage('stop', args)
  await assert.rejects(second.manage('start', args), fails('recovery-required'))
  await assert.rejects(second.manage('takeover', args), fails('recovery-required'))
  await assert.rejects(second.observe(h.exec()), fails('recovery-required'))
  await assert.rejects(second.bind({ botId: 'a', grant: 'operate', expectedRevision: (await second.state()).revision }), fails('recovery-required'))
  await assert.rejects(second.storage('recover', args), /still referenced/)
  h.provider.cleanup = async (current, options) => {
    assert.equal(current.homeRevision, undefined)
    assert.equal(options.staged, true)
    assert.equal(options.homeRevision, staged)
    return { removed: true }
  }
  const recovered = await second.storage('recover', args)
  assert.equal(recovered.computers[0].recoveryPending, false)
  assert.equal(recovered.computers[0].generation, record.generation + 1)
  assert.equal(recovered.checkpoints.length, 1)
})

test('an interrupted explicit deletion retries idempotently and clears only its metadata', async t => {
  const h = await setup(t)
  storageProvider(h)
  const record = await h.start()
  await h.manage('stop')
  const args = { botId: 'a', expectedGeneration: record.generation }
  const saved = await h.service.storage('checkpoint', args)
  const checkpointId = saved.checkpoints[0].id
  h.provider.cleanup = async () => { throw new Error('reply lost after deletion') }
  await assert.rejects(h.service.storage('delete-checkpoint', { ...args, checkpointId }), /reply lost/)
  assert.equal((await h.service.state()).checkpoints.length, 1)
  h.provider.cleanup = async (_, options) => { assert.equal(options.checkpointId, checkpointId); return { removed: false } }
  const recovered = await h.service.storage('recover', args)
  assert.equal(recovered.checkpoints.length, 0)
  assert.equal(recovered.computers[0].recoveryPending, false)
})

test('pruning action receipts invalidates old generations and preserves other Computers', async t => {
  const h = await setup(t)
  storageProvider(h)
  const a = await h.start()
  const b = await h.start('b')
  await h.service.act(h.click(await h.observe()), h.exec())
  await h.service.act(h.click(await h.observe('b')), h.exec('b'))
  const args = { botId: 'a', expectedGeneration: a.generation }
  await assert.rejects(h.service.storage('prune-journal', args), fails('not-stopped'))
  await h.manage('stop')
  await h.service.storage('prune-journal', args)
  const registry = JSON.parse(await readFile(join(h.home, 'computers/registry.json'), 'utf8'))
  assert.equal(registry.computers[a.id].generation, a.generation + 1)
  assert.deepEqual(Object.values(registry.operations).map(item => item.computerId), [b.id])
  await assert.rejects(h.service.manage('start', args), fails('stale-generation'))
})

test('image pins survive rebinding and reject a different provider image before touching a desktop', async t => {
  const h = await setup(t)
  const image = `sha256:${'a'.repeat(64)}`
  h.provider.image = image
  const record = await h.start()
  assert.equal(record.runtimeImage, image)
  assert.equal((await h.bind()).runtimeImage, image)
  await h.service.dispose()
  h.provider.image = `sha256:${'b'.repeat(64)}`
  let revoked = false
  h.provider.revoke = async () => { revoked = true }
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  const state = await second.state()
  const args = { botId: 'a', expectedGeneration: state.computers[0].generation }
  assert.equal(revoked, false)
  assert.equal(state.computers[0].runtimeImage, image)
  await assert.rejects(second.manage('start', args), fails('image-incompatible'))
  await assert.rejects(second.bind({ botId: 'a', grant: 'operate', expectedRevision: state.revision }), fails('image-incompatible'))
  await assert.rejects(second.observe(h.exec()), fails('image-incompatible'))
})

test('legacy homes acquire an image pin only with matching runtime evidence or a provably empty assignment', async t => {
  for (const evidence of [
    { image: `sha256:${'a'.repeat(64)}`, homeExists: true, accepted: true },
    { image: null, homeExists: false, accepted: true },
    { image: null, homeExists: false, retained: true, accepted: false },
    { image: null, homeExists: true, accepted: false },
    { image: `sha256:${'b'.repeat(64)}`, homeExists: true, accepted: false },
  ]) {
    const h = await setup(t)
    const original = await h.bind()
    await h.service.dispose()
    if (evidence.retained) {
      const file = join(h.home, 'computers/registry.json')
      const saved = JSON.parse(await readFile(file, 'utf8'))
      saved.computers[original.id].previousHomes = ['bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb']
      await writeFile(file, JSON.stringify(saved))
    }
    h.provider.image = `sha256:${'a'.repeat(64)}`
    h.provider.inspect = async () => ({ phase: 'stopped', ...evidence })
    const second = createComputerService(h.rt, h.provider)
    t.after(() => second.dispose())
    const state = await second.state()
    assert.equal(state.computers[0].runtimeImage, evidence.accepted ? h.provider.image : undefined)
    assert.equal(state.computers[0].generation, original.generation)
    if (!evidence.accepted) await assert.rejects(second.manage('start', { botId: 'a', expectedGeneration: original.generation }), fails('image-incompatible'))
  }
})

test('a corrected image configuration can replace a pin only on a verified empty assignment', async t => {
  const h = await setup(t)
  h.provider.image = `sha256:${'a'.repeat(64)}`
  const record = await h.bind()
  await h.service.dispose()
  h.provider.image = `sha256:${'b'.repeat(64)}`
  h.provider.inspect = async () => ({ phase: 'stopped', image: null, homeExists: false })
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  const state = await second.state()
  assert.equal(state.computers[0].runtimeImage, h.provider.image)
  assert.equal(state.computers[0].generation, record.generation + 1)
  await assert.rejects(second.manage('start', { botId: 'a', expectedGeneration: record.generation }), fails('stale-generation'))
})

test('upgrade publishes image and home together and rollback restores the original pair', async t => {
  const h = await setup(t)
  storageProvider(h)
  const original = `sha256:${'a'.repeat(64)}`
  const next = `sha256:${'b'.repeat(64)}`
  h.provider.image = original
  h.provider.images = [original, next]
  let staged
  h.provider.upgrade = async (record, options) => {
    assert.equal(record.runtimeImage, original)
    assert.equal(options.targetImage, next)
    assert.match(options.hash, /^[a-f0-9]{64}$/)
    staged = options.homeRevision
  }
  const record = await h.start()
  await h.manage('stop')
  const args = { botId: 'a', expectedGeneration: record.generation }
  await assert.rejects(h.service.storage('upgrade', { ...args, targetImage: original }), fails('image-incompatible'))
  await assert.rejects(h.service.storage('upgrade', { ...args, targetImage: `sha256:${'c'.repeat(64)}` }), fails('image-incompatible'))
  const upgraded = await h.service.storage('upgrade', { ...args, targetImage: next })
  assert.equal(upgraded.computers[0].runtimeImage, next)
  assert.deepEqual(upgraded.computers[0].previousImages, { original })
  assert.equal(upgraded.checkpoints[0].image, original)
  await assert.rejects(h.service.storage('upgrade', { botId: 'a', expectedGeneration: upgraded.computers[0].generation, targetImage: original }), fails('image-incompatible'))
  await h.bind('a', 'observe')
  const current = (await h.service.state()).computers[0]
  assert.deepEqual(current.previousImages, { original })
  await assert.rejects(h.service.storage('restore', { botId: 'a', expectedGeneration: current.generation, checkpointId: upgraded.checkpoints[0].id }), fails('image-incompatible'))
  h.provider.rollback = async (_, options) => { assert.equal(options.targetImage, original); assert.equal(options.homeRevision, null) }
  const rolled = await h.service.storage('rollback', { botId: 'a', expectedGeneration: current.generation, homeRevision: null })
  assert.equal(rolled.computers[0].runtimeImage, original)
  assert.deepEqual(rolled.computers[0].previousHomes, [staged])
  assert.deepEqual(rolled.computers[0].previousImages, { [staged]: next })
})

test('interrupted upgrade retains the source pair and reconciles only its candidate', async t => {
  const h = await setup(t)
  storageProvider(h)
  const original = `sha256:${'a'.repeat(64)}`, next = `sha256:${'b'.repeat(64)}`
  h.provider.image = original
  h.provider.images = [original, next]
  let staged
  h.provider.upgrade = async (_, options) => { staged = options.homeRevision; throw new Error('candidate failed health') }
  const record = await h.start()
  await h.manage('stop')
  await assert.rejects(h.service.storage('upgrade', { botId: 'a', expectedGeneration: record.generation, targetImage: next }), /failed health/)
  const interrupted = await h.service.state()
  assert.equal(interrupted.computers[0].runtimeImage, original)
  assert.equal(interrupted.computers[0].generation, record.generation)
  assert.equal(interrupted.computers[0].recoveryPending, true)
  await assert.rejects(h.manage('start'), fails('recovery-required'))
  h.provider.cleanup = async (_, options) => {
    assert.equal(options.homeRevision, staged)
    assert.equal(options.targetImage, next)
    assert.equal(options.staged, true)
    assert.equal(options.kind, 'home')
  }
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  const recovered = await second.state()
  assert.equal(recovered.computers[0].runtimeImage, original)
  assert.equal(recovered.computers[0].recoveryPending, false)
  assert.equal(recovered.checkpoints.length, 1)
})

test('storage diagnostics refuse stale generations and pending recovery without scanning', async t => {
  const h = await setup(t)
  const record = await h.start()
  let scans = 0
  h.provider.diagnostics = async () => { scans++; return { storage: { bytes: 7, hardQuota: false } } }
  await assert.rejects(h.service.diagnostics({ botId: 'a', expectedGeneration: 0 }), fails('stale-generation'))
  assert.equal(scans, 0)
  assert.equal((await h.service.diagnostics({ botId: 'a', expectedGeneration: record.generation })).storage.bytes, 7)
  storageProvider(h)
  h.provider.checkpoint = async () => { throw new Error('disk full') }
  await h.manage('stop')
  await assert.rejects(h.service.storage('checkpoint', { botId: 'a', expectedGeneration: record.generation }), /disk full/)
  await assert.rejects(h.service.diagnostics({ botId: 'a', expectedGeneration: record.generation }), fails('recovery-required'))
  assert.equal(scans, 1)
})

test('upgrade reserves the runtime limit before allocating a checkpoint or candidate', async t => {
  const h = await setup(t)
  storageProvider(h)
  h.provider.image = `sha256:${'a'.repeat(64)}`
  h.provider.images = [h.provider.image, `sha256:${'b'.repeat(64)}`]
  let upgraded = false
  h.provider.upgrade = async () => { upgraded = true }
  const record = await h.start('a')
  await h.start('b')
  await h.manage('stop', 'a')
  h.rt.config.computer = { maxRunning: 1 }
  const second = createComputerService(h.rt, h.provider)
  t.after(() => second.dispose())
  await assert.rejects(second.storage('upgrade', { botId: 'a', expectedGeneration: record.generation, targetImage: h.provider.images[1] }), fails('resource-limit'))
  assert.equal(upgraded, false)
  assert.equal((await second.state()).checkpoints.length, 0)
})

function fakeViewer() {
  let closed = false
  const listeners = new Set()
  return {
    get closed() { return closed },
    onData() {}, write() {},
    onClose(fn) { if (closed) fn(); else listeners.add(fn) },
    close() { if (closed) return; closed = true; for (const fn of listeners) fn() },
  }
}

test('viewers survive model turn fences but close on binding changes and read-only ownership', async t => {
  const provider = createFakeComputer()
  const opened = []
  provider.openViewer = async () => { const stream = fakeViewer(); opened.push(stream); return stream }
  const h = await setup(t, { provider })
  const record = await h.start()
  const stream = await h.service.openViewer({ botId: 'a', expectedGeneration: record.generation })
  await h.observe()
  await h.service.endTurn('a', 1)
  assert.equal(opened[0].closed, false)
  await stream.validate()
  await h.bind('a', 'off')
  assert.equal(opened[0].closed, true)
  const next = await h.start()
  const second = await h.service.openViewer({ botId: 'a', expectedGeneration: next.generation })
  h.readOnly('another host')
  await assert.rejects(second.validate(), fails('read-only'))
  second.close()
  h.readOnly(undefined)
})

test('a viewer opening concurrently with stop cannot outlive revocation', async t => {
  const provider = createFakeComputer()
  let finish
  provider.openViewer = () => new Promise(resolve => { finish = resolve })
  const h = await setup(t, { provider })
  const record = await h.start()
  const opening = h.service.openViewer({ botId: 'a', expectedGeneration: record.generation })
  const rejected = assert.rejects(opening)
  while (!finish) await delay(1)
  await h.manage('stop')
  const stream = fakeViewer()
  finish(stream)
  await rejected
  assert.equal(stream.closed, true)
})
