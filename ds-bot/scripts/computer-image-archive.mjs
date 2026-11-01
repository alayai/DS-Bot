import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageRecipe } from '../../computer-runtime/runtime.mjs'
import { archiveSource, archiveManifest } from '../src/host/computer/image-archive.js'

const PART_BYTES = 256 * 1024 ** 2
export async function packImageArchive(archive, directory, image) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('An immutable tested image ID is required.')
  await mkdir(directory)
  const parts = []
  let file, hash, bytes = 0, total = 0
  try {
    for await (const buffer of createReadStream(archive, { highWaterMark: 1024 * 1024 })) {
      for (let offset = 0; offset < buffer.length;) {
        if (!file) {
          if (parts.length >= 32) throw new Error('Desktop archive exceeds 8 GiB.')
          const name = `desktop-image.part-${String(parts.length).padStart(3, '0')}`
          file = await open(join(directory, name), 'wx')
          parts.push({ name })
          hash = createHash('sha256'); bytes = 0
        }
        const chunk = buffer.subarray(offset, offset + Math.min(buffer.length - offset, PART_BYTES - bytes))
        await file.writeFile(chunk)
        hash.update(chunk); bytes += chunk.length; total += chunk.length; offset += chunk.length
        if (bytes === PART_BYTES) {
          await file.close(); file = null
          Object.assign(parts.at(-1), { bytes, sha256: hash.digest('hex') })
        }
      }
    }
    if (file) {
      await file.close(); file = null
      Object.assign(parts.at(-1), { bytes, sha256: hash.digest('hex') })
    }
    if (!parts.length) throw new Error('Desktop archive is empty.')
    const manifest = { version: 1, image, recipe: await imageRecipe(), platform: 'linux/amd64', compression: 'gzip', bytes: total, parts }
    const text = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(join(directory, 'desktop-manifest.json'), text, { flag: 'wx' })
    return { manifest, sha256: createHash('sha256').update(text).digest('hex') }
  } finally { await file?.close() }
}
export async function archiveLock(manifestFile, repository, commit) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)
    || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('A repository and full source commit are required.')
  const bytes = await readFile(manifestFile)
  const manifest = JSON.parse(bytes)
  if (manifest.recipe !== await imageRecipe()) throw new Error('Desktop archive recipe differs from the current source.')
  const lock = JSON.parse(await readFile(new URL('../../computer-runtime/runtime.lock.json', import.meta.url)))
  delete lock.publishedImage
  Object.assign(lock, { publishedArchive: {
    url: `https://github.com/${repository}/releases/download/cua-desktop-${commit}/desktop-manifest.json`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }, publishedImageId: manifest.image, publishedImageRecipe: manifest.recipe })
  archiveManifest(bytes, archiveSource(lock), lock)
  return lock
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (args.length !== 3 || !['pack', 'lock'].includes(command)) throw new Error('Usage: computer-image-archive.mjs pack ARCHIVE NEW_DIRECTORY IMAGE_ID | lock MANIFEST REPOSITORY COMMIT')
    console.log(JSON.stringify(command === 'pack' ? await packImageArchive(...args) : await archiveLock(...args), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
