// Isolated real TigerVNC + Broker + noVNC test. Requires a prepared immutable
// CUA_TEST_IMAGE and CUA_BROWSER_DEPS pointing to React/ReactDOM/playwright-core.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const transport = process.env.CUA_TEST_TRANSPORT ?? 'websocket'
assert.ok(['websocket', 'fetch', 'blocked'].includes(transport))
let handler, upgrade, unavailable = false, browser, record, dispose, server
let upgrades = 0
const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
const rt = { ctx: { get: name => name === 'connection' ? {
  fetch: { register: route => { handler = route.fetch; return () => {} } },
  admit: () => ({ peer }),
} : name === 'webServer' ? { registerUpgrade: route => { upgrade = route.handler; return () => { upgrade = null } } } : null } }
let reads = 0
const timings = {}
try {
  record = await service.bind({ botId: 'stream-test', grant: 'observe', expectedRevision: (await service.state()).revision })
  let started = performance.now()
  await service.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  timings.guestStartMs = Math.round(performance.now() - started)
  dispose = registerComputerViewer(rt, () => service)
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ComputerScreen} from './src/client/computer-stream.js';
import RFB from '@novnc/novnc';
window.copies=0; const capture=RFB.prototype.getImageData; RFB.prototype.getImageData=function(){window.copies++;return capture.call(this)};
import {COMPUTER_CSS} from './src/client/computer-pane.js';
const style = document.createElement('style'); style.textContent = COMPUTER_CSS; document.head.append(style);
const root=createRoot(document.getElementById('root')); window.events=[]; window.transports=[];
window.render=(extra={})=>root.render(React.createElement('div',{className:'bt-computer-screen'},React.createElement(ComputerScreen,{
 live:true,botId:'stream-test',generation:${record.generation},channelOptions:{forceFetch:${transport === 'fetch'}},onControls:value=>window.controls=value,onReady:info=>{window.events.push('ready');window.transports.push(info.transport)},onLost:()=>window.events.push('lost'),onFallback:()=>window.events.push('fallback'),onPresented:data=>window.presented=data,...extra})));
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
  server.on('upgrade', (req, socket, head) => {
    upgrades++
    if (unavailable || !upgrade || transport === 'blocked') { socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    upgrade(req, socket, head)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CUA_CHROME, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  started = performance.now()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.events.includes('ready'), undefined, { timeout: 30000 })
  timings.firstFrameMs = Math.round(performance.now() - started)
  const before = await page.evaluate(() => {
    window.surface = document.querySelector('.bt-computer-canvas')
    return document.querySelector('.bt-computer-decoder canvas').toDataURL()
  })
  assert.ok(before.length > 10000)
  const copies = await page.evaluate(() => window.copies)
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => window.copies), copies, 'steady live display must not copy framebuffers')
  assert.equal(await page.evaluate(() => window.transports[0]), transport === 'websocket' ? 'websocket' : 'fetch')
  await run('docker', ['exec', recordContainer(), 'python3', '-c', `import ctypes
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
d=ctypes.c_void_p(x.XOpenDisplay(None))
assert d.value
t.XTestFakeMotionEvent(d,-1,200,200,0)
t.XTestFakeButtonEvent(d,3,1,0); t.XTestFakeButtonEvent(d,3,0,0)
x.XFlush(d); x.XCloseDisplay(d)`])
  await page.waitForFunction(old => document.querySelector('.bt-computer-decoder canvas').toDataURL() !== old, before)
  assert.equal(await page.evaluate(() => window.surface === document.querySelector('.bt-computer-canvas')), true)
  unavailable = true
  // Close only this test viewer; the desktop stays running during reconnect.
  await dispose()
  await page.waitForFunction(() => window.events.includes('lost'))
  const retained = await page.evaluate(() => window.surface.toDataURL())
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => window.surface.toDataURL()), retained)
  assert.equal(await page.evaluate(() => window.surface.hidden), false)
  dispose = registerComputerViewer(rt, () => service)
  started = performance.now()
  unavailable = false
  await page.waitForFunction(() => window.events.filter(event => event === 'ready').length >= 2)
  timings.observerReconnectMs = Math.round(performance.now() - started)
  assert.equal(await page.evaluate(() => window.surface === document.querySelector('.bt-computer-canvas')), true)
  assert.equal(await page.evaluate(() => window.events.includes('fallback')), false)
  // A failed snapshot decode must retain the displayed pixels and disable input.
  await page.evaluate(() => window.render({ live: false, frame: { data: 'invalid-png', frameId: 'invalid' } }))
  await page.waitForFunction(() => window.presented === null)
  assert.ok((await page.evaluate(() => window.surface.toDataURL())).length > 10000)
  const takeover = await service.manage('takeover', { botId: record.botId, expectedGeneration: record.generation })
  const renderControl = token => page.evaluate(controlToken => window.render({ controlToken }), token)
  let readyCount = await page.evaluate(() => window.events.filter(event => event === 'ready').length)
  started = performance.now()
  await renderControl(takeover.controlToken)
  await page.waitForFunction(n => window.events.filter(event => event === 'ready').length > n, readyCount)
  timings.liveControlReadyMs = Math.round(performance.now() - started)
  const liveCanvas = page.locator('.bt-computer-decoder canvas')
  const fixture = await readFile(join(root, 'computer-runtime/test/fixture.py'), 'utf8')
  await run('docker', ['exec', recordContainer(), 'python3', '-c',
    `from pathlib import Path;Path('/tmp/fixture.py').write_text(${JSON.stringify(fixture)});p=Path('/tmp/stream-firefox');p.mkdir();(p/'user.js').write_text('user_pref("browser.aboutwelcome.enabled", false);\\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\\n')`])
  await run('docker', ['exec', '-d', recordContainer(), 'python3', '/tmp/fixture.py'])
  await run('docker', ['exec', '-d', recordContainer(), 'firefox', '--kiosk', '--no-remote', '--profile', '/tmp/stream-firefox', 'http://127.0.0.1:8765/'])
  await marker('ready', value => Boolean(value))
  await page.waitForTimeout(1500)
  // The observation check opened the desktop menu; dismiss its X11 input grab.
  await page.evaluate(() => window.controls.key('Escape'))
  await page.waitForTimeout(200)
  await liveCanvas.click({ position: { x: 60, y: 60 } })
  await marker('marker', value => value === '1')
  await liveCanvas.click({ position: { x: 75, y: 131 } })
  await marker('focus', value => value === 'ready')
  await page.keyboard.type('key-')
  await marker('text', value => value === 'key-')
  await page.evaluate(() => window.controls.text('live-测试'))
  await marker('text', value => value === 'key-live-测试')
  await page.evaluate(() => window.controls.key('Enter'))
  await marker('key', value => value === 'key-live-测试')
  const samples = []
  for (let i = 1; i <= 10; i++) {
    const color = i % 2 ? [240, 64, 16] : [16, 128, 240]
    await page.evaluate(expected => {
      const surface = document.querySelector('.bt-computer-decoder canvas')
      const context = surface.getContext('2d')
      window.inputFrameMs = null
      surface.addEventListener('mousedown', () => {
        const began = performance.now()
        const check = () => {
          const pixel = context.getImageData(430, 175, 1, 1).data
          if (expected.every((value, channel) => pixel[channel] === value)) window.inputFrameMs = performance.now() - began
          else if (performance.now() - began < 5000) requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }, { once: true, capture: true })
    }, color)
    await liveCanvas.click({ position: { x: 360, y: 140 } })
    await page.waitForFunction(() => window.inputFrameMs !== null, undefined, { timeout: 6000 })
    await marker('pulse', value => value === String(i))
    samples.push(Math.round(await page.evaluate(() => window.inputFrameMs)))
  }
  const sorted = [...samples].sort((a, b) => a - b)
  timings.inputToFrameMs = { samples, min: sorted[0], p50: sorted[4], p95: sorted[9], max: sorted[9] }
  await liveCanvas.click({ position: { x: 60, y: 60 } })
  await page.keyboard.press('Escape')
  await page.keyboard.down('Control')
  await page.mouse.move(120, 150)
  await page.mouse.down()
  await page.mouse.move(200, 180, { steps: 5 })
  const held = await waitInput(value => value.keys && value.buttons)
  assert.ok(Math.abs(held.x - 200 * 1280 / 960) <= 3, 'scaled live pointer coordinates')
  readyCount = await page.evaluate(() => window.events.filter(event => event === 'ready').length)
  started = performance.now()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await waitInput(value => !value.keys && !value.buttons)
  timings.blurReleaseMs = Math.round(performance.now() - started)
  assert.equal((await service.state()).computers[0].control, 'human', 'blur never resumes the Bot')
  await page.mouse.up()
  await page.keyboard.up('Control')
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => window.events.filter(event => event === 'ready').length), readyCount, 'control must not reconnect itself')
  await page.getByRole('button', { name: 'Resume live control' }).click()
  await page.waitForFunction(n => window.events.filter(event => event === 'ready').length > n, readyCount)
  await liveCanvas.click({ position: { x: 60, y: 60 } })
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await waitInput(value => value.keys && value.buttons)
  started = performance.now()
  await dispose()
  await waitInput(value => !value.keys && !value.buttons)
  timings.disconnectReleaseMs = Math.round(performance.now() - started)
  await page.mouse.up()
  await page.keyboard.up('Shift')
  dispose = registerComputerViewer(rt, () => service)
  const renewed = await service.manage('takeover', { botId: record.botId, expectedGeneration: record.generation })
  await assert.rejects(service.openViewer({ botId: record.botId, expectedGeneration: record.generation, controlToken: takeover.controlToken }))
  readyCount = await page.evaluate(() => window.events.filter(event => event === 'ready').length)
  await renderControl(renewed.controlToken)
  await page.waitForFunction(n => window.events.filter(event => event === 'ready').length > n, readyCount)
  await service.manage('release', { botId: record.botId, expectedGeneration: record.generation, controlToken: renewed.controlToken })
  await waitInput(value => !value.keys && !value.buttons)
  assert.equal((await service.state()).computers[0].control, 'none')
  console.log(JSON.stringify({ realVnc: true, incrementalUpdate: true, stableCanvas: true, reconnectRetainsPixels: true, invalidSnapshotRetainsPixels: true, noSteadyFrameCopies: true,
    liveDragAndKeyboard: true, unicodeText: true, scaledCoordinates: true, blurReleasesInput: true, disconnectReleasesInput: true, staleControlRejected: true, transport, reads, upgrades, timings }))
  if (process.env.CUA_STREAM_REPORT) await writeFile(process.env.CUA_STREAM_REPORT, JSON.stringify({
    schema: 1, recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    engine: 'docker', image, transport, reads, upgrades, timings,
  }, null, 2) + '\n')
  function recordContainer() { return `dsbot-${record.id}` }
  async function marker(name, check) {
    let last
    for (let i = 0; i < 60; i++) {
      let value
      try { value = (await run('docker', ['exec', recordContainer(), 'cat', `/tmp/dsbot-fixture-${name}`])).stdout } catch {}
      last = value
      if (check(value)) return
      await page.waitForTimeout(100)
    }
    await page.screenshot({ path: '/tmp/cua-control-fixture-failure.png' })
    throw new Error(`No independent ${name} marker: ${JSON.stringify(last)}.`)
  }
  async function waitInput(check) {
    let last
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await run('docker', ['exec', recordContainer(), 'python3', '-c', `import ctypes as c,json
x=c.CDLL('libX11.so.6'); x.XOpenDisplay.restype=c.c_void_p
d=c.c_void_p(x.XOpenDisplay(None)); assert d.value
x.XDefaultRootWindow.restype=c.c_ulong
keys=(c.c_ubyte*32)(); x.XQueryKeymap(d,keys)
root,child=c.c_ulong(),c.c_ulong()
rx,ry,wx,wy,mask=(c.c_int() for _ in range(5))
x.XQueryPointer(d,c.c_ulong(x.XDefaultRootWindow(d)),c.byref(root),c.byref(child),c.byref(rx),c.byref(ry),c.byref(wx),c.byref(wy),c.byref(mask))
print(json.dumps(dict(keys=sum(bin(v).count('1') for v in keys),buttons=mask.value&0x1f00,x=rx.value,y=ry.value)))
x.XCloseDisplay(d)`])
      const value = JSON.parse(result.stdout)
      last = value
      if (check(value)) return value
      await page.waitForTimeout(100)
    }
    throw new Error(`Guest input state did not settle: ${JSON.stringify(last)}; phase=${(await service.state()).computers[0].phase}`)
  }
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
