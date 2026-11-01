import { desktopPolicy } from './policy.mjs'
import { randomUUID } from 'node:crypto'

export function quotaArguments(bytes = 0, engine) {
  if (!Number.isSafeInteger(bytes) || (bytes !== 0 && (bytes < 1024 ** 3 || bytes > 1024 ** 4))) throw new Error('Home quotas must be 0 or 1–1024 GiB.')
  if (!bytes) return []
  if (engine?.kind !== 'podman') throw new Error('Persistent home quotas require Podman on XFS with project quotas. This engine cannot enforce them.')
  return ['--opt', `o=size=${bytes}`, '--label', `org.ds-bot.computer.quota=${bytes}`]
}

export async function probeHomeQuota(docker, image, engine, signal) {
  quotaArguments(1024 ** 3, engine)
  const id = randomUUID()
  const volume = `dsbot-quota-probe-${id}`
  const helper = `dsbot-quota-check-${id}`
  let attempted = false
  const code = `import os,errno,json\nwith open('/home/cua/.dsbot-quota-check','xb') as f:\n try:\n  os.posix_fallocate(f.fileno(),0,128*1024*1024)\n except OSError as e:\n  if e.errno != errno.EDQUOT: raise\n else: raise RuntimeError('The volume size was not enforced by the kernel.')\nprint(json.dumps({'enforced':True,'backend':'podman-xfs'}))`
  try {
    try {
      await docker(['volume', 'inspect', volume], signal)
      throw new Error('Quota probe storage already exists.')
    } catch (error) { if (!/no such volume/i.test(error.stderr ?? '')) throw error }
    attempted = true
    await docker(['volume', 'create', '--opt', 'o=size=67108864', '--opt', 'nocopy', '--uid', '1000', '--gid', '1000',
      '--label', `org.ds-bot.computer.quota-probe=${id}`, volume], signal)
    const result = await docker(['run', '--rm', '--name', helper, '--label', `org.ds-bot.computer.quota-probe=${id}`, '--read-only', '--user', '1000:1000',
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '32',
      '--mount', `type=volume,source=${volume},target=/home/cua`, '--entrypoint', 'python3', image, '-c', code], signal)
    const value = JSON.parse(result.stdout)
    if (value.enforced !== true || value.backend !== 'podman-xfs') throw new Error('The home quota could not be verified.')
    return value
  } finally {
    if (attempted) {
      let container, value
      try { container = JSON.parse((await docker(['inspect', helper])).stdout)[0] }
      catch (error) { if (!/no such (object|container)/i.test(error.stderr ?? '')) throw error }
      if (container) {
        if (container.Config?.Labels?.['org.ds-bot.computer.quota-probe'] !== id) throw new Error('Quota probe cleanup could not verify its helper.')
        await docker(['rm', '-f', helper])
      }
      try { value = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0] }
      catch (error) { if (!/no such volume/i.test(error.stderr ?? '')) throw error }
      if (value) {
        if (value.Name !== volume || value.Labels?.['org.ds-bot.computer.quota-probe'] !== id) throw new Error('Quota probe cleanup could not verify its volume.')
        await docker(['volume', 'rm', volume])
      }
    }
  }
}

export function assertLocalEndpoint(endpoint, platform = process.platform) {
  const unix = platform === 'linux' && /^unix:\/\/\/[^?#\x00-\x20]+$/.test(endpoint)
  const pipe = platform === 'win32' && /^npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/.test(endpoint)
  if (typeof endpoint !== 'string' || (!unix && !pipe)) throw new Error('Choose a local Linux Docker socket or a supported Windows Docker named pipe.')
}

export function assertVolume(data, value) {
  const backupPrefix = `dsbot-${value.record.id}-backup-`
  const backup = value.volume.startsWith(backupPrefix) && /^[a-f0-9-]{36}$/.test(value.volume.slice(backupPrefix.length))
    && data?.Labels?.['org.ds-bot.computer.storage'] === 'checkpoint'
  const quota = backup ? 0 : value.record.homeQuotaBytes ?? 0
  const expected = quota ? { o: `size=${quota}` } : {}
  if (data?.Name !== value.volume || data.Driver !== 'local'
    || data.Labels?.['org.ds-bot.computer.id'] !== value.record.id
    || JSON.stringify(data.Options ?? {}) !== JSON.stringify(expected)
    || (quota && data.Labels?.['org.ds-bot.computer.quota'] !== String(quota))
    || (!quota && data.Labels?.['org.ds-bot.computer.quota'] !== undefined)) {
    throw new Error('The desktop volume is not a managed local Computer volume.')
  }
}

// Open egress on the engine bridge. Host networking and the old offline mode are both rejected.
const OPEN_NETWORK = new Set(['bridge', 'podman'])

export function assertContainer(data, value, image) {
  const labels = data?.Config?.Labels ?? {}
  const config = data?.HostConfig ?? {}
  const mount = data?.Mounts?.[0]
  const policy = desktopPolicy(value.record.policy)
  const networkOK = policy.network === 'offline' ? config.NetworkMode === 'none'
    : policy.network === 'restricted' ? config.NetworkMode === `dsbot-net-${value.record.id}` : OPEN_NETWORK.has(config.NetworkMode)
  if (labels['org.ds-bot.computer.id'] !== value.record.id || labels['org.ds-bot.computer.owner'] !== value.record.botId
    || labels['org.ds-bot.computer.protocol'] !== '1' || data.Image !== image
    || data.Config.User !== '1000:1000' || config.Privileged || !networkOK
    || config.PidMode === 'host' || config.IpcMode === 'host' || config.UTSMode === 'host'
    || config.Devices?.length || config.DeviceRequests?.length || config.Binds?.length || config.CapAdd?.length
    || !config.CapDrop?.includes('ALL') || !config.SecurityOpt?.includes('no-new-privileges')
    || config.SecurityOpt?.some(option => option !== 'no-new-privileges')
    || config.Memory !== policy.memoryMiB * 1024 ** 2 || config.MemorySwap !== policy.memoryMiB * 1024 ** 2
    || config.NanoCpus !== policy.cpu * 1_000_000_000 || config.PidsLimit !== 512
    || Object.keys(config.PortBindings ?? {}).length || config.PublishAllPorts
    || config.RestartPolicy?.Name !== 'no'
    || data.Mounts?.length !== 1 || mount?.Type !== 'volume'
    || mount.Name !== value.volume || mount.Destination !== '/home/cua' || mount.RW !== true) {
    throw new Error('The desktop does not match its registered container boundary.')
  }
}

export function assertHomeImage(volume, record, image, containerImage) {
  const labelled = volume.Labels?.['org.ds-bot.computer.image']
  if ((record.runtimeImage !== undefined && record.runtimeImage !== image) || (labelled !== undefined && labelled !== image)
    || (containerImage !== undefined && containerImage !== image)) {
    throw new Error('The home belongs to another desktop image; cross-image migration is not available.')
  }
  if (record.runtimeImage !== image && labelled !== image && containerImage !== image) {
    throw new Error('The original image of this home cannot be verified. Keep the original container and runtime configuration.')
  }
}
