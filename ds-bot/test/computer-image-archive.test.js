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
