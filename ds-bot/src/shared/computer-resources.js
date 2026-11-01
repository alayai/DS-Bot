export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxRunning: 2, idleStopMs: 900_000, freeWarningBytes: 2 * 1024 ** 3, homeWarningBytes: 10 * 1024 ** 3, newHomeQuotaBytes: 0, checkpointMaxBytes: 20 * 1024 ** 3,
})

export function resourceLimits(value) {
  if (!value || !Number.isInteger(value.maxRunning) || value.maxRunning < 1 || value.maxRunning > 8
    || !Number.isSafeInteger(value.idleStopMs) || value.idleStopMs < 0 || value.idleStopMs > 7 * 86400_000
    || (value.idleStopMs !== 0 && value.idleStopMs < 60_000)
    || !Number.isSafeInteger(value.freeWarningBytes) || value.freeWarningBytes < 256 * 1024 ** 2 || value.freeWarningBytes > 1024 ** 4
    || !Number.isSafeInteger(value.homeWarningBytes) || value.homeWarningBytes < 256 * 1024 ** 2 || value.homeWarningBytes > 1024 ** 4
    || !Number.isSafeInteger(value.checkpointMaxBytes ?? DEFAULT_RESOURCE_LIMITS.checkpointMaxBytes)
    || (value.checkpointMaxBytes !== undefined && (value.checkpointMaxBytes < 1024 ** 3 || value.checkpointMaxBytes > 1024 ** 4))
    || !Number.isSafeInteger(value.newHomeQuotaBytes ?? 0) || ((value.newHomeQuotaBytes ?? 0) !== 0
      && (value.newHomeQuotaBytes < 1024 ** 3 || value.newHomeQuotaBytes > 1024 ** 4))) {
    throw new Error('Choose 1–8 desktops, 0 or 1–10080 idle minutes, and disk warning levels from 0.25 to 1024 GiB.')
  }
  return Object.fromEntries(Object.keys(DEFAULT_RESOURCE_LIMITS).map(key => [key, value[key] ?? DEFAULT_RESOURCE_LIMITS[key]]))
}

export function resourceWarnings(storage, limits) {
  if (!storage) return []
  const warnings = []
  if (storage.freeBytes < limits.freeWarningBytes) warnings.push('low-space')
  if (storage.bytes >= limits.homeWarningBytes) warnings.push('large-home')
  return warnings
}
