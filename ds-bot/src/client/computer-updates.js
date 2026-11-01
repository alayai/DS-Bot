import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

const PHASE = {
  checking: 'Checking verified releases', downloading: 'Downloading desktop image', verifying: 'Verifying desktop image',
  cancelling: 'Cancelling image task', interrupted: 'Image task interrupted', cancelled: 'Image task cancelled', failed: 'Image task failed',
  available: 'A verified image is available', prepared: 'Image ready for upgrade', current: 'No verified update is available',
}
export function ComputerUpdates({ call, changed }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    let polling = false
    const poll = async () => {
      if (polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const value = await call('image-state')
        if (alive.current) setState(value)
      } catch (reason) { if (alive.current) setError(reason.message) }
      finally { polling = false }
    }
    void poll()
    const timer = setInterval(poll, 2000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])
  async function request(method, args) {
    if (pending) return
    setPending(true)
    setError('')
    try {
      const value = await call(method, args)
      if (alive.current) { setState(value); changed?.() }
    } catch (reason) { if (alive.current) setError(reason.message) }
    finally { if (alive.current) setPending(false) }
  }
  const job = state?.job
  const candidate = job?.candidate
  const button = (label, method, args, disabled = false) => h('button', {
    type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending || disabled,
    onClick: () => void request(method, args),
  }, t(label))
  return h('details', { className: 'bt-computer-help' },
    h('summary', null, t('Desktop image updates')),
    error ? h('p', { className: 'bt-error', role: 'status' }, error) : null,
    state && !state.supported ? h('p', { className: 'bt-muted' },
      t('Automatic image downloads require a desktop prepared by this plugin. Explicit runtime profiles manage their image list manually.')) : null,
    h('p', { className: 'bt-muted' }, t('Downloading an image keeps your current desktops unchanged. Stop a desktop and confirm its upgrade after the download is verified.')),
    h('div', { className: 'bt-computer-row' },
      button('Check for image updates', 'image-check', {}, !state?.supported || state.busy),
      candidate && !state.busy ? button('Download and verify image', 'image-download', { candidateId: candidate.id }, !state.supported || !state.canDownload || job.phase === 'prepared') : null,
      state?.busy ? button('Cancel image task', 'image-cancel', { jobId: job.id }, job.phase === 'cancelling') : null),
    job ? h('p', { role: 'status' }, t(PHASE[job.phase] ?? job.phase)) : null,
    candidate ? h('p', null, `${candidate.tag} · ${candidate.image.slice(0, 23)} · ${new Date(candidate.publishedAt).toLocaleDateString()}`) : null,
    job?.error ? h('p', { className: 'bt-error', role: 'status' }, job.error) : null,
    job?.log ? h('pre', { className: 'bt-computer-log', 'aria-label': t('Image download progress') }, job.log) : null)
}
