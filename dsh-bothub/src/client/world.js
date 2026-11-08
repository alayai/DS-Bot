import { createElement as h, useEffect, useRef } from 'react'
import {
  AmbientLight, BoxGeometry, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight,
  Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene as World,
  SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { entityState } from './model.js'

const hash = id => [...id].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) | 0, 0) >>> 0

// Renderer state never enters React. A frame is requested only for data, size,
// selection or camera changes; hidden pages have no drawing loop.
export function mountWorld(container, labels, onSelect, onError) {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  container.prepend(canvas)
  let renderer
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    canvas.remove()
    onError()
    return { update() {}, reset() {}, dispose() {} }
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  const world = new World()
  const camera = new PerspectiveCamera(40, 1, .1, 300)
  world.add(new AmbientLight(0xffffff, 1.3))
  const light = new DirectionalLight(0xffffff, 2)
  light.position.set(4, 10, 6)
  world.add(light)
  const geometry = {
    body: new CapsuleGeometry(.24, .38, 4, 10),
    head: new SphereGeometry(.28, 12, 8),
    eye: new SphereGeometry(.035, 8, 6),
    desk: new CylinderGeometry(.76, .84, .14, 6),
    ring: new CylinderGeometry(.88, .88, .045, 32),
    marker: new SphereGeometry(.09, 10, 8),
    floor: new BoxGeometry(1, .12, 1),
  }
  const materials = new Set()
  const material = color => {
    const value = new MeshStandardMaterial({ color, roughness: .65 })
    materials.add(value)
    return value
  }
  const ink = material(0x192237)
  const floorMaterial = material(0xc8d3e5)
  const platformMaterial = material(0xe8edf8)
  const selectedMaterial = material(0x4d6bfe)
  const green = material(0x00c972)
  const neutral = material(0x9aa6ba)
  const floor = new Mesh(geometry.floor, floorMaterial)
  floor.position.y = -.18
  world.add(floor)
  const members = new Map()
  let entities = []
  let selected = null
  let angle = .45
  let elevation = .82
  let distance = 11
  let baseDistance = 11
  let frame = 0
  let disposed = false
  let down = null
  const ray = new Raycaster()
  const pointer = new Vector2()
  const projected = new Vector3()
  const target = new Vector3()
  const draw = () => {
    frame = 0
    if (disposed || document.hidden) return
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    camera.position.set(
      target.x + Math.sin(angle) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      target.z + Math.cos(angle) * Math.cos(elevation) * distance,
    )
    camera.lookAt(target)
    renderer.setSize(width, height, false)
    renderer.render(world, camera)
    for (const entity of entities) {
      const item = members.get(entity.id)
      const label = labels.querySelector(`[data-key="${entity.index}"]`)
      if (!item || !label) continue
      projected.copy(item.group.position).add(new Vector3(0, 1.5, 0)).project(camera)
      label.style.display = projected.z < 1 && projected.z > -1 ? '' : 'none'
      label.style.transform = `translate(${(projected.x + 1) * width / 2}px,${(1 - projected.y) * height / 2}px) translate(-50%,-100%)`
    }
  }
  const invalidate = () => {
    if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(draw)
  }
  const resize = new ResizeObserver(invalidate)
  resize.observe(container)
  const makeMember = entity => {
    const group = new Group()
    const color = new Color().setHSL((hash(entity.id) % 360) / 360, .48, .62)
    const bodyMaterial = material(color)
    const pedestal = new Mesh(geometry.desk, platformMaterial)
    const ring = new Mesh(geometry.ring, selectedMaterial)
    ring.position.y = -.07
    const body = new Mesh(geometry.body, bodyMaterial)
    body.position.y = .52
    const head = new Mesh(geometry.head, bodyMaterial)
    head.position.set(0, 1.01, .02)
    const marker = new Mesh(geometry.marker, neutral)
    marker.position.set(.55, .16, .35)
    group.add(pedestal, ring, body, head, marker)
    for (const x of [-.1, .1]) {
      const eye = new Mesh(geometry.eye, ink)
      eye.position.set(x, 1.04, .27)
      group.add(eye)
    }
    group.traverse(child => { child.userData.entityId = entity.id })
    world.add(group)
    return { group, ring, marker, bodyMaterial }
  }
  const update = (next, snapshot, selectedId) => {
    selected = selectedId
    entities = next.slice(0, 50).map((entity, index) => ({ ...entity, index }))
    const keep = new Set(entities.map(entity => entity.id))
    for (const [id, item] of members) if (!keep.has(id)) {
      world.remove(item.group)
      item.bodyMaterial.dispose()
      materials.delete(item.bodyMaterial)
      members.delete(id)
    }
    const columns = Math.max(2, Math.ceil(Math.sqrt(entities.length)))
    const rows = Math.max(1, Math.ceil(entities.length / columns))
    floor.scale.set(columns * 2.4 + 1.5, 1, rows * 2.6 + 1.5)
    baseDistance = Math.max(10, columns * 3.5, rows * 3.5)
    if (members.size === 0) distance = baseDistance
    entities.forEach((entity, index) => {
      const item = members.get(entity.id) ?? makeMember(entity)
      members.set(entity.id, item)
      item.group.position.set((index % columns - (columns - 1) / 2) * 2.4, 0, (Math.floor(index / columns) - (rows - 1) / 2) * 2.6)
      item.ring.visible = entity.id === selected
      const status = entityState(entity, snapshot)
      item.marker.material = status === 'running' ? green : status === 'attention' ? selectedMaterial : neutral
    })
    const styles = getComputedStyle(container)
    const color = styles.getPropertyValue('--bh-accent').trim()
    if (color && !color.includes('var(')) selectedMaterial.color.setStyle(color)
    invalidate()
  }
  const pointerDown = event => {
    if (event.button !== 0) return
    down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false }
    canvas.setPointerCapture(event.pointerId)
  }
  const pointerMove = event => {
    if (!down) return
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down.moved = true
    if (down.moved) {
      angle -= (event.clientX - down.lastX) * .006
      elevation = Math.max(.25, Math.min(1.35, elevation + (event.clientY - down.lastY) * .005))
      invalidate()
    }
    down.lastX = event.clientX
    down.lastY = event.clientY
  }
  const pointerUp = event => {
    if (down && !down.moved) {
      const rect = canvas.getBoundingClientRect()
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
      ray.setFromCamera(pointer, camera)
      const hit = ray.intersectObjects([...members.values()].map(item => item.group), true)[0]
      if (hit) onSelect(hit.object.userData.entityId)
    }
    down = null
  }
  const cancel = () => { down = null }
  const wheel = event => {
    event.preventDefault()
    distance = Math.max(4, Math.min(80, distance * Math.exp(event.deltaY * .001)))
    invalidate()
  }
  const visibility = () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0 }
    else invalidate()
  }
  const lost = event => { event.preventDefault(); onError() }
  canvas.addEventListener('pointerdown', pointerDown)
  canvas.addEventListener('pointermove', pointerMove)
  canvas.addEventListener('pointerup', pointerUp)
  canvas.addEventListener('pointercancel', cancel)
  canvas.addEventListener('wheel', wheel, { passive: false })
  canvas.addEventListener('webglcontextlost', lost)
  document.addEventListener('visibilitychange', visibility)
  return {
    update,
    reset() { angle = .45; elevation = .82; distance = baseDistance; target.set(0, 0, 0); invalidate() },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('webglcontextlost', lost)
      for (const value of Object.values(geometry)) value.dispose()
      for (const value of materials) value.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      members.clear()
    },
  }
}

export function Scene({ entities, snapshot, selected, onSelect, onError, t }) {
  const container = useRef(null)
  const labels = useRef(null)
  const renderer = useRef(null)
  const actions = useRef({ onSelect, onError })
  actions.current = { onSelect, onError }
  useEffect(() => {
    const value = mountWorld(container.current, labels.current, id => actions.current.onSelect(id), () => actions.current.onError())
    renderer.current = value
    return () => { value.dispose(); renderer.current = null }
  }, [])
  useEffect(() => { renderer.current?.update(entities, snapshot, selected) }, [entities, snapshot, selected])
  return h('div', { className: 'bh-scene', ref: container, 'aria-label': t('scene') },
    h('div', { className: 'bh-scene-labels', ref: labels },
      ...entities.slice(0, 50).map((entity, index) => {
        const state = entityState(entity, snapshot)
        return h('button', {
          key: entity.id, type: 'button', className: 'bh-scene-label', 'data-key': index,
          'aria-pressed': selected === entity.id, onClick: () => onSelect(entity.id),
        }, h('strong', null, entity.name),
        h('span', { className: `bh-status bh-${state}` }, h('i'), t(state === 'attention' ? 'attentionState' : state)))
      })),
    h('div', { className: 'bh-scene-controls' }, h('button', { type: 'button', className: 'bh-button', onClick: () => renderer.current?.reset() }, t('overview'))),
    h('div', { className: 'bh-scene-help' }, t(entities.length > 50 ? 'limit' : 'sceneHelp')))
}
