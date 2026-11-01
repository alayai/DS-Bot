import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/computer-pane.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react'],
  plugins: [{
    name: 'test-translations',
    setup(builder) {
      builder.onResolve({ filter: /\/i18n\.js$/ }, () => ({ path: 'translations', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const t = value => value' }))
    },
  }],
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const find = (node, predicate) => {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return predicate(node) ? node : find(node.props.children, predicate)
}

function viewer({ setup = false } = {}) {
  const slots = []
  const timers = new Set()
  const listeners = new Set()
  const calls = []
  const document = {
    visibilityState: 'visible',
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  }
  let index = 0, effects = [], control = 'none', frameId = 0, data = 'same-png', previewWait, previewError, now = 100
  let approvalMode = 'required', generation = 1, handoffs = [], storageAvailable = false, phase = 'ready', checkpoints = [], images = [], runtimeImage
  let setupState = { enabled: false, busy: false, environment: { ready: true }, job: null }
  let fileList = [{ name: 'report.bin', bytes: 123, version: 'a'.repeat(64) }], deleteError
  let recovery
  const slot = make => slots[index++] ??= make()
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: initial => slot(() => ({ current: initial })),
    useState: initial => {
      const cell = slot(() => ({ value: initial }))
      return [cell.value, value => { cell.value = typeof value === 'function' ? value(cell.value) : value }]
    },
    useEffect: (make, deps) => {
      const cell = slot(() => ({}))
      if (!cell.deps || deps.some((value, i) => value !== cell.deps[i])) {
        effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
      }
    },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: () => react, document,
    Date: class extends Date { static now() { return now } }, crypto: { randomUUID: () => 'request' },
    setInterval: fn => { timers.add(fn); return fn },
    clearInterval: fn => timers.delete(fn),
  })
  const actions = {
    async computerCall(method, args) {
      calls.push({ method, args })
      if (method === 'setup-state') return setupState
      if (method === 'setup-prepare' || method === 'setup-retry') {
        setupState = { ...setupState, busy: true, job: { id: 'job', botId: 'bot', phase: 'preparing-image' } }
        return setupState
      }
      if (method === 'setup-cancel') return { ...setupState, job: { ...setupState.job, phase: 'cancelling' } }
      if (method === 'state') return { revision: generation, handoffs, storageAvailable, checkpoints, images, recovery, computers: [{ id: 'computer', botId: 'bot', generation, grant: 'operate', approvalMode, phase, control, runtimeImage }] }
      if (method === 'reconnect') { recovery = { ...recovery, version: 'next', status: 'running', stage: 'checking', completed: 0, total: 2 }; return {} }
      if (method === 'bind') { approvalMode = args.approvalMode; generation++; control = 'none'; return {} }
      if (method === 'takeover') { control = 'human'; return { controlToken: 'synthetic-ticket' } }
      if (method === 'preview') {
        await previewWait
        if (previewError) throw previewError
        return { frameId: `frame-${++frameId}`, data, width: 100, height: 100, validForMs: 5000 }
      }
      if (method === 'handoff-answer') { handoffs = []; control = 'none'; return { status: 'delivered' } }
      if (method === 'delete-checkpoint') { checkpoints = []; return {} }
      if (method === 'upgrade') { runtimeImage = args.targetImage; generation++; return {} }
      if (method === 'input') return { outcome: 'unknown' }
      if (method === 'files') {
        if (args.operation === 'list') return { files: fileList, storage: { bytes: 123, freeBytes: 1000 } }
        if (args.operation === 'delete') {
          if (deleteError) throw new Error('lost reply')
          fileList = []
          return { name: args.name, deleted: true }
        }
      }
      throw new Error(`Unexpected ${method}`)
    },
  }
  const render = () => {
    index = 0
    const out = (setup ? module.exports.ComputerSetup : module.exports.ComputerView)({ bot: { id: 'bot' }, actions })
    for (const effect of effects.splice(0)) effect()
    return out
  }
  const button = label => find(render(), node => node.type === 'button' && node.props.children[0] === label)
  const image = () => {
    const screen = find(render(), node => typeof node.type === 'function' && node.type.name === 'ComputerScreen')
    if (!screen?.props.frame) return undefined
    return { props: { ...screen.props, onLoad: () => screen.props.onPresented(screen.props.frame.data), onError: () => screen.props.onPresented(null), onClick: event => screen.props.onPointer(event, 'click') } }
  }
  return {
    calls, timers, listeners, render, button, image,
    setupState: value => { setupState = { ...setupState, ...value } },
    images: (values, active) => { images = values; runtimeImage = active },
    rebind: () => { generation++ },
    failDelete: () => { deleteError = true },
    recovery: value => {
      recovery = value
      if (value.status === 'completed') { phase = 'stopped'; generation++; control = 'none' }
    },
    storage: () => { storageAvailable = true; phase = 'stopped'; checkpoints = [{ id: 'backup', computerId: 'computer', at: 0 }] },
    help: value => { handoffs = value },
    poll: () => { for (const fn of timers) fn() },
    hide: () => { document.visibilityState = 'hidden'; for (const fn of listeners) fn() },
    data: value => { data = value },
    wait: value => { previewWait = value },
    failPreview: code => { previewError = code ? Object.assign(new Error('Preview failed'), { code }) : null },
    advance: value => { now += value },
    unmount: () => { for (const cell of slots) cell.stop?.() },
    async own({ live = false } = {}) {
      render()
      await tick()
      button('Take control').props.onClick()
      await tick()
      if (!live) {
        button('Use snapshot control').props.onClick()
        for (const fn of timers) fn()
        await tick()
      }
      image().props.onLoad()
    },
  }
}

test('service recovery confirms its global effect and polling never repeats the background request', async () => {
  const view = viewer()
  await view.own()
  view.recovery({ supported: true, version: 'first', status: 'idle' })
  view.poll()
  await tick()
  view.button('Recover desktop service').props.onClick()
  assert.equal(view.calls.filter(item => item.method === 'reconnect').length, 0)
  view.button('Cancel').props.onClick()
  assert.equal(view.button('Recover service and stop desktops'), undefined)
  view.button('Recover desktop service').props.onClick()
  view.recovery({ supported: true, version: 'other-window', status: 'idle' })
  view.poll()
  await tick()
  assert.equal(view.button('Recover service and stop desktops'), undefined)
  view.button('Recover desktop service').props.onClick()
  view.button('Recover service and stop desktops').props.onClick()
  await tick()
  assert.equal(view.button('Recover desktop service').props.disabled, true)
  assert.equal(view.button('Take control').props.disabled, true)
  const request = view.calls.find(item => item.method === 'reconnect')
  assert.deepEqual(JSON.parse(JSON.stringify(request.args)), { botId: 'bot', expectedGeneration: 1, expectedRecovery: 'other-window' })
  view.poll()
  await tick()
  assert.equal(view.calls.filter(item => item.method === 'reconnect').length, 1)
  view.recovery({ supported: true, version: 'next', status: 'completed', completed: 2, total: 2 })
  view.poll()
  await tick()
  assert.equal(view.button('Start desktop').props.disabled, false)
  assert.equal(view.calls.filter(item => item.method === 'start').length, 0)
  view.unmount()
})

test('file deletion consumes explicit confirmation, binds its identity and never retries a lost reply', async () => {
  const view = viewer()
  await view.own()
  view.button('List files').props.onClick()
  await tick()
  view.button('Delete file').props.onClick()
  assert.equal(view.calls.filter(item => item.args.operation === 'delete').length, 0)
  view.button('Cancel').props.onClick()
  assert.equal(view.button('Delete file permanently'), undefined)
  view.button('Delete file').props.onClick()
  view.rebind()
  view.poll()
  await tick()
  assert.equal(view.button('Delete file permanently'), undefined)
  view.button('Take control').props.onClick()
  await tick()
  view.button('List files').props.onClick()
  await tick()
  view.button('Delete file').props.onClick()
  view.failDelete()
  view.button('Delete file permanently').props.onClick()
  await tick()
  const deleted = view.calls.filter(item => item.args.operation === 'delete')
  assert.equal(deleted.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(deleted[0].args)), {
    botId: 'bot', expectedGeneration: 2, controlToken: 'synthetic-ticket',
    operation: 'delete', name: 'report.bin', version: 'a'.repeat(64),
  })
  assert.equal(view.button('Delete file permanently'), undefined)
  assert.equal(view.button('Delete file'), undefined)
  view.poll()
  await tick()
  assert.equal(view.calls.filter(item => item.args.operation === 'delete').length, 1)
  view.unmount()
})

test('live takeover passes its token to the stream and never submits snapshot input', async () => {
  const view = viewer()
  await view.own({ live: true })
  const screen = () => find(view.render(), node => typeof node.type === 'function' && node.type.name === 'ComputerScreen')
  assert.equal(screen().props.live, true)
  assert.equal(screen().props.controlToken, 'synthetic-ticket')
  assert.equal(view.button('Send key').props.disabled, true)
  const keys = []
  screen().props.onControls({ key: key => keys.push(key) })
  screen().props.onReady()
  view.button('Send key').props.onClick()
  assert.deepEqual(keys, ['Enter'])
  assert.equal(view.calls.some(call => call.method === 'input'), false)
  screen().props.onControls(null)
  screen().props.onLost()
  assert.equal(view.button('Send key').props.disabled, true)
  view.button('Use snapshot control').props.onClick()
  assert.equal(screen().props.live, false)
  assert.equal(screen().props.controlToken, undefined)
})

test('takeover clicked during a background preview runs once after the preview settles', async () => {
  const view = viewer()
  let release
  view.wait(new Promise(resolve => { release = resolve }))
  view.render()
  await tick()
  view.button('Take control').props.onClick()
  assert.equal(view.calls.some(call => call.method === 'takeover'), false)
  view.wait(null)
  release()
  await tick()
  assert.equal(view.calls.filter(call => call.method === 'takeover').length, 1)
  assert.ok(view.button('Renew control'))
  view.unmount()
})

test('unchanged desktop images keep fresh input enabled without another image load', async () => {
  const view = viewer()
  await view.own()
  assert.equal(Boolean(view.button('Send key').props.disabled), false)
  view.poll()
  await tick()
  // React keeps the same img src; the browser does not emit load again.
  assert.equal(Boolean(view.button('Send key').props.disabled), false)
  const send = view.button('Send key').props.onClick
  send()
  send()
  await tick()
  assert.equal(view.calls.filter(call => call.method === 'input').length, 1)
  assert.equal(view.calls.find(call => call.method === 'input').args.frameId, 'frame-4')
  assert.equal(view.button('Send key').props.disabled, true)
  view.image().props.onLoad()
  assert.equal(Boolean(view.button('Send key').props.disabled), false)
  view.unmount()
})

test('changed, expired and failed images cannot receive desktop input', async () => {
  const view = viewer()
  await view.own()
  view.data('different-png')
  view.poll()
  await tick()
  assert.equal(view.button('Send key').props.disabled, true)
  view.image().props.onLoad()
  assert.equal(Boolean(view.button('Send key').props.disabled), false)
  view.advance(5000)
  assert.equal(view.button('Send key').props.disabled, true)
  view.image().props.onError()
  assert.equal(view.button('Send key').props.disabled, true)
  view.unmount()
})

test('hiding discards an in-flight preview and closing never releases human control', async () => {
  const view = viewer()
  await view.own()
  let resolve
  view.wait(new Promise(done => { resolve = done }))
  view.poll()
  await tick()
  view.hide()
  resolve()
  await tick()
  assert.equal(view.image(), undefined)
  assert.equal(view.button('Send key').props.disabled, true)
  const count = view.calls.length
  view.poll()
  await tick()
  assert.equal(view.calls.length, count)
  view.unmount()
  assert.equal(view.timers.size, 0)
  assert.equal(view.listeners.size, 0)
  assert.equal(view.calls.some(call => call.method === 'release'), false)
})

test('busy refresh keeps the last image, disables input and recovers on a fresh preview', async () => {
  const view = viewer()
  await view.own()
  const src = view.image().props.src
  view.failPreview('bot/computer-busy')
  view.poll()
  await tick()
  assert.equal(view.image().props.src, src)
  assert.equal(view.button('Send key').props.disabled, true)
  assert.ok(find(view.render(), node => node.props.children.includes('The desktop is busy. Keeping the last preview until it is available again.')))
  view.advance(6000)
  assert.equal(view.image().props.src, src)
  assert.equal(view.button('Send key').props.disabled, true)
  view.failPreview(null)
  view.poll()
  await tick()
  assert.equal(Boolean(view.button('Send key').props.disabled), false)
  assert.equal(find(view.render(), node => node.props.children.includes('The desktop is busy. Keeping the last preview until it is available again.')), undefined)
  view.failPreview('bot/computer-stale-control')
  view.poll()
  await tick()
  assert.equal(view.image(), undefined)
  assert.equal(view.button('Give back to Bot').props.disabled, true)
  view.unmount()
})

test('a background snapshot leaves the access selector enabled', async () => {
  const view = viewer()
  view.render()
  await tick()
  await tick()
  const access = () => find(view.render(), node => node.type === 'select' && node.props.value === 'operate' && !node.props['aria-label'])
  assert.equal(Boolean(access().props.disabled), false)
  let release
  view.wait(new Promise(done => { release = done }))
  view.poll()
  await tick()
  assert.equal(Boolean(access().props.disabled), false)
  release()
  await tick()
  view.unmount()
})

test('approval selector sends an explicit YOLO choice and can restore per-action approval', async () => {
  const view = viewer()
  view.render()
  await tick()
  const select = () => find(view.render(), node => node.props['aria-label'] === 'CUA approval mode')
  assert.equal(select().props.value, 'required')
  select().props.onChange({ target: { value: 'yolo' } })
  await tick()
  const binding = view.calls.find(call => call.method === 'bind')
  assert.equal(binding.args.approvalMode, 'yolo')
  assert.equal(binding.args.grant, 'operate')
  assert.equal(binding.args.expectedRevision, 1)
  assert.equal(select().props.value, 'yolo')
  select().props.onChange({ target: { value: 'required' } })
  await tick()
  assert.equal(select().props.value, 'required')
  view.unmount()
})


test('desktop help Done requires takeover and submits the current request with its control token', async () => {
  const ui = viewer()
  ui.help([{ id: 'help', botId: 'bot', status: 'pending', note: 'Review the desktop.' }])
  ui.render()
  await tick()
  assert.equal(ui.button("I'm done").props.disabled, true)
  ui.button('Take control').props.onClick()
  await tick()
  assert.notEqual(ui.button("I'm done").props.disabled, true)
  ui.button("I'm done").props.onClick()
  await tick()
  const call = ui.calls.find(call => call.method === 'handoff-answer')
  assert.equal(call.args.requestId, 'help')
  assert.equal(call.args.outcome, 'done')
  assert.equal(call.args.controlToken, 'synthetic-ticket')
  assert.equal(ui.button("I'm done"), undefined)
  ui.unmount()
})

test('storage deletion requires confirmation and an external rebind cancels stale consent', async () => {
  const view = viewer()
  view.storage()
  view.render()
  await tick()
  view.button('Delete checkpoint').props.onClick()
  assert.equal(view.calls.some(call => call.method === 'delete-checkpoint'), false)
  assert.ok(view.button('Delete'))
  view.rebind()
  view.poll()
  await tick()
  assert.equal(view.button('Delete'), undefined)
  view.button('Delete checkpoint').props.onClick()
  view.button('Delete').props.onClick()
  await tick()
  const removed = view.calls.filter(call => call.method === 'delete-checkpoint')
  assert.equal(removed.length, 1)
  assert.equal(removed[0].args.expectedGeneration, 2)
  assert.equal(removed[0].args.checkpointId, 'backup')
  view.unmount()
})


test('image upgrade selector offers only later configured images and sends the selected generation', async () => {
  const view = viewer()
  const images = ['a', 'b', 'c'].map(value => `sha256:${value.repeat(64)}`)
  view.storage()
  view.images(images, images[1])
  view.render()
  await tick()
  const select = find(view.render(), node => node.props['aria-label'] === 'Desktop image')
  const options = select.props.children.flat()
  assert.deepEqual(options.map(node => node.props.value), ['', images[2]])
  assert.equal(view.button('Upgrade desktop').props.disabled, true)
  select.props.onChange({ target: { value: images[2] } })
  view.button('Upgrade desktop').props.onClick()
  await tick()
  const sent = view.calls.find(call => call.method === 'upgrade')
  assert.equal(sent.args.targetImage, images[2])
  assert.equal(sent.args.expectedGeneration, 1)
  assert.equal(view.button('Upgrade desktop'), undefined)
  view.unmount()
})


test('setup reads status, starts once on an explicit click, and closing leaves the background task running', async () => {
  const view = viewer({ setup: true })
  view.render()
  await tick()
  assert.deepEqual(view.calls.map(call => call.method), ['setup-state'])
  const prepare = view.button('Prepare and start').props.onClick
  prepare()
  prepare()
  await tick()
  assert.equal(view.calls.filter(call => call.method === 'setup-prepare').length, 1)
  assert.equal(view.button('Retry preparation').props.disabled, true)
  assert.ok(view.button('Cancel preparation'))
  view.unmount()
  assert.equal(view.timers.size, 0)
  assert.equal(view.calls.some(call => call.method === 'setup-cancel'), false)
})

test('setup resumes saved progress, sends a task-scoped cancellation, and stops polling while hidden', async () => {
  const view = viewer({ setup: true })
  view.setupState({ busy: true, job: { id: 'persisted', phase: 'preparing-image', log: 'Downloading layer' } })
  view.render()
  await tick()
  assert.ok(find(view.render(), node => node.type === 'pre' && node.props.children[0] === 'Downloading layer'))
  view.button('Cancel preparation').props.onClick()
  await tick()
  assert.equal(view.calls.find(call => call.method === 'setup-cancel').args.jobId, 'persisted')
  view.hide()
  const count = view.calls.length
  view.poll()
  await tick()
  assert.equal(view.calls.length, count)
  view.unmount()
})

test('an explicit profile disable keeps the prepare button unavailable', async () => {
  const view = viewer({ setup: true })
  view.setupState({ disabled: true })
  view.render()
  await tick()
  assert.equal(view.button('Prepare and start').props.disabled, true)
  view.unmount()
})


test('setup selects Podman explicitly and machine preparation is a separate user action', async () => {
  const ui = viewer({ setup: true })
  ui.render()
  await tick()
  const selector = find(ui.render(), node => node.type === 'select')
  selector.props.onChange({ target: { value: 'podman' } })
  ui.setupState({ environment: { ready: false, engine: 'podman', error: 'Machine stopped' }, canPrepareRuntime: true })
  ui.render()
  await tick()
  assert.ok(ui.calls.every(call => call.method === 'setup-state'))
  assert.equal(ui.calls.at(-1).args.engineKind, 'podman')
  ui.button('Prepare Podman machine and desktop').props.onClick()
  await tick()
  assert.equal(ui.calls.at(-1).args.prepareRuntime, true)
  assert.equal(ui.calls.at(-1).args.engineKind, 'podman')
  ui.setupState({ engine: 'podman', busy: false })
  ui.poll()
  await tick()
  assert.equal(find(ui.render(), node => node.type === 'select').props.disabled, true)
  ui.unmount()
})
