import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrangeLabels } from '../src/client/labels.js'

const label = (id, overrides = {}) => ({
  id, x: 200, y: 160, width: 100, height: 40, inView: true, priority: 10, ...overrides,
})

test('collisions prefer rooms and active work, retain stable input order, and leave separated labels visible', () => {
  const input = [label('idle'), label('work', { priority: 20 }), label('room', { priority: 40 }), label('other', { x: 400 })]
  const result = arrangeLabels(input, 600, 400)
  assert.deepEqual(result.map(item => item.id), input.map(item => item.id))
  assert.deepEqual(result.map(item => item.hidden), [true, true, false, false])
  assert.deepEqual(arrangeLabels(input, 600, 400), result)
  assert.equal(arrangeLabels(input.slice(0, 2), 600, 400)[1].hidden, false)
})

test('keyboard focus reveals offscreen or crowded labels within safe bounds', () => {
  const items = [
    label('room', { priority: 40, x: -20, y: -20 }),
    label('focused', { focused: true, priority: 1000, x: -20, y: -20, inView: false }),
    label('offscreen', { x: 2000, y: 2000, inView: false }),
  ]
  const result = arrangeLabels(items, 390, 360)
  assert.deepEqual(result.map(item => item.hidden), [true, false, true])
  for (const item of result) {
    assert.ok(item.left >= 8 && item.left + item.width <= 382)
    assert.ok(item.top >= 64 && item.top + item.height <= 296)
  }
  assert.equal(arrangeLabels([label('wide', { width: 600 })], 390, 360)[0].width, 374)
})
