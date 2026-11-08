import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createDesktopPreview, desktopRequest, validDesktopFrame } from '../src/client/desktop-preview.js'
import { fitDesktop } from '../src/client/desktop-screens.js'

const frame = { width: 64, height: 48, data: 'iVBORw0KGgoTEST' }
const computer = (botId, fields) => ({ botId, id: `desktop-${botId}`, generation: 1, phase: 'ready', grant: 'observe', ...fields })
const problem = code => Object.assign(new Error('test'), { code: `bot/computer-${code}` })
function harness(request) {
  let time = 0, serial = 0
  const jobs = new Map(), events = []
  const client = createDesktopPreview({
    request, publish: (id, value) => events.push({ id, ...value }), now: () => time,
    schedule: (fn, ms) => { const id = ++serial; jobs.set(id, { fn, at: time + ms }); return id },
    cancel: id => jobs.delete(id),
  })
  return { client, events, jobs, async advance(ms = 0) {
    const until = time + ms
    for (;;) {
      const due = [...jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      time = due[1].at; jobs.delete(due[0]); due[1].fn()
      await setImmediate()
    }
    time = until
    await setImmediate()
  } }
}

test('one scheduler deduplicates desks, caps visible Bots and uses passive generation-bound previews', async () => {
  const calls = []
  const h = harness(async (method, payload) => {
    calls.push([method, payload])
    return method === 'state' ? { passivePreview: true, computers: ['a', 'b', 'c', 'd', 'e'].map(id => computer(id)) } : frame
  })
  try {
    h.client.targets(['a', 'a', 'b', 'c', 'd', 'e'])
    await h.advance()
    assert.equal(calls.filter(([m]) => m === 'state').length, 1)
    assert.deepEqual(calls.filter(([m]) => m === 'preview').map(([, p]) => p),
      ['a', 'b', 'c', 'd'].map(botId => ({ botId, expectedGeneration: 1, passive: true })))
    h.client.targets(['d', 'c', 'b', 'a'])
    await h.advance(999)
    assert.equal(calls.length, 5)
    await h.advance(1)
    assert.equal(calls.length, 9)
  } finally { h.client.dispose() }
  assert.equal(h.jobs.size, 0)
})

test('legacy, disabled, starting and stopped desktops never receive screenshot requests', async () => {
  for (const [state, expected] of [
    [{ computers: [computer('a')] }, 'unsupported'],
    [{ passivePreview: true, computers: [computer('a', { phase: 'starting' })] }, 'starting'],
    [{ passivePreview: true, computers: [computer('a', { phase: 'stopped' })] }, 'standby'],
    [{ passivePreview: true, computers: [computer('a', { grant: 'off' })] }, 'standby'],
    [{ passivePreview: true, computers: [computer('a')], recovery: { disconnected: true } }, 'unavailable'],
    [null, 'standby'],
  ]) {
    const h = harness(async method => {
      assert.equal(method, 'state')
      if (!state) throw problem('off')
      return state
    })
    try {
      h.client.targets(['a']); await h.advance()
      assert.equal(h.events.at(-1).status, expected)
      assert.equal(h.events.at(-1).clear, true)
    } finally { h.client.dispose() }
  }
})

test('screenshots are limited to two concurrent requests and leaving rejects late frames', async () => {
  const pending = [], signals = []
  const h = harness(async (method, _args, signal) => {
    if (method === 'state') return { passivePreview: true, computers: ['a', 'b', 'c', 'd'].map(id => computer(id)) }
    signals.push(signal)
    return new Promise(resolve => pending.push(resolve))
  })
  h.client.targets(['a', 'b', 'c', 'd']); await h.advance()
  assert.equal(pending.length, 2)
  h.client.targets([])
  assert.ok(signals.every(signal => signal.aborted))
  for (const resolve of pending) resolve(frame)
  await h.advance(10000)
  assert.equal(h.events.filter(event => event.frame).length, 0)
  assert.equal(h.jobs.size, 0)
  h.client.dispose()
})

test('busy retains a marked frame briefly then expires even if the next request hangs', async () => {
  let shots = 0, finish
  const h = harness(async method => {
    if (method === 'state') return { passivePreview: true, computers: [computer('a')] }
    if (++shots === 1) return frame
    if (shots === 2) throw problem('busy')
    return new Promise(resolve => { finish = resolve })
  })
  try {
    h.client.targets(['a']); await h.advance()
    await h.advance(1000)
    assert.equal(h.events.at(-1).status, 'waiting')
    assert.equal(h.events.at(-1).clear, false)
    await h.advance(4000)
    assert.equal(h.events.at(-1).clear, true)
    h.client.targets([])
    finish(frame)
    await h.advance()
    assert.equal(h.events.filter(event => event.frame).length, 1)
  } finally { h.client.dispose() }
})

test('rebinding clears the old frame before publishing the new desktop; stopped state clears it', async () => {
  let record = computer('a')
  const calls = []
  const h = harness(async (method, payload) => {
    if (method === 'state') return { passivePreview: true, computers: [record] }
    calls.push(payload)
    return frame
  })
  try {
    h.client.targets(['a']); await h.advance()
    record = computer('a', { id: 'replacement', generation: 2 })
    await h.advance(5000)
    assert.equal(calls.at(-1).expectedGeneration, 2)
    const lastFrame = h.events.findLastIndex(event => event.frame)
    assert.equal(h.events[lastFrame - 1].clear, true)
    record = { ...record, phase: 'stopped' }
    await h.advance(5000)
    assert.equal(h.events.at(-1).status, 'standby')
    assert.equal(h.events.at(-1).clear, true)
  } finally { h.client.dispose() }
})

test('authentication failure backs off and stale generation never retains old content', async () => {
  let fail, calls = 0
  const h = harness(async method => {
    calls++
    if (fail) throw fail
    return method === 'state' ? { passivePreview: true, computers: [computer('a')] } : frame
  })
  try {
    h.client.targets(['a']); await h.advance()
    fail = problem('stale-generation')
    await h.advance(1000)
    assert.equal(h.events.at(-1).clear, true)
    fail = Object.assign(new Error('denied'), { code: 'HTTP_401' })
    await h.advance(5000)
    const before = calls
    await h.advance(29000)
    assert.equal(calls, before)
  } finally { h.client.dispose() }
})

test('request uses only authenticated read endpoints with no-store and propagates refusal codes', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options])
    return { ok: true, json: async () => ({ ok: false, error: { code: 'bot/computer-busy' } }) }
  })
  await assert.rejects(desktopRequest('preview', { botId: 'a', passive: true }, new AbortController().signal),
    error => error.code === 'bot/computer-busy')
  assert.equal(calls[0][0], 'api/bot')
  assert.equal(calls[0][1].credentials, 'same-origin')
  assert.equal(calls[0][1].cache, 'no-store')
  assert.equal(JSON.parse(calls[0][1].body).endpoint, 'computer-preview')
})

test('frame limits reject unbounded input and fitting preserves landscape/portrait proportions', () => {
  assert.equal(validDesktopFrame(frame), true)
  for (const item of [{ ...frame, width: 0 }, { ...frame, width: 8193 }, { ...frame, width: 8192, height: 8192 },
    { ...frame, data: 'https://example.invalid/image.png' }, { ...frame, data: 'iVBORw0KGgo' + 'x'.repeat(12_000_000) }]) {
    assert.equal(validDesktopFrame(item), false)
  }
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1024, 768]]) {
    const box = fitDesktop(width, height)
    assert.ok(Math.abs(box.width / box.height - width / height) < 1e-9)
    assert.ok(box.x >= 0 && box.y >= 0 && box.width <= 512 && box.height <= 276)
  }
})
