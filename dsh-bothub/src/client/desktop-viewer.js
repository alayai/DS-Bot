import { createElement as h, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createDesktopPreview } from './desktop-preview.js'
import { createDesktopCanvas } from './desktop-canvas.js'

export function DesktopViewer({ entity, connected, onClose, t }) {
  const dialog = useRef(null), canvas = useRef(null), close = useRef(onClose)
  close.current = onClose
  const title = useId(), hint = useId()
  const [closing, setClosing] = useState(false)
  const [actual, setActual] = useState(false)
  const [display, setDisplay] = useState({ status: 'loading', frame: false })
  useLayoutEffect(() => {
    const element = dialog.current
    const origin = document.activeElement
    const fallback = element.closest('.bh-root')
    element.showModal()
    return () => {
      element.close()
      const target = origin?.isConnected && origin !== document.body && !origin.matches(':disabled')
        ? origin : fallback?.querySelector('.bh-scene') ?? fallback
      target?.focus({ preventScroll: true })
    }
  }, [])
  useLayoutEffect(() => {
    const surface = createDesktopCanvas(canvas.current)
    let disposed = false
    const feed = createDesktopPreview({
      async publish(id, event) {
        if (disposed) return
        if (event.frame) {
          if (await surface.paint(event.frame, event.signal) && !disposed) setDisplay({ status: event.status, frame: true })
        } else {
          if (event.clear) surface.clear()
          setDisplay(previous => ({ status: event.status, frame: event.clear ? false : previous.frame }))
        }
      },
    })
    const visibility = () => {
      const enabled = connected && !closing && !document.hidden
      feed.targets(enabled ? [entity.id] : [])
      if (!enabled) surface.clear()
      setDisplay({ status: enabled ? 'loading' : connected ? 'standby' : 'unavailable', frame: false })
    }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      feed.dispose()
      surface.dispose()
    }
  }, [entity.id, connected, closing])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => close.current(), 160)
    return () => clearTimeout(timer)
  }, [closing])
  return h('dialog', {
    ref: dialog, className: `bh-desktop-viewer${closing ? ' bh-closing' : ''}`,
    'aria-labelledby': title, 'aria-describedby': hint, 'aria-modal': true,
    onCancel: event => { event.preventDefault(); setClosing(true) },
    onKeyDown: event => {
      if (event.key === 'Escape') event.stopPropagation()
      if (event.key !== 'Tab') return
      const stops = [...event.currentTarget.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
      const first = stops[0], last = stops.at(-1)
      if (event.shiftKey && event.target === first || !event.shiftKey && event.target === last) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target?.focus()
      }
    },
  },
  h('header', { className: 'bh-desktop-header' },
    h('h2', { id: title }, `${entity.name} · ${t('privateDesktop')}`),
    h('button', { type: 'button', className: 'bh-button', autoFocus: true, onClick: () => setClosing(true) }, t('closeDesktop'))),
  h('div', { className: 'bh-desktop-toolbar' },
    h('span', { role: 'status', 'data-preview-status': display.status }, t(`screen_${display.status}`)),
    h('div', { className: 'bh-switch', role: 'group', 'aria-label': t('desktopSize') },
      h('button', { type: 'button', 'aria-pressed': !actual, onClick: () => setActual(false) }, t('desktopFit')),
      h('button', { type: 'button', 'aria-pressed': actual, onClick: () => setActual(true) }, t('desktopActual')))),
  h('div', { className: `bh-desktop-viewport${actual ? ' bh-desktop-actual' : ''}`, tabIndex: 0, role: 'region', 'aria-label': t('privateDesktop') },
    h('canvas', { ref: canvas, hidden: !display.frame, role: 'img', 'aria-label': `${entity.name} · ${t('screen_live')}` }),
    !display.frame && h('div', { className: 'bh-desktop-placeholder' }, h('span', { 'aria-hidden': true }, '▰'),
      h('p', null, t(`screen_${display.status}`)))),
  h('p', { id: hint, className: 'bh-desktop-hint' }, t('desktopReadOnly')))
}
