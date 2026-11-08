import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityProjection as projection, installActivity, readActivity } from '../src/host/monitor-activity.js'
import { agentActivity } from '../src/host/monitor-agents.js'
import { fakeContext } from './fake-ctx.js'

const event = (type, data = {}, seq = 1) => ({ type, data, seq, time: 1000 + seq })
const start = () => projection.apply(projection.init(), event('turn/start', { turn: 3 }))
const call = (state, id, name = 'read') => projection.apply(state, event('tool/call', { turn: 3, callId: id, name, arguments: 'SECRET_ARGUMENTS' }))
const result = (state, id) => projection.apply(state, event('tool/result', { message: { toolCallId: id, content: 'SECRET_RESULT' } }))
const resident = status => ({ status, session: { id: 'root' } })
function context(state, active = [], agent = resident('running')) {
  return fakeContext({ services: {
    agents: { get: () => agent },
    sessionProjections: { stateOf: (_session, key) => key === projection.key ? state : { questions: { active, settled: [] } } },
  } })
}

test('projection pairs concurrent tools and PTC calls without retaining arguments or results', () => {
  let state = call(call(start(), 'a', 'read'), 'b', 'search')
  state = projection.apply(state, event('tool/ptc-dispatch-start', { subCallId: 'p', name: 'bash', arguments: { secret: 'SECRET' } }))
  state = result(state, 'a')
  assert.deepEqual(state.calls, [{ id: 'b', name: 'search' }, { id: 'p', name: 'bash' }])
  state = projection.apply(state, event('tool/ptc-dispatch', { subCallId: 'p', content: 'SECRET' }))
  assert.deepEqual(state.calls, [{ id: 'b', name: 'search' }])
  assert.equal(JSON.stringify(state).includes('SECRET'), false)
  assert.equal(result(state, 'unknown'), state)
  assert.equal(call(state, 'b'), state)
})

test('turn closure, new turns and fork inheritance cannot resurrect old work', () => {
  let state = projection.init({}, 10)
  assert.equal(projection.apply(state, event('turn/start', { turn: 1 }, 9)), state)
  state = projection.apply(state, event('turn/start', { turn: 3 }, 10))
  state = projection.apply(state, event('tool/call', { turn: 3, callId: 'a', name: 'read' }, 11))
  state = projection.apply(state, event('approval/asked', { id: 'ask', reason: 'SECRET' }, 12))
  assert.equal(projection.apply(state, event('turn/end', { turn: 2 }, 13)), state)
  state = projection.apply(state, event('turn/end', { turn: 3 }, 14))
  assert.deepEqual(state, projection.init({}, 10))
  assert.equal(projection.apply(state, event('approval/asked', { id: 'stale' }, 15)), state)
  assert.equal(projection.apply(call(start(), 'old'), event('turn/start', { turn: 4 })).calls.length, 0)
})

test('approval ids settle independently for every outcome and reasons never enter the projection', () => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    let state = projection.apply(start(), event('approval/asked', { id: 'a', reason: 'SECRET' }))
    state = projection.apply(state, event('approval/asked', { id: 'b', reason: 'SECRET' }))
    state = projection.apply(state, event('approval/decided', { id: 'a', outcome }))
    assert.deepEqual(state.approvals, ['b'])
    assert.equal(JSON.stringify(state).includes('SECRET'), false)
    assert.deepEqual(readActivity(context(state), resident('running')).blockers, ['approval'])
  }
})

test('invalid names are omitted and activity state stays bounded with explicit partial coverage', () => {
  let state = call(start(), 'invalid', 'private\nvalue')
  assert.equal(state.calls[0].name, null)
  for (let n = 0; n < 200; n++) {
    state = call(state, `c${n}`)
    state = projection.apply(state, event('approval/asked', { id: `a${n}` }))
  }
  assert.equal(state.calls.length, 128)
  assert.equal(state.approvals.length, 128)
  assert.equal(state.partial, true)
  assert.equal(readActivity(context(state), resident('running')).detailState, 'partial')
  const parsed = projection.stateSchema.parse({ ...state, secret: 'SECRET' })
  parsed.calls.pop()
  assert.equal(state.calls.length, 128)
  assert.equal('secret' in parsed, false)
  assert.throws(() => projection.stateSchema.parse({ ...state, calls: [...state.calls, { id: 'overflow', name: 'read' }] }))
})

test('registry status wins over stale projection state; missing and throwing projections degrade details', () => {
  const state = projection.apply(call(start(), 'tool'), event('approval/asked', { id: 'a' }))
  const agent = resident('idle')
  const ctx = context(state, [{ state: 'open' }], agent)
  assert.equal(agentActivity(ctx, 'entity', 'root').run, null)
  assert.deepEqual(agentActivity(ctx, 'entity', 'root').session.blockers, [])
  agent.status = 'running'
  assert.equal(agentActivity(ctx, 'entity', 'root').run.startedAt, 1001)
  assert.equal(agentActivity(ctx, 'entity', 'root').run.phase, 'waiting')
  for (const projections of [undefined, { stateOf: () => { throw new Error('SECRET path') } }]) {
    const degraded = fakeContext({ services: { agents: { get: () => agent }, sessionProjections: projections } })
    const activity = agentActivity(degraded, 'entity', 'root')
    assert.equal(activity.run.phase, 'active')
    assert.equal(activity.session.status, 'running')
    assert.equal(activity.session.detailState, 'unavailable')
    assert.equal(JSON.stringify(activity).includes('SECRET'), false)
  }
  assert.equal(agentActivity(fakeContext(), 'entity', 'root').session.status, 'unknown')
})

test('continued questions coexist with independent work and survive idle; open questions block only live work', () => {
  const state = call(start(), 'a', 'bash')
  const agent = resident('running')
  const ctx = context(state, [{ state: 'continued', questions: ['SECRET'] }], agent)
  let activity = agentActivity(ctx, 'entity', 'root')
  assert.deepEqual(activity.session.blockers, ['input'])
  assert.equal(activity.session.pendingInput, 'continued')
  assert.equal(activity.run.phase, 'tool')
  assert.deepEqual(activity.run.blockers, [])
  agent.status = 'idle'
  activity = agentActivity(ctx, 'entity', 'root')
  assert.deepEqual(activity.session.blockers, ['input'])
  assert.equal(activity.run, null)
  agent.status = 'running'
  activity = agentActivity(context(state, [{ state: 'open' }], agent), 'entity', 'root')
  assert.equal(activity.run.phase, 'waiting')
  assert.deepEqual(activity.run.blockers, ['input'])
})

test('live question observation preserves the exact answer, handles parallel waits and isolates Agent instances', async t => {
  const ctx = fakeContext()
  const hasQuestion = installActivity(ctx)
  t.after(() => ctx.dispose())
  const listener = ctx.listeners.get('user-questions/request')[0]
  const agent = resident('running')
  let answerA, answerB
  const first = listener({ agent }, () => new Promise(resolve => { answerA = resolve }))
  const second = listener({ agent }, () => new Promise(resolve => { answerB = resolve }))
  assert.equal(hasQuestion(agent), true)
  assert.equal(hasQuestion(resident('running')), false)
  const value = { answers: ['exact native answer'] }
  answerA(value)
  assert.equal(await first, value)
  assert.equal(hasQuestion(agent), true)
  answerB(value)
  assert.equal(await second, value)
  assert.equal(hasQuestion(agent), false)
})

test('question errors, cancellation and disposal clear observation without answering or aborting the native wait', async () => {
  const ctx = fakeContext()
  const hasQuestion = installActivity(ctx)
  const listener = ctx.listeners.get('user-questions/request')[0]
  const agent = resident('running')
  const failure = new Error('native failure')
  await assert.rejects(listener({ agent }, () => { throw failure }), error => error === failure)
  assert.equal(hasQuestion(agent), false)
  const controller = new AbortController()
  let finish
  const pending = listener({ agent, signal: controller.signal }, () => new Promise(resolve => { finish = resolve }))
  assert.equal(hasQuestion(agent), true)
  controller.abort()
  assert.equal(hasQuestion(agent), false)
  finish('native answer')
  assert.equal(await pending, 'native answer')
  const lifetime = new AbortController()
  const unloading = listener({ agent, signal: lifetime.signal }, () => new Promise(resolve => { finish = resolve }))
  await ctx.dispose()
  assert.equal(hasQuestion(agent), false)
  assert.equal(lifetime.signal.aborted, false)
  finish('native answer after monitor unload')
  assert.equal(await unloading, 'native answer after monitor unload')
})

test('projection registration is optional and disposes with the monitor', async () => {
  let registered, disposed = false
  const ctx = fakeContext({ services: { sessionProjections: {
    register: value => { registered = value; return () => { disposed = true } },
  } } })
  installActivity(ctx)
  assert.equal(registered, projection)
  assert.equal(registered.wire, undefined)
  await ctx.dispose()
  assert.equal(disposed, true)
})
