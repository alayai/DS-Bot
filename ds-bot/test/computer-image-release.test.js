import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCandidate, verifyCandidate, promoteCandidate } from '../scripts/computer-image-release.mjs'
import { imageRecipe, checkPublishedImage } from '../../computer-runtime/runtime.mjs'

const image = `sha256:${'a'.repeat(64)}`
const reference = `ghcr.io/example/ds-bot/cua-desktop@sha256:${'b'.repeat(64)}`
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cua-image-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'source'), evidence = join(directory, 'evidence')
  await mkdir(evidence)
  for (const name of ['computer-runtime/desktop', 'ds-bot/dev', 'ds-bot/scripts', '.github/workflows']) await mkdir(join(project, name), { recursive: true })
  for (const name of ['runtime.lock.json', 'desktop/Dockerfile', 'desktop/requirements.txt', 'desktop/launch.py']) {
    await copyFile(new URL(`../../computer-runtime/${name}`, import.meta.url), join(project, 'computer-runtime', name))
  }
  for (const name of ['ds-bot/dev/computer-setup-smoke.mjs', 'ds-bot/scripts/computer-image-release.mjs', '.github/workflows/computer-image.yml']) {
    await writeFile(join(project, name), 'fixture')
  }
  const git = args => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull } }).trim()
  git(['init', '-q'])
  git(['add', '.'])
  // This isolated repository is test data, not a development commit.
  git(['-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture'])
  const commit = git(['rev-parse', 'HEAD'])
  const values = {
    'image-build.json': { ready: true, platform: 'linux/amd64', driver: '0.37.0', image },
    'image-pull.json': [{ Id: image, RepoDigests: [reference], Os: 'linux', Architecture: 'amd64',
      Config: { User: '1000:1000', Labels: { 'org.ds-bot.computer.protocol': '1', 'org.ds-bot.computer.driver': '0.37.0' } } }],
    'image-smoke.json': { version: 1, passed: true, image, checks: ['screenshot', 'file-roundtrip', 'checkpoint', 'restart'] },
    'guest-sbom.cdx.json': { bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { version: image } }, components: [{ name: 'fixture' }] },
  }
  const save = (name, value) => writeFile(join(evidence, name), JSON.stringify(value))
  for (const [name, value] of Object.entries(values)) await save(name, value)
  const args = [evidence, 'Example/DS-Bot', commit, { project }]
  return { project, evidence, values, save, args, commit }
}

test('image promotion binds the source recipe, public digest, smoke and inventory without Docker or network', async t => {
  const f = await fixture(t)
  const before = await imageRecipe(join(f.project, 'computer-runtime'))
  const candidate = await recordCandidate(...f.args)
  assert.equal(candidate.recipe, before)
  assert.equal((await verifyCandidate(...f.args)).candidate.image, image)
  await promoteCandidate(...f.args)
  const lock = JSON.parse(await readFile(join(f.project, 'computer-runtime/runtime.lock.json')))
  assert.equal(lock.publishedImage, reference)
  assert.equal(lock.publishedImageId, image)
  assert.equal(lock.publishedImageRecipe, before)
  assert.equal(await imageRecipe(join(f.project, 'computer-runtime')), before)
  await promoteCandidate(...f.args)
  assert.throws(() => checkPublishedImage(lock, `sha256:${'c'.repeat(64)}`), /tested published image/)
  checkPublishedImage(lock, image)
  checkPublishedImage({}, image)
})

test('release recording refuses dirty source or a different source commit and never overwrites evidence', async t => {
  const f = await fixture(t)
  await assert.rejects(recordCandidate(f.evidence, f.args[1], 'f'.repeat(40), f.args[3]), /clean source commit/)
  const launch = join(f.project, 'computer-runtime/desktop/launch.py')
  const original = await readFile(launch)
  await writeFile(launch, 'modified')
  await assert.rejects(recordCandidate(...f.args), /clean source commit/)
  await writeFile(launch, original)
  await recordCandidate(...f.args)
  await assert.rejects(recordCandidate(...f.args), { code: 'EEXIST' })
})

test('promotion refuses stale recipes, changed evidence and unexpected source identity without editing the lock', async t => {
  const f = await fixture(t)
  await recordCandidate(...f.args)
  const lockPath = join(f.project, 'computer-runtime/runtime.lock.json')
  const before = await readFile(lockPath, 'utf8')
  await assert.rejects(promoteCandidate(f.evidence, 'other/repo', f.commit, f.args[3]), /expected repository/)
  await assert.rejects(promoteCandidate(f.evidence, f.args[1], 'f'.repeat(40), f.args[3]), /expected repository/)
  await f.save('image-smoke.json', { ...f.values['image-smoke.json'], passed: false })
  await assert.rejects(promoteCandidate(...f.args), /checksum/)
  await f.save('image-smoke.json', f.values['image-smoke.json'])
  await writeFile(join(f.project, 'computer-runtime/desktop/launch.py'), 'different recipe')
  await assert.rejects(promoteCandidate(...f.args), /different runtime recipe/)
  assert.equal(await readFile(lockPath, 'utf8'), before)
})

test('release recording rejects pull substitutions, incompatible metadata and missing smoke or inventory', async t => {
  const f = await fixture(t)
  const cases = [
    ['image-pull.json', [{ ...f.values['image-pull.json'][0], Id: `sha256:${'c'.repeat(64)}` }], /Anonymous pull/],
    ['image-pull.json', [{ ...f.values['image-pull.json'][0], Architecture: 'arm64' }], /Anonymous pull/],
    ['image-pull.json', [{ ...f.values['image-pull.json'][0], RepoDigests: ['ghcr.io/other/repo@sha256:' + 'b'.repeat(64)] }], /published digest/],
    ['image-build.json', { ...f.values['image-build.json'], ready: false }, /build evidence/],
    ['image-smoke.json', { ...f.values['image-smoke.json'], image: `sha256:${'c'.repeat(64)}` }, /smoke evidence/],
    ['image-smoke.json', { ...f.values['image-smoke.json'], checks: ['screenshot'] }, /smoke evidence/],
    ['guest-sbom.cdx.json', { ...f.values['guest-sbom.cdx.json'], components: [] }, /inventory/],
  ]
  for (const [name, value, error] of cases) {
    await f.save(name, value)
    await assert.rejects(recordCandidate(...f.args), error)
    await f.save(name, f.values[name])
  }
})

test('promotion rejects a substituted candidate image or mutable registry reference even if checksums still match', async t => {
  const f = await fixture(t)
  const candidate = await recordCandidate(...f.args)
  await f.save('image-candidate.json', { ...candidate, image: `sha256:${'c'.repeat(64)}` })
  await assert.rejects(promoteCandidate(...f.args), /image ID/)
  await f.save('image-candidate.json', { ...candidate, publishedImage: 'ghcr.io/example/ds-bot/cua-desktop:latest' })
  await assert.rejects(promoteCandidate(...f.args), /digest-pinned/)
  await f.save('image-candidate.json', { ...candidate, publishedImage: 'ghcr.io/other/repo@sha256:' + 'b'.repeat(64) })
  await assert.rejects(promoteCandidate(...f.args), /another registry/)
})
