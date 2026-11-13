import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('harness installer runs npm in the harness, includes native optionals and forwards CI overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stub = join(root, 'npm stub.mjs')
  await writeFile(stub, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); process.exitCode=17\n')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/install-harness.mjs', import.meta.url)),
    '--no-save', '@deepseek-ai/dsh@0.2.0-rc.2'], { cwd: root, env: { ...process.env, npm_execpath: stub }, encoding: 'utf8' })
  assert.equal(result.status, 17, result.stderr)
  const invocation = JSON.parse(result.stdout)
  assert.equal(invocation.cwd.toLowerCase(), fileURLToPath(new URL('../dev/harness', import.meta.url)).toLowerCase())
  assert.deepEqual(invocation.args, ['install', '--legacy-peer-deps=false', '--include=optional', '--no-package-lock', '--no-fund', '--no-audit', '--no-save', '@deepseek-ai/dsh@0.2.0-rc.2'])
  const manifest = JSON.parse(await readFile(new URL('../dev/harness/package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.optionalDependencies['@oxlint/binding-win32-x64-msvc'], manifest.dependencies.oxlint)
  assert.equal(manifest.dependencies['ds-bot'], undefined, 'installing the harness must not add the caller as a dependency')
})
