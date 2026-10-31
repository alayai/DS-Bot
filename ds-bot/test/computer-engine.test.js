import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesktop } from '../../computer-runtime/engine.mjs'

test('cancelling an image build terminates its child process and closes inherited output pipes', { timeout: 20000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-build-cancel-'))
  const previous = process.cwd()
  let descendant
  t.after(async () => {
    process.chdir(previous)
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} }
    await rm(home, { recursive: true, force: true })
  })
  await writeFile(join(home, 'build'), `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
require('node:fs').writeFileSync('child.pid', String(child.pid))
process.stdout.write('child-ready')
setInterval(() => {}, 1000)
`)
  process.chdir(home)
  const controller = new AbortController()
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const running = buildDesktop({ executable: process.execPath, endpoint: 'fixture' }, home, 'fixture', {
    signal: controller.signal, log: text => { if (text.includes('child-ready')) ready() },
  })
  const rejected = assert.rejects(running, /cancelled by test/)
  await started
  descendant = Number(await readFile(join(home, 'child.pid'), 'utf8'))
  controller.abort(new Error('cancelled by test'))
  await rejected
  if (process.platform === 'win32') {
    assert.throws(() => process.kill(descendant, 0))
    descendant = undefined
  }
})
