import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { packImageArchive, archiveLock } from '../scripts/computer-image-archive.mjs'
import { loadImageArchive } from '../src/host/computer/image-archive.js'
import { runEngineTask } from '../../computer-runtime/engine.mjs'

// Network substitution is restricted to this test fixture. Archive validation,
// Docker load, image checks, registration and migration use production code.
export async function releaseFixture(directory, image, tools) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Choose a local immutable fixture image.')
  const archive = join(directory, 'fixture.tar.gz')
  const child = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'inherit'] })
  const saved = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Fixture export failed.')))
  })
  await Promise.all([saved, pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(archive, { flags: 'wx' }))])
  const parts = join(directory, 'release')
  const packed = await packImageArchive(archive, parts, image)
  const lock = await archiveLock(join(parts, 'desktop-manifest.json'), 'fixture/repo', 'a'.repeat(40))
  const candidate = { id: packed.sha256, image, lock, tag: `cua-desktop-${'a'.repeat(40)}`,
    evidence: 'b'.repeat(40), publishedAt: '2026-11-01T00:00:00Z' }
  return {
    ...tools,
    findRelease: async () => candidate,
    prepareRelease: (engine, selected, options) => loadImageArchive(engine, selected.lock, options, {
      task: runEngineTask,
      fetcher: async url => {
        if (!String(url).startsWith(lock.publishedArchive.url.slice(0, -'desktop-manifest.json'.length))) throw new Error('Unexpected fixture URL.')
        const name = new URL(url).pathname.split('/').at(-1)
        if (name !== 'desktop-manifest.json' && !/^desktop-image\.part-\d{3}$/.test(name)) throw new Error('Unexpected fixture part.')
        return new Response(createReadStream(join(parts, name)))
      },
    }),
  }
}
