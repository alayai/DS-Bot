import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile, rename, rm, statfs } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { refused } from './contract.js'
const CHUNK = 256 * 1024
export function createPortableBackups({ directory, ready, assigned, run, limits, supported, measure }) {
  let loaded, job = null, active, writing = false, closed = false
  const metadata = join(directory, 'job.json')
  const path = id => join(directory, `${id}.dsbackup`)
  async function load() {
    await ready()
    if (closed || !supported()) throw refused('unavailable', 'Portable backups require the native desktop runtime.')
    loaded ??= (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        const text = await readFile(metadata, 'utf8')
        if (text.length > 16000) throw Error('Invalid backup state.')
        const saved = JSON.parse(text)
        if (saved && (!/^[a-f0-9-]{36}$/.test(saved.id) || typeof saved.botId !== 'string' || !/^[\w-]{1,160}$/.test(saved.botId) || !Number.isSafeInteger(saved.generation) || saved.generation < 1
          || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0 || saved.bytes > 1024 ** 4 + 64 * 1024 ** 2 + 32
          || !Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > saved.bytes || !['exporting','uploading','importing','ready','completed','interrupted','failed','cancelled'].includes(saved.status))) throw Error('Invalid backup state.')
        job = saved
        if (job && ['exporting','uploading','importing'].includes(job.status)) { job.status = 'interrupted'; await save() }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    })()
    await loaded
  }
  async function save() {
    const temp = `${metadata}.${randomUUID()}.tmp`
    try { await writeFile(temp, JSON.stringify(job), { flag: 'wx', mode: 0o600, flush: true }); await rename(temp, metadata) }
    finally { await rm(temp, { force: true }) }
  }
  function view() { return { supported: supported(), job: job ? { ...job } : null, busy: Boolean(active || writing), chunkSize: CHUNK } }
  async function hashFile() {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path(job.id))) hash.update(chunk)
    return hash.digest('hex')
  }
  async function state() { if (!supported()) return view(); await load(); return view() }
  async function command(method, args) {
    await load()
    if (writing) throw refused('busy', 'A backup request is still settling.')
    writing = true
    try {
      if (method === 'cancel') {
        if (!job || args.id !== job.id || args.botId !== job.botId) throw refused('conflict', 'The backup changed.')
        if (active) { active.controller.abort(); return view() }
        await rm(path(job.id), { force: true }); job = null; await save(); return view()
      }
      if (active) throw refused('busy', 'A portable backup is still running.')
      if (['export', 'upload'].includes(method)) {
        if (job) throw refused('busy', 'Discard the previous portable backup before starting another.')
        const record = await assigned(args.botId)
        if (record.generation !== args.expectedGeneration) throw refused('stale-generation', 'Refresh the desktop before transferring a backup.')
        const max = limits().checkpointMaxBytes + 64 * 1024 ** 2 + 32
        if (method === 'upload' && (!Number.isSafeInteger(args.bytes) || args.bytes < 32 || args.bytes > max)) throw refused('invalid', 'The backup exceeds the configured size limit.')
        const estimated = method === 'export' && measure ? await measure(record) : limits().checkpointMaxBytes
        if (method === 'export' && (!Number.isSafeInteger(estimated) || estimated < 0 || estimated > limits().checkpointMaxBytes)) throw refused('resource-limit', 'The home exceeds the configured backup limit.')
        const space = await statfs(directory)
        if (space.bavail * space.bsize < (method === 'upload' ? args.bytes : estimated + 64 * 1024 ** 2) + 256 * 1024 ** 2) throw refused('resource-limit', 'Free host disk space before transferring this backup.')
        job = { id: randomUUID(), botId: record.botId, generation: record.generation, status: method === 'export' ? 'exporting' : 'uploading', bytes: method === 'upload' ? args.bytes : 0, offset: 0 }
        if (method === 'upload') { const file = await open(path(job.id), 'wx', 0o600); await file.close() }
        await save()
        if (method === 'export') start('portable-export')
        return view()
      }
      if (!job || args.id !== job.id || args.botId !== job.botId) throw refused('conflict', 'The portable backup changed.')
      if (method === 'write') {
        if (job.status !== 'uploading' || args.offset !== job.offset || typeof args.data !== 'string' || args.data.length > Math.ceil(CHUNK / 3) * 4) throw refused('invalid', 'Invalid backup chunk order.')
        const data = Buffer.from(args.data, 'base64')
        if (!data.length || data.length > CHUNK || data.toString('base64') !== args.data || job.offset + data.length > job.bytes) throw refused('invalid', 'Invalid backup chunk.')
        const file = await open(path(job.id), 'a')
        try { if ((await file.stat()).size !== job.offset) throw refused('invalid', 'The partial backup changed. Discard it and upload again.'); await file.writeFile(data) } finally { await file.close() }
        job.offset += data.length
      } else if (method === 'import') {
        if (job.status !== 'uploading' || job.offset !== job.bytes || args.confirm !== true) throw refused('invalid', 'Complete the upload and confirm replacing this home.')
        job.sha256 = await hashFile(); job.status = 'importing'; await save(); start('portable-import')
      } else if (method === 'read') {
        if (job.status !== 'ready' || !Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset >= job.bytes) throw refused('invalid', 'This backup is not ready to download.')
        const file = await open(path(job.id), 'r'), data = Buffer.alloc(Math.min(CHUNK, job.bytes - args.offset))
        try { const read = await file.read(data, 0, data.length, args.offset); if (!read.bytesRead) throw refused('invalid', 'The backup file is truncated.'); return { data: data.subarray(0, read.bytesRead).toString('base64'), offset: args.offset + read.bytesRead } }
        finally { await file.close() }
      } else throw refused('invalid', 'Unknown portable backup operation.')
      return view()
    } finally { writing = false }
  }
  function start(method) {
    const controller = new AbortController(), current = job
    const entry = { controller }; active = entry
    entry.done = run(method, { botId: current.botId, expectedGeneration: current.generation }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65 * 60_000)]), portablePath: path(current.id) }).then(async result => {
      job = { ...current, ...(method === 'portable-export' ? result : {}), status: method === 'portable-export' ? 'ready' : 'completed' }
      if (method === 'portable-import') await rm(path(current.id), { force: true })
      await save()
    }).catch(async error => { job = { ...current, status: controller.signal.aborted ? 'cancelled' : 'failed', error: String(error.message).slice(0, 500) }; await save() }).catch(() => {}).finally(() => { active = null })
  }
  async function dispose() { closed = true; active?.controller.abort(); await active?.done }
  return { state, command, dispose }
}
