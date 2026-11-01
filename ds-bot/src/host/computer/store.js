import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkId, refused } from './contract.js'
import { desktopPolicy } from '../../../computer-runtime/broker/policy.mjs'
import { validateTasks } from './tasks.js'
import { resourceLimits } from '../../shared/computer-resources.js'

const empty = () => ({ version: 1, revision: 0, computers: {}, operations: {} })

function validate(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !value.computers || Array.isArray(value.computers) || typeof value.computers !== 'object'
    || !value.operations || Array.isArray(value.operations) || typeof value.operations !== 'object') {
    throw refused('store-invalid', 'Computer metadata is invalid; it has not been overwritten.')
  }
  if (value.tasks !== undefined) validateTasks(value.tasks, value.computers)
  if (value.storageClaims !== undefined && (!value.storageClaims || Array.isArray(value.storageClaims)
    || Object.keys(value.storageClaims).length > 10000 || Object.entries(value.storageClaims).some(([name, claim]) =>
      !/^dsbot-cmp_[a-f0-9-]{36}-(?:home(?:-[a-f0-9-]{36})?|backup-[a-f0-9-]{36})$/.test(name)
      || !/^[a-f0-9]{64}$/.test(claim?.stamp ?? '') || !/^sha256:[a-f0-9]{64}$/.test(claim?.image ?? '')))) throw refused('store-invalid', 'Invalid legacy storage evidence.')
  if (value.limits !== undefined) {
    try { resourceLimits(value.limits) } catch { throw refused('store-invalid', 'Invalid desktop resource limits.') }
  }
  for (const [id, record] of Object.entries(value.computers)) {
    checkId(id)
    if (record?.id !== id || !['off', 'observe', 'operate'].includes(record.grant)
      || (record.homeQuotaBytes !== undefined && (!Number.isSafeInteger(record.homeQuotaBytes) || record.homeQuotaBytes < 1024 ** 3 || record.homeQuotaBytes > 1024 ** 4))
      || (record.approvalMode !== undefined && !['required', 'yolo'].includes(record.approvalMode))
      || !['assisted'].includes(record.executionPolicy) || !Number.isSafeInteger(record.generation) || record.generation < 1
      || (record.runtimeImage !== undefined && !/^sha256:[a-f0-9]{64}$/.test(record.runtimeImage))
      || (record.homeRevision !== undefined && !/^[a-f0-9-]{36}$/.test(record.homeRevision))
      || (record.previousHomes !== undefined && (!Array.isArray(record.previousHomes) || record.previousHomes.length > 2 || record.previousHomes.some(id => id !== null && !/^[a-f0-9-]{36}$/.test(id))))
      || (record.previousImages !== undefined && (!record.previousImages || Array.isArray(record.previousImages) || typeof record.previousImages !== 'object' || Object.entries(record.previousImages).some(([key, image]) => !(record.previousHomes ?? []).includes(key === 'original' ? null : key) || !/^sha256:[a-f0-9]{64}$/.test(image))))
      || typeof record.archived !== 'boolean' || (record.humanPaused !== undefined && typeof record.humanPaused !== 'boolean')) throw refused('store-invalid', 'Invalid Computer record.')
    if (record.diskProtection !== undefined && (!Number.isFinite(record.diskProtection?.at) || !Number.isSafeInteger(record.diskProtection?.freeBytes) || record.diskProtection.freeBytes < 0)) throw refused('store-invalid', 'Invalid disk protection record.')
    if (record.policy !== undefined) desktopPolicy(record.policy)
    checkId(record.botId)
  }
  if (value.lifecycle !== undefined) {
    if (!value.lifecycle || typeof value.lifecycle !== 'object' || Array.isArray(value.lifecycle)) throw refused('store-invalid', 'Invalid storage recovery journal.')
    for (const [id, item] of Object.entries(value.lifecycle)) {
      if (item?.method === 'configure') desktopPolicy(item.targetPolicy)
      if (item?.computerId !== id || !value.computers[id] || item.generation !== value.computers[id].generation
        || !/^[a-f0-9-]{36}$/.test(item.id) || !Number.isFinite(item.at)
        || !['checkpoint', 'restore', 'upgrade', 'recreate', 'rollback', 'delete-checkpoint', 'delete-home', 'configure', 'portable-import'].includes(item.method)
        || (['checkpoint', 'restore', 'upgrade', 'delete-checkpoint'].includes(item.method) && !/^[a-f0-9-]{36}$/.test(item.checkpointId))
        || (['restore', 'upgrade', 'portable-import', 'rollback', 'delete-home'].includes(item.method) && item.homeRevision !== null && !/^[a-f0-9-]{36}$/.test(item.homeRevision))
        || (['restore', 'upgrade', 'portable-import', 'delete-home'].includes(item.method) && item.homeRevision === (value.computers[id].homeRevision ?? null))
        || (['rollback', 'delete-home'].includes(item.method) && !value.computers[id].previousHomes?.includes(item.homeRevision))
        || (['restore', 'upgrade', 'recreate', 'delete-checkpoint'].includes(item.method) && value.checkpoints?.[item.checkpointId]?.computerId !== id)
        || (item.targetImage !== undefined && !/^sha256:[a-f0-9]{64}$/.test(item.targetImage))
        || (item.method === 'upgrade' && (!item.targetImage || item.targetImage === value.computers[id].runtimeImage))
        || (item.method === 'checkpoint' && value.checkpoints?.[item.checkpointId])
        || (['restore', 'upgrade', 'portable-import'].includes(item.method) && (item.homeRevision === null || value.computers[id].previousHomes?.includes(item.homeRevision)))) {
        throw refused('store-invalid', 'Invalid storage recovery operation.')
      }
    }
  }
  if (value.checkpoints !== undefined) {
    if (!value.checkpoints || typeof value.checkpoints !== 'object' || Array.isArray(value.checkpoints)) throw refused('store-invalid', 'Invalid checkpoint journal.')
    for (const [id, item] of Object.entries(value.checkpoints)) {
      if (item?.id !== id || !/^[a-f0-9-]{36}$/.test(id) || !value.computers[item.computerId]
        || (item.image !== undefined && !/^sha256:[a-f0-9]{64}$/.test(item.image))
        || !/^[a-f0-9]{64}$/.test(item.hash) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 1024 ** 4) {
        throw refused('store-invalid', 'Invalid checkpoint manifest.')
      }
    }
  }
  if (value.handoffs !== undefined) {
    if (!value.handoffs || Array.isArray(value.handoffs) || typeof value.handoffs !== 'object') throw refused('store-invalid', 'Invalid desktop help journal.')
    for (const [id, item] of Object.entries(value.handoffs)) {
      if (item?.id !== id || !/^[a-f0-9]{64}$/.test(id) || !value.computers[item.computerId]
        || value.computers[item.computerId].botId !== item.botId || !Number.isSafeInteger(item.generation)
        || typeof item.sourceSessionId !== 'string' || !Number.isSafeInteger(item.turnId)
        || !['login', 'captcha', 'payment', 'other'].includes(item.reason)
        || typeof item.note !== 'string' || !item.note.trim() || item.note.length > 1000
        || !['pending', 'queued', 'sending', 'unknown', 'delivered', 'cancelled'].includes(item.status)
        || (item.outcome !== undefined && !['done', 'skip'].includes(item.outcome))
        || (['queued', 'sending', 'unknown', 'delivered'].includes(item.status) && (!item.outcome || typeof item.targetSessionId !== 'string'))) {
        throw refused('store-invalid', 'Invalid desktop help record.')
      }
    }
  }
  const owners = new Set()
  for (const record of Object.values(value.computers)) {
    if (!record.archived) {
      if (owners.has(record.botId)) throw refused('store-invalid', 'Duplicate Computer ownership.')
      owners.add(record.botId)
    }
  }
  for (const [id, record] of Object.entries(value.operations)) {
    if (record?.id !== id || !/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(record.hash)
      || !['pending', 'completed', 'unknown', 'rejected', 'partial'].includes(record.outcome)
      || !Number.isInteger(record.completedActions) || record.completedActions < 0 || record.completedActions > 8
      || !Object.hasOwn(value.computers, record.computerId)) throw refused('store-invalid', 'Invalid Computer operation receipt.')
  }
  return value
}

// The enclosing Bot home lock is the single-writer authority. A failed write never
// publishes its draft in memory; every command rechecks that authority.
export function createComputerStore(path, { writable }) {
  let state
  let loading
  let fault
  let writing = Promise.resolve()
  async function load() {
    if (fault) throw refused('store-unavailable', 'A Computer metadata write failed after publication. Restart to reconcile the journal.')
    if (!loading) loading = (async () => {
      try { state = validate(JSON.parse(await readFile(path, 'utf8'))) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        state = empty()
      }
      return state
    })()
    await loading
    return structuredClone(state)
  }
  function update(change) {
    const work = writing.then(async () => {
      await load()
      writable()
      const draft = structuredClone(state)
      const result = change(draft)
      draft.revision += 1
      validate(draft)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(draft)}\n`, { mode: 0o600, flag: 'wx', flush: true })
        writable()
        await rename(temporary, path)
        state = draft
        if (process.platform !== 'win32') {
          try {
            const directory = await open(dirname(path), 'r')
            try { await directory.sync() } finally { await directory.close() }
          } catch (error) {
            fault = error
            throw error
          }
        }
      } finally {
        await rm(temporary, { force: true })
      }
      state = draft
      return structuredClone(result)
    })
    writing = work.catch(() => {})
    return work
  }
  return { load, update, snapshot: () => state ? structuredClone(state) : undefined, flush: () => writing }
}
