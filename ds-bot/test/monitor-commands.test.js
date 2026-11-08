import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMonitorCommands } from '../src/host/monitor-commands.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'bothub-commands-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const calls = [], lifetime = new AbortController()
  const controller = { prompt: async request => { calls.push(request); return { accepted: true } } }
  const rt = {
    home, ctx: { get: name => name === 'sessionController' ? controller : undefined },
    state: { workspaceId: 'team', bots: { b: { id: 'b' }, c: { id: 'c' } }, rooms: { g: { id: 'g', members: ['b'] } } },
    own: (table, key) => Object.hasOwn(table, key) ? table[key] : undefined,
    refresh: async () => {}, readOnly: () => undefined, chatOf: id => `${id}-current`,
    ensureCapabilities: async () => {},
  }
  const request = { commandId: randomUUID(), workspaceId: 'team', entityId: 'b', groupId: null, text: 'Private message body' }
  return { rt, calls, controller, lifetime, request, path: join(home, 'bothub-commands.json'),
    service: createMonitorCommands(rt, lifetime.signal) }
}
const failure = code => error => error.code === `bothub/${code}`

test('receipt is durable before dispatch, binds the current private segment, and never stores text', async t => {
  const f = await fixture(t)
  f.controller.prompt = async request => {
    f.calls.push(request)
    const data = JSON.parse(await readFile(f.path, 'utf8')).commands[0]
    assert.equal(data.status, 'pending')
    assert.equal(data.sessionId, 'b-current')
    assert.equal(request.requestId, data.commandId)
    return { accepted: true }
  }
  const result = await f.service.send(f.request)
  assert.equal(result.status, 'accepted')
  assert.equal(f.calls[0].mode, 'queue')
  assert.deepEqual(f.calls[0].content, [{ type: 'text', text: f.request.text }])
  const stored = await readFile(f.path, 'utf8')
  assert.equal(stored.includes(f.request.text), false)
  assert.equal(stored.includes('"text"'), false)
  assert.equal(JSON.parse(stored).commands[0].status, 'accepted')
})

test('concurrent identical submissions dispatch once; conflicting payloads and targets are rejected', async t => {
  const f = await fixture(t)
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  f.controller.prompt = request => {
    f.calls.push(request); entered()
    return new Promise(resolve => { release = resolve })
  }
  const first = f.service.send(f.request)
  await ready
  const second = f.service.send({ ...f.request })
  assert.equal((await f.service.receipt(f.request.commandId)).status, 'submitting')
  await assert.rejects(f.service.send({ ...f.request, text: 'different' }), failure('command-conflict'))
  release({ accepted: true })
  assert.deepEqual(await first, await second)
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.service.send({ ...f.request, groupId: 'g' }), failure('command-conflict'))
  await assert.rejects(f.service.send({ ...f.request, entityId: 'c' }), failure('command-conflict'))
})

test('room messages use the group root, never a member hidden session', async t => {
  const f = await fixture(t)
  const result = await f.service.send({ ...f.request, groupId: 'g' })
  assert.equal(result.sessionId, 'g')
  assert.equal(f.calls[0].sessionId, 'g')
})

test('scope, membership, read-only and malformed requests fail before dispatch', async t => {
  const f = await fixture(t)
  for (const [patch, code] of [
    [{ workspaceId: 'other' }, 'scope-changed'], [{ entityId: 'agent:a' }, 'not-found'],
    [{ entityId: '__proto__' }, 'not-found'], [{ entityId: 'c', groupId: 'g' }, 'not-found'],
    [{ groupId: '__proto__' }, 'not-found'], [{ commandId: '../file' }, 'invalid'],
    [{ groupId: undefined }, 'invalid'], [{ text: ' ' }, 'invalid'], [{ text: 'x'.repeat(4001) }, 'invalid'],
  ]) await assert.rejects(f.service.send({ ...f.request, ...patch }), failure(code))
  f.rt.readOnly = () => 'private path'
  await assert.rejects(f.service.send(f.request), failure('read-only'))
  assert.equal(f.calls.length, 0)
  await assert.rejects(readFile(f.path), { code: 'ENOENT' })
})

test('rechecks target after capabilities: removal and segment rollover cannot misroute a pending message', async t => {
  for (const change of ['membership', 'segment']) {
    const f = await fixture(t)
    f.rt.ensureCapabilities = async () => {
      if (change === 'membership') f.rt.state.rooms.g.members = []
      else f.rt.chatOf = () => 'new-part'
    }
    const result = await f.service.send({ ...f.request, groupId: change === 'membership' ? 'g' : null })
    assert.equal(result.status, 'rejected')
    assert.equal(result.error, change === 'membership' ? 'not-found' : 'target-changed')
    assert.equal(f.calls.length, 0)
  }
})

test('restarting after acceptance returns the original segment receipt without dispatching again', async t => {
  const f = await fixture(t)
  const first = await f.service.send(f.request)
  f.rt.chatOf = () => 'rolled-over'
  const restarted = createMonitorCommands(f.rt, f.lifetime.signal)
  assert.deepEqual(await restarted.send(f.request), first)
  assert.equal(f.calls.length, 1)
})

test('lost acceptance persistence stays unknown; public inbox evidence recovers after restart without replay', async t => {
  const f = await fixture(t)
  f.controller.prompt = async request => {
    f.calls.push(request)
    f.rt.readOnly = () => 'lock lost after admission'
    return { accepted: true }
  }
  assert.equal((await f.service.send(f.request)).status, 'unknown')
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).commands[0].status, 'pending')
  f.rt.readOnly = () => undefined
  f.rt.chatOf = () => 'new-part'
  const restarted = createMonitorCommands(f.rt, f.lifetime.signal)
  assert.equal((await restarted.send(f.request)).status, 'unknown')
  f.controller.projections = async ({ sessionId }) => {
    assert.equal(sessionId, 'b-current')
    return { kind: 'sequenced', asOfSeq: 5, values: { inbox: { 'next-turn': [{ source: { kind: 'user', rpcId: f.request.commandId } }] } } }
  }
  f.controller.page = async () => { throw Error('queue evidence should suffice') }
  assert.equal((await restarted.receipt(f.request.commandId)).status, 'accepted')
  assert.equal(f.calls.length, 1)
})

test('history receipt recovery is bounded; absent or failing evidence never causes a resend', async t => {
  const f = await fixture(t)
  f.controller.prompt = async request => { f.calls.push(request); throw Error('secret path') }
  assert.equal((await f.service.send(f.request)).status, 'unknown')
  f.controller.projections = async () => ({ kind: 'sequenced', asOfSeq: 70, values: {} })
  f.controller.page = async request => {
    assert.deepEqual(request, { address: { kind: 'session', sessionId: 'b-current' }, throughSeq: 70, maxMessages: 32 })
    return { records: [] }
  }
  assert.equal((await f.service.receipt(f.request.commandId)).status, 'unknown')
  assert.equal((await f.service.send(f.request)).status, 'unknown')
  f.controller.page = async () => ({ records: [{ type: 'event', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: f.request.commandId } } } }] })
  assert.equal((await f.service.receipt(f.request.commandId)).status, 'accepted')
  assert.equal(f.calls.length, 1)
  assert.equal((await readFile(f.path, 'utf8')).includes('secret'), false)
})

test('receipt reads recheck membership after asynchronous evidence lookup', async t => {
  const f = await fixture(t)
  f.controller.prompt = async () => { throw Error('lost') }
  await f.service.send({ ...f.request, groupId: 'g' })
  f.controller.projections = async () => {
    f.rt.state.rooms.g.members = []
    return { kind: 'sequenced', asOfSeq: 1, values: {} }
  }
  f.controller.page = async () => ({ records: [] })
  await assert.rejects(f.service.receipt(f.request.commandId), failure('not-found'))
})

test('corrupt and full stores refuse new commands without overwriting or discarding deduplication evidence', async t => {
  const corrupt = await fixture(t)
  await writeFile(corrupt.path, '{broken')
  await assert.rejects(corrupt.service.send(corrupt.request), failure('command-store'))
  assert.equal(await readFile(corrupt.path, 'utf8'), '{broken')
  const full = await fixture(t)
  await full.service.send(full.request)
  const record = JSON.parse(await readFile(full.path, 'utf8')).commands[0]
  await writeFile(full.path, JSON.stringify({ version: 1, commands: Array.from({ length: 2048 }, () => ({ ...record, commandId: randomUUID() })) }))
  const restarted = createMonitorCommands(full.rt, full.lifetime.signal)
  await assert.rejects(restarted.send({ ...full.request, commandId: randomUUID() }), failure('command-capacity'))
  assert.equal(full.calls.length, 1)
})
