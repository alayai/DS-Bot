// Browser file picker/download, actual portable manager and task queue; isolated fake desktop.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createComputerService } from '../src/host/computer/service.js'
import { createFakeComputer } from '../src/host/computer/providers/fake.js'
const require = createRequire(join(process.env.CUA_BROWSER_DEPS, 'package.json')), { chromium } = require('playwright-core')
const home = await mkdtemp(join(tmpdir(), '.dsh-test-management-ui-')), size = 65 * 1024 ** 2
const provider = Object.assign(createFakeComputer(), {
  portableSupported: true, configure: async () => {}, portableExport: async (_record, { path }) => {
    const out = await open(path, 'wx'); try { const chunk = Buffer.alloc(1024 ** 2, 7); for (let i = 0; i < 65; i++) await out.writeFile(chunk) } finally { await out.close() }
    return { bytes: size, sha256: 'a'.repeat(64) }
  }, portableImport: async (_record, { path }) => { const bytes = await readFile(path); assert.equal(bytes.length, size); assert.ok(bytes.every(value => value === 7)) },
})
let service, browser, server, record
const deliveries = []
const rt = { home, config: {}, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'ui-test' ? { id } : undefined,
  chatOf: () => 'ui-chat', live: new Map(), groupOwners: new Map(), isBotSession: id => id === 'ui-chat', selfOf: () => 'ui-test',
  ctx: { sessions: { flush: async () => {} } }, resolveAgent: async () => ({ session: { id: 'ui-chat' }, inbox: { nextTurn: [], nextStep: [], remove() {} }, cancel() {} }),
  deliver: async args => { (await service.tasks.validateDelivery(args.computerTask, args.sessionId))(); deliveries.push(args) },
}
service = createComputerService(rt, provider)
const errors = []
try {
  await service.bind({ botId: 'ui-test', grant: 'observe', expectedRevision: 0 })
  record = (await service.state()).computers[0]
  const output = await build({ stdin: { contents: `import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';
import{ComputerPortable}from'./src/client/computer-portable.js';import{ComputerPolicy}from'./src/client/computer-policy.js';import{ComputerTasks}from'./src/client/computer-tasks.js';
const initial=${JSON.stringify(record)};window.showSaveFilePicker=async()=>{throw new DOMException('Native picker denied in this fixture','SecurityError')};
function App(){const[record,setRecord]=useState(initial);const call=async(method,args={})=>{const r=await fetch('/control',{method:'POST',body:JSON.stringify({method,args:{botId:record.botId,expectedGeneration:record.generation,...args}})});const v=await r.json();if(v.error)throw Error(v.error);return v};const changed=async()=>setRecord((await call('state')).computers[0]);useEffect(()=>{void changed()},[]);return React.createElement('main',{'data-generation':record.generation},React.createElement(ComputerPortable,{record,call,changed}),React.createElement(ComputerPolicy,{record,call,changed}),React.createElement(ComputerTasks,{record,call}));}createRoot(document.getElementById('root')).render(React.createElement(App));`,
      resolveDir: resolve(import.meta.dirname, '..'), loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { react: require.resolve('react'), 'react-dom/client': require.resolve('react-dom/client') }, define: { 'process.env.NODE_ENV': '"production"' } })
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/') return res.setHeader('content-type', 'text/html').end('<div id="root"></div><script src="/test.js"></script>')
      if (req.url === '/test.js') return res.setHeader('content-type', 'text/javascript').end(output.outputFiles[0].text)
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const { method, args } = JSON.parse(Buffer.concat(chunks))
      const value = method === 'portable-state' ? await service.portable.state() : method === 'portable' ? await service.portable.command(args.method, args)
        : method === 'configure' ? await service.storage('configure', args) : method === 'state' ? await service.state()
          : method === 'tasks' ? args.method ? await service.tasks.command(args.method, args) : await service.tasks.list(args.botId) : null
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
    } catch (error) { res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: process.env.CUA_CHROME, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'en-US', acceptDownloads: true }); page.setDefaultTimeout(30000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('Desktop CPU, memory and network', { exact: true }).click()
  await page.getByLabel('CPU cores', { exact: true }).fill('1')
  await page.getByLabel('Memory (MiB)', { exact: true }).fill('1024')
  await page.getByRole('button', { name: 'Save desktop settings', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm desktop settings', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('main')?.dataset.generation === '2')
  await page.getByText('External desktop backup', { exact: true }).click()
  await page.getByRole('button', { name: 'Prepare external backup', exact: true }).click()
  await page.getByRole('button', { name: 'Save backup to this computer', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Save backup to this computer', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Native picker denied in this fixture' }).waitFor()
  await page.getByLabel('Use numbered backup parts', { exact: true }).check()
  const paths = []
  for (let i = 0; i < 2; i++) {
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Save backup to this computer', exact: true }).click()
    const download = await downloaded, path = join(home, download.suggestedFilename()); await download.saveAs(path); paths.push(path)
  }
  assert.match(paths[0], /000001-of-000002$/); assert.match(paths[1], /000002-of-000002$/)
  assert.equal((await readFile(paths[0])).length, 64 * 1024 ** 2); assert.equal((await readFile(paths[1])).length, 1024 ** 2)
  await page.getByRole('button', { name: 'Discard temporary backup', exact: true }).click()
  await page.getByLabel('Choose backup files', { exact: true }).setInputFiles(paths.reverse())
  await page.getByRole('button', { name: 'Import uploaded backup', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm backup import', exact: true }).click()
  await page.getByText('Backup status: completed', { exact: false }).waitFor()
  console.log('PASS: real browser saves numbered 64 MiB parts, accepts multi-file selection in reverse order, uploads and confirms import')
  await page.getByText('Desktop task queue', { exact: true }).click()
  await page.getByLabel('Desktop task goal', { exact: true }).fill('Observe a test window and report evidence.')
  await page.getByRole('button', { name: 'Add desktop task', exact: true }).click()
  await page.getByText('Task status: queued', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Pause task', exact: true }).click()
  await page.getByText('Task status: paused', { exact: true }).waitFor()
  await page.reload(); await page.getByText('Desktop task queue', { exact: true }).click(); await page.getByText('Task status: paused', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click(); await page.getByText('Task status: cancelled', { exact: true }).waitFor()
  record = (await service.state()).computers[0]
  await service.manage('start', { botId: record.botId, expectedGeneration: record.generation })
  for (const timezoneId of ['Asia/Shanghai', 'America/Los_Angeles']) {
    const scheduledPage = await browser.newPage({ locale: 'en-US', timezoneId })
    scheduledPage.on('pageerror', error => errors.push(error.message))
    try {
      await scheduledPage.goto(`http://127.0.0.1:${server.address().port}`)
      await scheduledPage.getByText('Desktop task queue', { exact: true }).click()
      const expected = await scheduledPage.evaluate(() => {
        const date = new Date(Date.now() + 3600_000); date.setSeconds(0, 0)
        const pad = n => String(n).padStart(2, '0')
        return { timestamp: date.getTime(), local: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}` }
      })
      const goal = `Scheduled desktop check in ${timezoneId}`
      await scheduledPage.getByLabel('Desktop task goal', { exact: true }).fill(goal)
      await scheduledPage.getByLabel('Run at (optional)', { exact: true }).fill(expected.local)
      assert.equal(await scheduledPage.getByLabel('Run at (optional)', { exact: true }).evaluate(el => el.checkValidity()), true)
      await scheduledPage.getByRole('button', { name: 'Add desktop task', exact: true }).click()
      const row = scheduledPage.locator('section').filter({ has: scheduledPage.getByText(goal, { exact: true }) })
      await row.getByText('Task status: queued', { exact: true }).waitFor()
      let task = (await service.tasks.list(record.botId)).find(item => item.goal === goal)
      assert.equal(task.runAt, expected.timestamp)
      await service.tasks.tick(); assert.equal(deliveries.length, 0)
      await scheduledPage.reload()
      await scheduledPage.getByText('Desktop task queue', { exact: true }).click()
      await row.getByText('Task status: queued', { exact: true }).waitFor()
      await row.getByText('Scheduled for', { exact: false }).waitFor()
      await row.getByRole('button', { name: 'Cancel task', exact: true }).click()
      await row.getByText('Task status: cancelled', { exact: true }).waitFor()
      task = (await service.tasks.list(record.botId)).find(item => item.id === task.id)
      assert.equal(task.status, 'cancelled')
      assert.equal(task.runAt, expected.timestamp)
    } finally { await scheduledPage.close() }
  }
  assert.deepEqual(errors, [])
  console.log('PASS: CPU/RAM confirmation, persistent queue pause/cancel and panel reload without browser errors')
  console.log('PASS: scheduled time in Shanghai/Los Angeles, absolute timestamp persistence, reload, no early dispatch and cancellation')
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await service.dispose(); await rm(home, { recursive: true, force: true })
}
