import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/cloud-export.js'

function fixture({ ready = true, bot = {} } = {}) {
  let service
  const entry = { id: 'bot-a', name: 'Builder', role: 'Engineer', instructions: 'Use the cloud workspace.', private: false, ...bot }
  const rt = {
    state: { bots: { a: entry } },
    snapshotReady: () => ready,
    botOf: id => id === entry.id ? entry : undefined,
    ctx: { effect: fn => fn(), provide: (name, value) => { assert.equal(name, 'botExport'); service = value; return () => { service = undefined } } },
  }
  install(rt)
  return { service, entry }
}

test('exports a complete public declarative definition without local model or folders', () => {
  const { service } = fixture()
  assert.deepEqual(service.get('bot-a'), {
    version: 1,
    exportable: true,
    definition: { schemaVersion: 1, name: 'Builder', role: 'Engineer', instructions: 'Use the cloud workspace.', requiredCapabilities: [] },
  })
})

test('refuses private, missing, unready and oversized Bots before any cloud request', () => {
  assert.equal(fixture({ bot: { private: true } }).service.get('bot-a').reason, 'PRIVATE_BOT')
  assert.equal(fixture().service.get('missing').reason, 'NOT_FOUND')
  assert.equal(fixture({ ready: false }).service.get('bot-a').reason, 'NOT_READY')
  assert.equal(fixture({ bot: { instructions: 'x'.repeat(16_001) } }).service.get('bot-a').reason, 'TOO_LARGE')
})
