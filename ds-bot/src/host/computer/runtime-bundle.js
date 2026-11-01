import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Version 1 is a closed inventory. Changing it requires updating the bundle contract.
const FILES = [
  'runtime.mjs', 'runtime.lock.json', 'engine.mjs', 'podman.mjs', 'README.md', 'TOOL_POLICY.md', 'LICENSE', 'NOTICE',
  'broker/main.mjs', 'broker/boundary.mjs', 'broker/checkpoint.mjs', 'broker/checkpoint.py',
  'broker/files.py', 'broker/input.mjs', 'broker/rfb.mjs', 'broker/release-input.py', 'broker/mcp.mjs',
  'desktop/Dockerfile', 'desktop/requirements.txt', 'desktop/launch.py',
  'desktop/inventory.py', 'licenses/cua-MIT.txt',
].sort()

function regular(root, name) {
  let path = root
  const parts = name.split('/')
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    const info = lstatSync(path)
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Computer runtime contains an invalid file: ${name}`)
    }
  }
  return path
}

export function verifyComputerRuntime(directory) {
  const manifestPath = regular(directory, 'manifest.json')
  if (lstatSync(manifestPath).size > 16384) throw new Error('Computer runtime manifest is too large.')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== 1 || manifest.algorithm !== 'sha256' || !manifest.files
    || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(FILES)) {
    throw new Error('Computer runtime has an unsupported manifest.')
  }
  for (const name of FILES) {
    const path = regular(directory, name)
    if (lstatSync(path).size > 2 * 1024 * 1024
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== manifest.files[name]) {
      throw new Error(`Computer runtime integrity check failed: ${name}`)
    }
  }
  const lock = JSON.parse(readFileSync(join(directory, 'runtime.lock.json'), 'utf8'))
  if (lock.protocolVersion !== 1 || lock.platform !== 'linux/amd64' || lock.driver?.version !== '0.37.0') {
    throw new Error('Computer runtime is incompatible with this plugin.')
  }
  return { entrypoint: join(directory, 'broker', 'main.mjs'), manifest }
}
