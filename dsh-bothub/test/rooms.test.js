import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inSpace, isSceneEntity, roomLayout, selectSpaceEntities, spaceSnapshot, spaceState, workSnapshot } from '../src/client/rooms.js'

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
  assert.deepEqual(layout.presences.filter(item => item.entity.id === 'b').map(item => item.groupId), ['g1', 'g2'])
  assert.equal(new Set(layout.presences.map(item => item.key)).size, layout.presences.length)
  assert.equal(layout.rooms.find(room => room.groupId === 'empty').total, 0)
  assert.deepEqual(layout.presences.map(item => item.entity.id).sort(), ['b', 'b'])
  assert.equal(layout.presences.some(item => item.entity.kind === 'subagent'), false)
  assert.equal(data.entities.length, 3)
})

test('public room excludes group members even when only their private session matches the filter', () => {
  const data = fixture()
  data.sessions.find(session => session.id === 'bs1').blockers = []
  const publicRoom = layout => layout.rooms.find(room => room.groupId === null)
  assert.equal(publicRoom(roomLayout(data)).total, 0)
  assert.deepEqual(publicRoom(roomLayout(data, { groupId: null })).entities, [])
  assert.deepEqual(roomLayout(data, { status: 'running' }).presences.map(item => item.groupId), ['g1', 'g2'])
  assert.deepEqual(selectSpaceEntities(data, { groupId: null }), [agent])
  assert.deepEqual(selectSpaceEntities(data), [bot, agent, child])

  data.groups[0].members = []
  assert.deepEqual(selectSpaceEntities(data, { groupId: null }), [agent])
  data.groups[1].members = []
  assert.deepEqual(selectSpaceEntities(data, { groupId: null, status: 'running' }), [bot])
  assert.equal(publicRoom(roomLayout(data)).total, 1)
})

test('3D scene only lays out Bots while 2D keeps Agents and subagents', () => {
  const data = fixture()
  assert.equal(isSceneEntity(bot), true)
  assert.equal(isSceneEntity(agent), false)
  assert.equal(isSceneEntity(child), false)
  assert.deepEqual(roomLayout(data).presences.map(item => item.entity.id).sort(), ['b', 'b'])
  assert.deepEqual(selectSpaceEntities(data), [bot, agent, child])
})

test('Bot seats share real work while room conversations retain their own context', () => {
  const data = fixture()
  assert.equal(spaceState(bot, data, 'g1'), 'attention')
  assert.equal(spaceState(bot, data, 'g2'), 'attention')
  assert.equal(spaceState(bot, data, null), 'attention')
  assert.deepEqual(selectSpaceEntities(data, { groupId: 'g2', status: 'running' }), [])
  assert.deepEqual(selectSpaceEntities(data, { groupId: 'g2', status: 'idle' }), [])
  assert.deepEqual(selectSpaceEntities(data, { groupId: 'g2', status: 'attention' }), [bot])
  assert.equal(workSnapshot(bot, data, 'g2'), data)
  assert.deepEqual(spaceSnapshot(data, 'g1').runs.map(run => run.sessionId), ['bs1', 'cs'])
  data.sessions = data.sessions.filter(session => session.id !== 'bs2')
  assert.equal(spaceState(bot, data, 'g2'), 'attention')
  assert.equal(spaceState(child, data, 'g2'), 'unknown')
  assert.deepEqual(workSnapshot(child, data, 'g2').runs, [])
})

test('private tool work and other-group work remain busy in an idle or unobserved room', () => {
  const data = fixture()
  data.entities[0] = { ...bot, waiting: false }
  data.sessions.forEach(session => { session.status = 'idle'; session.blockers = [] })
  const worker = data.entities[0]
  for (const context of [null, 'g1']) {
    const session = data.sessions.find(item => item.entityId === worker.id && item.groupId === context)
    session.status = 'running'
    data.runs = [{ id: 'current', entityId: worker.id, sessionId: session.id, groupId: context, phase: 'tool', tool: 'read_page' }]
    for (const groupId of ['g1', 'g2']) {
      assert.equal(spaceState(worker, data, groupId), 'running')
      assert.deepEqual(selectSpaceEntities(data, { groupId, status: 'running' }), [worker])
      assert.equal(selectSpaceEntities(data, { groupId, status: 'idle' }).some(item => item.id === worker.id), false)
      assert.equal(roomLayout(data, { groupId }).presences[0].state, 'running')
      assert.equal(workSnapshot(worker, data, groupId).runs[0].sessionId, session.id)
    }
    session.status = 'idle'
  }
  data.sessions = data.sessions.filter(session => session.groupId !== 'g2')
  assert.equal(spaceState(worker, data, 'g2'), 'running')
  data.runs = []
  worker.waiting = true
  assert.equal(spaceState(worker, data, 'g2'), 'waiting')
  worker.waiting = false
  assert.equal(spaceState(worker, data, 'g2'), 'idle')
  data.sessions[0].status = 'unknown'
  assert.equal(spaceState(worker, data, 'g2'), 'unknown')
})

test('children follow the explicit root session, including external children with no local session', () => {
  const data = fixture()
  assert.equal(inSpace(child, data, 'g1'), true)
  assert.equal(inSpace(child, data, 'g2'), false)
  assert.equal(inSpace(child, data, null), false)
  assert.equal(inSpace({ ...child, rootSessionId: 'own' }, data, null), true)
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
  assert.equal(focused.presences.length, 1)
  assert.equal(focused.truncated, false)
  assert.deepEqual(roomLayout(data, { query: 'absent' }).rooms, [])
})
