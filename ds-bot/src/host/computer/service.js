import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { checkActions, checkFrame, checkId, checkProvider, refused } from './contract.js'
import { createComputerStore } from './store.js'
import { createLeases } from './leases.js'
import { contextFile, fileBytes, fileName } from './artifacts.js'
import { createComputerStorage } from './lifecycle.js'
import { createComputerHandoffs } from './handoffs.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const imageHash = data => createHash('sha256').update(data).digest('hex')
const receipt = operation => ({
  operationId: operation.id,
  outcome: operation.outcome === 'pending' ? 'unknown' : operation.outcome,
  completedActions: operation.completedActions ?? 0,
  retryPolicy: operation.outcome === 'completed' ? 'do-not-repeat' : 'observe-first',
})

export function createComputerService(rt, injectedProvider, { now, ttl } = {}) {
  const provider = checkProvider(injectedProvider)
  const leases = createLeases({ now, ttl })
  const active = new Map()
  const controls = new Map()
  const humans = new Map()
  const clock = now ?? Date.now
  const humanTtl = 60_000
  const frameTtl = 5_000
  const frames = new Map()
  const held = new Map()
  const managing = new Set()
  const touched = new Map()
  const maxRunning = rt.config.computer?.maxRunning ?? 2
  const idleStopMs = rt.config.computer?.idleStopMs ?? 900_000
  if (!Number.isInteger(maxRunning) || maxRunning < 1 || maxRunning > 8
    || !Number.isSafeInteger(idleStopMs) || (idleStopMs !== 0 && idleStopMs < 60_000)) {
    throw refused('invalid', 'Desktop limits require maxRunning 1–8 and idleStopMs 0 or at least 60000.')
  }
  let closed = false
  let initializing
  function writable() {
    if (closed) throw refused('unavailable', 'The Computer service is stopping.')
    if (rt.readOnly() !== undefined) throw refused('read-only', 'This host does not own the Bot team.')
  }
  const store = createComputerStore(join(rt.home, 'computers', 'registry.json'), { writable })
  async function ready() {
    await rt.load()
    writable()
    if (!initializing) initializing = (async () => {
      const state = await store.load()
      // A previous host may have died after sending input but before saving a receipt.
      if (Object.values(state.operations).some(operation => operation.outcome === 'pending')) {
        await store.update(draft => {
          for (const operation of Object.values(draft.operations)) {
            if (operation.outcome === 'pending') operation.outcome = 'unknown'
          }
        })
      }
      for (const record of Object.values(state.computers)) {
        controls.set(record.id, 'blocked')
        try {
          if (provider.image && !(provider.images ?? [provider.image]).includes(record.runtimeImage)) {
            const replacing = Boolean(record.runtimeImage)
            const retained = record.homeRevision || record.previousHomes?.length || state.lifecycle?.[record.id]
              || Object.values(state.checkpoints ?? {}).some(item => item.computerId === record.id)
            if (replacing && retained) compatible(record)
            // Removing the pin is only for a read-only provenance query, never for dispatch.
            const inspected = await provider.inspect({ ...record, runtimeImage: undefined })
            const empty = inspected.phase === 'stopped' && inspected.homeExists === false && !retained
            if (!empty && (replacing || inspected.image !== provider.image)) {
              throw refused('image-unverified', 'The image that owns this home could not be verified. Keep the original runtime configuration.')
            }
            await store.update(draft => {
              draft.computers[record.id].runtimeImage = provider.image
              if (replacing) {
                draft.computers[record.id].generation++
                for (const item of Object.values(draft.handoffs ?? {})) if (item.computerId === record.id) item.status = 'cancelled'
              }
            })
            record.runtimeImage = provider.image
            if (replacing) record.generation++
          }
          compatible(record)
          await provider.revoke(record)
          await storageManager.reconcile(record)
          const recovered = (await store.load()).computers[record.id]
          controls.set(record.id, recovered.humanPaused ? 'human' : 'none')
          touched.set(record.id, clock())
        } catch {
          // A desktop whose old input authority cannot be revoked stays blocked.
        }
      }
    })()
    await initializing
    writable()
  }
  function owner(exec) {
    const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
    if (!rt.isBotSession(sessionId)) throw refused('owner-denied', 'Only a current Bot Session may use its assigned desktop. Subagents are not enabled.')
    const botId = rt.selfOf(sessionId)
    const bot = rt.botOf(botId)
    const group = rt.groupOwners.get(sessionId)
    if (!bot || (group && (bot.private || !rt.roomOf(group.roomId)?.members?.includes(botId)))) {
      throw refused('owner-denied', 'This Session no longer owns a desktop.')
    }
    const turnId = rt.live.get(sessionId)?.turn
    if (!Number.isSafeInteger(turnId)) throw refused('owner-denied', 'A running Bot turn is required.')
    return { botId, sessionId, turnId }
  }
  function compatible(record) {
    if (provider.image && !(provider.images ?? [provider.image]).includes(record.runtimeImage)) {
      throw refused('image-incompatible', 'This home is pinned to its original image. Restore that runtime configuration or include the original image in the configured image list.')
    }
  }
  async function assigned(botId) {
    checkId(botId)
    if (!rt.botOf(botId)) throw refused('owner-denied', 'Unknown Bot.')
    const state = await store.load()
    const record = Object.values(state.computers).find(item => item.botId === botId && !item.archived)
    if (!record) throw refused('off', 'This Bot has no assigned desktop.')
    compatible(record)
    return record
  }
  function invalidate(id) {
    frames.delete(id)
    held.delete(id)
    leases.revoke(id)
  }
  async function administration(id, work) {
    if (managing.has(id)) throw refused('busy', 'Desktop settings are already changing.')
    managing.add(id)
    try { return await work() } finally { managing.delete(id) }
  }
  function available(record) {
    writable()
    if (store.snapshot()?.lifecycle?.[record.id]) throw refused('recovery-required', 'Finish storage recovery before using this desktop.')
    if (record.grant === 'off') throw refused('off', 'This desktop is disabled. Its files are retained.')
    if (controls.get(record.id) && controls.get(record.id) !== 'none') {
      throw refused('human-control', 'Automatic observation and input are paused. Wait for the user to give back control.')
    }
  }
  async function stillOwns(record, who) {
    writable()
    const current = await assigned(who.botId)
    if (current.id !== record.id || current.generation !== record.generation) throw refused('stale-generation', 'The assigned desktop changed.')
    if (!rt.isBotSession(who.sessionId) || rt.selfOf(who.sessionId) !== who.botId || rt.live.get(who.sessionId)?.turn !== who.turnId) {
      throw refused('owner-denied', 'The original Bot turn is no longer running.')
    }
    const group = rt.groupOwners.get(who.sessionId)
    if (group && !rt.roomOf(group.roomId)?.members?.includes(who.botId)) throw refused('owner-denied', 'The Bot left this group.')
    available(current)
    return current
  }
  function exclusive(record, signal, work) {
    if (active.has(record.id)) throw refused('busy', 'A desktop operation is still settling.')
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const entry = { controller, signal: combined }
    active.set(record.id, entry)
    entry.promise = Promise.resolve().then(() => {
      combined.throwIfAborted()
      touched.set(record.id, clock())
      return work(combined, entry)
    }).finally(() => {
      touched.set(record.id, clock())
      if (active.get(record.id) === entry) active.delete(record.id)
    })
    return entry.promise
  }
  async function barrier(record, state = 'blocked') {
    controls.set(record.id, state)
    humans.delete(record.id)
    invalidate(record.id)
    const pending = active.get(record.id)
    pending?.controller.abort()
    try {
      await provider.revoke(record)
      await pending?.promise.catch(() => {})
      // An operation that was already inside a driver may have settled after revoke.
      await provider.revoke(record)
    } catch {
      controls.set(record.id, 'blocked')
      throw refused('revoke-failed', 'Input revocation could not be confirmed. This desktop remains blocked.')
    }
  }
  async function vision(exec) {
    const config = exec.agent?.session?.requestHeader?.()?.config
    if (!config?.provider || !config.model || rt.config.textOnlyModels?.includes(`${config.provider}/${config.model}`)) {
      throw refused('vision-required', 'Select a model with declared image input before observing or operating this desktop.')
    }
    let info
    try { info = await rt.ctx.llm.resolveModelInfo(config.provider, config.model) } catch {}
    if (!info?.inputModalities?.includes('image')) throw refused('vision-required', 'The model has no verified image input capability.')
  }
  const handoffs = createComputerHandoffs(rt, {
    store, ready, owner, assigned, available, barrier, administration, human, controls, stillOwns,
    hasHuman: id => humans.has(id), claim: (record, who) => leases.acquire(record, who),
  })
  const storageManager = createComputerStorage({ store, provider, ready, assigned, administration, barrier, exclusive, controls, clock, state, reserveRuntime })
  const storage = storageManager.run
  async function state() {
    await ready()
    const stored = await store.load()
    const computers = []
    for (const record of Object.values(stored.computers)) {
      let phase = 'unavailable'
      try {
        const inspected = await provider.inspect(record)
        if (['ready', 'stopped', 'starting', 'error'].includes(inspected.phase)) phase = inspected.phase
      } catch {}
      computers.push({
        id: record.id, botId: record.botId, generation: record.generation, grant: record.grant,
        archived: record.archived, executionPolicy: record.executionPolicy, approvalMode: record.approvalMode ?? 'required',
        runtimeImage: record.runtimeImage, previousImages: record.previousImages ?? {},
        previousHomes: record.previousHomes ?? [], recoveryPending: Boolean(stored.lifecycle?.[record.id]),
        provider: provider.kind, phase, control: controls.get(record.id) ?? 'none',
        humanExpired: controls.get(record.id) === 'human' && (!humans.has(record.id) || humans.get(record.id).expires <= clock()),
      })
    }
    return { revision: stored.revision, computers, images: provider.images ?? [], limits: { maxRunning, idleStopMs }, storageAvailable: typeof provider.checkpoint === 'function', checkpoints: Object.values(stored.checkpoints ?? {}), handoffs: await handoffs.list() }
  }
  async function diagnostics(args) {
    await ready()
    const record = await assigned(args.botId)
    if (record.generation !== args.expectedGeneration) throw refused('stale-generation', 'Refresh before checking storage.')
    if (typeof provider.diagnostics !== 'function') throw refused('unavailable', 'Storage diagnostics are unavailable.')
    if (store.snapshot()?.lifecycle?.[record.id]) throw refused('recovery-required', 'Finish storage recovery before checking storage.')
    return exclusive(record, undefined, signal => provider.diagnostics(record, { signal }))
  }
  async function bind(args) {
    await ready()
    checkId(args.botId)
    return administration(args.botId, () => bindOnce(args))
  }
  async function bindOnce({ botId, grant = 'observe', executionPolicy = 'assisted', approvalMode = 'required', expectedRevision }) {
    await ready()
    checkId(botId)
    if (!rt.botOf(botId)) throw refused('owner-denied', 'Unknown Bot.')
    if (!['off', 'observe', 'operate'].includes(grant) || executionPolicy !== 'assisted') {
      throw refused('policy-denied', 'Only assisted mode is verified. Computer-only isolation is not available.')
    }
    if (!['required', 'yolo'].includes(approvalMode)) throw refused('policy-denied', 'Choose required or yolo approval mode.')
    const snapshot = await store.load()
    if (snapshot.revision !== expectedRevision) throw refused('conflict', 'Computer settings changed. Refresh before saving.')
    const existing = Object.values(snapshot.computers).find(record => record.botId === botId && !record.archived)
    if (existing) {
      compatible(existing)
      if (snapshot.lifecycle?.[existing.id]) throw refused('recovery-required', 'Finish storage recovery before changing desktop settings.')
      await barrier(existing)
      if (grant === 'off') await provider.stop(existing)
    }
    const result = await store.update(draft => {
      if (draft.revision !== expectedRevision) throw refused('conflict', 'Computer settings changed. Refresh before saving.')
      const id = existing?.id ?? `cmp_${randomUUID()}`
      const record = {
        ...(provider.image ? { runtimeImage: existing?.runtimeImage ?? provider.image } : {}),
        ...(existing?.homeRevision ? { homeRevision: existing.homeRevision } : {}),
        ...(existing?.previousHomes ? { previousHomes: existing.previousHomes } : {}),
        ...(existing?.previousImages ? { previousImages: existing.previousImages } : {}),
        id, botId, grant, executionPolicy, approvalMode, generation: (existing?.generation ?? 0) + 1, archived: false,
      }
      draft.computers[id] = record
      for (const item of Object.values(draft.handoffs ?? {})) {
        if (item.computerId === id && item.generation !== record.generation) item.status = 'cancelled'
      }
      return record
    })
    controls.set(result.id, 'none')
    return result
  }
  async function status(exec) {
    await ready()
    const who = owner(exec)
    const record = await assigned(who.botId)
    const view = await state()
    return view.computers.find(item => item.id === record.id)
  }
  async function observe(exec) {
    await ready()
    const who = owner(exec)
    const record = await assigned(who.botId)
    available(record)
    await vision(exec)
    return exclusive(record, exec.signal, async signal => {
      await stillOwns(record, who)
      const lease = leases.acquire(record, who)
      held.set(record.id, lease)
      frames.delete(record.id)
      const frame = checkFrame(await provider.observe(record, { fence: lease.fence, signal }))
      signal.throwIfAborted()
      await stillOwns(record, who)
      leases.check(lease)
      const attachments = rt.ctx.get?.('attachments')
      let attachment
      try {
        attachment = await attachments?.saveImage({
          data: frame.data, mediaType: frame.mediaType, name: 'Computer screenshot',
        })
      } catch {}
      if (!attachment?.attachmentId || !['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType)
        || !Number.isInteger(attachment.width) || !Number.isInteger(attachment.height)
        || attachment.width < 1 || attachment.height < 1 || attachment.width > frame.width || attachment.height > frame.height) {
        frames.delete(record.id)
        throw refused('observation-unavailable', 'The screenshot could not be stored. No image coordinates were authorized.')
      }
      signal.throwIfAborted()
      await stillOwns(record, who)
      leases.renew(lease)
      const observation = {
        observationId: `obs_${randomUUID()}`, width: attachment.width, height: attachment.height,
        nativeWidth: frame.width, nativeHeight: frame.height, generation: record.generation,
        scaleX: frame.width / attachment.width, scaleY: frame.height / attachment.height, origin: { x: 0, y: 0 },
      }
      frames.set(record.id, { ...observation, imageHash: imageHash(frame.data), attachmentId: attachment.attachmentId, lease, who })
      return { text: JSON.stringify(observation), attachment }
    })
  }
  async function act(args, exec) {
    await ready()
    const who = owner(exec)
    const record = await assigned(who.botId)
    available(record)
    if (record.grant !== 'operate') throw refused('policy-denied', 'The user granted observation only.')
    if (typeof exec.callId !== 'string' || !exec.callId) throw refused('invalid', 'A tool call id is required.')
    const id = hash([record.id, record.generation, who.sessionId, who.turnId, exec.callId])
    const actionHash = hash(args)
    const previous = (await store.load()).operations[id]
    if (previous) {
      if (previous.hash !== actionHash) throw refused('conflict', 'This call id was already used for different input.')
      return receipt(previous)
    }
    await vision(exec)
    const frame = frames.get(record.id)
    if (!frame || frame.observationId !== args.observationId || frame.who.sessionId !== who.sessionId || frame.who.turnId !== who.turnId) {
      throw refused('stale-observation', 'Observe this desktop in the current Session and turn before acting.')
    }
    const messages = exec.agent.session.deriveMessages?.()
    if (!messages?.some(message => message.content?.some(block =>
      block.type === 'image' && block.offloaded !== true && block.attachment?.attachmentId === frame.attachmentId))) {
      throw refused('stale-observation', 'The screenshot is no longer in this Session context. Observe again.')
    }
    const actions = checkActions(args.actions, frame)
    if (actions.length > (provider.maxActions ?? 8) || (provider.actions && actions.some(action => !provider.actions.includes(action.type)))) {
      throw refused('unsupported-action', 'This provider does not support the requested action batch.')
    }
    leases.check(frame.lease)
    return exclusive(record, exec.signal, async (signal, entry) => {
      leases.check(frame.lease)
      await stillOwns(record, who)
      if (record.approvalMode !== 'yolo') {
        const approval = rt.ctx.get?.('approval')
        if (typeof approval?.request !== 'function') throw refused('approval-required', 'The approval service is unavailable. Nothing was done.')
        const waiting = new AbortController()
        const stopRenewing = leases.keepAlive(frame.lease, error => waiting.abort(error))
        let decision
        entry.previewAllowed = true
        try {
          decision = await approval.request({
            agent: exec.agent, toolName: 'computer_act', callId: exec.callId,
            signal: AbortSignal.any([signal, waiting.signal]),
            reason: `Allow ${actions.length} desktop action(s) for ${rt.botOf(who.botId).name}? Review the current desktop and requested tool arguments.`,
          })
        } finally {
          entry.previewAllowed = false
          // Drain the last preview before re-observing or dispatching input.
          await entry.preview?.catch(() => {})
          stopRenewing()
        }
        waiting.signal.throwIfAborted()
        signal.throwIfAborted()
        if (decision !== 'allowed-once') throw refused('approval-denied', 'The desktop action was not approved. Nothing was done.')
      }
      await stillOwns(record, who)
      leases.check(frame.lease)
      const currentFrame = checkFrame(await provider.observe(record, { fence: frame.lease.fence, signal }))
      if (imageHash(currentFrame.data) !== frame.imageHash) {
        frames.delete(record.id)
        throw refused('stale-observation', 'The desktop changed before input. Observe again before requesting new input.')
      }
      signal.throwIfAborted()
      await stillOwns(record, who)
      leases.check(frame.lease)
      frames.delete(record.id)
      await store.update(draft => {
        if (Object.keys(draft.operations).length >= 10_000) throw refused('journal-full', 'The operation journal is full. No input was sent.')
        draft.operations[id] = { id, hash: actionHash, computerId: record.id, outcome: 'pending', completedActions: 0 }
      })
      let result
      try {
        signal.throwIfAborted()
        await stillOwns(record, who)
        leases.check(frame.lease)
        const response = await provider.perform(record, {
          actions: actions.map(action => (action.x === undefined ? action : {
            ...action, x: Math.floor(action.x * frame.scaleX), y: Math.floor(action.y * frame.scaleY),
          })),
          fence: frame.lease.fence, operationId: id,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        })
        if (!['completed', 'partial', 'rejected', 'unknown'].includes(response?.outcome)
          || !Number.isInteger(response.completedActions) || response.completedActions < 0 || response.completedActions > actions.length
          || (response.outcome === 'completed' && response.completedActions !== actions.length)) throw new Error('Invalid receipt')
        result = { outcome: response.outcome, completedActions: response.completedActions }
      } catch {
        // The driver may have accepted input before the connection failed.
        result = { outcome: 'unknown', completedActions: 0 }
      }
      await store.update(draft => Object.assign(draft.operations[id], result))
      return receipt({ id, ...result })
    })
  }
  async function release(exec) {
    await ready()
    const who = owner(exec)
    const record = await assigned(who.botId)
    available(record)
    const lease = held.get(record.id)
    if (lease && (lease.sessionId !== who.sessionId || lease.turnId !== who.turnId)) throw refused('busy', 'Another Session owns this desktop.')
    return administration(who.botId, async () => {
      await barrier(record)
      controls.set(record.id, 'none')
      return { released: true }
    })
  }
  async function reserveRuntime(record, work) {
    return administration('runtime-start', async () => {
      let running = 0
      for (const other of Object.values((await store.load()).computers)) {
        if (other.id === record.id) continue
        if ((await provider.inspect(other)).phase !== 'stopped') running++
      }
      if (running >= maxRunning) throw refused('resource-limit', 'The running desktop limit was reached. Stop another desktop first.')
      return work()
    })
  }
  async function manage(method, args) {
    await ready()
    checkId(args.botId)
    return administration(args.botId, () => manageOnce(method, args))
  }
  async function manageOnce(method, { botId, expectedGeneration, controlToken }) {
    await ready()
    const record = await assigned(botId)
    if (record.generation !== expectedGeneration) throw refused('stale-generation', 'The desktop binding changed. Refresh before managing it.')
    let ticket
    if (method === 'takeover') {
      if ((await store.load()).lifecycle?.[record.id]) throw refused('recovery-required', 'Finish storage recovery before taking control.')
      if (record.grant === 'off') throw refused('off', 'Enable this desktop first.')
      await store.update(draft => { draft.computers[record.id].humanPaused = true })
      await barrier(record, 'taking-over')
      ticket = { token: randomUUID(), expires: clock() + humanTtl, frame: null }
      humans.set(record.id, ticket)
      controls.set(record.id, 'human')
    } else if (method === 'release') {
      human(record, controlToken)
      await barrier(record)
      await store.update(draft => { draft.computers[record.id].humanPaused = false })
      controls.set(record.id, 'none')
    } else if (method === 'start') {
      if ((await store.load()).lifecycle?.[record.id]) throw refused('recovery-required', 'Finish storage recovery before starting this desktop.')
      available(record)
      await barrier(record)
      await reserveRuntime(record, () => exclusive(record, undefined, signal => provider.start(record, { signal }))).catch(error => {
        if (['bot/computer-resource-limit', 'bot/computer-busy'].includes(error.code)) controls.set(record.id, 'none')
        throw error
      })
      controls.set(record.id, 'none')
    } else if (method === 'stop') {
      await barrier(record)
      await provider.stop(record)
      await store.update(draft => {
        draft.computers[record.id].humanPaused = false
        for (const item of Object.values(draft.handoffs ?? {})) {
          if (item.computerId === record.id && ['pending', 'queued', 'sending', 'unknown'].includes(item.status)) item.status = 'cancelled'
        }
      })
      controls.set(record.id, 'none')
    } else throw refused('invalid', 'Unknown desktop operation.')
    return { ...await state(), ...(ticket ? { controlToken: ticket.token } : {}) }
  }
  function human(record, token) {
    writable()
    const ticket = humans.get(record.id)
    if (controls.get(record.id) !== 'human' || typeof token !== 'string'
      || ticket?.token !== token || ticket.expires <= clock()) {
      throw refused('stale-control', 'Control expired or belongs to another window. Take control again.')
    }
    return ticket
  }
  async function userRecord(args) {
    await ready()
    const record = await assigned(args.botId)
    if (record.generation !== args.expectedGeneration) throw refused('stale-generation', 'The desktop binding changed. Refresh before managing it.')
    if (record.grant === 'off') throw refused('off', 'Enable this desktop first.')
    return record
  }
  async function preview(args) {
    const record = await userRecord(args)
    const ticket = args.controlToken ? human(record, args.controlToken) : null
    if (!ticket && typeof provider.preview !== 'function') throw refused('unavailable', 'Desktop viewing is unavailable.')
    const pending = active.get(record.id)
    // Only the approval wait may share the lane with a read-only capture.
    const shared = !ticket && pending?.previewAllowed && !pending.preview
    if (pending && !shared) throw refused('busy', 'A desktop operation is still settling.')
    const capture = async signal => {
      const frame = checkFrame(await (ticket
        ? provider.observe(record, { fence: ticket.token, signal })
        : provider.preview(record, { signal })))
      signal.throwIfAborted()
      const frameId = randomUUID()
      if (ticket) {
        human(record, args.controlToken)
        ticket.expires = clock() + humanTtl
        ticket.frame = { frameId, width: frame.width, height: frame.height, at: clock(), hash: imageHash(frame.data) }
      }
      return { frameId, width: frame.width, height: frame.height, data: frame.data.toString('base64'), validForMs: frameTtl }
    }
    if (!shared) return exclusive(record, undefined, capture)
    pending.preview = Promise.resolve().then(() => {
      pending.signal.throwIfAborted()
      return capture(pending.signal)
    }).finally(() => { pending.preview = null })
    return pending.preview
  }
  async function humanAct(args) {
    const record = await userRecord(args)
    const ticket = human(record, args.controlToken)
    checkId(args.requestId)
    const id = hash([record.id, record.generation, ticket.token, args.requestId])
    const actionHash = hash([args.frameId, args.actions])
    const previous = (await store.load()).operations[id]
    if (previous) {
      if (previous.hash !== actionHash) throw refused('conflict', 'This request id was already used for different input.')
      return receipt(previous)
    }
    return exclusive(record, undefined, async signal => {
      human(record, args.controlToken)
      const frame = ticket.frame
      if (!frame || frame.frameId !== args.frameId || clock() - frame.at > frameTtl) {
        throw refused('stale-observation', 'Refresh the desktop before sending input.')
      }
      const actions = checkActions(args.actions, frame)
      if (actions.length !== 1) throw refused('invalid', 'Send one human action at a time.')
      ticket.frame = null
      // Bind input to the frame the user saw, including while another app redraws.
      const current = checkFrame(await provider.observe(record, { fence: ticket.token, signal }))
      if (imageHash(current.data) !== frame.hash) throw refused('stale-observation', 'The desktop changed. Refresh and review it before sending input.')
      human(record, args.controlToken)
      signal.throwIfAborted()
      await store.update(draft => {
        if (Object.keys(draft.operations).length >= 10_000) throw refused('journal-full', 'The operation journal is full. No input was sent.')
        draft.operations[id] = { id, hash: actionHash, computerId: record.id, outcome: 'pending', completedActions: 0 }
      })
      let result = { outcome: 'unknown', completedActions: 0 }
      try {
        signal.throwIfAborted()
        human(record, args.controlToken)
        const value = await provider.perform(record, { actions, fence: ticket.token, operationId: id, signal })
        if (['completed', 'partial', 'rejected', 'unknown'].includes(value?.outcome)
          && Number.isInteger(value.completedActions) && value.completedActions >= 0 && value.completedActions <= 1
          && (value.outcome !== 'completed' || value.completedActions === 1)) result = value
      } catch { /* Dispatch may have succeeded; never replay an uncertain result. */ }
      await store.update(draft => Object.assign(draft.operations[id], result))
      return receipt({ id, ...result })
    })
  }
  async function files(args) {
    const record = await userRecord(args)
    human(record, args.controlToken)
    if (typeof provider.files !== 'function') throw refused('unavailable', 'File transfer is unavailable.')
    if (!['list', 'read', 'write'].includes(args.operation)) throw refused('invalid', 'Unknown file operation.')
    if (args.operation !== 'list' && (typeof args.name !== 'string' || !/^[^/\\\x00-\x1f]{1,120}$/.test(args.name)
      || args.name === '.' || args.name === '..' || args.name.startsWith('.'))) throw refused('invalid', 'Use a plain file name without folders or hidden names.')
    if (args.operation === 'write' && (typeof args.data !== 'string' || args.data.length > 349_528
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)
      || Buffer.from(args.data, 'base64').length > 262_144)) throw refused('invalid', 'Files must be at most 256 KiB.')
    return exclusive(record, undefined, async signal => {
      human(record, args.controlToken).frame = null
      const value = await provider.files(record, { operation: args.operation, name: args.name, data: args.data, signal })
      signal.throwIfAborted()
      human(record, args.controlToken)
      return value
    })
  }
  async function modelFiles(method, args, exec) {
    await ready()
    const who = owner(exec)
    const record = await assigned(who.botId)
    available(record)
    if (typeof provider.files !== 'function') throw refused('unavailable', 'File transfer is unavailable.')
    if (!['list', 'import', 'export'].includes(method)) throw refused('invalid', 'Unknown file operation.')
    if (method !== 'list') fileName(args.name)
    if (method === 'import' && record.grant !== 'operate') throw refused('policy-denied', 'Import requires operate access.')
    const id = hash(['import', record.id, record.generation, who.sessionId, who.turnId, exec.callId])
    const inputHash = hash(args)
    if (method === 'import') {
      if (typeof exec.callId !== 'string' || !exec.callId) throw refused('invalid', 'A tool call id is required.')
      const previous = (await store.load()).operations[id]
      if (previous) {
        if (previous.hash !== inputHash) throw refused('conflict', 'This call already imported different input.')
        return receipt(previous)
      }
    }
    return exclusive(record, exec.signal, async signal => {
      await stillOwns(record, who)
      const lease = leases.acquire(record, who)
      held.set(record.id, lease)
      const waiting = new AbortController()
      const stopRenewing = leases.keepAlive(lease, error => waiting.abort(error))
      signal = AbortSignal.any([signal, waiting.signal])
      try {
        const attachments = rt.ctx.get?.('attachments')
        let data
        if (method === 'import') {
          data = await contextFile({ ...exec, signal }, attachments, args.attachmentId)
          if (record.approvalMode !== 'yolo') {
            const approval = rt.ctx.get?.('approval')
            if (typeof approval?.request !== 'function') throw refused('approval-required', 'File import needs approval.')
            const decision = await approval.request({
              agent: exec.agent, toolName: 'computer_import', callId: exec.callId, signal,
              reason: `Import ${args.name} (${data.length} bytes) into this Bot's private desktop? Existing files will not be overwritten.`,
            })
            if (decision !== 'allowed-once') throw refused('approval-denied', 'File import was not approved.')
          }
        }
        signal.throwIfAborted()
        await stillOwns(record, who)
        leases.check(lease)
        if (method === 'export' && typeof attachments?.saveFile !== 'function') throw refused('unavailable', 'File attachments are unavailable.')
        if (method === 'import') {
          frames.delete(record.id)
          await store.update(draft => {
            if (Object.keys(draft.operations).length >= 10_000) throw refused('journal-full', 'The operation journal is full. No file was written.')
            draft.operations[id] = { id, hash: inputHash, computerId: record.id, outcome: 'pending', completedActions: 0 }
          })
          let result = { outcome: 'unknown', completedActions: 0 }
          try {
            signal.throwIfAborted()
            await stillOwns(record, who)
            leases.check(lease)
            await provider.files(record, { operation: 'write', name: args.name, data: data.toString('base64'), signal })
            result = { outcome: 'completed', completedActions: 1 }
          } catch { /* A completed rename may precede a lost reply; never replay it. */ }
          await store.update(draft => Object.assign(draft.operations[id], result))
          return receipt({ id, ...result })
        }
        const value = await provider.files(record, {
          operation: method === 'export' ? 'read' : 'list',
          ...(method !== 'list' ? { name: args.name } : {}),
          ...(data ? { data: data.toString('base64') } : {}), signal,
        })
        signal.throwIfAborted()
        await stillOwns(record, who)
        leases.check(lease)
        if (method !== 'export') return value
        const bytes = fileBytes(value.data)
        const file = await attachments.saveFile({ data: bytes, name: args.name })
        signal.throwIfAborted()
        await stillOwns(record, who)
        if (!file?.attachmentId || file.bytes !== bytes.length) throw refused('unavailable', 'The file could not be attached.')
        return { text: `Exported ${args.name} (${bytes.length} bytes) from this desktop.`, file }
      } finally { stopRenewing() }
    })
  }
  async function archive(botId) {
    await ready()
    checkId(botId)
    return administration(botId, () => archiveOnce(botId))
  }
  async function archiveOnce(botId) {
    await ready()
    let record
    try { record = await assigned(botId) } catch (error) {
      if (error.code === 'bot/computer-off') return
      throw error
    }
    await barrier(record)
    await provider.stop(record)
    await store.update(draft => { draft.computers[record.id].archived = true })
  }
  async function endTurn(sessionId, turnId) {
    for (const record of Object.values((await store.load()).computers)) {
      if (held.get(record.id)?.sessionId !== sessionId) continue
      if (turnId !== undefined && held.get(record.id)?.turnId !== turnId) continue
      if (managing.has(record.botId)) continue
      await administration(record.botId, async () => {
        await barrier(record)
        controls.set(record.id, 'none')
      })
    }
  }
  async function reapIdle() {
    if (closed || !initializing || idleStopMs === 0) return
    await ready()
    for (const record of Object.values((await store.load()).computers)) {
      if (record.archived || held.has(record.id) || active.has(record.id) || managing.has(record.botId)
        || controls.get(record.id) !== 'none' || clock() - (touched.get(record.id) ?? clock()) < idleStopMs) continue
      await administration(record.botId, async () => {
        // Block new leases before awaiting the provider; a polling viewer is active use.
        controls.set(record.id, 'blocked')
        try {
          await barrier(record)
          await provider.stop(record)
          touched.set(record.id, clock())
          controls.set(record.id, 'none')
        } catch { throw refused('recovery-required', 'Idle shutdown failed. Stop this desktop to recover.') }
      })
    }
  }
  async function dispose() {
    closed = true
    for (const operation of active.values()) operation.controller.abort()
    try {
      if (initializing) {
        await initializing.catch(() => {})
        const state = await store.load()
        await Promise.allSettled(Object.values(state.computers).map(record => barrier(record)))
      }
      await store.flush()
    } finally {
      await provider.dispose?.()
    }
  }
  return { state, diagnostics, bind, status, observe, act, release, manage, preview, humanAct, files, modelFiles, handoffs, archive, endTurn, storage, reapIdle, dispose }
}
