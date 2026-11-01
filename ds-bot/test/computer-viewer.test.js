import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readOnlyInput, registerComputerViewer } from '../src/host/computer/viewer.js'

const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])])
const update = Buffer.from([3, 1, 0, 0, 0, 0, 4, 0, 3, 0])

test('read-only RFB accepts fragmented 3.8 shared handshake and update requests', () => {
  const input = Buffer.concat([handshake, Buffer.alloc(20), update, Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 0])])
  for (let width = 1; width < input.length; width++) {
    const filter = readOnlyInput()
    const chunks = []
    for (let i = 0; i < input.length; i += width) chunks.push(filter(input.subarray(i, i + width)))
    assert.deepEqual(Buffer.concat(chunks), input)
  }
})

test('read-only RFB refuses input, clipboard, power, resize, bad handshake and oversized requests', () => {
  for (const type of [4, 5, 6, 250, 251, 255, 99]) {
    const filter = readOnlyInput()
    filter(handshake)
    assert.throws(() => filter(Buffer.from([type])))
  }
  for (const bytes of [Buffer.from('RFB 003.003\n'), Buffer.concat([handshake.subarray(0, 13), Buffer.from([0])])]) {
    assert.throws(() => readOnlyInput()(bytes))
  }
  assert.throws(() => readOnlyInput()(Buffer.alloc(65537)))
  const filter = readOnlyInput()
  filter(handshake)
  assert.throws(() => filter(Buffer.from([2, 0, 255, 255])))
})

test('RFB strips control and clipboard capability advertisements', () => {
  const message = Buffer.alloc(4 + 6 * 4)
  message[0] = 2
  message.writeUInt16BE(6, 2)
  ;[0, 7, -309, -308, -258, 0xc0a1e5ce | 0].forEach((encoding, i) => message.writeInt32BE(encoding, 4 + 4 * i))
  const filter = readOnlyInput()
  filter(handshake)
  const output = filter(message)
  assert.equal(output.readUInt16BE(2), 2)
  assert.deepEqual([...output.subarray(4)], [0, 0, 0, 0, 0, 0, 0, 7])
})

function route(t) {
  let handler, data, closed = false, closing, valid = true, acknowledgements = 0
  const writes = []
  const stream = {
    onData: fn => { data = fn }, onClose: fn => { closing = fn },
    close: () => { if (!closed) { closed = true; closing?.() } },
    validate: async () => { if (!valid) throw new Error('revoked') },
    write: async bytes => writes.push(bytes),
  }
  const dispose = registerComputerViewer({ ctx: { get: () => ({ fetch: { register: value => { handler = value.fetch; return () => {} } } }) } }, () => ({ openViewer: async () => stream }))
  t.after(dispose)
  const call = (body, signal) => handler(new Request('http://fixture/api/ds-bot/computer-viewer', { method: 'POST', body: JSON.stringify(body), signal }))
  return { call, writes, dispose, revoke: () => { valid = false }, isClosed: () => closed,
    send: bytes => data(bytes, () => acknowledgements++), ack: () => acknowledgements }
}

test('desktop Fetch transport delays broker acknowledgement until the next read', async t => {
  const h = route(t)
  const { id } = await (await h.call({ operation: 'open', botId: 'a', generation: 1 })).json()
  h.send(Buffer.from('pixels'))
  assert.equal(await (await h.call({ operation: 'read', id })).text(), 'pixels')
  assert.equal(h.ack(), 0)
  const pending = h.call({ operation: 'read', id })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.ack(), 1)
  await h.call({ operation: 'close', id })
  assert.equal((await pending).status, 410)
  assert.equal(h.isClosed(), true)
  assert.equal((await h.call({ operation: 'read', id })).status, 410)
})

test('viewer validates ownership on each exchange, bounds data and closes on forbidden input', async t => {
  const h = route(t)
  const { id } = await (await h.call({ operation: 'open', botId: 'a', generation: 1 })).json()
  assert.equal((await h.call({ operation: 'write', id, data: handshake.toString('base64') })).status, 200)
  assert.deepEqual(h.writes, [handshake])
  assert.equal((await h.call({ operation: 'write', id, data: Buffer.from([5]).toString('base64') })).status, 403)
  assert.equal(h.isClosed(), true)
  const next = route(t)
  const opened = await (await next.call({ operation: 'open', botId: 'a', generation: 1 })).json()
  next.revoke()
  assert.equal((await next.call({ operation: 'read', id: opened.id })).status, 403)
  assert.equal(next.isClosed(), true)
})

test('cancelled reads and route disposal close the runtime stream', async t => {
  const h = route(t)
  const { id } = await (await h.call({ operation: 'open', botId: 'a', generation: 1 })).json()
  const abort = new AbortController()
  const read = h.call({ operation: 'read', id }, abort.signal)
  abort.abort()
  assert.equal((await read).status, 410)
  assert.equal(h.isClosed(), true)
  await h.dispose()
  assert.equal((await h.call({ operation: 'open' })).status, 503)
})
