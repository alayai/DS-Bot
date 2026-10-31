import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, isAbsolute, win32 } from 'node:path'
import { promisify } from 'node:util'
import { assertLocalEndpoint } from './broker/boundary.mjs'

const exec = promisify(execFile)
const ENV = ['PATH', 'HOME', 'LANG', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'DOCKER_CONFIG']

export function engineEnvironment(engine, source = process.env) {
  const env = Object.fromEntries(ENV.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
  if (engine?.endpoint) env.DOCKER_HOST = engine.endpoint
  return env
}

export function validateEngine(engine, platform = process.platform) {
  if (engine?.kind !== 'docker' || typeof engine.executable !== 'string'
    || /[\x00-\x1f]/.test(engine.executable)
    || !(engine.executable === 'docker' || engine.executable === 'docker.exe'
      || ((platform === 'win32' ? win32.isAbsolute(engine.executable) : isAbsolute(engine.executable))
        && /(?:^|[/\\])docker(?:\.exe)?$/.test(engine.executable)))
    || typeof engine.id !== 'string' || !engine.id || engine.id.length > 200 || /[\x00-\x20]/.test(engine.id)) {
    throw new Error('Invalid saved desktop engine. Restore its original configuration.')
  }
  assertLocalEndpoint(engine.endpoint, platform)
  return engine
}

export function dockerExecutable(platform = process.platform) {
  if (platform !== 'win32') return 'docker'
  const paths = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
  ]
  return paths.find(path => path && existsSync(path)) ?? 'docker.exe'
}

export function runEngine(engine, args, options = {}) {
  return exec(engine.executable, args, {
    env: engineEnvironment(engine), windowsHide: true, timeout: 30_000,
    maxBuffer: 1024 * 1024, ...options,
  })
}

export async function discoverEngine(saved, {
  platform = process.platform, arch = process.arch, execute = runEngine, source = process.env,
} = {}) {
  if (!['linux', 'win32'].includes(platform) || arch !== 'x64') {
    throw new Error('Private desktops currently require Windows x64 or Linux x64.')
  }
  let engine = saved ? { ...validateEngine(saved, platform) } : { kind: 'docker', executable: dockerExecutable(platform) }
  if (!saved) {
    let endpoint = source.DOCKER_HOST
    try {
      if (source.DOCKER_CONTEXT || !endpoint) {
        const args = ['context', 'inspect', ...(source.DOCKER_CONTEXT ? [source.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}']
        endpoint = JSON.parse((await execute(engine, args)).stdout)
      }
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Install Docker Desktop on the DSH host, then check again.')
      throw new Error('Docker could not read its local connection. Open Docker Desktop and check again.')
    }
    assertLocalEndpoint(endpoint, platform)
    engine.endpoint = endpoint
  }
  let info
  try { info = JSON.parse((await execute(engine, ['info', '--format', '{{json .}}'])).stdout) }
  catch { throw new Error('Start Docker with Linux containers on the DSH host, then check again.') }
  if (info.OSType !== 'linux' || !['x86_64', 'amd64'].includes(info.Architecture)) throw new Error('Switch Docker to Linux x64 containers.')
  if (saved && info.ID !== saved.id) throw new Error('The desktop engine changed. Restore the original engine; existing desktops have not been moved.')
  engine = { ...engine, id: info.ID }
  return validateEngine(engine, platform)
}

export function buildDesktop(engine, directory, tag, { signal, log = () => {}, timeoutMs = 30 * 60_000 } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(engine.executable, ['build', '--platform', 'linux/amd64', '--progress=plain', '-t', tag, directory], {
      env: engineEnvironment(engine), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false
    const abort = () => child.kill()
    const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => log(bytes.toString('utf8')))
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (signal?.aborted) reject(signal.reason)
      else if (timedOut) reject(new Error('Desktop image preparation timed out. Retry to reuse downloaded layers.'))
      else resolve()
    }
    child.once('error', finish)
    child.once('close', code => finish(code && !signal?.aborted && !timedOut ? new Error('Desktop image preparation failed. Review the preparation log and retry.') : null))
  })
}
