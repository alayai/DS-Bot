import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { bundleRuntime, imageRecipe } from '../../computer-runtime/runtime.mjs'

test('installed setup pulls the published digest, refuses substituted IDs and preserves existing pinned images', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cua-published-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'computer-runtime')
  await bundleRuntime(directory)
  const host = join(root, 'src/host/computer')
  await mkdir(host, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  for (const name of ['setup-runtime.js', 'runtime-bundle.js']) {
    await copyFile(new URL(`../src/host/computer/${name}`, import.meta.url), join(host, name))
  }
  const image = `sha256:${'a'.repeat(64)}`
  const reference = `ghcr.io/example/image@sha256:${'b'.repeat(64)}`
  const lock = JSON.parse(await readFile(join(directory, 'runtime.lock.json')))
  Object.assign(lock, { publishedImage: reference, publishedImageId: image,
    publishedImageRecipe: await imageRecipe(directory, lock) })
  await writeFile(join(directory, 'runtime.lock.json'), JSON.stringify(lock))
  // Only the engine boundary is replaced. The installed loader, manifest checks,
  // recipe validation and image compatibility checks run as shipped.
  await writeFile(join(directory, 'engine.mjs'), `
    export const calls = []
    export const state = { image: ${JSON.stringify(image)}, error: null }
    export const discoverEngine = async value => value
    export const validateEngine = () => {}
    export const preparePodmanMachine = async () => {}
    export const buildDesktop = async () => { throw Error('Unexpected local build') }
    export async function runEngineTask(engine, args, options) {
      calls.push({ args, signal: options.signal })
      options.signal?.throwIfAborted()
      if (state.error) throw Error(state.error)
    }
    export async function runEngine(engine, args) {
      calls.push({ args })
      if (args[0] === 'info') return { stdout: JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }) }
      const id = args[2].startsWith('sha256:') ? args[2] : state.image
      return { stdout: JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'amd64',
        Config: { User: '1000:1000', Labels: { 'org.ds-bot.computer.protocol': '1', 'org.ds-bot.computer.driver': '0.37.0' } } }]) }
    }
  `)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')))
  for (const name of ['runtime.lock.json', 'engine.mjs']) manifest.files[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  const { loadSetupRuntime } = await import(pathToFileURL(join(host, 'setup-runtime.js')).href)
  const { calls, state } = await import(pathToFileURL(join(directory, 'engine.mjs')).href)
  const runtime = await loadSetupRuntime()
  const engine = { endpoint: process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock' }
  const controller = new AbortController()
  assert.equal(await runtime.prepare(engine, { signal: controller.signal }), image)
  assert.deepEqual(calls[0], { args: ['pull', reference], signal: controller.signal })
  state.image = `sha256:${'c'.repeat(64)}`
  await assert.rejects(runtime.image(engine), /tested published image ID/)
  assert.equal(await runtime.image(engine, state.image), state.image)
  state.error = 'Registry unavailable'
  await assert.rejects(runtime.prepare(engine, { signal: controller.signal }), /Registry unavailable/)
  controller.abort(new Error('Cancelled download'))
  await assert.rejects(runtime.prepare(engine, { signal: controller.signal }), /Cancelled download/)
})
