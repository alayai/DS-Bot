import { acceptSnapshot } from './model.js'
import { applyFrame, readMonitorStream } from './stream.js'
import { coordinateMonitorStream } from './monitor-connection.js'

export async function request(payload, signal) {
  const response = await fetch('api/bothub', {
    method: payload ? 'POST' : 'GET', credentials: 'same-origin', signal,
    headers: payload ? { 'content-type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    cache: 'no-store',
  })
  if (!response.ok) {
    const detail = response.status === 503 ? await response.json().catch(() => null) : null
    const code = response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 409 ? 'incompatible'
        : response.status === 404 ? payload ? 'not-found' : 'host-missing'
          : detail?.error === 'bridge-missing' ? 'bridge-missing' : 'unavailable'
    throw new Error(code)
  }
  return response.json()
}

const fetchCurrent = signal => request(undefined, signal)
const monitorStream = coordinateMonitorStream(readMonitorStream)

export function createMonitorStore(fetchSnapshot = fetchCurrent, environment = globalThis,
  stream = fetchSnapshot === fetchCurrent ? monitorStream : null) {
  let state = { data: null, phase: 'loading', error: null, transport: stream ? 'stream' : 'poll' }
  let active = false, generation = 0, timer, controller, watchdog, projection
  let failures = 0, retries = 0, fallbackPolls = 0, authBlocked = false
  const listeners = new Set()
  const leases = new Set()
  const publish = next => { state = next; for (const listener of listeners) listener() }
  const visible = () => !environment.document?.hidden
  const clearTimers = () => {
    environment.clearTimeout(timer)
    environment.clearTimeout(watchdog)
    timer = watchdog = undefined
  }
  const cancel = () => {
    generation++
    controller?.abort()
    controller = undefined
    clearTimers()
  }
  const attempt = async () => {
    if (!active || controller || !visible() || authBlocked || environment.navigator?.onLine === false) return
    environment.clearTimeout(timer)
    const own = ++generation
    const ownController = new AbortController()
    controller = ownController
    const mode = stream && failures < 3 ? 'stream' : 'poll'
    let halted = false, pollNow = false
    const current = () => active && generation === own && !ownController.signal.aborted
    const arm = delay => {
      environment.clearTimeout(watchdog)
      watchdog = environment.setTimeout(() => ownController.abort(), delay)
    }
    arm(10000)
    try {
      // Race the transport against cancellation even if a test/carrier ignores abort.
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('unavailable'))
        ownController.signal.addEventListener('abort', abort, { once: true })
        const run = async () => {
          if (mode === 'poll') {
            const data = acceptSnapshot(await fetchSnapshot(ownController.signal))
            if (!current()) return
            projection = undefined
            retries = 0
            publish({ data, phase: 'live', error: null, transport: 'poll' })
            if (stream && ++fallbackPolls >= 12) { failures = 0; fallbackPolls = 0 }
          } else {
            let pending = projection, ready = false
            await stream(ownController.signal, projection?.cursor, (type, frame) => {
              if (!current()) return
              pending = applyFrame(pending, type, frame)
              if (type === 'snapshot') {
                ready = false
                if (projection && pending.scopeKey !== projection.scopeKey) {
                  projection = undefined
                  publish({ data: null, phase: 'loading', error: null, transport: 'stream' })
                }
              }
              if (type === 'ready') ready = true
              arm(35000)
              if (ready) {
                projection = pending
                failures = retries = fallbackPolls = 0
                publish({ data: pending.data, phase: 'live', error: null, transport: 'stream' })
              }
            })
            throw new Error('unavailable')
          }
        }
        run().then(resolve, reject)
          .finally(() => ownController.signal.removeEventListener('abort', abort))
      })
    } catch (error) {
      if (active && generation === own && error.message === 'stream-occupied') {
        failures = 3
        retries = 0
        pollNow = true
      } else if (active && generation === own) {
        const code = ['unauthorized', 'incompatible', 'host-missing', 'bridge-missing'].includes(error.message) ? error.message : 'unavailable'
        const reset = code !== 'unavailable'
        if (reset || error.message === 'resync-required') projection = undefined
        halted = code === 'unauthorized'
        authBlocked = halted
        if (mode === 'stream') failures = error.message === 'stream-unavailable' ? 3 : failures + 1
        retries++
        publish({ ...state, data: reset ? null : state.data, phase: 'stale', error: code })
      }
    } finally {
      if (generation === own) {
        ownController.abort()
        controller = undefined
        environment.clearTimeout(watchdog)
        watchdog = undefined
        if (active && visible() && !halted) {
          const delay = pollNow ? 0 : retries ? Math.min(30000, 1000 * 2 ** Math.min(retries - 1, 5))
            * (0.5 + (environment.random?.() ?? Math.random()) * 0.5) : 2500
          timer = environment.setTimeout(attempt, delay)
        }
      }
    }
  }
  const visibility = () => {
    cancel()
    if (authBlocked) return
    publish({ ...state, phase: 'loading' })
    if (visible()) void attempt()
  }
  const offline = () => {
    cancel()
    if (!authBlocked) publish({ ...state, phase: 'stale', error: 'unavailable' })
  }
  const online = () => {
    if (authBlocked) return
    cancel()
    failures = retries = fallbackPolls = 0
    publish({ ...state, phase: 'loading', error: null })
    void attempt()
  }
  const stop = () => {
    leases.clear()
    active = false
    cancel()
    environment.document?.removeEventListener('visibilitychange', visibility)
    environment.removeEventListener?.('offline', offline)
    environment.removeEventListener?.('online', online)
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start() {
      const lease = {}
      leases.add(lease)
      if (!active) {
        active = true
        if (state.data) publish({ ...state, phase: 'loading' })
        environment.document?.addEventListener('visibilitychange', visibility)
        environment.addEventListener?.('offline', offline)
        environment.addEventListener?.('online', online)
        void attempt()
      }
      return () => { if (leases.delete(lease) && leases.size === 0) stop() }
    },
    refresh() {
      // Legacy polling callers keep single-flight refresh; stream refresh restarts
      // the subscription so a stuck reader cannot prevent recovery.
      authBlocked = false
      if (!stream) return attempt()
      cancel()
      failures = retries = fallbackPolls = 0
      projection = undefined
      publish({ ...state, phase: 'loading', error: null })
      return attempt()
    },
    stop,
  }
}
