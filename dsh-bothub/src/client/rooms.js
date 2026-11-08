import { entityState } from './model.js'

export const spaceKey = groupId => JSON.stringify(['space', groupId])
export const presenceKey = (entityId, groupId) => JSON.stringify([entityId, groupId])

export function inSpace(entity, snapshot, groupId) {
  if (groupId === undefined) return true
  if (entity.kind === 'subagent') {
    const root = snapshot.sessions.find(session => session.id === entity.rootSessionId && session.entityId === entity.rootEntityId)
    return Boolean(root) && (root.groupId ?? null) === groupId
      && (groupId === null || snapshot.groups.some(group => group.id === groupId && group.members.includes(entity.rootEntityId)))
  }
  return groupId === null || snapshot.groups.some(group => group.id === groupId && group.members.includes(entity.id))
}

export function spaceSnapshot(snapshot, groupId) {
  if (groupId === undefined) return snapshot
  return {
    ...snapshot,
    entities: snapshot.entities.filter(entity => inSpace(entity, snapshot, groupId)),
    sessions: snapshot.sessions.filter(session => (session.groupId ?? null) === groupId),
    runs: snapshot.runs.filter(run => (run.groupId ?? null) === groupId),
  }
}

export function spaceState(entity, snapshot, groupId) {
  return entityState(groupId == null ? entity : { ...entity, waiting: false }, spaceSnapshot(snapshot, groupId))
}

export function selectSpaceEntities(snapshot, { query = '', status = 'all', groupId } = {}) {
  const scoped = spaceSnapshot(snapshot, groupId)
  const term = query.trim().toLocaleLowerCase()
  return scoped.entities.filter(entity =>
    (!term || `${entity.name} ${entity.role}`.toLocaleLowerCase().includes(term))
    && (status === 'all' || entityState(groupId == null ? entity : { ...entity, waiting: false }, scoped) === status))
}

export function roomLayout(snapshot, { query = '', status = 'all', groupId } = {}) {
  const candidates = [
    ...snapshot.groups.map(group => ({ groupId: group.id, name: group.name })),
    { groupId: null, name: null },
  ].filter(room => groupId === undefined || room.groupId === groupId)
  const allRooms = candidates.map(room => ({
    ...room, key: spaceKey(room.groupId),
    entities: selectSpaceEntities(snapshot, { query, status, groupId: room.groupId })
      .sort((a, b) => a.id.localeCompare(b.id)),
  })).filter(room => (!query.trim() && status === 'all') || room.entities.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
  let remaining = 50
  const rooms = allRooms.slice(0, 24).map(room => {
    const entities = room.entities.slice(0, remaining)
    remaining -= entities.length
    const columns = Math.max(2, Math.ceil(Math.sqrt(entities.length)))
    const rows = Math.max(1, Math.ceil(entities.length / columns))
    return {
      ...room, total: room.entities.length, entities,
      width: columns * 2.4 + 1.6, depth: rows * 2.6 + 2.6,
      columns, rows,
    }
  })
  // Fixed ID order keeps unrelated polls and locale changes from shuffling rooms.
  rooms.sort((a, b) => a.key.localeCompare(b.key))
  const columns = Math.max(1, Math.ceil(Math.sqrt(rooms.length)))
  const rows = Math.ceil(rooms.length / columns)
  const cellWidth = Math.max(6, ...rooms.map(room => room.width)) + 2
  const cellDepth = Math.max(5, ...rooms.map(room => room.depth)) + 2
  const presences = []
  rooms.forEach((room, index) => {
    room.x = (index % columns - (columns - 1) / 2) * cellWidth
    room.z = (Math.floor(index / columns) - (rows - 1) / 2) * cellDepth
    room.entities.forEach((entity, seat) => presences.push({
      key: presenceKey(entity.id, room.groupId), entity, groupId: room.groupId,
      state: spaceState(entity, snapshot, room.groupId),
      x: room.x + (seat % room.columns - (room.columns - 1) / 2) * 2.4,
      z: room.z + (Math.floor(seat / room.columns) - (room.rows - 1) / 2) * 2.6 + .4,
    }))
  })
  return {
    rooms, presences,
    truncated: allRooms.length > rooms.length || rooms.some(room => room.total > room.entities.length),
    width: columns * cellWidth, depth: Math.max(1, rows) * cellDepth,
  }
}
