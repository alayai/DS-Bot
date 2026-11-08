import { coordinateDesktopRequest } from './desktop-capture.js'

const MAX_TARGETS = 4
const FRAME_TTL = 5000

export async function desktopRequest(endpoint, payload, signal) {
  const response = await fetch('api/bot', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: `computer-${endpoint}`, payload }), signal,
  })
  if (!response.ok) throw Object.assign(new Error('Desktop unavailable'), { code: `HTTP_${response.status}` })
  const result = await response.json()
  if (!result.ok) throw Object.assign(new Error('Desktop unavailable'), { code: result.error?.code })
  return result.value
}

export function validDesktopFrame(frame) {
  return Number.isSafeInteger(frame?.width) && Number.isSafeInteger(frame?.height)
    && frame.width > 0 && frame.height > 0 && frame.width <= 8192 && frame.height <= 8192
    && frame.width * frame.height <= 16_777_216 && typeof frame.data === 'string'
    && frame.data.length <= 12_000_000 && frame.data.startsWith('iVBORw0KGgo')
}

const coordinatedRequest = coordinateDesktopRequest(desktopRequest)

// One scheduler for the whole scene. Images only travel to the renderer; neither
// the monitor store nor its event/history stream carries desktop pixels.
export function createDesktopPreview({
  request = coordinatedRequest, publish, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout,
}) {
  let targets = [], epoch = 0, timer, controller, disposed = false
  let records = new Map(), checkedAt = -Infinity
  const painted = new Map()
  const expirations = new Map()
  const bindings = new Map(), statuses = new Map()
  const status = (id, value, clear = true) => {
    const hadFrame = painted.has(id)
    if (clear) { painted.delete(id); cancel(expirations.get(id)); expirations.delete(id) }
    if (statuses.get(id) === value && (!clear || !hadFrame)) return
    statuses.set(id, value)
    publish(id, { status: value, clear })
  }
  const run = async () => {
    const version = epoch, started = now(), active = new AbortController()
    controller = active
    const current = () => !disposed && epoch === version && !active.signal.aborted
    const call = (method, args) => request(method, args,
      AbortSignal.any([active.signal, AbortSignal.timeout(method === 'state' ? 8000 : 5000)]))
    let delay = 1000
    try {
      if (now() - checkedAt >= 5000) {
        const state = await call('state', null)
        if (!current()) return
        checkedAt = now()
        if (state?.passivePreview !== true) {
          records.clear()
          for (const id of targets) status(id, 'unsupported')
          checkedAt = -Infinity
          delay = 30000
          return
        }
        const recovering = state.recovery?.disconnected || ['running', 'failed'].includes(state.recovery?.status)
        records = new Map((state.computers ?? []).filter(item => !item.archived).map(item =>
          [item.botId, { ...item, phase: recovering || item.recoveryPending ? 'unavailable' : item.phase }]))
      }
      const queue = [...targets]
      const capture = async () => {
        while (queue.length && current()) {
          const id = queue.shift(), record = records.get(id)
          const binding = record ? `${record.id}:${record.generation}` : null
          if (bindings.get(id) !== binding) {
            bindings.set(id, binding)
            if (record?.phase === 'ready' && record.grant !== 'off') status(id, 'loading')
          }
          if (!record || record.grant === 'off' || record.phase !== 'ready') {
            status(id, record?.phase === 'starting' ? 'starting'
              : !record || record.grant === 'off' || record.phase === 'stopped' ? 'standby' : 'unavailable')
            continue
          }
          try {
            const frame = await call('preview', { botId: id, expectedGeneration: record.generation, passive: true })
            if (!current()) return
            if (!validDesktopFrame(frame)) throw new Error('Invalid desktop frame')
            await publish(id, { status: 'live', frame, signal: active.signal })
            if (current()) {
              statuses.set(id, 'live')
              painted.set(id, { binding, at: now() })
              cancel(expirations.get(id))
              expirations.set(id, schedule(() => {
                if (current()) status(id, 'waiting')
              }, FRAME_TTL))
            }
          } catch (error) {
            if (!current()) return
            const busy = error?.code === 'bot/computer-busy'
            const previous = painted.get(id)
            status(id, busy ? 'waiting' : 'unavailable',
              !busy || !previous || now() - previous.at >= FRAME_TTL)
            if (!busy) { checkedAt = -Infinity; delay = 5000 }
          }
        }
      }
      await Promise.all([capture(), capture()])
    } catch (error) {
      if (!current()) return
      records.clear(); checkedAt = -Infinity
      const off = error?.code === 'bot/computer-off'
      const unsupported = ['bot/not-found', 'HTTP_404'].includes(error?.code)
      for (const id of targets) status(id, off ? 'standby' : unsupported ? 'unsupported' : 'unavailable')
      delay = ['HTTP_401', 'HTTP_403', 'bot/read-only'].includes(error?.code) || unsupported || off ? 30000 : 5000
    } finally {
      if (current()) timer = schedule(() => { void run() }, Math.max(100, delay - (now() - started)))
    }
  }
  const stop = () => {
    epoch++
    cancel(timer)
    controller?.abort()
    controller = null
    records.clear(); checkedAt = -Infinity
    for (const id of targets) status(id, 'standby')
    bindings.clear(); statuses.clear()
  }
  return {
    targets(ids) {
      const next = [...new Set(ids)].slice(0, MAX_TARGETS)
      if (disposed || targets.length === next.length && targets.every(id => next.includes(id))) return
      stop()
      targets = next
      if (targets.length) timer = schedule(() => { void run() }, 0)
    },
    dispose() { stop(); disposed = true; targets = [] },
  }
}
