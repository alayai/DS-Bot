import { createElement as h, useEffect, useRef, useState } from 'react'
import { imagePoint, freshFrame } from './computer-model.js'
import { t } from './i18n.js'
import { importDesktopFile, exportDesktopFile } from './computer-files.js'
import { FILE_LIMIT } from '../shared/computer-files.js'

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
  const [fileStorage, setFileStorage] = useState(null)
  const [fileDeletion, setFileDeletion] = useState(null)
  const [transfer, setTransfer] = useState(null)
  const transferring = useRef(null)
  const [streamFailed, setStreamFailed] = useState(false)
  const [streamProblem, setStreamProblem] = useState(null)
  const [tick, setTick] = useState(0)
  const [diagnostics, setDiagnostics] = useState(null)
  const [targetImage, setTargetImage] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const [serviceConfirmation, setServiceConfirmation] = useState(null)
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
  const serviceBlocked = Boolean(['running', 'failed'].includes(state?.recovery?.status) || state?.recovery?.disconnected)
  const ready = record?.phase === 'ready' && record.grant !== 'off' && !serviceBlocked
  const liveControl = owned && controlMode === 'live'
  const inputReady = owned && ready && !busy && !leaving && document.visibilityState !== 'hidden'
    && (liveControl ? session.current.streamReady && Boolean(session.current.liveInput)
      : !previewBusy && freshFrame(frame) && session.current.shown === frame?.data)
  const call = (method, args = {}) => actions.computerCall(method, {
    botId: bot.id, expectedGeneration: session.current.record?.generation,
    ...(session.current.token ? { controlToken: session.current.token } : {}), ...args,
  })
  const clearFrame = () => { session.current.shown = null; setFrame(null) }
  const clearFiles = () => { setFiles([]); setFileStorage(null); setFileDeletion(null) }
  const forget = () => { session.current.token = null; setOwned(false); clearFiles() }
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
    const recovering = ['running', 'failed'].includes(value.recovery?.status) || value.recovery?.disconnected
    if (changed || next?.control !== 'human' || next?.humanExpired || recovering) forget()
    if (changed || value.recovery?.version !== session.current.recoveryVersion) setServiceConfirmation(null)
    session.current.recoveryVersion = value.recovery?.version
    if (changed) { clearFrame(); setConfirmation(null); setDiagnostics(null) }
    session.current.record = next
    setState(value)
    if (next?.phase !== 'ready' || next.grant === 'off' || recovering) { clearFrame(); return }
    if (session.current.streamReady) return
    const shot = await call('preview')
    if (session.current.mounted && document.visibilityState !== 'hidden' && !editing()) {
      setFrame({ ...shot, receivedAt: Date.now() })
      setPreviewBusy(false)
    }
  }
  async function run(work, reload = true) {
    // A background preview can outlive the enabled button the user clicked.
    // Wait for that read; never silently discard the user's file selection.
    if (session.current.polling) await session.current.polling
    if (session.current.pending || leaving || !session.current.mounted) return
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
      session.current.polling = refresh().catch(failure).finally(() => {
        session.current.pending = false
        session.current.polling = null
      })
    }
    poll()
    const timer = setInterval(poll, 1500)
    const hide = () => { if (document.visibilityState === 'hidden') { clearFrame() } else poll() }
    document.addEventListener('visibilitychange', hide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', hide)
      session.current.mounted = false
      if (transferring.current) transferring.current.cancelled = true
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
    clearFiles()
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
  const loadFiles = async () => {
    const result = await call('files', { operation: 'list' })
    setFiles(result.files)
    setFileStorage(result.storage ?? null)
    setFileDeletion(null)
  }
  const askDeleteFile = file => setFileDeletion({
    botId: bot.id, expectedGeneration: record.generation, controlToken: session.current.token,
    operation: 'delete', name: file.name, version: file.version,
  })
  const deleteFile = () => run(async () => {
    const request = fileDeletion
    // Consume confirmation before dispatch: a lost reply must not replay deletion.
    clearFiles()
    setNotice('')
    try {
      const result = await actions.computerCall('files', request)
      if (result?.deleted !== true || result.name !== request.name) throw new Error('Invalid deletion receipt.')
    } catch {
      throw new Error(t('Deletion could not be confirmed. Refresh the file list before trying again.'))
    }
    setNotice(t('File deleted.'))
    await loadFiles()
  })
  const transferFile = work => run(async () => {
    const identity = { botId: bot.id, expectedGeneration: session.current.record?.generation, controlToken: session.current.token }
    const task = { cancelled: false }
    transferring.current = task
    setNotice('')
    setTransfer({ bytes: 0, total: 0, phase: 'Preparing file…' })
    const request = args => actions.computerCall('files', { ...identity, ...args })
    const check = () => {
      if (task.cancelled || !session.current.mounted || session.current.token !== identity.controlToken
        || session.current.record?.generation !== identity.expectedGeneration) throw new Error('Transfer stopped. Check the destination before retrying.')
    }
    const progress = (bytes, total) => {
      check()
      setTransfer({ bytes, total, phase: bytes === total ? 'Verifying file…' : 'Transferring file…' })
    }
    try { await work(request, { check, progress }); check() }
    finally {
      transferring.current = null
      if (session.current.mounted) setTransfer(null)
    }
  })
  const upload = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void transferFile(async (request, options) => {
      await importDesktopFile(request, file, options)
      await loadFiles()
      setNotice(t('File imported. Existing files are never overwritten.'))
    })
  }
  const download = name => transferFile(async (request, options) => {
    const blob = await exportDesktopFile(request, name, options)
    options.check()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  })
  const removeCopy = (method, args, label) => setConfirmation({ method, args: { ...args, botId: bot.id, expectedGeneration: record.generation }, label })
  const recoverService = () => run(async () => {
    const args = serviceConfirmation
    setServiceConfirmation(null)
    forget()
    clearFrame()
    session.current.streamReady = false
    setStreamFailed(false); setStreamProblem(null)
    await actions.computerCall('reconnect', args)
  })
  const button = (label, onClick, disabled = false, recoveryAction = false) => h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || disabled || leaving || (serviceBlocked && !recoveryAction), onClick }, t(label))
  return h('div', { ref: panel, className: 'bt-computer', 'data-tick': tick },
    h('div', { className: 'bt-computer-head' }, h('strong', null, t('Private desktop')), h('span', { className: 'bt-chip' }, t(PHASE[record?.phase] ?? 'Not assigned'))),
    h('p', { className: 'bt-muted' }, t('Linux container with open internet access. Other Bot tools still run with their existing permissions.')),
    h('label', { className: 'bt-computer-row' }, t('Bot access'),
      h('select', { value: record?.grant ?? 'off', disabled: busy || !state || leaving || serviceBlocked, onChange: event => { void bind(event.target.value) } },
        h('option', { value: 'off' }, t('Off — keep files')),
        h('option', { value: 'observe' }, t('Observe only')),
        h('option', { value: 'operate' }, t('Observe and operate')))),
    h('label', { className: 'bt-computer-row' }, t('CUA approval mode'),
      h('select', { 'aria-label': t('CUA approval mode'), value: record?.approvalMode ?? 'required', disabled: busy || record?.grant !== 'operate' || leaving || serviceBlocked,
        onChange: event => { void bind(record.grant, event.target.value) } },
      h('option', { value: 'required' }, t('Ask before each action')),
      h('option', { value: 'yolo' }, t('YOLO — no approval')))),
    record?.grant === 'operate' && record.approvalMode === 'yolo'
      ? h('p', { className: 'bt-muted', role: 'status' }, t('YOLO is on for this desktop. Bot actions run without confirmation. Take control or stop the desktop to pause them.')) : null,
    h('div', { className: 'bt-computer-row' },
      button('Start desktop', () => manage('start'), !record || record.grant === 'off' || ready || record.control === 'human' || record.recoveryPending),
      button('Stop desktop', () => manage('stop'), !record || record.phase === 'stopped'),
      button('Refresh', () => run(refresh, false), false, true),
      streamFailed ? button('Retry live stream', () => { setStreamFailed(false); setStreamProblem(null) }, !ready) : null),
    state?.recovery?.supported ? h('section', { className: 'bt-computer-help', 'aria-label': t('Desktop service recovery') },
      state.recovery.status === 'running' ? h('p', { role: 'status' },
        t({ settling: 'Waiting for desktop operations to stop…', reconnecting: 'Reconnecting desktop service…', checking: 'Checking and stopping desktops…' }[state.recovery.stage]),
        ` ${state.recovery.completed} / ${state.recovery.total}`) : null,
      state.recovery.status === 'completed' && !state.recovery.disconnected ? h('p', { role: 'status' }, t('Desktop service recovered. Start each desktop when ready.')) : null,
      state.recovery.status === 'failed' ? h('p', { role: 'alert' }, t(state.recovery.problem === 'interrupted-management'
        ? 'A desktop startup or storage operation was interrupted. Restart DSH and check desktop recovery before continuing.'
        : state.recovery.problem === 'runtime-changed'
        ? 'The desktop engine connection changed. Restore the previous connection before retrying.'
        : state.recovery.problem === 'unsettled'
        ? 'Recovery could not finish stopping previous work. Wait, then retry.'
        : 'Recovery failed. Check that the container engine is running, then retry. Desktops remain blocked.')) : null,
      serviceConfirmation ? h('div', { role: 'group', 'aria-label': t('Confirm service recovery') },
        h('p', null, t('Stop all Bot desktops and recover their shared service? Saved files and checkpoints are kept. Start desktops manually afterward; unconfirmed actions will not be repeated.')),
        h('div', { className: 'bt-computer-row' },
          button('Recover service and stop desktops', recoverService, state.recovery.status === 'running', true),
          button('Cancel', () => setServiceConfirmation(null), false, true)))
        : button('Recover desktop service', () => setServiceConfirmation({
          botId: bot.id, expectedGeneration: record.generation, expectedRecovery: state.recovery.version,
        }), !record || state.recovery.status === 'running', true)) : state?.recovery?.disconnected
      ? h('p', { className: 'bt-muted' }, t('Restart DSH to recover this desktop bridge.')) : null,
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
    error ? h('div', { className: 'bt-error', role: 'alert' }, t(error)) : null,
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
    h('p', { className: 'bt-muted' }, t('Use /home/cua/DSBot inside the desktop. Files up to 200 MiB; folders and overwrites are not supported.')),
    transfer ? h('div', { className: 'bt-computer-row' },
      h('span', { role: 'status', 'aria-live': 'polite' }, t(transfer.phase), ` ${transfer.bytes} / ${transfer.total} B`),
      h('progress', { value: transfer.bytes, max: transfer.total || 1, 'aria-label': t('File transfer progress') }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: transfer.phase === 'Cancelling transfer…',
        onClick: () => { if (transferring.current) transferring.current.cancelled = true; setTransfer(value => ({ ...value, phase: 'Cancelling transfer…' })) } }, t('Cancel transfer'))) : null,
    h('div', { className: 'bt-computer-row' },
      h('label', null, t('Import file'), h('input', { type: 'file', 'aria-label': t('Import file'), disabled: busy || !owned || !ready, onChange: upload })),
      button('List files', () => run(loadFiles), !owned || !ready)),
    fileStorage ? h('p', { className: 'bt-muted', role: 'status' },
      `${t('Listed files')}: ${files.length} · ${(fileStorage.bytes / 1048576).toFixed(1)} MiB · ${t('Disk available')}: ${(fileStorage.freeBytes / 1073741824).toFixed(1)} GiB`) : null,
    fileDeletion ? h('div', { className: 'bt-computer-help', role: 'group', 'aria-label': t('Confirm file deletion') },
      h('strong', null, fileDeletion.name),
      h('p', null, t('Permanently delete this file from the desktop? This cannot be undone.')),
      h('div', { className: 'bt-computer-row' },
        button('Delete file permanently', deleteFile, !owned || !ready),
        button('Cancel', () => setFileDeletion(null)))) : null,
    files.map(file => h('div', { key: file.name, className: 'bt-computer-row' },
      h('span', { className: 'bt-computer-name' }, file.name), h('span', { className: 'bt-muted' }, `${file.bytes} B`),
      button('Download', () => download(file.name), !owned || !ready || file.bytes > FILE_LIMIT),
      button('Delete file', () => askDeleteFile(file), !owned || !ready || !file.version))))
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
