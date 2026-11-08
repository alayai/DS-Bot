import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coordinateMonitorStream } from '../src/client/monitor-connection.js'
import { flush } from './helpers/clock.js'

function lockManager() {
  const held = new Set()
  return { held, async request(name, options, callback) {
    assert.deepEqual(options, { ifAvailable: true })
    if (held.has(name)) return callback(null)
    held.add(name)
    try { return await callback({ name }) } finally { held.delete(name) }
  } }
}

test('only one monitor stream per API path opens; followers use their own polling transport', async () => {
  const locks = lockManager(), calls = [], first = new AbortController()
  const stream = coordinateMonitorStream((signal, cursor) => {
    calls.push(cursor)
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, { locks })
  const active = stream(first.signal, 'epoch:1', () => {})
  const ended = assert.rejects(active, { name: 'AbortError' })
  await flush()
  await assert.rejects(stream(new AbortController().signal, 'epoch:2', () => {}), /stream-occupied/)
  assert.deepEqual(calls, ['epoch:1'])
  first.abort()
  await ended
  assert.equal(locks.held.size, 0)
  const next = new AbortController()
  const replacement = stream(next.signal, 'epoch:3', () => {})
  const stopped = assert.rejects(replacement, { name: 'AbortError' })
  await flush(); next.abort(); await stopped
  assert.deepEqual(calls, ['epoch:1', 'epoch:3'])
})

test('cancel releases the stream slot and suppresses late frames even if a transport ignores abort', async () => {
  const locks = lockManager(), controller = new AbortController(), frames = []
  let emit
  const stream = coordinateMonitorStream((_signal, _cursor, receive) => {
    emit = receive
    return new Promise(() => {})
  }, { locks })
  const active = stream(controller.signal, undefined, (...args) => frames.push(args))
  const stopped = assert.rejects(active, { name: 'AbortError' })
  await flush(); controller.abort(); await stopped
  emit('snapshot', { private: true })
  assert.deepEqual(frames, [])
  assert.equal(locks.held.size, 0)
})

test('unavailable lock support uses polling, while stream authentication errors remain authoritative', async () => {
  const signal = new AbortController().signal
  for (const locks of [null, { request() { throw Object.assign(new Error('policy'), { name: 'SecurityError' }) } }]) {
    const stream = coordinateMonitorStream(() => assert.fail('cannot open a new stream'), { locks })
    await assert.rejects(stream(signal), /stream-occupied/)
  }
  const locks = lockManager()
  const stream = coordinateMonitorStream(async () => { throw new Error('unauthorized') }, { locks })
  await assert.rejects(stream(signal), /unauthorized/)
  assert.equal(locks.held.size, 0)
})

test('separate host paths are independent and already-cancelled subscriptions never acquire a slot', async () => {
  const locks = lockManager(), controller = new AbortController()
  const work = () => new Promise(() => {})
  const first = coordinateMonitorStream(work, { locks, path: '/a/api/bothub/events' })
  const second = coordinateMonitorStream(work, { locks, path: '/b/api/bothub/events' })
  const a = assert.rejects(first(controller.signal), { name: 'AbortError' })
  const b = assert.rejects(second(controller.signal), { name: 'AbortError' })
  await flush()
  assert.equal(locks.held.size, 2)
  controller.abort()
  await Promise.all([a, b])
  await assert.rejects(first(controller.signal), { name: 'AbortError' })
  assert.equal(locks.held.size, 0)
})
