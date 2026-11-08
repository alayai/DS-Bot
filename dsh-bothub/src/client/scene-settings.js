export const qualityKey = 'dsh-bothub.scene-quality'
const levels = {
  low: { ratio: 1, shadow: 0, fps: 12 },
  balanced: { ratio: 1.25, shadow: 1024, fps: 24 },
  high: { ratio: 1.5, shadow: 2048, fps: 30 },
}

export const normalizeQuality = value => Object.hasOwn(levels, value) ? value : 'balanced'
export const qualitySettings = value => levels[normalizeQuality(value)]

export function readQuality(storage) {
  try { return normalizeQuality((storage ?? window.localStorage).getItem(qualityKey)) }
  catch { return 'balanced' }
}

export function saveQuality(value, storage) {
  try { (storage ?? window.localStorage).setItem(qualityKey, normalizeQuality(value)) }
  catch { /* A browser can disable storage without disabling the scene. */ }
}

export const motionKey = 'dsh-bothub.scene-motion'
export const normalizeMotion = value => ['quiet', 'normal', 'lively'].includes(value) ? value : 'normal'
export function readMotion(storage) {
  try { return normalizeMotion((storage ?? window.localStorage).getItem(motionKey)) }
  catch { return 'normal' }
}
export function saveMotion(value, storage) {
  try { (storage ?? window.localStorage).setItem(motionKey, normalizeMotion(value)) }
  catch { /* Scene preferences are optional. */ }
}
