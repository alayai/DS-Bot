import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channel } from 'node:diagnostics_channel'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpDiagnostics } from '../dev/http-diagnostics.mjs'

test('bench HTTP diagnostics retain timing evidence without credentials or changing timeouts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsbot-http-diagnostics-'))
  const file = join(directory, 'events.jsonl')
  const dispose = httpDiagnostics(file)
  t.after(async () => { dispose(); await rm(directory, { recursive: true, force: true }) })
  const socket = new EventEmitter()
  socket.timeout = 0
  const request = Object.assign(new EventEmitter(), {
    url: '/api/bot?token=private-query', path: '/api/bot?token=private-query', socket,
    headers: { cookie: 'private-cookie' }, body: 'private-body',
  })
  const response = Object.assign(new EventEmitter(), { writableFinished: true, statusCode: 200 })
  const server = { timeout: 0, keepAliveTimeout: 5000, requestTimeout: 300000 }
  channel('http.server.request.start').publish({ request, response, server })
  channel('undici:client:sendHeaders').publish({ request, socket })
  channel('undici:request:error').publish({ request, error: { code: 'ECONNRESET', message: 'private-message' } })
  channel('undici:request:trailers').publish({ request })
  response.emit('close')
  socket.emit('close', false)
  const contents = await readFile(file, 'utf8')
  assert.equal(contents.includes('private-'), false)
  const events = contents.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.event), [
    'server-start', 'client-send', 'client-error', 'client-complete', 'response-close', 'socket-close',
  ])
  assert.equal(events[2].code, 'ECONNRESET')
  assert.equal(events[4].finished, true)
  assert.equal(request.listenerCount('aborted'), 0, 'completed responses do not retain request listeners')
  assert.equal(socket.listenerCount('end'), 0, 'closed sockets do not retain listeners')
  assert.equal(server.keepAliveTimeout, 5000)
  assert.equal(socket.listenerCount('timeout'), 0, 'listening for timeout would change Node socket destruction')
  dispose()
  assert.equal(request.listenerCount('aborted'), 0)
  assert.equal(socket.listenerCount('end'), 0)
  channel('undici:request:error').publish({ request, error: { code: 'ECONNRESET' } })
  assert.equal(await readFile(file, 'utf8'), contents)
})

test('bench diagnostics ignore unrelated routes and sanitize unexpected error codes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsbot-http-diagnostics-'))
  const file = join(directory, 'events.jsonl')
  const dispose = httpDiagnostics(file)
  t.after(async () => { dispose(); await rm(directory, { recursive: true, force: true }) })
  const socket = new EventEmitter()
  const hidden = { path: '/private-route?token=private-query' }
  channel('undici:client:sendHeaders').publish({ request: hidden, socket })
  channel('undici:request:error').publish({ request: hidden, error: { code: 'ECONNRESET' } })
  const request = { path: '/api/ds-bot/computer-viewer?token=private-query' }
  channel('undici:client:sendHeaders').publish({ request, socket })
  channel('undici:request:error').publish({ request, error: { code: 'private-code', message: 'private-message' } })
  const contents = await readFile(file, 'utf8')
  assert.equal(contents.includes('private-'), false)
  const events = contents.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.length, 2)
  assert.equal(events[0].path, '/api/ds-bot/computer-viewer')
  assert.equal(events[1].code, 'UNKNOWN')
})
