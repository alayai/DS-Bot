import { randomUUID } from 'node:crypto'
import { refused } from './contract.js'
import { STORAGE_METHODS } from './lifecycle.js'

export function createStorageJobs({ ready, assigned, run, now = Date.now }) {
  const jobs = new Map()
  let closed = false
  const view = botId => jobs.get(botId)?.state ?? null
  async function start({ method, ...args }) {
    await ready()
    if (closed) throw refused('unavailable', 'Desktop storage is stopping.')
    if (!STORAGE_METHODS.includes(method) || method.startsWith('portable-')) throw refused('invalid', 'Unknown storage operation.')
    const record = await assigned(args.botId)
    if (closed) throw refused('unavailable', 'Desktop storage is stopping.')
    if (record.generation !== args.expectedGeneration) throw refused('stale-generation', 'Refresh before changing desktop storage.')
    if (jobs.get(args.botId)?.done) throw refused('busy', 'A storage task is already running.')
    const controller = new AbortController()
    const entry = { controller, state: { id: randomUUID(), method, status: 'running', at: now(), progress: null } }
    jobs.set(args.botId, entry)
    entry.done = run(method, args, {
      signal: controller.signal,
      onProgress: progress => { entry.state = { ...entry.state, progress } },
    }).then(() => {
      entry.state = { ...entry.state, status: 'completed', finishedAt: now() }
    }, error => {
      entry.state = { ...entry.state, status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: String(error.message ?? 'Storage task failed.').slice(0, 500), finishedAt: now() }
    }).finally(() => { entry.done = null })
    return { ...entry.state }
  }
  async function cancel({ botId, jobId }) {
    await ready()
    const entry = jobs.get(botId)
    if (!entry || jobId !== entry.state.id) throw refused('conflict', 'The storage task changed. Refresh before cancelling.')
    if (entry.done) {
      entry.state = { ...entry.state, status: 'cancelling' }
      entry.controller.abort()
    }
    return { ...entry.state }
  }
  async function dispose() {
    closed = true
    for (const entry of jobs.values()) entry.controller.abort()
    await Promise.allSettled([...jobs.values()].map(entry => entry.done))
  }
  return { start, cancel, view, dispose }
}
