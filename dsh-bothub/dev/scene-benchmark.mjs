import { mountWorld } from '../src/client/world-renderer.js'
import { roomLayout } from '../src/client/rooms.js'

// Development-only synthetic workload. No host, model or production test hooks.
const nativeFrame = window.requestAnimationFrame.bind(window)
const tick = () => new Promise(resolve => nativeFrame(resolve))
const stats = { frames: [], draws: 0, contexts: 0, buffers: new Set(), textures: new Set(), contextOnlyTextures: 0 }
const getContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (...args) {
  const gl = getContext.apply(this, args)
  if (!gl || !args[0].startsWith('webgl') || gl.__benchmark) return gl
  gl.__benchmark = true
  stats.contexts++
  const owned = { buffers: new Set(), textures: new Set() }
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  stats.gpu = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  for (const [create, remove, field] of [
    ['createBuffer', 'deleteBuffer', 'buffers'], ['createTexture', 'deleteTexture', 'textures'],
  ]) {
    const make = gl[create].bind(gl), free = gl[remove].bind(gl)
    gl[create] = (...args) => {
      const object = make(...args)
      if (object) { stats[field].add(object); owned[field].add(object) }
      return object
    }
    gl[remove] = object => { stats[field].delete(object); owned[field].delete(object); free(object) }
  }
  for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const native = gl[method].bind(gl)
    gl[method] = (...args) => { stats.draws++; return native(...args) }
  }
  const getExtension = gl.getExtension.bind(gl)
  gl.getExtension = name => {
    const ext = getExtension(name)
    if (name === 'WEBGL_lose_context' && ext && !ext.__benchmark) {
      ext.__benchmark = true
      const lose = ext.loseContext.bind(ext)
      ext.loseContext = () => {
        stats.contexts--
        stats.contextOnlyTextures += owned.textures.size
        for (const field of ['buffers', 'textures']) for (const object of owned[field]) stats[field].delete(object)
        lose()
      }
    }
    return ext
  }
  return gl
}
window.requestAnimationFrame = callback => nativeFrame(time => {
  const started = performance.now(), draws = stats.draws
  callback(time)
  stats.frames.push({ ms: performance.now() - started, draws: stats.draws - draws })
})
const resources = () => ({ contexts: stats.contexts, buffers: stats.buffers.size, textures: stats.textures.size })
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
const container = document.querySelector('.bh-scene'), labels = document.querySelector('.bh-scene-labels')
let renderer
function mount(count) {
  const snapshot = {
    entities: Array.from({ length: count }, (_, id) => ({ id: `bench-${id}`, name: `Member ${id + 1}`, kind: 'bot', role: '' })),
    groups: [], sessions: [], runs: [],
  }
  const layout = roomLayout(snapshot, { groupId: null })
  labels.replaceChildren(...layout.presences.map((seat, index) => {
    const button = document.createElement('button')
    button.className = 'bh-scene-label'; button.dataset.seat = index
    button.textContent = seat.entity.name
    return button
  }))
  renderer = mountWorld(container, labels, () => {}, () => {}, () => {}, () => { throw Error('WebGL unavailable') })
  renderer.update(layout, null, true)
}
window.runBenchmark = async ({ count = 50, frames = 120 } = {}) => {
  renderer?.dispose()
  mount(count)
  const results = []
  for (const quality of ['low', 'balanced', 'high']) {
    stats.frames = []
    renderer.quality(quality)
    await tick()
    const transition = stats.frames.at(-1)
    for (let i = 0; i < 10; i++) { renderer.key('ArrowRight'); await tick() }
    stats.frames = []
    const intervals = []
    let previous = performance.now()
    for (let i = 0; i < frames; i++) {
      renderer.key(i % 2 ? 'ArrowLeft' : 'ArrowRight')
      await tick()
      const now = performance.now(); intervals.push(now - previous); previous = now
    }
    results.push({
      quality, transition, frames: stats.frames.length,
      cpuP50: percentile(stats.frames.map(f => f.ms), .5), cpuP95: percentile(stats.frames.map(f => f.ms), .95),
      intervalP50: percentile(intervals, .5), intervalP95: percentile(intervals, .95),
      maxDrawCalls: Math.max(...stats.frames.map(f => f.draws)), resources: resources(),
    })
  }
  const first = resources(), history = []
  for (let i = 0; i < 30; i++) {
    renderer.quality('low'); await tick()
    renderer.quality('balanced'); await tick()
    renderer.quality('high'); await tick()
    history.push(resources())
  }
  const rendered = stats.frames.length
  await new Promise(resolve => setTimeout(resolve, 1000))
  const idleFrames = stats.frames.length - rendered
  renderer.dispose(); renderer = null
  const afterDispose = resources()
  const report = { count, viewport: [container.clientWidth, container.clientHeight], dpr: devicePixelRatio,
    gpu: stats.gpu, results, first, qualityCycles: history, idleFrames, afterDispose,
    contextOnlyTextures: stats.contextOnlyTextures }
  document.querySelector('pre').textContent = JSON.stringify(report, null, 2)
  return report
}
