import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { archiveSource, archiveManifest, loadImageArchive } from '../src/host/computer/image-archive.js'
import { packImageArchive, archiveLock } from '../scripts/computer-image-archive.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cua-archive-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('fixture docker archive, never executed')
  const part = { name: 'desktop-image.part-000', bytes: bytes.length, sha256: hash(bytes) }
  const image = `sha256:${'a'.repeat(64)}`
  const recipe = 'b'.repeat(64)
  const manifest = Buffer.from(JSON.stringify({ version: 1, image, recipe, platform: 'linux/amd64', compression: 'gzip', bytes: bytes.length, parts: [part] }))
  const lock = { publishedImageId: image, publishedImageRecipe: recipe, publishedArchive: {
    url: `https://github.com/example/repo/releases/download/cua-desktop-${'c'.repeat(40)}/desktop-manifest.json`, sha256: hash(manifest),
  } }
  const loads = []
  const deps = { temporaryRoot: root, capacity: async () => ({ bavail: 10 ** 9, bsize: 1 }),
    fetcher: async (url, options) => {
      assert.equal(options.credentials, 'omit')
      options.signal.throwIfAborted()
      return new Response(url.endsWith('desktop-manifest.json') ? manifest : bytes)
    },
    task: async (engine, args) => {
      assert.deepEqual(args.slice(0, 2), ['load', '--input'])
      loads.push(await readFile(args[2]))
    } }
  return { root, bytes, manifest, lock, deps, loads }
}

test('archive is fully checked before engine load and temporary bytes are removed', async t => {
  const h = await fixture(t)
  assert.equal(await loadImageArchive({}, h.lock, {}, h.deps), h.lock.publishedImageId)
  assert.deepEqual(h.loads, [h.bytes])
  assert.deepEqual(await readdir(h.root), [])
})

test('tampered, truncated, oversized and failed downloads never reach the engine', async t => {
  for (const kind of ['manifest', 'tampered', 'truncated', 'oversized', 'offline']) {
    const h = await fixture(t)
    h.deps.fetcher = async url => {
      if (kind === 'offline') throw Error('offline')
      if (url.endsWith('desktop-manifest.json')) return new Response(kind === 'manifest' ? Buffer.from('{}') : h.manifest)
      return new Response(kind === 'tampered' ? Buffer.alloc(h.bytes.length) : kind === 'truncated' ? h.bytes.subarray(1) : Buffer.concat([h.bytes, Buffer.from('extra')]))
    }
    await assert.rejects(loadImageArchive({}, h.lock, {}, h.deps))
    assert.equal(h.loads.length, 0)
    assert.deepEqual(await readdir(h.root), [])
  }
})

test('disk exhaustion, engine errors and abort clean downloads without silently building an image', async t => {
  for (const kind of ['space', 'abort', 'engine']) {
    const h = await fixture(t)
    const controller = new AbortController()
    if (kind === 'space') h.deps.capacity = async () => ({ bavail: 0, bsize: 1 })
    if (kind === 'engine') h.deps.task = async () => { throw Error('engine failed') }
    const original = h.deps.fetcher
    if (kind === 'abort') h.deps.fetcher = async (url, options) => {
      const response = await original(url, options)
      if (!url.endsWith('desktop-manifest.json')) controller.abort(Error('cancelled'))
      return response
    }
    await assert.rejects(loadImageArchive({}, h.lock, { signal: controller.signal }, h.deps),
      kind === 'space' ? /disk space/ : kind === 'abort' ? /cancelled/ : /engine failed/)
    assert.equal(h.loads.length, 0)
    assert.deepEqual(await readdir(h.root), [])
  }
})

test('archive evidence rejects source substitution, traversal and mismatched identities', async t => {
  const h = await fixture(t)
  assert.throws(() => archiveSource({ ...h.lock, publishedImage: 'another registry' }))
  assert.throws(() => archiveSource({ ...h.lock, publishedArchive: { ...h.lock.publishedArchive, url: 'https://other.example/image' } }))
  for (const change of [
    value => { value.image = `sha256:${'d'.repeat(64)}` },
    value => { value.parts[0].name = '../other' },
    value => { value.parts[0] = null },
    value => { value.bytes++ },
    value => { value.parts[0].bytes = 300 * 1024 ** 2 },
  ]) {
    const value = JSON.parse(h.manifest)
    change(value)
    const bytes = Buffer.from(JSON.stringify(value))
    assert.throws(() => archiveManifest(bytes, { sha256: hash(bytes) }, h.lock))
  }
})

test('publication packer produces a lock that the installer accepts with the current recipe', async t => {
  const h = await fixture(t)
  const source = join(h.root, 'source.tar.gz')
  const directory = join(h.root, 'release')
  await writeFile(source, h.bytes)
  const packed = await packImageArchive(source, directory, h.lock.publishedImageId)
  const lock = await archiveLock(join(directory, 'desktop-manifest.json'), 'example/repo', 'c'.repeat(40))
  assert.equal(archiveManifest(await readFile(join(directory, 'desktop-manifest.json')), archiveSource(lock), lock).bytes, h.bytes.length)
  assert.equal(packed.sha256, lock.publishedArchive.sha256)
  assert.deepEqual(await readFile(join(directory, 'desktop-image.part-000')), h.bytes)
  await assert.rejects(archiveLock(join(directory, 'desktop-manifest.json'), '../bad', 'c'.repeat(40)))
  await assert.rejects(packImageArchive(source, directory, h.lock.publishedImageId), { code: 'EEXIST' })
})

test('blocked release pages fall back to the official asset API with unchanged hash checks', async t => {
  for (const corrupt of [false, true]) {
    const h = await fixture(t), urls = []
    h.deps.fetcher = async (url, options) => {
      urls.push(url)
      assert.equal(options.credentials, 'omit')
      if (url.startsWith('https://github.com/')) throw new Error('blocked release page')
      assert.ok(url.startsWith('https://api.github.com/repos/example/repo/releases/'))
      if (url.includes('/tags/')) {
        assert.equal(options.redirect, 'error')
        return Response.json({ tag_name: `cua-desktop-${'c'.repeat(40)}`, assets: [
          { id: 1, name: 'desktop-manifest.json' }, { id: 2, name: 'desktop-image.part-000' },
        ] })
      }
      assert.equal(options.headers.Accept, 'application/octet-stream')
      return new Response(url.endsWith('/1') ? h.manifest : corrupt ? Buffer.alloc(h.bytes.length) : h.bytes)
    }
    if (corrupt) await assert.rejects(loadImageArchive({}, h.lock, {}, h.deps), /checksum/)
    else assert.equal(await loadImageArchive({}, h.lock, {}, h.deps), h.lock.publishedImageId)
    assert.equal(h.loads.length, corrupt ? 0 : 1)
    assert.equal(urls.filter(url => url.startsWith('https://github.com/')).length, 1)
    assert.equal(urls.filter(url => url.includes('/tags/')).length, 1)
    assert.deepEqual(await readdir(h.root), [])
  }
})

test('a cancelled partial download resumes with Range, verifies bytes and clears cache on success', async t => {
  const h = await fixture(t), cacheRoot = join(h.root, 'cache')
  let first = true
  const controller = new AbortController(), requests = []
  h.deps.fetcher = async (url, options) => {
    if (url.endsWith('.json')) return new Response(h.manifest)
    requests.push(options.headers?.Range)
    if (first) {
      first = false
      return new Response(new ReadableStream({
        async start(stream) {
          stream.enqueue(h.bytes.subarray(0, 8))
          await new Promise(resolve => setTimeout(resolve, 30))
          controller.abort(Error('cancelled'))
          stream.error(Error('cancelled'))
        },
      }))
    }
    assert.equal(options.headers.Range, 'bytes=8-')
    return new Response(h.bytes.subarray(8), { status: 206, headers: { 'Content-Range': `bytes 8-${h.bytes.length - 1}/${h.bytes.length}` } })
  }
  await assert.rejects(loadImageArchive({}, h.lock, { cacheRoot, signal: controller.signal }, h.deps), /cancelled/)
  assert.equal(h.loads.length, 0)
  assert.deepEqual(await readFile(join(cacheRoot, 'archive/desktop-image.part-000')), h.bytes.subarray(0, 8))
  await loadImageArchive({}, h.lock, { cacheRoot }, h.deps)
  assert.deepEqual(requests, [undefined, 'bytes=8-'])
  assert.deepEqual(h.loads, [h.bytes])
  assert.deepEqual(await readdir(cacheRoot), [])
})

test('completed cached parts are rehashed, reused after engine failure, and corrupted parts are downloaded again', async t => {
  for (const corrupt of [false, true]) {
    const h = await fixture(t), cacheRoot = join(h.root, 'cache')
    const task = h.deps.task
    h.deps.task = async () => { throw Error('engine offline') }
    await assert.rejects(loadImageArchive({}, h.lock, { cacheRoot }, h.deps), /engine offline/)
    const path = join(cacheRoot, 'archive/desktop-image.part-000')
    if (corrupt) await writeFile(path, Buffer.alloc(h.bytes.length))
    let downloads = 0
    const fetcher = h.deps.fetcher
    h.deps.fetcher = (url, opts) => { if (!url.endsWith('.json')) downloads++; return fetcher(url, opts) }
    h.deps.task = task
    await loadImageArchive({}, h.lock, { cacheRoot }, h.deps)
    assert.equal(downloads, corrupt ? 1 : 0)
    assert.deepEqual(h.loads, [h.bytes])
  }
})

test('ignored Range restarts one part while malformed ranges and corrupt resumed bytes never load', async t => {
  const { prepareImageCache } = await import('../src/host/computer/image-cache.js')
  const { mkdir } = await import('node:fs/promises')
  for (const kind of ['ignored', 'wrong-range', 'corrupt']) {
    const h = await fixture(t), cacheRoot = join(h.root, 'cache')
    await mkdir(cacheRoot)
    const cache = await prepareImageCache(cacheRoot, h.lock.publishedArchive.sha256)
    await writeFile(join(cache, 'desktop-image.part-000'), h.bytes.subarray(0, 8))
    h.deps.fetcher = async (url, opts) => {
      if (url.endsWith('.json')) return new Response(h.manifest)
      assert.equal(opts.headers.Range, 'bytes=8-')
      if (kind === 'ignored') return new Response(h.bytes)
      return new Response(kind === 'corrupt' ? Buffer.alloc(h.bytes.length - 8) : h.bytes.subarray(8), {
        status: 206, headers: { 'Content-Range': `bytes ${kind === 'wrong-range' ? 9 : 8}-${h.bytes.length - 1}/${h.bytes.length}` },
      })
    }
    if (kind === 'ignored') { await loadImageArchive({}, h.lock, { cacheRoot }, h.deps); assert.deepEqual(h.loads, [h.bytes]) }
    else { await assert.rejects(loadImageArchive({}, h.lock, { cacheRoot }, h.deps), /range|checksum/); assert.equal(h.loads.length, 0) }
  }
})

test('API fallback preserves byte ranges and a new release discards the old cache', async t => {
  const { mkdir } = await import('node:fs/promises')
  const { prepareImageCache, imageCacheState, clearImageCache, withImageCache } = await import('../src/host/computer/image-cache.js')
  const h = await fixture(t), cacheRoot = join(h.root, 'cache')
  await mkdir(cacheRoot)
  let directory = await prepareImageCache(cacheRoot, 'old-release')
  await writeFile(join(directory, 'desktop-image.part-000'), Buffer.from('old'))
  directory = await prepareImageCache(cacheRoot, h.lock.publishedArchive.sha256)
  assert.deepEqual(await readdir(directory), ['identity'])
  await writeFile(join(directory, 'desktop-image.part-000'), h.bytes.subarray(0, 8))
  assert.equal((await imageCacheState(cacheRoot)).bytes, 8)
  await withImageCache(cacheRoot, async () => { await assert.rejects(clearImageCache(cacheRoot), /busy/) })
  h.deps.fetcher = async (url, options) => {
    if (url.startsWith('https://github.com/')) throw Error('blocked')
    if (url.includes('/tags/')) {
      assert.equal(options.headers.Range, undefined)
      return Response.json({ tag_name: `cua-desktop-${'c'.repeat(40)}`, assets: [
        { id: 1, name: 'desktop-manifest.json' }, { id: 2, name: 'desktop-image.part-000' },
      ] })
    }
    if (url.endsWith('/1')) return new Response(h.manifest)
    assert.equal(options.headers.Range, 'bytes=8-')
    return new Response(h.bytes.subarray(8), { status: 206, headers: { 'Content-Range': `bytes 8-${h.bytes.length - 1}/${h.bytes.length}` } })
  }
  await loadImageArchive({}, h.lock, { cacheRoot }, h.deps)
  assert.deepEqual(h.loads, [h.bytes])
  await clearImageCache(cacheRoot)
  assert.equal((await imageCacheState(cacheRoot)).bytes, 0)
})
