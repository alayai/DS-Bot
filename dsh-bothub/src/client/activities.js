export const characterSeed = id => [...id].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) | 0, 0) >>> 0
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])
export const routeLength = points => points.slice(1).reduce((sum, point, i) => sum + distance(points[i], point), 0)

export function routePoint(points, length) {
  for (let i = 1; i < points.length; i++) {
    const size = distance(points[i - 1], points[i])
    if (length <= size && size > 0) {
      const a = points[i - 1], b = points[i], ratio = Math.max(0, length / size)
      return { x: a[0] + (b[0] - a[0]) * ratio, z: a[1] + (b[1] - a[1]) * ratio,
        angle: Math.atan2(-(b[0] - a[0]), -(b[1] - a[1])), segment: i }
    }
    length -= size
  }
  const last = points.at(-1)
  return { x: last[0], z: last[1], angle: 0, segment: points.length - 1 }
}

// Paths use the reserved aisles between workstation columns and amenity bands.
// They never take a diagonal shortcut through another desk or the snooker table.
export function activityRoute(seat, room, action) {
  const home = [seat.x, seat.z], side = [seat.x + 1.65, seat.z]
  if (action === 'sleep') return [home]
  if (action === 'stretch' || action === 'dumbbell') return [home, [seat.x + .95, seat.z]]
  const back = room.z - room.depth / 2
  const route = [home, side, [side[0], back + (room.groupId === null ? 8.3 : 1.7)]]
  if (room.groupId !== null) return [...route, [room.x + room.width / 2 - 1.7, back + 1.7]]
  route.push([room.x - 6.35, back + 8.3])
  if (action === 'snooker') return [...route, [room.x - 6.35, back + 5.2]]
  return [...route, [room.x - 6.35, back + 1.8], [room.x - 4.05, back + 1.8]]
}

export function createActivity(seat, room, reservations, time = 0) {
  const seed = characterSeed(seat.key)
  let state = seat.state, changed = time, due = time + 4 + seed % 7, serial = 0
  let trip = null, lease = null, last = { x: seat.x, z: seat.z, angle: 0, action: 'sit' }
  const release = () => { if (lease && reservations.get(lease) === seat.key) reservations.delete(lease); lease = null }
  const reset = () => { release(); trip = null; last = { x: seat.x, z: seat.z, angle: 0, action: 'sit' } }
  const startReturn = now => {
    if (!trip || trip.phase === 'return') return
    const path = trip.phase === 'out'
      ? [[last.x, last.z], ...trip.path.slice(0, last.segment).reverse()]
      : [...trip.path].reverse()
    trip = { ...trip, phase: 'return', path, started: now, length: routeLength(path) }
    release()
  }
  return {
    setState(next, now) {
      if (next === state) return
      state = next; changed = now; due = now + 4 + seed % 7
      if (next !== 'idle') startReturn(now)
    },
    step(now, motion) {
      if (motion === 'quiet' || state === 'unknown') { reset(); return { ...last, animate: false } }
      const elapsed = now - changed
      if (motion === 'normal') {
        reset()
        return { ...last, action: state === 'running' && elapsed < 5 ? 'type' : 'sit',
          time: elapsed, animate: state === 'running' && elapsed < 5 }
      }
      if (!trip && state === 'idle' && now >= due) {
        const choices = room.groupId === null
          ? ['water', 'coffee', 'stretch', 'dumbbell', 'sleep', 'snooker']
          : ['water', 'stretch', 'dumbbell', 'sleep']
        let action = choices[(seed + serial++) % choices.length]
        if (action === 'sleep' && elapsed < 60) action = 'stretch'
        if (['water', 'coffee', 'snooker'].includes(action)) {
          const key = JSON.stringify([room.key, action === 'snooker' ? 'snooker' : 'drink'])
          if (reservations.has(key)) action = 'stretch'
          else { reservations.set(key, seat.key); lease = key }
        }
        const path = activityRoute(seat, room, action)
        trip = { action, path, length: routeLength(path), phase: 'out', started: now }
      }
      if (trip) {
        const age = now - trip.started
        if (trip.phase === 'hold') {
          if (age >= (trip.action === 'sleep' ? 18 : 10)) startReturn(now)
        } else if (age * 1.5 >= trip.length) {
          if (trip.phase === 'return') { reset(); due = now + 5 + seed % 5 }
          else { trip.phase = 'hold'; trip.started = now }
        }
      }
      if (trip) {
        if (trip.phase === 'hold') {
          const end = trip.path.at(-1)
          last = { x: end[0], z: end[1], angle: trip.action === 'snooker' ? -Math.PI / 2 : 0,
            action: trip.action, time: now - trip.started }
        } else {
          last = { ...routePoint(trip.path, (now - trip.started) * 1.5), action: 'walk', time: now }
        }
      } else last = { x: seat.x, z: seat.z, angle: 0, action: state === 'running' ? 'type' : 'sit', time: now + seed % 9 }
      return { ...last, counter: room.groupId === null, animate: Boolean(trip) || state === 'running',
        wakeAfter: !trip && state === 'idle' ? Math.max(0, due - now) : null }
    },
    dispose: reset,
  }
}
