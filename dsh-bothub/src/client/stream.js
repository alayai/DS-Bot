import { acceptSnapshot } from './model.js'
import { collections, cursorOf, streamVersion } from '../shared/sync.js'

const failure = () => new Error('resync-required')
const validRows = rows => Array.isArray(rows) && rows.every(row => row && typeof row.id === 'string' && row.id.length > 0)
  && new Set(rows.map(row => row.id)).size === rows.length
const checkedSnapshot = value => {
  acceptSnapshot(value)
  if (!collections.every(key => validRows(value[key]))) throw failure()
  return value
}

export function applyFrame(previous, type, frame) {
  if (!frame || frame.schemaVersion !== streamVersion || typeof frame.epoch !== 'string' || !frame.epoch
    || typeof frame.scopeKey !== 'string' || !frame.scopeKey || !Number.isSafeInteger(frame.seq) || frame.seq < 0) throw failure()
  const same = previous?.epoch === frame.epoch && previous?.scopeKey === frame.scopeKey
  if (type === 'snapshot') {
    const data = checkedSnapshot(frame.snapshot)
    if (same && frame.seq < previous.seq) return previous
    return { data, epoch: frame.epoch, scopeKey: frame.scopeKey, seq: frame.seq, cursor: cursorOf(frame) }
  }
  if (!same) throw failure()
  if (type === 'ready') {
    if (frame.seq !== previous.seq || !Number.isFinite(frame.capturedAt)) throw failure()
    return { ...previous, data: { ...previous.data, capturedAt: frame.capturedAt } }
  }
  if (type !== 'patch') throw failure()
  if (frame.seq <= previous.seq) return previous
  if (frame.seq !== previous.seq + 1 || !frame.meta || frame.meta.version !== 2
    || (frame.meta.workspaceId ?? null) !== (previous.data.workspaceId ?? null)
    || frame.meta.readOnly !== previous.data.readOnly
    || collections.some(key => Object.hasOwn(frame.meta, key))) throw failure()
  const data = { ...frame.meta }
  for (const key of collections) {
    const change = frame.changes?.[key]
    if (!change || !validRows(change.upsert) || !Array.isArray(change.remove)
      || !change.remove.every(id => typeof id === 'string')) throw failure()
    const removed = new Set(change.remove)
    const rows = new Map(previous.data[key].filter(row => !removed.has(row.id)).map(row => [row.id, row]))
    for (const row of change.upsert) rows.set(row.id, row)
    data[key] = [...rows.values()]
  }
  return { ...previous, data: checkedSnapshot(data), seq: frame.seq, cursor: cursorOf(frame) }
}

export function parseEventBlock(block) {
  let type = 'message'
  const lines = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
  }
  if (!lines.length) return null
  try { return { type, data: JSON.parse(lines.join('\n')) } } catch { throw failure() }
}

export async function readMonitorStream(signal, cursor, onFrame, fetcher = globalThis.fetch) {
  const response = await fetcher('api/bothub/events', {
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: { accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}) },
  })
  if (!response.ok) {
    const detail = response.status === 503 ? await response.json().catch(() => null) : null
    throw new Error(response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 404 || response.status === 405 ? 'stream-unavailable'
        : response.status === 409 ? 'incompatible'
          : detail?.error === 'bridge-missing' ? 'bridge-missing' : 'unavailable')
  }
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('stream-unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new Error('unavailable')
    while (true) {
      const { value, done } = await reader.read()
      if (done || signal.aborted) throw new Error('unavailable')
      buffer += decoder.decode(value, { stream: true })
      // A stalled/malformed source cannot grow the browser buffer indefinitely.
      if (buffer.length > 2 * 1024 * 1024) throw failure()
      let match
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const frame = parseEventBlock(block)
        if (frame) {
          if (frame.type === 'fault') throw new Error(['bridge-missing', 'incompatible'].includes(frame.data?.error) ? frame.data.error : 'unavailable')
          onFrame(frame.type, frame.data)
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
