import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

/* global require */
const ROUTE = 'api/ds-bot/computer-viewer'

// noVNC's public raw-channel interface also works on DSH's shell Fetch carrier.
export class ComputerChannel {
  constructor(botId, generation, fetcher = globalThis.fetch) {
    this.readyState = 0
    this.binaryType = 'arraybuffer'
    this.protocol = ''
    this.onopen = this.onmessage = this.onclose = this.onerror = null
    this.controller = new AbortController()
    this.fetcher = (...args) => fetcher(...args)
    this.queue = []
    this.queuedBytes = 0
    this.writing = false
    this.start = setTimeout(() => { void this.open(botId, generation) }, 0)
  }
  async request(operation, args = {}) {
    const response = await this.fetcher(ROUTE, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, id: this.id, ...args }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) throw new Error('Desktop stream unavailable.')
    return response
  }
  async open(botId, generation) {
    try {
      const response = await this.request('open', { botId, generation })
      this.id = (await response.json()).id
      if (this.readyState === 3) { this.release(); return }
      this.readyState = 1
      this.onopen?.()
      while (this.readyState === 1) {
        const data = await (await this.request('read')).arrayBuffer()
        if (this.readyState === 1 && data.byteLength) this.onmessage?.({ data })
      }
    } catch { this.close() }
  }
  send(data) {
    if (this.readyState !== 1 || this.queuedBytes + data.byteLength > 65536) { this.close(); return }
    const copy = new Uint8Array(data)
    this.queue.push(copy)
    this.queuedBytes += copy.byteLength
    void this.flush()
  }
  async flush() {
    if (this.writing || this.readyState !== 1) return
    this.writing = true
    try {
      while (this.queue.length && this.readyState === 1) {
        let binary = ''
        for (const bytes of this.queue.splice(0)) for (const byte of bytes) binary += String.fromCharCode(byte)
        this.queuedBytes = 0
        await this.request('write', { data: btoa(binary) })
      }
    } catch { this.close() }
    finally { this.writing = false }
  }
  release() {
    if (!this.id) return
    void this.fetcher(ROUTE, { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'close', id: this.id }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    this.id = null
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    clearTimeout(this.start)
    this.controller.abort()
    this.queue.length = 0
    this.queuedBytes = 0
    this.release()
    this.onclose?.({ code: 1000, wasClean: true })
  }
}

export function ComputerScreen({ live, botId, generation, frame, onPresented, onReady, onLost, onFallback, onPointer }) {
  const canvas = useRef(null)
  const decoder = useRef(null)
  const hasPixels = useRef(false)
  const callbacks = useRef(null)
  callbacks.current = { onPresented, onReady, onLost, onFallback, onPointer }
  const [status, setStatus] = useState('connecting')
  const [painted, setPainted] = useState(false)
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  const paint = image => {
    const surface = canvas.current
    if (!surface) return
    if (surface.width !== image.width) surface.width = image.width
    if (surface.height !== image.height) surface.height = image.height
    const context = surface.getContext('2d')
    if (image instanceof Image) context.drawImage(image, 0, 0)
    else context.putImageData(image, 0, 0)
    hasPixels.current = true
    setPainted(true)
  }
  useEffect(() => {
    const surface = canvas.current
    surface?.getContext('2d').clearRect(0, 0, surface.width, surface.height)
    hasPixels.current = false
    setPainted(false)
  }, [botId, generation])
  useEffect(() => {
    if (!frame || (live && hasPixels.current)) return
    let cancelled = false
    const image = new Image()
    image.src = `data:image/png;base64,${frame.data}`
    void image.decode().then(() => {
      if (cancelled || (live && hasPixels.current)) return
      paint(image)
      callbacks.current.onPresented?.(frame.data)
    }).catch(() => { if (!cancelled) callbacks.current.onPresented?.(null) })
    return () => { cancelled = true }
  }, [live, frame, botId, generation])
  useEffect(() => {
    if (!live || !visible || !decoder.current) return
    let stopped = false, current, channel, retry, draw, deadline
    let attempts = 0, hadFrame = false, lost = false
    const disconnect = () => {
      clearInterval(draw)
      clearTimeout(deadline)
      current?.disconnect()
      channel?.close()
      decoder.current?.replaceChildren()
    }
    const failed = () => {
      if (stopped || lost) return
      lost = true
      disconnect()
      callbacks.current.onLost?.()
      setStatus('reconnecting')
      if (++attempts >= 4) { callbacks.current.onFallback?.(); return }
      retry = setTimeout(connect, Math.min(500 * 2 ** (attempts - 1), 5000))
    }
    const connect = () => {
      if (stopped) return
      lost = false
      hadFrame = false
      try {
        const RFB = require('@novnc/novnc').default
        channel = new ComputerChannel(botId, generation)
        current = new RFB(decoder.current, channel, { shared: true })
        current.viewOnly = true
        current.resizeSession = false
        const connection = current
        current.addEventListener('disconnect', () => { if (current === connection) { current = null; failed() } })
        current.addEventListener('securityfailure', failed)
        deadline = setTimeout(failed, 20_000)
        // noVNC owns and removes its decoder canvas on disconnect. Our display
        // canvas survives it and is updated only after real pixels arrive.
        draw = setInterval(() => {
          if (stopped || lost) return
          try {
            const image = current.getImageData()
            if (!image.width || !image.height) return
            if (!hadFrame) {
              let opaque = false
              for (let i = 3; i < image.data.length; i += 4) if (image.data[i]) { opaque = true; break }
              if (!opaque) return
              hadFrame = true
              attempts = 0
              clearTimeout(deadline)
              setStatus('live')
              callbacks.current.onReady?.()
            }
            paint(image)
          } catch { /* The framebuffer has no dimensions until ServerInit. */ }
        }, 66)
      } catch { failed() }
    }
    setStatus('connecting')
    connect()
    return () => { stopped = true; clearTimeout(retry); disconnect(); callbacks.current.onLost?.() }
  }, [live, visible, botId, generation])
  return h('div', { className: 'bt-computer-display' },
    h('div', { ref: decoder, className: 'bt-computer-decoder', 'aria-hidden': true }),
    h('canvas', { ref: canvas, className: 'bt-computer-canvas', hidden: !painted, 'aria-label': t('Private desktop screenshot'),
      onClick: event => callbacks.current.onPointer?.(event, 'click'),
      onContextMenu: event => callbacks.current.onPointer?.(event, 'click'),
      onWheel: event => callbacks.current.onPointer?.(event, 'scroll'),
    }),
    !painted ? h('p', { className: 'bt-muted' }, t('No current desktop image. Input is disabled.')) : null,
    live && status !== 'live' ? h('span', { className: 'bt-computer-stream-status', role: 'status' }, t(status === 'connecting' ? 'Connecting to desktop…' : 'Reconnecting to desktop…')) : null)
}
