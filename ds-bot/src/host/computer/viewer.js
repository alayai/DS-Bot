import { randomUUID } from 'node:crypto'

const LIMIT = 65536

// Only framebuffer negotiation and update requests may reach the VNC server.
// In particular, viewOnly in the browser is not an authorization boundary.
export function readOnlyInput() {
  let stage = 0
  let pending = Buffer.alloc(0)
  return data => {
    if (pending.length + data.length > LIMIT) throw new Error('Viewer input exceeds its limit.')
    pending = Buffer.concat([pending, data])
    const output = []
    while (pending.length) {
      let size
      if (stage < 3) {
        size = stage === 0 ? 12 : 1
        if (pending.length < size) break
        if (stage === 0 ? pending.subarray(0, 12).toString() !== 'RFB 003.008\n' : pending[0] !== 1) {
          throw new Error('Unsupported viewer handshake.')
        }
        stage++
      } else {
        const type = pending[0]
        if (type === 0) size = 20
        else if (type === 2) {
          if (pending.length < 4) break
          size = 4 + pending.readUInt16BE(2) * 4
        } else if (type === 3 || type === 150) size = 10
        else if (type === 248) {
          if (pending.length < 9) break
          if (pending[8] > 64) throw new Error('Invalid fence.')
          size = 9 + pending[8]
        } else throw new Error('Viewer input is read-only.')
        if (size > LIMIT) throw new Error('Viewer input exceeds its limit.')
        if (pending.length < size) break
      }
      let message = pending.subarray(0, size)
      // Do not advertise clipboard, resize, power or extended-key capabilities.
      if (stage === 3 && size >= 4 && message[0] === 2) {
        const encodings = []
        for (let offset = 4; offset < size; offset += 4) {
          const encoding = message.readInt32BE(offset)
          if (![-308, -309, -258, 0xc0a1e5ce | 0].includes(encoding)) encodings.push(message.subarray(offset, offset + 4))
        }
        const header = Buffer.from([2, 0, 0, 0])
        header.writeUInt16BE(encodings.length, 2)
        message = Buffer.concat([header, ...encodings])
      }
      output.push(message)
      pending = pending.subarray(size)
    }
    return Buffer.concat(output)
  }
}

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
  const close = session => {
    if (session.closed) return
    session.closed = true
    sessions.delete(session.id)
    session.wake?.()
    session.stream.close()
  }
  const timer = setInterval(() => {
    for (const session of sessions.values()) if (Date.now() - session.touched > 45_000) close(session)
  }, 5000)
  timer.unref?.()
  const unregister = connection.fetch.register({
    path: '/api/ds-bot/computer-viewer', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let session
      try {
        if (disposed) return response(null, 503)
        const text = await request.text()
        if (text.length > 100_000) return response(null, 413)
        const args = JSON.parse(text)
        if (args.operation === 'open') {
          if (sessions.size + opening >= 16) return response(null, 429)
          opening++
          try {
            const computer = getComputer()
            if (!computer) return response(null, 503)
            const stream = await computer.openViewer({ botId: args.botId, expectedGeneration: args.generation, signal: request.signal })
            if (disposed || request.signal.aborted) { stream.close(); return response(null, 410) }
            session = { id: randomUUID(), stream, queue: [], bytes: 0, filter: readOnlyInput(), touched: Date.now(), closed: false }
            sessions.set(session.id, session)
            stream.onClose(() => close(session))
            stream.onData((data, acknowledge) => {
              if (session.closed) return
              if (session.bytes + data.length > LIMIT * 2) { close(session); return }
              session.bytes += data.length
              session.queue.push({ data, acknowledge })
              session.wake?.()
            })
            if (session.closed) return response(null, 410)
            return response(JSON.stringify({ id: session.id }))
          } finally { opening-- }
        }
        session = sessions.get(args.id)
        if (!session || session.closed) return response(null, 410)
        session.touched = Date.now()
        if (args.operation === 'close') { close(session); return response(null) }
        await session.stream.validate()
        if (args.operation === 'write') {
          if (session.writing) return response(null, 409)
          if (typeof args.data !== 'string' || args.data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw new Error('Invalid viewer data.')
          session.writing = true
          try {
            const safe = session.filter(Buffer.from(args.data, 'base64'))
            if (safe.length) await session.stream.write(safe)
          } finally { session.writing = false }
          return response(null)
        }
        if (args.operation !== 'read') return response(null, 400)
        if (session.reading) return response(null, 409)
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
          if (request.signal.aborted) { close(session); return response(null, 410) }
          await session.stream.validate()
          if (session.closed) return response(null, 410)
          const chunk = session.queue.shift()
          if (!chunk) return response(null)
          session.bytes -= chunk.data.length
          session.acknowledge = chunk.acknowledge
          return response(chunk.data)
        } finally { session.reading = false }
      } catch {
        if (session) close(session)
        return response(null, 403)
      }
    },
  })
  return async () => {
    disposed = true
    clearInterval(timer)
    for (const session of sessions.values()) close(session)
    await unregister()
  }
}
