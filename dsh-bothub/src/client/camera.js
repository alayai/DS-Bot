import { presenceKey } from './rooms.js'

export function cameraFrame(layout, selection, focused) {
  // Undefined is an aggregate 2D selection, not a common-area seat.
  const seat = selection?.groupId !== undefined && layout.presences.find(item =>
    item.key === presenceKey(selection.entityId, selection.groupId))
  if (seat) return { key: `member:${seat.key}`, center: [seat.x, .85, seat.z - .2], radius: 2.3 }
  const room = focused && layout.rooms[0]
  if (room) return { key: `room:${room.key}`, center: [room.x, 0, room.z], radius: Math.hypot(room.width, room.depth) / 2 }
  return { key: 'overview', center: [0, 0, 0], radius: Math.hypot(layout.width, layout.depth) / 2 }
}

export function createCameraState() {
  let frame = { key: '', center: [0, 0, 0], radius: 5 }
  let angle, elevation, zoom
  const reset = () => { angle = .45; elevation = .82; zoom = 1 }
  reset()
  return {
    update(next) {
      if (next.key !== frame.key) reset()
      frame = next
    },
    reset,
    orbit(dx, dy) {
      angle += dx
      elevation = Math.max(.25, Math.min(1.35, elevation + dy))
    },
    scale(factor) { zoom = Math.max(.3, Math.min(2, zoom * factor)) },
    position(aspect) {
      const halfFov = Math.min(Math.PI / 9, Math.atan(Math.tan(Math.PI / 9) * aspect))
      const distance = Math.max(4, frame.radius / Math.sin(halfFov)) * zoom
      const [x, y, z] = frame.center
      return {
        center: frame.center,
        eye: [x + Math.sin(angle) * Math.cos(elevation) * distance,
          y + Math.sin(elevation) * distance,
          z + Math.cos(angle) * Math.cos(elevation) * distance],
      }
    },
  }
}

export function allowsShortcut(event) {
  return !event.defaultPrevented && !event.isComposing && !event.nativeEvent?.isComposing
    && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey
    && !event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
}
