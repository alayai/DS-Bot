import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyComputerRuntime } from './runtime-bundle.js'

export async function loadSetupRuntime() {
  // Container CLIs cannot read Electron's virtual ASAR filesystem.
  const directory = fileURLToPath(new URL('../../../computer-runtime/', import.meta.url)).replace(/\.asar([/\\])/g, '.asar.unpacked$1')
  verifyComputerRuntime(directory)
  const runtime = await import(pathToFileURL(join(directory, 'runtime.mjs')).href)
  const { discoverEngine, runEngine, buildDesktop, runEngineTask, validateEngine, preparePodmanMachine } = await import(pathToFileURL(join(directory, 'engine.mjs')).href)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const published = runtime.publishedImage(await runtime.validateLock())
  const recipe = createHash('sha256').update(JSON.stringify(
    ['runtime.lock.json', 'desktop/Dockerfile', 'desktop/requirements.txt', 'desktop/launch.py'].map(name => [name, manifest.files[name]]),
  )).digest('hex')
  const tag = `ds-bot-cua:setup-${recipe.slice(0, 20)}`
  const check = (engine, image) => runtime.checkRuntime(image, args => runEngine(engine, args), {
    platform: process.platform, arch: process.arch, endpoint: engine.endpoint, engine,
  })
  return {
    recipe,
    startRuntime: (engine, options) => preparePodmanMachine(engine, options),
    validate: validateEngine,
    discover: (engine, kind) => discoverEngine(engine, { kind: kind ?? engine?.kind ?? 'docker' }),
    async image(engine, pinned) {
      const metadata = JSON.parse((await runEngine(engine, ['image', 'inspect', pinned ?? published ?? tag])).stdout)[0]
      await check(engine, metadata.Id)
      return metadata.Id
    },
    async prepare(engine, options) {
      if (published) await runEngineTask(engine, ['pull', published], options)
      else await buildDesktop(engine, join(directory, 'desktop'), tag, options)
      return this.image(engine)
    },
    broker: (engine, image) => ({ native: true, entrypoint: join(directory, 'broker/main.mjs'), engine, image }),
  }
}
