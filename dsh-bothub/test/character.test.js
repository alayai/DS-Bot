import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CapsuleGeometry, CylinderGeometry, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three'
import { createCharacter } from '../src/client/character.js'
import { createOfficeAssets } from '../src/client/furniture.js'

function character(t) {
  const office = createOfficeAssets()
  const geometry = { body: new CapsuleGeometry(.21, .22), head: new SphereGeometry(.26),
    eye: new SphereGeometry(.035), limb: new CylinderGeometry(1, 1, 1) }
  const material = new MeshStandardMaterial()
  const rig = createCharacter(geometry, material, material, office)
  t.after(() => {
    office.dispose(); material.dispose()
    Object.values(geometry).forEach(g => g.dispose())
  })
  return { rig, geometry, office }
}

test('articulated poses and props reuse assets and maintain finite transforms through rapid changes', t => {
  const { rig, geometry, office } = character(t)
  const objects = []
  rig.group.traverse(child => objects.push(child))
  for (let frame = 0; frame < 180; frame++) {
    rig.update({ action: ['type', 'sleep', 'walk', 'water', 'coffee', 'stretch', 'dumbbell', 'snooker', 'sit'][frame % 9], time: frame / 12 }, 1 / 24)
    rig.group.updateMatrixWorld(true)
    for (const child of objects) {
      assert.ok(child.matrixWorld.elements.every(Number.isFinite))
      if (child.isMesh) assert.ok([...Object.values(geometry), ...Object.values(office.geometry)].includes(child.geometry))
    }
  }
  let count = 0
  rig.group.traverse(() => count++)
  assert.equal(count, objects.length)
})

test('walking arms and same-side feet move in opposite directions over both half-strides', t => {
  const { rig } = character(t)
  for (const time of [Math.PI / 18, Math.PI / 6]) {
    rig.update({ action: 'walk', time })
    for (const side of ['left', 'right']) {
      const forearm = rig.group.getObjectByName(`${side}-forearm`)
      const hand = new Vector3(0, forearm.scale.y / 2, 0).applyQuaternion(forearm.quaternion).add(forearm.position)
      const foot = rig.group.getObjectByName(`${side}-shoe`).position
      assert.ok((hand.z - .3) * (foot.z - .18) < 0, `${side} hand and foot must oppose`)
    }
  }
})

test('walking carries an upright cup in the hand without pouring or losing the drink color', t => {
  const { rig, office } = character(t)
  const cup = rig.group.getObjectByName('cup'), pouring = rig.group.getObjectByName('drink-pour')
  const liquid = rig.group.getObjectByName('drink-liquid')
  for (const drink of ['water', 'coffee']) {
    let carried
    for (const time of [Math.PI / 18, Math.PI / 6]) {
      rig.update({ action: 'walk', drink, filled: true, time })
      assert.equal(cup.visible, true)
      assert.equal(pouring.visible, false)
      assert.equal(cup.rotation.x, 0)
      const forearm = rig.group.getObjectByName('right-forearm')
      const hand = new Vector3(0, forearm.scale.y / 2, 0).applyQuaternion(forearm.quaternion).add(forearm.position)
      assert.ok(cup.position.distanceTo(hand) < .11)
      if (carried) assert.ok(cup.position.distanceTo(carried) < .00001, 'holding hand must not swing the cup')
      carried = cup.position.clone()
      assert.equal(liquid.material, office.materials[drink === 'water' ? 'screenLine' : 'brown'])
    }
    rig.update({ action: drink, time: 1 })
    assert.equal(pouring.visible, true)
    rig.update({ action: 'walk', drink, filled: false, time: 0 })
    assert.equal(cup.visible, true)
    assert.equal(liquid.visible, false)
    assert.equal(pouring.visible, false)
    rig.update({ action: 'type', drink, filled: true, time: 3 })
    assert.equal(cup.visible, false)
  }
})
