import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerStore } from '../src/host/computer/store.js'
import { createDesktopTasks } from '../src/host/computer/tasks.js'
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-tasks-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'queue.json')
  let store = createComputerStore(path, { writable() {} }), now = Date.now()
  const record = { id: 'cmp_test', botId: 'a', generation: 1, grant: 'operate', executionPolicy: 'assisted', archived: false }
  await store.update(draft => { draft.computers[record.id] = record })
  const controls = new Map([[record.id, 'none']]), sent = [], removed = [], cancelled = []
  const agent = { id: 'chat', session: { id: 'chat' }, inbox: { nextTurn: [], nextStep: [], remove: id => removed.push(id) }, cancel: reason => cancelled.push(reason) }
  const rt = { readOnly: () => undefined, chatOf: () => 'chat', live: new Map(), resolveAgent: async () => agent,
    ctx: { sessions: { flush: async () => {} } }, deliver: async value => { (await tasks.validateDelivery(value.computerTask, value.sessionId))(); sent.push(value) } }
  let barriers = 0
  const deps = { store, now: () => now, ready: () => store.load(), assigned: async () => (await store.load()).computers[record.id], owner: () => ({ botId: 'a', sessionId: 'chat', turnId: rt.live.get('chat').turn }),
    administration: async (_id, work) => work(), barrier: async () => { barriers++ }, controls, provider: { inspect: async () => ({ phase: 'ready' }) } }
  let tasks = createDesktopTasks(rt, deps)
  const command = (method, args = {}) => tasks.command(method, { botId: 'a', expectedGeneration: 1, ...args })
  const start = async () => { await command('add', { goal: 'Inspect the desktop and report evidence.' }); await tasks.tick(); const item = (await tasks.list('a'))[0]; rt.live.set('chat', { turn: 1, info: { exchangeId: item.attempt } }); await tasks.enter(agent); return item }
  return { get store() { return store }, rt, agent, sent, removed, cancelled, command, start, get tasks() { return tasks }, barriers: () => barriers,
    now: () => now, advance: ms => { now += ms },
    reload: () => { tasks.dispose(); store = createComputerStore(path, { writable() {} }); tasks = createDesktopTasks(rt, { ...deps, store }); return tasks } }
}
test('queued desktop tasks dispatch once and require an explicit result', async t => {
  const h = await fixture(t), item = await h.start()
  await h.tasks.tick(); assert.equal(h.sent.length, 1)
  await h.tasks.report({ taskId: item.id, status: 'progress', note: 'Observed current desktop.' }, {})
  await h.tasks.endTurn('chat', 1)
  assert.equal((await h.tasks.list('a'))[0].status, 'needs-review')
  await h.tasks.tick(); assert.equal(h.sent.length, 1)
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 1 }), /no longer running/)
})
test('scheduled desktop tasks remain queued until their durable run time', async t => {
  const h = await fixture(t)
  const runAt = h.now() + 60_000
  await h.command('add', { goal: 'Run later', runAt })
  await h.tasks.tick()
  assert.equal(h.sent.length, 0)
  assert.equal((await h.tasks.list('a'))[0].runAt, runAt)
  await assert.rejects(h.command('add', { goal: 'Too far', runAt: h.now() + 367 * 24 * 60 * 60 * 1000 }), /within one year/)
  await assert.rejects(h.command('add', { goal: 'In the past', runAt: h.now() - 1 }), /future/)
  h.reload()
  assert.equal((await h.tasks.list('a'))[0].runAt, runAt)
  await h.tasks.tick(); assert.equal(h.sent.length, 0)
  h.advance(60_000)
  await h.tasks.tick()
  assert.equal(h.sent.length, 1)
  await h.tasks.tick(); assert.equal(h.sent.length, 1)
})
test('future tasks do not block immediate work and due tasks use their scheduled order', async t => {
  const h = await fixture(t)
  await h.command('add', { goal: 'Later', runAt: h.now() + 120_000 })
  await h.command('add', { goal: 'Earlier', runAt: h.now() + 60_000 })
  await h.command('add', { goal: 'Immediate' })
  await h.tasks.tick()
  assert.match(h.sent[0].text, /Immediate/)
  let item = (await h.tasks.list('a')).find(item => item.goal === 'Immediate')
  await h.command('cancel', { id: item.id })
  h.advance(120_000); await h.tasks.tick()
  assert.match(h.sent[1].text, /Earlier/)
  item = (await h.tasks.list('a')).find(item => item.goal === 'Earlier')
  await h.command('cancel', { id: item.id }); await h.tasks.tick()
  assert.match(h.sent[2].text, /Later/)
})
test('invalid explicit times cannot silently enqueue immediate work', async t => {
  const h = await fixture(t)
  for (const runAt of [null, '', true, {}, [], String(h.now() + 1000), NaN, Infinity, 1.5, h.now()]) {
    await assert.rejects(h.command('add', { goal: 'Invalid', runAt }), /future/)
  }
  assert.equal((await h.tasks.list('a')).length, 0)
  const [item] = await h.command('add', { goal: 'Scheduled', runAt: h.now() + 60_000 })
  await assert.rejects(h.store.update(draft => { draft.tasks[item.id].runAt = h.now() - 1 }), /Invalid desktop task/)
  await h.command('pause', { id: item.id }); h.advance(60_000)
  await h.tasks.tick(); assert.equal(h.sent.length, 0)
  await h.command('cancel', { id: item.id }); await h.tasks.tick()
  assert.equal(h.sent.length, 0)
})
test('pause cancels only the matching task and resume creates a fresh fenced delivery', async t => {
  const h = await fixture(t), item = await h.start()
  h.agent.inbox.nextTurn = [{ id: 'mine', source: { exchangeId: item.attempt } }, { id: 'other', source: { exchangeId: 'unrelated' } }]
  await h.command('pause', { id: item.id }); assert.equal(h.cancelled.length, 1); assert.deepEqual(h.removed, ['mine'])
  h.agent.inbox.nextTurn = []; h.rt.live.clear()
  await assert.rejects(h.command('resume', { id: item.id }), /confirm/)
  await h.command('resume', { id: item.id, confirm: true }); await h.tasks.tick()
  assert.equal(h.sent.length, 2); assert.notEqual(h.sent[1].exchangeId, item.attempt)
  h.rt.live.set('chat', { turn: 2, info: { exchangeId: item.attempt } })
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 2 }), /no longer running/)
})
test('uncertain delivery and host restart never automatically replay a task', async t => {
  const h = await fixture(t)
  h.rt.deliver = async value => { h.sent.push(value); throw Error('lost after enqueue') }
  await h.command('add', { goal: 'Task' }); await h.tasks.tick(); await h.tasks.tick()
  assert.equal(h.sent.length, 1); assert.equal((await h.tasks.list('a'))[0].status, 'unknown')
  h.reload(); assert.equal((await h.tasks.list('a'))[0].status, 'interrupted')
  await h.tasks.tick(); assert.equal(h.sent.length, 1)
})
test('explicit completion records evidence, ends the turn and blocks stale tools', async t => {
  const h = await fixture(t), item = await h.start(); let ended = false
  await h.tasks.report({ taskId: item.id, status: 'completed', note: 'Verified the requested file exists.' }, { concludeTurn: () => { ended = true } })
  assert.equal(ended, true); assert.equal((await h.tasks.list('a'))[0].status, 'completed')
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 1 }), /no longer running/)
  await h.command('remove', { id: item.id }); assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 1 }), /no longer running/)
})
test('queue waits for unrelated turns and generation changes require review', async t => {
  const h = await fixture(t)
  h.rt.live.set('chat', { turn: 20, info: { exchangeId: 'unrelated' } })
  await h.command('add', { goal: 'Task' }); await h.tasks.tick(); assert.equal(h.sent.length, 0)
  const item = (await h.tasks.list('a'))[0]
  await h.command('pause', { id: item.id }); assert.equal(h.cancelled.length, 0)
  h.rt.live.clear(); await h.command('resume', { id: item.id, confirm: true })
  await h.store.update(draft => { draft.computers.cmp_test.generation++ }); await h.tasks.tick()
  assert.equal((await h.tasks.list('a'))[0].status, 'interrupted'); assert.equal(h.sent.length, 0)
})

test('a new turn cannot reclaim a running attempt and a generation change fences it immediately', async t => {
  const h = await fixture(t), item = await h.start()
  h.rt.live.set('chat', { turn: 2, info: { exchangeId: item.attempt } }); await h.tasks.enter(h.agent)
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 2 }), /no longer running/)
  h.rt.live.set('chat', { turn: 1, info: { exchangeId: item.attempt } })
  await h.store.update(draft => { draft.computers.cmp_test.generation++ })
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 1 }), /no longer running/)
  assert.equal((await h.tasks.list('a'))[0].status, 'interrupted')
})

test('pause fences a delayed delivery before it reaches the agent inbox', async t => {
  const h = await fixture(t); let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  h.rt.deliver = async args => { entered(); await gate; (await h.tasks.validateDelivery(args.computerTask, args.sessionId))(); h.sent.push(args) }
  const [item] = await h.command('add', { goal: 'Task' })
  const pending = h.tasks.tick(); await started
  await h.command('pause', { id: item.id }); release(); await pending
  assert.equal(h.sent.length, 0); assert.equal((await h.tasks.list('a'))[0].status, 'paused')
})

const repeat = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', missed: 'once' }
async function enterDue(h, item) {
  h.advance(Math.max(0, item.runAt - h.now()))
  await h.tasks.tick()
  const current = (await h.tasks.list('a')).find(task => task.id === item.id)
  h.rt.live.set('chat', { turn: h.sent.length, info: { exchangeId: current.attempt } })
  await h.tasks.enter(h.agent)
  return current
}
test('recurring success schedules one future occurrence, persists history and fences the old attempt', async t => {
  const h = await fixture(t), [item] = await h.command('add', { goal: 'Daily check', repeat })
  await enterDue(h, item)
  await h.tasks.report({ taskId: item.id, status: 'completed', note: 'Verified.' }, {})
  const current = (await h.tasks.list('a'))[0]
  assert.equal(current.status, 'queued'); assert.equal(current.runs, 1)
  assert.ok(current.runAt > h.now()); assert.equal(current.history[0].note, 'Verified.')
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 1 }), /no longer running/)
  await assert.rejects(h.tasks.report({ taskId: item.id, status: 'completed', note: 'Duplicate' }, {}))
  h.rt.live.clear(); h.reload()
  assert.equal((await h.tasks.list('a'))[0].runAt, current.runAt)
  await h.tasks.tick(); assert.equal(h.sent.length, 1)
})
test('recurring history stays bounded and failures block later occurrences until review', async t => {
  const h = await fixture(t), [item] = await h.command('add', { goal: 'Daily check', repeat })
  for (let n = 0; n < 22; n++) {
    await enterDue(h, (await h.tasks.list('a'))[0])
    await h.tasks.report({ taskId: item.id, status: n === 21 ? 'failed' : 'completed', note: `Evidence ${n}` }, {})
    h.rt.live.clear()
  }
  let current = (await h.tasks.list('a'))[0]
  assert.equal(current.status, 'failed'); assert.equal(current.runs, 22)
  assert.equal(current.history.length, 20); assert.equal(current.history[0].note, 'Evidence 2')
  h.advance(3 * 86400000); await h.tasks.tick(); assert.equal(h.sent.length, 22)
  await h.command('resume', { id: item.id, confirm: true }); await h.tasks.tick()
  current = (await h.tasks.list('a'))[0]
  assert.equal(current.status, 'sending'); assert.equal(h.sent.length, 23)
})
test('overdue repeat coalesces once or skips instead of replaying a backlog', async t => {
  for (const missed of ['once', 'skip']) {
    const h = await fixture(t), [item] = await h.command('add', { goal: 'Check', repeat: { ...repeat, missed } })
    h.advance(item.runAt - h.now() + 3 * 86400000)
    await h.tasks.tick(); await h.tasks.tick()
    assert.equal(h.sent.length, missed === 'once' ? 1 : 0)
    if (missed === 'skip') {
      assert.ok((await h.tasks.list('a'))[0].runAt > h.now())
      await h.command('pause', { id: item.id })
      await h.command('resume', { id: item.id, confirm: true })
      h.advance(360000); await h.tasks.tick()
      assert.equal(h.sent.length, 1, 'explicit resume is not skipped as a missed recurrence')
    }
  }
})
test('task deadlines block tools immediately and watchdog pauses/cancels only its own turn', async t => {
  const h = await fixture(t), item = await h.start()
  await h.tasks.report({ taskId: item.id, status: 'progress', note: 'Read page', step: 'Inspect', progress: 20 }, {})
  h.advance(590000)
  await h.tasks.report({ taskId: item.id, status: 'waiting', note: 'Read page', step: 'Inspect', progress: 20, waitReason: 'Waiting for server' }, {})
  h.advance(10000)
  assert.throws(() => h.tasks.guard({ botId: 'a', sessionId: 'chat', turnId: 1 }), /No progress/)
  await assert.rejects(h.tasks.report({ taskId: item.id, status: 'progress', note: 'Late heartbeat' }, {}), /No progress/)
  await h.tasks.tick()
  let current = (await h.tasks.list('a'))[0]
  assert.equal(current.status, 'paused'); assert.match(current.waitReason, /No progress/)
  assert.equal(current.elapsedMs, 600000); assert.equal(h.cancelled.length, 1)
  h.advance(60000); current = (await h.tasks.list('a'))[0]
  assert.equal(current.elapsedMs, 600000)
})
test('meaningful progress renews stall time but never the total deadline', async t => {
  const h = await fixture(t)
  const [item] = await h.command('add', { goal: 'Limited', maxRunMs: 120000, stallMs: 60000 })
  await h.tasks.tick()
  const queued = (await h.tasks.list('a'))[0]
  h.rt.live.set('chat', { turn: 1, info: { exchangeId: queued.attempt } }); await h.tasks.enter(h.agent)
  for (const progress of [20, 40]) {
    h.advance(50000); await h.tasks.report({ taskId: item.id, status: 'progress', note: `Step ${progress}`, progress }, {})
    await h.tasks.tick(); assert.equal((await h.tasks.list('a'))[0].status, 'running')
  }
  h.advance(20000); await h.tasks.tick()
  assert.match((await h.tasks.list('a'))[0].waitReason, /time limit/)
})
test('queue reports blockers and corrupt optional task records are rejected', async t => {
  const h = await fixture(t), [item] = await h.command('add', { goal: 'Check', repeat })
  assert.equal((await h.tasks.list('a'))[0].queueReason, 'scheduled')
  h.advance(item.runAt - h.now()); h.rt.live.set('chat', { turn: 4 })
  assert.equal((await h.tasks.list('a'))[0].queueReason, 'bot-busy')
  await assert.rejects(h.store.update(draft => { draft.tasks[item.id].history = [null] }), /Invalid desktop task/)
  await assert.rejects(h.store.update(draft => { draft.tasks[item.id].resumeOnce = 'yes' }), /Invalid desktop task/)
})
