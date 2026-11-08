import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createMessageStore, messageRequest } from '../src/client/messages.js'

const target = { workspaceId: 'team', entityId: 'b', groupId: null }
const accepted = command => ({ ...command, status: 'accepted', sessionId: command.groupId ?? 'own' })
function environment() {
  const values = new Map()
  return {
    values, crypto: { randomUUID }, setTimeout, clearTimeout,
    sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
  }
}

test('double-click submits once and target changes cannot redirect an in-flight message', async () => {
  const env = environment(), calls = []
  let release
  const store = createMessageStore(command => {
    calls.push(command)
    return new Promise(resolve => { release = () => resolve(accepted(command)) })
  }, env)
  store.draft(target, 'private text')
  const first = store.send(target)
  await store.send(target)
  const group = { ...target, groupId: 'g' }
  store.draft(group, 'group draft')
  assert.equal(store.get(target).phase, 'submitting')
  assert.equal(store.get(group).phase, 'idle')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].groupId, null)
  assert.equal([...env.values.values()].join('').includes('private text'), false)
  release(); await first
  assert.equal(store.get(target).phase, 'accepted')
  assert.equal(store.get(target).draft, '')
  assert.equal(store.get(group).draft, 'group draft')
  store.dispose()
})

test('network uncertainty locks the original draft and checks receipts without replay', async () => {
  const calls = [], env = environment()
  const store = createMessageStore(async command => {
    calls.push(command)
    if (command.action === 'send') throw Error('network')
    return accepted({ ...target, commandId: command.commandId })
  }, env)
  store.draft(target, 'keep this draft')
  await store.send(target)
  const id = store.get(target).command.commandId
  assert.equal(store.get(target).phase, 'unknown')
  store.draft(target, 'must not replace'); await store.send(target)
  assert.equal(store.get(target).draft, 'keep this draft')
  assert.equal(calls.length, 1)
  await store.check(target)
  assert.deepEqual(calls[1], { action: 'receipt', commandId: id })
  assert.equal(store.get(target).phase, 'accepted')
  store.dispose()
})

test('explicit rejection preserves the draft and a deliberate retry uses a new command ID', async () => {
  const calls = []
  const store = createMessageStore(async command => {
    calls.push(command)
    if (calls.length === 1) throw Object.assign(Error('read-only'), { code: 'read-only' })
    return accepted(command)
  }, environment())
  store.draft(target, 'draft')
  await store.send(target)
  assert.equal(store.get(target).phase, 'rejected')
  assert.equal(store.get(target).draft, 'draft')
  await store.send(target)
  assert.notEqual(calls[0].commandId, calls[1].commandId)
  store.dispose()
})

test('reload retains only the command address, allowing receipt recovery without storing or sending text', async () => {
  const env = environment()
  const first = createMessageStore(async () => { throw Error('lost') }, env)
  first.draft(target, 'not persisted')
  await first.send(target)
  const id = first.get(target).command.commandId
  first.dispose()
  const calls = []
  const second = createMessageStore(async command => {
    calls.push(command)
    return accepted({ ...target, commandId: id })
  }, env)
  assert.equal(second.get(target).phase, 'unknown')
  assert.equal(second.get(target).restore, true)
  assert.equal(second.get(target).draft, '')
  await second.check(target)
  assert.deepEqual(calls, [{ action: 'receipt', commandId: id }])
  assert.equal(second.get(target).phase, 'accepted')
  second.dispose()
})

test('blocked storage works; disposal aborts requests; draft capacity can be reclaimed explicitly', async () => {
  const env = environment()
  env.sessionStorage = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
  let signal
  const store = createMessageStore(async (command, value) => { signal = value; return new Promise(resolve => value.addEventListener('abort', () => resolve(accepted(command)))) }, env)
  for (let i = 0; i < 64; i++) store.draft({ ...target, entityId: `b${i}` }, 'draft')
  assert.equal(store.capacity(target), false)
  store.clear({ ...target, entityId: 'b0' })
  assert.equal(store.capacity(target), true)
  store.draft(target, 'hello')
  const pending = store.send(target)
  store.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(await pending, undefined)
  assert.equal(store.getSnapshot().size, 0)
})

test('command transport preserves read-only errors and treats malformed success as uncertain', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'read-only' }), { status: 403 })
  await assert.rejects(messageRequest({ action: 'send' }), { code: 'read-only' })
  globalThis.fetch = async () => new Response(JSON.stringify({ receipt: { status: 'accepted', commandId: 'other' } }))
  await assert.rejects(messageRequest({ action: 'send', commandId: 'mine' }), /unavailable/)
})
