import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function loadSetupRuntime() {
  // Container CLIs cannot read Electron's virtual ASAR filesystem.
  const directory = fileURLToPath(new URL('../../../computer-runtime/', import.meta.url)).replace(/\.asar([/\\])/g, '.asar.unpacked$1')
  const runtime = await import('../../../computer-runtime/runtime.mjs')
  await runtime.verifyBundle(directory)
  const { discoverEngine, runEngine, buildDesktop, validateEngine } = await import('../../../computer-runtime/engine.mjs')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const recipe = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex')
  const tag = `ds-bot-cua:setup-${recipe.slice(0, 20)}`
  const check = (engine, image) => runtime.checkRuntime(image, args => runEngine(engine, args), {
    platform: process.platform, arch: process.arch, endpoint: engine.endpoint,
  })
  return {
    recipe,
    validate: validateEngine,
    discover: engine => discoverEngine(engine),
    async image(engine, pinned) {
      const metadata = JSON.parse((await runEngine(engine, ['image', 'inspect', pinned ?? tag])).stdout)[0]
      await check(engine, metadata.Id)
      return metadata.Id
    },
    async prepare(engine, options) {
      await buildDesktop(engine, join(directory, 'desktop'), tag, options)
      return this.image(engine)
    },
    broker: (engine, image) => ({ native: true, entrypoint: join(directory, 'broker/main.mjs'), engine, image }),
  }
}
