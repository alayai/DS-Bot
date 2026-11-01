import { createElement as h, useEffect, useRef, useState } from 'react'
import { imagePoint, freshFrame } from './computer-model.js'
import { t } from './i18n.js'

import { ComputerScreen } from './computer-stream.js'
const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']
const PHASE = { ready: 'Running', stopped: 'Stopped', starting: 'Starting', error: 'Needs recovery', unavailable: 'Unavailable' }

const SETUP_PHASE = {
  checking: 'Checking the desktop environment', 'preparing-runtime': 'Preparing the Podman machine', 'preparing-image': 'Preparing the desktop image',
  'verifying-image': 'Verifying the desktop image', configuring: 'Saving desktop settings',
  'starting-desktop': 'Starting the private desktop', 'checking-desktop': 'Waiting for a desktop screenshot',
  cancelling: 'Cancelling preparation', cancelled: 'Preparation cancelled', failed: 'Preparation failed',
  interrupted: 'Preparation interrupted', ready: 'Desktop ready',
}

export function ComputerSetup({ bot, actions, leaving } = {}) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showDesktop, setShowDesktop] = useState(false)
  const [engineKind, setEngineKind] = useState(null)
  const session = useRef({ mounted: false, pending: false })
  const ready = Boolean(state?.enabled && state?.job?.phase === 'ready' && !state?.busy)
  async function request(method, args = {}) {
    if (!actions || leaving || session.current.pending) return
    session.current.pending = true
    if (method !== 'setup-state') setBusy(true)
    try {
      const value = await actions.computerCall(method, { botId: bot.id, ...(engineKind ? { engineKind } : {}), ...args })
      if (session.current.mounted) { setState(value); setError('') }
    } catch (reason) { if (session.current.mounted) setError(reason.message) }
    finally { session.current.pending = false; if (session.current.mounted) setBusy(false) }
  }
  useEffect(() => {
    session.current.mounted = true
    const poll = () => {
      if (!leaving && !showDesktop && !ready && document.visibilityState !== 'hidden') void request('setup-state')
    }
    poll()
    const timer = setInterval(poll, 2000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      session.current.mounted = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [bot?.id, leaving, ready, showDesktop, engineKind])
  if (showDesktop || ready) return h(ComputerView, { bot, actions, leaving })
  const job = state?.job
  const preparing = busy || state?.busy
  const blocked = state?.disabled || state?.explicit
  return h('section', { className: 'bt-computer', 'aria-label': t('Private desktop setup') },
    h('div', { className: 'bt-computer-head' }, h('strong', null, t('Private desktop')), h('span', { className: 'bt-chip' }, t('Not configured'))),
    h('p', null, t('Prepare a private Linux desktop on the machine running DSH. The first preparation downloads and builds its image.')),
    h('p', { className: 'bt-muted' }, t('Desktop access starts as observe-only. You can enable Bot actions after setup. The desktop can reach the internet; its traffic is not filtered.')),
    h('label', null, t('Container engine'), ' ', h('select', {
      value: state?.engine ?? engineKind ?? state?.environment?.engine ?? 'docker',
      disabled: preparing || blocked || Boolean(state?.engine) || leaving,
      onChange: event => { setEngineKind(event.target.value); setState(null) },
    }, h('option', { value: 'docker' }, 'Docker'), h('option', { value: 'podman' }, t('Podman (experimental)')))),
    blocked ? h('p', { className: 'bt-error' }, t(state.disabled ? 'Private desktops are disabled by the DSH profile.' : 'This profile already has an explicit desktop runtime. Use its desktop controls.')) : null,
    !state ? h('p', { role: 'status', className: 'bt-muted' }, t('Checking the desktop environment')) : null,
    state?.environment ? h('p', { className: state.environment.ready ? 'bt-muted' : 'bt-error' },
      t(state.environment.ready ? (state.environment.engine === 'podman' ? 'Podman is ready on the DSH host.' : 'Docker is ready on the DSH host.') : state.environment.error)) : null,
    state?.environment?.ready === false ? h('div', { className: 'bt-computer-help' },
      h('a', { href: state.environment.engine === 'podman' ? 'https://podman-desktop.io/docs/installation' : 'https://docs.docker.com/desktop/setup/install/', target: '_blank', rel: 'noreferrer' }, t(state.environment.engine === 'podman' ? 'Podman installation guide' : 'Docker installation guide')),
      h('p', null, t(state.environment.engine === 'podman' ? 'Install Podman, then prepare its machine. If Windows requests a restart, reopen DSH and retry. The desktop engine runs on the DSH host.' : 'Install and start Docker with Linux containers, then check again. If Windows requests a restart, reopen DSH afterward.'))) : null,
    job ? h('p', { role: 'status', 'aria-live': 'polite' }, t(SETUP_PHASE[job.phase] ?? 'Checking the desktop environment')) : null,
    job?.error ? h('p', { className: 'bt-error' }, t(job.error)) : null,
    error ? h('p', { className: 'bt-error', role: 'alert' }, t(error)) : null,
    h('div', { className: 'bt-computer-actions' },
      state?.canPrepareRuntime && state.environment?.ready === false && !blocked ? h('button', { type: 'button', className: 'bt-soft', disabled: preparing || leaving,
        onClick: () => request('setup-prepare', { prepareRuntime: true, engineKind: 'podman' }) }, t('Prepare Podman machine and desktop')) : null,
      h('button', { type: 'button', className: 'bt-soft', disabled: preparing || blocked || !state || leaving,
        onClick: () => request(job ? 'setup-retry' : 'setup-prepare', job ? { jobId: job.id } : {}) }, t(job ? 'Retry preparation' : 'Prepare and start')),
      h('button', { type: 'button', className: 'bt-soft', disabled: preparing || leaving, onClick: () => request('setup-state', { check: true }) }, t('Check again')),
      state?.busy && job ? h('button', { type: 'button', className: 'bt-soft', disabled: busy || job.phase === 'cancelling' || leaving,
        onClick: () => request('setup-cancel', { jobId: job.id }) }, t('Cancel preparation')) : null,
      state?.enabled && !preparing ? h('button', { type: 'button', className: 'bt-soft', onClick: () => setShowDesktop(true) }, t('Open desktop controls')) : null),
    job?.log ? h('details', { className: 'bt-computer-help' }, h('summary', null, t('Preparation log')),
      h('pre', { className: 'bt-computer-log' }, job.log)) : null,
    h('p', { className: 'bt-muted' }, t('You can close this panel during preparation. Reopen it to see progress.')))
}

export function ComputerView({ bot, actions, leaving }) {
  const [state, setState] = useState(null)
  const [frame, setFrame] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [owned, setOwned] = useState(false)
  const [controlMode, setControlMode] = useState('live')
  const [text, setText] = useState('')
  const [key, setKey] = useState('Enter')
  const [files, setFiles] = useState([])
  const [streamFailed, setStreamFailed] = useState(false)
  const [streamProblem, setStreamProblem] = useState(null)
  const [tick, setTick] = useState(0)
  const [diagnostics, setDiagnostics] = useState(null)
  const [targetImage, setTargetImage] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const session = useRef({ token: null, record: null, pending: false, mounted: true, shown: null, streamReady: false })
  const panel = useRef(null)
  // An open menu is a native control. Repainting or disabling it drops the choice.
  const editing = () => {
    const node = document.activeElement
    return Boolean(node && panel.current?.contains(node) && /^(SELECT|INPUT|TEXTAREA)$/.test(node.tagName ?? ''))
  }
  const record = state?.computers.find(item => item.botId === bot.id && !item.archived)
  const upgradeImages = (state?.images ?? []).slice((state?.images ?? []).indexOf(record?.runtimeImage) + 1)
  const requests = (state?.handoffs ?? []).filter(item => item.botId === bot.id)
  const ready = record?.phase === 'ready' && record.grant !== 'off'
  const liveControl = owned && controlMode === 'live'
  const inputReady = owned && ready && !busy && !leaving && document.visibilityState !== 'hidden'
    && (liveControl ? session.current.streamReady && Boolean(session.current.liveInput)
      : !previewBusy && freshFrame(frame) && session.current.shown === frame?.data)
  const call = (method, args = {}) => actions.computerCall(method, {
    botId: bot.id, expectedGeneration: session.current.record?.generation,
    ...(session.current.token ? { controlToken: session.current.token } : {}), ...args,
  })
  const clearFrame = () => { session.current.shown = null; setFrame(null) }
  const forget = () => { session.current.token = null; setOwned(false); setFiles([]) }
  const failure = reason => {
    if (!session.current.mounted) return
    if (reason.code === 'bot/computer-busy') {
      setError('')
      setPreviewBusy(true)
      return
    }
    setError(reason.message)
    clearFrame()
    if (['bot/computer-stale-control', 'bot/computer-stale-generation'].includes(reason.code)) forget()
  }
  async function refresh() {
    const value = await call('state')
    if (!session.current.mounted || editing()) return
    const next = value.computers.find(item => item.botId === bot.id && !item.archived)
    const changed = next?.id !== session.current.record?.id || next?.generation !== session.current.record?.generation
    if (changed || next?.control !== 'human' || next?.humanExpired) forget()
    if (changed) { clearFrame(); setConfirmation(null); setDiagnostics(null) }
    session.current.record = next
    setState(value)
    if (next?.phase !== 'ready' || next.grant === 'off') { clearFrame(); return }
    if (session.current.streamReady) return
    const shot = await call('preview')
    if (session.current.mounted && document.visibilityState !== 'hidden' && !editing()) {
      setFrame({ ...shot, receivedAt: Date.now() })
      setPreviewBusy(false)
    }
  }
  async function run(work, reload = true) {
    if (session.current.pending || leaving) return
    session.current.pending = true
    setBusy(true)
    setError('')
    try {
      await work()
      if (reload && session.current.mounted) await refresh()
    } catch (reason) { failure(reason) }
    finally {
      session.current.pending = false
      if (session.current.mounted) setBusy(false)
    }
  }
  useEffect(() => {
    session.current.mounted = true
    const poll = () => {
      if (editing()) return
      setTick(value => value + 1)
      if (leaving || document.visibilityState === 'hidden' || session.current.pending) return
      session.current.pending = true
      void refresh().catch(failure).finally(() => { session.current.pending = false })
    }
    poll()
    const timer = setInterval(poll, 1500)
    const hide = () => { if (document.visibilityState === 'hidden') { clearFrame() } else poll() }
    document.addEventListener('visibilitychange', hide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', hide)
      session.current.mounted = false
      // Closing a viewer never silently hands control back to an automatic agent.
    }
  }, [bot.id, leaving])
  const manage = method => run(async () => {
    const result = await call(method)
    session.current.token = result.controlToken ?? null
    setOwned(Boolean(result.controlToken))
    session.current.streamReady = false
    setStreamFailed(false); setStreamProblem(null)
    clearFrame()
    setNotice('')
    setFiles([])
  })
  const bind = (grant, approvalMode = record?.approvalMode ?? 'required') => run(async () => {
    await call('bind', { grant, approvalMode, expectedRevision: state.revision })
    forget()
    session.current.streamReady = false
    setStreamFailed(false); setStreamProblem(null)
    setNotice('')
  })
  const input = action => {
    if (!inputReady) return
    if (liveControl) {
      if (action.type === 'text') session.current.liveInput?.text(action.text)
      else if (action.type === 'key') session.current.liveInput?.key(action.key)
      return
    }
    void run(async () => {
      const receipt = await call('input', { actions: [action], frameId: frame.frameId, requestId: crypto.randomUUID() })
      clearFrame()
      setNotice(receipt.outcome === 'unknown'
        ? t('Input was sent, but its effect is unconfirmed. Review the desktop before doing it again.')
        : receipt.outcome === 'rejected' ? t('Input was refused. Review the desktop.') : t('Input sent. Review the desktop.'))
  })
}
  const pointer = (event, type) => {
    if (!inputReady || liveControl) return
    event.preventDefault()
    const point = imagePoint(frame, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
    if (point) input({ type, ...point, ...(type === 'click' ? { button: event.type === 'contextmenu' ? 'right' : 'left' } : { deltaY: event.deltaY > 0 ? 3 : -3 }) })
  }
  const loadFiles = async () => setFiles((await call('files', { operation: 'list' })).files)
  const upload = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void run(async () => {
      if (file.size > 262144) throw new Error(t('Files must be at most 256 KiB.'))
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      await call('files', { operation: 'write', name: file.name, data: btoa(binary) })
      await loadFiles()
      setNotice(t('File imported. Existing files are never overwritten.'))
    })
  }
  const download = name => run(async () => {
    const value = await call('files', { operation: 'read', name })
    const bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = value.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  })
  const removeCopy = (method, args, label) => setConfirmation({ method, args: { ...args, botId: bot.id, expectedGeneration: record.generation }, label })
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || disabled || leaving, onClick }, t(label))
  return h('div', { ref: panel, className: 'bt-computer', 'data-tick': tick },
    h('div', { className: 'bt-computer-head' }, h('strong', null, t('Private desktop')), h('span', { className: 'bt-chip' }, t(PHASE[record?.phase] ?? 'Not assigned'))),
    h('p', { className: 'bt-muted' }, t('Linux container with open internet access. Other Bot tools still run with their existing permissions.')),
    h('label', { className: 'bt-computer-row' }, t('Bot access'),
      h('select', { value: record?.grant ?? 'off', disabled: busy || !state || leaving, onChange: event => { void bind(event.target.value) } },
        h('option', { value: 'off' }, t('Off — keep files')),
        h('option', { value: 'observe' }, t('Observe only')),
        h('option', { value: 'operate' }, t('Observe and operate')))),
    h('label', { className: 'bt-computer-row' }, t('CUA approval mode'),
      h('select', { 'aria-label': t('CUA approval mode'), value: record?.approvalMode ?? 'required', disabled: busy || record?.grant !== 'operate' || leaving,
        onChange: event => { void bind(record.grant, event.target.value) } },
      h('option', { value: 'required' }, t('Ask before each action')),
      h('option', { value: 'yolo' }, t('YOLO — no approval')))),
    record?.grant === 'operate' && record.approvalMode === 'yolo'
      ? h('p', { className: 'bt-muted', role: 'status' }, t('YOLO is on for this desktop. Bot actions run without confirmation. Take control or stop the desktop to pause them.')) : null,
    h('div', { className: 'bt-computer-row' },
      button('Start desktop', () => manage('start'), !record || record.grant === 'off' || ready || record.control === 'human' || record.recoveryPending),
      button('Stop desktop', () => manage('stop'), !record || record.phase === 'stopped'),
      button('Refresh', () => run(refresh, false)),
      streamFailed ? button('Retry live stream', () => { setStreamFailed(false); setStreamProblem(null) }, !ready) : null),
    h('div', { className: 'bt-computer-row' },
      button(owned ? 'Renew control' : 'Take control', () => manage('takeover'), !ready),
      button('Give back to Bot', () => manage('release'), !owned),
      owned ? button(liveControl ? 'Use snapshot control' : 'Use live control', () => {
        session.current.streamReady = false
        session.current.liveInput = null
        setControlMode(liveControl ? 'snapshot' : 'live')
        setStreamFailed(false); setStreamProblem(null)
        clearFrame()
      }) : null),
    h('p', { className: 'bt-muted', role: 'status' }, owned
      ? t('You control this desktop. Closing the panel keeps the Bot paused.')
      : record?.control === 'human' || record?.control === 'blocked'
        ? t('Bot paused. Take control here, or stop the desktop to recover.') : t('Read-only preview. Take control to send input or transfer files.')),
    requests.map(item => h('section', { key: item.id, className: 'bt-computer-help', 'aria-label': t('Desktop help requested') },
      h('strong', null, t('Desktop help requested')),
      h('p', null, item.note),
      item.status !== 'pending' ? h('p', { className: 'bt-muted' }, t('Answer saved. Retry checks delivery before continuing.')) : null,
      h('div', { className: 'bt-computer-row' },
        button(item.status === 'pending' ? "I'm done" : 'Retry answer', () => run(async () => {
          await call('handoff-answer', { requestId: item.id, outcome: item.outcome ?? 'done' })
          forget()
        }), item.status === 'pending' && !owned),
        item.status === 'pending' ? button('Skip', () => run(async () => {
          await call('handoff-answer', { requestId: item.id, outcome: 'skip' })
          forget()
        })) : null))),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    previewBusy ? h('div', { className: 'bt-muted', role: 'status' }, t('The desktop is busy. Keeping the last preview until it is available again.')) : null,
    notice ? h('div', { className: 'bt-muted', role: 'status' }, notice) : null,
    h('div', { className: 'bt-computer-screen', 'data-control': inputReady || undefined },
      h(ComputerScreen, {
        live: Boolean(ready && (!owned || liveControl) && !streamFailed && !leaving), botId: bot.id, generation: record?.generation,
        controlToken: liveControl ? session.current.token : undefined,
        onControls: controls => { session.current.liveInput = controls },
        frame, onPointer: pointer,
        onPresented: data => { session.current.shown = data; if (!editing()) setTick(value => value + 1) },
        onReady: () => { session.current.streamReady = true; setPreviewBusy(false); setStreamProblem(null); setTick(value => value + 1) },
        onLost: () => { session.current.streamReady = false; if (session.current.mounted) setTick(value => value + 1) },
        onFallback: detail => { session.current.streamReady = false; setStreamFailed(true); setStreamProblem(detail) },
      })),
    streamFailed && streamProblem ? h('p', { className: 'bt-error', role: 'status' }, t(streamProblem.message)) : null,
    h('p', { className: 'bt-muted' }, t(owned
      ? liveControl ? 'Live control: click the desktop to type or drag. Losing window focus pauses input.'
        : 'Control uses verified snapshots. The last image stays visible while the next one loads.'
      : streamFailed ? 'Live desktop streaming is unavailable. Showing PNG snapshots instead.' : 'Live desktop stream (read-only).')),
    h('div', { className: 'bt-computer-row' },
      h('select', { 'aria-label': t('Desktop key'), value: key, onChange: event => setKey(event.target.value) }, KEYS.map(value => h('option', { key: value, value }, value))),
      button('Send key', () => input({ type: 'key', key }), !inputReady)),
    h('form', { className: 'bt-computer-row', onSubmit: event => { event.preventDefault(); input({ type: 'text', text }) } },
      h('input', { value: text, maxLength: 4000, 'aria-label': t('Text to type'), placeholder: t('Text to type'), onChange: event => setText(event.target.value), autoComplete: 'off' }),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: !inputReady || !text }, t('Type text'))),
    state?.storageAvailable ? h('section', { className: 'bt-computer-help', 'aria-label': t('Desktop recovery') },
      h('strong', null, t('Desktop recovery')),
      record?.recoveryPending ? h('div', { className: 'bt-computer-row', role: 'status' },
        h('span', null, t('A storage change was interrupted. Finish recovery before continuing.')),
        button('Finish recovery', () => run(() => call('recover')))) : null,
      h('p', { className: 'bt-muted' }, t('Stop the desktop first. Recreate saves a checkpoint; restore keeps the previous home. Start the desktop when ready.')),
      h('div', { className: 'bt-computer-row' },
        button('Save checkpoint', () => run(() => call('checkpoint')), record?.phase !== 'stopped'),
        button('Recreate container', () => run(() => call('recreate')), record?.phase !== 'stopped'),
        button('Clear operation history', () => removeCopy('prune-journal', {}, t('Desktop operation history')), record?.phase !== 'stopped')),
      h('div', { className: 'bt-computer-row' }, button('Check storage', () => run(async () => setDiagnostics(await call('diagnostics'))), !record || record.recoveryPending)),
      diagnostics?.storage ? h('div', { className: 'bt-computer-help', role: 'status' },
        h('span', null, `${t('Home size')}: ${(diagnostics.storage.bytes / 1048576).toFixed(1)} MiB · ${t('Disk available')}: ${(diagnostics.storage.freeBytes / 1073741824).toFixed(1)} GiB`),
        h('p', { className: 'bt-muted' }, t('Storage is measured in the desktop runtime. A hard disk quota is not enforced.')),
        diagnostics.storage.freeBytes < diagnostics.storage.reserveBytes ? h('p', { className: 'bt-error' }, t('Storage is low. Free space before copying or upgrading.')) : null) : null,
      upgradeImages.length > 0 ? h('div', { className: 'bt-computer-help' },
        h('label', { className: 'bt-computer-row' }, t('Desktop image'),
          h('select', { 'aria-label': t('Desktop image'), value: targetImage, disabled: busy, onChange: event => setTargetImage(event.target.value) },
            h('option', { value: '' }, t('Choose an image')),
            upgradeImages.map(image => h('option', { key: image, value: image }, image.slice(0, 23))))),
        h('p', { className: 'bt-muted' }, t('Upgrade checks a fresh desktop, copies your saved home and keeps the previous image and home together for rollback.')),
        button('Upgrade desktop', () => run(() => call('upgrade', { targetImage })), record?.phase !== 'stopped' || !targetImage || record.recoveryPending)) : null,
      busy ? h('p', { className: 'bt-muted', role: 'status' }, t('Working. Keep this panel open until the operation finishes.')) : null,
      (state.checkpoints ?? []).filter(item => item.computerId === record?.id).map(item => h('div', { key: item.id, className: 'bt-computer-row' },
        h('span', null, new Date(item.at).toLocaleString()),
        button('Restore checkpoint', () => run(() => call('restore', { checkpointId: item.id })), record?.phase !== 'stopped' || (item.image && item.image !== record?.runtimeImage)),
        button('Delete checkpoint', () => removeCopy('delete-checkpoint', { checkpointId: item.id }, new Date(item.at).toLocaleString()), record?.phase !== 'stopped'))),
      (record?.previousHomes ?? []).map((homeRevision, index) => h('div', { key: homeRevision ?? 'original', className: 'bt-computer-row' },
        h('span', null, `${t('Previous home')} ${index + 1}${record.previousImages?.[homeRevision ?? 'original'] ? ` · ${record.previousImages[homeRevision ?? 'original'].slice(0, 19)}` : ''}`),
        button('Switch to this home', () => run(() => call('rollback', { homeRevision })), record.phase !== 'stopped'),
        button('Delete previous home', () => removeCopy('delete-home', { homeRevision }, `${t('Previous home')} ${index + 1}${record.previousImages?.[homeRevision ?? 'original'] ? ` · ${record.previousImages[homeRevision ?? 'original'].slice(0, 19)}` : ''}`), record.phase !== 'stopped'))),
      confirmation ? h('div', { className: 'bt-computer-help', role: 'group', 'aria-label': t('Confirm deletion') },
        h('strong', null, confirmation.label),
        h('p', null, t('Permanently delete this saved data? The current home is kept.')),
        h('div', { className: 'bt-computer-row' },
          button('Delete', () => run(async () => { await call(confirmation.method, confirmation.args); setConfirmation(null) })),
          button('Cancel', () => setConfirmation(null)))) : null) : null,
    h('strong', null, t('Transfer files')),
    h('p', { className: 'bt-muted' }, t('Use /home/cua/DSBot inside the desktop. Files up to 256 KiB; folders and overwrites are not supported.')),
    h('div', { className: 'bt-computer-row' },
      h('label', null, t('Import file'), h('input', { type: 'file', 'aria-label': t('Import file'), disabled: busy || !owned || !ready, onChange: upload })),
      button('List files', () => run(loadFiles), !owned || !ready)),
    files.map(file => h('div', { key: file.name, className: 'bt-computer-row' },
      h('span', { className: 'bt-computer-name' }, file.name), h('span', { className: 'bt-muted' }, `${file.bytes} B`),
      button('Download', () => download(file.name), !owned || !ready || file.bytes > 262144))))
}

export const COMPUTER_CSS = `
.bt-computer{display:flex;flex-direction:column;gap:12px;overflow:auto;padding:16px;min-height:0;font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-computer p{margin:0}
.bt-computer-help{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--bt-line);border-radius:12px;overflow-wrap:anywhere}
.bt-computer-head,.bt-computer-row,.bt-computer-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-computer-log{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
.bt-computer-head{justify-content:space-between}
.bt-computer select,.bt-computer input:not([type=file]){min-height:32px;min-width:0;max-width:100%;border:1px solid var(--bt-line);border-radius:8px;padding:6px 8px;background:var(--bt-card);color:var(--bt-ink);font:inherit}
.bt-computer input:not([type=file]){flex:1}
.bt-computer input[type=file]{display:block;max-width:240px;font:inherit;margin-top:4px}
.bt-computer-screen{position:relative;flex:none;border:1px solid var(--bt-line);border-radius:12px;overflow:hidden;background:var(--bt-card);min-height:120px;aspect-ratio:16 / 10;display:flex;align-items:center;justify-content:center}
.bt-computer-screen[data-control] canvas{cursor:crosshair}
.bt-computer-display{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.bt-computer-decoder{position:absolute;inset:0;visibility:hidden;pointer-events:none;z-index:1}
.bt-computer-decoder[data-live]{visibility:visible}
.bt-computer-decoder[data-live][data-interactive]{pointer-events:auto}
.bt-computer-stream-status{z-index:2}
.bt-computer-canvas{display:block;max-width:100%;max-height:100%;width:auto;height:auto;user-select:none}
.bt-computer-canvas[hidden]{display:none}
.bt-computer-stream-status{position:absolute;right:8px;bottom:8px;padding:3px 7px;border-radius:6px;background:var(--bt-card);color:var(--bt-ink);font-size:11px}
.bt-computer-screen p{padding:16px}
.bt-computer-name{flex:1;min-width:0;overflow-wrap:anywhere}
.bt-computer button:disabled{opacity:.45;cursor:default}
.bt-computer :focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`
