import { randomUUID } from 'node:crypto'
import { refused } from './contract.js'

export const STORAGE_METHODS = ['checkpoint', 'restore', 'upgrade', 'recreate', 'rollback', 'delete-checkpoint', 'delete-home', 'prune-journal', 'recover']
const revision = record => record.homeRevision ?? null

export function createComputerStorage({ store, provider, ready, assigned, administration, barrier, exclusive, controls, clock, state, reserveRuntime }) {
  function advance(draft, id) {
    const record = draft.computers[id]
    record.generation++
    record.humanPaused = false
    for (const item of Object.values(draft.handoffs ?? {})) {
      if (item.computerId === id) item.status = 'cancelled'
    }
  }
  async function begin(record, method, fields = {}) {
    const operation = { id: randomUUID(), computerId: record.id, generation: record.generation, method, at: clock(), ...fields }
    await store.update(draft => {
      draft.lifecycle ??= {}
      if (draft.lifecycle[record.id]) throw refused('recovery-required', 'Finish storage recovery before making another change.')
      draft.lifecycle[record.id] = operation
    })
    return operation
  }
  async function finish(record, change = () => {}) {
    await store.update(draft => { change(draft); delete draft.lifecycle[record.id] })
  }
  const remove = (record, operation, signal) => provider.cleanup(record, {
    kind: operation.method === 'delete-checkpoint' || operation.method === 'checkpoint' ? 'checkpoint' : 'home',
    ...(operation.checkpointId ? { checkpointId: operation.checkpointId } : {}),
    ...(operation.homeRevision !== undefined ? { homeRevision: operation.homeRevision } : {}),
    staged: ['restore', 'upgrade'].includes(operation.method), targetImage: operation.targetImage, signal,
  })
  function deleted(draft, record, operation) {
    if (operation.method === 'delete-checkpoint') delete draft.checkpoints[operation.checkpointId]
    if (operation.method === 'delete-home') {
      draft.computers[record.id].previousHomes = (record.previousHomes ?? []).filter(id => id !== operation.homeRevision)
      if (draft.computers[record.id].previousImages) delete draft.computers[record.id].previousImages[operation.homeRevision ?? 'original']
    }
  }
  async function reconcile(record) {
    const operation = (await store.load()).lifecycle?.[record.id]
    if (!operation) return
    if (operation.generation !== record.generation) throw refused('store-invalid', 'Storage recovery generation does not match.')
    if (['checkpoint', 'restore', 'upgrade', 'delete-checkpoint', 'delete-home'].includes(operation.method)) {
      if (typeof provider.cleanup !== 'function') throw refused('unavailable', 'This provider cannot reconcile staged storage.')
      await remove(record, operation)
    }
    // Unpublished restore/recreate/rollback leaves the previous home authoritative.
    await finish(record, draft => { deleted(draft, record, operation); advance(draft, record.id) })
  }
  async function save(record) {
    const id = randomUUID()
    await begin(record, 'checkpoint', { checkpointId: id })
    const result = await exclusive(record, undefined, signal => provider.checkpoint(record, { checkpointId: id, signal }))
    const checkpoint = { id, computerId: record.id, at: clock(), ...result, ...(record.runtimeImage ? { image: record.runtimeImage } : {}) }
    await finish(record, draft => { draft.checkpoints ??= {}; draft.checkpoints[id] = checkpoint })
    return checkpoint
  }
  async function run(method, args) {
    await ready()
    if (!STORAGE_METHODS.includes(method)) throw refused('invalid', 'Unknown storage operation.')
    return administration(args.botId, async () => {
      const record = await assigned(args.botId)
      return method === 'upgrade' ? reserveRuntime(record, change) : change()
      async function change() {
        if (record.generation !== args.expectedGeneration) throw refused('stale-generation', 'Refresh before changing desktop storage.')
        if (method === 'recover') {
          await barrier(record)
          await reconcile(record)
          controls.set(record.id, 'none')
          return state()
        }
        const snapshot = await store.load()
        if (snapshot.lifecycle?.[record.id]) throw refused('recovery-required', 'Finish storage recovery before making another change.')
        if ((await provider.inspect(record)).phase !== 'stopped') throw refused('not-stopped', 'Stop the desktop before changing its storage.')
        const checkpoints = Object.values(snapshot.checkpoints ?? {}).filter(item => item.computerId === record.id)
        let checkpoint = snapshot.checkpoints?.[args.checkpointId]
        if (['restore', 'delete-checkpoint'].includes(method) && (!checkpoint || checkpoint.computerId !== record.id)) throw refused('invalid', 'Choose a checkpoint belonging to this desktop.')
        if (['rollback', 'delete-home'].includes(method) && (!(record.previousHomes ?? []).includes(args.homeRevision) || args.homeRevision === revision(record))) throw refused('invalid', 'Choose a retained previous home.')
        if (['restore', 'upgrade'].includes(method) && (record.previousHomes?.length ?? 0) >= 2) throw refused('resource-limit', 'Delete a previous home before restoring another checkpoint.')
        if (['checkpoint', 'recreate', 'upgrade'].includes(method) && checkpoints.length >= 2) throw refused('resource-limit', 'Delete a checkpoint before saving another one.')
        if (method === 'upgrade' && (!provider.images?.includes(args.targetImage) || provider.images.indexOf(args.targetImage) <= provider.images.indexOf(record.runtimeImage))) throw refused('image-incompatible', 'Choose a different configured desktop image.')
        if (method === 'restore' && checkpoint.image && checkpoint.image !== record.runtimeImage) throw refused('image-incompatible', 'Switch to the home paired with this checkpoint image before restoring it.')
        const required = ['delete-checkpoint', 'delete-home'].includes(method) ? 'cleanup' : method
        if (method !== 'prune-journal' && typeof provider[required] !== 'function') throw refused('unavailable', 'Desktop recovery is unavailable.')
        await barrier(record)
        if (method === 'prune-journal') {
          // Generation changes make old call ids and observations unusable before receipts are removed.
          await store.update(draft => {
            advance(draft, record.id)
            for (const [id, item] of Object.entries(draft.operations)) if (item.computerId === record.id) delete draft.operations[id]
            for (const [id, item] of Object.entries(draft.handoffs ?? {})) if (item.computerId === record.id) delete draft.handoffs[id]
          })
        } else if (['delete-checkpoint', 'delete-home'].includes(method)) {
          const operation = await begin(record, method, method === 'delete-checkpoint' ? { checkpointId: checkpoint.id } : { homeRevision: args.homeRevision })
          await exclusive(record, undefined, signal => remove(record, operation, signal))
          await finish(record, draft => deleted(draft, record, operation))
        } else {
          if (['checkpoint', 'recreate', 'upgrade'].includes(method)) checkpoint = await save(record)
          if (method !== 'checkpoint') {
            const homeRevision = ['restore', 'upgrade'].includes(method) ? randomUUID() : method === 'rollback' ? args.homeRevision : revision(record)
            const targetImage = method === 'upgrade' ? args.targetImage : method === 'rollback' ? record.previousImages?.[homeRevision ?? 'original'] ?? record.runtimeImage : record.runtimeImage
            const operation = await begin(record, method, { homeRevision, ...(targetImage ? { targetImage } : {}), ...(checkpoint ? { checkpointId: checkpoint.id } : {}) })
            await exclusive(record, undefined, signal => provider[method](record, { ...operation, ...(checkpoint ? { hash: checkpoint.hash } : {}), signal }))
            await finish(record, draft => {
              const current = draft.computers[record.id]
              if (['restore', 'upgrade'].includes(method)) current.previousHomes = [...(record.previousHomes ?? []), revision(record)]
              if (method === 'rollback') current.previousHomes = [...record.previousHomes.filter(id => id !== homeRevision), revision(record)]
              if (['restore', 'upgrade', 'rollback'].includes(method) && record.runtimeImage) {
                current.previousImages ??= {}
                delete current.previousImages[homeRevision ?? 'original']
                current.previousImages[revision(record) ?? 'original'] = record.runtimeImage
                current.runtimeImage = targetImage
              }
              if (homeRevision === null) delete current.homeRevision
              else current.homeRevision = homeRevision
              advance(draft, record.id)
            })
          }
        }
        controls.set(record.id, 'none')
        return state()
      }
    })
  }
  return { run, reconcile }
}
