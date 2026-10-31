import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleRuntime, verifyBundle, checkRuntime, inventoryImage, publishedImage, runtimeText } from '../../computer-runtime/runtime.mjs'
import { verifyComputerRuntime } from '../src/host/computer/runtime-bundle.js'

test('standalone runtime bundle verifies its inventory and refuses overwrites or modified payloads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-bundle-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const output = join(dir, 'runtime')
  await bundleRuntime(output)
  assert.equal((await verifyBundle(output)).verified, true)
  assert.ok(verifyComputerRuntime(output).entrypoint.endsWith('broker/main.mjs'))
  await assert.rejects(bundleRuntime(output), { code: 'EEXIST' })
  await writeFile(join(output, 'broker/files.py'), 'tampered')
  await assert.rejects(verifyBundle(output), /integrity/)
  assert.throws(() => verifyComputerRuntime(output), /integrity/)
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json')))
  manifest.files['../escape'] = 'a'.repeat(64)
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(verifyBundle(output), /unexpected file list/)
})
test('runtime check is read-only and rejects incompatible images', async () => {
  const image = `sha256:${'a'.repeat(64)}`
  const calls = []
  let user = '1000:1000'
  const execute = async args => {
    calls.push(args)
    if (args[0] === 'context') return { stdout: 'unix:///var/run/docker.sock' }
    if (args[0] === 'info') return { stdout: JSON.stringify({ OSType: 'linux', Architecture: 'x86_64', ServerVersion: 'fixture' }) }
    return { stdout: JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64', Config: { User: user, Labels: {
      'org.ds-bot.computer.protocol': '1', 'org.ds-bot.computer.driver': '0.37.0',
    } } }]) }
  }
  const environment = { platform: 'linux', arch: 'x64' }
  assert.equal((await checkRuntime(image, execute, environment)).ready, true)
  assert.deepEqual(calls.map(args => args[0]), ['context', 'info', 'image'])
  user = 'root'
  await assert.rejects(checkRuntime(image, execute, environment), /does not match/)
  await assert.rejects(checkRuntime('mutable:tag', execute, environment), /immutable/)
  await assert.rejects(checkRuntime(image, execute, { platform: 'win32', arch: 'x64' }), /named pipe/)
})


test('runtime verification refuses a substituted symlink even when its bytes match', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cua-bundle-link-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const output = join(dir, 'runtime')
  await bundleRuntime(output)
  const target = join(output, 'broker/files.py')
  const substitute = join(dir, 'files.py')
  await writeFile(substitute, await readFile(target))
  await rm(target)
  await symlink(substitute, target)
  await assert.rejects(verifyBundle(output), /Invalid runtime file/)
})

test('guest inventory uses an offline bounded container and cleans it after malformed output', { skip: process.platform !== 'linux' }, async () => {
  const image = `sha256:${'a'.repeat(64)}`
  const calls = []
  const execute = async args => {
    calls.push(args)
    if (args[0] === 'context') return { stdout: 'unix:///var/run/docker.sock' }
    if (args[0] === 'info') return { stdout: JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }) }
    if (args[0] === 'image') return { stdout: JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64', Config: { User: '1000:1000', Labels: { 'org.ds-bot.computer.protocol': '1', 'org.ds-bot.computer.driver': '0.37.0' } } }]) }
    return { stdout: 'broken' }
  }
  await assert.rejects(inventoryImage(image, execute))
  const run = calls.find(args => args[0] === 'run')
  assert.equal(run[run.indexOf('--network') + 1], 'none')
  assert.ok(run.includes('--read-only'))
  assert.ok(!run.includes('--mount'))
  assert.deepEqual(calls.at(-1), ['rm', '-f', run[run.indexOf('--name') + 1]])
})


test('published desktop images require immutable registry digests and retain local-build fallback', () => {
  assert.equal(publishedImage({}), null)
  const reference = `ghcr.io/owner/project/cua-desktop@sha256:${'a'.repeat(64)}`
  assert.equal(publishedImage({ publishedImage: reference }), reference)
  for (const published of ['ghcr.io/owner/image:latest', 'https://remote/image', 'docker.io/owner/image@sha256:' + 'a'.repeat(64), '', null]) {
    assert.throws(() => publishedImage({ publishedImage: published }), /digest-pinned/)
  }
})


test('runtime payload text and recipe keys are independent of Windows checkout line endings', () => {
  const linux = Buffer.from('FROM pinned@sha256:fixture\nUSER 1000:1000\n')
  const windows = Buffer.from('FROM pinned@sha256:fixture\r\nUSER 1000:1000\r\n')
  assert.deepEqual(runtimeText(windows), linux)
  assert.deepEqual(runtimeText(linux), linux)
})
