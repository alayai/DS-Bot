import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_ARCHIVE = 8 * 1024 ** 3
const MAX_PART = 256 * 1024 ** 2
const URL_PATTERN = /^https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)\/releases\/download\/(cua-desktop-[a-f0-9]{40})\/desktop-manifest\.json$/
export function archiveSource(lock) {
  if (lock.publishedArchive === undefined) return null
  const value = lock.publishedArchive
  if (!value || !URL_PATTERN.test(value.url ?? '') || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    || lock.publishedImage !== undefined || !/^sha256:[a-f0-9]{64}$/.test(lock.publishedImageId ?? '')
    || !/^[a-f0-9]{64}$/.test(lock.publishedImageRecipe ?? '')) throw new Error('Invalid published desktop archive.')
  return { url: value.url, sha256: value.sha256 }
}
export function archiveManifest(bytes, source, lock) {
  if (bytes.length > 65536 || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Desktop archive manifest checksum mismatch.')
  const value = JSON.parse(bytes)
  if (!value || value.version !== 1 || value.image !== lock.publishedImageId || value.recipe !== lock.publishedImageRecipe
    || value.platform !== 'linux/amd64' || value.compression !== 'gzip'
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_ARCHIVE
    || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 32
    || value.parts.some((part, index) => !part || part.name !== `desktop-image.part-${String(index).padStart(3, '0')}`
      || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > MAX_PART || !/^[a-f0-9]{64}$/.test(part.sha256 ?? ''))
    || value.parts.reduce((sum, part) => sum + part.bytes, 0) !== value.bytes) throw new Error('Desktop archive does not match the tested image.')
  return value
}
async function receive(url, limit, { signal, fetcher, consume }) {
  const response = await fetcher(url, { signal, credentials: 'omit' })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error('The desktop image download failed. Check the connection and retry.')
  }
  let length = 0
  for await (const chunk of response.body) {
    signal?.throwIfAborted()
    length += chunk.length
    if (length > limit) {
      throw new Error('The desktop image download exceeded its declared size.')
    }
    await consume(chunk)
  }
  return length
}
export async function loadImageArchive(engine, lock, options = {}, {
  fetcher = fetch, task, temporaryRoot = tmpdir(), capacity = statfs,
} = {}) {
  const source = archiveSource(lock)
  if (!source) throw new Error('No published desktop archive is configured.')
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45 * 60_000)]) : AbortSignal.timeout(45 * 60_000)
  const pieces = []
  await receive(source.url, 65536, { signal, fetcher, consume: chunk => pieces.push(Buffer.from(chunk)) })
  const manifest = archiveManifest(Buffer.concat(pieces), source, lock)
  const space = await capacity(temporaryRoot)
  if (space.bavail * space.bsize < manifest.bytes + 512 * 1024 ** 2) throw new Error('Free temporary disk space before downloading the desktop image.')
  const directory = await mkdtemp(join(temporaryRoot, 'dsbot-image-'))
  try {
    const path = join(directory, 'desktop-image.tar.gz')
    const file = await open(path, 'wx', 0o600)
    let total = 0
    let reported = 0
    try {
      for (const part of manifest.parts) {
        signal.throwIfAborted()
        const hash = createHash('sha256')
        options.log?.(`Downloading desktop image: ${total} / ${manifest.bytes} bytes\n`)
        const length = await receive(new URL(part.name, source.url).href, part.bytes, { signal, fetcher, consume: async chunk => {
          hash.update(chunk)
          await file.writeFile(chunk)
          total += chunk.length
          if (total - reported >= 16 * 1024 ** 2) {
            options.log?.(`Downloading desktop image: ${total} / ${manifest.bytes} bytes\n`)
            reported = total
          }
        } })
        if (length !== part.bytes || hash.digest('hex') !== part.sha256) throw new Error('Desktop image part checksum mismatch. No image was loaded.')
      }
      await file.sync()
    } finally { await file.close() }
    signal.throwIfAborted()
    options.log?.(`Verified ${total} bytes. Loading the tested desktop image into the selected engine.\n`)
    await task(engine, ['load', '--input', path], { ...options, signal })
    return lock.publishedImageId
  } finally { await rm(directory, { recursive: true, force: true }) }
}
