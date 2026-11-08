import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFrame, parseEventBlock, readMonitorStream } from '../src/client/stream.js'
import { diffSnapshot } from '../src/shared/sync.js'
import { createMonitorStore } from '../src/client/store.js'
import { clock, flush } from './helpers/clock.js'

const snapshot = () => ({ version: 2, workspaceId: 'team', readOnly: false, capturedAt: 1,
  entities: [{ id: 'b', name: 'Builder' }], sessions: [], runs: [], groups: [] })
const frame = (seq = 0, epoch = 'epoch') => ({ schemaVersion: 1, scopeKey: epoch, epoch, seq })
const initial = () => ({ ...frame(), snapshot: snapshot() })

test('projection applies atomic additions/removals, ignores duplicate updates and rejects gaps or wrong scope', () => {
  const first = initial()
  let state = applyFrame(undefined, 'snapshot', first)
  const next = { ...snapshot(), capturedAt: 2, entities: [{ id: 'c', name: 'New' }], runs: [{ id: 'r' }] }
  const patch = { ...frame(1), ...diffSnapshot(first.snapshot, next) }
  state = applyFrame(state, 'patch', patch)
  assert.deepEqual(state.data, next)
  assert.equal(applyFrame(state, 'patch', patch), state)
  assert.throws(() => applyFrame(state, 'patch', { ...patch, seq: 3 }), /resync-required/)
  assert.throws(() => applyFrame(state, 'patch', { ...patch, epoch: 'other' }), /resync-required/)
  assert.throws(() => applyFrame(state, 'ready', { ...frame(2), capturedAt: 3 }), /resync-required/)
  assert.throws(() => applyFrame(state, 'patch', { ...patch, seq: 2, meta: { ...patch.meta, workspaceId: 'other' } }), /resync-required/)
  assert.throws(() => applyFrame(undefined, 'snapshot', { ...first, snapshot: { ...first.snapshot, entities: [{ id: 'b' }, { id: 'b' }] } }), /resync-required/)
  const replaced = applyFrame(state, 'snapshot', { ...frame(0, 'new'), snapshot: { ...snapshot(), entities: [] } })
  assert.deepEqual(replaced.data.entities, [])
})

test('SSE parser handles fragmented Unicode and CRLF, uses cookie auth and cancels its reader', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: snapshot\r\ndata: {"name":"设计组"}\r\n\r\n')
  const frames = []
  let options
  await assert.rejects(readMonitorStream(new AbortController().signal, 'epoch:3', (type, data) => frames.push({ type, data }),
    async (_url, value) => {
      options = value
      return new Response(new ReadableStream({
        start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }), /unavailable/)
  assert.deepEqual(frames, [{ type: 'snapshot', data: { name: '设计组' } }])
  assert.equal(options.credentials, 'same-origin')
  assert.equal(options.headers['last-event-id'], 'epoch:3')
  assert.equal(parseEventBlock(': keepalive'), null)
  assert.throws(() => parseEventBlock('data: {broken}'), /resync-required/)
  const controller = new AbortController()
  let cancelled = false
  const reading = readMonitorStream(controller.signal, undefined, () => {}, async () => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  await flush(); controller.abort()
  await assert.rejects(reading, /unavailable/)
  assert.equal(cancelled, true)
})

test('stream authentication and unsupported responses are distinct and malformed buffers are bounded', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'stream-unavailable'], [409, 'incompatible']]) {
    await assert.rejects(readMonitorStream(new AbortController().signal, undefined, () => {},
      async () => new Response('', { status })), new RegExp(expected))
  }
  await assert.rejects(readMonitorStream(new AbortController().signal, undefined, () => {},
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/event-stream' } })), /resync-required/)
})

function storeFixture() {
  const time = clock(), connections = [], listeners = new Map()
  time.environment.document = {
    hidden: false, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  }
  time.environment.addEventListener = (name, fn) => listeners.set(name, fn)
  time.environment.removeEventListener = name => listeners.delete(name)
  let reads = 0
  const store = createMonitorStore(async () => { reads++; return snapshot() }, time.environment,
    (signal, cursor, receive) => new Promise((resolve, reject) => connections.push({
      signal, cursor, receive(type, data) { try { receive(type, data) } catch (error) { reject(error) } }, resolve, reject,
    })))
  return { store, time, connections, listeners, get reads() { return reads } }
}
function ready(connection, baseline = initial()) {
  connection.receive('snapshot', baseline)
  connection.receive('ready', { ...baseline, capturedAt: baseline.snapshot.capturedAt })
}

test('store disables stale actions, resumes only after a ready watermark and excludes late generations', async () => {
  const f = storeFixture(), stop = f.store.start()
  try {
    ready(f.connections[0]); assert.equal(f.store.getSnapshot().phase, 'live')
    f.connections[0].reject(new Error('unavailable')); await flush()
    assert.equal(f.store.getSnapshot().phase, 'stale')
    await f.time.advance(500)
    assert.equal(f.connections[1].cursor, 'epoch:0')
    const next = { ...snapshot(), capturedAt: 2, runs: [{ id: 'next' }] }
    f.connections[1].receive('patch', { ...frame(1), ...diffSnapshot(snapshot(), next) })
    assert.equal(f.store.getSnapshot().phase, 'stale')
    f.connections[1].receive('ready', { ...frame(1), capturedAt: 2 })
    assert.equal(f.store.getSnapshot().data.runs[0].id, 'next')
    f.connections[0].receive('snapshot', initial())
    assert.equal(f.store.getSnapshot().data.runs[0].id, 'next')
    f.time.environment.document.hidden = true; f.listeners.get('visibilitychange')()
    assert.equal(f.connections[1].signal.aborted, true)
    assert.equal(f.time.timers.size, 0)
    f.time.environment.document.hidden = false; f.listeners.get('visibilitychange')()
    assert.equal(f.connections[2].cursor, 'epoch:1')
  } finally { stop() }
  assert.equal(f.time.timers.size, 0); assert.equal(f.listeners.size, 0)
})

test('unsupported SSE falls back visibly and periodically probes streaming again', async () => {
  const f = storeFixture(), stop = f.store.start()
  try {
    f.connections[0].reject(new Error('stream-unavailable')); await flush()
    await f.time.advance(500)
    assert.equal(f.store.getSnapshot().transport, 'poll')
    assert.equal(f.store.getSnapshot().phase, 'live')
    await f.time.advance(12 * 2500)
    assert.equal(f.reads, 12)
    assert.equal(f.connections.length, 2)
    assert.equal(f.connections[1].cursor, undefined)
    ready(f.connections[1])
    assert.equal(f.store.getSnapshot().transport, 'stream')
  } finally { stop() }
})

test('authentication clears data and waits for explicit refresh; hung transports cannot retain timers', async () => {
  const f = storeFixture(), stop = f.store.start()
  ready(f.connections[0])
  f.connections[0].reject(new Error('unauthorized')); await flush()
  assert.equal(f.store.getSnapshot().data, null)
  assert.equal(f.time.timers.size, 0)
  f.listeners.get('visibilitychange')(); await f.time.advance(60000)
  assert.equal(f.connections.length, 1)
  void f.store.refresh()
  assert.equal(f.connections.length, 2)
  await f.time.advance(10000)
  assert.equal(f.connections[1].signal.aborted, true)
  assert.equal(f.store.getSnapshot().phase, 'stale')
  stop()
  assert.equal(f.time.timers.size, 0)
})

test('scope change clears old rows before enabling current capabilities', () => {
  const f = storeFixture(), stop = f.store.start()
  try {
    ready(f.connections[0])
    const replacement = { ...frame(0, 'new'), snapshot: { ...snapshot(), workspaceId: 'other', readOnly: true, entities: [] } }
    f.connections[0].receive('snapshot', replacement)
    assert.equal(f.store.getSnapshot().data, null)
    assert.equal(f.store.getSnapshot().phase, 'loading')
    f.connections[0].receive('ready', { ...replacement, capturedAt: 2 })
    assert.equal(f.store.getSnapshot().data.readOnly, true)
    assert.deepEqual(f.store.getSnapshot().data.entities, [])
  } finally { stop() }
})

test('a sequence gap abandons the cursor and a silent stream times out without accepting late frames', async () => {
  const f = storeFixture(), stop = f.store.start()
  try {
    ready(f.connections[0])
    f.connections[0].receive('patch', { ...frame(2), ...diffSnapshot(snapshot(), snapshot()) })
    await flush()
    assert.equal(f.store.getSnapshot().phase, 'stale')
    await f.time.advance(500)
    assert.equal(f.connections[1].cursor, undefined)
    ready(f.connections[1])
    await f.time.advance(35000)
    assert.equal(f.store.getSnapshot().phase, 'stale')
    assert.equal(f.connections[1].signal.aborted, true)
    f.connections[1].receive('snapshot', { ...frame(0, 'late'), snapshot: { ...snapshot(), workspaceId: 'wrong' } })
    assert.equal(f.store.getSnapshot().data.workspaceId, 'team')
  } finally { stop() }
})

test('offline suspends retries and online reconnects with the last applied cursor', async () => {
  const f = storeFixture(), stop = f.store.start()
  try {
    ready(f.connections[0])
    f.time.environment.navigator = { onLine: false }
    f.listeners.get('offline')()
    assert.equal(f.store.getSnapshot().phase, 'stale')
    assert.equal(f.connections[0].signal.aborted, true)
    await f.time.advance(60000)
    assert.equal(f.connections.length, 1)
    assert.equal(f.time.timers.size, 0)
    f.time.environment.navigator.onLine = true
    f.listeners.get('online')()
    assert.equal(f.connections[1].cursor, 'epoch:0')
    ready(f.connections[1])
    assert.equal(f.store.getSnapshot().phase, 'live')
  } finally { stop() }
})
