import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recentProjection as projection, readRecent } from '../src/host/monitor-recent.js'
import { monitorSnapshot } from '../src/host/monitor.js'

const event = (type, turn, seq, kind) => ({
  type, seq, time: 1000 + seq, data: { turn, reason: { kind, error: 'SECRET', message: 'SECRET' } },
})
const finish = (state, turn, seq, kind = 'completed') => projection.apply(
  projection.apply(state, event('turn/start', turn, seq)), event('turn/end', turn, seq + 1, kind))

test('short runs retain authoritative endings without retaining text or assuming success', () => {
  let state = projection.init()
  for (const [index, kind] of ['completed', 'aborted', 'error', 'new-reason'].entries()) {
    state = finish(state, index, index * 2, kind)
  }
  assert.deepEqual(state.recent.map(run => run.outcome), ['completed', 'aborted', 'error', 'unknown'])
  assert.equal(state.turn, null)
  assert.equal(JSON.stringify(state).includes('SECRET'), false)
  assert.equal(state.recent[0].startedAt, 1000)
  assert.equal(state.recent[0].endedAt, 1001)
})

test('source sequence rejects duplicate and late events, inherited endings and unrelated turns', () => {
  let state = projection.init({}, 10)
  assert.equal(projection.apply(state, event('turn/start', 0, 9)), state)
  state = projection.apply(state, event('turn/end', 0, 10, 'completed'))
  assert.deepEqual(state.recent, [])
  state = finish(state, 1, 11)
  for (const e of [event('turn/start', 0, 9), event('turn/end', 1, 12, 'error')]) {
    assert.equal(projection.apply(state, e), state)
  }
  state = projection.apply(state, event('turn/start', 2, 13))
  state = projection.apply(state, event('turn/end', 1, 14, 'error'))
  assert.equal(state.turn, 2)
  assert.equal(state.recent.length, 1)
})

test('10000 completed turns stay bounded and schema drops unknown fields', () => {
  let state = projection.init()
  for (let n = 0; n < 10000; n++) state = finish(state, n, n * 2)
  assert.equal(state.recent.length, 16)
  assert.equal(state.recent[0].turn, 9984)
  assert.equal(state.truncated, true)
  const parsed = projection.stateSchema.parse({ ...state, secret: 'SECRET' })
  parsed.recent.pop()
  assert.equal(state.recent.length, 16)
  assert.equal('secret' in parsed, false)
  assert.throws(() => projection.stateSchema.parse({ ...state, recent: Array(17).fill(state.recent[0]) }))
})

test('resident-only reads cannot load an Agent and missing or corrupt projections degrade safely', () => {
  const state = finish(projection.init(), 1, 0)
  let agent = { session: { id: 's' } }, value = state
  const ctx = { get: name => name === 'agents' ? { get: () => agent }
    : { stateOf: () => value } }
  assert.equal(readRecent(ctx, 's').recentRuns.length, 1)
  value = { ...state, recent: [{ secret: 'SECRET' }] }
  assert.deepEqual(readRecent(ctx, 's'), { recentRuns: [], recentCoverage: 'unavailable' })
  value = state; agent = undefined
  assert.equal(readRecent(ctx, 's').recentCoverage, 'unavailable')
})

test('deleted Bots and rotated sessions drop old recent endings from snapshots', () => {
  const state = finish(projection.init(), 1, 0)
  let sessionId = 'own'
  const rt = {
    state: { bots: { b: { id: 'b', name: '<script>SECRET</script>' } }, mainBotIds: [], rooms: {} },
    chatOf: () => sessionId, groupOwners: new Map(), live: new Map(),
    approvalsView: () => [], waitingView: () => ({}), readOnly: () => undefined,
    ctx: { get: name => name === 'agents' ? { get: id => id === 'own' ? { session: { id } } : undefined }
      : { stateOf: () => state } },
  }
  assert.equal(monitorSnapshot(rt).sessions[0].recentRuns.length, 1)
  sessionId = 'new'
  assert.equal(monitorSnapshot(rt).sessions[0].recentRuns.length, 0)
  delete rt.state.bots.b
  assert.deepEqual(monitorSnapshot(rt).sessions, [])
})
