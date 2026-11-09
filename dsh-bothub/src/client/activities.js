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

const UNNOTICED_IDLE = 60

// Low bits of sequential ids stay sequential after the string hash. Mix them
// so neighbours do not share a start time or the same rest between outings.
const mixDelay = (seed, salt) => {
  let value = Math.imul(seed ^ Math.imul(salt + 1, 0x85EBCA6B), 0x9E3779B1) >>> 0
  value = (value ^ (value >>> 16)) >>> 0
  return 4 + (value % 46)
}

export function createActivity(seat, room, reservations, time = 0) {
  const seed = characterSeed(seat.key)
  let state = seat.state, changed = time, serial = 0
  let trip = null, lease = null, last = { x: seat.x, z: seat.z, angle: 0, action: 'sit' }
  const release = () => { if (lease && reservations.get(lease) === seat.key) reservations.delete(lease); lease = null }
  const reset = () => { release(); trip = null; last = { x: seat.x, z: seat.z, angle: 0, action: 'sit' } }
  const wait = next => (next === 'unknown' ? UNNOTICED_IDLE : 0) + mixDelay(seed, serial)
  let due = time + wait(state)
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
      state = next; changed = now; due = now + wait(next)
      if (next !== 'idle') startReturn(now)
    },
    step(now, motion) {
      if (motion === 'quiet') { reset(); return { ...last, animate: false } }
      const elapsed = now - changed
      // Unobserved members keep their real status. After a minute the lively scene treats them as idle.
      const settled = state === 'unknown' && elapsed >= UNNOTICED_IDLE
      const idleLike = state === 'idle' || settled
      const idleFor = settled ? elapsed - UNNOTICED_IDLE : elapsed
      if (motion === 'normal' || (state === 'unknown' && !settled)) {
        reset()
        const typing = motion === 'normal' && state === 'running' && elapsed < 5
        return { ...last, action: typing ? 'type' : 'sit', time: elapsed, animate: typing,
          wakeAfter: motion === 'normal' ? null : Math.max(0, UNNOTICED_IDLE - elapsed) }
      }
      if (!trip && idleLike && now >= due) {
        const choices = room.groupId === null
          ? ['water', 'coffee', 'stretch', 'dumbbell', 'sleep', 'snooker']
          : ['water', 'stretch', 'dumbbell', 'sleep']
        let action = choices[(seed + serial++) % choices.length]
        if (action === 'sleep' && idleFor < 60) action = 'stretch'
        if (['water', 'coffee', 'snooker'].includes(action)) {
          const key = JSON.stringify([room.key, action === 'snooker' ? 'snooker' : 'drink'])
          if (reservations.has(key)) action = 'stretch'
          else { reservations.set(key, seat.key); lease = key }
        }
        const path = activityRoute(seat, room, action)
        trip = { action, path, length: routeLength(path), phase: 'out', started: now, filled: false }
      }
      if (trip) {
        const age = now - trip.started
        if (trip.phase === 'hold') {
          if (['water', 'coffee'].includes(trip.action) && age >= 2) trip.filled = true
          if (age >= (trip.action === 'sleep' ? 18 : 10)) startReturn(now)
        } else if (age * 1.5 >= trip.length) {
          if (trip.phase === 'return') { reset(); due = now + mixDelay(seed, serial) }
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
      return { ...last, drink: trip && ['water', 'coffee'].includes(trip.action) ? trip.action : null,
        filled: trip?.filled ?? false, counter: room.groupId === null, animate: Boolean(trip) || state === 'running',
        wakeAfter: !trip && idleLike ? Math.max(0, due - now) : null }
    },
    dispose: reset,
  }
}
