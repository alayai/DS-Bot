import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMonitorStore } from '../src/client/store.js'

const snapshot = { version: 2, capturedAt: 1, entities: [], sessions: [], runs: [], groups: [] }
const flush = () => new Promise(resolve => setImmediate(resolve))

test('store keeps last known data on disconnect, clears it on auth loss, and recovers', async () => {
  let mode = 'ok'
  const store = createMonitorStore(async () => {
    if (mode !== 'ok') throw new Error(mode)
    return snapshot
  })
  const stop = store.start()
  try {
    await flush()
    assert.equal(store.getSnapshot().phase, 'live')
    mode = 'unavailable'
    await store.refresh()
    assert.equal(store.getSnapshot().phase, 'stale')
    assert.equal(store.getSnapshot().data, snapshot)
    mode = 'unauthorized'
    await store.refresh()
    assert.equal(store.getSnapshot().data, null)
    mode = 'ok'
    await store.refresh()
    assert.equal(store.getSnapshot().phase, 'live')
  } finally { stop() }
})

test('store never overlaps pulls or accepts a disposed request after reopening', async () => {
  const pending = []
  const store = createMonitorStore(signal => new Promise(resolve => pending.push({ signal, resolve })))
  let stop = store.start()
  await store.refresh()
  assert.equal(pending.length, 1)
  stop()
  assert.equal(pending[0].signal.aborted, true)
  stop = store.start()
  assert.equal(pending.length, 2)
  pending[1].resolve({ ...snapshot, capturedAt: 2 })
  await flush()
  pending[0].resolve(snapshot)
  await flush()
  assert.equal(store.getSnapshot().data.capturedAt, 2)
  stop()
})

test('unmount clears request timers even when a transport ignores cancellation', () => {
  const timers = new Set()
  const environment = {
    setTimeout(callback) { timers.add(callback); return callback },
    clearTimeout(callback) { timers.delete(callback) },
  }
  let signal
  const store = createMonitorStore(nextSignal => {
    signal = nextSignal
    return new Promise(() => {})
  }, environment)
  const stop = store.start()
  assert.equal(timers.size, 1)
  stop()
  assert.equal(signal.aborted, true)
  assert.equal(timers.size, 0)
})
