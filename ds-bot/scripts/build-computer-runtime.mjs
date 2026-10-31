import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepareComputerRuntime } from '../../app/scripts/prepare-computer-runtime.mjs'
import { verifyBundle } from '../../computer-runtime/runtime.mjs'

const output = fileURLToPath(new URL('../', import.meta.url))
if (process.argv.includes('--check')) {
  const directory = fileURLToPath(new URL('../computer-runtime/', import.meta.url))
  await verifyBundle(directory)
  const manifest = JSON.parse(await readFile(new URL('../computer-runtime/manifest.json', import.meta.url)))
  const { createHash } = await import('node:crypto')
  for (const [name, digest] of Object.entries(manifest.files)) {
    const source = new URL(['LICENSE', 'NOTICE'].includes(name) ? `../../${name}` : `../../computer-runtime/${name}`, import.meta.url)
    const actual = createHash('sha256').update(await readFile(source)).digest('hex')
    if (actual !== digest) throw new Error(`Bundled Computer runtime is stale: ${name}. Run npm run build.`)
  }
} else {
  await prepareComputerRuntime({ output })
}
