import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monitorRoute } from '../src/host/channel.js'
import { apply } from '../index.js'

const request = body => new Request('http://localhost/api/bothub', body ? {
  method: 'POST', body: JSON.stringify(body),
} : {})

test('route reports a missing or incompatible bridge without exposing server errors', async () => {
  const missing = await monitorRoute(request())
  assert.equal(missing.status, 503)
  assert.deepEqual(await missing.json(), { error: 'bridge-missing' })
  assert.equal((await monitorRoute(request(), { version: 99 })).status, 409)
  const result = await monitorRoute(request(), { version: 2, snapshot: () => { throw new Error('secret path') } })
  assert.equal(result.status, 503)
  assert.equal((await result.text()).includes('secret'), false)
})

test('route only accepts reads and explicitly scoped conversation resolution', async () => {
  const calls = []
  const service = {
    version: 2, snapshot: () => ({ version: 2 }),
    resolve: (...args) => { calls.push(args); return args[0] === 'b' ? 'current' : null },
  }
  assert.deepEqual(await (await monitorRoute(request(), service)).json(), { version: 2 })
  const resolved = await monitorRoute(request({ action: 'resolve', entityId: 'b', sessionId: 'old' }), service)
  assert.deepEqual(await resolved.json(), { target: 'current' })
  assert.deepEqual(calls, [['b', 'old', undefined]])
  assert.equal((await monitorRoute(request({ action: 'send', entityId: 'b' }), service)).status, 400)
  assert.equal((await monitorRoute(request({ action: 'resolve', entityId: 'missing' }), service)).status, 404)
  assert.equal((await monitorRoute(request({ action: 'resolve', entityId: [] }), service)).status, 400)
  const foreign = new Request('http://localhost/api/bothub', { headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' } })
  assert.equal((await monitorRoute(foreign, service)).status, 403)
  const normalized = new Request('http://localhost/api/bothub', {
    method: 'POST', headers: { origin: 'http://localhost:3196', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'resolve', entityId: 'b' }),
  })
  assert.equal((await monitorRoute(normalized, service)).status, 200)
})

test('room navigation carries a bounded group identity to the bridge', async () => {
  let args
  const service = { version: 2, resolve: (...value) => { args = value; return 'group' } }
  const response = await monitorRoute(request({ action: 'resolve', entityId: 'b', groupId: 'group' }), service)
  assert.deepEqual(await response.json(), { target: 'group' })
  assert.deepEqual(args, ['b', undefined, 'group'])
  for (const groupId of ['', null, [], 'a'.repeat(257)]) {
    assert.equal((await monitorRoute(request({ action: 'resolve', entityId: 'b', groupId }), service)).status, 400)
  }
})

test('plugin registers on the authenticated connection service and disposes its route', () => {
  let route
  let disposed = false
  const disposers = []
  apply({
    on: () => () => {},
    connection: { fetch: { register(value) { route = value; return () => { disposed = true } } } },
    get: () => undefined, effect: callback => disposers.push(callback()),
  })
  assert.equal(route.path, '/api/bothub')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  disposers.forEach(dispose => dispose())
  assert.equal(disposed, true)
})

test('child navigation returns the host-validated native address intact', async () => {
  const target = { parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' }
  const response = await monitorRoute(request({ action: 'resolve', entityId: 'subagent:c' }), {
    version: 2, resolve: () => target,
  })
  assert.deepEqual(await response.json(), { target })
})

test('command transport requires JSON, bounds input, and only exposes safe command errors', async () => {
  const post = body => new Request('http://localhost/api/bothub', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  let value
  const service = { version: 2, send: body => { value = body; return { status: 'accepted' } }, receipt: () => ({ status: 'unknown' }) }
  assert.equal((await monitorRoute(post({ action: 'send', text: 'x'.repeat(65536) }), service)).status, 400)
  assert.equal((await monitorRoute(post({ action: 'send' }), { version: 2 })).status, 503)
  assert.equal((await monitorRoute(request({ action: 'send' }), service)).status, 400)
  const body = { action: 'send', commandId: 'id', entityId: 'b', groupId: 'g', workspaceId: 'scope', text: 'hello', actor: 'admin' }
  assert.equal((await monitorRoute(post(body), service)).status, 200)
  assert.deepEqual(value, { commandId: 'id', entityId: 'b', groupId: 'g', workspaceId: 'scope', text: 'hello' })
  service.send = () => { throw Object.assign(Error('private path'), { code: 'bothub/read-only' }) }
  const response = await monitorRoute(post(body), service)
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'read-only' })
  service.send = () => { throw Error('secret') }
  assert.deepEqual(await (await monitorRoute(post(body), service)).json(), { error: 'unavailable' })
  const cross = new Request(post(body), { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } })
  assert.equal((await monitorRoute(cross, service)).status, 403)
})
