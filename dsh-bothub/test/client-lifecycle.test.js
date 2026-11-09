import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'
import { clock, flush } from './helpers/clock.js'

test('bundled conversation and receipt navigation wait for the client catalog and unload cancels a wait', async () => {
  const time = clock(), disposers = [], slots = [], listeners = new Set(), opened = []
  const byId = {}
  let plugin, refreshes = 0
  const sessions = {
    list: {
      getSnapshot: () => ({ byId }),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    },
    async refresh() { refreshes++ },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(module) { plugin = module.factory(() => ({ createElement() {} })) } } },
    ...time.environment, AbortController, AbortSignal,
    fetch: async () => new Response(JSON.stringify({ target: 'new-segment' })),
  })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  plugin.apply({
    sessions, uiWorkspace: { openSession(id) { assert.ok(byId[id], 'only listed IDs may open'); opened.push(id) } },
    effect(callback) { disposers.push(callback()) }, on: () => () => {},
    locale: { register: () => () => {} }, sidebarRightTabs: { register: () => () => {} },
    slots: { inject(_name, callback) { callback() }, register(value) { slots.push(value) } },
  })
  const { open, openReceipt } = slots.find(slot => slot.name === 'sidebar.right.pane.tab').inject()
  const conversation = open('b')
  await flush()
  assert.deepEqual(opened, [])
  assert.equal(refreshes, 1)
  byId['new-segment'] = { id: 'new-segment' }
  for (const fn of listeners) fn()
  await conversation
  assert.deepEqual(opened, ['new-segment'])
  const receipt = openReceipt({ sessionId: 'delivery' })
  await flush()
  assert.equal(refreshes, 2)
  byId.delivery = { id: 'delivery' }
  for (const fn of listeners) fn()
  await receipt
  assert.deepEqual(opened, ['new-segment', 'delivery'])
  const late = openReceipt({ sessionId: 'late' })
  await flush()
  for (const dispose of disposers.reverse()) dispose()
  await late
  byId.late = { id: 'late' }
  for (const fn of listeners) fn()
  assert.deepEqual(opened, ['new-segment', 'delivery'])
  assert.equal(listeners.size, 0)
  assert.equal(time.timers.size, 0)
})

for (const streaming of [true, false]) test(`an authenticated Host reset restarts the bundled ${streaming ? 'stream' : 'polling'} client after auth loss and unload releases resources`, async () => {
  const time = clock(), callbacks = new Map(), disposers = [], slots = []
  let plugin, requests = 0, cancelled = 0
  const snapshot = { version: 2, workspaceId: 'team', readOnly: false, capturedAt: 1, entities: [], sessions: [], runs: [], groups: [] }
  const identity = { schemaVersion: 1, epoch: 'new-host', scopeKey: 'scope', seq: 0 }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(module) {
      plugin = module.factory(name => {
        if (name === 'react') return { createElement() {} }
        throw new Error(`Unexpected dependency: ${name}`)
      })
    } } },
    ...time.environment, AbortController, AbortSignal, TextEncoder, TextDecoder, Response,
    navigator: streaming ? { locks: { request: (_name, _options, callback) => callback({}) } } : {},
    fetch: async () => {
      requests++
      if (requests === 1) return new Response('', { status: 401 })
      if (!streaming) return new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } })
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: snapshot\ndata: ${JSON.stringify({ ...identity, snapshot })}\n\n`
            + `event: ready\ndata: ${JSON.stringify({ ...identity, capturedAt: 1 })}\n\n`))
        },
        cancel() { cancelled++ },
      }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  plugin.apply({
    effect(callback) { disposers.push(callback()) },
    on(event, callback) { callbacks.set(event, callback); return () => callbacks.delete(event) },
    locale: { register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject(_name, callback) { callback() }, register(value) { slots.push(value) } },
  })
  const store = slots.find(slot => slot.name === 'sidebar.right.pane.tab').inject().store
  store.start(); await flush(); await time.advance(0)
  assert.equal(store.getSnapshot().error, 'unauthorized')
  assert.equal(time.timers.size, 0)
  callbacks.get('connection/reset')(); await flush(); await time.advance(0)
  assert.equal(requests, 2)
  assert.equal(store.getSnapshot().phase, 'live')
  assert.equal(store.getSnapshot().transport, streaming ? 'stream' : 'poll')
  assert.equal(store.getSnapshot().data.workspaceId, 'team')
  for (const dispose of disposers.reverse()) dispose()
  await flush()
  assert.equal(cancelled, streaming ? 1 : 0)
  assert.equal(callbacks.size, 0)
  assert.equal(time.timers.size, 0)
})
