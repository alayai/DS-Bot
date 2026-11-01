import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quotaArguments, probeHomeQuota, assertVolume } from '../../computer-runtime/broker/boundary.mjs'

test('quota options are Podman-only and managed homes require exact volume metadata', () => {
  const bytes = 4 * 1024 ** 3
  assert.deepEqual(quotaArguments(undefined, { kind: 'docker' }), [])
  assert.throws(() => quotaArguments(bytes, { kind: 'docker' }), /cannot enforce/)
  assert.throws(() => quotaArguments(0.5, { kind: 'podman' }))
  assert.ok(quotaArguments(bytes, { kind: 'podman' }).includes(`o=size=${bytes}`))
  const value = { volume: 'managed', record: { id: 'id', homeQuotaBytes: bytes } }
  const data = { Name: 'managed', Driver: 'local', Options: { o: `size=${bytes}` },
    Labels: { 'org.ds-bot.computer.id': 'id', 'org.ds-bot.computer.quota': String(bytes) } }
  assertVolume(data, value)
  assert.throws(() => assertVolume({ ...data, Options: {} }, value))
  assert.throws(() => assertVolume(data, { ...value, record: { id: 'id' } }))
  const backup = { ...data, Options: {}, Labels: { 'org.ds-bot.computer.id': 'id', 'org.ds-bot.computer.storage': 'checkpoint' } }
  assert.throws(() => assertVolume(backup, value))
  const name = `dsbot-id-backup-${'a'.repeat(36)}`
  assertVolume({ ...backup, Name: name }, { ...value, volume: name })
})

test('kernel quota probe requires EDQUOT evidence and cleans only its labelled resources', async () => {
  for (const mode of ['enforced', 'unsupported', 'interrupted-create', 'foreign']) {
    let volume, removed = false
    const calls = []
    const docker = async args => {
      calls.push(args)
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (!volume) throw Object.assign(Error('missing'), { stderr: 'no such volume' })
        return { stdout: JSON.stringify([volume]) }
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        const label = args[args.indexOf('--label') + 1].split('=')
        volume = { Name: args.at(-1), Labels: { [label[0]]: mode === 'foreign' ? 'not-ours' : label[1] } }
        assert.ok(args.includes('nocopy'))
        if (mode === 'interrupted-create') throw Error('result lost')
        return { stdout: volume.Name }
      }
      if (args[0] === 'inspect') throw Object.assign(Error('removed helper'), { stderr: 'no such object' })
      if (args[0] === 'run') {
        assert.match(args.at(-1), /errno.EDQUOT/)
        assert.ok(args.includes('none'))
        assert.ok(!args.includes('--privileged'))
        if (mode === 'unsupported') throw Error('The volume size was not enforced by the kernel.')
        return { stdout: JSON.stringify({ enforced: true, backend: 'podman-xfs' }) }
      }
      if (args[0] === 'volume' && args[1] === 'rm') { removed = true; return {} }
      assert.fail(`Unexpected ${args}`)
    }
    const operation = probeHomeQuota(docker, `sha256:${'a'.repeat(64)}`, { kind: 'podman' })
    if (mode === 'enforced') assert.equal((await operation).enforced, true)
    else await assert.rejects(operation)
    assert.equal(removed, mode !== 'foreign')
    assert.ok(!calls.some(args => args[0] === 'rm'))
  }
})
