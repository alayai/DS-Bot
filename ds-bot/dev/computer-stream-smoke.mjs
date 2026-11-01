// Isolated real TigerVNC + Broker + noVNC test. Requires a prepared immutable
// CUA_TEST_IMAGE and CUA_BROWSER_DEPS pointing to React/ReactDOM/playwright-core.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'
import { createComputerService } from '../src/host/computer/service.js'
import { registerComputerViewer } from '../src/host/computer/viewer.js'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const image = process.env.CUA_TEST_IMAGE
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
const require = createRequire(join(resolve(process.env.CUA_BROWSER_DEPS), 'package.json'))
const { chromium } = require('playwright-core')
const home = await mkdtemp(join(tmpdir(), '.dsh-test-cua-stream-'))
const provider = createBrokerProvider({ image, entrypoint: join(root, 'computer-runtime/broker/main.mjs') })
const service = createComputerService({ home, config: {}, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'stream-test' ? { id } : null }, provider)
let handler, unavailable = false, browser, record, dispose, server
let reads = 0
try {
  record = await service.bind({ botId: 'stream-test', grant: 'observe', expectedRevision: (await service.state()).revision })
  await service.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  dispose = registerComputerViewer({ ctx: { get: () => ({ fetch: { register: route => { handler = route.fetch; return () => {} } } }) } }, () => service)
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ComputerScreen} from './src/client/computer-stream.js';
import {COMPUTER_CSS} from './src/client/computer-pane.js';
const style = document.createElement('style'); style.textContent = COMPUTER_CSS; document.head.append(style);
const root=createRoot(document.getElementById('root')); window.events=[];
window.render=(extra={})=>root.render(React.createElement('div',{className:'bt-computer-screen'},React.createElement(ComputerScreen,{
 live:true,botId:'stream-test',generation:${record.generation},onReady:()=>window.events.push('ready'),onLost:()=>window.events.push('lost'),onFallback:()=>window.events.push('fallback'),onPresented:data=>window.presented=data,...extra})));
window.render();`, resolveDir: join(root, 'ds-bot'), loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { react: require.resolve('react'), 'react-dom/client': require.resolve('react-dom/client') },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<style>body{margin:0;background:#222}#root{width:960px}</style><div id="root"></div><script src="/test.js"></script>'); return }
      if (req.url === '/test.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
      if (req.url !== '/api/ds-bot/computer-viewer') { res.writeHead(404).end(); return }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      if (JSON.parse(body).operation === 'read') reads++
      if (unavailable) { res.writeHead(503).end(); return }
      const abort = new AbortController()
      res.once('close', () => { if (!res.writableEnded) abort.abort() })
      const result = await handler(new Request(`http://fixture${req.url}`, { method: 'POST', body, signal: abort.signal }))
      res.writeHead(result.status, Object.fromEntries(result.headers))
      res.end(Buffer.from(await result.arrayBuffer()))
    } catch (error) { console.error('fixture HTTP',error.message); res.writeHead(500).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CUA_CHROME, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.events.includes('ready'), { timeout: 30000 })
  const before = await page.evaluate(() => {
    window.surface = document.querySelector('.bt-computer-canvas')
    return window.surface.toDataURL()
  })
  assert.ok(before.length > 10000)
  await run('docker', ['exec', recordContainer(), 'python3', '-c', `import ctypes
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
d=ctypes.c_void_p(x.XOpenDisplay(None))
assert d.value
t.XTestFakeMotionEvent(d,-1,200,200,0)
t.XTestFakeButtonEvent(d,3,1,0); t.XTestFakeButtonEvent(d,3,0,0)
x.XFlush(d); x.XCloseDisplay(d)`])
  await page.waitForFunction(old => window.surface.toDataURL() !== old, before)
  assert.equal(await page.evaluate(() => window.surface === document.querySelector('.bt-computer-canvas')), true)
  unavailable = true
  // Close only this test viewer; the desktop stays running during reconnect.
  await dispose()
  await page.waitForFunction(() => window.events.includes('lost'))
  const retained = await page.evaluate(() => window.surface.toDataURL())
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => window.surface.toDataURL()), retained)
  assert.equal(await page.evaluate(() => window.surface.hidden), false)
  dispose = registerComputerViewer({ ctx: { get: () => ({ fetch: { register: route => { handler = route.fetch; return () => {} } } }) } }, () => service)
  unavailable = false
  await page.waitForFunction(() => window.events.filter(event => event === 'ready').length >= 2)
  assert.equal(await page.evaluate(() => window.surface === document.querySelector('.bt-computer-canvas')), true)
  assert.equal(await page.evaluate(() => window.events.includes('fallback')), false)
  // A failed snapshot decode must retain the displayed pixels and disable input.
  await page.evaluate(() => window.render({ live: false, frame: { data: 'invalid-png', frameId: 'invalid' } }))
  await page.waitForFunction(() => window.presented === null)
  assert.ok((await page.evaluate(() => window.surface.toDataURL())).length > 10000)
  console.log(JSON.stringify({ realVnc: true, incrementalUpdate: true, stableCanvas: true, reconnectRetainsPixels: true, invalidSnapshotRetainsPixels: true, reads }))
  function recordContainer() { return `dsbot-${record.id}` }
} finally {
  await browser?.close()
  await dispose?.()
  server?.closeAllConnections()
  await new Promise(resolve => server ? server.close(resolve) : resolve())
  await service.dispose()
  if (record) {
    await run('docker', ['rm', '-f', `dsbot-${record.id}`]).catch(() => {})
    await run('docker', ['volume', 'rm', `dsbot-${record.id}-home`]).catch(() => {})
  }
  await rm(home, { recursive: true, force: true })
}
