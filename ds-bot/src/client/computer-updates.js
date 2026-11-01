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
  const [confirmation, setConfirmation] = useState(null)
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
    setConfirmation(null)
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
      state?.imageBusy && job ? button('Cancel image task', 'image-cancel', { jobId: job.id }, job.phase === 'cancelling') : null),
    job ? h('p', { role: 'status' }, t(PHASE[job.phase] ?? job.phase)) : null,
    candidate ? h('p', null, `${candidate.tag} · ${candidate.image.slice(0, 23)} · ${new Date(candidate.publishedAt).toLocaleDateString()}`) : null,
    job?.error ? h('p', { className: 'bt-error', role: 'status' }, job.error) : null,
    job?.log ? h('pre', { className: 'bt-computer-log', 'aria-label': t('Image download progress') }, job.log) : null,
    h('p', { className: 'bt-muted' }, t('Interrupted downloads keep their progress. Check for updates again after restarting, then download to continue.')),
    state?.cache?.bytes > 0 ? h('div', { className: 'bt-computer-row' },
      h('span', null, `${t('Cached download')}: ${(state.cache.bytes / 1024 ** 2).toFixed(1)} MiB`),
      button('Clear download cache', 'image-cache-clear', {}, state.busy)) : null,
    h('details', { className: 'bt-computer-help' },
      h('summary', null, t('Desktop storage cleanup')),
      h('p', { className: 'bt-muted' }, t('Scan for unused images and orphan storage. Current desktops, saved checkpoints and rollback homes are protected.')),
      button('Scan unused resources', 'image-cleanup-scan', {}, !state?.supported || state.busy),
      state?.cleanup?.items.length === 0 ? h('p', null, t('No managed resources found.')) : null,
      ...(state?.cleanup?.items ?? []).map(item => h('div', { key: `${item.kind}:${item.id}`, className: 'bt-computer-help' },
        h('p', { style: { overflowWrap: 'anywhere' } }, `${t(item.kind === 'image' ? 'Image' : 'Storage volume')}: ${item.id}`),
        h('p', { className: 'bt-muted' }, item.reason ? t(item.reason) : t(item.missing ? 'Image is already absent; remove its saved entry.' : 'Unused resource')),
        item.bytes > 0 ? h('p', { className: 'bt-muted' }, `${(item.bytes / 1024 ** 2).toFixed(1)} MiB · ${t('Shared image layers may remain on disk.')}`) : null,
        item.removable ? (confirmation?.id === item.id && confirmation.token === state.cleanup.token
          ? h('div', null,
            h('p', { className: 'bt-error' }, t('Permanently delete this resource? This cannot be undone.')),
            button('Confirm deletion', 'image-cleanup-remove', confirmation, state.busy),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirmation(null) }, t('Cancel')))
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending || state.busy,
            onClick: () => setConfirmation({ token: state.cleanup.token, id: item.id, kind: item.kind }) }, t('Delete unused resource'))) : null))))
}
