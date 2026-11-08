import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'
import { clock, flush } from './helpers/clock.js'

test('an authenticated Host reset restarts the bundled client after auth loss, and unload releases the stream', async () => {
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
    fetch: async () => {
      requests++
      if (requests === 1) return new Response('', { status: 401 })
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
    slots: { inject(_name, callback) { callback() }, register(value) { slots.push(value) } },
  })
  const store = slots.find(slot => slot.key === 'bothub').inject().store
  store.start(); await flush()
  assert.equal(store.getSnapshot().error, 'unauthorized')
  assert.equal(time.timers.size, 0)
  callbacks.get('connection/reset')(); await flush()
  assert.equal(requests, 2)
  assert.equal(store.getSnapshot().phase, 'live')
  assert.equal(store.getSnapshot().data.workspaceId, 'team')
  for (const dispose of disposers.reverse()) dispose()
  await flush()
  assert.equal(cancelled, 1)
  assert.equal(callbacks.size, 0)
  assert.equal(time.timers.size, 0)
})
