import { createHash } from 'node:crypto'
import { archiveSource } from './image-archive.js'

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const invalid = () => Object.assign(new Error('The desktop release has no compatible verification evidence.'), { unapproved: true })
export function releaseRepository(lock) {
  const source = archiveSource(lock)
  if (!source) throw new Error('This runtime does not configure a desktop release source.')
  return new URL(source.url).pathname.split('/').slice(1, 3).join('/')
}
async function json(url, signal, fetcher, missing = false) {
  const response = await fetcher(url, { signal, credentials: 'omit', redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DS-Bot-desktop-updates' } })
  if (missing && response.status === 404) { await response.body?.cancel(); return null }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error(response.status === 403 || response.status === 429
      ? 'Desktop release checks are rate limited. Try again later.'
      : 'Desktop releases could not be checked. Check the connection and retry.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Desktop release metadata is too large.')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export async function approvedRelease(baseLock, release, { signal, fetcher = fetch } = {}) {
  const repo = releaseRepository(baseLock)
  const source = release?.tag_name?.match(/^cua-desktop-([a-f0-9]{40})$/)?.[1]
  if (!source || release.draft || !Number.isFinite(Date.parse(release.published_at))) throw invalid()
  const api = `https://api.github.com/repos/${repo}`
  const ref = await json(`${api}/git/ref/heads/codex/cua-image-evidence-${source}`, signal, fetcher, true)
  const evidence = ref?.object?.sha
  if (ref?.object?.type !== 'commit' || !sha(evidence)) throw invalid()
  const commit = await json(`${api}/commits/${evidence}`, signal, fetcher)
  if (commit.sha !== evidence || commit.parents?.length !== 1 || commit.parents[0].sha !== source
    || commit.files?.length !== 1 || commit.files[0].filename !== 'computer-runtime/runtime.lock.json'
    || commit.files[0].status !== 'modified') throw invalid()
  const content = await json(`${api}/contents/computer-runtime/runtime.lock.json?ref=${evidence}`, signal, fetcher)
  if (content?.encoding !== 'base64' || !Number.isSafeInteger(content.size) || content.size > 65536
    || typeof content.content !== 'string' || content.content.length > 100000) throw invalid()
  let lock
  try {
    const bytes = Buffer.from(content.content, 'base64')
    if (bytes.length !== content.size) throw invalid()
    lock = JSON.parse(bytes)
    const archive = archiveSource(lock)
    if (archive?.url !== `https://github.com/${repo}/releases/download/${release.tag_name}/desktop-manifest.json`
      || lock.protocolVersion !== baseLock.protocolVersion || lock.platform !== baseLock.platform
      || lock.driver?.version !== baseLock.driver?.version || lock.driver?.sha256 !== baseLock.driver?.sha256) throw invalid()
  } catch { throw invalid() }
  return { id: createHash('sha256').update(JSON.stringify([evidence, lock])).digest('hex'),
    tag: release.tag_name, publishedAt: release.published_at, source, evidence, image: lock.publishedImageId, lock }
}
export async function findImageRelease(lock, { signal, fetcher = fetch } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000)
  const releases = await json(`https://api.github.com/repos/${releaseRepository(lock)}/releases?per_page=20`, signal, fetcher)
  if (!Array.isArray(releases) || releases.length > 20) throw new Error('Invalid desktop release list.')
  for (const release of releases.filter(r => /^cua-desktop-[a-f0-9]{40}$/.test(r?.tag_name ?? '') && !r.draft)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))) {
    try { return await approvedRelease(lock, release, { signal, fetcher }) }
    catch (error) { if (!error.unapproved) throw error }
  }
  return null
}
