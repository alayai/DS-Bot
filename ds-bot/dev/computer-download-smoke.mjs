// Real local HTTP Range interruption and Docker archive round-trip, isolated test image.
// The small test image exercises transport/import, not desktop compatibility.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { packImageArchive, archiveLock } from '../scripts/computer-image-archive.mjs'
import { loadImageArchive } from '../src/host/computer/image-archive.js'
import { imageCacheState } from '../src/host/computer/image-cache.js'
import { discoverEngine, runEngineTask } from '../../computer-runtime/engine.mjs'
const run = promisify(execFile)
const home = await mkdtemp(join(tmpdir(), '.dsh-test-cua-download-'))
let image, server
try {
  await writeFile(join(home, 'payload'), randomBytes(2 * 1024 ** 2))
  await run('tar', ['-cf', join(home, 'root.tar'), '-C', home, 'payload'])
  image = (await run('docker', ['import', join(home, 'root.tar')])).stdout.trim()
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  await run('docker', ['save', '--output', join(home, 'image.tar'), image])
  const archive = join(home, 'image.tar.gz')
  await pipeline(createReadStream(join(home, 'image.tar')), createGzip(), createWriteStream(archive, { flags: 'wx' }))
  const parts = join(home, 'parts')
  await packImageArchive(archive, parts, image)
  const lock = await archiveLock(join(parts, 'desktop-manifest.json'), 'fixture/repo', 'f'.repeat(40))
  const requests = [], controller = new AbortController()
  let interrupt = true
  server = createServer(async (req, res) => {
    try {
      const name = req.url.slice(1)
      if (name !== 'desktop-manifest.json' && !/^desktop-image\.part-\d{3}$/.test(name)) { res.writeHead(404).end(); return }
      const path = join(parts, name), size = (await stat(path)).size
      const start = req.headers.range ? Number(req.headers.range.match(/^bytes=(\d+)-$/)?.[1]) : 0
      if (!Number.isSafeInteger(start) || start >= size) { res.writeHead(416).end(); return }
      if (name !== 'desktop-manifest.json') requests.push(start)
      res.writeHead(start ? 206 : 200, { 'Content-Length': size - start, ...(start ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}) })
      if (interrupt && name !== 'desktop-manifest.json') {
        res.write((await readFile(path)).subarray(0, 128 * 1024))
        const timer = setTimeout(() => controller.abort(Error('test interruption')), 150)
        res.on('close', () => clearTimeout(timer))
        return
      }
      createReadStream(path, { start }).pipe(res)
    } catch { res.destroy() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const fetcher = (url, options) => {
    assert.ok(String(url).startsWith(lock.publishedArchive.url.slice(0, -'desktop-manifest.json'.length)))
    return fetch(`http://127.0.0.1:${server.address().port}/${new URL(url).pathname.split('/').at(-1)}`, options)
  }
  const cacheRoot = join(home, 'cache'), engine = await discoverEngine()
  await assert.rejects(loadImageArchive(engine, lock, { cacheRoot, signal: controller.signal }, { fetcher, task: runEngineTask }), /test interruption|abort/i)
  assert.equal((await imageCacheState(cacheRoot)).bytes, 128 * 1024)
  await run('docker', ['image', 'rm', image])
  interrupt = false
  const result = await loadImageArchive(engine, lock, { cacheRoot }, { fetcher, task: runEngineTask })
  assert.equal(result, image)
  assert.deepEqual(requests, [0, 128 * 1024])
  assert.equal((await imageCacheState(cacheRoot)).bytes, 0)
  assert.equal(JSON.parse((await run('docker', ['image', 'inspect', image])).stdout)[0].Id, image)
  console.log(`PASS: real HTTP interruption retained 131072 bytes, resumed with Range, verified archive SHA-256 and loaded original Docker image ${image}`)
  console.log(`Archive SHA-256: ${createHash('sha256').update(await readFile(archive)).digest('hex')}`)
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (image) await run('docker', ['image', 'rm', image]).catch(() => {})
  await rm(home, { recursive: true, force: true })
}
