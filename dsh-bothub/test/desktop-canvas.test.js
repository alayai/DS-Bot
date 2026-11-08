import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDesktopCanvas } from '../src/client/desktop-canvas.js'

const frame = { width: 960, height: 540, data: 'test' }
function harness() {
  const images = [], draws = []
  class TestImage {
    naturalWidth = 960
    naturalHeight = 540
    constructor() { images.push(this) }
    decode() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject }) }
  }
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage: (...args) => draws.push(args) }) }
  return { canvas, images, draws, surface: createDesktopCanvas(canvas, TestImage), controller: new AbortController() }
}

test('viewer preserves original image dimensions and releases decoded sources', async () => {
  const h = harness(), paint = h.surface.paint(frame, h.controller.signal)
  h.images[0].resolve()
  assert.equal(await paint, true)
  assert.deepEqual([h.canvas.width, h.canvas.height], [960, 540])
  assert.equal(h.draws.length, 1)
  assert.equal(h.images[0].src, '')
  h.surface.dispose()
  assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1])
})

for (const reason of ['clear', 'dispose', 'abort']) {
  test(`viewer rejects a late decode after ${reason}`, async () => {
    const h = harness(), paint = h.surface.paint(frame, h.controller.signal)
    if (reason === 'abort') h.controller.abort()
    else h.surface[reason]()
    assert.equal(h.images[0].src, '')
    h.images[0].resolve()
    assert.equal(await paint, false)
    assert.equal(h.draws.length, 0)
    assert.deepEqual([h.canvas.width, h.canvas.height], [1, 1])
  })
}

test('a previous desktop decode cannot overwrite a fresh desktop after clear', async () => {
  const h = harness(), old = h.surface.paint(frame, h.controller.signal)
  h.surface.clear()
  const fresh = h.surface.paint(frame, h.controller.signal)
  h.images[1].resolve()
  assert.equal(await fresh, true)
  h.images[0].resolve()
  assert.equal(await old, false)
  assert.equal(h.draws.length, 1)
  assert.equal(h.draws[0][0], h.images[1])
})

test('viewer rejects mismatched PNG dimensions and releases failed decodes', async () => {
  const h = harness(), paint = h.surface.paint({ ...frame, width: 12 }, h.controller.signal)
  h.images[0].resolve()
  await assert.rejects(paint, /Desktop size changed/)
  assert.equal(h.images[0].src, '')
  const failed = h.surface.paint(frame, h.controller.signal)
  h.images[1].reject(new Error('Invalid PNG'))
  await assert.rejects(failed, /Invalid PNG/)
  assert.equal(h.images[1].src, '')
  assert.equal(h.draws.length, 0)
})
