// Isolated real engine and React panel. No model requests or user desktop mutations.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { createComputerSetup } from '../src/host/computer/setup.js'
import { loadSetupRuntime } from '../src/host/computer/setup-runtime.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'
import { createComputerService } from '../src/host/computer/service.js'

const root = resolve(import.meta.dirname, '../..'), run = promisify(execFile)
const image = process.env.CUA_TEST_IMAGE
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const require = createRequire(join(resolve(process.env.CUA_BROWSER_DEPS), 'package.json'))
const { chromium } = require('playwright-core')
const home = await mkdtemp(join(tmpdir(), '.dsh-test-cua-cleanup-'))
const rt = { home, config: {}, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'cleanup-test' ? { id } : null }
let browser, server, record, candidate, orphan, container
const imageContainer = `dsbot-cleanup-image-${randomUUID()}`
const errors = [], deleted = []
const setup = createComputerSetup(rt, async config => { rt.computer ??= createComputerService(rt, createBrokerProvider(config)) })
try {
  const tools = await loadSetupRuntime(), engine = await tools.discover()
  await run('docker', ['create', '--name', imageContainer, image])
  candidate = (await run('docker', ['commit', '--change', `LABEL org.ds-bot.cleanup-test=${randomUUID()}`, imageContainer])).stdout.trim()
  await run('docker', ['rm', imageContainer])
  assert.notEqual(candidate, image)
  await mkdir(join(home, 'computers'))
  await writeFile(join(home, 'computers/setup.json'), JSON.stringify({ version: 1, config: { engine, image, images: [candidate], recipe: tools.recipe } }))
  await setup.restore()
  record = await rt.computer.bind({ botId: 'cleanup-test', grant: 'observe', expectedRevision: 0 })
  await rt.computer.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  container = `dsbot-${record.id}`
  await run('docker', ['exec', container, 'sh', '-c', 'echo cleanup-marker > /home/cua/cleanup-marker'])
  orphan = `dsbot-${record.id}-home-${randomUUID()}`
  await run('docker', ['volume', 'create', '--label', `org.ds-bot.computer.id=${record.id}`, '--label', `org.ds-bot.computer.image=${candidate}`, orphan])
  const output = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {ComputerUpdates} from './src/client/computer-updates.js';
const call=async(method,args)=>{const response=await fetch('/control',{method:'POST',body:JSON.stringify({method,args})});const value=await response.json();if(value.error)throw Error(value.error);return value};
createRoot(document.getElementById('root')).render(React.createElement(ComputerUpdates,{call}));`, resolveDir: join(root, 'ds-bot'), loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { react: require.resolve('react'), 'react-dom/client': require.resolve('react-dom/client') }, define: { 'process.env.NODE_ENV': '"production"' },
  })
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script src="/test.js"></script>'); return }
      if (req.url === '/test.js') { res.setHeader('content-type', 'text/javascript'); res.end(output.outputFiles[0].text); return }
      if (req.url !== '/control') { res.writeHead(404).end(); return }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const { method, args } = JSON.parse(Buffer.concat(chunks))
      const methods = { 'image-state': 'state', 'image-cleanup-scan': 'scan', 'image-cleanup-remove': 'remove' }
      assert.ok(methods[method])
      const value = await setup.updates[methods[method]](args)
      if (method === 'image-cleanup-remove') deleted.push(args.id)
      if (method === 'image-cleanup-scan') console.log('Test candidate:', value.cleanup?.items.find(item => item.id === candidate))
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
    } catch (error) { console.error('Control request failed:', error.message); res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CUA_CHROME, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'en-US' })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('Desktop image updates', { exact: true }).click()
  await page.getByText('Desktop storage cleanup', { exact: true }).click()
  await page.getByRole('button', { name: 'Scan unused resources', exact: true }).click()
  const volumeRow = page.locator('div.bt-computer-help').filter({ has: page.getByText(`Storage volume: ${orphan}`, { exact: true }) })
  const imageRow = page.locator('div.bt-computer-help').filter({ has: page.getByText(`Image: ${candidate}`, { exact: true }) })
  await imageRow.getByText('Referenced by desktop storage', { exact: true }).waitFor().catch(async error => { console.log('Panel text:', await page.locator('body').innerText()); throw error })
  assert.equal(await imageRow.getByRole('button', { name: 'Delete unused resource', exact: true }).count(), 0)
  await volumeRow.getByRole('button', { name: 'Delete unused resource', exact: true }).click()
  await volumeRow.getByRole('button', { name: 'Confirm deletion', exact: true }).click()
  await volumeRow.waitFor({ state: 'detached' })
  const result = (await setup.updates.state()).cleanup.items.find(item => item.id === candidate)
  if (result.removable) {
    await imageRow.getByRole('button', { name: 'Delete unused resource', exact: true }).click()
    await imageRow.getByRole('button', { name: 'Confirm deletion', exact: true }).click()
    await imageRow.waitFor({ state: 'detached' })
    assert.deepEqual(deleted, [orphan, candidate])
    await assert.rejects(run('docker', ['image', 'inspect', candidate]))
    assert.deepEqual(JSON.parse(await readFile(join(home, 'computers/setup.json'))).config.images, [])
    console.log('PASS: unused image deleted and saved pin removed')
  } else {
    assert.equal(result.reason, 'Storage image identity is unknown')
    await imageRow.getByText(result.reason, { exact: true }).waitFor()
    assert.equal(await imageRow.getByRole('button', { name: 'Delete unused resource', exact: true }).count(), 0)
    assert.deepEqual(deleted, [orphan])
    console.log('PASS: pre-existing foreign storage with unknown image identity blocks image deletion; user storage remains untouched')
  }
  await assert.rejects(run('docker', ['volume', 'inspect', orphan]))
  assert.equal((await run('docker', ['exec', container, 'cat', '/home/cua/cleanup-marker'])).stdout.trim(), 'cleanup-marker')
  assert.equal((await rt.computer.state()).computers[0].phase, 'ready')
  assert.deepEqual(errors, [])
  console.log('PASS: real React scan and confirmation delete the test orphan; running desktop and marker remain intact')
  await page.reload()
  await page.getByText('Desktop image updates', { exact: true }).click()
  await page.getByText('Desktop storage cleanup', { exact: true }).click()
  await page.getByRole('button', { name: 'Scan unused resources', exact: true }).click()
  await page.getByText(`Image: ${image}`, { exact: true }).waitFor()
  assert.equal(await page.getByText(`Storage volume: ${orphan}`, { exact: true }).count(), 0)
  console.log('PASS: reopening panel preserves the cleanup result')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await setup.dispose()
  await rt.computer?.dispose()
  if (record) {
    await run('docker', ['rm', '-f', `dsbot-${record.id}`]).catch(() => {})
    await run('docker', ['volume', 'rm', `dsbot-${record.id}-home`]).catch(() => {})
  }
  if (orphan) await run('docker', ['volume', 'rm', orphan]).catch(() => {})
  await run('docker', ['rm', '-f', imageContainer]).catch(() => {})
  if (candidate) await run('docker', ['image', 'rm', candidate]).catch(() => {})
  await rm(home, { recursive: true, force: true })
}
