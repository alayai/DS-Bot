import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// The desktop lock is the reproducible host baseline, not the machine running npm pack.
export async function candidateBaseline(root) {
  const paths = ['app/package.json', 'app/package-lock.json', 'ds-bot/dev/harness/package.json', 'dsh-bothub/package.json']
  const sources = await Promise.all(paths.map(path => readFile(join(root, path))))
  const [app, lock, harness, hub] = sources.map(bytes => JSON.parse(bytes.toString('utf8')))
  const dsh = app.dependencies['@deepseek-ai/dsh']
  const cordis = app.overrides['@deepseek-ai/cordis']
  for (const [name, version] of [['@deepseek-ai/dsh', dsh], ['@deepseek-ai/cordis', cordis]]) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) throw new Error(`Candidate baseline must pin ${name}`)
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) throw new Error(`Candidate baseline lock mismatch: ${name}`)
  }
  if (lock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] !== dsh
    || harness.dependencies['@deepseek-ai/dsh'] !== dsh) throw new Error('Candidate DSH baseline differs from the app lock or test harness')
  if (hub.peerDependencies['@deepseek-ai/cordis'] !== cordis) throw new Error('BotHub Cordis peer differs from the candidate baseline')
  return {
    dsh, cordis,
    baseline: { kind: 'declared-desktop-lock', sources: paths.map((path, i) => ({
      path, sha256: createHash('sha256').update(sources[i]).digest('hex'),
    })) },
  }
}
