// Public DSH tool/attachment runtime → plugin → IPC Broker → guest MCP → fixture.
// Uses no model credentials. The scripted calls do not test visual-model reasoning.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { install } from '../src/host/computer.js'
import { createBrokerProvider } from '../src/host/computer/providers/broker.js'

const image = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Pass the immutable id of the locally built development image.')
const root = resolve(import.meta.dirname, '../..')
const home = await mkdtemp(join(root, '.dsh-test-computer-'))
const run = promisify(execFile)
const docker = args => run('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
const ctx = new Context()
let record
let rt
let approvals = 0
try {
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  ctx.provide('approval', { request: async () => {
    approvals++
    const frame = await rt.computer.preview({ botId: record.botId, expectedGeneration: record.generation })
    assert.equal(frame.width, 1280)
    return 'allowed-once'
  } })
  new LocalAttachmentStore(ctx, { dshHome: home })
  const tools = new ToolRuntime(ctx)
  const messages = []
  const agent = {
    id: 'fixture-bot',
    session: {
      id: 'fixture-bot', requestHeader: () => ({ config: { provider: 'fixture', model: 'vision' } }),
      deriveMessages: () => messages,
    },
  }
  agent.ctx = createScope(ctx, agent).ctx
  rt = {
    ctx, home, config: { computer: { enabled: true, broker: { entrypoint: join(root, 'computer-runtime/broker/main.mjs'), image } } },
    load: async () => {}, readOnly: () => undefined,
    isBotSession: id => id === agent.id, selfOf: id => id === agent.id ? id : undefined,
    botOf: id => id === agent.id ? { id, name: 'Fixture Bot' } : undefined,
    groupOwners: new Map(), live: new Map([[agent.id, { turn: 1 }]]), warn: () => {},
  }
  const broker = createBrokerProvider(rt.config.computer.broker)
  rt.config.computerProvider = broker
  install(rt)
  await ctx.parallel('agent/created', { agent })
  record = await rt.computer.bind({ botId: agent.id, grant: 'operate', expectedRevision: 0 })
  const name = `dsbot-${record.id}`
  let controlToken
  const manage = async method => {
    const result = await rt.computer.manage(method, { botId: agent.id, expectedGeneration: record.generation, controlToken })
    controlToken = result.controlToken ?? controlToken
    return result
  }
  let sequence = 0
  async function tool(name, args = {}) {
    const result = await tools.execute({
      name, arguments: args, callId: `fixture-${++sequence}`, agent, signal: AbortSignal.timeout(45_000),
    })
    if (result.isError) throw new Error(`Computer tool failed: ${JSON.stringify(result.content)}`)
    messages.push({ role: 'tool', content: result.content })
    return result
  }
  await manage('start')
  const diagnostics = await rt.computer.diagnostics({ botId: agent.id, expectedGeneration: record.generation })
  assert.equal(diagnostics.network, 'open')
  assert.equal(diagnostics.storage.hardQuota, false)
  assert.ok(diagnostics.storage.freeBytes > 0)
  const interfaces = JSON.parse((await docker(['exec', name, 'python3', '-c', 'import json,socket;print(json.dumps([name for _,name in socket.if_nameindex()]))'])).stdout)
  assert.ok(interfaces.includes('lo'))
  assert.ok(interfaces.some(name => name !== 'lo'))
  console.log('PASS: storage diagnostics read the actual runtime filesystem; the guest has a non-loopback interface')
  console.log('PASS: plugin starts a labelled non-root desktop with open egress through the Broker')
  const fixture = `from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers()
  self.wfile.write(b"""<!doctype html><title>Semantic fixture</title><h1>Visible guest browser</h1><label>Name<input aria-label="Name"></label><input type="password" aria-label="Password"><button onclick="document.querySelector('h1').textContent='Saved '+document.querySelector('input').value;localStorage.setItem('fixture','saved')">Save</button><a href="/next">Next</a><button onclick="window.open('/tab','_blank')">New tab</button><button onclick="setTimeout(()=>document.querySelector('h1').textContent='Changed',3000)">Delayed change</button><p id="persist"></p><script>document.querySelector('#persist').textContent=localStorage.getItem('fixture')||'fresh'</script>""")
HTTPServer(('127.0.0.1',8765),Handler).serve_forever()`
  await docker(['exec', '-d', name, 'python3', '-c', fixture])
  await delay(1000)
  const parse = result => JSON.parse(typeof result.value === 'string' ? result.value : result.value.text)
  const observe = async () => parse(await tool('computer_browser_observe'))
  const act = async (frame, action) => parse(await tool('computer_browser_act', { observationId: frame.observationId, action }))
  async function openFixture() {
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(500)
      const frame = parse(await tool('computer_observe'))
      try { return await act(frame, { type: 'open', url: 'http://127.0.0.1:8765/' }) }
      catch (error) { if (!error.message.includes('The desktop changed before input.') || attempt === 4) throw error }
    }
  }
  assert.equal((await openFixture()).outcome, 'completed')
  let frame = await observe()
  assert.match(frame.browser.text, /Visible guest browser/)
  assert.equal(frame.browser.visible, true)
  const input = frame.browser.elements.find(e => e.name === 'Name')
  assert.equal((await act(frame, { type: 'fill', ref: input.ref, text: 'CUA semantic' })).outcome, 'completed')
  frame = await observe()
  assert.equal((await act(frame, { type: 'click', ref: frame.browser.elements.find(e => e.name === 'Save').ref })).outcome, 'completed')
  frame = await observe()
  assert.match(frame.browser.text, /Saved CUA semantic/)
  assert.equal((await act(frame, { type: 'fill', ref: frame.browser.elements.find(e => e.name === 'Password').ref, text: 'test-only' })).outcome, 'rejected')
  frame = await observe()
  assert.equal((await act(frame, { type: 'click', ref: frame.browser.elements.find(e => e.name === 'Next').ref })).outcome, 'completed')
  frame = await observe(); assert.match(frame.browser.url, /next$/); assert.match(frame.browser.text, /saved/)
  assert.equal((await act(frame, { type: 'back' })).outcome, 'completed')
  frame = await observe(); assert.equal(frame.browser.url, 'http://127.0.0.1:8765/')
  assert.equal((await act(frame, { type: 'click', ref: frame.browser.elements.find(e => e.name === 'Delayed change').ref })).outcome, 'completed')
  frame = await observe(); await delay(3500)
  assert.equal((await act(frame, { type: 'click', ref: frame.browser.elements.find(e => e.name === 'Save').ref })).outcome, 'rejected')
  frame = await observe()
  const originalTab = frame.browser.tab
  assert.equal((await act(frame, { type: 'click', ref: frame.browser.elements.find(e => e.name === 'New tab').ref })).outcome, 'completed')
  frame = await observe()
  assert.equal(frame.browser.tabs.length, 2)
  const otherTab = frame.browser.tabs.find(tab => tab !== originalTab)
  assert.equal((await act(frame, { type: 'switch', tab: otherTab })).outcome, 'completed')
  frame = await observe(); assert.match(frame.browser.url, /tab$/)
  assert.equal((await act(frame, { type: 'switch', tab: originalTab })).outcome, 'completed')
  await tool('computer_release')
  frame = await observe(); assert.match(frame.browser.text, /saved|Saved/)
  console.log('PASS: public DSH tools operate visible Firefox, fill/click/back/tabs, refuse stale DOM and password fields, and reconnect after release')
  await delay(2000)
  await manage('stop'); await manage('start')
  await docker(['exec', '-d', name, 'python3', '-c', fixture]); await delay(500)
  assert.equal((await openFixture()).outcome, 'completed')
  frame = await observe(); assert.match(frame.browser.text, /saved/)
  const listeners = (await docker(['exec', name, 'python3', '-c', "from pathlib import Path;print('\\n'.join(line for line in Path('/proc/net/tcp').read_text().splitlines() if ':0B0C' in line and ' 0A ' in line))"])).stdout
  assert.match(listeners, /0100007F:0B0C/)
  assert.doesNotMatch(listeners, /00000000:0B0C/)
  console.log('PASS: the persistent Firefox profile survives desktop restart; Marionette listens on guest loopback')
  await manage('stop'); await manage('start')
  await docker(['exec', '-d', name, 'firefox', '--no-remote', 'about:blank']); await delay(2500)
  const refused = await openFixture()
  assert.equal(refused.outcome, 'rejected')
  assert.match(refused.note, /already running without semantic access/)
  assert.ok(approvals >= 10)
  console.log('PASS: an existing ordinary Firefox is left running and asks for explicit close/reopen')
} finally {
  await ctx.fiber.dispose()
  if (record) {
    await docker(['rm', '-f', `dsbot-${record.id}`]).catch(() => {})
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=org.ds-bot.computer.id=${record.id}`])).stdout.trim().split('\n').filter(Boolean)
    for (const volume of volumes) await docker(['volume', 'rm', volume]).catch(() => {})
  }
  await rm(home, { recursive: true, force: true })
}
