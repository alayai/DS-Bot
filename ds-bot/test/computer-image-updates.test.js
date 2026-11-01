import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { findImageRelease } from '../src/host/computer/image-releases.js'
import { createImageUpdates } from '../src/host/computer/image-updates.js'

const image = `sha256:${'a'.repeat(64)}`
const next = `sha256:${'b'.repeat(64)}`
const source = 'c'.repeat(40), evidence = 'd'.repeat(40)
const tag = `cua-desktop-${source}`
const lock = {
  protocolVersion: 1, platform: 'linux/amd64', driver: { version: '0.37.0', sha256: 'e'.repeat(64) },
  publishedArchive: { url: `https://github.com/owner/repo/releases/download/${tag}/desktop-manifest.json`, sha256: 'a'.repeat(64) },
  publishedImageId: next, publishedImageRecipe: 'f'.repeat(64),
}
function releaseFixture(change = () => {}) {
  const data = {
    releases: [{ tag_name: tag, published_at: '2026-11-01T00:00:00Z', draft: false }],
    ref: { object: { type: 'commit', sha: evidence } },
    commit: { sha: evidence, parents: [{ sha: source }], files: [{ filename: 'computer-runtime/runtime.lock.json', status: 'modified' }] },
    lock: structuredClone(lock),
  }
  change(data)
  const urls = []
  const fetcher = async (url, options) => {
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    urls.push(url)
    let value
    if (url.includes('/releases?')) value = data.releases
    else if (url.includes('/git/ref/')) value = data.ref
    else if (url.includes('/commits/')) value = data.commit
    else {
      assert.ok(url.endsWith(`?ref=${evidence}`))
      const bytes = Buffer.from(JSON.stringify(data.lock))
      value = { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }
    }
    return new Response(JSON.stringify(value), { status: value ? 200 : 404 })
  }
  return { fetcher, urls }
}
test('image checks accept only compatible immutable release evidence from the configured repository', async () => {
  const h = releaseFixture()
  const candidate = await findImageRelease(lock, h)
  assert.equal(candidate.image, next)
  assert.equal(candidate.evidence, evidence)
  assert.ok(h.urls.every(url => url.startsWith('https://api.github.com/repos/owner/repo/')))
  for (const change of [
    d => { d.ref = null },
    d => { d.commit.parents[0].sha = '0'.repeat(40) },
    d => { d.commit.files.push({ filename: 'another-file' }) },
    d => { d.lock.platform = 'linux/arm64' },
    d => { d.lock.driver.version = '1.0' },
    d => { d.lock.publishedArchive.url = d.lock.publishedArchive.url.replace('owner/repo', 'attacker/repo') },
    d => { d.lock.publishedArchive.sha256 = 'invalid' },
    d => { d.releases[0].draft = true },
  ]) assert.equal(await findImageRelease(lock, releaseFixture(change)), null)
})
test('rate limits and connection failures are not reported as no updates', async () => {
  await assert.rejects(findImageRelease(lock, { fetcher: async () => new Response('', { status: 403 }) }), /rate limited/)
  await assert.rejects(findImageRelease(lock, { fetcher: async () => { throw new Error('offline') } }), /offline/)
})
const until = async read => {
  for (let i = 0; i < 1000; i++) { if (await read()) return; await delay(2) }
  assert.fail('Image task did not settle')
}
function updatesFixture(t) {
  const data = { config: { engine: {}, image } }, saved = [], calls = []
  const candidate = { id: 'checked', image: next, tag, evidence, lock }
  let download
  const tools = {
    findRelease: async () => candidate,
    prepareRelease: async (_engine, value, options) => {
      assert.equal(value, candidate)
      calls.push('download')
      if (download) await download(options)
    },
    image: async (_engine, id) => { assert.equal(id, next); calls.push('verify') },
  }
  const manager = createImageUpdates({
    load: async () => {}, data: () => data, save: async () => { saved.push(structuredClone(data)) }, writable: () => {},
    payload: async () => tools, available: () => true,
    service: () => ({ registerImage: async id => {
      assert.ok(saved.at(-1).config.images.includes(id))
      calls.push('register')
    } }),
  })
  t.after(() => manager.dispose())
  return { manager, data, saved, calls, tools, download: fn => { download = fn }, settle: () => until(async () => !(await manager.state()).busy) }
}
test('download verifies and persists a prepared pin without changing the current image', async t => {
  const h = updatesFixture(t)
  await h.manager.check()
  await h.settle()
  await assert.rejects(h.manager.download({ candidateId: 'stale' }), /again/)
  await h.manager.download({ candidateId: 'checked' })
  await h.settle()
  assert.deepEqual(h.calls, ['download', 'verify', 'register'])
  assert.equal(h.data.config.image, image)
  assert.deepEqual(h.data.config.images, [next])
  assert.equal((await h.manager.state()).job.phase, 'prepared')
  await h.manager.check()
  await h.settle()
  assert.equal((await h.manager.state()).job.phase, 'prepared')
})
test('cancelled or incompatible downloads never register or persist a new pin', async t => {
  const h = updatesFixture(t)
  h.download(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
  await h.manager.check()
  await h.settle()
  const started = await h.manager.download({ candidateId: 'checked' })
  await until(() => h.calls.includes('download'))
  await assert.rejects(h.manager.check(), /already running/)
  await assert.rejects(h.manager.cancel({ jobId: 'stale' }), /changed/)
  await h.manager.cancel({ jobId: started.job.id })
  await h.settle()
  assert.equal((await h.manager.state()).job.phase, 'cancelled')
  assert.equal(h.data.config.images, undefined)
  assert.deepEqual(h.calls, ['download'])
  h.download(() => { throw new Error('checksum mismatch') })
  await h.manager.download({ candidateId: 'checked' })
  await h.settle()
  assert.equal((await h.manager.state()).job.phase, 'failed')
  assert.equal(h.data.config.images, undefined)
})


test('a failed new check invalidates the previous selection; incompatible images stay unregistered', async t => {
  const h = updatesFixture(t)
  await h.manager.check()
  await h.settle()
  h.tools.image = async () => { throw new Error('incompatible image') }
  await h.manager.download({ candidateId: 'checked' })
  await h.settle()
  assert.equal((await h.manager.state()).job.phase, 'failed')
  assert.equal(h.data.config.images, undefined)
  assert.equal(h.calls.includes('register'), false)
  h.tools.findRelease = async () => { throw new Error('offline') }
  await h.manager.check()
  await h.settle()
  await assert.rejects(h.manager.download({ candidateId: 'checked' }), /again/)
  assert.equal((await h.manager.state()).canDownload, false)
})
