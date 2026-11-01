import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
const PART = 64 * 1024 ** 2
const encode = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text) }
export function backupSelection(files) {
  const list = Array.from(files)
  if (!list.length) throw Error('Choose a backup file.')
  if (list.length === 1 && list[0].name.endsWith('.dsbackup')) return list
  const parsed = list.map(file => ({ file, match: /^(.*\.dsbackup)\.(\d{6})-of-(\d{6})$/.exec(file.name) }))
  if (parsed.some(item => !item.match)) throw Error('Choose one complete backup or all numbered backup parts.')
  parsed.sort((a, b) => Number(a.match[2]) - Number(b.match[2]))
  if (parsed.some((item, index) => item.match[1] !== parsed[0].match[1] || Number(item.match[2]) !== index + 1 || Number(item.match[3]) !== parsed.length
    || item.file.size <= 0 || item.file.size > PART || (index < parsed.length - 1 && item.file.size !== PART))) throw Error('Backup parts are missing, duplicated or have changed size.')
  return parsed.map(item => item.file)
}
export function ComputerPortable({ record, call, changed }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null), [part, setPart] = useState(1), [confirmation, setConfirmation] = useState(false), [split, setSplit] = useState(false)
  const picker = useRef(null), run = useRef(null), alive = useRef(true), lastStatus = useRef(null)
  const job = state?.job, own = job?.botId === record?.botId
  const cmd = (method, args = {}) => call('portable', { method, id: job?.id, ...args })
  async function refresh() {
    const value = await call('portable-state')
    if (alive.current) {
      setState(value)
      if (value.job?.status === 'completed' && lastStatus.current !== 'completed') changed()
      lastStatus.current = value.job?.status
    }
  }
  useEffect(() => {
    alive.current = true
    let polling = false
    const poll = async () => { if (polling || run.current || document.visibilityState === 'hidden') return; polling = true; try { await refresh() } catch (e) { if (alive.current) setError(e.message) } finally { polling = false } }
    void poll(); const timer = setInterval(poll, 2000)
    return () => { alive.current = false; clearInterval(timer); if (run.current) run.current.cancelled = true }
  }, [record?.botId])
  async function work(fn) {
    if (run.current) return
    const task = { cancelled: false }; run.current = task; setBusy(true); setError('')
    try { await fn(task); if (alive.current) { await refresh(); changed() } }
    catch (e) { if (alive.current) setError(e.message) }
    finally { run.current = null; if (alive.current) { setBusy(false); setProgress(null) } }
  }
  const check = task => { if (task.cancelled) throw Error('Backup transfer stopped. Discard the partial transfer or retry the download.') }
  function upload(event) {
    let files
    try { files = backupSelection(event.target.files) } catch (e) { setError(e.message); return }
    event.target.value = ''
    void work(async task => {
      const total = files.reduce((sum, file) => sum + file.size, 0)
      const started = await cmd('upload', { bytes: total }), id = started.job.id
      let offset = 0
      for (const file of files) for (let at = 0; at < file.size; at += started.chunkSize) {
        check(task)
        const bytes = new Uint8Array(await file.slice(at, at + started.chunkSize).arrayBuffer())
        await cmd('write', { id, offset, data: encode(bytes) }); offset += bytes.length
        if (alive.current) setProgress({ offset, total })
      }
    })
  }
  function download() {
    // Acquire the native picker in the click gesture, before any channel request.
    const handle = !split && typeof window.showSaveFilePicker === 'function' ? window.showSaveFilePicker({ suggestedName: `${job.id}.dsbackup` }) : null
    void work(async task => {
      const writer = handle ? await (await handle).createWritable() : null
      const count = Math.ceil(job.bytes / PART), selected = Math.min(Math.max(1, Math.trunc(part)), count)
      let offset = writer ? 0 : (selected - 1) * PART
      const end = writer ? job.bytes : Math.min(job.bytes, offset + PART), chunks = []
      try {
        while (offset < end) {
          check(task)
          const value = await cmd('read', { offset })
          const data = Uint8Array.from(atob(value.data), c => c.charCodeAt(0))
          if (value.offset !== offset + data.length || !data.length || value.offset > end) throw Error('Invalid backup download chunk.')
          if (writer) await writer.write(data); else chunks.push(data)
          offset = value.offset; if (alive.current) setProgress({ offset, total: end })
        }
        check(task)
        if (writer) await writer.close()
        else {
          const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' })), a = document.createElement('a')
          a.href = url; a.download = count === 1 ? `${job.id}.dsbackup` : `${job.id}.dsbackup.${String(selected).padStart(6, '0')}-of-${String(count).padStart(6, '0')}`
          a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
          if (alive.current) setPart(Math.min(count, selected + 1))
        }
      } catch (e) { await writer?.abort().catch(() => {}); throw e }
    })
  }
  if (!record || state?.supported === false) return null
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || disabled, onClick }, t(label))
  return h('details', { className: 'bt-computer-help' }, h('summary', null, t('External desktop backup')),
    h('p', { className: 'bt-muted' }, t('Stop the desktop before export or import. Import verifies every file in a new home and retains the previous home. The original image must be available.')),
    h('p', { className: 'bt-muted' }, t('Keep backups private: they include browser profiles and login data. A ready export is temporary until you save it outside DSH.')),
    error ? h('p', { role: 'alert', className: 'bt-error' }, t(error)) : null,
    job && !own ? h('p', { role: 'status' }, t('Another Bot has a portable backup. Finish or discard it in that Bot desktop.')) : null,
    !job ? h('div', { className: 'bt-computer-row' },
      button('Prepare external backup', () => void work(() => cmd('export')), record.phase !== 'stopped' || record.recoveryPending),
      button('Choose backup files', () => picker.current?.click(), record.phase !== 'stopped' || record.recoveryPending),
      h('input', { type: 'file', hidden: true, multiple: true, ref: picker, onChange: upload, 'aria-label': t('Choose backup files') })) : null,
    own ? h('div', null,
      h('p', { role: 'status' }, `${t('Backup status')}: ${t(job.status)} · ${(job.bytes / 1048576).toFixed(1)} MiB`),
      job.sha256 ? h('p', { className: 'bt-muted' }, `SHA-256: ${job.sha256}`) : null,
      job.error ? h('p', { className: 'bt-error' }, job.error) : null,
      job.status === 'ready' ? h('div', { className: 'bt-computer-row' },
        typeof globalThis.showSaveFilePicker === 'function' ? h('label', null, h('input', { type: 'checkbox', checked: split, disabled: busy, onChange: e => setSplit(e.target.checked) }), t('Use numbered backup parts')) : null,
        (split || typeof window.showSaveFilePicker !== 'function') && job.bytes > PART ? h('label', null,
          t('Download part'), ` / ${Math.ceil(job.bytes / PART)} `,
          h('input', { type: 'number', min: 1, max: Math.ceil(job.bytes / PART), value: part, onChange: e => setPart(Number(e.target.value) || 1), disabled: busy })) : null,
        button('Save backup to this computer', download),
        h('p', { className: 'bt-muted' }, t('If a native save picker is unavailable, save every numbered 64 MiB part. Select all parts together when importing. Verify the saved files before discarding this export.'))) : null,
      job.status === 'uploading' && job.offset === job.bytes ? h('div', null,
        confirmation ? h('p', null, t('Replace the current home with this backup? The previous home remains available for rollback.')) : null,
        button(confirmation ? 'Confirm backup import' : 'Import uploaded backup', () => confirmation ? void work(async () => { await cmd('import', { confirm: true }); setConfirmation(false) }) : setConfirmation(true), record.phase !== 'stopped' || record.generation !== job.generation)) : null,
      button(state.busy ? 'Cancel backup operation' : 'Discard temporary backup', () => void work(() => cmd('cancel')))) : null,
    progress ? h('progress', { value: progress.offset, max: progress.total, 'aria-label': t('Backup transfer progress') }) : null,
    busy ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { if (run.current) run.current.cancelled = true } }, t('Stop transfer')) : null)
}
