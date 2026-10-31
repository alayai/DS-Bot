export function assertLocalEndpoint(endpoint, platform = process.platform) {
  const unix = platform === 'linux' && /^unix:\/\/\/[^?#\x00-\x20]+$/.test(endpoint)
  const pipe = platform === 'win32' && /^npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/.test(endpoint)
  if (typeof endpoint !== 'string' || (!unix && !pipe)) throw new Error('Choose a local Linux Docker socket or a supported Windows Docker named pipe.')
}

export function assertVolume(data, value) {
  if (data?.Name !== value.volume || data.Driver !== 'local'
    || data.Labels?.['org.ds-bot.computer.id'] !== value.record.id
    || Object.keys(data.Options ?? {}).length > 0) {
    throw new Error('The desktop volume is not a managed local Computer volume.')
  }
}

export function assertContainer(data, value, image) {
  const labels = data?.Config?.Labels ?? {}
  const config = data?.HostConfig ?? {}
  const mount = data?.Mounts?.[0]
  if (labels['org.ds-bot.computer.id'] !== value.record.id || labels['org.ds-bot.computer.owner'] !== value.record.botId
    || labels['org.ds-bot.computer.protocol'] !== '1' || data.Image !== image
    || data.Config.User !== '1000:1000' || config.Privileged || config.NetworkMode !== 'none'
    || config.PidMode === 'host' || config.IpcMode === 'host' || config.UTSMode === 'host'
    || config.Devices?.length || config.DeviceRequests?.length || config.Binds?.length || config.CapAdd?.length
    || !config.CapDrop?.includes('ALL') || !config.SecurityOpt?.includes('no-new-privileges')
    || config.SecurityOpt?.some(option => option !== 'no-new-privileges')
    || config.Memory !== 4 * 1024 ** 3 || config.MemorySwap !== 4 * 1024 ** 3
    || config.NanoCpus !== 2_000_000_000 || config.PidsLimit !== 512
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
