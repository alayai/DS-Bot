import { createElement as h, useEffect, useRef } from 'react'
import {
  AmbientLight, BoxGeometry, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight,
  Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene as World,
  SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { presenceKey } from './rooms.js'

const hash = id => [...id].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) | 0, 0) >>> 0

// Renderer state never enters React. A frame is requested only for data, size,
// selection or camera changes; hidden pages have no drawing loop.
export function mountWorld(container, labels, onSelect, onFocus, onError) {
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
  const camera = new PerspectiveCamera(40, 1, .1, 1000)
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
    wall: new BoxGeometry(1, 1, 1),
  }
  const materials = new Set()
  const material = color => {
    const value = new MeshStandardMaterial({ color, roughness: .65 })
    materials.add(value)
    return value
  }
  const ink = material(0x192237)
  const floorMaterial = material(0xc8d3e5)
  const wallMaterial = material(0xb0bed5)
  const platformMaterial = material(0xe8edf8)
  const selectedMaterial = material(0x4d6bfe)
  const green = material(0x00c972)
  const neutral = material(0x9aa6ba)
  const members = new Map()
  const spaces = new Map()
  let layout = { rooms: [], presences: [], width: 8, depth: 8 }
  let selected = null
  let angle = .45
  let elevation = .82
  let zoom = 1
  let layoutKey = ''
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
    const radius = Math.hypot(layout.width, layout.depth) / 2
    const halfFov = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect))
    const distance = Math.max(10, radius / Math.sin(halfFov)) * zoom
    camera.position.set(
      target.x + Math.sin(angle) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      target.z + Math.cos(angle) * Math.cos(elevation) * distance,
    )
    camera.lookAt(target)
    renderer.setSize(width, height, false)
    renderer.render(world, camera)
    const positionLabel = (label, x, y, z) => {
      if (!label) return
      projected.set(x, y, z).project(camera)
      label.style.display = projected.z < 1 && projected.z > -1 ? '' : 'none'
      label.style.transform = `translate(${(projected.x + 1) * width / 2}px,${(1 - projected.y) * height / 2}px) translate(-50%,-100%)`
    }
    layout.presences.forEach((presence, index) =>
      positionLabel(labels.querySelector(`[data-seat="${index}"]`), presence.x, 1.5, presence.z))
    layout.rooms.forEach((room, index) =>
      positionLabel(labels.querySelector(`[data-room="${index}"]`), room.x, layout.rooms.length > 1 ? 3 : .9, room.z - room.depth / 2 + .3))
  }
  const invalidate = () => {
    if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(draw)
  }
  const resize = new ResizeObserver(invalidate)
  resize.observe(container)
  const makeMember = presence => {
    const { entity, groupId, key } = presence
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
    group.traverse(child => { child.userData = { entityId: entity.id, groupId, key } })
    world.add(group)
    return { group, ring, marker, bodyMaterial }
  }
  const makeRoom = room => {
    const group = new Group()
    group.position.set(room.x, 0, room.z)
    const floor = new Mesh(geometry.floor, floorMaterial)
    floor.scale.set(room.width, 1, room.depth)
    floor.position.y = -.18
    group.add(floor)
    // Low cutaway walls leave every seat visible from the overview camera.
    for (const [x, z, width, depth] of [
      [0, -room.depth / 2, room.width, .14],
      [-room.width / 2, 0, .14, room.depth],
      [room.width / 2, 0, .14, room.depth],
    ]) {
      const wall = new Mesh(geometry.wall, wallMaterial)
      wall.scale.set(width, .6, depth)
      wall.position.set(x, .06, z)
      group.add(wall)
    }
    group.traverse(child => { child.userData = { room: true, groupId: room.groupId } })
    world.add(group)
    return group
  }
  const update = (next, selection) => {
    layout = next
    selected = selection && presenceKey(selection.entityId, selection.groupId)
    const nextKey = JSON.stringify(layout.rooms.map(room => [room.key, room.width, room.depth, room.x, room.z]))
    if (layoutKey !== nextKey) {
      for (const group of spaces.values()) world.remove(group)
      spaces.clear()
      for (const room of layout.rooms) spaces.set(room.key, makeRoom(room))
      layoutKey = nextKey
      zoom = 1
    }
    const keep = new Set(layout.presences.map(presence => presence.key))
    for (const [id, item] of members) if (!keep.has(id)) {
      world.remove(item.group)
      item.bodyMaterial.dispose()
      materials.delete(item.bodyMaterial)
      members.delete(id)
    }
    layout.presences.forEach(presence => {
      const item = members.get(presence.key) ?? makeMember(presence)
      members.set(presence.key, item)
      item.group.position.set(presence.x, 0, presence.z)
      item.ring.visible = presence.key === selected
      item.marker.material = presence.state === 'running' ? green : presence.state === 'attention' ? selectedMaterial : neutral
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
      if (hit) onSelect(hit.object.userData.entityId, hit.object.userData.groupId)
      else {
        const room = ray.intersectObjects([...spaces.values()], true)[0]
        if (room) onFocus(room.object.userData.groupId)
      }
    }
    down = null
  }
  const cancel = () => { down = null }
  const wheel = event => {
    event.preventDefault()
    zoom = Math.max(.3, Math.min(2, zoom * Math.exp(event.deltaY * .001)))
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
    reset() { angle = .45; elevation = .82; zoom = 1; target.set(0, 0, 0); invalidate() },
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
      spaces.clear()
    },
  }
}

export function Scene({ layout, selected, onSelect, onFocus, onOverview, focused, onError, t }) {
  const container = useRef(null)
  const labels = useRef(null)
  const renderer = useRef(null)
  const actions = useRef({ onSelect, onFocus, onError })
  actions.current = { onSelect, onFocus, onError }
  useEffect(() => {
    const value = mountWorld(container.current, labels.current,
      (id, groupId) => actions.current.onSelect(id, groupId), groupId => actions.current.onFocus(groupId),
      () => actions.current.onError())
    renderer.current = value
    return () => { value.dispose(); renderer.current = null }
  }, [])
  useEffect(() => { renderer.current?.update(layout, selected) }, [layout, selected])
  return h('div', {
    className: 'bh-scene', ref: container, 'aria-label': t('scene'),
    onKeyDown: event => {
      if (event.key === 'Escape') { onOverview(); renderer.current?.reset() }
    },
  },
    h('div', { className: 'bh-scene-labels', ref: labels },
      ...layout.rooms.map((room, index) => h('button', {
        key: room.key, type: 'button', className: 'bh-scene-label bh-room-label', 'data-room': index,
        'data-space': room.key, 'aria-label': `${t('enterRoom')}: ${room.name ?? t('publicSpace')}`,
        onClick: () => onFocus(room.groupId),
      }, h('strong', null, room.name ?? t('publicSpace')),
      h('span', null, `${room.total} ${t('members')}`))),
      ...layout.presences.map(({ entity, groupId, key, state }, index) => {
        return h('button', {
          key, type: 'button', className: 'bh-scene-label', 'data-seat': index,
          'data-entity': entity.id, 'data-space': JSON.stringify(groupId),
          'aria-label': `${entity.name} · ${layout.rooms.find(room => room.groupId === groupId)?.name ?? t('publicSpace')}`,
          'aria-pressed': selected?.entityId === entity.id && selected?.groupId === groupId,
          onClick: () => onSelect(entity.id, groupId),
        }, h('strong', null, entity.name),
        h('span', { className: `bh-status bh-${state}` }, h('i'), t(state === 'attention' ? 'attentionState' : state)))
      })),
    h('div', { className: 'bh-scene-controls' },
      focused && h('button', { type: 'button', className: 'bh-button', onClick: onOverview }, t('allRooms')),
      h('button', { type: 'button', className: 'bh-button', onClick: () => renderer.current?.reset() }, t('overview'))),
    h('div', { className: 'bh-scene-help' }, t(layout.truncated ? 'roomLimit' : 'roomHelp')))
}
