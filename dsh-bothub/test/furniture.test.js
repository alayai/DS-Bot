import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Box3, Matrix4, Vector3 } from 'three'
import { createOfficeAssets, createOfficeEnvironment } from '../src/client/furniture.js'
import { roomFixtures, stationSize } from '../src/client/office-layout.js'
import { roomLayout } from '../src/client/rooms.js'

const fixture = (count = 3, groups = 2) => {
  const entities = Array.from({ length: count }, (_, id) => ({ id: `b${id}`, name: `Bot ${id}`, kind: 'bot', role: '' }))
  return {
    entities, sessions: [], runs: [],
    groups: Array.from({ length: groups }, (_, id) => ({ id: `g${id}`, name: 'Office', members: entities.map(e => e.id) })),
  }
}
const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 - .001
  && Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 - .001

test('storage, amenities and workstations fit inside every room without overlapping', () => {
  for (const count of [0, 1, 3, 12, 50]) {
    for (const groupId of [null, 'g0']) {
      const data = fixture(count, groupId === null ? 0 : 1)
      const layout = roomLayout(data, { groupId })
      const room = layout.rooms[0], furniture = roomFixtures(room)
      const stations = layout.presences.map(seat => ({ x: seat.x - room.x, z: seat.z - room.z, ...stationSize }))
      const footprints = [...furniture, ...stations]
      for (const item of footprints) {
        assert.ok(Math.abs(item.x) + item.width / 2 <= room.width / 2)
        assert.ok(Math.abs(item.z) + item.depth / 2 <= room.depth / 2)
      }
      for (let a = 0; a < footprints.length; a++) for (let b = a + 1; b < footprints.length; b++) {
        assert.equal(overlaps(footprints[a], footprints[b]), false, `${count} members: ${footprints[a].kind ?? 'station'} overlaps ${footprints[b].kind ?? 'station'}`)
      }
    }
  }
})

test('static furniture batches are shared across rooms; every instance resolves to its actual room or member', () => {
  const assets = createOfficeAssets()
  const layout = roomLayout(fixture(4, 24))
  const environment = createOfficeEnvironment(layout, assets)
  const matrix = new Matrix4(), point = new Vector3()
  try {
    assert.ok(environment.batchCount < 70, `too many static batches: ${environment.batchCount}`)
    assert.ok(environment.instances > 1000)
    assert.ok(environment.group.children.every(mesh => Object.values(assets.geometry).includes(mesh.geometry)))
    const rooms = new Set(layout.rooms.map(room => room.groupId)), seats = new Set(layout.presences.map(seat => seat.key))
    for (const mesh of environment.group.children) {
      assert.equal(mesh.count, mesh.userData.targets.length)
      for (let index = 0; index < mesh.count; index++) {
        const target = mesh.userData.targets[index]
        assert.ok(rooms.has(target.groupId))
        if (target.entityId) assert.ok(seats.has(target.key))
        mesh.getMatrixAt(index, matrix)
        point.setFromMatrixPosition(matrix)
        assert.ok(point.toArray().every(Number.isFinite))
      }
    }
    const bounds = new Box3().setFromObject(environment.group)
    assert.ok(bounds.min.x >= -layout.width / 2 && bounds.max.x <= layout.width / 2)
    assert.ok(bounds.min.z >= -layout.depth / 2 && bounds.max.z <= layout.depth / 2)
  } finally { environment.dispose(); assets.dispose() }
})

test('room rebuild frees instance buffers while shared surfaces survive until renderer disposal', () => {
  const assets = createOfficeAssets(), environment = createOfficeEnvironment(roomLayout(fixture()), assets)
  let instances = 0, geometries = 0, materials = 0, textures = 0
  for (const mesh of environment.group.children) mesh.addEventListener('dispose', () => instances++)
  for (const value of Object.values(assets.geometry)) value.addEventListener('dispose', () => geometries++)
  for (const value of Object.values(assets.materials)) value.addEventListener('dispose', () => materials++)
  for (const value of new Set(Object.values(assets.materials).map(m => m.map).filter(Boolean))) value.addEventListener('dispose', () => textures++)
  environment.dispose()
  assert.equal(instances, environment.batchCount)
  assert.equal(environment.group.children.length, 0)
  assert.deepEqual([geometries, materials, textures], [0, 0, 0])
  const replacement = createOfficeEnvironment(roomLayout(fixture(1, 0), { groupId: null }), assets)
  replacement.dispose(); assets.dispose()
  assert.equal(geometries, Object.keys(assets.geometry).length)
  assert.equal(materials, Object.keys(assets.materials).length)
  assert.equal(textures, 2)
})

test('theme changes reuse physical assets and restore light surfaces without cumulative darkening', () => {
  const assets = createOfficeAssets()
  const floor = assets.materials.floor, texture = floor.map, initial = floor.color.clone()
  const dark = { background: '#141414', card: '#242424', dark: true }
  assets.theme(dark)
  const first = floor.color.clone()
  assert.ok(first.r < initial.r)
  assets.theme(dark)
  assert.ok(floor.color.equals(first))
  assert.equal(assets.materials.wall.color.getHexString(), '242424')
  assets.theme({ background: '#fcfcfc', card: '#eeeeee', dark: false })
  assert.ok(floor.color.equals(initial))
  assert.equal(assets.materials.floor, floor)
  assert.equal(floor.map, texture)
  assets.dispose()
})
