import { createHash } from 'node:crypto'
import { mkdir, lstat, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const locks = new Set()
export async function withImageCache(root, work) {
  if (locks.has(root)) throw new Error('The image download cache is busy.')
  locks.add(root)
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory()) throw new Error('Invalid image download cache.')
    return await work()
  } finally { locks.delete(root) }
}
export async function clearImageCache(root) {
  return withImageCache(root, () => rm(join(root, 'archive'), { recursive: true, force: true }))
}
export async function imageCacheState(root) {
  let bytes = 0
  const directory = join(root, 'archive')
  try {
    if (!(await lstat(directory)).isDirectory()) return { bytes: 0 }
    for (const name of await readdir(directory)) {
      if (!/^desktop-image\.part-[0-9]{3}$/.test(name)) continue
      const info = await lstat(join(directory, name))
      if (info.isFile()) bytes += info.size
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { bytes }
}
export async function prepareImageCache(root, identity) {
  const directory = join(root, 'archive')
  let same = false
  try {
    const info = await lstat(directory)
    if (!info.isDirectory()) throw new Error('Invalid image download cache directory.')
    const marker = join(directory, 'identity')
    if (!(await lstat(marker)).isFile()) throw new Error('Invalid image download cache identity.')
    same = (await readFile(marker, 'utf8')) === identity
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!same) {
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'identity'), identity, { flag: 'wx', mode: 0o600 })
  }
  return directory
}
async function digest(path) {
  const hash = createHash('sha256')
  const file = await open(path, 'r')
  try { for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk) }
  finally { await file.close() }
  return hash.digest('hex')
}
export async function downloadPart(path, part, url, { fetcher, signal, progress }) {
  let offset = 0
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('Invalid cached image part.')
    offset = info.size
    if (offset === part.bytes && await digest(path) === part.sha256) { progress(offset, true); return }
    if (offset >= part.bytes) { await rm(path); offset = 0 }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  signal.throwIfAborted()
  const response = await fetcher(url, { signal, credentials: 'omit', ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}) })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error('The desktop image download failed. Retry to resume the download.')
  }
  if (response.status === 206) {
    if (response.headers.get('content-range') !== `bytes ${offset}-${part.bytes - 1}/${part.bytes}`) {
      await response.body.cancel().catch(() => {})
      throw new Error('Invalid desktop image download range.')
    }
  } else if (response.status === 200) offset = 0
  else { await response.body.cancel().catch(() => {}); throw new Error('Unexpected desktop image download response.') }
  const file = await open(path, offset ? 'a' : 'w', 0o600)
  let length = offset
  progress(length, offset > 0)
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      if (length + chunk.length > part.bytes) throw new Error('The desktop image download exceeded its declared size.')
      await file.writeFile(chunk)
      length += chunk.length
      progress(length, false)
    }
    await file.sync()
  } finally { await file.close() }
  signal.throwIfAborted()
  if (length !== part.bytes) throw new Error('The desktop image download was interrupted. Retry to resume the download.')
  if (await digest(path) !== part.sha256) {
    await rm(path)
    throw new Error('Desktop image part checksum mismatch. Retry to download this part again.')
  }
}
