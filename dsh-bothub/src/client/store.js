import { acceptSnapshot } from './model.js'

export async function request(payload, signal) {
  const response = await fetch('api/bothub', {
    method: payload ? 'POST' : 'GET', credentials: 'same-origin', signal,
    headers: payload ? { 'content-type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    cache: 'no-store',
  })
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 409 ? 'incompatible' : response.status === 404 ? 'not-found' : 'unavailable'
    throw new Error(code)
  }
  return response.json()
}

export function createMonitorStore(fetchSnapshot = signal => request(undefined, signal), environment = globalThis) {
  let state = { data: null, phase: 'loading', error: null }
  let active = false
  let generation = 0
  let timer
  let controller
  let requestTimeout
  const listeners = new Set()
  const publish = next => {
    state = next
    for (const listener of listeners) listener()
  }
  const poll = async () => {
    if (!active || controller || environment.document?.hidden) return
    environment.clearTimeout(timer)
    const own = ++generation
    const ownController = new AbortController()
    controller = ownController
    const timeout = environment.setTimeout(() => ownController.abort(), 10000)
    requestTimeout = timeout
    try {
      const data = acceptSnapshot(await fetchSnapshot(ownController.signal))
      if (active && generation === own) publish({ data, phase: 'live', error: null })
    } catch (error) {
      if (active && generation === own) {
        const code = ['unauthorized', 'incompatible', 'not-found'].includes(error.message) ? error.message : 'unavailable'
        publish({ data: code === 'unauthorized' || code === 'incompatible' ? null : state.data, phase: 'stale', error: code })
      }
    } finally {
      environment.clearTimeout(timeout)
      if (generation === own) {
        controller = undefined
        requestTimeout = undefined
        if (active) timer = environment.setTimeout(poll, 1500)
      }
    }
  }
  const visibility = () => {
    if (!environment.document.hidden) void poll()
  }
  const stop = () => {
    active = false
    generation++
    controller?.abort()
    controller = undefined
    environment.clearTimeout(requestTimeout)
    requestTimeout = undefined
    environment.clearTimeout(timer)
    environment.document?.removeEventListener('visibilitychange', visibility)
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start() {
      if (active) return () => {}
      active = true
      if (state.data) publish({ ...state, phase: 'loading' })
      environment.document?.addEventListener('visibilitychange', visibility)
      void poll()
      return stop
    },
    refresh: poll,
    stop,
  }
}
