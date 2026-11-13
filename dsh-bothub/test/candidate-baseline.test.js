import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateBaseline } from '../scripts/candidate-baseline.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bothub-baseline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const write = async (path, value) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), JSON.stringify(value))
  }
  const app = { dependencies: { '@deepseek-ai/dsh': '1.2.3-rc.4' }, overrides: { '@deepseek-ai/cordis': '4.2.3' } }
  const lock = { packages: { '': { dependencies: app.dependencies }, 'node_modules/@deepseek-ai/dsh': { version: '1.2.3-rc.4' }, 'node_modules/@deepseek-ai/cordis': { version: '4.2.3' } } }
  await write('app/package.json', app)
  await write('app/package-lock.json', lock)
  await write('ds-bot/dev/harness/package.json', { dependencies: app.dependencies })
  await write('dsh-bothub/package.json', { peerDependencies: app.overrides })
  return { root, write, app, lock }
}

test('candidate derives versions from the locked host and fingerprints its evidence', async t => {
  const { root } = await fixture(t)
  const result = await candidateBaseline(root)
  assert.equal(result.dsh, '1.2.3-rc.4')
  assert.equal(result.cordis, '4.2.3')
  assert.equal(result.baseline.sources.length, 4)
  assert.match(result.baseline.sources[0].sha256, /^[a-f0-9]{64}$/)
})

for (const fault of ['lock', 'harness', 'peer', 'range']) test(`candidate rejects ${fault} drift before packaging`, async t => {
  const { root, write, app, lock } = await fixture(t)
  if (fault === 'lock') {
    lock.packages['node_modules/@deepseek-ai/dsh'].version = '0.0.1'
    await write('app/package-lock.json', lock)
  } else if (fault === 'harness') await write('ds-bot/dev/harness/package.json', { dependencies: { '@deepseek-ai/dsh': '0.0.1' } })
  else if (fault === 'peer') await write('dsh-bothub/package.json', { peerDependencies: { '@deepseek-ai/cordis': '4.0.5' } })
  else { app.dependencies['@deepseek-ai/dsh'] = '^1.2.3'; await write('app/package.json', app) }
  await assert.rejects(candidateBaseline(root), /baseline|peer/i)
})

test('repository candidate baseline agrees with the checked-in host and peer lock', async () => {
  const root = new URL('../../', import.meta.url)
  const result = await candidateBaseline(fileURLToPath(root))
  const hub = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.equal(hub.packages[''].peerDependencies['@deepseek-ai/cordis'], result.cordis)
})
