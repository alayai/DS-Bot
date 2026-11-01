// Real React panel, managed setup, public verified release, Broker and guest.
// Creates only an isolated temporary team and its labelled containers/volumes.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createComputerSetup } from '../src/host/computer/setup.js'
import { loadSetupRuntime } from '../src/host/computer/setup-runtime.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'
import { createComputerService } from '../src/host/computer/service.js'
import { releaseFixture } from './computer-release-fixture.mjs'

const root = resolve(import.meta.dirname, '../..')
const image = process.env.CUA_TEST_IMAGE
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const require = createRequire(join(resolve(process.env.CUA_BROWSER_DEPS), 'package.json'))
const { chromium } = require('playwright-core')
const run = promisify(execFile)
async function until(read, timeout = 180_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await read()) return; await delay(250) }
  throw new Error('The desktop task did not settle.')
}
const home = await mkdtemp(join(tmpdir(), '.dsh-test-cua-storage-'))
const rt = { home, config: {}, load: async () => {}, readOnly: () => undefined,
  botOf: id => id === 'storage-test' ? { id } : null }
let runtimeTools
const setup = createComputerSetup(rt, async config => { rt.computer ??= createComputerService(rt, createBrokerProvider(config)) },
  { runtime: async () => runtimeTools })
let browser, page, server, record, downloaded
const errors = []
const tools = await loadSetupRuntime()
const engine = await tools.discover()
try {
  runtimeTools = process.env.CUA_TEST_CANDIDATE_IMAGE
    ? await releaseFixture(home, process.env.CUA_TEST_CANDIDATE_IMAGE, tools) : tools
  await mkdir(join(home, 'computers'))
  await writeFile(join(home, 'computers/setup.json'), JSON.stringify({ version: 1,
    config: { engine, image, recipe: tools.recipe } }))
  await setup.restore()
  const service = rt.computer
  record = await service.bind({ botId: 'storage-test', grant: 'observe', expectedRevision: 0 })
  await service.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  const container = `dsbot-${record.id}`
  await run('docker', ['exec', container, 'python3', '-c',
    'from pathlib import Path;p=Path("/home/cua/DSBot");p.mkdir(exist_ok=True)\nwith open(p/"large.bin","wb") as f:\n for i in range(256): f.write(bytes([i])*1024**2)\n(p/"marker.txt").write_text("before")'], { timeout: 60000 })
  const digest = async () => (await run('docker', ['exec', container, 'sha256sum', '/home/cua/DSBot/large.bin'])).stdout.split(' ')[0]
  const originalHash = await digest()
  const bundle = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {ComputerView,COMPUTER_CSS} from './src/client/computer-pane.js';
const style=document.createElement('style');style.textContent=COMPUTER_CSS;document.head.append(style);
const actions={computerCall:async(method,args)=>{const r=await fetch('/control',{method:'POST',body:JSON.stringify({method,args})});const v=await r.json();if(v.error)throw Object.assign(new Error(v.error),{code:v.code});return v}};
createRoot(document.getElementById('root')).render(React.createElement(ComputerView,{bot:{id:'storage-test'},actions}));`,
      resolveDir: join(root, 'ds-bot'), loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { react: require.resolve('react'), 'react-dom/client': require.resolve('react-dom/client') },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<style>:root{--bt-ink:#222;--bt-card:#fff;--bt-line:#ccc;--bt-main:#fff}#root{width:900px}</style><div id="root"></div><script src="/test.js"></script>'); return }
      if (req.url === '/test.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
      // Streaming is covered by the dedicated viewer smoke; use snapshots here.
      if (req.url !== '/control') { res.writeHead(404).end(); return }
      const chunks = []
      let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('Request too large'); chunks.push(chunk) }
      const { method, args } = JSON.parse(Buffer.concat(chunks))
      const value = method.startsWith('image-') ? await setup.updates[method.slice(6)](args)
        : method === 'state' ? await service.state()
          : method === 'storage-start' ? await service.storageStart(args)
            : method === 'storage-cancel' ? await service.storageCancel(args)
              : method === 'rollback' || method === 'recover' ? await service.storage(method, args)
                : method === 'preview' ? await service.preview(args) : await service.manage(method, args)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    } catch (error) { res.end(JSON.stringify({ error: error.message, code: error.code })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CUA_CHROME, args: ['--no-sandbox'] })
  page = await browser.newPage({ locale: 'en-US' })
  page.setDefaultTimeout(180_000)
  process.once('SIGTERM', () => { void browser.close() })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: 'Stop desktop', exact: true }).click()
  await page.getByRole('button', { name: 'Save checkpoint', exact: true }).click()
  await page.reload()
  await page.getByText('Storage task completed', { exact: true }).waitFor()
  let state = await service.state()
  assert.ok(state.checkpoints[0].bytes >= 256 * 1024 ** 2)
  console.log('PASS: 256 MiB checkpoint completes in the background and survives panel reload')
  await page.getByRole('button', { name: 'Start desktop', exact: true }).click()
  await page.getByText('Running', { exact: true }).waitFor()
  await run('docker', ['exec', container, 'python3', '-c',
    'from pathlib import Path;Path("/home/cua/DSBot/marker.txt").write_text("after")'])
  await page.getByRole('button', { name: 'Stop desktop', exact: true }).click()
  const previousJob = state.computers[0].storageJob.id
  await page.getByRole('button', { name: 'Restore checkpoint', exact: true }).click()
  await until(async () => {
    const v = await service.state()
    return v.computers[0].storageJob?.id !== previousJob && v.computers[0].storageJob?.status === 'completed'
  })
  await page.getByRole('button', { name: 'Start desktop', exact: true }).click()
  await page.getByText('Running', { exact: true }).waitFor()
  assert.equal(await digest(), originalHash)
  assert.equal((await run('docker', ['exec', container, 'cat', '/home/cua/DSBot/marker.txt'])).stdout, 'before')
  console.log('PASS: restored large file SHA-256 matches; the original home is retained')
  await page.getByText('Desktop image updates', { exact: true }).click()
  await page.getByRole('button', { name: 'Check for image updates', exact: true }).click()
  await page.getByText('A verified image is available', { exact: true }).waitFor()
  const candidate = (await setup.updates.state()).job.candidate
  let existed = false
  try { await run('docker', ['image', 'inspect', candidate.image]); existed = true } catch {}
  if (!existed) downloaded = candidate.image
  const checkedJob = (await setup.updates.state()).job.id
  await page.getByRole('button', { name: 'Download and verify image', exact: true }).click()
  await until(async () => {
    const value = await setup.updates.state()
    return value.job?.id !== checkedJob && !value.busy
  }, 45 * 60_000)
  assert.equal((await setup.updates.state()).job.phase, 'prepared', (await setup.updates.state()).job.error)
  state = await service.state()
  assert.equal(state.computers[0].runtimeImage, image)
  assert.equal(state.computers[0].phase, 'ready')
  assert.ok(state.images.includes(candidate.image))
  console.log(`PASS: ${process.env.CUA_TEST_CANDIDATE_IMAGE ? 'local release fixture' : 'public release'} downloaded, verified and registered while the old desktop keeps running`)
  await page.getByRole('button', { name: 'Stop desktop', exact: true }).click()
  await page.getByLabel('Desktop image', { exact: true }).selectOption(candidate.image)
  const oldGeneration = (await service.state()).computers[0].generation
  await page.getByRole('button', { name: 'Upgrade desktop', exact: true }).click()
  assert.equal((await service.state()).computers[0].generation, oldGeneration)
  await page.getByRole('button', { name: 'Confirm upgrade', exact: true }).click()
  await until(async () => {
    const v = await service.state()
    return v.computers[0].generation > oldGeneration && v.computers[0].storageJob?.status === 'completed'
  })
  await page.getByRole('button', { name: 'Start desktop', exact: true }).click()
  await page.getByText('Running', { exact: true }).waitFor()
  assert.equal(await digest(), originalHash)
  state = await service.state()
  assert.equal(state.computers[0].runtimeImage, candidate.image)
  await page.getByRole('button', { name: 'Stop desktop', exact: true }).click()
  await page.getByRole('button', { name: 'Switch to this home', exact: true }).last().click()
  await page.getByRole('button', { name: 'Start desktop', exact: true }).click()
  await page.getByText('Running', { exact: true }).waitFor()
  assert.equal((await service.state()).computers[0].runtimeImage, image)
  assert.equal(await digest(), originalHash)
  assert.deepEqual(errors, [])
  console.log('PASS: confirmed upgrade and rollback preserve the 256 MiB file and paired image/home; no browser exceptions')
} catch (error) {
  if (page) console.error('Panel state:', await page.locator('[role=alert],[role=status]').allTextContents())
  console.error('Setup update:', await setup.updates.state().catch(() => null))
  throw error
} finally {
  await browser?.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await setup.dispose()
  await rt.computer?.dispose()
  if (record) {
    await run('docker', ['rm', '-f', `dsbot-${record.id}`]).catch(() => {})
    const registry = JSON.parse(await readFile(join(home, 'computers/registry.json'), 'utf8'))
    const stored = registry.computers[record.id]
    const volumes = new Set([`dsbot-${record.id}-home`, ...[stored.homeRevision, ...(stored.previousHomes ?? [])].filter(Boolean).map(id => `dsbot-${record.id}-home-${id}`),
      ...Object.keys(registry.checkpoints ?? {}).map(id => `dsbot-${record.id}-backup-${id}`)])
    const pending = registry.lifecycle?.[record.id]
    if (pending?.homeRevision) volumes.add(`dsbot-${record.id}-home-${pending.homeRevision}`)
    if (pending?.checkpointId) volumes.add(`dsbot-${record.id}-backup-${pending.checkpointId}`)
    for (const volume of volumes) await run('docker', ['volume', 'rm', volume]).catch(() => {})
  }
  if (downloaded) await run('docker', ['image', 'rm', downloaded]).catch(() => {})
  await rm(home, { recursive: true, force: true })
}
