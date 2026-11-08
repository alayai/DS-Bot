import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptSnapshot, entityState, runLabel, selectEntities } from '../src/client/model.js'

const entity = { id: 'b', name: 'Builder', role: 'Engineer', waiting: false }
const snapshot = {
  version: 2, capturedAt: 100, entities: [entity],
  groups: [{ id: 'g', members: ['b'] }],
  sessions: [{ id: 'own', entityId: 'b', status: 'running', blockers: [] }, { id: 'group', entityId: 'b', status: 'running', blockers: ['approval'] }],
  runs: [{ entityId: 'b' }, { entityId: 'b' }],
}

test('attention wins over another active context without duplicating members', () => {
  assert.equal(entityState(entity, snapshot), 'attention')
  assert.equal(selectEntities(snapshot, { query: 'engineer', group: 'g', status: 'attention' }).length, 1)
  assert.equal(selectEntities(snapshot, { status: 'running' }).length, 0)
  assert.equal(selectEntities(snapshot, { query: 'missing' }).length, 0)
})

test('unobserved sessions stay unknown and malformed protocol is rejected', () => {
  assert.equal(entityState(entity, { sessions: [], runs: [] }), 'unknown')
  const idle = { entityId: 'b', status: 'idle', blockers: [] }
  assert.equal(entityState(entity, { sessions: [idle], runs: [] }), 'idle')
  assert.equal(entityState(entity, {
    sessions: [idle, { ...idle, status: 'unknown' }], runs: [],
  }), 'unknown')
  assert.throws(() => acceptSnapshot({ ...snapshot, version: 99 }), /incompatible/)
  assert.throws(() => acceptSnapshot({ ...snapshot, entities: null }), /incompatible/)
  assert.equal(acceptSnapshot(snapshot), snapshot)
})

test('subagents inherit the root member group filter and keep their own live state', () => {
  const child = { id: 'subagent:c', rootEntityId: 'b', name: 'Reviewer', role: '' }
  const data = { ...snapshot, entities: [entity, child], runs: [...snapshot.runs, { entityId: child.id }] }
  assert.deepEqual(selectEntities(data, { group: 'g', status: 'running' }), [child])
  assert.equal(selectEntities(data, { query: 'reviewer' }).length, 1)
})


test('waiting reasons take precedence over tool labels, while unanswered continued input does not pause a run', () => {
  assert.equal(runLabel({ phase: 'waiting', tool: 'bash', blockers: ['approval', 'input'] }), 'approval')
  assert.equal(runLabel({ phase: 'waiting', tool: 'ask_user_question', blockers: ['input'] }), 'input')
  assert.equal(runLabel({ phase: 'tool', tools: ['read', 'search'], blockers: [] }), 'tool')
  assert.equal(runLabel({ phase: 'active', blockers: [] }), 'active')
  const data = { ...snapshot, sessions: [{ entityId: 'b', status: 'idle', pendingInput: 'continued', blockers: ['input'] }], runs: [] }
  assert.equal(entityState(entity, data), 'attention')
})
