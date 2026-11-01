// Real panel + Browser File APIs + Host + Broker + guest filesystem.
// All data and containers belong to this isolated fixture.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, open, stat, rm, readFile, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'
import { createComputerService } from '../src/host/computer/service.js'
import { registerComputerViewer } from '../src/host/computer/viewer.js'

const root = resolve(import.meta.dirname, '../..')
const image = process.env.CUA_TEST_IMAGE
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const require = createRequire(join(resolve(process.env.CUA_BROWSER_DEPS), 'package.json'))
const { chromium } = require('playwright-core')
const run = promisify(execFile)
const fileSize = Number(process.env.CUA_TEST_FILE_BYTES ?? 1024 * 1024 + 31)
assert.ok(Number.isSafeInteger(fileSize) && fileSize > 0 && fileSize <= 200 * 1024 * 1024)
async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const home = await mkdtemp(join(tmpdir(), '.dsh-test-cua-files-'))
const testRecovery = process.env.CUA_TEST_RECOVERY === '1'
const brokerEntry = join(root, 'computer-runtime/broker/main.mjs')
const wrapper = join(home, 'broker-fixture.mjs')
const pidFile = join(home, 'broker.pid')
if (testRecovery) await writeFile(wrapper, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await import(${JSON.stringify(brokerEntry)});`)
const provider = createBrokerProvider({ image, entrypoint: testRecovery ? wrapper : brokerEntry })
const service = createComputerService({ home, config: {}, load: async () => {}, readOnly: () => undefined, botOf: id => ['files-test', ...(testRecovery ? ['second-test'] : [])].includes(id) ? { id } : null }, provider)
let browser, page, server, record, secondRecord, lastTicket, handler, upgrade, dispose, holdChunk = false, releaseChunk, chunkSeen
const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
const rt = { ctx: { get: name => name === 'connection' ? {
  fetch: { register: route => { handler = route.fetch; return () => {} } }, admit: () => ({ peer }),
} : name === 'webServer' ? { registerUpgrade: route => { upgrade = route.handler; return () => {} } } : null } }
try {
  record = await service.bind({ botId: 'files-test', grant: 'observe', expectedRevision: 0 })
  await service.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  dispose = registerComputerViewer(rt, () => service)
  const bundle = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {ComputerView,COMPUTER_CSS} from './src/client/computer-pane.js';
const style=document.createElement('style');style.textContent=COMPUTER_CSS;document.head.append(style);
const actions={computerCall:async(method,args)=>{const r=await fetch('/control',{method:'POST',body:JSON.stringify({method,args})});const v=await r.json();if(v.error)throw Object.assign(new Error(v.error),{code:v.code});return v}};
createRoot(document.getElementById('root')).render(React.createElement(ComputerView,{bot:{id:'files-test'},actions}));`,
    resolveDir: join(root, 'ds-bot'), loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { react: require.resolve('react'), 'react-dom/client': require.resolve('react-dom/client') },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<style>:root{--bt-ink:#222;--bt-card:#fff;--bt-line:#ccc;--bt-main:#fff}body{margin:0}#root{width:900px}</style><div id="root"></div><script src="/test.js"></script>'); return }
      if (req.url === '/test.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
      const chunks = []
      let size = 0
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk) }
      const body = Buffer.concat(chunks).toString()
      if (req.url === '/api/ds-bot/computer-viewer') {
        const result = await handler(new Request(`http://fixture${req.url}`, { method: 'POST', body }))
        res.writeHead(result.status, Object.fromEntries(result.headers))
        res.end(Buffer.from(await result.arrayBuffer()))
        return
      }
      if (req.url !== '/control') { res.writeHead(404).end(); return }
      const { method, args } = JSON.parse(body)
      if (method === 'files' && args.operation === 'write-chunk' && holdChunk) {
        holdChunk = false
        chunkSeen?.()
        await new Promise(resolve => { releaseChunk = resolve })
      }
      const value = method === 'state' ? await service.state()
        : method === 'files' ? await service.files(args)
          : method === 'reconnect' ? await service.reconnect(args)
            : method === 'preview' ? await service.preview(args) : await service.manage(method, args)
      if (method === 'takeover') lastTicket = value.controlToken
      if (method === 'files' && args.operation.endsWith('-chunk') && value.offset % (20 * 1024 * 1024) === 0) {
        console.log(`${args.operation}: ${value.offset} bytes acknowledged`)
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    } catch (error) {
      console.error('Fixture request failed:', error.code ?? '', error.message)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: error.message, code: error.code }))
    }
  })
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CUA_CHROME, args: ['--no-sandbox'] })
  page = await browser.newPage({ locale: 'en-US', acceptDownloads: true })
  page.setDefaultTimeout(180_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  const upload = page.getByLabel('Import file', { exact: true })
  await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  const source = join(home, 'panel.bin')
  const file = await open(source, 'wx')
  const block = Buffer.alloc(256 * 1024, 91)
  try {
    for (let offset = 0; offset < fileSize; offset += block.length) {
      await file.writeFile(block.subarray(0, Math.min(block.length, fileSize - offset)))
    }
  } finally { await file.close() }
  const expectedHash = await fileHash(source)
  await upload.setInputFiles(source)
  await page.getByText('File imported. Existing files are never overwritten.', { exact: true }).waitFor({ timeout: 900_000 })
  const downloadEvent = page.waitForEvent('download', { timeout: 900_000 })
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloadEvent
  const destination = await download.path()
  assert.equal((await stat(destination)).size, fileSize)
  assert.equal(await fileHash(destination), expectedHash)
  console.log(`PASS: real panel uploads and downloads ${fileSize} bytes with matching SHA-256`)

  const seen = Promise.withResolvers()
  chunkSeen = seen.resolve
  holdChunk = true
  await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  await upload.setInputFiles({ name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024 + 31, 91) })
  const chunkTimeout = setTimeout(() => seen.reject(new Error('The upload did not dispatch a chunk.')), 30_000)
  try { await seen.promise } finally { clearTimeout(chunkTimeout) }
  assert.equal(await page.getByRole('progressbar').getAttribute('value'), '0', 'queued chunks are not acknowledged progress')
  await page.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
  releaseChunk()
  await page.getByText('Transfer stopped. Check the destination before retrying.', { exact: true }).waitFor()
  const container = `dsbot-${record.id}`
  const files = JSON.parse((await run('docker', ['exec', container, 'python3', '-c', 'import os,json;print(json.dumps(os.listdir("/home/cua/DSBot")))'])).stdout)
  assert.deepEqual(files, ['panel.bin'])
  console.log('PASS: cancel waits for in-flight acknowledgement, removes staging and never publishes a partial file')

  // Reusing a destination must leave the previously published bytes intact.
  await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  await upload.setInputFiles({ name: 'panel.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('replace') })
  await page.getByRole('alert').filter({ hasText: 'A file with this name already exists.' }).waitFor()
  const sha256 = (await run('docker', ['exec', container, 'sha256sum', '/home/cua/DSBot/panel.bin'])).stdout.split(' ')[0]
  assert.equal(sha256, expectedHash)
  await page.getByRole('button', { name: 'Delete file', exact: true }).click()
  const confirmation = page.getByRole('group', { name: 'Confirm file deletion', exact: true })
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal((await run('docker', ['exec', container, 'sha256sum', '/home/cua/DSBot/panel.bin'])).stdout.split(' ')[0], expectedHash)

  await page.getByRole('button', { name: 'Delete file', exact: true }).click()
  await run('docker', ['exec', container, 'python3', '-c', 'from pathlib import Path;Path("/home/cua/DSBot/panel.bin").write_bytes(b"changed before confirmation")'])
  await confirmation.getByRole('button', { name: 'Delete file permanently', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Deletion could not be confirmed.' }).waitFor()
  assert.equal((await run('docker', ['exec', container, 'cat', '/home/cua/DSBot/panel.bin'])).stdout, 'changed before confirmation')
  console.log('PASS: cancelling deletion preserves bytes; stale confirmation refuses a changed file')

  await page.getByRole('button', { name: 'List files', exact: true }).click()
  await page.getByRole('button', { name: 'Delete file', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Delete file permanently', exact: true }).click()
  await page.getByText('File deleted.', { exact: true }).waitFor()
  assert.deepEqual(JSON.parse((await run('docker', ['exec', container, 'python3', '-c', 'import os,json;print(json.dumps(os.listdir("/home/cua/DSBot")))'])).stdout), [])
  assert.equal(await page.getByRole('button', { name: 'Delete file', exact: true }).count(), 0)
  console.log('PASS: confirmed deletion removes only the selected file and refreshes the list')
  if (testRecovery) {
    secondRecord = await service.bind({ botId: 'second-test', grant: 'observe', expectedRevision: (await service.state()).revision })
    await service.manage('start', { botId: secondRecord.botId, expectedGeneration: secondRecord.generation })
    for (const item of [record, secondRecord]) {
      await run('docker', ['exec', `dsbot-${item.id}`, 'python3', '-c',
        'from pathlib import Path;import sys;p=Path("/home/cua/DSBot");p.mkdir(exist_ok=True);(p/"kept.txt").write_text(sys.argv[1])', item.botId])
    }
    const oldPid = Number(await readFile(pidFile, 'utf8'))
    const oldTicket = lastTicket
    process.kill(oldPid, 'SIGKILL')
    await page.getByText('Unavailable', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Recover desktop service', exact: true }).click()
    const recovery = page.getByRole('group', { name: 'Confirm service recovery', exact: true })
    await recovery.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(Number(await readFile(pidFile, 'utf8')), oldPid)
    await page.getByRole('button', { name: 'Recover desktop service', exact: true }).click()
    await recovery.getByRole('button', { name: 'Recover service and stop desktops', exact: true }).click()
    await page.getByText('Desktop service recovered. Start each desktop when ready.', { exact: true }).waitFor()
    const recovered = await service.state()
    assert.equal(recovered.recovery.completed, 2)
    assert.ok(recovered.computers.every(item => item.phase === 'stopped' && item.control === 'none'))
    assert.notEqual(Number(await readFile(pidFile, 'utf8')), oldPid)
    record = recovered.computers.find(item => item.id === record.id)
    secondRecord = recovered.computers.find(item => item.id === secondRecord.id)
    await assert.rejects(service.files({ botId: record.botId, expectedGeneration: record.generation, controlToken: oldTicket, operation: 'list' }),
      error => error.code === 'bot/computer-stale-control')
    await page.getByRole('button', { name: 'Start desktop', exact: true }).click()
    await page.getByRole('button', { name: 'Take control', exact: true }).click()
    await page.getByRole('button', { name: 'List files', exact: true }).click()
    await page.getByText('kept.txt', { exact: true }).waitFor()
    await service.manage('start', { botId: secondRecord.botId, expectedGeneration: secondRecord.generation })
    for (const item of [record, secondRecord]) {
      assert.equal((await run('docker', ['exec', `dsbot-${item.id}`, 'cat', '/home/cua/DSBot/kept.txt'])).stdout, item.botId)
    }
    console.log('PASS: real panel recovers a killed Broker, stops both desktops, rejects the old control ticket and preserves each home after explicit restart')
  }
  assert.deepEqual(errors, [])
  console.log('PASS: conflicting upload preserves the original file; panel has no uncaught browser errors')
} catch (error) {
  if (page) console.error('Panel state:', await page.locator('[role=alert],[role=status]').allTextContents())
  throw error
} finally {
  releaseChunk?.()
  await browser?.close()
  await dispose?.()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  for (const item of [record, secondRecord].filter(Boolean)) await service.manage('stop', { botId: item.botId, expectedGeneration: item.generation }).catch(() => {})
  await service.dispose()
  for (const item of [record, secondRecord].filter(Boolean)) {
    await run('docker', ['rm', '-f', `dsbot-${item.id}`]).catch(() => {})
    await run('docker', ['volume', 'rm', `dsbot-${item.id}-home`]).catch(() => {})
  }
  await rm(home, { recursive: true, force: true })
}
