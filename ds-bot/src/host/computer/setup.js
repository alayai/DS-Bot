import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'
import { refused, checkId } from './contract.js'
import { loadSetupRuntime } from './setup-runtime.js'

const ACTIVE = new Set(['checking', 'preparing-image', 'verifying-image', 'configuring', 'starting-desktop', 'checking-desktop', 'cancelling'])
const PHASES = new Set([...ACTIVE, 'ready', 'failed', 'cancelled', 'interrupted'])
const safeLog = text => String(text).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
  .replace(/((?:token|password|authorization|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[redacted]').slice(-16000)

export function createComputerSetup(rt, activate, { runtime = loadSetupRuntime, now = Date.now } = {}) {
  const directory = join(rt.home, 'computers')
  const file = join(directory, 'setup.json')
  let data = { version: 1 }
  let loaded, loadingRuntime, restoring, operation, starting, disposed = false, fault, environment, inspectedAt = 0
  let writing = Promise.resolve()
  const payload = () => loadingRuntime ??= runtime().catch(error => { loadingRuntime = undefined; throw error })
  const explicit = () => rt.config.computer?.enabled === true
  const disabled = () => rt.config.computer?.enabled === false
  const pending = () => Boolean(starting || operation || (data.job && data.job.phase !== 'ready' && !explicit()))
  function writable() {
    if (disposed) throw refused('unavailable', 'Desktop setup is stopping.')
    if (rt.readOnly() !== undefined) throw refused('read-only', 'This host does not own the Bot team.')
    if (disabled()) throw refused('off', 'Private desktops are disabled by the DSH profile.')
    if (fault) throw refused('setup-storage', 'Desktop setup could not be saved. Restart DSH before continuing.')
  }
  async function load() {
    await rt.load()
    loaded ??= (async () => {
      let text
      try { text = await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
      if (text.length > 65536) throw refused('setup-storage', 'Desktop setup metadata is too large.')
      const value = JSON.parse(text)
      if (value?.version !== 1 || (value.config && (!/^sha256:[a-f0-9]{64}$/.test(value.config.image ?? '')
        || !/^[a-f0-9]{64}$/.test(value.config.recipe ?? '')))
        || (value.job && (!PHASES.has(value.job.phase) || typeof value.job.id !== 'string' || typeof value.job.botId !== 'string'))) {
        throw refused('setup-storage', 'Desktop setup metadata is invalid; it has not been overwritten.')
      }
      if (value.config) (await payload()).validate(value.config.engine)
      if (value.selection) (await payload()).validate(value.selection)
      data = value
      if (data.job && ACTIVE.has(data.job.phase)) {
        data.job.phase = 'interrupted'
        data.job.error = 'Preparation was interrupted. Retry to check existing resources and continue.'
      }
    })()
    await loaded
  }
  async function save() {
    writable()
    const text = `${JSON.stringify(data)}\n`
    const next = writing.then(async () => {
      writable()
      await mkdir(directory, { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
        writable()
        await replaceFile(temporary, file, writable)
      } finally { await rm(temporary, { force: true }) }
    })
    writing = next.catch(error => { fault = error })
    return next
  }
  async function restore() {
    if (disabled() || explicit() || disposed) return
    await load()
    if (!data.config || rt.readOnly() !== undefined) return
    restoring ??= (async () => {
      const tools = await payload()
      await activate(tools.broker(data.config.engine, data.config.image))
    })().catch(error => { restoring = undefined; throw error })
    await restoring
  }
  function view() {
    return {
      enabled: Boolean(rt.computer), disabled: disabled(), explicit: explicit(), busy: Boolean(starting || operation),
      configured: Boolean(data.config), engine: data.config?.engine.kind ?? null,
      job: data.job ? { ...data.job, log: safeLog(data.job.log ?? '') } : null,
    }
  }
  async function state({ check = false } = {}) {
    await load()
    if (!disabled() && !explicit() && !operation && (check || !environment || now() - inspectedAt > 15000)) {
      try {
        const engine = await (await payload()).discover(data.config?.engine ?? data.selection)
        environment = { ready: true, engine: engine.kind }
      } catch (error) { environment = { ready: false, error: safeLog(error.message).slice(0, 500) } }
      inspectedAt = now()
    }
    return { ...view(), environment }
  }
  async function update(phase, error) {
    data.job = { ...data.job, phase, updatedAt: now(), ...(error ? { error } : { error: null }) }
    await save()
  }
  async function run(botId, signal) {
    let service, record, startingDesktop = false
    try {
      const tools = await payload()
      const engine = await tools.discover(data.config?.engine ?? data.selection)
      signal.throwIfAborted()
      data.selection = engine
      await save()
      let image
      if (data.config) {
        image = await tools.image(engine, data.config.image)
      } else {
        // A failed inspect is not evidence that there is no image. A build still
        // uses only the shipped recipe and never changes an existing Computer.
        try { image = await tools.image(engine) } catch {}
        if (!image) {
          await update('preparing-image')
          image = await tools.prepare(engine, {
            signal, log: text => { data.job.log = safeLog((data.job.log ?? '') + text); data.job.updatedAt = now() },
          })
        }
      }
      signal.throwIfAborted()
      await update('verifying-image')
      await tools.image(engine, image)
      signal.throwIfAborted()
      writable()
      data.config = { engine, image, recipe: tools.recipe }
      await update('configuring')
      await restore()
      service = rt.computer
      if (!service) throw refused('unavailable', 'The desktop service could not be enabled.')
      let current = await service.state()
      record = current.computers.find(item => item.botId === botId && !item.archived)
      if (!record) record = await service.bind({ botId, grant: 'observe', expectedRevision: current.revision })
      if (record.grant === 'off') throw refused('off', 'This desktop is disabled. Enable it from its access settings.')
      signal.throwIfAborted()
      await update('starting-desktop')
      startingDesktop = record.phase !== 'ready'
      if (startingDesktop) await service.manage('start', { botId, expectedGeneration: record.generation })
      signal.throwIfAborted()
      await update('checking-desktop')
      await service.preview({ botId, expectedGeneration: record.generation })
      signal.throwIfAborted()
      await update('ready')
      await rt.save?.()
    } catch (error) {
      if (signal.aborted && startingDesktop && record && service) {
        try { await service.manage('stop', { botId, expectedGeneration: record.generation }) }
        catch { error = new Error('Preparation was cancelled, but stopping the new desktop could not be confirmed. Review its state before retrying.') }
      }
      await update(signal.aborted ? 'cancelled' : 'failed', safeLog(error.message ?? 'Desktop preparation failed.').slice(0, 500))
    }
  }
  async function prepare({ botId, jobId } = {}) {
    await load()
    writable()
    if (explicit()) throw refused('configured', 'This profile already has an explicit desktop runtime. Use its desktop controls.')
    checkId(botId)
    if (!rt.botOf(botId)) throw refused('owner-denied', 'Unknown Bot.')
    if (operation || starting) {
      if (data.job?.botId !== botId) throw refused('busy', 'Desktop preparation is already running for another Bot.')
      return view()
    }
    if (jobId && jobId !== data.job?.id) throw refused('conflict', 'The preparation task changed. Refresh before retrying.')
    starting = true
    try {
      // Never infer a different engine for registry data created by an explicit
      // configuration. Its image store and volumes might be elsewhere.
      if (!data.config) {
        let registry
        try { registry = JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8')) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        if (Object.keys(registry?.computers ?? {}).length) throw refused('configured', 'Existing desktops require their original runtime configuration. Restore it before using setup.')
      }
      data.job = { id: randomUUID(), botId, phase: 'checking', updatedAt: now(), log: '' }
      await save()
      const controller = new AbortController()
      const entry = { controller }
      operation = entry
      const timer = setInterval(() => { void save().catch(() => { controller.abort(new Error('Desktop setup could not save progress.')) }) }, 2000)
      timer.unref?.()
      entry.done = run(botId, controller.signal).catch(() => {
        data.job = { ...data.job, phase: 'failed', error: 'Desktop setup could not save its result. Restart DSH to reconcile the task.' }
      }).finally(() => { clearInterval(timer); if (operation === entry) operation = undefined })
      return view()
    } finally { starting = false }
  }
  async function cancel({ jobId } = {}) {
    await load()
    writable()
    if (!operation) return view()
    if (jobId !== data.job?.id) throw refused('conflict', 'The preparation task changed. Refresh before cancelling.')
    const entry = operation
    entry.controller.abort(new Error('Desktop preparation was cancelled. Downloaded layers can be reused.'))
    if (operation === entry && ACTIVE.has(data.job.phase)) await update('cancelling')
    return view()
  }
  async function dispose() {
    operation?.controller.abort(new Error('DSH is stopping. Retry desktop preparation after restarting.'))
    await operation?.done
    await writing
    disposed = true
  }
  return { state, restore, prepare, cancel, pending, dispose }
}
