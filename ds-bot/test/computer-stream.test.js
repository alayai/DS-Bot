import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/computer-stream.js', import.meta.url))], bundle: true, write: false, format: 'cjs', external: ['react'] })
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}), AbortController, AbortSignal, setTimeout, clearTimeout, Uint8Array, btoa })
const { ComputerChannel } = module.exports
const tick = () => new Promise(resolve => setImmediate(resolve))

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
