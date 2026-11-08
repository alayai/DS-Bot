import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityRoute, createActivity, routeLength, routePoint } from '../src/client/activities.js'
import { roomLayout } from '../src/client/rooms.js'
import { roomFixtures, stationSize } from '../src/client/office-layout.js'

function layout(count = 3, groupId = null) {
  const entities = Array.from({ length: count }, (_, i) => ({ id: `b${i}`, kind: 'bot', name: `Bot ${i}` }))
  return roomLayout({ entities, groups: [{ id: 'g', name: 'Group', members: entities.map(e => e.id) }],
    sessions: entities.map(e => ({ id: e.id, entityId: e.id, status: 'idle', blockers: [], groupId })), runs: [] }, { groupId })
}
test('paths keep room identity and use clear aisles, including 50-seat layouts', () => {
  for (const count of [1, 3, 20, 50]) for (const groupId of [null, 'g']) {
    const { rooms: [room], presences } = layout(count, groupId)
    for (const seat of presences) for (const action of groupId === null ? ['water', 'coffee', 'snooker'] : ['water']) {
      const path = activityRoute(seat, room, action)
      assert.deepEqual(path[0], [seat.x, seat.z])
      const blocks = [
        ...roomFixtures(room).map(f => ({ ...f, x: f.x + room.x, z: f.z + room.z })),
        ...presences.filter(s => s.key !== seat.key).map(s => ({ ...s, ...stationSize })),
      ]
      for (let d = 0; d <= routeLength(path); d += .15) {
        const point = routePoint(path, d)
        assert.ok(Math.abs(point.x - room.x) < room.width / 2 - .3)
        assert.ok(Math.abs(point.z - room.z) < room.depth / 2 - .3)
        for (const block of blocks) assert.ok(
          Math.abs(point.x - block.x) >= block.width / 2 + .29 || Math.abs(point.z - block.z) >= block.depth / 2 + .29,
          `${count}/${groupId}/${action}: path intersects ${block.kind ?? block.key}`)
      }
    }
  }
})
test('observed idle cycles cover activities, sleep waits, and facility leases are exclusive', () => {
  const { rooms: [room], presences } = layout(8), reservations = new Map()
  const actors = presences.map(seat => createActivity(seat, room, reservations))
  const waiting = actors[0].step(0, 'lively')
  assert.equal(waiting.animate, false)
  assert.ok(waiting.wakeAfter >= 4)
  const seen = new Set()
  for (let time = 0; time < 420; time += .2) {
    const poses = actors.map(actor => { actor.setState('idle', time); return actor.step(time, 'lively') })
    for (const pose of poses) {
      seen.add(pose.action)
      if (time < 60) assert.notEqual(pose.action, 'sleep')
      assert.ok([pose.x, pose.z, pose.angle].every(Number.isFinite))
    }
    assert.ok(poses.filter(p => ['water', 'coffee'].includes(p.action)).length <= 1)
    assert.ok(poses.filter(p => p.action === 'snooker').length <= 1)
  }
  for (const action of ['walk', 'water', 'coffee', 'stretch', 'dumbbell', 'sleep', 'snooker']) assert.ok(seen.has(action), action)
  actors.forEach(a => a.dispose()); assert.equal(reservations.size, 0)
})
test('new work interrupts an outing and retraces the path without jumping or losing the target', () => {
  const { rooms: [room], presences: [seat] } = layout(1), actor = createActivity(seat, room, new Map())
  let pose, time = 0
  for (; time < 200; time += .05) {
    pose = actor.step(time, 'lively')
    if (pose.action === 'walk' && Math.hypot(pose.x - seat.x, pose.z - seat.z) > .5) break
  }
  assert.ok(time < 200)
  actor.setState('running', time)
  let previous = pose, returned = false
  for (; time < 240; time += .05) {
    const next = actor.step(time, 'lively')
    assert.ok(Math.hypot(next.x - previous.x, next.z - previous.z) < .12)
    if (next.action === 'type') { assert.equal(next.x, seat.x); assert.equal(next.z, seat.z); returned = true; break }
    previous = next
  }
  assert.ok(returned)
  actor.dispose()
})
test('unknown, quiet, waiting, and normal time limits never simulate continuous work', () => {
  const { rooms: [room], presences: [seat] } = layout(1), reservations = new Map()
  for (const state of ['unknown', 'attention', 'waiting']) {
    const actor = createActivity({ ...seat, state }, room, reservations)
    assert.deepEqual([actor.step(50, 'lively').action, actor.step(50, 'lively').animate], ['sit', false])
  }
  const actor = createActivity({ ...seat, state: 'running' }, room, reservations)
  assert.equal(actor.step(1, 'normal').action, 'type')
  assert.equal(actor.step(6, 'normal').animate, false)
  assert.equal(actor.step(7, 'quiet').action, 'sit')
  assert.equal(actor.step(8, 'lively').action, 'type')
  actor.setState('idle', 9)
  actor.step(60, 'lively')
  actor.step(61, 'quiet')
  assert.equal(reservations.size, 0)
})
