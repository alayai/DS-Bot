import { randomUUID } from 'node:crypto'
import { streamFailure } from '../../shared/computer-stream.js'
import { registerViewerSocket } from './viewer-socket.js'

const LIMIT = 65536

export { rfbInput as readOnlyInput } from '../../../computer-runtime/broker/rfb.mjs'
import { rfbInput as readOnlyInput } from '../../../computer-runtime/broker/rfb.mjs'

// Exact Fetch routes are authenticated owner-only on both DSH Web and Desktop.
// A bounded long poll carries RFB bytes, not screenshots, without requiring a
// separately exposed WebSocket server in the desktop shell.
export function registerComputerViewer(rt, getComputer) {
  const connection = rt.ctx.get?.('connection')
  if (!connection?.fetch?.register) return
  const sessions = new Map()
  let disposed = false
  let opening = 0
  const response = (data, status = 200) => new Response(data, { status, headers: {
    'content-type': 'application/octet-stream', 'cache-control': 'no-store',
  } })
  const failure = error => {
    const detail = streamFailure(error)
    return Response.json({ error: detail }, { status: detail.status, headers: { 'cache-control': 'no-store' } })
  }
  const close = (session, error = 'closed') => {
    if (session.closed) return
    session.closed = true
    sessions.delete(session.id)
    session.wake?.()
    session.socket?.stop(error)
    session.queue.length = 0
    session.stream.close()
  }
  const write = async (session, data) => {
    let safe
    try { safe = session.filter(data) }
    catch { throw Object.assign(new Error('Invalid RFB input.'), { code: 'protocol' }) }
    if (safe.length) await session.stream.write(safe)
  }
  const socket = registerViewerSocket(rt, sessions, close, write)
  const timer = setInterval(() => {
    for (const session of sessions.values()) if (Date.now() - session.touched > (session.stream.interactive ? 6000 : 45_000)) close(session, 'timeout')
  }, 1000)
  timer.unref?.()
  const unregister = connection.fetch.register({
    path: '/api/ds-bot/computer-viewer', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let session
      try {
        if (disposed) return failure('unavailable')
        const text = await request.text()
        if (text.length > 100_000) return failure('invalid')
        let args
        try { args = JSON.parse(text) } catch { return failure('invalid') }
        if (!args || typeof args !== 'object') return failure('invalid')
        if (args.operation === 'open') {
          if (sessions.size + opening >= 16) return failure('busy')
          opening++
          try {
            const computer = getComputer()
            if (!computer) return failure('unavailable')
            const stream = await computer.openViewer({ botId: args.botId, expectedGeneration: args.generation,
              ...(args.controlToken !== undefined ? { controlToken: args.controlToken } : {}), signal: request.signal })
            if (disposed || request.signal.aborted) { stream.close(); return failure('closed') }
            session = { id: randomUUID(), stream, queue: [], bytes: 0, filter: readOnlyInput(stream.interactive === true), touched: Date.now(), closed: false }
            sessions.set(session.id, session)
            stream.onClose(() => close(session, 'broker'))
            stream.onData((data, acknowledge) => {
              if (session.closed) return
              if (session.bytes + data.length > LIMIT * 2) { close(session); return }
              session.bytes += data.length
              session.queue.push({ data, acknowledge })
              session.wake?.()
              session.socket?.pump()
            })
            if (session.closed) return failure('closed')
            return response(JSON.stringify({ id: session.id, webSocket: socket?.path ?? null, interactive: stream.interactive === true }))
          } finally { opening-- }
        }
        session = sessions.get(args.id)
        if (!session || session.closed) return failure('closed')
        session.touched = Date.now()
        if (args.operation === 'close') { close(session); return response(null) }
        if (args.operation === 'heartbeat') {
          await session.stream.validate()
          return response(null)
        }
        if (session.socket) return failure('busy')
        await session.stream.validate()
        if (args.operation === 'write') {
          if (session.writing) return failure('busy')
          if (typeof args.data !== 'string' || args.data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw Object.assign(new Error('Invalid viewer data.'), { code: 'protocol' })
          session.writing = true
          try {
            await write(session, Buffer.from(args.data, 'base64'))
          } finally { session.writing = false }
          return response(null)
        }
        if (args.operation !== 'read') return failure('invalid')
        if (session.reading) return failure('busy')
        session.reading = true
        try {
          // The next read acknowledges that the preceding response reached the client.
          session.acknowledge?.()
          session.acknowledge = null
          if (!session.queue.length && !session.closed) await new Promise(resolve => {
            const finish = () => { clearTimeout(wait); request.signal.removeEventListener('abort', finish); session.wake = null; resolve() }
            const wait = setTimeout(finish, 20_000)
            session.wake = finish
            request.signal.addEventListener('abort', finish, { once: true })
            if (request.signal.aborted) finish()
          })
          if (request.signal.aborted) { close(session); return failure('closed') }
          await session.stream.validate()
          if (session.closed) return failure('closed')
          const chunk = session.queue.shift()
          if (!chunk) return response(null)
          session.bytes -= chunk.data.length
          session.acknowledge = chunk.acknowledge
          return response(chunk.data)
        } finally { session.reading = false }
      } catch (error) {
        if (session) close(session, error)
        return failure(error)
      }
    },
  })
  return async () => {
    disposed = true
    clearInterval(timer)
    for (const session of sessions.values()) close(session)
    await socket?.dispose()
    await unregister()
  }
}
