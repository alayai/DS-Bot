import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fork } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { benchOptions, packageSource, checkPort, BenchProcesses } from '../dev/bench-support.mjs'

test('bench rejects traversal, real-service ports, shared ports and unknown modes', () => {
  for (const args of [['../user'], ['bothub-a', '3080'], ['bothub-a', '3001', '3001'], ['bothub-a', 'NaN'], ['bothub-a', '3001', '3002', 'reset']]) {
    assert.throws(() => benchOptions(tmpdir(), args))
  }
  assert.equal(benchOptions(tmpdir(), ['bothub-test']).home, join(tmpdir(), '.dsh-test-bothub-test'))
})

test('archives accept native absolute paths with spaces and Unicode, reject relative paths and directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bothub-包 '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = join(root, 'test package.tgz')
  await writeFile(archive, 'fixture')
  assert.equal(await packageSource(archive, root), `file:${archive.replaceAll('\\', '/')}`)
  await assert.rejects(packageSource('relative.tgz', root), /absolute/)
  await assert.rejects(packageSource(root, root), /absolute/)
})

test('occupied ports are refused without disturbing the existing server', async t => {
  const server = createServer(socket => socket.end('sentinel'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await assert.rejects(checkPort(server.address().port), { code: 'EADDRINUSE' })
  assert.equal(server.listening, true)
})

test('target exit codes remain failures', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bothub-exit-'))
  const owned = new BenchProcesses()
  t.after(async () => { await owned.stop(); await rm(root, { recursive: true, force: true }) })
  const item = await owned.start(process.execPath, ['-e', 'process.exit(7)'], { cwd: root, env: process.env, log: join(root, 'exit.log') })
  await assert.rejects(owned.wait(item, 5000), /7/)
  if (process.platform === 'win32') assert.equal(item.result.jobAssigned, true)
})

test('cleanup errors are surfaced to the caller', { timeout: 30000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows Job Object failure paths'); return }
  const root = await mkdtemp(join(tmpdir(), 'bothub-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  for (const phase of ['create', 'assign', 'cleanup']) {
    const preload = join(root, phase + '.cjs')
    const from = phase === 'create' ? '[DshBenchJob]::NewJob()' : phase === 'assign'
      ? 'if(!AssignProcessToJobObject(job,pi.Process))' : '[DshBenchJob]::Stop($job)'
    const to = phase === 'create' ? '[IntPtr]::Zero' : phase === 'assign'
      ? 'if(job != IntPtr.Zero)' : "throw 'INJECTED cleanup access denied'"
    await writeFile(preload, 'const cp=require("node:child_process");const original=cp.spawn;cp.spawn=function(file,args,options){if(file==="powershell.exe"){args=[...args];args[args.length-1]=args.at(-1).replace('+JSON.stringify(from)+','+JSON.stringify(to)+')}return original.call(this,file,args,options)}')
    const owned = new BenchProcesses()
    try {
      const item = await owned.start(process.execPath, ['-e', 'require("node:fs").writeFileSync('+JSON.stringify(phase+'.ran')+',"ran");process.exit(0)'], {
        cwd: root, env: { ...process.env, NODE_OPTIONS: '--require='+JSON.stringify(preload) }, log: join(root, phase+'.log'),
      })
      if (phase === 'cleanup') {
        await owned.wait(item, 5000)
        await assert.rejects(owned.stop(), /Could not clean detached bench descendants/)
        await assert.rejects(owned.stop(), /Could not clean detached bench descendants/)
      } else {
        await assert.rejects(owned.wait(item, 5000), /JOB/)
        await assert.rejects(readFile(join(root, phase+'.ran')), { code: 'ENOENT' })
        await owned.stop()
      }
    } finally { await owned.stop().catch(() => {}) }
  }
})

test('failed spawn, timeout and cancellation settle and clean up only owned process trees', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bothub-process-'))
  const owned = new BenchProcesses(), sentinel = new BenchProcesses()
  t.after(async () => {
    try { await owned.stop() } finally { await sentinel.stop() }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const options = name => ({ cwd: root, env: process.env, log: join(root, `${name}.log`) })
  const missing = await owned.start(join(root, 'missing-executable'), [], options('missing'))
  await assert.rejects(owned.wait(missing, 5000), /ENOENT/)
  const other = await sentinel.start(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], options('sentinel'))
  await sentinel.ready(other, options('sentinel').log, 'ready', 5000)
  const child = await owned.start(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});
    require('node:fs').writeFileSync('descendant.pid',String(child.pid));
    console.log('ready');setInterval(()=>{},1000);
  `], options('owned'))
  await owned.ready(child, options('owned').log, 'ready', 5000)
  const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'))
  await assert.rejects(owned.wait(child, 30), /timed out/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(owned.wait(child, 2000, abort.signal), /interrupted/)
  const exits = await owned.start(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});
    require('node:fs').writeFileSync('exited-descendant.pid',String(child.pid));
    setTimeout(()=>process.exit(0),100);
  `], options('exits'))
  await owned.wait(exits, 5000)
  assert.equal(exits.ended, false, 'supervisor stays alive after target exit for tree cleanup')
  const exitedPid = Number(await readFile(join(root, 'exited-descendant.pid'), 'utf8'))
  const firstStop = owned.stop()
  assert.strictEqual(owned.stop(), firstStop)
  await firstStop
  assert.strictEqual(owned.stop(), firstStop)
  assert.equal(child.ended, true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.throws(() => process.kill(exitedPid, 0), { code: 'ESRCH' })
  assert.equal(other.ended, false)
  assert.doesNotThrow(() => process.kill(other.child.pid, 0))
})

for (const failure of ['disconnect', 'SIGKILL', 'SIGHUP']) {
  test(`POSIX supervisor cleans its process group after parent ${failure}`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bothub-parent-'))
    const sentinel = new BenchProcesses()
    let parent, supervisorPid
    t.after(async () => {
      if (parent?.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
      if (supervisorPid) { try { process.kill(-supervisorPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
      await sentinel.stop()
      await rm(root, { recursive: true, force: true })
    })
    const options = name => ({ cwd: root, env: process.env, log: join(root, `${name}.log`) })
    const other = await sentinel.start(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], options('sentinel'))
    await sentinel.ready(other, options('sentinel').log, 'ready', 5000)
    const fixture = join(root, 'parent.mjs')
    await writeFile(fixture, `
      import { BenchProcesses } from ${JSON.stringify(new URL('../dev/bench-support.mjs', import.meta.url).href)}
      const owned = new BenchProcesses()
      const item = await owned.start(process.execPath, ['-e', ${JSON.stringify(`
        const { spawn } = require('node:child_process')
        const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
        require('node:fs').writeFileSync('descendants.json', JSON.stringify([process.pid, descendant.pid]))
        console.log('ready'); setInterval(()=>{},1000)
      `)}], { cwd: ${JSON.stringify(root)}, env: process.env, log: ${JSON.stringify(join(root, 'owned.log'))} })
      await owned.ready(item, ${JSON.stringify(join(root, 'owned.log'))}, 'ready', 5000)
      process.on('message', () => item.child.disconnect())
      process.send({ supervisor: item.child.pid })
    `)
    parent = fork(fixture, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const parentExit = new Promise(resolve => parent.once('exit', resolve))
    supervisorPid = await new Promise((resolve, reject) => {
      parent.once('message', message => resolve(message.supervisor))
      parent.once('error', reject)
      parent.once('exit', () => reject(new Error('Parent exited before starting its process group')))
    })
    const descendants = JSON.parse(await readFile(join(root, 'descendants.json'), 'utf8'))
    if (failure === 'disconnect') parent.send('disconnect')
    else parent.kill(failure)
    // A killed child may briefly be a zombie until its new parent reaps it.
    const running = async pid => {
      try {
        process.kill(pid, 0)
        if (process.platform === 'linux') return !/^.*\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))
        return true
      } catch (error) {
        if (['ESRCH', 'ENOENT'].includes(error.code)) return false
        throw error
      }
    }
    const deadline = Date.now() + 5000
    let alive
    do {
      alive = await Promise.all([supervisorPid, ...descendants].map(running))
      if (alive.every(value => !value)) break
      await delay(20)
    } while (Date.now() < deadline)
    assert.ok(alive.every(value => !value), 'supervisor, target and descendants stop after parent loss')
    if (failure === 'disconnect') { parent.disconnect(); await parentExit }
    assert.equal(other.ended, false)
    assert.doesNotThrow(() => process.kill(other.child.pid, 0))
  })
}
