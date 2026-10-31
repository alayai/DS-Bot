import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { bundledComputerConfig, verifyComputerRuntime } from '../src/computer-runtime.mjs'
import { prepareComputerRuntime } from '../scripts/prepare-computer-runtime.mjs'
import { bundleRuntime } from '../../computer-runtime/runtime.mjs'

const image = `sha256:${'a'.repeat(64)}`
async function setup(t) {
  const output = await mkdtemp(join(tmpdir(), 'dsbot-pack-computer-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  await prepareComputerRuntime({ output })
  return { output, directory: join(output, 'computer-runtime') }
}
test('packaging includes a verified standalone runtime and is idempotent', async t => {
  const { output, directory } = await setup(t)
  assert.equal(verifyComputerRuntime(directory).entrypoint, join(directory, 'broker', 'main.mjs'))
  assert.equal((await prepareComputerRuntime({ output })).changed, false)
  const config = { enabled: true, maxRunning: 1, broker: { bundled: true, image } }
  const resolved = bundledComputerConfig(config, { runtimeDir: output, platform: 'linux', arch: 'x64' })
  assert.equal(resolved.broker.entrypoint, join(directory, 'broker', 'main.mjs'))
  assert.equal(resolved.broker.bundled, undefined)
  assert.equal(config.broker.bundled, true)
  assert.equal(resolved.maxRunning, 1)
  assert.throws(() => bundledComputerConfig(config, { runtimeDir: output, platform: 'darwin' }), /require Linux/)
})
test('Windows bundled config translates only the verified packaged path through its selected WSL distribution', async t => {
  const { output, directory } = await setup(t)
  const config = { enabled: true, broker: { bundled: true, image, wsl: { distribution: 'Ubuntu-24.04', node: '/home/test/node/bin/node' } } }
  let calls = 0
  const options = { runtimeDir: output, platform: 'win32', toLinuxPath: (path, distribution) => {
    calls++
    assert.equal(path, join(directory, 'broker', 'main.mjs'))
    assert.equal(distribution, 'Ubuntu-24.04')
    return '/mnt/c/Program Files/DS Bot/resources/computer-runtime/broker/main.mjs'
  } }
  assert.match(bundledComputerConfig(config, options).broker.entrypoint, /Program Files/)
  assert.equal(calls, 1)
  assert.throws(() => bundledComputerConfig({ ...config, broker: { ...config.broker, entrypoint: '/injected' } }, options), /either/)
  assert.throws(() => bundledComputerConfig(config, { ...options, toLinuxPath: () => '/valid\n/another' }), /valid Computer runtime path/)
  config.broker.wsl.distribution = 'Ubuntu;command'
  assert.throws(() => bundledComputerConfig(config, options), /Configure a WSL/)
})
test('incomplete and tampered payloads fail before launch; failed preparation retains the previous payload', async t => {
  const { output, directory } = await setup(t)
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8')
  await assert.rejects(prepareComputerRuntime({ output }, async staged => {
    await bundleRuntime(staged)
    await writeFile(join(staged, 'broker', 'main.mjs'), 'modified')
  }), /integrity/)
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), manifest)
  verifyComputerRuntime(directory)
  await mkdir(join(output, '.computer-runtime.prepare.lock'))
  await assert.rejects(prepareComputerRuntime({ output }), { code: 'EEXIST' })
  await rm(join(output, '.computer-runtime.prepare.lock'), { recursive: true })
  await rm(join(directory, 'broker', 'files.py'))
  assert.throws(() => verifyComputerRuntime(directory), /ENOENT/)
  assert.equal((await prepareComputerRuntime({ output })).changed, true)
  verifyComputerRuntime(directory)
})
test('payload verification refuses symlinks and unexpected manifest paths', async t => {
  const { output, directory } = await setup(t)
  const main = join(directory, 'broker', 'main.mjs')
  const external = join(output, 'outside.mjs')
  await writeFile(external, await readFile(main))
  await rm(main)
  try { await symlink(external, main) } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation is unavailable.'); return } throw error }
  assert.throws(() => verifyComputerRuntime(directory), /invalid file/)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  manifest.files['../outside.mjs'] = 'a'.repeat(64)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  assert.throws(() => verifyComputerRuntime(directory), /unsupported manifest/)
})

test('the configured extraResources payload resolves outside the checkout without importing source files', async t => {
  const { output } = await setup(t)
  const config = parse(await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const resource = config.extraResources.find(item => item.to === 'computer-runtime')
  assert.equal(resource.from, 'build/runtime/computer-runtime')
  const resources = join(output, 'packaged', 'resources')
  await mkdir(resources, { recursive: true })
  await cp(join(output, 'computer-runtime'), join(resources, resource.to), { recursive: true })
  const checker = join(output, 'packaged', 'checker.mjs')
  await cp(new URL('../src/computer-runtime.mjs', import.meta.url), checker)
  const outside = await import(pathToFileURL(checker).href)
  const result = outside.bundledComputerConfig({ enabled: true, broker: { bundled: true, image } }, { runtimeDir: resources, platform: 'linux', arch: 'x64' })
  assert.equal(result.broker.entrypoint, join(resources, 'computer-runtime', 'broker', 'main.mjs'))
  outside.verifyComputerRuntime(join(resources, 'computer-runtime'))
})
