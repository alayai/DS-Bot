import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMonitorStore, request } from '../src/client/store.js'

const snapshot = { version: 2, capturedAt: 1, entities: [], sessions: [], runs: [], groups: [] }
const flush = () => new Promise(resolve => setImmediate(resolve))

test('visible right-sidebar tabs share a monitor until the final lease leaves', () => {
  const signals = []
  const store = createMonitorStore(signal => {
    signals.push(signal)
    return new Promise(() => {})
  })
  const first = store.start(), second = store.start()
  assert.equal(signals.length, 1)
  first()
  first()
  assert.equal(signals[0].aborted, false)
  second()
  assert.equal(signals[0].aborted, true)
  const old = store.start()
  store.stop()
  const current = store.start()
  old()
  assert.equal(signals[2].aborted, false)
  current()
  assert.equal(signals[2].aborted, true)
})

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

test('known installation errors stay distinct without displaying untrusted server messages', async t => {
  let status = 503
  let body = { error: 'bridge-missing' }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }))
  await assert.rejects(request(), /^Error: bridge-missing$/)
  body = { error: 'private server details' }
  await assert.rejects(request(), /^Error: unavailable$/)
  status = 401
  await assert.rejects(request(), /^Error: unauthorized$/)
  status = 409
  await assert.rejects(request(), /^Error: incompatible$/)
  status = 404
  await assert.rejects(request(), /^Error: host-missing$/)
  await assert.rejects(request({ action: 'resolve', entityId: 'b' }), /^Error: not-found$/)
})

test('bridge removal clears stale room membership and reinstatement loads a fresh snapshot', async () => {
  let missing = false
  const store = createMonitorStore(async () => {
    if (missing) throw new Error('bridge-missing')
    return snapshot
  })
  const stop = store.start()
  try {
    await flush()
    missing = true
    await store.refresh()
    assert.equal(store.getSnapshot().data, null)
    assert.equal(store.getSnapshot().error, 'bridge-missing')
    missing = false
    await store.refresh()
    assert.equal(store.getSnapshot().phase, 'live')
  } finally { stop() }
})
