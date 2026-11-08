import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendChildren, discoverChildren } from '../src/host/monitor-agents.js'
import { install } from '../src/host/monitor.js'
import { fakeContext } from './fake-ctx.js'

const roots = [{ id: 'root', entityId: 'bot', groupId: 'room' }]
const child = (id, mode = 'continuable') => ({ id, mode, label: id, privatePayload: 'secret' })
const context = listChildren => fakeContext({ services: { subagents: { listChildren } } })
const discover = (ctx, signal = new AbortController().signal) => discoverChildren(ctx, roots, signal)
const base = () => ({ entities: [{ id: 'bot' }], sessions: [...roots], runs: [] })

function runtime(ctx) {
  return {
    ctx, state: { bots: { bot: { id: 'bot', name: 'Bot' } }, agents: {}, mainBotIds: [], rooms: {} },
    chatOf: () => 'root', groupOwners: new Map(), live: new Map(),
    approvalsView: () => [], waitingView: () => ({}), readOnly: () => undefined,
    refresh: async () => {},
  }
}

test('discovery follows only explicit scoped catalogs and external children never open locally', async () => {
  const reads = []
  const ctx = context(async id => {
    reads.push(id)
    return { root: [child('a'), child('remote', 'external')], a: [child('b', 'one-shot')], b: [] }[id]
  })
  const snapshot = appendChildren(ctx, base(), await discover(ctx))
  assert.deepEqual(reads, ['root', 'a', 'b'])
  assert.equal(snapshot.partial, false)
  assert.equal(snapshot.entities.find(item => item.id === 'subagent:b').parentEntityId, 'subagent:a')
  assert.equal(snapshot.entities.find(item => item.id === 'subagent:remote').sessionId, null)
  assert.deepEqual(snapshot.sessions.find(item => item.id === 'b').target, {
    parentSessionId: 'a', childSessionId: 'b', mode: 'one-shot',
  })
  assert.equal(snapshot.sessions.find(item => item.id === 'b').status, 'unknown')
  assert.equal(JSON.stringify(snapshot).includes('secret'), false)
})

test('discovery bounds cycles, fanout and depth and indicates incomplete coverage', async () => {
  const cycle = await discover(context(async id => id === 'root' ? [child('a')] : [child('root')]))
  assert.equal(cycle.nodes.length, 1)
  assert.equal(cycle.partial, true)
  let reads = 0
  const wide = await discover(context(async () => { reads++; return Array.from({ length: 200 }, (_, n) => child(`c${n}`)) }))
  assert.equal(wide.nodes.length, 64)
  assert.equal(reads, 1)
  assert.equal(wide.partial, true)
  const deep = await discover(context(async id => [child(`${id}-child`)]))
  assert.equal(deep.nodes.length, 4)
  assert.equal(deep.partial, true)
})

test('missing capability, invalid catalogs and read failures degrade without leaking errors', async () => {
  assert.equal((await discover(fakeContext())).partial, true)
  for (const provider of [async () => null, async () => { throw new Error('/secret/path') }, async () => [{ id: 'x', mode: 'invalid' }]]) {
    const result = await discover(context(provider))
    assert.deepEqual(result, { nodes: [], partial: true })
  }
})

test('cancellation returns even when the catalog provider ignores its signal', async () => {
  const controller = new AbortController()
  const pending = discover(context(() => new Promise(() => {})), controller.signal)
  controller.abort()
  assert.deepEqual(await pending, { nodes: [], partial: true })
})

test('removed roots are dropped after asynchronous catalog reads', async () => {
  const discovery = await discover(context(async id => id === 'root' ? [child('a')] : []))
  const snapshot = appendChildren(fakeContext(), { entities: [], sessions: [], runs: [] }, discovery)
  assert.deepEqual(snapshot.entities, [])
  assert.deepEqual(snapshot.sessions, [])
})

test('navigation rechecks parent membership and does not accept arbitrary sessions', async t => {
  let catalog = [child('a')]
  const ctx = context(async id => id === 'root' ? catalog : [])
  install(runtime(ctx))
  t.after(() => ctx.dispose())
  const service = ctx.get('botMonitor')
  assert.deepEqual(await service.resolve('subagent:a'), { parentSessionId: 'root', childSessionId: 'a', mode: 'continuable' })
  assert.equal(await service.resolve('subagent:a', 'unrelated'), null)
  catalog = []
  assert.equal(await service.resolve('subagent:a'), null)
})

test('concurrent polls share discovery, disposal cancels work and removes the service', async () => {
  let release
  let reads = 0
  const ctx = context(() => { reads++; return new Promise(resolve => { release = resolve }) })
  install(runtime(ctx))
  const service = ctx.get('botMonitor')
  const first = service.snapshot()
  const second = service.snapshot()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1)
  release([])
  assert.equal(await first, await second)
  const pending = service.snapshot()
  await new Promise(resolve => setImmediate(resolve))
  await ctx.dispose()
  await assert.rejects(pending, /disposed/)
  assert.equal(ctx.get('botMonitor'), undefined)
  await assert.rejects(service.snapshot(), /disposed/)
})

test('root removal while collecting invalidates discovered children and navigation', async t => {
  let rt
  const ctx = context(async id => {
    if (id === 'root') { delete rt.state.bots.bot; return [child('a')] }
    return []
  })
  rt = runtime(ctx)
  install(rt)
  t.after(() => ctx.dispose())
  assert.deepEqual((await ctx.get('botMonitor').snapshot()).entities, [])
  assert.equal(await ctx.get('botMonitor').resolve('subagent:a'), null)
})

test('service deadline returns root activity when a catalog stalls', async t => {
  let aborted = false
  const ctx = context((_id, signal) => {
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
    return new Promise(() => {})
  })
  install(runtime(ctx))
  t.after(() => ctx.dispose())
  const snapshot = await ctx.get('botMonitor').snapshot()
  assert.equal(aborted, true)
  assert.equal(snapshot.partial, true)
  assert.deepEqual(snapshot.entities.map(item => item.id), ['bot'])
})
