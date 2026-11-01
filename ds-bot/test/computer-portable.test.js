import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createPortableBackups } from '../src/host/computer/portable.js'
async function fixture(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsbot-portable-test-'))
  const deps = { directory, ready: async () => {}, assigned: async () => ({ botId: 'a', generation: 1 }), run,
    limits: () => ({ checkpointMaxBytes: 1024 ** 3 }), supported: () => true }
  const manager = createPortableBackups(deps)
  t.after(async () => { await manager.dispose(); await rm(directory, { force: true, recursive: true }) })
  return { manager, deps, directory, cmd: (method, args = {}) => manager.command(method, { botId: 'a', expectedGeneration: 1, ...args }) }
}
test('portable upload enforces ordered bounded chunks, ownership and explicit import', async t => {
  let copied
  const h = await fixture(t, async (method, args, task) => { assert.equal(method, 'portable-import'); copied = await readFile(task.portablePath) })
  const { job } = await h.cmd('upload', { bytes: 32 })
  await assert.rejects(h.cmd('write', { id: job.id, offset: 1, data: Buffer.alloc(32).toString('base64') }), /order/)
  await assert.rejects(h.cmd('cancel', { id: job.id, botId: 'b' }), /changed/)
  await h.cmd('write', { id: job.id, offset: 0, data: Buffer.alloc(32, 7).toString('base64') })
  await assert.rejects(h.cmd('write', { id: job.id, offset: 0, data: 'AA==' }), /order/)
  await assert.rejects(h.cmd('import', { id: job.id }), /confirm/)
  await h.cmd('import', { id: job.id, confirm: true })
  for (let i = 0; i < 100 && (await h.manager.state()).busy; i++) await delay(5)
  assert.equal((await h.manager.state()).job.status, 'completed'); assert.deepEqual(copied, Buffer.alloc(32, 7))
})
test('interrupted uploads cannot be silently resumed with unpersisted offsets', async t => {
  const h = await fixture(t, async () => {})
  const { job } = await h.cmd('upload', { bytes: 64 })
  await h.cmd('write', { id: job.id, offset: 0, data: Buffer.alloc(32).toString('base64') })
  const next = createPortableBackups(h.deps); t.after(() => next.dispose())
  assert.equal((await next.state()).job.status, 'interrupted')
  await assert.rejects(next.command('write', { botId: 'a', id: job.id, offset: 0, data: 'AA==' }), /order/)
})
test('export is read in bounded chunks and cancellation discards only its own temporary file', async t => {
  const h = await fixture(t, async (_method, _args, task) => { await writeFile(task.portablePath, Buffer.alloc(300000, 5)); return { bytes: 300000, sha256: 'a'.repeat(64) } })
  const { job } = await h.cmd('export')
  for (let i = 0; i < 100 && (await h.manager.state()).busy; i++) await delay(5)
  const chunk = await h.cmd('read', { id: job.id, offset: 0 }); assert.equal(chunk.offset, 256 * 1024)
  assert.equal(Buffer.from(chunk.data, 'base64').length, 256 * 1024)
  await h.cmd('cancel', { id: job.id }); assert.equal((await h.manager.state()).job, null)
})

test('export admission uses measured home size and rejects a home above the limit before starting', async t => {
  const h = await fixture(t, async () => assert.fail('Oversized home must not be exported'))
  const manager = createPortableBackups({ ...h.deps, measure: async () => 2 * 1024 ** 3 }); t.after(() => manager.dispose())
  await assert.rejects(manager.command('export', { botId: 'a', expectedGeneration: 1 }), /exceeds/)
  assert.equal((await manager.state()).job, null)
})
