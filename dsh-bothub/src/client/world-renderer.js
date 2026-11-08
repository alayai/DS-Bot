import {
  ACESFilmicToneMapping, HemisphereLight, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight,
  Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene as World,
  PCFSoftShadowMap, SphereGeometry, TorusGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { presenceKey } from './rooms.js'
import { cameraFrame, createCameraState } from './camera.js'
import { createOfficeAssets, createOfficeEnvironment } from './furniture.js'
import { roomFixtures } from './office-layout.js'
import { arrangeLabels } from './labels.js'
import { createActivity, characterSeed } from './activities.js'
import { createCharacter } from './character.js'
import { normalizeMotion, normalizeQuality, qualitySettings } from './scene-settings.js'
import { createDesktopScreens } from './desktop-screens.js'


// Renderer state never enters React. A frame is requested only for data, size,
// selection or camera changes, and bounded motion frames; hidden pages do not draw.
export function mountWorld(container, labels, onSelect, onFocus, onClear, onError, translate, onDesktop) {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  container.prepend(canvas)
  let renderer
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    canvas.remove()
    onError()
    return { update() {}, quality() {}, motion() {}, reset() {}, key() {}, dispose() {} }
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  renderer.shadowMap.autoUpdate = false
  const world = new World()
  const camera = new PerspectiveCamera(40, 1, .1, 1000)
  const ambient = new HemisphereLight(0xf5f7ff, 0x9a8f7e, 2)
  world.add(ambient)
  const light = new DirectionalLight(0xfff0d6, 3)
  light.castShadow = true
  light.shadow.mapSize.set(2048, 2048)
  light.shadow.normalBias = .035
  light.shadow.bias = -.00015
  world.add(light)
  world.add(light.target)
  const office = createOfficeAssets()
  let environment = null
  const geometry = {
    body: new CapsuleGeometry(.21, .22, 4, 10),
    head: new SphereGeometry(.26, 16, 12),
    eye: new SphereGeometry(.035, 8, 6),
    limb: new CylinderGeometry(1, 1, 1, 8),
    ring: new TorusGeometry(.61, .025, 8, 40),
    marker: new SphereGeometry(.09, 10, 8),
  }
  const materials = new Set()
  const material = color => {
    const value = new MeshStandardMaterial({ color, roughness: .65 })
    materials.add(value)
    return value
  }
  const ink = material(0x192237)
  const selectedMaterial = material(0x4d6bfe)
  const green = material(0x00c972)
  const neutral = material(0x9aa6ba)
  const members = new Map()
  let layout = { rooms: [], presences: [], width: 8, depth: 8 }
  let selected = null
  const view = createCameraState()
  let layoutKey = ''
  let frame = 0, wake = 0, sceneTime = 0, lastDraw = performance.now()
  let motionLevel = 'normal', connected = true, previewEnabled = true
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const reservations = new Map()
  let disposed = false
  let down = null
  let currentQuality = null
  let themeKey = ''
  const ray = new Raycaster()
  const pointer = new Vector2()
  const projected = new Vector3()
  const target = new Vector3()
  const draw = () => {
    frame = 0
    if (disposed || document.hidden) return
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) { screens.pause(); return }
    const now = performance.now(), elapsed = Math.max(0, (now - lastDraw) / 1000), dt = Math.min(.1, elapsed)
    lastDraw = now; sceneTime += elapsed
    let animated = false, wakeAfter = Infinity
    for (const item of members.values()) {
      item.pose = item.activity.step(sceneTime, reduced.matches || !connected ? 'quiet' : motionLevel)
      animated ||= item.pose.animate
      if (item.pose.wakeAfter != null) wakeAfter = Math.min(wakeAfter, item.pose.wakeAfter)
      item.rig.group.position.set(item.pose.x - item.seat.x, 0, item.pose.z - item.seat.z)
      const delta = Math.atan2(Math.sin(item.pose.angle - item.rig.group.rotation.y), Math.cos(item.pose.angle - item.rig.group.rotation.y))
      item.rig.group.rotation.y += delta * (1 - Math.exp(-dt * 18))
      if (reduced.matches || motionLevel === 'quiet' || !connected) item.rig.group.rotation.y = 0
      item.rig.update(item.pose, !item.pose.animate ? 1 : dt)
    }
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const pose = view.position(camera.aspect)
    const actor = members.get(selected)
    const offsetX = actor ? actor.pose.x - actor.seat.x : 0, offsetZ = actor ? actor.pose.z - actor.seat.z : 0
    target.fromArray(pose.center); target.x += offsetX; target.z += offsetZ
    camera.position.fromArray(pose.eye); camera.position.x += offsetX; camera.position.z += offsetZ
    camera.lookAt(target)
    camera.updateMatrixWorld()
    const screenMotion = screens.draw(camera, height, selected, connected && previewEnabled, reduced.matches ? 'quiet' : motionLevel)
    if (screenMotion) wakeAfter = Math.min(wakeAfter, .4)
    renderer.setSize(width, height, false)
    renderer.render(world, camera)
    const candidates = []
    const positionLabel = (label, x, y, z, priority = 0) => {
      if (!label) return
      projected.set(x, y, z).project(camera)
      const focused = label === document.activeElement
      candidates.push({
        label, x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2,
        width: label.offsetWidth, height: label.offsetHeight,
        inView: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) < 1,
        focused, priority: focused ? 1000 : priority,
      })
    }
    layout.presences.forEach((presence, index) => {
      const item = members.get(presence.key), label = labels.querySelector(`[data-seat="${index}"]`)
      const cue = label?.querySelector('[data-activity]')
      if (cue && cue.dataset.activity !== item.pose.action) {
        cue.dataset.activity = item.pose.action
        cue.textContent = ({ type: '⌨ · 💧', water: '💧', coffee: '☕', stretch: '↔', dumbbell: '🏋', sleep: 'Zzz', snooker: '🎱', walk: '…' })[item.pose.action] ?? ''
      }
      const desktop = label?.querySelector('[data-desktop]')
      if (desktop) {
        const status = screens.status(presence.entity.id)
        desktop.dataset.desktop = status
        desktop.textContent = status === 'standby' ? '' : translate?.(`screen_${status}`) ?? status
      }
      positionLabel(label, item.pose.x, 2.15, item.pose.z + .3,
        presence.key === selected ? 100 : presence.state === 'attention' ? 30 : presence.state === 'running' ? 20 : 10)
    })
    layout.rooms.forEach((room, index) =>
      positionLabel(labels.querySelector(`[data-room="${index}"]`), room.x, 3.1, room.z - room.depth / 2 + .3, 40))
    if (layout.rooms.length === 1 && layout.rooms[0].groupId === null) {
      const room = layout.rooms[0]
      roomFixtures(room).forEach((fixture, index) => {
        const dx = fixture.kind === 'snooker' ? -1.8 : fixture.kind === 'fitness' ? 2.4 : 0
        const dz = fixture.kind === 'lounge' ? -1.9 : fixture.kind === 'coffee' ? 1 : 0
        positionLabel(labels.querySelector(`[data-fixture="${index}"]`), room.x + fixture.x + dx, .1, room.z + fixture.z + dz)
      })
    }
    for (const item of arrangeLabels(candidates, width, height)) {
      item.label.classList.toggle('bh-label-muted', item.hidden)
      item.label.style.transform = `translate(${item.left}px,${item.top}px)`
    }
    if (animated || Number.isFinite(wakeAfter)) {
      wake = setTimeout(() => { wake = 0; invalidate() },
        animated ? 1000 / qualitySettings(currentQuality).fps : Math.max(16, wakeAfter * 1000))
    }
  }
  const invalidate = () => {
    clearTimeout(wake); wake = 0
    if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(draw)
  }
  const screens = createDesktopScreens(invalidate, translate)
  world.add(screens.group)
  const resize = new ResizeObserver(invalidate)
  resize.observe(container)
  const theme = () => {
    const styles = getComputedStyle(container)
    const value = name => styles.getPropertyValue(name).trim()
    const background = value('--bh-bg') || '#fafbfe', card = value('--bh-card') || '#f0f3f9'
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    const accent = value('--bh-accent'), working = value('--bh-green'), muted = value('--bh-muted')
    const key = JSON.stringify([background, card, dark, accent, working, muted])
    if (key === themeKey) return
    themeKey = key
    office.theme({ background, card, dark })
    if (accent) selectedMaterial.color.setStyle(accent)
    if (working) green.color.setStyle(working)
    if (muted) neutral.color.setStyle(muted)
    ambient.intensity = dark ? 1.3 : 2
    light.intensity = dark ? 1.8 : 3
    renderer.toneMappingExposure = dark ? .95 : 1.15
    invalidate()
  }
  const themeObserver = new MutationObserver(theme)
  for (const node of [document.documentElement, document.body]) {
    themeObserver.observe(node, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
  }
  // Custom accent/theme styles can change without changing the dark-mode marker.
  themeObserver.observe(document.head, { subtree: true, childList: true, characterData: true })
  const quality = value => {
    const name = normalizeQuality(value)
    if (name === currentQuality) return
    currentQuality = name
    const settings = qualitySettings(name)
    light.shadow.dispose()
    light.shadow.map = light.shadow.mapPass = null
    light.shadow.mapSize.set(settings.shadow || 1, settings.shadow || 1)
    renderer.shadowMap.enabled = Boolean(settings.shadow)
    renderer.shadowMap.needsUpdate = Boolean(settings.shadow)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.ratio))
    invalidate()
  }
  const makeMember = presence => {
    const { entity, groupId, key } = presence
    const group = new Group()
    const color = new Color().setHSL((characterSeed(entity.id) % 360) / 360, .48, .62)
    const bodyMaterial = material(color)
    const ring = new Mesh(geometry.ring, selectedMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(0, .025, .4)
    const rig = createCharacter(geometry, bodyMaterial, ink, office)
    const marker = new Mesh(geometry.marker, neutral)
    marker.position.set(1.02, .99, -.24)
    rig.group.add(ring)
    group.add(rig.group, marker)
    group.traverse(child => {
      child.userData = { entityId: entity.id, groupId, key }
      // Moving rigs do not enter the cached static shadow map.
    })
    world.add(group)
    return { group, ring, marker, bodyMaterial, rig }
  }
  const update = (next, selection, focused, live = true, preview = true) => {
    connected = live
    previewEnabled = preview
    if (!connected || !previewEnabled) screens.pause()
    layout = next
    const updateTime = sceneTime + (document.hidden ? 0 : Math.max(0, (performance.now() - lastDraw) / 1000))
    selected = selection?.groupId !== undefined ? presenceKey(selection.entityId, selection.groupId) : null
    view.update(cameraFrame(layout, selection, focused))
    const nextKey = JSON.stringify([
      layout.rooms.map(room => [room.key, room.width, room.depth, room.x, room.z]),
      layout.presences.map(seat => [seat.key, seat.x, seat.z]),
    ])
    const rearranged = layoutKey !== nextKey
    if (rearranged) {
      if (environment) { world.remove(environment.group); environment.dispose() }
      environment = createOfficeEnvironment(layout, office)
      world.add(environment.group)
      screens.update(layout)
      const extent = Math.max(layout.width, layout.depth)
      light.position.set(-extent * .35, extent * .9, extent * .45)
      Object.assign(light.shadow.camera, { left: -extent * .7, right: extent * .7, top: extent * .7, bottom: -extent * .7, near: .5, far: extent * 3 })
      light.shadow.camera.updateProjectionMatrix()
      renderer.shadowMap.needsUpdate = true
      layoutKey = nextKey
    }
    const keep = new Set(layout.presences.map(presence => presence.key))
    for (const [id, item] of members) if (!keep.has(id)) {
      world.remove(item.group)
      item.activity.dispose()
      item.bodyMaterial.dispose()
      materials.delete(item.bodyMaterial)
      members.delete(id)
    }
    layout.presences.forEach(presence => {
      const item = members.get(presence.key) ?? makeMember(presence)
      members.set(presence.key, item)
      if (!item.activity || rearranged) {
        item.activity?.dispose()
        item.activity = createActivity(presence, layout.rooms.find(room => room.groupId === presence.groupId), reservations, updateTime)
      }
      item.seat = presence
      item.activity.setState(connected ? presence.state : 'unknown', updateTime)
      item.group.position.set(presence.x, 0, presence.z)
      item.ring.visible = presence.key === selected
      item.marker.material = presence.state === 'running' ? green : presence.state === 'attention' ? selectedMaterial : neutral
    })
    theme()
    invalidate()
  }
  const pointerDown = event => {
    if (event.button !== 0) return
    container.focus({ preventScroll: true })
    down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false }
    canvas.setPointerCapture(event.pointerId)
  }
  const pointerMove = event => {
    if (!down) return
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down.moved = true
    if (down.moved) {
      view.orbit(-(event.clientX - down.lastX) * .006, (event.clientY - down.lastY) * .005)
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
      const hit = ray.intersectObjects([...members.values()].map(item => item.group).concat(environment?.group ?? [], screens.group), true)[0]
      const subject = hit && (hit.object.userData.targets?.[hit.instanceId] ?? hit.object.userData)
      if (subject?.desktop && onDesktop) {
        container.focus({ preventScroll: true })
        onDesktop(subject.entityId, subject.groupId)
      } else if (subject?.entityId) onSelect(subject.entityId, subject.groupId)
      else if (subject?.room) onFocus(subject.groupId)
      else onClear()
    }
    down = null
  }
  const cancel = () => { down = null }
  const wheel = event => {
    event.preventDefault()
    view.scale(Math.exp(event.deltaY * .001))
    invalidate()
  }
  const visibility = () => {
    clearTimeout(wake); wake = 0
    lastDraw = performance.now()
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; screens.pause() }
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
  reduced.addEventListener('change', invalidate)
  labels.addEventListener('focusin', invalidate)
  labels.addEventListener('focusout', invalidate)
  quality('balanced')
  return {
    update,
    quality,
    motion(value) { motionLevel = normalizeMotion(value); invalidate() },
    reset() { view.reset(); invalidate() },
    key(key) {
      if (key === 'ArrowLeft') view.orbit(-.12, 0)
      else if (key === 'ArrowRight') view.orbit(.12, 0)
      else if (key === 'ArrowUp') view.orbit(0, .08)
      else if (key === 'ArrowDown') view.orbit(0, -.08)
      else if (key === '+' || key === '=') view.scale(.9)
      else if (key === '-' || key === '_') view.scale(1 / .9)
      else if (key === 'Home') view.reset()
      else return false
      invalidate()
      return true
    },
    dispose() {
      disposed = true
      screens.dispose()
      cancelAnimationFrame(frame)
      clearTimeout(wake)
      reduced.removeEventListener('change', invalidate)
      for (const item of members.values()) item.activity.dispose()
      reservations.clear()
      resize.disconnect()
      themeObserver.disconnect()
      labels.removeEventListener('focusin', invalidate)
      labels.removeEventListener('focusout', invalidate)
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('webglcontextlost', lost)
      for (const value of Object.values(geometry)) value.dispose()
      for (const value of materials) value.dispose()
      environment?.dispose()
      office.dispose()
      light.shadow.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      members.clear()
    },
  }
}
