import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/turns.js'
import { monitorSnapshot } from '../src/host/monitor.js'

function fixture() {
  let onEvent
  const rt = {
    ctx: { on: (_name, fn) => { onEvent = fn }, get: () => undefined },
    state: { bots: { b: { id: 'b', name: 'Builder' } }, rooms: {}, mainBotIds: ['b'], questions: {}, exchangeTurns: {} },
    groupOwners: new Map(), chatOwners: new Map([['s', 'b']]),
    isBotSession: id => id === 's', roomOf: () => undefined, chatOf: () => 's',
    switchJobs: () => [], approvalsView: () => [], waitingView: () => ({}), readOnly: () => undefined,
  }
  install(rt)
  const emit = (type, data) => onEvent({ id: 's' }, { type, data })
  emit('turn/start', { turn: 1 })
  const call = (callId, name) => emit('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
  const result = (toolCallId, isError = false) => emit('tool/result', {
    turn: 1, step: 1, message: { role: 'tool', toolCallId, content: [], ...(isError ? { isError: true } : {}) },
  })
  return { rt, emit, call, result, run: () => monitorSnapshot(rt).runs[0] }
}

for (const isError of [false, true]) test(`a ${isError ? 'failed' : 'completed'} tool restores thinking before the turn ends`, () => {
  const { rt, call, result, run } = fixture()
  call('search', 'web_search')
  assert.equal(rt.activityView().b, 'searching')
  assert.equal(run().tool, 'web_search')
  result('search', isError)
  assert.equal(rt.live.get('s').calls.size, 0)
  assert.equal(rt.activityView().b, 'thinking')
  assert.equal(run().phase, 'thinking')
  assert.equal(run().tool, null)
})

test('parallel native and PTC results remove only their matching call', () => {
  const { rt, emit, call, result, run } = fixture()
  call('search', 'web_search')
  call('write', 'write_file')
  emit('tool/ptc-dispatch-start', { subCallId: 'read', name: 'read_file', arguments: {} })
  result('write')
  assert.equal(rt.live.get('s').calls.size, 2)
  assert.equal(run().tool, 'read_file')
  result('unrelated')
  assert.equal(rt.live.get('s').calls.size, 2)
  emit('tool/ptc-dispatch', { subCallId: 'read' })
  assert.equal(run().tool, 'web_search')
  assert.equal(rt.activityView().b, 'searching')
  result('search')
  assert.equal(run().phase, 'thinking')
  assert.equal(rt.activityView().b, 'thinking')
})
