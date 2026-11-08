import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMonitorFeed } from '../src/host/stream.js'
import { clock, flush } from './helpers/clock.js'

const base = () => ({ version: 2, workspaceId: 'team', readOnly: false, capturedAt: 1,
  entities: [{ id: 'bot', name: 'Builder' }], sessions: [], runs: [], groups: [] })
const request = (cursor, signal) => new Request('http://localhost/api/bothub/events', {
  headers: cursor ? { 'last-event-id': cursor } : {}, signal,
})
async function event(reader) {
  const { value, done } = await reader.read()
  if (done) return null
  const text = new TextDecoder().decode(value)
  return { type: /event: (.+)/.exec(text)[1], ...JSON.parse(/data: (.+)/.exec(text)[1]) }
}
function fixture(limits) {
  const time = clock()
  let data = base(), reads = 0
  let service = { version: 2, async snapshot() { reads++; return structuredClone(data) } }
  const feed = createMonitorFeed(() => service, time.environment, limits)
  return { feed, time, get reads() { return reads }, data: () => data, setData: next => { data = next },
    setService: next => { service = next } }
}

test('one serialized projection supplies baseline, patches and deletes to multiple subscribers', async t => {
  const f = fixture(); t.after(() => f.feed.dispose())
  const responses = await Promise.all([f.feed.open(request()), f.feed.open(request())])
  assert.equal(f.reads, 1)
  const readers = responses.map(response => response.body.getReader())
  for (const reader of readers) { assert.equal((await event(reader)).type, 'snapshot'); await event(reader) }
  f.data().runs.push({ id: 'run', sessionId: 's', entityId: 'bot' })
  f.data().sessions.push({ id: 's', entityId: 'bot', status: 'running' })
  f.data().capturedAt = 2
  for (let i = 0; i < 10000; i++) f.feed.invalidate()
  await f.time.advance(150)
  assert.equal(f.reads, 2)
  for (const reader of readers) {
    const patch = await event(reader)
    assert.equal(patch.seq, 1)
    assert.equal(patch.changes.runs.upsert[0].id, 'run')
    assert.deepEqual(patch.changes.entities.upsert, [])
  }
  f.data().runs = []
  f.feed.invalidate(); await f.time.advance(150)
  for (const reader of readers) assert.deepEqual((await event(reader)).changes.runs.remove, ['run'])
  for (const reader of readers) await reader.cancel()
  assert.equal(f.time.timers.size, 0)
  f.feed.invalidate(); await f.time.advance(60000)
  assert.equal(f.reads, 3)
})

test('reconnect replays a contiguous suffix; evicted or foreign cursors receive a fresh baseline', async t => {
  const f = fixture({ entries: 1 }); t.after(() => f.feed.dispose())
  const reader = (await f.feed.open(request())).body.getReader()
  const first = await event(reader); await event(reader)
  f.data().entities[0].name = 'Second'; f.feed.invalidate(); await f.time.advance(150)
  const patch1 = await event(reader)
  f.data().entities[0].name = 'Third'; f.feed.invalidate(); await f.time.advance(150)
  await event(reader)
  const resume = (await f.feed.open(request(`${first.epoch}:${patch1.seq}`))).body.getReader()
  const replay = await event(resume)
  assert.equal(replay.type, 'patch'); assert.equal(replay.seq, 2)
  assert.equal((await event(resume)).type, 'ready')
  await resume.cancel()
  for (const cursor of [`${first.epoch}:0`, 'foreign:2', `${first.epoch}:999`]) {
    const next = (await f.feed.open(request(cursor))).body.getReader()
    assert.equal((await event(next)).type, 'snapshot')
    await next.cancel()
  }
  await reader.cancel()
})

test('workspace, permission and bridge replacements reset epoch and discard old identities', async t => {
  const f = fixture(); t.after(() => f.feed.dispose())
  const reader = (await f.feed.open(request())).body.getReader()
  let previous = await event(reader); await event(reader)
  for (const change of [
    () => f.setData({ ...base(), workspaceId: 'other', entities: [] }),
    () => { f.data().readOnly = true },
    () => f.setService({ version: 2, snapshot: async () => f.data() }),
  ]) {
    change(); f.feed.invalidate(); await f.time.advance(150)
    const snapshot = await event(reader)
    assert.equal(snapshot.type, 'snapshot')
    assert.notEqual(snapshot.epoch, previous.epoch)
    assert.notEqual(snapshot.scopeKey, previous.scopeKey)
    assert.deepEqual(snapshot.snapshot.entities, [])
    assert.equal(snapshot.seq, 0)
    await event(reader); previous = snapshot
  }
  await reader.cancel()
})

test('slow readers, lease expiry, disconnect and disposal release all scheduled work', async () => {
  const f = fixture({ queueBytes: 900, leaseMs: 20000 })
  const response = await f.feed.open(request())
  f.data().entities[0].name = 'x'.repeat(2000)
  f.feed.invalidate(); await f.time.advance(150)
  assert.equal(f.time.timers.size, 0)
  await response.body.cancel()
  f.setData(base())
  const controller = new AbortController()
  const live = await f.feed.open(request(undefined, controller.signal))
  controller.abort(); assert.equal(f.time.timers.size, 0); await live.body.cancel()
  const leased = await f.feed.open(request())
  await f.time.advance(20000)
  assert.equal(f.time.timers.size, 0); await leased.body.cancel()
  const again = await f.feed.open(request())
  f.feed.dispose(); assert.equal(f.time.timers.size, 0)
  await again.body.cancel()
  assert.equal((await f.feed.open(request())).status, 503)
})

test('byte eviction, client cap, cross-site and service faults stay bounded and sanitized', async t => {
  const f = fixture({ bytes: 1, clients: 2 }); t.after(() => f.feed.dispose())
  const reader = (await f.feed.open(request())).body.getReader()
  const first = await event(reader); await event(reader)
  f.data().entities[0].name = 'Changed'; f.feed.invalidate(); await f.time.advance(150)
  await event(reader)
  const next = (await f.feed.open(request(`${first.epoch}:0`))).body.getReader()
  assert.equal((await event(next)).type, 'snapshot')
  assert.equal((await f.feed.open(request())).status, 429)
  assert.equal((await f.feed.open(new Request(request(), { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403)
  await next.cancel()
  f.setService(undefined); f.feed.invalidate(); await f.time.advance(150)
  assert.equal((await event(reader)).error, 'bridge-missing')
  assert.equal(await event(reader), null)
  assert.equal(f.time.timers.size, 0)
  f.setService({ version: 2, snapshot() { throw new Error('secret credentials') } })
  const failure = await f.feed.open(request())
  assert.deepEqual(await failure.json(), { error: 'unavailable' })
})

test('hung and disposed reads cannot publish late state or retain a timeout', async () => {
  const f = fixture()
  let release
  f.setService({ version: 2, snapshot: () => new Promise(resolve => { release = resolve }) })
  const pending = f.feed.open(request())
  await flush(); await f.time.advance(9000)
  assert.equal((await pending).status, 503)
  assert.equal(f.time.timers.size, 0)
  release(base()); await flush()
  const other = f.feed.open(request()); await flush()
  f.feed.dispose()
  assert.equal((await other).status, 503)
  assert.equal(f.time.timers.size, 0)
  release(base()); await flush()
})

test('a notification during collection triggers a follow-up instead of losing the final state', async t => {
  const f = fixture(); t.after(() => f.feed.dispose())
  let release, blocked = false
  f.setService({ version: 2, snapshot: () => {
    const copy = structuredClone(f.data())
    return blocked ? new Promise(resolve => { release = () => resolve(copy) }) : Promise.resolve(copy)
  } })
  const reader = (await f.feed.open(request())).body.getReader()
  await event(reader); await event(reader)
  blocked = true
  f.feed.invalidate(); await f.time.advance(150)
  f.data().runs = Array.from({ length: 100 }, (_, index) => ({ id: `r${index}`, entityId: 'bot' }))
  f.feed.invalidate(); await f.time.advance(150)
  blocked = false; release(); await flush()
  await f.time.advance(150)
  assert.equal((await event(reader)).changes.runs.upsert.length, 100)
  await reader.cancel()
})
