import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexEngine } from '../src/host/local-agents/codex.js'

test('repeated cursors fail instead of returning a partial model list or looping', async () => {
  const engine = new CodexEngine('local-codex-cli', {}, {})
  let calls = 0
  engine.ensure = async () => ({ request: async () => {
    calls++
    return { data: [{ id: 'old' }], nextCursor: 'same' }
  } })
  await assert.rejects(engine.listModels(), /Invalid Codex model cursor/)
  assert.equal(calls, 2)
})

test('a failed later page never returns the first page as a complete catalog', async () => {
  const engine = new CodexEngine('local-codex-cli', {}, {})
  let calls = 0
  engine.ensure = async () => ({ request: async () => {
    if (++calls > 1) throw Error('model list unavailable')
    return { data: [{ id: 'old' }], nextCursor: 'more' }
  } })
  await assert.rejects(engine.listModels(), /model list unavailable/)
})
