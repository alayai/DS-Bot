import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CapsuleGeometry, CylinderGeometry, MeshStandardMaterial, SphereGeometry } from 'three'
import { createCharacter } from '../src/client/character.js'
import { createOfficeAssets } from '../src/client/furniture.js'

test('articulated poses and props reuse assets and maintain finite transforms through rapid changes', () => {
  const office = createOfficeAssets()
  const geometry = { body: new CapsuleGeometry(.21, .22), head: new SphereGeometry(.26),
    eye: new SphereGeometry(.035), limb: new CylinderGeometry(1, 1, 1) }
  const material = new MeshStandardMaterial()
  const rig = createCharacter(geometry, material, material, office)
  const objects = []
  rig.group.traverse(child => objects.push(child))
  try {
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
  } finally {
    office.dispose(); material.dispose()
    Object.values(geometry).forEach(g => g.dispose())
  }
})
