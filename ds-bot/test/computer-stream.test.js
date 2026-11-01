import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { viewerSocketUrl } from '../src/client/computer-channel.js'

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/computer-stream.js', import.meta.url))], bundle: true, write: false, format: 'cjs', external: ['react'] })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}), AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, Uint8Array, btoa, URL })
const { ComputerChannel } = module.exports
const tick = () => new Promise(resolve => setImmediate(resolve))

test('raw channel close notification is asynchronous like WebSocket', async () => {
  const channel = new ComputerChannel('a', 1, async () => new Response())
  let called = 0
  channel.onclose = () => called++
  channel.close()
  assert.equal(called, 0)
  channel.close()
  await tick()
  assert.equal(called, 1)
})

test('Desktop document URLs without an HTTP origin select Fetch without throwing', () => {
  for (const base of ['about:blank', 'file:///app/index.html', 'dsh://app/', 'dsh-app://app/', 'invalid']) {
    assert.equal(viewerSocketUrl('/api/ds-bot/computer-viewer/socket', base), null)
  }
  assert.equal(viewerSocketUrl('/api/ds-bot/computer-viewer/socket', 'dsh-app://app/', 'http://127.0.0.1:9230'), 'ws://127.0.0.1:9230/api/ds-bot/computer-viewer/socket')
  assert.equal(viewerSocketUrl('/unexpected/socket', 'https://fixture/'), null)
  assert.equal(viewerSocketUrl('/api/ds-bot/computer-viewer/socket', 'https://fixture/mount/'), 'wss://fixture/mount/api/ds-bot/computer-viewer/socket')
})

test('raw channel preserves fetch receiver, serializes uplink and closes abandoned reads', async () => {
  const calls = []
  let finishWrite
  const channel = new ComputerChannel('a', 7, async function (_url, options) {
    assert.equal(this, undefined)
    const args = JSON.parse(options.body)
    calls.push(args)
    if (args.operation === 'open') return Response.json({ id: 'fixture-id' })
    if (args.operation === 'read') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }))
    if (args.operation === 'write') return new Promise(resolve => { finishWrite = () => resolve(new Response()) })
    return new Response()
  })
  await new Promise(resolve => { channel.onopen = resolve })
  assert.equal(channel.readyState, 1)
  channel.send(Uint8Array.from([1, 2]))
  channel.send(Uint8Array.from([3]))
  assert.equal(calls.filter(call => call.operation === 'write').length, 1)
  finishWrite()
  await tick()
  const writes = calls.filter(call => call.operation === 'write')
  assert.deepEqual(writes.map(call => call.data), ['AQI=', 'Aw=='])
  finishWrite()
  await tick()
  channel.close()
  channel.close()
  await tick()
  assert.equal(channel.readyState, 3)
  assert.equal(calls.filter(call => call.operation === 'close').length, 1)
  assert.equal(calls[0].botId, 'a')
  assert.equal(calls[0].generation, 7)
  assert.ok(calls.every(call => !('controlToken' in call)))
})

test('raw channel rejects an oversized uplink without submitting it', async () => {
  const operations = []
  const channel = new ComputerChannel('a', 1, async (_url, options) => {
    const args = JSON.parse(options.body)
    operations.push(args.operation)
    if (args.operation === 'open') return Response.json({ id: 'fixture' })
    if (args.operation === 'read') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }))
    return new Response()
  })
  await new Promise(resolve => { channel.onopen = resolve })
  channel.send(new Uint8Array(65537))
  assert.equal(channel.readyState, 3)
  assert.equal(operations.includes('write'), false)
})

test('transport errors keep actionable public codes and hide arbitrary provider text', async () => {
  const channel = new ComputerChannel('a', 1, async () => Response.json({ error: { code: 'broker', message: 'secret provider path' } }, { status: 502 }))
  await new Promise(resolve => { channel.onclose = resolve })
  assert.equal(channel.error.code, 'broker')
  assert.equal(channel.error.retryable, true)
  assert.equal(channel.error.message.includes('secret'), false)
  const denied = new ComputerChannel('a', 1, async () => new Response('unauthorized', { status: 401 }))
  await new Promise(resolve => { denied.onclose = resolve })
  assert.equal(denied.error.code, 'auth')
  assert.equal(denied.error.retryable, false)
})

test('WebSocket carries only RFB data and acknowledged frames, with no session token in the URL', async () => {
  let socket
  const calls = [], sent = []
  class Socket {
    constructor(url) {
      assert.equal(url, 'wss://example.test/mount/api/ds-bot/computer-viewer/socket')
      this.bufferedAmount = 0
      socket = this
      queueMicrotask(() => this.onopen())
    }
    send(data) {
      sent.push(data)
      if (typeof data === 'string' && JSON.parse(data).id) queueMicrotask(() => this.onmessage({ data: '{"ready":true}' }))
    }
    close() {}
  }
  const channel = new ComputerChannel('a', 7, async (_url, options) => {
    const call = JSON.parse(options.body); calls.push(call)
    return call.operation === 'open' ? Response.json({ id: 'private-session', webSocket: '/api/ds-bot/computer-viewer/socket' }) : new Response()
  }, { base: 'https://example.test/mount/', WebSocket: Socket })
  await new Promise(resolve => { channel.onopen = resolve })
  assert.equal(channel.transport, 'websocket')
  const pixels = new Uint8Array([1, 2, 3]).buffer
  let received
  channel.onmessage = event => { received = event.data }
  socket.onmessage({ data: pixels })
  assert.equal(received, pixels)
  assert.equal(JSON.parse(sent.at(-1)).ack, 1)
  channel.send(Uint8Array.from([1]))
  assert.equal(typeof sent.at(-1), 'object')
  assert.equal(calls.some(call => call.operation === 'read'), false)
  channel.close()
})

test('a blocked WebSocket upgrade retires its session before Fetch fallback', async () => {
  const calls = []
  let opened = 0
  class BlockedSocket {
    constructor() { queueMicrotask(() => this.onerror()) }
    close() {}
  }
  const channel = new ComputerChannel('a', 1, async (_url, options) => {
    const call = JSON.parse(options.body); calls.push(call)
    if (call.operation === 'open') return Response.json({ id: `session-${++opened}`, webSocket: '/api/ds-bot/computer-viewer/socket' })
    if (call.operation === 'read') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }))
    return new Response()
  }, { base: 'http://fixture/', WebSocket: BlockedSocket })
  await new Promise(resolve => { channel.onopen = resolve })
  assert.equal(channel.transport, 'fetch')
  assert.deepEqual(calls.map(call => call.operation).slice(0, 3), ['open', 'close', 'open'])
  assert.equal(calls[1].id, 'session-1')
  assert.equal(calls.find(call => call.operation === 'read').id, 'session-2')
  channel.close()
})
