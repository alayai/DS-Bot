import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanup, homeVolume, backupVolume } from '../../computer-runtime/broker/checkpoint.mjs'

const checkpointId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const homeRevision = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const record = { id: 'cmp_fixture', previousHomes: [null], homeRevision }
const value = { record, volume: homeVolume(record) }
function fixture({ owner = record.id, references = '', missing = false, storage = 'staged-home' } = {}) {
  const removed = []
  const docker = async args => {
    if (args[0] === 'ps') return { stdout: references }
    if (args[1] === 'rm') { removed.push(args[2]); return { stdout: '' } }
    if (missing) throw Object.assign(new Error('missing'), { stderr: 'no such volume' })
    return { stdout: JSON.stringify([{ Name: args[2], Driver: 'local', Options: null, Labels: {
      'org.ds-bot.computer.id': owner, 'org.ds-bot.computer.checkpoint': checkpointId,
      'org.ds-bot.computer.storage': storage,
    } }]) }
  }
  return { removed, docker }
}
test('cleanup removes only an owned unreferenced checkpoint or retained home', async () => {
  const h = fixture()
  await cleanup(value, { kind: 'checkpoint', checkpointId }, h.docker)
  await cleanup(value, { kind: 'home', homeRevision: null }, h.docker)
  assert.deepEqual(h.removed, [backupVolume(record, checkpointId), homeVolume({ ...record, homeRevision: null })])
  assert.deepEqual(await cleanup(value, { kind: 'checkpoint', checkpointId }, fixture({ missing: true }).docker), { removed: false })
})
test('cleanup refuses active, foreign, referenced and unrecorded storage', async () => {
  for (const options of [
    { kind: 'home', homeRevision, staged: true },
    { kind: 'home', homeRevision: checkpointId },
    { kind: 'home', homeRevision: null, staged: true },
    { kind: 'checkpoint', checkpointId: '../home' },
  ]) {
    const h = fixture()
    await assert.rejects(cleanup(value, options, h.docker))
    assert.deepEqual(h.removed, [])
  }
  for (const overrides of [{ owner: 'cmp_other' }, { references: 'stopped-container' }]) {
    const h = fixture(overrides)
    await assert.rejects(cleanup(value, { kind: 'checkpoint', checkpointId }, h.docker))
    assert.deepEqual(h.removed, [])
  }
  await assert.rejects(cleanup(value, { kind: 'home', homeRevision: checkpointId, staged: true }, fixture({ storage: 'legacy' }).docker), /staging/)
})
