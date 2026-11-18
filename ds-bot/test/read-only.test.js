import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/read-only.js'

function fixture(ready = true) {
  let service
  const bot = { id: 'bot-a', name: 'Builder', role: 'Engineer', instructions: '<script>plain text</script>', model: 'provider/model', private: true, workDir: '/secret/path', apiKey: 'hidden-key', capabilities: [{ secret: 'hidden-capability' }] }
  const rt = {
    state: { bots: { a: bot } }, snapshotReady: () => ready,
    ctx: { effect: fn => fn(), provide: (name, value) => { assert.equal(name, 'botReadOnly'); service = value; return () => { service = undefined } } },
    load: () => { throw new Error('must not load') }, refresh: () => { throw new Error('must not refresh') }, save: () => { throw new Error('must not save') },
  }
  install(rt)
  return { rt, service, bot }
}

test('loaded Bot settings are detached and omit paths, credentials and capabilities', () => {
  const { service, bot } = fixture()
  const before = structuredClone(bot), result = service.list(0, 10)
  assert.deepEqual(result, { ready: true, nextOffset: null, items: [{ id: 'bot-a', name: 'Builder', role: 'Engineer', instructions: '<script>plain text</script>', model: 'provider/model', private: true, truncated: false }] })
  result.items[0].name = 'changed'
  assert.deepEqual(bot, before)
  for (const secret of ['/secret/path', 'hidden-key', 'hidden-capability']) assert.equal(JSON.stringify(result).includes(secret), false)
})

test('uninitialized roster is explicit and never triggers initialization', () => {
  const { service } = fixture(false)
  assert.deepEqual(service.list(0, 10), { ready: false, items: [], nextOffset: null })
})

test('settings preview is bounded, paginated and reflects loaded edits without refreshing', () => {
  const { service, bot, rt } = fixture()
  bot.instructions = 'x'.repeat(5000)
  rt.state.bots.b = { ...bot, id: 'bot-b', name: 'Second' }
  const page = service.list(0, 1)
  assert.equal(page.items[0].instructions.length, 4096)
  assert.equal(page.items[0].truncated, true)
  assert.equal(page.nextOffset, 1)
  assert.equal(service.list(1, 1).items[0].id, 'bot-b')
  assert.equal(service.list(1, 1).nextOffset, null)
  for (const [offset, limit] of [[-1, 1], [0, 11], [0, 0], [1.5, 1]]) assert.throws(() => service.list(offset, limit))
})
