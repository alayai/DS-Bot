// Isolated visual integration bench: actual Computer service + synthetic PNG
// provider. It never uses DSH_HOME or starts a container/model.
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createComputerService } from '../../ds-bot/src/host/computer/service.js'
import { createFakeComputer } from '../../ds-bot/src/host/computer/providers/fake.js'
import { encodePng } from '../../ds-bot/src/office/png.js'

const home = await mkdtemp(join(tmpdir(), '.dsh-test-bothub-screens-'))
const provider = createFakeComputer()
const metrics = { captures: [], active: 0, peak: 0, errors: {} }
let legacy = false, busy = false, invalid = false, portrait = false, frameSerial = 0
const capture = provider.preview.bind(provider)
const preview = async (record, options) => {
  if (busy) throw Object.assign(new Error('Synthetic busy'), { code: 'bot/computer-busy' })
  await capture(record, options)
  const width = portrait ? 480 : 960, height = portrait ? 800 : 540
  const data = Buffer.alloc(width * height * 4)
  const palette = record.botId === 'alpha' ? [26, 80, 126] : [96, 50, 78]
  frameSerial++
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const panel = x > width * .08 && x < width * .92 && y > 70 && y < height - 60
    const bar = panel && x < width * (.3 + Math.floor(y / 24) % 4 * .13) && y % 24 < 8
    const cursor = x > 60 + frameSerial % 12 * 25 && x < 70 + frameSerial % 12 * 25 && y > height - 43 && y < height - 25
    data.set(bar ? [140, 212, 194, 255] : cursor ? [255, 219, 117, 255] : panel ? [18, 29, 44, 255] : [...palette, 255], (y * width + x) * 4)
  }
  return { width, height, data: invalid ? Buffer.from('invalid') : encodePng({ width, height, data }) }
}
provider.preview = async (record, options) => {
  metrics.active++
  metrics.peak = Math.max(metrics.peak, metrics.active)
  metrics.captures.push({ botId: record.botId, at: Date.now() })
  if (metrics.captures.length > 4096) metrics.captures.shift()
  try { return await preview(record, options) } finally { metrics.active-- }
}
const bots = ['alpha', 'beta', 'gamma'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), kind: 'bot' }))
const rt = {
  home, config: {}, load: async () => {}, readOnly: () => undefined,
  botOf: id => bots.find(bot => bot.id === id), live: new Map(), groupOwners: new Map(),
  isBotSession: () => false, ctx: {},
}
const service = createComputerService(rt, provider)
for (const bot of bots.slice(0, 2)) await service.bind({ botId: bot.id, grant: 'observe', expectedRevision: (await service.state()).revision })
const manage = async (method, botId = 'alpha') => {
  const record = (await service.state()).computers.find(item => item.botId === botId)
  return service.manage(method, { botId, expectedGeneration: record.generation })
}
const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8')
// Supply an external React install for standalone Hub verification; never bundle
// a second React into the production plugin or add test dependencies to it.
const viewerScript = process.env.BOTHUB_REACT_MODULES ? await build({
  entryPoints: [new URL('./desktop-viewer-bench.js', import.meta.url).pathname],
  nodePaths: [process.env.BOTHUB_REACT_MODULES],
  bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'text' },
}) : null
const script = await build({
  stdin: { resolveDir: new URL('..', import.meta.url).pathname, contents: `
import {mountWorld} from './src/client/world-renderer.js';
import {roomLayout} from './src/client/rooms.js';
const bots=${JSON.stringify(bots)};
const snapshot={entities:bots,groups:[{id:'design',name:'Design room',members:bots.map(b=>b.id)},{id:'ops',name:'Operations',members:['alpha']}],sessions:[],runs:[]};
const container=document.querySelector('.bh-scene'),labels=document.querySelector('.bh-scene-labels');
let world, selection=null, groupId='design';
const stats={requests:[],frames:0,contexts:0,textures:new Set()};
const fetcher=window.fetch.bind(window);
window.fetch=(url,options)=>{if(url==='api/bot')stats.requests.push(JSON.parse(options.body));return fetcher(url,options)};
const context=HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext=function(...args){const gl=context.apply(this,args);if(!gl||!args[0].startsWith('webgl')||gl.testHook)return gl;gl.testHook=true;stats.contexts++;
const create=gl.createTexture.bind(gl),remove=gl.deleteTexture.bind(gl);const owned=new Set();
gl.createTexture=()=>{const t=create();owned.add(t);stats.textures.add(t);return t};
gl.deleteTexture=t=>{owned.delete(t);stats.textures.delete(t);remove(t)};
const extension=gl.getExtension.bind(gl);gl.getExtension=name=>{const e=extension(name);if(name==='WEBGL_lose_context'&&e&&!e.testHook){e.testHook=true;const lose=e.loseContext.bind(e);e.loseContext=()=>{stats.contexts--;for(const t of owned)stats.textures.delete(t);lose()}}return e};return gl};
const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=fn=>raf(t=>{stats.frames++;fn(t)});
const render=()=>{if(!world)return;const layout=roomLayout(snapshot,{groupId});labels.replaceChildren(...layout.presences.map((seat,i)=>{const button=document.createElement('button');button.className='bh-scene-label';button.dataset.seat=i;button.dataset.entity=seat.entity.id;button.textContent=seat.entity.name;const status=document.createElement('span');status.dataset.desktop='standby';button.append(status);button.onclick=()=>{selection={entityId:seat.entity.id,groupId:seat.groupId};render()};return button}));world.update(layout,selection,true)};
const mount=()=>{world=mountWorld(container,labels,(id,space)=>{selection={entityId:id,groupId:space};render()},()=>{},()=>{selection=null;render()},()=>{throw Error('WebGL failed')});render()};
const command=async action=>{await fetch('/fixture',{method:'POST',body:JSON.stringify({action})})};
document.querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>command(button.dataset.command));
window.screenTest={stats,select(id){selection=id?{entityId:id,groupId:'design'}:null;groupId='design';render()},all(){groupId=undefined;selection=null;render()},mount,unmount(){world.dispose();world=null;labels.replaceChildren()},motion(value){world.motion(value)},connected(value){const layout=roomLayout(snapshot,{groupId});world.update(layout,selection,true,value)},command};
mount();
`, loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser',
})
const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store')
  try {
    if (request.url === '/favicon.ico') return response.writeHead(204).end()
    if (request.url === '/metrics') return response.setHeader('content-type', 'application/json').end(JSON.stringify(metrics))
    if (request.url === '/viewer' && viewerScript) return response.setHeader('content-type', 'text/html; charset=utf-8').end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#hub{height:calc(100dvh - 44px)}.test-source{height:44px;padding:8px;box-sizing:border-box;font:12px system-ui}</style><div class="test-source">Synthetic desktop integration test · Actual Hub and Computer service · No container/model</div><div id="hub"></div><script src="/viewer.js"></script>`)
    if (request.url === '/viewer.js' && viewerScript) return response.setHeader('content-type', 'text/javascript').end(viewerScript.outputFiles[0].text)
    if (request.url === '/') return response.setHeader('content-type', 'text/html; charset=utf-8').end(`<!doctype html><meta charset="utf-8"><style>${css}
body{margin:0;font-family:system-ui;background:#fafbfe}header{padding:12px 24px}.bh-root{height:100vh}.bh-scene{height:calc(100vh - 100px);width:100%}button{margin:4px;padding:6px}</style>
<main class="bh-root"><header><strong>BotHub · Synthetic desktop integration test</strong><div>Actual preview service · Original test pixels · No container or model</div>
<button data-command="start">Start test desktop</button><button data-command="stop">Stop test desktop</button><button data-command="busy">Toggle busy</button><button data-command="portrait">Toggle portrait</button></header>
<div class="bh-scene"><div class="bh-scene-labels"></div></div></main><script src="/bench.js"></script>`)
    if (request.url === '/bench.js') return response.setHeader('content-type', 'text/javascript').end(script.outputFiles[0].text)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    let value
    if (request.url === '/fixture') {
      if (body.action === 'start' || body.action === 'stop') await manage(body.action)
      else if (body.action === 'start-beta') await manage('start', 'beta')
      else if (body.action === 'busy') busy = !busy
      else if (body.action === 'legacy') legacy = !legacy
      else if (body.action === 'invalid') invalid = !invalid
      else if (body.action === 'portrait') portrait = !portrait
      value = true
    } else if (request.url === '/api/bot') {
      if (body.endpoint === 'computer-state') {
        value = await service.state()
        if (legacy) delete value.passivePreview
      } else if (body.endpoint === 'computer-preview') value = await service.preview(body.payload)
      else throw new Error('Unsupported bench endpoint')
    } else throw new Error('Unknown bench route')
    response.setHeader('content-type', 'application/json').end(JSON.stringify({ ok: true, value }))
  } catch (error) {
    const code = error.code ?? 'test/error'
    metrics.errors[code] = (metrics.errors[code] ?? 0) + 1
    response.setHeader('content-type', 'application/json').end(JSON.stringify({ ok: false, error: { code: error.code ?? 'test/error' } }))
  }
})
await new Promise(resolve => server.listen(Number(process.argv[2] ?? 3204), '127.0.0.1', resolve))
console.log(`Synthetic desktop bench listening on ${server.address().port}`)
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await service.dispose()
  await rm(home, { recursive: true, force: true })
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void stop() })
