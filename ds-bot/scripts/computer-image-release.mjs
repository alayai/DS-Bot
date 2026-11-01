import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageRecipe, publishedImage } from '../../computer-runtime/runtime.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const evidenceFiles = ['image-build.json', 'image-pull.json', 'image-smoke.json', 'guest-sbom.cdx.json']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const smokeChecks = ['screenshot', 'file-roundtrip', 'checkpoint', 'restart']
function identity(repository, commit) {
  if (typeof repository !== 'string' || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(repository)
    || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('An explicit GitHub owner/repository and full source commit are required.')
  return repository.toLowerCase()
}
async function evidence(directory) {
  const hashes = {}, values = {}
  for (const name of evidenceFiles) {
    const path = join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error(`Invalid release evidence file: ${name}`)
    const bytes = await readFile(path)
    hashes[name] = digest(bytes)
    values[name] = JSON.parse(bytes)
  }
  return { hashes, values }
}
function validateEvidence(values, reference, lock) {
  const build = values['image-build.json']
  const pulled = values['image-pull.json']
  const smoke = values['image-smoke.json']
  const sbom = values['guest-sbom.cdx.json']
  if (!build || build.ready !== true || !imageId(build.image)
    || build.platform !== lock.platform || build.driver !== lock.driver.version) throw new Error('Invalid image build evidence.')
  const image = Array.isArray(pulled) && pulled.length === 1 ? pulled[0] : null
  if (image?.Id !== build.image || image.Os !== 'linux' || image.Architecture !== 'amd64'
    || image.Config?.User !== '1000:1000'
    || image.Config?.Labels?.['org.ds-bot.computer.protocol'] !== String(lock.protocolVersion)
    || image.Config?.Labels?.['org.ds-bot.computer.driver'] !== lock.driver.version
    || !Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(reference)) {
    throw new Error('Anonymous pull evidence does not match the tested image and registry digest.')
  }
  if (smoke?.version !== 1 || smoke.passed !== true || smoke.image !== build.image
    || JSON.stringify(smoke.checks) !== JSON.stringify(smokeChecks)) throw new Error('Desktop smoke evidence is missing or belongs to another image.')
  if (sbom?.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5'
    || sbom.metadata?.component?.version !== build.image
    || !Array.isArray(sbom.components) || sbom.components.length === 0) throw new Error('Package inventory does not match the tested image.')
  return build.image
}
export async function recordCandidate(directory, repository, commit, { project = root } = {}) {
  repository = identity(repository, commit)
  const inputs = ['computer-runtime', 'ds-bot/dev/computer-setup-smoke.mjs',
    'ds-bot/scripts/computer-image-release.mjs', '.github/workflows/computer-image.yml']
  const git = args => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git(['rev-parse', 'HEAD']) !== commit
    || git(['status', '--porcelain', '--untracked-files=all', '--', ...inputs])) throw new Error('Record candidates only from the clean source commit used by CI.')
  // A clean untracked/ignored directory is not evidence of committed sources.
  for (const path of ['computer-runtime/runtime.lock.json', 'computer-runtime/desktop/Dockerfile',
    'computer-runtime/desktop/requirements.txt', 'computer-runtime/desktop/launch.py', ...inputs.slice(1)]) {
    git(['ls-files', '--error-unmatch', path])
  }
  const lock = JSON.parse(await readFile(join(project, 'computer-runtime/runtime.lock.json'), 'utf8'))
  const { hashes, values } = await evidence(directory)
  const refs = values['image-pull.json']?.[0]?.RepoDigests
  const prefix = `ghcr.io/${repository}/cua-desktop@sha256:`
  const matches = Array.isArray(refs) ? [...new Set(refs.filter(value => typeof value === 'string' && value.startsWith(prefix)))] : []
  if (matches.length !== 1) throw new Error('Expected exactly one published digest for this repository.')
  const reference = publishedImage({ publishedImage: matches[0] })
  const image = validateEvidence(values, reference, lock)
  const candidate = { version: 1, repository, commit, recipe: await imageRecipe(join(project, 'computer-runtime'), lock),
    image, publishedImage: reference, evidence: hashes }
  await writeFile(join(directory, 'image-candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' })
  return candidate
}
export async function verifyCandidate(directory, repository, commit, { project = root } = {}) {
  repository = identity(repository, commit)
  const candidateFile = join(directory, 'image-candidate.json')
  const stat = await lstat(candidateFile)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid image candidate file.')
  const candidate = JSON.parse(await readFile(candidateFile, 'utf8'))
  if (candidate?.version !== 1 || candidate.repository !== repository || candidate.commit !== commit
    || !imageId(candidate.image)) throw new Error('Candidate does not match the expected repository and commit.')
  const reference = publishedImage(candidate)
  if (!reference?.startsWith(`ghcr.io/${repository}/cua-desktop@sha256:`)) throw new Error('Candidate belongs to another registry repository.')
  const lockPath = join(project, 'computer-runtime/runtime.lock.json')
  if (!(await lstat(lockPath)).isFile() || (await lstat(lockPath)).isSymbolicLink()) throw new Error('Invalid runtime lock file.')
  const original = await readFile(lockPath, 'utf8')
  const lock = JSON.parse(original)
  if (candidate.recipe !== await imageRecipe(join(project, 'computer-runtime'), lock)) throw new Error('Candidate was built from a different runtime recipe.')
  const { hashes, values } = await evidence(directory)
  if (!candidate.evidence || Object.keys(candidate.evidence).length !== evidenceFiles.length
    || evidenceFiles.some(name => candidate.evidence[name] !== hashes[name])) throw new Error('Release evidence checksum mismatch.')
  if (validateEvidence(values, reference, lock) !== candidate.image) throw new Error('Candidate image ID does not match release evidence.')
  delete lock.publishedArchive
  return { candidate, original, lockPath, lock: { ...lock, publishedImage: reference,
    publishedImageId: candidate.image, publishedImageRecipe: candidate.recipe } }
}
export async function promoteCandidate(directory, repository, commit, options) {
  const result = await verifyCandidate(directory, repository, commit, options)
  const temporary = `${result.lockPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(result.lock, null, 2)}\n`, { flag: 'wx' })
    if (await readFile(result.lockPath, 'utf8') !== result.original) throw new Error('Runtime lock changed during promotion.')
    await rename(temporary, result.lockPath)
  } finally { await rm(temporary, { force: true }) }
  return result.candidate
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, repository, commit, ...extra] = process.argv.slice(2)
    if (!directory || !repository || !commit || extra.length || !['record', 'verify', 'promote'].includes(command)) {
      throw new Error('Usage: node ds-bot/scripts/computer-image-release.mjs record|verify|promote EVIDENCE_DIRECTORY OWNER/REPOSITORY SOURCE_COMMIT')
    }
    const result = command === 'record' ? await recordCandidate(directory, repository, commit)
      : command === 'promote' ? await promoteCandidate(directory, repository, commit)
        : (await verifyCandidate(directory, repository, commit)).candidate
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
