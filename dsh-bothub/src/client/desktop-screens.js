import { CanvasTexture, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three'
import { createDesktopPreview } from './desktop-preview.js'

export const screenLabels = {
  standby: 'Standby', loading: 'Connecting', starting: 'Starting desktop',
  live: 'Desktop preview', waiting: 'Waiting for desktop', unavailable: 'Desktop unavailable',
  unsupported: 'Update DS Bot for preview',
}

export function fitDesktop(width, height, targetWidth = 512, targetHeight = 276) {
  const scale = Math.min(targetWidth / width, targetHeight / height)
  return { x: (targetWidth - width * scale) / 2, y: (targetHeight - height * scale) / 2, width: width * scale, height: height * scale }
}

function surface() {
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 276
  const context = canvas.getContext('2d')
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = texture.magFilter = LinearFilter
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false })
  return { canvas, context, texture, material, dispose() { material.dispose(); texture.dispose(); canvas.width = canvas.height = 1 } }
}

function poster(value, label, step = 0) {
  const ctx = value.context
  ctx.fillStyle = '#102733'; ctx.fillRect(0, 0, 512, 276)
  ctx.fillStyle = '#244958'; ctx.fillRect(0, 0, 512, 34)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = ['#eb9a7a', '#e4c979', '#75b8a1'][i]
    ctx.beginPath(); ctx.arc(18 + i * 19, 17, 4, 0, Math.PI * 2); ctx.fill()
  }
  for (let i = 0; i < 7; i++) {
    const line = (i + step) % 7
    ctx.fillStyle = i % 3 === 0 ? '#75b8a1' : '#729bb1'
    ctx.fillRect(28 + line % 3 * 17, 53 + i * 23, 100 + (line * 43) % 230, 7)
  }
  ctx.fillStyle = '#c5e2e7'; ctx.font = '16px sans-serif'
  ctx.fillText(label, 24, 253, 464)
  if (step % 2 === 0) ctx.fillRect(28 + step % 3 * 17, 216, 9, 14)
  value.texture.needsUpdate = true
}

// Static desks stay instanced. Only the thin display surface is independent;
// all appearances of one Bot share a single decoded, downsized texture.
export function createDesktopScreens(invalidate, translate = key => screenLabels[key.slice(7)] ?? key) {
  const group = new Group(), geometry = new PlaneGeometry(.91, .49)
  const posters = new Map(), frames = new Map(), states = new Map()
  let seats = [], disposed = false, lastStep = -1, born = performance.now()
  const point = new Vector3()
  const fallback = state => {
    if (!posters.has(state)) {
      const value = surface()
      poster(value, translate(`screen_${state}`))
      posters.set(state, value)
    }
    return posters.get(state).material
  }
  const assign = id => {
    const material = frames.get(id)?.material ?? fallback(states.get(id) ?? 'standby')
    for (const seat of seats) if (seat.entity.id === id) seat.mesh.material = material
  }
  const clearFrame = id => {
    frames.get(id)?.dispose()
    frames.delete(id)
  }
  const feed = createDesktopPreview({
    async publish(id, event) {
      if (disposed) return
      if (event.frame) {
        const image = new Image()
        const abort = () => { image.src = '' }
        event.signal.addEventListener('abort', abort, { once: true })
        image.src = `data:image/png;base64,${event.frame.data}`
        try {
          await image.decode()
          if (disposed || event.signal.aborted) return
          if (image.naturalWidth !== event.frame.width || image.naturalHeight !== event.frame.height) throw new Error('Desktop size changed')
          const value = frames.get(id) ?? surface()
          frames.set(id, value)
          const box = fitDesktop(image.naturalWidth, image.naturalHeight)
          value.context.fillStyle = '#050b10'; value.context.fillRect(0, 0, 512, 276)
          value.context.drawImage(image, box.x, box.y, box.width, box.height)
          value.texture.needsUpdate = true
        } finally { event.signal.removeEventListener('abort', abort); image.src = '' }
      } else if (event.clear) clearFrame(id)
      states.set(id, event.status)
      // A retained busy frame has an explicit amber indicator.
      if (event.status === 'waiting' && frames.has(id)) {
        const value = frames.get(id)
        value.context.fillStyle = '#102733'; value.context.fillRect(0, 244, 512, 32)
        value.context.fillStyle = '#e4c979'; value.context.font = '16px sans-serif'
        value.context.fillText(translate('screen_waiting'), 12, 266, 480)
        value.texture.needsUpdate = true
      }
      assign(id)
      invalidate()
    },
  })
  return {
    group,
    update(layout) {
      group.clear()
      seats = layout.presences.map(seat => {
        const mesh = new Mesh(geometry, fallback('standby'))
        mesh.position.set(seat.x - .12, 1.36, seat.z - .888)
        mesh.userData = { entityId: seat.entity.id, groupId: seat.groupId, key: seat.key, desktop: seat.entity.kind === 'bot' }
        group.add(mesh)
        return { ...seat, mesh }
      })
      const keep = new Set(seats.map(seat => seat.entity.id))
      for (const id of frames.keys()) if (!keep.has(id)) clearFrame(id)
      for (const id of states.keys()) if (!keep.has(id)) states.delete(id)
      for (const id of keep) assign(id)
    },
    draw(camera, height, selected, live, motion) {
      const candidates = new Map()
      if (live && !document.hidden) for (const seat of seats) {
        if (seat.entity.kind !== 'bot') continue
        point.copy(seat.mesh.position).project(camera)
        if (Math.abs(point.x) > 1.1 || Math.abs(point.y) > 1.1 || Math.abs(point.z) >= 1
          || camera.position.z <= seat.mesh.position.z) continue
        const distance = camera.position.distanceTo(seat.mesh.position)
        const size = height * .49 / (2 * Math.tan(camera.fov * Math.PI / 360) * distance)
        if (size < 8) continue
        const priority = (seat.key === selected ? 10000 : 0) + size
        candidates.set(seat.entity.id, Math.max(candidates.get(seat.entity.id) ?? 0, priority))
      }
      feed.targets([...candidates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([id]) => id))
      const animate = live && !document.hidden && (motion === 'lively' || motion === 'normal' && performance.now() - born < 5000)
      const step = animate ? Math.floor((performance.now() - born) / 400) % 14 : 0
      if (step !== lastStep) {
        for (const [state, value] of posters) poster(value, translate(`screen_${state}`), step)
        lastStep = step
      }
      return animate && seats.some(seat => !frames.has(seat.entity.id))
    },
    status(id) { return states.get(id) ?? 'standby' },
    pause() { feed.targets([]) },
    dispose() {
      disposed = true
      feed.dispose()
      for (const value of frames.values()) value.dispose()
      for (const value of posters.values()) value.dispose()
      frames.clear(); posters.clear(); states.clear()
      group.clear(); seats = []; geometry.dispose()
    },
  }
}
