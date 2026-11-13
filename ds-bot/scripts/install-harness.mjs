// Running npm in the target directory avoids installing the caller as a local dependency.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.npm_execpath) throw new Error('Use npm run harness')
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'install',
  '--legacy-peer-deps=false', '--include=optional', '--no-package-lock', '--no-fund', '--no-audit', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../dev/harness/', import.meta.url)), stdio: 'inherit', windowsHide: true,
})
if (result.error) console.error(`harness: ${result.error.message}`)
process.exitCode = result.status ?? 1
