import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { ComputerChannel } from './computer-channel.js'
import { ReconnectBudget, streamFailure } from '../shared/computer-stream.js'
export { ComputerChannel } from './computer-channel.js'

/* global require */

const KEYS = { Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, Backspace: 0xff08, Delete: 0xffff,
  ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, Space: 0x20 }

export function ComputerScreen({ live, botId, generation, frame, controlToken, onControls, onPresented, onReady, onLost, onFallback, onPointer, channelOptions }) {
  const canvas = useRef(null)
  const decoder = useRef(null)
  const hasPixels = useRef(false)
  const callbacks = useRef(null)
  callbacks.current = { onPresented, onReady, onLost, onFallback, onPointer, onControls }
  const identity = useRef(null)
  identity.current = `${botId}:${generation}`
  const [status, setStatus] = useState('connecting')
  const [problem, setProblem] = useState(null)
  const [painted, setPainted] = useState(false)
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden')
  const [suspended, setSuspended] = useState(false)
  useEffect(() => { setSuspended(false) }, [controlToken])
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
    if (!live || !visible || suspended || !decoder.current) return
    let stopped = false, current, retry
    const budget = new ReconnectBudget()
    const owner = `${botId}:${generation}`
    const capture = attempt => {
      if (!attempt?.hadFrame || identity.current !== owner) return
      try { paint(attempt.rfb.getImageData()) } catch { /* Keep the last good poster if capture fails. */ }
    }
    const disconnect = attempt => {
      if (!attempt) return
      callbacks.current.onControls?.(null)
      clearInterval(attempt.probe)
      clearTimeout(attempt.deadline)
      if (!attempt.disconnected) attempt.rfb?.disconnect()
      attempt.channel?.close()
      decoder.current?.replaceChildren()
    }
    const fail = (attempt, error) => {
      if (stopped || current !== attempt || attempt.lost) return
      attempt.lost = true
      const detail = streamFailure(error ?? attempt.channel?.error ?? 'closed')
      capture(attempt)
      disconnect(attempt)
      callbacks.current.onLost?.(detail)
      setProblem(controlToken && detail.code === 'closed' ? null : detail)
      if (controlToken) { setStatus('paused'); setSuspended(true); return }
      setStatus('reconnecting')
      const delay = budget.failed(detail)
      if (delay === null) { callbacks.current.onFallback?.(detail); return }
      retry = setTimeout(connect, delay)
    }
    const connect = () => {
      if (stopped) return
      const attempt = { lost: false, hadFrame: false }
      current = attempt
      try {
        const RFB = require('@novnc/novnc').default
        attempt.channel = new ComputerChannel(botId, generation, globalThis.fetch, { ...channelOptions, controlToken })
        attempt.rfb = new RFB(decoder.current, attempt.channel, { shared: true })
        attempt.rfb.viewOnly = true
        attempt.rfb.scaleViewport = true
        attempt.rfb.resizeSession = false
        attempt.rfb.addEventListener('disconnect', () => { attempt.disconnected = true; fail(attempt) })
        attempt.rfb.addEventListener('securityfailure', () => fail(attempt, 'protocol'))
        attempt.deadline = setTimeout(() => fail(attempt, 'timeout'), 20_000)
        attempt.rfb.addEventListener('connect', () => {
          if (stopped || current !== attempt || attempt.lost) return
          attempt.probe = setInterval(() => {
            if (stopped || current !== attempt || attempt.lost) return
            try {
              const image = attempt.rfb.getImageData()
              if (!image.width || !image.height) return
              let opaque = false
              for (let i = 3; i < image.data.length; i += 4) if (image.data[i]) { opaque = true; break }
              if (!opaque) return
              // The live noVNC canvas renders incremental updates directly. Copy
              // only the first frame and the last frame before losing that canvas.
              paint(image)
              attempt.hadFrame = true
              clearInterval(attempt.probe)
              clearTimeout(attempt.deadline)
              budget.ready()
              if (controlToken) {
                if (!attempt.channel.interactive) { fail(attempt, 'control'); return }
                attempt.rfb.viewOnly = false
                const send = keys => {
                  if (stopped || attempt.lost || !attempt.hadFrame || document.visibilityState === 'hidden') return
                  for (const key of keys) attempt.rfb.sendKey(key)
                }
                callbacks.current.onControls?.({
                  key: name => { if (KEYS[name]) send([KEYS[name]]) },
                  text: value => {
                    if (typeof value !== 'string' || !value.length || value.length > 4000 || value.includes('\0')) return
                    send(Array.from(value, character => {
                      const point = character.codePointAt(0)
                      return point === 10 ? KEYS.Enter : point === 9 ? KEYS.Tab : point <= 255 ? point : 0x1000000 + point
                    }))
                  },
                })
              }
              setProblem(null)
              setStatus('live')
              callbacks.current.onReady?.({ transport: attempt.channel.transport })
            } catch { fail(attempt, 'display') }
          }, 66)
        })
      } catch { fail(attempt, 'display') }
    }
    setProblem(null)
    setStatus('connecting')
    connect()
    const pause = () => {
      if (!controlToken) return
      capture(current)
      if (current) current.lost = true
      disconnect(current)
      callbacks.current.onLost?.()
      setProblem(null)
      setStatus('paused')
      setSuspended(true)
    }
    if (controlToken) window.addEventListener('blur', pause)
    return () => {
      stopped = true
      if (controlToken) window.removeEventListener('blur', pause)
      if (controlToken && document.visibilityState === 'hidden') setSuspended(true)
      clearTimeout(retry)
      capture(current)
      disconnect(current)
      callbacks.current.onLost?.()
    }
  }, [live, visible, suspended, controlToken, botId, generation])
  return h('div', { className: 'bt-computer-display' },
    h('div', { ref: decoder, className: 'bt-computer-decoder',
      'data-live': live && visible && !suspended && status === 'live' || undefined,
      'data-interactive': Boolean(controlToken) || undefined, 'aria-label': t('Live desktop'), 'aria-hidden': !controlToken }),
    h('canvas', { ref: canvas, className: 'bt-computer-canvas', hidden: !painted, 'aria-label': t('Private desktop screenshot'),
      onClick: event => callbacks.current.onPointer?.(event, 'click'),
      onContextMenu: event => callbacks.current.onPointer?.(event, 'click'),
      onWheel: event => callbacks.current.onPointer?.(event, 'scroll'),
    }),
    !painted ? h('p', { className: 'bt-muted' }, t('No current desktop image. Input is disabled.')) : null,
    live && (suspended || status !== 'live') ? h('span', { className: 'bt-computer-stream-status', role: 'status' },
      t(problem?.message ?? (suspended ? 'Live control paused. The Bot remains paused.' : status === 'connecting' ? 'Connecting to desktop…' : 'Reconnecting to desktop…')),
      suspended && controlToken ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setSuspended(false) }, t('Resume live control')) : null) : null)
}
