import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowsShortcut, cameraFrame, createCameraState } from '../src/client/camera.js'
import { presenceKey } from '../src/client/rooms.js'

const layout = {
  width: 24, depth: 18,
  rooms: [{ key: 'g1', x: 4, z: 2, width: 8, depth: 6 }],
  presences: [
    { key: presenceKey('bot', 'g1'), x: 3, z: 2 },
    { key: presenceKey('bot', null), x: -4, z: -2 },
  ],
}

test('camera moves from overview to the selected room and exact member seat', () => {
  const overview = cameraFrame(layout, null, false)
  const room = cameraFrame(layout, null, true)
  const member = cameraFrame(layout, { entityId: 'bot', groupId: 'g1' }, true)
  assert.deepEqual(overview.center, [0, 0, 0])
  assert.deepEqual(room.center, [4, 0, 2])
  assert.deepEqual(member.center, [3, .85, 1.8])
  assert.ok(overview.radius > room.radius && room.radius > member.radius)
  const common = cameraFrame(layout, { entityId: 'bot', groupId: null }, true)
  assert.deepEqual(common.center, [-4, .85, -2.2])
  assert.notEqual(common.key, member.key)
})

test('aggregate 2D selection never focuses a common seat; missing members fall back to room', () => {
  assert.equal(cameraFrame(layout, { entityId: 'bot' }, false).key, 'overview')
  assert.equal(cameraFrame(layout, { entityId: 'gone', groupId: 'g1' }, true).key, 'room:g1')
  assert.equal(cameraFrame({ ...layout, rooms: [] }, null, true).key, 'overview')
})

test('polls preserve orbit and zoom; member movement follows its target without resetting angle', () => {
  const camera = createCameraState()
  const frame = cameraFrame(layout, { entityId: 'bot', groupId: 'g1' }, true)
  camera.update(frame)
  const initial = camera.position(1.5)
  camera.orbit(.5, -.2)
  camera.scale(.6)
  const changed = camera.position(1.5)
  assert.notDeepEqual(changed, initial)
  camera.update({ ...frame })
  assert.deepEqual(camera.position(1.5), changed)
  camera.update({ ...frame, center: [frame.center[0] + 1, frame.center[1], frame.center[2]] })
  assert.deepEqual(camera.position(1.5).eye, [changed.eye[0] + 1, changed.eye[1], changed.eye[2]])
  camera.update(cameraFrame(layout, null, true))
  camera.update(frame)
  assert.deepEqual(camera.position(1.5), initial)
  camera.orbit(.4, .2)
  camera.reset()
  assert.deepEqual(camera.position(1.5), initial)
})

test('view fits narrow screens, and extreme zoom and orbit remain bounded', () => {
  const camera = createCameraState()
  camera.update(cameraFrame(layout, null, false))
  const distance = pose => Math.hypot(...pose.eye.map((value, i) => value - pose.center[i]))
  assert.ok(distance(camera.position(.4)) > distance(camera.position(2)))
  const normal = distance(camera.position(1))
  camera.scale(1e10)
  assert.ok(Math.abs(distance(camera.position(1)) / normal - 2) < 1e-10)
  camera.scale(1e-20)
  assert.ok(Math.abs(distance(camera.position(1)) / normal - .3) < 1e-10)
  camera.orbit(0, 1e5)
  assert.ok(camera.position(1).eye.every(Number.isFinite))
  camera.orbit(0, -1e5)
  assert.ok(camera.position(1).eye[1] > 0)
})

test('typing, composition, modifiers, and consumed events never trigger shortcuts', () => {
  assert.equal(allowsShortcut({ target: { closest: () => null } }), true)
  for (const blocked of [
    { isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 },
    { defaultPrevented: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
    { target: { closest: () => ({}) } },
  ]) assert.equal(allowsShortcut(blocked), false)
})
