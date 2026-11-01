import { readFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { McpClient } from './mcp.mjs'
import { assertContainer, assertLocalEndpoint, assertVolume, assertHomeImage, quotaArguments, probeHomeQuota } from './boundary.mjs'
import { checkpoint, cleanup, homeVolume, ownedVolume, storageUsage } from './checkpoint.mjs'
import { createTransfers } from './transfers.mjs'
import { driverInput, driverReceipt } from './input.mjs'
import { rfbInput } from './rfb.mjs'
import { discoverEngine, validateEngine, runEngine, engineCommand, engineEnvironment } from '../engine.mjs'

const run = promisify(execFile)
const engine = process.env.DS_BOT_COMPUTER_ENGINE ? validateEngine(JSON.parse(process.env.DS_BOT_COMPUTER_ENGINE)) : null
const executable = engine?.executable ?? 'docker'
const image = process.argv[2]
const allowedImages = process.argv[4] ? JSON.parse(process.argv[4]) : [image]
if (!Array.isArray(allowedImages) || allowedImages.length > 5 || !allowedImages.includes(image) || allowedImages.some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw new Error('Invalid image list.')
const imageOf = value => value.record.runtimeImage ?? image
const stdio = process.argv[3] === '--stdio'
let runtimeKey
const send = message => {
  if (message.id !== undefined && runtimeKey) message = { ...message, runtimeKey }
  if (stdio) { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(message)}\n`) }
  else if (process.connected) process.send(message)
}
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '') || (!process.send && !stdio)) {
  throw new Error('Start the development Broker through its IPC adapter with an immutable local image id.')
}
const targets = new Map()
const requests = new Map()
const socket = '/tmp/dsbot-runtime/cua.sock'
const docker = async (args, signal) => {
  try {
    if (engine) return await runEngine(engine, args, { signal, maxBuffer: 12 * 1024 * 1024 })
    return await run(executable, args, { signal, windowsHide: true, timeout: 30_000, maxBuffer: 12 * 1024 * 1024 })
  }
  catch (error) { error.operation = args[0]; throw error }
}
const fail = message => { throw Object.assign(new Error(message), { public: true }) }
let runtimeChecked
async function localRuntime() {
  runtimeChecked ??= (async () => {
    if (engine) {
      await discoverEngine(engine)
      if (engine.kind === 'docker') process.env.DOCKER_HOST = engine.endpoint
      delete process.env.DOCKER_CONTEXT
      runtimeKey = createHash('sha256').update(JSON.stringify(engine.kind === 'docker'
        ? ['docker', engine.endpoint, engine.id] : engine)).digest('hex')
      return
    }
    const host = (process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST)
      ?? JSON.parse((await docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])).stdout)
    try { assertLocalEndpoint(host) } catch (error) { fail(error.message) }
    // Pin every later CLI/MCP subprocess to the checked daemon even if the
    // user's default Docker context changes while this Broker is running.
    process.env.DOCKER_HOST = host
    delete process.env.DOCKER_CONTEXT
    const id = JSON.parse((await docker(['info', '--format', '{{json .ID}}'])).stdout)
    if (typeof id !== 'string' || !id || id.length > 200) fail('The desktop engine identity could not be verified.')
    runtimeKey = createHash('sha256').update(JSON.stringify(['docker', host, id])).digest('hex')
  })()
  return runtimeChecked
}
let closing = false
function target(record) {
  if (!record || !/^cmp_[a-f0-9-]{36}$/.test(record.id) || !/^[\w-]{1,160}$/.test(record.botId)
    || !Number.isSafeInteger(record.generation) || record.generation < 1
    || (record.homeRevision !== undefined && !/^[a-f0-9-]{36}$/.test(record.homeRevision))) fail('Invalid desktop identity.')
  if (record.runtimeImage !== undefined && !allowedImages.includes(record.runtimeImage)) fail('This desktop is pinned to another image. Restore the original runtime configuration.')
  quotaArguments(record.homeQuotaBytes, engine)
  let value = targets.get(record.id)
  if (!value) {
    value = {
      name: `dsbot-${record.id}`, volume: homeVolume(record),
      record: { ...record }, fence: null, client: null, previewClient: null, modelSession: `model-${randomUUID()}`, previewSession: `preview-${randomUUID()}`, frame: null, busy: false,
    }
    targets.set(record.id, value)
  }
  if (record.botId !== value.record.botId || record.generation < value.record.generation) fail('Stale desktop identity.')
  if ((record.homeQuotaBytes ?? 0) !== (value.record.homeQuotaBytes ?? 0)) fail('Home quotas cannot be changed on an existing desktop.')
  if (record.generation === value.record.generation && (homeVolume(record) !== value.volume || (record.runtimeImage && value.record.runtimeImage && record.runtimeImage !== value.record.runtimeImage))) fail('Stale home identity.')
  if (record.generation > value.record.generation) {
    if (value.busy || value.fence) fail('Revoke the old desktop generation first.')
    closeViewers(value)
    value.record = { ...record }
    value.volume = homeVolume(record)
  }
  value.record = { ...record }
  return value
}
function networkMode() {
  return engine?.kind === 'podman' ? 'podman' : 'bridge'
}
function createArgs(value) {
  return [
    'create', '--name', value.name,
    '--label', `org.ds-bot.computer.id=${value.record.id}`, '--label', `org.ds-bot.computer.owner=${value.record.botId}`,
    '--label', 'org.ds-bot.computer.protocol=1',
    '--init', '--user', '1000:1000', '--network', networkMode(), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '4g', '--memory-swap', '4g', '--cpus', '2', '--pids-limit', '512', '--shm-size', '256m', '--restart', 'no',
    '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    '--mount', `type=volume,source=${value.volume},target=/home/cua`, imageOf(value),
  ]
}
async function readContainer(value, signal) {
  try { return JSON.parse((await docker(['inspect', value.name], signal)).stdout)[0] }
  catch (error) {
    if (/no such (object|container)/i.test(error.stderr ?? '')) return null
    fail('The container runtime could not inspect this desktop.')
  }
}
async function waitReady(value, signal) {
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted()
    try {
      await docker(['exec', value.name, 'cua-driver', 'status', '--socket', socket], signal)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  fail('The desktop driver did not become ready.')
}
// Network mode is fixed when the container is created. Replace an older offline
// container and keep its volume so the desktop can reach the internet.
async function replaceOfflineContainer(value, data, signal) {
  if (value.replacing) return value.replacing
  value.replacing = (async () => {
    const opened = { ...data, HostConfig: { ...data.HostConfig, NetworkMode: networkMode() } }
    try { assertContainer(opened, value, imageOf(value)) }
    catch (error) { fail(error.message) }
    const running = Boolean(data.State?.Running)
    if (running) await docker(['stop', '--time', '5', value.name], signal)
    await docker(['rm', value.name], signal)
    await docker(createArgs(value), signal)
    if (running) {
      await docker(['start', value.name], signal)
      value.reconciled = true
      await waitReady(value, signal)
    }
    return readContainer(value, signal)
  })()
  try { return await value.replacing }
  finally { value.replacing = null }
}
async function inspect(value, signal) {
  let data = await readContainer(value, signal)
  if (data?.HostConfig?.NetworkMode === 'none') data = await replaceOfflineContainer(value, data, signal)
  if (!data) return null
  try {
    assertContainer(data, value, imageOf(value))
    const volume = JSON.parse((await docker(['volume', 'inspect', value.volume], signal)).stdout)[0]
    assertVolume(volume, value)
    assertHomeImage(volume, value.record, imageOf(value), data.Image)
  } catch (error) {
    fail(error.operation ? 'The container runtime could not inspect the desktop volume.' : error.message)
  }
  return data
}
async function client(value, signal, key = 'client', session = value.modelSession) {
  if (value[key] && !value[key].closed) return value[key]
  const info = await inspect(value, signal)
  if (!info?.State.Running) fail('Start the desktop before using it.')
  const next = new McpClient(executable, engineCommand(engine, ['exec', '-i', '--user', '1000:1000', value.name, 'cua-driver', 'mcp', '--socket', socket]), engine ? { env: engineEnvironment(engine) } : {})
  try {
    await next.initialize(signal)
    await next.call('start_session', { session }, signal)
  }
  catch (error) { await next.close(); throw error }
  value[key] = next
  return next
}
// One chunk in flight per viewer bounds both IPC and stdio/WSL transport queues.
const viewers = new Map()
const relay = `import os, socket, select
s = socket.create_connection(('127.0.0.1', 5901), timeout=10)
s.setblocking(False)
os.set_blocking(0, False)
os.set_blocking(1, False)
a = bytearray()
b = bytearray()
eof = False
try:
 while True:
  if eof and not a: break
  r, w, _ = select.select(([0] if not eof and len(a)<65536 else []) + ([s] if len(b)<65536 else []), ([s] if a else []) + ([1] if b else []), [], 1)
  if 0 in r:
   v = os.read(0, 65536-len(a))
   if not v: eof = True
   a.extend(v)
  if s in r:
   v = s.recv(65536-len(b))
   if not v: break
   b.extend(v)
  if s in w:
   try: del a[:s.send(a)]
   except BlockingIOError: pass
  if 1 in w:
   try: del b[:os.write(1,b)]
   except BlockingIOError: pass
finally:
 s.close()
`
function closeViewer(id) {
  const viewer = viewers.get(id)
  if (!viewer) return
  viewers.delete(id)
  viewer.closed = true
  const child = viewer.child
  const exited = child ? new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Viewer relay did not stop.')) }, 2000)
    timer.unref()
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.stdin.end(viewer.interactive ? viewer.filter.release() : undefined)
    child.stdout.resume()
  }) : Promise.resolve()
  if (viewer.interactive) {
    // Preserve the cleanup promise until the next open/action/revoke observes it.
    viewer.value.inputCleanup = Promise.all([viewer.value.inputCleanup, exited]).then(async () => {
      const info = await inspect(viewer.value)
      if (!info?.State.Running) return
      const code = await readFile(new URL('./release-input.py', import.meta.url), 'utf8')
      await docker(['exec', '--user', '1000:1000', viewer.value.name, 'python3', '-c', code])
    }).catch(() => {
      viewer.value.dirty = true
      viewer.value.reconciled = false
    })
  } else void exited.catch(() => {})
  send({ stream: id, type: 'close' })
}
function closeViewers(value) {
  for (const [id, viewer] of viewers) if (viewer.value === value) closeViewer(id)
}
async function openViewer(value, id, signal, interactive = false) {
  if (typeof interactive !== 'boolean') fail('Invalid viewer mode.')
  if (interactive && [...viewers.values()].some(viewer => viewer.value === value && viewer.interactive)) fail('A live controller is already connected.')
  if (!/^viewer-[1-9][0-9]{0,15}$/.test(id ?? '') || viewers.has(id) || viewers.size >= 16
    || [...viewers.values()].filter(viewer => viewer.value === value).length >= 4) fail('Invalid viewer identity or limit.')
  const viewer = { value, interactive, filter: rfbInput(interactive), closed: false, writing: false }
  viewers.set(id, viewer)
  try {
    await value.inputCleanup
    const info = await inspect(value, signal)
    signal.throwIfAborted()
    if (viewer.closed || closing || !info?.State.Running || value.dirty) fail('Start the desktop before viewing it.')
    const child = spawn(executable, engineCommand(engine, ['exec', '-i', '--user', '1000:1000', value.name, 'python3', '-c', relay]), {
      ...(engine ? { env: engineEnvironment(engine) } : {}), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    viewer.child = child
    child.stdout.on('data', data => {
      child.stdout.pause()
      if (!viewer.closed) send({ stream: id, type: 'data', data: data.toString('base64') })
    })
    child.stdin.on('error', () => closeViewer(id))
    child.on('error', () => closeViewer(id))
    child.once('close', () => closeViewer(id))
    return { interactive }
  } catch (error) { closeViewer(id); throw error }
}
function viewerMessage(message) {
  const viewer = viewers.get(message.stream)
  if (!viewer) return
  const child = viewer.child
  if (message.type === 'close') return closeViewer(message.stream)
  if (message.type === 'ack') { child?.stdout.resume(); return }
  if (message.type !== 'write' || !child || viewer.writing || typeof message.data !== 'string' || message.data.length > 87384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) return closeViewer(message.stream)
  viewer.writing = true
  let data
  try { data = viewer.filter(Buffer.from(message.data, 'base64')) }
  catch { return closeViewer(message.stream) }
  child.stdin.write(data, error => {
    viewer.writing = false
    if (error) closeViewer(message.stream)
    else if (!viewer.closed) send({ stream: message.stream, type: 'written' })
  })
}

async function fileHelper(value, args, signal) {
  const helper = await readFile(new URL('./files.py', import.meta.url), 'utf8')
  const timeout = ['begin-read', 'commit'].includes(args.operation) ? 120_000 : 15_000
  const result = await new Promise((resolve, reject) => {
    const child = execFile(executable, engineCommand(engine, ['exec', '-i', '--user', '1000:1000', value.name, 'python3', '-c', helper]),
      { signal, ...(engine ? { env: engineEnvironment(engine) } : {}), windowsHide: true, timeout, maxBuffer: 512 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(args))
  })
  const response = JSON.parse(result)
  if (!response.ok) fail(response.error)
  return response.value
}

async function revoke(value) {
  if (value.revoking) return value.revoking
  value.fence = null
  value.frame = null
  value.dirty = true
  value.abort?.abort()
  value.revoking = (async () => {
    for (const [id, viewer] of viewers) if (viewer.value === value && viewer.interactive) closeViewer(id)
    await value.inputCleanup
    await value.settled
    try {
      const info = await inspect(value)
      if (info?.State.Running) {
        await value.transfers?.clear()
        if (!value.reconciled) {
          // A new Broker cannot account for input from a dead predecessor.
          // Stop its container; only an explicit start can resume this desktop.
          await docker(['stop', '--time', '5', value.name])
        } else {
          const list = async () => {
            const response = JSON.parse((await docker(['exec', value.name, 'cua-driver', 'sessions', 'list', '--json', '--socket', socket])).stdout)
            if (!Array.isArray(response.sessions) || response.count !== response.sessions.length) fail('The driver could not enumerate input scopes.')
            return response.sessions.filter(session => session.state === 'active')
          }
          const sessions = await list()
          for (const session of sessions) {
            if (typeof session.session !== 'string' || session.session.length > 200 || session.session.startsWith('-')) fail('Invalid driver session identity.')
            await docker(['exec', value.name, 'cua-driver', 'revoke', '--session', session.session, '--socket', socket])
          }
          await value.client?.close()
          await value.previewClient?.close()
          if ((await list()).length) fail('The driver did not revoke every input scope.')
        }
      }
      value.modelSession = `model-${randomUUID()}`
      value.previewSession = `preview-${randomUUID()}`
      value.reconciled = true
      value.dirty = false
    } finally {
      await value.client?.close()
      await value.previewClient?.close()
      value.previewClient = null
      value.client = null
      value.fence = null
      value.frame = null
    }
  })()
  try { await value.revoking } finally { value.revoking = null }
}
async function preview(value, signal) {
  const peer = await client(value, signal, 'previewClient', value.previewSession)
  const file = `/tmp/dsbot-frame-${randomUUID()}.png`
  try {
    const frame = await peer.call('get_desktop_state', { screenshot_out_file: file, session: value.previewSession }, signal)
    if (typeof frame.capture_id !== 'string') fail('The desktop returned no capture binding.')
    const encoded = (await docker(['exec', value.name, 'base64', '-w0', file], signal)).stdout
    signal.throwIfAborted()
    return { data: encoded, width: frame.screenshot_width, height: frame.screenshot_height }
  } finally {
    await docker(['exec', value.name, 'rm', '-f', file]).catch(() => {})
  }
}
async function start(value, signal) {
  const image = imageOf(value)
  const record = value.record
  const metadata = JSON.parse((await docker(['image', 'inspect', image], signal)).stdout)[0]
  if (metadata.Id !== image || metadata.Os !== 'linux' || metadata.Architecture !== 'amd64' || metadata.Config?.User !== '1000:1000'
    || metadata.Config?.Labels?.['org.ds-bot.computer.protocol'] !== '1'
    || metadata.Config?.Labels?.['org.ds-bot.computer.driver'] !== '0.37.0') fail('Unsupported desktop image.')
  if (record.homeQuotaBytes) await probeHomeQuota(docker, image, engine, signal)
  let info = await inspect(value, signal)
  if (!info) {
    let volume
    try { volume = JSON.parse((await docker(['volume', 'inspect', value.volume], signal)).stdout)[0] }
    catch (error) { if (!/no such volume/i.test(error.stderr ?? '')) throw error }
    if (volume) {
      try { assertVolume(volume, value); assertHomeImage(volume, record, image) } catch (error) { fail(error.message) }
    }
    if (!volume) await docker(['volume', 'create', ...quotaArguments(record.homeQuotaBytes, engine), '--label', `org.ds-bot.computer.id=${record.id}`, '--label', `org.ds-bot.computer.image=${image}`, value.volume], signal)
    await docker(createArgs(value), signal)
    info = await inspect(value, signal)
  }
  if (!info.State.Running) {
    await docker(['start', value.name], signal)
    value.reconciled = true
  }
  await waitReady(value, signal)
  return null
}
function candidateValue(value, options) {
  if (!/^[a-f0-9-]{36}$/.test(options.homeRevision ?? '') || !allowedImages.includes(options.targetImage)) fail('Invalid upgrade identity.')
  const record = { ...value.record, homeRevision: options.homeRevision, runtimeImage: options.targetImage }
  return { ...value, record, name: `dsbot-upgrade-${record.id}-${options.homeRevision}`, volume: homeVolume(record), client: null, previewClient: null }
}
async function retireCandidate(value, options, signal, existing) {
  const candidate = existing ?? candidateValue(value, options)
  await candidate.previewClient?.close()
  candidate.previewClient = null
  const info = await inspect(candidate, signal)
  if (info?.State.Running) await docker(['stop', '--time', '5', candidate.name], signal)
  if (info) await docker(['rm', candidate.name], signal)
}
async function dispatch(method, record, options, signal) {
  await localRuntime()
  if (method === 'health') return { protocolVersion: 1, runtimeKey }
  const value = target(record)
  const image = imageOf(value)
  if (method === 'inspect') {
    const info = await inspect(value, signal)
    let volume
    if (!info) {
      try { volume = JSON.parse((await docker(['volume', 'inspect', value.volume], signal)).stdout)[0] }
      catch (error) { if (!/no such volume/i.test(error.stderr ?? '')) throw error }
      if (volume) assertVolume(volume, value)
    }
    return { phase: value.dirty ? 'error' : info?.State.Running ? 'ready' : 'stopped', provider: 'local-container', isolation: 'container',
      image: info?.Image ?? volume?.Labels?.['org.ds-bot.computer.image'] ?? null, homeExists: Boolean(info || volume) }
  }
  if (method === 'viewer-open') return await openViewer(value, options.stream, signal, options.interactive ?? false)
  if (method === 'revoke') { await revoke(value); return null }
  await value.inputCleanup
  if (value.busy || value.revoking) fail('The desktop is busy.')
  if (value.dirty && method !== 'stop') fail('Desktop input must be revoked before this Computer can be reused.')
  value.busy = true
  let settle
  value.settled = new Promise(resolve => { settle = resolve })
  const abort = new AbortController()
  value.abort = abort
  signal = AbortSignal.any([signal, abort.signal])
  try {
    if (method === 'start') return await start(value, signal)
    if (method === 'stop') {
      closeViewers(value)
      value.fence = null
      value.frame = null
      await value.client?.close()
      await value.previewClient?.close()
      value.previewClient = null
      value.client = null
      const info = await inspect(value, signal)
      if (info?.State.Running) await docker(['stop', '--time', '5', value.name], signal)
      return null
    }
    if (method === 'quota-check') return probeHomeQuota(docker, image, engine, signal)
    if (method === 'diagnostics') return { storage: await storageUsage(value, { docker, image, signal }), image, network: 'open', isolation: 'container' }
    if (method === 'cleanup') {
      if (options.targetImage && options.staged) await retireCandidate(value, options, signal)
      return await cleanup(value, options, docker, signal)
    }
    if (method === 'upgrade') {
      if (!allowedImages.includes(options.targetImage) || allowedImages.indexOf(options.targetImage) <= allowedImages.indexOf(image)) fail('Choose a different configured image.')
      const info = await inspect(value, signal)
      if (info?.State.Running) fail('Stop the desktop before upgrading.')
      const candidate = candidateValue(value, options)
      // A blank desktop must pass image, driver and screenshot checks before any home is copied.
      await ownedVolume(candidate.volume, value, docker, signal, { missing: true }).then(data => { if (data) fail('Staging storage already exists.') })
      await docker(['volume', 'create', '--label', `org.ds-bot.computer.id=${record.id}`,
        ...quotaArguments(record.homeQuotaBytes, engine),
        '--label', `org.ds-bot.computer.image=${options.targetImage}`, '--label', 'org.ds-bot.computer.storage=staged-home', candidate.volume], signal)
      try { await start(candidate, signal); await preview(candidate, signal) }
      finally { await retireCandidate(value, options, undefined, candidate) }
      await cleanup(value, { ...options, kind: 'home', staged: true }, docker, signal)
      await checkpoint('restore', value, options, { docker, image, signal, executable, engine, destinationImage: options.targetImage })
      try { await start(candidate, signal); await preview(candidate, signal) }
      finally { await retireCandidate(value, options, undefined, candidate) }
      if (info) await docker(['rm', value.name], signal)
      return { image: options.targetImage }
    }
    if (method === 'rollback') {
      const info = await inspect(value, signal)
      if (info?.State.Running) fail('Stop the desktop before rolling back.')
      if (!(record.previousHomes ?? []).includes(options.homeRevision) || options.homeRevision === (record.homeRevision ?? null)) fail('Choose a retained previous home.')
      const previous = await ownedVolume(homeVolume({ ...record, homeRevision: options.homeRevision }), value, docker, signal)
      const previousImage = record.previousImages?.[options.homeRevision ?? 'original'] ?? image
      if (!allowedImages.includes(previousImage) || options.targetImage !== previousImage) fail('The previous home image must remain configured.')
      assertHomeImage(previous, { ...record, runtimeImage: previousImage }, previousImage)
      if (info) await docker(['rm', value.name], signal)
      return null
    }
    if (['checkpoint', 'restore', 'recreate'].includes(method)) {
      const info = await inspect(value, signal)
      if (info?.State.Running) fail('Stop the desktop before changing its storage.')
      const result = method === 'recreate' ? null : await checkpoint(method, value, options, { docker, image, signal, executable, engine })
      // The old home survives removal. Restore publishes a verified new home only in the host journal.
      if (method !== 'checkpoint' && info) await docker(['rm', value.name], signal)
      return result
    }
    if (method === 'files') {
      const info = await inspect(value, signal)
      if (!info?.State.Running) fail('Start the desktop before transferring files.')
      if (['list', 'read', 'write'].includes(options.operation)) {
        return await fileHelper(value, { operation: options.operation, name: options.name, data: options.data }, signal)
      }
      value.transfers ??= createTransfers((args, signal) => fileHelper(value, args, signal))
      if (options.operation === 'expire') { if (value.transfers.expired()) await value.transfers.clear(); return null }
      try { return await value.transfers.call(options, signal) }
      catch (error) { fail(error.message) }
    }
    if (method === 'preview') return await preview(value, signal)
    if (method === 'observe') {
      if (typeof options.fence !== 'string' || options.fence.length > 100) fail('Invalid input fence.')
      const peer = await client(value, signal, 'client', value.modelSession)
      const file = `/tmp/dsbot-frame-${randomUUID()}.png`
      try {
        const frame = await peer.call('get_desktop_state', { screenshot_out_file: file, session: value.modelSession }, signal)
        if (typeof frame.capture_id !== 'string') fail('The desktop returned no capture binding.')
        const encoded = (await docker(['exec', value.name, 'base64', '-w0', file], signal)).stdout
        signal.throwIfAborted()
        value.fence = options.fence
        value.frame = frame
        return { data: encoded, width: frame.screenshot_width, height: frame.screenshot_height }
      } finally {
        await docker(['exec', value.name, 'rm', '-f', file]).catch(() => {})
      }
    }
    if (method === 'perform') {
      if (!value.frame || value.fence !== options.fence || !value.client) fail('The observation or input lease was revoked.')
      let input
      try { input = driverInput(options.actions, value.frame) } catch (error) { fail(error.message) }
      value.frame = null
      const result = await value.client.call(input.name, { ...input.args, session: value.modelSession }, signal)
      signal.throwIfAborted()
      return driverReceipt(result)
    }
    fail('Unsupported Broker operation.')
  } catch (error) {
    if (!['preview', 'files', 'diagnostics'].includes(method)) {
      value.dirty = true
      value.fence = null
      value.frame = null
    }
    throw error
  } finally {
    value.busy = false
    value.abort = null
    settle()
  }
}
function receive(message) {
  if (message?.stream !== undefined) { viewerMessage(message); return }
  if (message?.cancel) { requests.get(message.cancel)?.abort(); return }
  if (closing || !Number.isSafeInteger(message?.id) || requests.has(message.id)) return
  const abort = new AbortController()
  requests.set(message.id, abort)
  void dispatch(message.method, message.record, message.options ?? {}, abort.signal).then(
    value => send({ id: message.id, ok: true, value }),
    error => {
      send({
        id: message.id, ok: false,
        error: error.public === true ? error.message
          : `Computer operation failed (${error.operation ?? 'protocol'}, ${String(error.code ?? error.name).slice(0, 40)}). Input may have executed; observe before continuing.`,
      })
    },
  ).finally(() => requests.delete(message.id))
}
process.on('message', receive)
if (stdio) {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 1024 * 1024) { void shutdown(); return }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message
      try { message = JSON.parse(line) } catch { void shutdown(); return }
      receive(message)
    }
  })
  process.stdin.once('end', () => { void shutdown() })
  process.stdout.on('error', () => { void shutdown() })
}
async function shutdown() {
  if (closing) return
  closing = true
  for (const id of viewers.keys()) closeViewer(id)
  for (const abort of requests.values()) abort.abort()
  await Promise.allSettled([...targets.values()].map(async value => {
    await revoke(value)
    const info = await inspect(value)
    if (info?.State.Running) await docker(['stop', '--time', '5', value.name])
  }))
  process.exit(0)
}
const transferReaper = setInterval(() => {
  if (closing) return
  for (const value of targets.values()) {
    if (!value.busy && !value.revoking && value.transfers?.expired()) {
      void dispatch('files', value.record, { operation: 'expire' }, AbortSignal.timeout(20_000)).catch(() => {})
    }
  }
}, 30_000)
transferReaper.unref()
process.once('disconnect', shutdown)
process.once('SIGTERM', shutdown)
