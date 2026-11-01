import { checkpointTask } from './checkpoint-task.mjs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { assertVolume, assertHomeImage, quotaArguments } from './boundary.mjs'
import { engineCommand, engineEnvironment } from '../engine.mjs'

export const homeVolume = record => `dsbot-${record.id}-home${record.homeRevision ? `-${record.homeRevision}` : ''}`
export const backupVolume = (record, id) => `dsbot-${record.id}-backup-${id}`
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)

export async function checkpoint(method, value, options, { docker, image, signal, destinationImage = image, executable = 'docker', engine, onProgress }) {
  const record = value.record
  const id = options.checkpointId
  if (!uuid(id) || (method === 'restore' && (!uuid(options.homeRevision) || !/^[a-f0-9]{64}$/.test(options.hash)))) throw new Error('Invalid checkpoint identity.')
  const backup = backupVolume(record, id)
  const destination = method === 'checkpoint' ? backup : homeVolume({ ...record, homeRevision: options.homeRevision })
  const source = method === 'checkpoint' ? value.volume : backup
  const info = JSON.parse((await docker(['volume', 'inspect', source], signal)).stdout)[0]
  assertVolume(info, { ...value, volume: source })
  assertHomeImage(info, record, image)
  if (method === 'restore' && info.Labels?.['org.ds-bot.computer.checkpoint'] !== id) throw new Error('Checkpoint ownership mismatch.')
  if ((await docker(['ps', '-q', '--filter', `volume=${source}`], signal)).stdout.trim()) throw new Error('Stop every container using this home before checkpointing.')
  // A random, nonexistent staging name is essential: Docker volume create reuses existing names.
  try {
    await docker(['volume', 'inspect', destination], signal)
    throw Object.assign(new Error('The staging volume already exists.'), { exists: true })
  } catch (error) {
    if (error.exists || !/no such volume/i.test(error.stderr ?? '')) throw error
  }
  const helper = `dsbot-checkpoint-${randomUUID()}`
  let created = false
  let complete = false
  try {
    await docker(['volume', 'create', '--label', `org.ds-bot.computer.id=${record.id}`,
      '--label', `org.ds-bot.computer.checkpoint=${id}`, '--label', `org.ds-bot.computer.image=${destinationImage}`,
      ...(method === 'restore' ? quotaArguments(record.homeQuotaBytes, engine) : []),
      '--label', `org.ds-bot.computer.storage=${method === 'checkpoint' ? 'checkpoint' : 'staged-home'}`, destination], signal)
    created = true
    const code = await readFile(new URL('./checkpoint.py', import.meta.url), 'utf8')
    const maxBytes = options.maxBytes ?? 20 * 1024 ** 3
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ** 3 || maxBytes > 1024 ** 4) throw new Error('Invalid checkpoint limit.')
    const result = await checkpointTask(executable, engineCommand(engine, ['run', '--rm', '-i', '--name', helper,
      '--read-only', '--user', '1000:1000', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '32',
      '--mount', `type=volume,source=${source},target=/source,readonly`,
      '--mount', `type=volume,source=${destination},target=/home/cua`,
      '--entrypoint', 'python3', image, '-c', code]), {
      operation: method === 'checkpoint' ? 'create' : 'restore', maxBytes, identity: {
        computerId: record.id, botId: record.botId, checkpointId: id, image,
        ...(method === 'restore' ? { hash: options.hash } : {}),
      },
    }, { signal, onProgress, ...(engine ? { env: engineEnvironment(engine) } : {}) })
    complete = true
    return result
  } finally {
    await docker(['rm', '-f', helper]).catch(() => {})
    if (created && !complete) await docker(['volume', 'rm', destination]).catch(() => {})
  }
}

export async function ownedVolume(name, value, docker, signal, { missing = false } = {}) {
  let data
  try { data = JSON.parse((await docker(['volume', 'inspect', name], signal)).stdout)[0] }
  catch (error) { if (missing && /no such volume/i.test(error.stderr ?? '')) return null; throw error }
  assertVolume(data, { ...value, volume: name })
  if ((await docker(['ps', '-aq', '--filter', `volume=${name}`], signal)).stdout.trim()) throw new Error('A container still references this volume.')
  return data
}

export async function cleanup(value, options, docker, signal) {
  const record = value.record
  let name
  if (options.kind === 'checkpoint' && uuid(options.checkpointId)) name = backupVolume(record, options.checkpointId)
  else if (options.kind === 'home' && (options.homeRevision === null || uuid(options.homeRevision))) {
    name = homeVolume({ ...record, homeRevision: options.homeRevision })
    if (!options.staged && !(record.previousHomes ?? []).includes(options.homeRevision)) throw new Error('This home is not retained by this Computer.')
    if (options.staged && (record.previousHomes ?? []).includes(options.homeRevision)) throw new Error('A retained home is not staging storage.')
  } else throw new Error('Invalid storage cleanup target.')
  if (name === value.volume) throw new Error('The current home cannot be deleted.')
  const data = await ownedVolume(name, value, docker, signal, { missing: true })
  if (!data) return { removed: false }
  if (options.kind === 'checkpoint' && data.Labels?.['org.ds-bot.computer.checkpoint'] !== options.checkpointId) throw new Error('Checkpoint identity mismatch.')
  if (options.staged && data.Labels?.['org.ds-bot.computer.storage'] !== 'staged-home') throw new Error('The volume is not managed staging storage.')
  await docker(['volume', 'rm', name], signal)
  return { removed: true }
}

export async function storageUsage(value, { docker, image, signal }) {
  const info = JSON.parse((await docker(['volume', 'inspect', value.volume], signal)).stdout)[0]
  assertVolume(info, value)
  assertHomeImage(info, value.record, image)
  const name = `dsbot-storage-${randomUUID()}`
  const code = await readFile(new URL('./checkpoint.py', import.meta.url), 'utf8')
  try {
    const result = await docker(['run', '--rm', '--name', name, '--read-only', '--user', '1000:1000',
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '32',
      '--mount', `type=volume,source=${value.volume},target=/source,readonly`, '--entrypoint', 'python3', image,
      '-c', `${code.split("if __name__ == '__main__':")[0]}\nprint(json.dumps(usage(Path('/source'))))`], signal)
    return { ...JSON.parse(result.stdout), hardQuota: Boolean(value.record.homeQuotaBytes),
      quotaBytes: value.record.homeQuotaBytes ?? null, quotaScope: value.record.homeQuotaBytes ? 'current-home' : null }
  } finally { await docker(['rm', '-f', name]).catch(() => {}) }
}
