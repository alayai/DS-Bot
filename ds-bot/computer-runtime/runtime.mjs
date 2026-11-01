import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLocalEndpoint } from './broker/boundary.mjs'
import { validatePodman } from './podman.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const run = promisify(execFile)
const docker = args => run('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
const payload = [
  'runtime.mjs', 'runtime.lock.json', 'engine.mjs', 'podman.mjs', 'README.md', 'TOOL_POLICY.md',
  'broker/main.mjs', 'broker/boundary.mjs', 'broker/checkpoint.mjs', 'broker/checkpoint.py',
  'broker/files.py', 'broker/transfers.mjs', 'broker/input.mjs', 'broker/rfb.mjs', 'broker/release-input.py', 'broker/mcp.mjs',
  'desktop/Dockerfile', 'desktop/requirements.txt', 'desktop/launch.py',
  'desktop/inventory.py', 'licenses/cua-MIT.txt',
]
// The closed inventory is UTF-8 text. Git's Windows checkout conversion must
// not change the published payload hashes or the recipe cache key.
export const runtimeText = bytes => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')

export async function imageRecipe(directory = root, lock) {
  const source = { ...(lock ?? JSON.parse(await readFile(join(directory, 'runtime.lock.json'), 'utf8'))) }
  // Publication metadata cannot be part of the recipe it identifies.
  for (const name of ['publishedImage', 'publishedImageId', 'publishedImageRecipe']) delete source[name]
  const inputs = [['runtime.lock.json', JSON.stringify(source)]]
  for (const name of ['desktop/Dockerfile', 'desktop/requirements.txt', 'desktop/launch.py']) {
    inputs.push([name, createHash('sha256').update(runtimeText(await readFile(join(directory, name)))).digest('hex')])
  }
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

export function publishedImage(lock) {
  if (lock.publishedImage === undefined) return null
  if (typeof lock.publishedImage !== 'string'
    || !/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9/._-]*@sha256:[a-f0-9]{64}$/.test(lock.publishedImage)) {
    throw new Error('The published desktop image must be a digest-pinned GHCR reference.')
  }
  return lock.publishedImage
}
export function checkPublishedImage(lock, image) {
  if (lock.publishedImageId && image !== lock.publishedImageId) throw new Error('The downloaded image does not match the tested published image ID.')
}
export async function validateLock() {
  const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'))
  publishedImage(lock)
  const recipe = (await readFile(join(root, 'desktop/Dockerfile'), 'utf8')).replace(/\r\n/g, '\n')
  const requirements = await readFile(join(root, 'desktop/requirements.txt'), 'utf8')
  if (lock.platform !== 'linux/amd64' || lock.protocolVersion !== 1
    || !recipe.includes(`FROM ${lock.baseImage}\n`)
    || !recipe.includes(`cua-driver ${lock.driver.version}`)
    || !requirements.includes(lock.driver.sha256) || !requirements.includes(`cua-driver==${lock.driver.version}`)) {
    throw new Error('Runtime recipe does not match runtime.lock.json.')
  }
  if (lock.publishedImageId !== undefined || lock.publishedImageRecipe !== undefined) {
    if (!lock.publishedImage || !/^sha256:[a-f0-9]{64}$/.test(lock.publishedImageId ?? '')
      || lock.publishedImageRecipe !== await imageRecipe(root, lock)) {
      throw new Error('Published image evidence does not match this runtime recipe.')
    }
  }
  return lock
}
export async function checkRuntime(image, execute = docker, environment = { platform: process.platform, arch: process.arch }) {
  const lock = await validateLock()
  if (!['linux', 'win32'].includes(environment.platform) || environment.arch !== 'x64') throw new Error('Run this command on Linux x64 or Windows x64.')
  if (image && !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Use an immutable local image ID (sha256:64 hex characters).')
  const endpoint = environment.endpoint ?? (await execute(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim()
  // Environment overrides take precedence over the selected Docker context.
  if (environment.engine?.kind === 'podman') validatePodman(environment.engine, environment.platform)
  else assertLocalEndpoint(endpoint, environment.platform)
  if (!environment.endpoint && process.env.DOCKER_HOST) assertLocalEndpoint(process.env.DOCKER_HOST, environment.platform)
  const info = JSON.parse((await execute(['info', '--format', '{{json .}}'])).stdout)
  if (info.OSType !== 'linux' || !['x86_64', 'amd64'].includes(info.Architecture)) throw new Error('A local Linux x64 Docker Engine is required.')
  if (image) {
    const item = JSON.parse((await execute(['image', 'inspect', image])).stdout)[0]
    if (item?.Id !== image || item.Os !== 'linux' || item.Architecture !== 'amd64'
      || item.Config?.User !== '1000:1000'
      || item.Config?.Labels?.['org.ds-bot.computer.protocol'] !== String(lock.protocolVersion)
      || item.Config?.Labels?.['org.ds-bot.computer.driver'] !== lock.driver.version) throw new Error('The local image does not match this runtime.')
  }
  return { ready: true, platform: lock.platform, driver: lock.driver.version, dockerVersion: info.ServerVersion, image: image ?? null }
}
export async function bundleRuntime(destination) {
  const output = resolve(destination)
  await validateLock()
  // Exclusive directory creation prevents replacing an operator's existing deployment.
  await mkdir(output)
  try {
    const files = {}
    for (const name of [...payload, 'LICENSE', 'NOTICE']) {
      let source = join(root, name)
      if (['LICENSE', 'NOTICE'].includes(name)) {
        try { await readFile(source) } catch (error) { if (error.code !== 'ENOENT') throw error; source = resolve(root, '..', name) }
      }
      const target = join(output, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, runtimeText(await readFile(source)))
      files[name] = createHash('sha256').update(await readFile(target)).digest('hex')
    }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ version: 1, algorithm: 'sha256', files }, null, 2)}\n`)
    return { output, files: Object.keys(files).length, entrypoint: join(output, 'broker/main.mjs') }
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error }
}
export async function verifyBundle(directory) {
  async function regular(name) {
    let path = directory
    for (const [index, part] of name.split('/').entries()) {
      path = join(path, part)
      const info = await lstat(path)
      if (info.isSymbolicLink() || (index < name.split('/').length - 1 ? !info.isDirectory() : !info.isFile()) || info.size > 2 * 1024 * 1024) throw new Error(`Invalid runtime file: ${name}`)
    }
    return path
  }
  await regular('manifest.json')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.algorithm !== 'sha256' || !manifest.files) throw new Error('Invalid runtime manifest.')
  const expected = [...payload, 'LICENSE', 'NOTICE'].sort()
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)) throw new Error('Runtime manifest has an unexpected file list.')
  for (const name of expected) {
    const hash = createHash('sha256').update(await readFile(await regular(name))).digest('hex')
    if (hash !== manifest.files[name]) throw new Error(`Runtime integrity check failed: ${name}`)
  }
  return { verified: true, files: expected.length }
}
export async function inventoryImage(image, execute = docker) {
  if (!image) throw new Error('An immutable image ID is required for inventory.')
  await checkRuntime(image, execute)
  const name = `dsbot-inventory-${randomUUID()}`
  const code = await readFile(join(root, 'desktop/inventory.py'), 'utf8')
  try {
    const result = await execute(['run', '--rm', '--name', name, '--read-only', '--user', '1000:1000',
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '32',
      '--entrypoint', '/opt/venv/bin/python3', image, '-c', code])
    const components = JSON.parse(result.stdout)
    if (!Array.isArray(components) || components.length > 20000) throw new Error('Invalid guest package inventory.')
    return { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, serialNumber: `urn:uuid:${randomUUID()}`,
      metadata: { component: { type: 'container', name: 'ds-bot-cua', version: image },
        properties: [{ name: 'dsbot:scope', value: 'Installed dpkg and Python packages. License evidence is not a distribution approval.' }] }, components }
  } finally { await execute(['rm', '-f', name]).catch(() => {}) }
}
async function buildImage() {
  await checkRuntime()
  const lock = await validateLock()
  const tag = `ds-bot-cua:${lock.driver.version}`
  console.error('Building the pinned desktop image; Docker progress follows.')
  await new Promise((accept, reject) => {
    const child = spawn('docker', ['build', '--platform', lock.platform, '--progress=plain', '-t', tag, join(root, 'desktop')], { stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Docker build exited with ${code}.`)))
  })
  const image = (await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).stdout.trim()
  return checkRuntime(image)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, argument, ...extra] = process.argv.slice(2)
    if (extra.length) throw new Error('Unexpected arguments.')
    let result
    if (command === 'check') result = await checkRuntime(argument)
    else if (command === 'inventory' && argument) result = await inventoryImage(argument)
    else if (command === 'build' && !argument) result = await buildImage()
    else if (command === 'bundle' && argument) result = await bundleRuntime(argument)
    else if (command === 'verify' && argument) result = await verifyBundle(argument)
    else throw new Error('Usage: node runtime.mjs check [image-id] | build | bundle NEW_DIRECTORY | verify DIRECTORY | inventory IMAGE_ID')
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
