import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inSpace, roomLayout, selectSpaceEntities, spaceSnapshot, spaceState } from '../src/client/rooms.js'

const bot = { id: 'b', kind: 'bot', name: 'Builder', role: '', waiting: true }
const agent = { id: 'a', kind: 'agent', name: 'Agent', role: '' }
const child = { id: 'child', kind: 'subagent', name: 'Review', role: '', rootEntityId: 'b', rootSessionId: 'bs1' }
const fixture = () => ({
  entities: [bot, agent, child],
  groups: [{ id: 'g1', name: 'Team', members: ['b'] }, { id: 'g2', name: 'Team', members: ['b'] }, { id: 'empty', name: 'Empty', members: [] }],
  sessions: [
    { id: 'own', entityId: 'b', groupId: null, status: 'running', blockers: [] },
    { id: 'bs1', entityId: 'b', groupId: 'g1', status: 'running', blockers: ['approval'] },
    { id: 'bs2', entityId: 'b', groupId: 'g2', status: 'idle', blockers: [] },
    { id: 'cs', entityId: 'child', groupId: 'g1', status: 'running', blockers: [] },
  ],
  runs: [
    { entityId: 'b', sessionId: 'own', groupId: null },
    { entityId: 'b', sessionId: 'bs1', groupId: 'g1' },
    { entityId: 'child', sessionId: 'cs', groupId: 'g1' },
  ],
})

test('one room per group, including empty and identically named groups; identity stays unique', () => {
  const data = fixture()
  const layout = roomLayout(data)
  assert.equal(layout.rooms.length, 4)
  assert.equal(new Set(layout.rooms.map(room => room.key)).size, 4)
  assert.equal(layout.presences.filter(item => item.entity.id === 'b').length, 3)
  assert.equal(new Set(layout.presences.map(item => item.key)).size, layout.presences.length)
  assert.equal(layout.rooms.find(room => room.groupId === 'empty').total, 0)
  assert.equal(data.entities.length, 3)
})

test('room states and filters use only that group context, not private or other group work', () => {
  const data = fixture()
  assert.equal(spaceState(bot, data, 'g1'), 'attention')
  assert.equal(spaceState(bot, data, 'g2'), 'idle')
  assert.equal(spaceState(bot, data, null), 'running')
  assert.deepEqual(selectSpaceEntities(data, { groupId: 'g2', status: 'running' }), [])
  assert.deepEqual(selectSpaceEntities(data, { groupId: 'g2', status: 'idle' }), [bot])
  assert.deepEqual(spaceSnapshot(data, 'g1').runs.map(run => run.sessionId), ['bs1', 'cs'])
  data.sessions = data.sessions.filter(session => session.id !== 'bs2')
  assert.equal(spaceState(bot, data, 'g2'), 'unknown')
})

test('children follow the explicit root session, including external children with no local session', () => {
  const data = fixture()
  assert.equal(inSpace(child, data, 'g1'), true)
  assert.equal(inSpace(child, data, 'g2'), false)
  assert.equal(inSpace(child, data, null), false)
  assert.equal(inSpace({ ...child, mode: 'external' }, data, 'g1'), true)
  data.groups[0].members = []
  assert.equal(inSpace(child, data, 'g1'), false)
  data.sessions = []
  assert.equal(inSpace(child, data, null), false)
})

test('layout is stable across input ordering and places seats inside separate room bounds', () => {
  const data = fixture()
  const first = roomLayout(data)
  assert.deepEqual(roomLayout({ ...data, groups: [...data.groups].reverse(), entities: [...data.entities].reverse() }), first)
  for (const seat of first.presences) {
    const room = first.rooms.find(item => item.groupId === seat.groupId)
    assert.ok(Math.abs(seat.x - room.x) < room.width / 2)
    assert.ok(Math.abs(seat.z - room.z) < room.depth / 2)
  }
  for (const a of first.rooms) for (const b of first.rooms) if (a !== b) {
    assert.ok(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.z - b.z) >= (a.depth + b.depth) / 2)
  }
  assert.equal(first.truncated, false)
})

test('rendering limits count repeated seats; focusing a group recovers seats omitted from overview', () => {
  const data = fixture()
  data.groups = Array.from({ length: 30 }, (_, index) => ({ id: `g${index}`, name: 'Team', members: ['b', 'a'] }))
  const overview = roomLayout(data)
  assert.equal(overview.rooms.length, 24)
  assert.ok(overview.presences.length <= 50)
  assert.equal(overview.truncated, true)
  const focused = roomLayout(data, { groupId: 'g29' })
  assert.equal(focused.rooms.length, 1)
  assert.equal(focused.presences.length, 2)
  assert.equal(focused.truncated, false)
  assert.deepEqual(roomLayout(data, { query: 'absent' }).rooms, [])
})
