import { WebSocketServer } from 'ws'
import { streamFailure } from '../../shared/computer-stream.js'

const LIMIT = 65536
const WINDOW = 512 * 1024
const PATH = '/api/ds-bot/computer-viewer/socket'

export function registerViewerSocket(rt, sessions, close, write) {
  const server = rt.ctx.get?.('webServer')
  const connection = rt.ctx.get?.('connection')
  if (!server?.registerUpgrade || !connection?.admit) return null
  const sockets = new Set()
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMIT, perMessageDeflate: false })
  let disposed = false
  const unregister = server.registerUpgrade({ path: PATH, handler(req, socket, head) {
    const admission = connection.admit(req)
    if (disposed || 'rejection' in admission || admission.peer.principal.kind !== 'owner' || admission.peer.signal.aborted || sockets.size >= 16) {
      const status = disposed ? 503 : admission.rejection ?? (sockets.size >= 16 ? 429 : 403)
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws)
      let session, pendingAck, outgoing = 0, sequence = 0, writing = Promise.resolve(), inputBytes = 0
      let alive = true, ended = false
      const outstanding = []
      const stop = error => {
        if (ended) return
        ended = true
        clearTimeout(deadline)
        clearInterval(heartbeat)
        admission.peer.signal.removeEventListener('abort', revoked)
        sockets.delete(ws)
        if (session) close(session, error)
        if (ws.readyState === 1) ws.close(4000, streamFailure(error ?? 'closed').code)
        const kill = setTimeout(() => ws.terminate(), 1000)
        kill.unref?.()
        ws.once('close', () => clearTimeout(kill))
      }
      const revoked = () => stop('forbidden')
      const deadline = setTimeout(() => stop('timeout'), 5000)
      const heartbeat = setInterval(() => {
        const check = connection.admit(req)
        if ('rejection' in check || check.peer !== admission.peer || check.peer.principal.kind !== 'owner') return stop('auth')
        if (!alive || (outstanding.length && Date.now() - outstanding[0].at > 30_000)) return stop('timeout')
        alive = false
        ws.ping()
        if (session && !session.stream.interactive) session.touched = Date.now()
      }, 15_000)
      heartbeat.unref?.()
      admission.peer.signal.addEventListener('abort', revoked, { once: true })
      const resume = () => {
        if (ended || outgoing > WINDOW - LIMIT || !pendingAck) return
        const acknowledge = pendingAck
        pendingAck = null
        acknowledge()
      }
      const pump = () => {
        if (ended || !session || pendingAck || !session.queue.length) return
        const chunk = session.queue.shift()
        session.bytes -= chunk.data.length
        outgoing += chunk.data.length
        outstanding.push({ sequence: ++sequence, bytes: chunk.data.length, at: Date.now() })
        ws.send(chunk.data, { binary: true }, error => {
          if (error) return stop('network')
          if (ended) return
          pendingAck = chunk.acknowledge
          resume()
        })
      }
      ws.on('pong', () => { alive = true })
      ws.on('error', () => stop('network'))
      ws.on('close', () => stop('closed'))
      ws.on('message', (data, binary) => {
        if (ended) return
        try {
          if (!session) {
            if (binary || data.length > 200) return stop('protocol')
            const hello = JSON.parse(data.toString())
            const target = sessions.get(hello.id)
            if (!target || target.closed) return stop('closed')
            if (target.socket || target.reading || target.writing || target.acknowledge) return stop('busy')
            session = target
            session.socket = { pump, stop }
            session.touched = Date.now()
            clearTimeout(deadline)
            ws.send(JSON.stringify({ ready: true }))
            pump()
            return
          }
          session.touched = Date.now()
          if (!binary) {
            if (data.length > 100) return stop('protocol')
            const ack = JSON.parse(data.toString()).ack
            if (!outstanding.length || ack !== outstanding[0].sequence) return stop('protocol')
            outgoing -= outstanding.shift().bytes
            resume()
            return
          }
          if (inputBytes + data.length > LIMIT) return stop('protocol')
          inputBytes += data.length
          writing = writing.then(async () => {
            if (ended) return
            await session.stream.validate()
            await write(session, data)
            inputBytes -= data.length
          }).catch(stop)
        } catch { stop('protocol') }
      })
    })
  } })
  return { path: PATH, async dispose() {
    disposed = true
    await unregister()
    for (const socket of sockets) socket.terminate()
    wss.close()
  } }
}
