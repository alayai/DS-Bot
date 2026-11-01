export function desktopPolicy(value = {}) {
  const cpu = value.cpu ?? 2, memoryMiB = value.memoryMiB ?? 4096
  const network = value.network ?? 'open', domains = value.domains ?? []
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 32 || !Number.isInteger(memoryMiB)
    || memoryMiB < 512 || memoryMiB > 65536 || memoryMiB % 256
    || !['open', 'offline', 'restricted'].includes(network) || !Array.isArray(domains) || domains.length > 64
    || domains.some(name => typeof name !== 'string' || name.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(name))) throw new Error('Choose 1–32 CPUs, 512–65536 MiB in steps of 256, and valid public domain names.')
  if (network === 'restricted' && !domains.length) throw new Error('Choose at least one allowed domain.')
  return { cpu, memoryMiB, network, domains: [...new Set(domains)].sort() }
}
