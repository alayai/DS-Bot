import { randomUUID } from 'node:crypto'
import { refused } from './contract.js'

export function createImageUpdates({ load, data, save, writable, payload, service, available, now = Date.now }) {
  let operation, starting = false, stopping = false, candidate, startingTask
  const view = () => ({
    supported: available(), busy: Boolean(starting || operation),
    canDownload: Boolean(candidate && candidate.id === data().imageUpdate?.candidate?.id),
    images: data().config ? [data().config.image, ...(data().config.images ?? [])] : [],
    job: data().imageUpdate ?? null,
  })
  async function state() { await load(); return view() }
  async function update(fields) {
    data().imageUpdate = { ...data().imageUpdate, ...fields, updatedAt: now() }
    await save()
  }
  async function begin(method, { candidateId } = {}) {
    await load()
    writable()
    if (stopping || !available()) throw refused('unavailable', 'Image updates require a desktop prepared by this plugin. Explicit runtime profiles manage their image list manually.')
    if (operation || starting) throw refused('busy', 'An image task is already running.')
    if (method === 'download' && (!candidate || candidate.id !== candidateId)) throw refused('conflict', 'Check for image updates again before downloading.')
    if (!['check', 'download'].includes(method)) throw refused('invalid', 'Unknown image operation.')
    if (method === 'download' && (data().config.images?.length ?? 0) >= 4 && !view().images.includes(candidate.image)) {
      throw refused('resource-limit', 'The four prepared image slots are full. Retain images used by previous homes; image pruning requires manual maintenance.')
    }
    starting = true
    let started
    startingTask = new Promise(resolve => { started = resolve })
    try {
      const selected = candidate
      if (method === 'check') candidate = undefined
      await update({ id: randomUUID(), phase: method === 'check' ? 'checking' : 'downloading', error: null, log: '',
        ...(method === 'check' ? { candidate: null } : {}) })
      if (stopping) { await update({ phase: 'interrupted' }); return view() }
      const controller = new AbortController()
      const entry = { controller }
      operation = entry
      entry.done = (async () => {
        const tools = await payload()
        const signal = controller.signal
        if (method === 'check') {
          candidate = await tools.findRelease({ signal })
          signal.throwIfAborted()
          if (candidate && view().images.includes(candidate.image)) {
            await tools.image(data().config.engine, candidate.image)
            signal.throwIfAborted()
            await service().registerImage(candidate.image)
          }
          await update({ phase: candidate ? (view().images.includes(candidate.image) ? 'prepared' : 'available') : 'current',
            candidate: candidate ? { id: candidate.id, image: candidate.image, tag: candidate.tag,
              publishedAt: candidate.publishedAt, evidence: candidate.evidence } : null })
        } else {
          await tools.prepareRelease(data().config.engine, selected, {
            signal, log: text => { data().imageUpdate.log = (data().imageUpdate.log + String(text)).slice(-8000) },
          })
          signal.throwIfAborted()
          await update({ phase: 'verifying' })
          await tools.image(data().config.engine, selected.image)
          signal.throwIfAborted()
          // Save only verified pins before registration. A restart can then
          // recreate the same allowlist even if IPC loses its acknowledgement.
          const config = data().config
          config.images = [...new Set([...(config.images ?? []), selected.image])].filter(id => id !== config.image)
          await save()
          await service().registerImage(selected.image)
          await update({ phase: 'prepared' })
        }
      })().catch(async error => {
        await update({ phase: controller.signal.aborted ? (stopping ? 'interrupted' : 'cancelled') : 'failed',
          error: String(error.message ?? 'Image update failed.').slice(0, 500) })
      }).catch(() => {
        data().imageUpdate = { ...data().imageUpdate, phase: 'failed', error: 'Image update state could not be saved. Restart DSH before continuing.' }
      }).finally(() => { if (operation === entry) operation = undefined })
      return view()
    } finally { starting = false; started(); startingTask = undefined }
  }
  async function cancel({ jobId } = {}) {
    await load()
    writable()
    if (jobId !== data().imageUpdate?.id) throw refused('conflict', 'The image task changed. Refresh before cancelling.')
    if (operation) {
      const entry = operation
      await update({ phase: 'cancelling' })
      entry.controller.abort()
      void entry.done.then(async () => {
        if (data().imageUpdate.phase === 'cancelling') await update({ phase: 'cancelled' })
      }).catch(() => {})
    }
    return view()
  }
  async function dispose() {
    stopping = true
    operation?.controller.abort()
    await startingTask
    operation?.controller.abort()
    await operation?.done
  }
  return { state, check: args => begin('check', args), download: args => begin('download', args), cancel, dispose }
}
