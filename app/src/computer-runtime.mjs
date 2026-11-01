import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

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
    throw new Error('Computer runtime is incompatible with this app.')
  }
  return { entrypoint: join(directory, 'broker', 'main.mjs'), manifest }
}

const hasControls = value => [...value].some(character => character.codePointAt(0) < 32)

function linuxPath(path, distribution) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  return execFileSync('wsl.exe', ['--distribution', distribution, '--exec', '/usr/bin/wslpath', '-a', '-u', path], {
    env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16384,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function bundledComputerConfig(computer, {
  runtimeDir = process.env.DS_BOT_RUNTIME_DIR, platform = process.platform, arch = process.arch,
  toLinuxPath = linuxPath,
} = {}) {
  if (computer.broker.bundled !== true) return computer
  if (!runtimeDir) throw new Error('The bundled Computer runtime directory is unavailable.')
  if (computer.broker.entrypoint !== undefined) throw new Error('Choose either the bundled Computer runtime or an explicit Broker entrypoint.')
  if (platform !== 'win32' && (platform !== 'linux' || arch !== 'x64')) throw new Error('Bundled Computers require Linux x64 or Windows with WSL.')
  if (!/^sha256:[a-f0-9]{64}$/.test(computer.broker.image ?? '')) throw new Error('The bundled Computer runtime requires an immutable local image ID.')
  const runtime = verifyComputerRuntime(join(runtimeDir, 'computer-runtime'))
  let entrypoint = runtime.entrypoint
  if (platform === 'win32' && computer.broker.native !== true) {
    const wsl = computer.broker.wsl
    if (!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(wsl?.distribution ?? '')
      || !posix.isAbsolute(wsl?.node ?? '') || hasControls(wsl.node)) {
      throw new Error('Configure a WSL distribution and an absolute Linux Node path.')
    }
    entrypoint = toLinuxPath(entrypoint, wsl.distribution)
    if (!posix.isAbsolute(entrypoint) || hasControls(entrypoint)) throw new Error('WSL did not return a valid Computer runtime path.')
  }
  const { bundled: _bundled, ...broker } = computer.broker
  return { ...computer, broker: { ...broker, entrypoint } }
}
