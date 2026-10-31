import { createHash } from 'node:crypto'
import { win32 } from 'node:path'

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function validatePodman(engine, platform) {
  if (platform === 'win32') {
    const machine = engine.machine
    if (!machine || !namePattern.test(machine.name ?? '') || typeof machine.created !== 'string'
      || !machine.created || !win32.isAbsolute(engine.identity ?? '') || /[\x00-\x1f]/.test(engine.identity)) {
      throw new Error('The saved Podman machine identity is invalid.')
    }
    const url = new URL(engine.endpoint)
    if (url.protocol !== 'ssh:' || url.hostname !== '127.0.0.1' || url.username !== 'root'
      || url.password || !url.port || url.search || url.hash || url.pathname !== '/run/podman/podman.sock') {
      throw new Error('Podman must connect to its verified local rootful machine.')
    }
  } else if (platform !== 'linux' || !/^unix:\/\/\/[^?#\x00-\x20]+$/.test(engine.endpoint)) {
    throw new Error('Podman requires a local Unix socket or a verified Windows machine.')
  }
}

export function podmanArgs(engine, args) {
  if (args[0] === 'create') {
    args = args.filter((value, index) => !(value === '--log-opt' && args[index + 1] === 'max-file=2')
      && !(value === 'max-file=2' && args[index - 1] === '--log-opt'))
    args = [...args.slice(0, 1), '--log-driver', 'k8s-file', ...args.slice(1)]
  }
  return ['--remote', '--url', engine.endpoint, ...(engine.identity ? ['--identity', engine.identity] : []), ...args]
}

export function podmanMachine(value) {
  if (!value || !namePattern.test(value.Name ?? '') || typeof value.Created !== 'string' || !value.Created
    || value.Rootful !== true || !Number.isInteger(value.SSHConfig?.Port)
    || value.SSHConfig.Port < 1 || value.SSHConfig.Port > 65535
    || !win32.isAbsolute(value.SSHConfig.IdentityPath ?? '')) {
    throw new Error('Choose a rootful Podman machine with a valid local SSH connection in Podman Desktop.')
  }
  return {
    machine: { name: value.Name, created: value.Created },
    endpoint: `ssh://root@127.0.0.1:${value.SSHConfig.Port}/run/podman/podman.sock`,
    identity: value.SSHConfig.IdentityPath,
  }
}

export async function discoverPodman(engine, { platform, execute, source }) {
  let selected = { ...engine }
  if (platform === 'win32') {
    let machines
    try {
      const names = engine.machine ? [engine.machine.name]
        : JSON.parse((await execute({ ...engine, endpoint: undefined }, ['machine', 'list', '--format', 'json'])).stdout)
          .map(item => item.Name)
      if (!names.length || names.some(name => !namePattern.test(name))) throw new Error('No valid machine.')
      machines = JSON.parse((await execute({ ...engine, endpoint: undefined },
        ['machine', 'inspect', ...names])).stdout)
    } catch {
      throw Object.assign(new Error('Install Podman and prepare a rootful machine in Podman Desktop, then check again.'), { code: 'podman-machine-missing' })
    }
    if (!Array.isArray(machines)) throw new Error('Podman returned invalid machine metadata.')
    const candidates = machines.filter(item => item.Rootful === true)
    const machine = engine.machine
      ? candidates.find(item => item.Name === engine.machine.name)
      : candidates.find(item => item.Name === 'ds-bot') ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!machine) throw new Error('Choose one rootful Podman machine, or create a dedicated machine named ds-bot.')
    const connection = podmanMachine(machine)
    if (engine.machine && (JSON.stringify(connection.machine) !== JSON.stringify(engine.machine)
      || connection.endpoint !== engine.endpoint || connection.identity !== engine.identity)) {
      throw new Error('The Podman machine changed. Restore its original connection; existing desktops have not been moved.')
    }
    selected = { ...selected, ...connection }
    if (machine.State !== 'running') {
      throw Object.assign(new Error(`Start Podman machine ${machine.Name}, then check again.`), {
        code: 'podman-machine-stopped', machine: connection.machine.name,
      })
    }
  } else {
    selected.endpoint ??= source.CONTAINER_HOST ?? 'unix:///run/podman/podman.sock'
  }
  validatePodman(selected, platform)
  let info
  try { info = JSON.parse((await execute(selected, ['info', '--format', 'json'])).stdout) }
  catch { throw new Error('Start the local Podman service, then check again.') }
  if (info.host?.os !== 'linux' || !['amd64', 'x86_64'].includes(info.host?.arch)
    || info.host?.security?.rootless !== false || info.host?.cgroupVersion !== 'v2'
    || !info.host?.hostname || !info.store?.graphRoot || !info.store?.graphDriverName) {
    throw new Error('Podman requires a rootful Linux x64 engine with cgroup v2 resource limits.')
  }
  const id = digest([selected.machine ?? null, info.host.hostname, info.store.graphRoot, info.store.graphDriverName])
  if (engine.id && engine.id !== id) throw new Error('The desktop engine changed. Restore the original Podman store.')
  return { ...selected, id }
}

// Keep the original fields, and normalize only documented representation
// differences. Missing isolation settings still fail the Broker assertions.
export function normalizePodman(args, stdout) {
  if (args[0] === 'info') {
    const info = JSON.parse(stdout)
    return JSON.stringify({ ...info, OSType: info.host?.os, Architecture: info.host?.arch, ServerVersion: info.version?.Version })
  }
  if ((args[0] === 'image' && args[1] === 'inspect') || args[0] === 'inspect') {
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows)) throw new Error('Podman returned invalid inspect data.')
    return JSON.stringify(rows.map(item => {
      const result = { ...item }
      for (const key of ['Id', 'Image']) {
        if (/^[a-f0-9]{64}$/.test(result[key] ?? '')) result[key] = `sha256:${result[key]}`
      }
      if (item.HostConfig) {
        const config = { ...item.HostConfig }
        if (config.NanoCpus === 0 && config.CpuPeriod > 0 && config.CpuQuota > 0) {
          config.NanoCpus = config.CpuQuota / config.CpuPeriod * 1e9
        }
        config.CapDrop = config.CapDrop?.map(value => value.toUpperCase())
        config.SecurityOpt = config.SecurityOpt?.map(value => value === 'no-new-privileges=true' ? 'no-new-privileges' : value)
        if (config.RestartPolicy?.Name === '') config.RestartPolicy = { ...config.RestartPolicy, Name: 'no' }
        result.HostConfig = config
      }
      return result
    }))
  }
  return stdout
}
