import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityRoute, createActivity, routeLength, routePoint } from '../src/client/activities.js'
import { roomLayout } from '../src/client/rooms.js'
import { roomFixtures, stationSize } from '../src/client/office-layout.js'

function layout(count = 3, groupId = null) {
  const entities = Array.from({ length: count }, (_, i) => ({ id: `b${i}`, kind: 'bot', name: `Bot ${i}` }))
  return roomLayout({ entities, groups: groupId === null ? [] : [{ id: groupId, name: 'Group', members: entities.map(e => e.id) }],
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
test('unobserved members sit for 60 seconds, then follow the idle routine', () => {
  const { rooms: [room], presences: [seat] } = layout(1)
  const actor = createActivity({ ...seat, state: 'unknown' }, room, new Map())
  const waiting = actor.step(59, 'lively')
  assert.equal(waiting.action, 'sit')
  assert.equal(waiting.animate, false)
  assert.ok(waiting.wakeAfter > 0 && waiting.wakeAfter <= 1)
  let moved = false, slept = false
  for (let time = 60; time < 600; time += .2) {
    const pose = actor.step(time, 'lively')
    if (pose.action !== 'sit') moved = true
    if (time < 120) assert.notEqual(pose.action, 'sleep')
    if (pose.action === 'sleep') { slept = true; break }
  }
  assert.equal(moved, true)
  assert.equal(slept, true)
  assert.equal(actor.step(600, 'quiet').action, 'sit')
  actor.setState('running', 600)
  assert.equal(actor.step(601, 'lively').action, 'type')
  actor.setState('unknown', 601)
  assert.equal(actor.step(660, 'lively').action, 'sit')
  let restarted = false
  for (let time = 661; time < 720; time += .2) {
    if (actor.step(time, 'lively').animate) { restarted = true; break }
  }
  assert.equal(restarted, true)
  actor.dispose()
})
test('seatmates start and resume outings at different times', () => {
  const { rooms: [room], presences } = layout(12)
  const span = values => Math.max(...values) - Math.min(...values)
  const fullest = values => {
    const counts = new Map()
    for (const value of values) {
      const bucket = Math.floor(value / 3)
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    return Math.max(...counts.values())
  }
  const departures = (state, until) => {
    const actors = presences.map(seat => createActivity({ ...seat, state }, room, new Map()))
    const first = Array(actors.length).fill(null)
    const again = Array(actors.length).fill(null)
    const away = Array(actors.length).fill(false)
    for (let time = 0; time < until; time += .25) {
      actors.forEach((actor, index) => {
        const moving = actor.step(time, 'lively').action !== 'sit'
        if (moving && !away[index]) {
          if (first[index] === null) first[index] = time
          else if (again[index] === null) again[index] = time
        }
        away[index] = moving
      })
    }
    actors.forEach(actor => actor.dispose())
    return { first, again: again.filter(time => time !== null) }
  }
  const unnoticed = departures('unknown', 260)
  assert.ok(unnoticed.first.every(time => time >= 64))
  assert.ok(span(unnoticed.first) >= 25, span(unnoticed.first))
  assert.ok(fullest(unnoticed.first) <= 2, fullest(unnoticed.first))
  const idle = departures('idle', 160)
  assert.ok(span(idle.first) >= 25, span(idle.first))
  assert.ok(fullest(idle.first) <= 2, fullest(idle.first))
  assert.ok(idle.again.length >= 8)
  assert.ok(span(idle.again) >= 20, span(idle.again))
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

test('drink trips keep the cup through filling and normal or interrupted return', () => {
  for (const groupId of [null, 'g']) for (const drink of groupId === null ? ['water', 'coffee'] : ['water']) {
    for (const interrupt of ['none', 'out', 'filled']) {
      const { rooms: [room], presences: [seat] } = layout(1, groupId)
      const actor = createActivity(seat, room, new Map())
      let pose, time = 0
      const advance = until => {
        for (; time < 600; time += .05) {
          pose = actor.step(time, 'lively')
          if (until(pose)) return
        }
        assert.fail('expected drink phase was not reached')
      }
      advance(p => p.action === 'walk' && p.drink === drink && !p.filled
        && Math.hypot(p.x - seat.x, p.z - seat.z) > .5)
      if (interrupt !== 'out') {
        advance(p => p.action === drink)
        assert.equal(pose.drink, drink)
        advance(p => p.action === drink && p.filled)
      }
      if (interrupt !== 'none') actor.setState('running', time)
      advance(p => p.action === 'walk')
      assert.equal(pose.drink, drink)
      assert.equal(pose.filled, interrupt !== 'out')
      advance(p => p.action === (interrupt === 'none' ? 'sit' : 'type'))
      assert.equal(pose.drink, null)
      assert.equal(pose.filled, false)
      actor.dispose()
    }
  }
})
