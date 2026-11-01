// Codes cross both transports; arbitrary provider error text never reaches the viewer.
const ERRORS = {
  auth: [401, false, 'Desktop login expired. Reload DSH and sign in again.'],
  forbidden: [403, false, 'This connection cannot view the desktop.'],
  protocol: [400, false, 'The desktop stream protocol was rejected. Update the plugin and runtime together.'],
  invalid: [400, false, 'The desktop viewer request is invalid.'],
  changed: [409, false, 'The desktop assignment changed. Refresh its controls.'],
  control: [409, false, 'Desktop control expired or moved to another window. Take control again.'],
  stopped: [409, false, 'The desktop is stopped or disabled. Start it from desktop controls.'],
  busy: [429, true, 'The desktop viewer is busy. Close unused viewers and retry.'],
  broker: [502, true, 'The desktop runtime disconnected. Check the engine and restart DSH if needed.'],
  unavailable: [503, true, 'Desktop streaming is unavailable. Check the desktop runtime.'],
  closed: [410, true, 'The desktop stream closed. Reconnecting…'],
  timeout: [504, true, 'The desktop connection timed out. Retry the live stream.'],
  network: [502, true, 'The live desktop stream was interrupted. Retry the stream.'],
  display: [500, false, 'The desktop image could not be displayed. Retry the viewer.'],
}
const ALIASES = {
  'owner-denied': 'forbidden', 'read-only': 'forbidden', 'stale-generation': 'changed',
  'recovery-required': 'stopped', off: 'stopped', 'not-ready': 'stopped',
  'provider-unavailable': 'broker', 'provider-failed': 'broker', 'viewer-unavailable': 'closed',
  'result-unknown': 'timeout',
  'stale-control': 'control',
}
export function streamFailure(error, status) {
  let code = typeof error === 'string' ? error : error?.code
  code = code?.replace(/^bot\/computer-/, '')
  code = ALIASES[code] ?? code
  if (!Object.hasOwn(ERRORS, code ?? '')) {
    code = status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 429 ? 'busy'
      : status === 410 ? 'closed' : status === 400 ? 'invalid' : status === 503 ? 'unavailable' : 'network'
  }
  const [httpStatus, retryable, message] = ERRORS[code]
  return { code, status: httpStatus, retryable, message }
}

export class ReconnectBudget {
  constructor() { this.attempts = 0; this.failures = []; this.readyAt = null }
  ready(now = Date.now()) { this.readyAt = now }
  failed(error, now = Date.now()) {
    if (!streamFailure(error).retryable) return null
    if (this.readyAt !== null && now - this.readyAt >= 30_000) this.attempts = 0
    this.readyAt = null
    this.failures = this.failures.filter(time => now - time < 120_000)
    this.failures.push(now)
    if (++this.attempts >= 4 || this.failures.length >= 6) return null
    return Math.min(500 * 2 ** (this.attempts - 1), 5000)
  }
}
