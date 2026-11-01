import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReconnectBudget, streamFailure } from '../src/shared/computer-stream.js'

test('briefly successful frames do not reset the reconnect budget', () => {
  const retry = new ReconnectBudget()
  for (let i = 0; i < 4; i++) {
    retry.ready(i * 2000)
    assert.equal(retry.failed('network', i * 2000 + 1000), i < 3 ? 500 * 2 ** i : null)
  }
})

test('stable connections reset consecutive attempts while rapid repeated failures stay bounded', () => {
  const retry = new ReconnectBudget()
  assert.equal(retry.failed('network', 0), 500)
  retry.ready(1000)
  assert.equal(retry.failed('network', 32_000), 500)
  assert.equal(retry.failed('network', 33_000), 1000)
  retry.ready(34_000)
  assert.equal(retry.failed('network', 65_000), 500)
  assert.equal(retry.failed('network', 66_000), 1000)
  retry.ready(67_000)
  assert.equal(retry.failed('network', 98_000), null)
})

test('authorization and protocol failures never auto retry', () => {
  for (const code of ['auth', 'forbidden', 'protocol', 'changed', 'stopped', 'display']) {
    assert.equal(new ReconnectBudget().failed({ code }), null)
  }
  assert.equal(streamFailure({ code: 'bot/computer-provider-unavailable' }).code, 'broker')
  assert.equal(streamFailure({ code: 'bot/computer-off' }).code, 'stopped')
})
