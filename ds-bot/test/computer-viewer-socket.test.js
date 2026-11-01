import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { registerComputerViewer } from '../src/host/computer/viewer.js'

async function fixture(t) {
  let route, upgrade, pushed, onClose, closed = false, acknowledgements = 0
  const controller = new AbortController()
  const peer = { principal: { kind: 'owner' }, signal: controller.signal }
  const writes = []
  const stream = {
    validate: async () => {},
    onClose: fn => { onClose = fn }, onData: fn => { pushed = fn },
    close: () => { if (!closed) { closed = true; onClose?.() } },
    write: async data => writes.push(data),
  }
  const connection = { fetch: { register: value => { route = value.fetch; return () => {} } },
    admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer } : { rejection: 401 },
  }
  const webServer = { registerUpgrade: value => { upgrade = value.handler; return () => {} } }
  const dispose = registerComputerViewer({ ctx: { get: name => ({ connection, webServer })[name] } }, () => ({ openViewer: async () => stream }))
  const server = createServer()
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `ws://127.0.0.1:${server.address().port}/api/ds-bot/computer-viewer/socket`
  t.after(async () => { await dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const call = args => route(new Request('http://fixture/api/ds-bot/computer-viewer', { method: 'POST', body: JSON.stringify(args) }))
  return { base, call, writes, closed: () => closed, acks: () => acknowledgements,
    push: data => pushed(data, () => acknowledgements++), peer, revoke: () => controller.abort() }
}

test('WebSocket upgrade refuses unauthenticated callers without opening a Broker stream', async t => {
  const h = await fixture(t)
  const socket = new WebSocket(h.base)
  socket.on('error', () => {})
  const status = await new Promise(resolve => socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); socket.terminate() }))
  assert.equal(status, 401)
  assert.equal(h.closed(), false)
})

test('authenticated WebSocket enforces the receive window, read-only protocol and exclusive transport', async t => {
  const h = await fixture(t)
  const opened = await (await h.call({ operation: 'open', botId: 'a', generation: 1 })).json()
  assert.equal(opened.webSocket, '/api/ds-bot/computer-viewer/socket')
  const socket = new WebSocket(h.base, { headers: { 'x-fixture-owner': 'yes' } })
  socket.on('error', () => {})
  t.after(() => socket.terminate())
  await once(socket, 'open')
  const ready = once(socket, 'message')
  socket.send(JSON.stringify({ id: opened.id }))
  assert.equal(JSON.parse((await ready)[0].toString()).ready, true)
  assert.equal((await h.call({ operation: 'read', id: opened.id })).status, 429)
  const received = []
  socket.on('message', (data, binary) => { if (binary) received.push(data) })
  for (let i = 0; i < 8; i++) {
    h.push(Buffer.alloc(65536, i))
    while (received.length < i + 1) await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.equal(h.acks(), 7, 'the eighth chunk waits for receiver credit')
  socket.send(JSON.stringify({ ack: 1 }))
  while (h.acks() < 8) await new Promise(resolve => setTimeout(resolve, 1))
  socket.send(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]))
  while (!h.writes.length) await new Promise(resolve => setTimeout(resolve, 1))
  const disconnected = once(socket, 'close')
  socket.send(Buffer.from([5]))
  const [code, reason] = await disconnected
  assert.equal(code, 4000)
  assert.equal(reason.toString(), 'protocol')
  assert.equal(h.closed(), true)
})

for (const scenario of ['revoked', 'invalid-ack']) {
  test(`WebSocket closes its Broker stream on ${scenario}`, async t => {
    const h = await fixture(t)
    const opened = await (await h.call({ operation: 'open', botId: 'a', generation: 1 })).json()
    const socket = new WebSocket(h.base, { headers: { 'x-fixture-owner': 'yes' } })
    socket.on('error', () => {})
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const ready = once(socket, 'message')
    socket.send(JSON.stringify({ id: opened.id }))
    await ready
    const disconnected = once(socket, 'close')
    if (scenario === 'revoked') h.revoke()
    else {
      const received = once(socket, 'message')
      h.push(Buffer.alloc(32))
      await received
      socket.send(JSON.stringify({ ack: 2 }))
    }
    const [code, reason] = await disconnected
    assert.equal(code, 4000)
    assert.equal(reason.toString(), scenario === 'revoked' ? 'forbidden' : 'protocol')
    assert.equal(h.closed(), true)
    assert.equal((await h.call({ operation: 'read', id: opened.id })).status, 410)
  })
}
