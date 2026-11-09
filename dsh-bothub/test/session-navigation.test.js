import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionNavigation } from '../src/client/session-navigation.js'
import { clock, flush } from './helpers/clock.js'

function fixture(ids = []) {
  const time = clock(), listeners = new Set(), opened = []
  let byId = Object.fromEntries(ids.map(id => [id, { id }])), refreshes = 0
  const sessions = {
    list: {
      getSnapshot: () => ({ byId }),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    },
    async refresh() { refreshes++ },
  }
  const update = (id, main = false) => {
    byId = Object.fromEntries(Object.entries(byId).map(([key, value]) => [key, { ...value, retainedBy: {} }]))
    byId[id] = { id, ...(main ? { retainedBy: { mainView: 1 } } : {}) }
    for (const fn of listeners) fn()
  }
  const navigation = createSessionNavigation(sessions, target => { opened.push(target); update(typeof target === 'string' ? target : target.childSessionId, true) }, time.environment)
  return { time, listeners, opened, sessions, navigation, update, refreshes: () => refreshes }
}

test('known sessions and durable child addresses open without a list refresh', async () => {
  const { navigation, opened, refreshes, listeners, time } = fixture(['known'])
  assert.equal(await navigation.open(() => 'known'), true)
  const child = { parentSessionId: 'known', childSessionId: 'child', mode: 'local' }
  assert.equal(await navigation.open(() => child), true)
  assert.deepEqual(opened, ['known', child])
  assert.equal(refreshes(), 0)
  assert.equal(listeners.size, 0)
  assert.equal(time.timers.size, 0)
})

test('a newly resolved session waits for the independent client list', async () => {
  const { navigation, opened, refreshes, update, listeners, time } = fixture()
  const pending = navigation.open(() => 'new-segment')
  await flush()
  assert.deepEqual(opened, [])
  assert.equal(refreshes(), 1)
  update('unrelated')
  assert.deepEqual(opened, [])
  update('new-segment')
  assert.equal(await pending, true)
  update('new-segment')
  assert.deepEqual(opened, ['new-segment'])
  assert.equal(listeners.size, 0)
  assert.equal(time.timers.size, 0)
})

test('a newer navigation cancels both a list wait and a late Host resolve', async () => {
  const { navigation, opened, update, time } = fixture(['known'])
  const first = navigation.open(() => 'not-listed')
  await flush()
  let release
  const second = navigation.open(() => new Promise(resolve => { release = resolve }))
  await flush()
  assert.equal(await first, false)
  await navigation.open(() => 'known')
  assert.equal(await second, false)
  release('late')
  update('not-listed'); update('late')
  await flush()
  assert.deepEqual(opened, ['known'])
  assert.equal(time.timers.size, 0)
})

test('navigation elsewhere cancels the wait even while Host resolution is pending', async () => {
  const { navigation, opened, update, listeners, time } = fixture()
  let release
  const pending = navigation.open(() => new Promise(resolve => { release = resolve }))
  await flush()
  update('elsewhere', true)
  assert.equal(await pending, false)
  release('new-segment')
  update('new-segment')
  await flush()
  assert.deepEqual(opened, [])
  assert.equal(listeners.size, 0)
  assert.equal(time.timers.size, 0)
})

test('a missing target times out and disposal prevents late navigation', async () => {
  const { navigation, opened, update, listeners, time } = fixture()
  const pending = navigation.open(() => 'missing')
  const failed = assert.rejects(pending, /unavailable/)
  await time.advance(10000)
  await failed
  assert.equal(listeners.size, 0)
  const next = navigation.open(() => 'late')
  await flush()
  navigation.dispose()
  assert.equal(await next, false)
  update('late')
  assert.equal(await navigation.open(() => 'late'), false)
  assert.deepEqual(opened, [])
  assert.equal(listeners.size, 0)
  assert.equal(time.timers.size, 0)
})

test('resolve, refresh and opening failures propagate and release the wait', async () => {
  const { navigation, sessions, listeners, time } = fixture()
  await assert.rejects(navigation.open(() => { throw Error('resolve failed') }), /resolve failed/)
  sessions.refresh = async () => { throw Error('refresh failed') }
  await assert.rejects(navigation.open(() => 'missing'), /refresh failed/)
  const broken = createSessionNavigation(sessions, () => { throw Error('open failed') }, time.environment)
  await assert.rejects(broken.open(() => ({ childSessionId: 'child' })), /open failed/)
  assert.equal(listeners.size, 0)
  assert.equal(time.timers.size, 0)
})
