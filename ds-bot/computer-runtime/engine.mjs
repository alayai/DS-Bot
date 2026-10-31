import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, isAbsolute, win32 } from 'node:path'
import { promisify } from 'node:util'
import { assertLocalEndpoint } from './broker/boundary.mjs'
import { validatePodman, podmanArgs, podmanMachine, discoverPodman, normalizePodman } from './podman.mjs'

const exec = promisify(execFile)
const ENV = ['PATH', 'HOME', 'LANG', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'DOCKER_CONFIG', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']

export function engineEnvironment(engine, source = process.env) {
  const env = Object.fromEntries(ENV.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
  if (engine?.endpoint && engine.kind !== 'podman') env.DOCKER_HOST = engine.endpoint
  return env
}

export function validateEngine(engine, platform = process.platform) {
  if (!['docker', 'podman'].includes(engine?.kind) || typeof engine.executable !== 'string'
    || /[\x00-\x1f]/.test(engine.executable)
    || !(engine.executable === engine.kind || engine.executable === `${engine.kind}.exe`
      || ((platform === 'win32' ? win32.isAbsolute(engine.executable) : isAbsolute(engine.executable))
        && new RegExp(`(?:^|[/\\\\])${engine.kind}(?:\\.exe)?$`).test(engine.executable)))
    || typeof engine.id !== 'string' || !engine.id || engine.id.length > 200 || /[\x00-\x20]/.test(engine.id)) {
    throw new Error('Invalid saved desktop engine. Restore its original configuration.')
  }
  if (engine.kind === 'podman') validatePodman(engine, platform)
  else assertLocalEndpoint(engine.endpoint, platform)
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

export function engineCommand(engine, args) {
  if (engine?.kind !== 'podman') return args
  if (args[0] === 'machine') return args
  return podmanArgs(engine, args)
}

export async function runEngine(engine, args, options = {}) {
  const result = await exec(engine.executable, engineCommand(engine, args), {
    env: engineEnvironment(engine), windowsHide: true, timeout: 30_000,
    maxBuffer: 1024 * 1024, ...options,
  })
  if (engine.kind === 'podman') result.stdout = normalizePodman(args, result.stdout)
  return result
}

export function podmanExecutable(platform = process.platform) {
  if (platform !== 'win32') return 'podman'
  const paths = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Podman', 'podman.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'RedHat', 'Podman', 'podman.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Podman', 'podman.exe'),
  ]
  return paths.find(path => path && existsSync(path)) ?? 'podman.exe'
}

export async function discoverEngine(saved, {
  platform = process.platform, arch = process.arch, execute = runEngine, source = process.env, kind = saved?.kind ?? 'docker',
} = {}) {
  if (!['linux', 'win32'].includes(platform) || arch !== 'x64') {
    throw new Error('Private desktops currently require Windows x64 or Linux x64.')
  }
  if (!['docker', 'podman'].includes(kind) || (saved && saved.kind !== kind)) throw new Error('Keep the original desktop engine; engine migration is not available.')
  if (kind === 'podman') {
    const selected = saved ? validateEngine(saved, platform) : { kind, executable: podmanExecutable(platform) }
    return validateEngine(await discoverPodman(selected, { platform, execute, source }), platform)
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

export function buildDesktop(engine, directory, tag, options = {}) {
  return runEngineTask(engine, ['build', '--platform', 'linux/amd64', ...(engine.kind === 'podman' ? [] : ['--progress=plain']), '-t', tag, directory], options)
}

export function runEngineTask(engine, args, { signal, log = () => {}, timeoutMs = 30 * 60_000 } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(engine.executable, engineCommand(engine, args), {
      env: engineEnvironment(engine), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false, finished = false, terminating, terminationError
    const abort = () => {
      if (terminating || !child.pid) return
      terminating = (async () => {
        if (process.platform === 'win32') {
          // Docker starts buildx as a child. Killing only docker.exe leaves the
          // build running and inherited output pipes prevent "close".
          await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, timeout: 10000, maxBuffer: 16384,
          })
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        }
      })().catch(() => {
        terminationError = new Error('Stopping the runtime task could not be confirmed. Check the container engine before retrying.')
        child.kill()
      }).finally(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(terminationError)
      })
    }
    const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => log(bytes.toString('utf8')))
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (signal?.aborted) reject(signal.reason)
      else if (timedOut) reject(new Error('Desktop preparation timed out. Retry to check existing resources and reuse downloaded layers.'))
      else resolve()
    }
    child.once('error', error => { if (!terminating) finish(error) })
    child.once('close', code => {
      if (!terminating) finish(code !== 0 && !signal?.aborted && !timedOut ? new Error('Desktop preparation failed. Review the preparation log and retry.') : null)
    })
  })
}

export async function preparePodmanMachine(saved, options = {}, {
  platform = process.platform, execute = runEngine, task = runEngineTask,
} = {}) {
  if (platform !== 'win32') throw new Error('Manage the Podman service on the Linux host, then check again.')
  if (saved && (saved.kind !== 'podman' || saved.machine?.name !== 'ds-bot')) {
    throw new Error('Start the existing desktop engine in its runtime application.')
  }
  const engine = { kind: 'podman', executable: saved?.executable ?? podmanExecutable(platform) }
  const machines = JSON.parse((await execute(engine, ['machine', 'list', '--format', 'json'])).stdout)
  if (!Array.isArray(machines)) throw new Error('Podman returned invalid machine metadata.')
  let machine
  if (machines.some(item => item.Name === 'ds-bot')) {
    machine = JSON.parse((await execute(engine, ['machine', 'inspect', 'ds-bot'])).stdout)[0]
    const connection = podmanMachine(machine)
    if (saved && JSON.stringify(connection.machine) !== JSON.stringify(saved.machine)) throw new Error('The original Podman machine was replaced.')
  } else {
    if (saved) throw new Error('The original Podman machine is missing; it will not be recreated automatically.')
    await task(engine, ['machine', 'init', '--rootful', '--cpus', '2', '--memory', '6144', '--disk-size', '30', 'ds-bot'], options)
  }
  options.signal?.throwIfAborted()
  if (machine?.State !== 'running') await task(engine, ['machine', 'start', '--update-connection=false', 'ds-bot'], options)
}
