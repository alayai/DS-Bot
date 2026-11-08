import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeQuality, qualitySettings, readQuality, saveQuality } from '../src/client/scene-settings.js'

test('invalid or unavailable preferences use balanced quality without blocking the view', () => {
  for (const value of [null, '', 'ultra', '__proto__', 'toString']) {
    assert.equal(normalizeQuality(value), 'balanced')
    assert.equal(readQuality({ getItem: () => value }), 'balanced')
  }
  const blocked = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') } }
  assert.equal(readQuality(blocked), 'balanced')
  assert.doesNotThrow(() => saveQuality('high', blocked))
  let stored
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value } }
  saveQuality('low', storage)
  assert.equal(readQuality(storage), 'low')
  saveQuality('corrupt', storage)
  assert.equal(readQuality(storage), 'balanced')
})

test('eco disables shadows; balanced and detailed bound pixel and shadow costs', () => {
  assert.equal(qualitySettings('low').shadow, 0)
  const balanced = qualitySettings('balanced'), high = qualitySettings('high')
  assert.ok(balanced.ratio < high.ratio && high.ratio <= 1.5)
  assert.ok(balanced.shadow < high.shadow && high.shadow <= 2048)
})
