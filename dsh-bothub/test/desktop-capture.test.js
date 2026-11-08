import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { coordinateDesktopRequest } from '../src/client/desktop-capture.js'

function harness() {
  let time = 0, serial = 0
  const jobs = new Map(), queues = new Map(), held = new Set()
  const drain = name => {
    if (held.has(name)) return
    const entry = queues.get(name)?.shift()
    if (!entry) { queues.delete(name); return }
    entry.signal.removeEventListener('abort', entry.abort)
    held.add(name)
    Promise.resolve().then(entry.callback).then(entry.resolve, entry.reject).finally(() => {
      held.delete(name); drain(name)
    })
  }
  const locks = { request(name, { signal }, callback) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const queue = queues.get(name) ?? []
      const entry = { signal, callback, resolve, reject, abort() {
        queue.splice(queue.indexOf(entry), 1)
        reject(signal.reason)
      } }
      queue.push(entry); queues.set(name, queue)
      signal.addEventListener('abort', entry.abort, { once: true })
      drain(name)
    })
  } }
  const options = {
    locks, path: '/api/bot', now: () => time,
    schedule(fn, ms) { const id = ++serial; jobs.set(id, { fn, at: time + ms }); return id },
    cancel: id => jobs.delete(id),
  }
  return { options, jobs, held, queues, now: () => time, async advance(ms = 0) {
    await setImmediate()
    const end = time + ms
    for (;;) {
      const next = [...jobs].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      time = next[1].at; jobs.delete(next[0]); next[1].fn()
      await setImmediate()
    }
    time = end
    await setImmediate()
  } }
}
const capture = (request, signal, botId = 'a') => request('preview', { botId, passive: true }, signal)

test('separate windows share same-Bot capture slots and present the image before cooldown ends', async () => {
  const h = harness(), calls = [], a = new AbortController(), b = new AbortController()
  const request = async () => { calls.push(h.now()); return 'pixels' }
  const first = capture(coordinateDesktopRequest(request, h.options), a.signal)
  const second = capture(coordinateDesktopRequest(request, h.options), b.signal)
  await h.advance()
  assert.equal(await first, 'pixels')
  assert.deepEqual(calls, [0])
  await h.advance(999)
  assert.deepEqual(calls, [0])
  await h.advance(1)
  assert.equal(await second, 'pixels')
  assert.deepEqual(calls, [0, 1000])
  b.abort(); await h.advance()
  assert.equal(h.jobs.size + h.held.size + h.queues.size, 0)
})

test('different Bots and different API paths do not block one another', async () => {
  const h = harness(), controller = new AbortController(), calls = []
  const call = async (_, payload) => { calls.push(payload.botId); return true }
  const first = coordinateDesktopRequest(call, h.options)
  const otherPath = coordinateDesktopRequest(call, { ...h.options, path: '/second/api/bot' })
  await Promise.all([capture(first, controller.signal), capture(first, controller.signal, 'b'), capture(otherPath, controller.signal)])
  assert.deepEqual(calls, ['a', 'b', 'a'])
  assert.equal(h.held.size, 3)
  controller.abort(); await h.advance()
  assert.equal(h.jobs.size + h.held.size + h.queues.size, 0)
})

test('cancelled queued captures never run and cancelling cooldown releases the next window immediately', async () => {
  const h = harness(), controllers = Array.from({ length: 3 }, () => new AbortController()), calls = []
  const request = coordinateDesktopRequest(async () => { calls.push(h.now()); return true }, h.options)
  await capture(request, controllers[0].signal)
  const queued = capture(request, controllers[1].signal)
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  const third = capture(request, controllers[2].signal)
  await h.advance()
  controllers[1].abort()
  await rejected
  controllers[0].abort()
  await h.advance()
  await third
  assert.deepEqual(calls, [0, 0])
  controllers[2].abort(); await h.advance()
  assert.equal(h.jobs.size + h.held.size + h.queues.size, 0)
})

test('abort rejects an in-flight capture and a late result cannot replace the rejection', async () => {
  const h = harness(), controller = new AbortController()
  let finish
  const request = coordinateDesktopRequest(() => new Promise(resolve => { finish = resolve }), h.options)
  const result = capture(request, controller.signal)
  const rejected = assert.rejects(result, { name: 'AbortError' })
  await h.advance()
  controller.abort()
  await rejected
  finish('late pixels')
  await h.advance()
  assert.equal(h.jobs.size + h.held.size + h.queues.size, 0)
})

test('unsupported storage policy falls back once, but capture errors are never retried by the coordinator', async () => {
  for (const name of ['SecurityError', 'NotSupportedError']) {
    let calls = 0
    const request = coordinateDesktopRequest(async () => ++calls, {
      locks: { request() { throw Object.assign(new Error('policy'), { name }) } },
    })
    assert.equal(await capture(request, new AbortController().signal), 1)
    assert.equal(calls, 1)
  }
  const h = harness(), controller = new AbortController()
  let calls = 0
  const request = coordinateDesktopRequest(async () => { calls++; throw Object.assign(new Error('capture'), { name: 'SecurityError' }) }, h.options)
  await assert.rejects(capture(request, controller.signal), /capture/)
  assert.equal(calls, 1)
  controller.abort(); await h.advance()
  assert.equal(h.jobs.size + h.held.size + h.queues.size, 0)
})

test('missing locks and non-passive endpoints preserve the existing request contract', async () => {
  const calls = []
  const original = async (...args) => { calls.push(args); return 'result' }
  const signal = new AbortController().signal
  const plain = coordinateDesktopRequest(original, { locks: null })
  assert.equal(await capture(plain, signal), 'result')
  const guarded = coordinateDesktopRequest(original, { locks: { request() { assert.fail('not a passive screenshot') } } })
  await guarded('state', null, signal)
  await guarded('preview', { botId: 'a' }, signal)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(args => args[2] === signal))
})

test('one virtual hour of alternating windows leaves bounded timers and no held locks after shutdown', async () => {
  const h = harness(), controller = new AbortController()
  let calls = 0
  const windows = Array.from({ length: 3 }, () => coordinateDesktopRequest(async () => ++calls, h.options))
  for (let i = 0; i < 3600; i++) {
    const result = capture(windows[i % 3], controller.signal)
    await h.advance(i ? 1000 : 0)
    assert.equal(await result, i + 1)
    assert.equal(h.jobs.size, 1)
    assert.equal(h.held.size, 1)
  }
  controller.abort(); await h.advance()
  assert.equal(calls, 3600)
  assert.equal(h.jobs.size + h.held.size + h.queues.size, 0)
})
