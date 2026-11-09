import { entityState } from './model.js'
import { officeSize, stationSpacing } from './office-layout.js'

export const spaceKey = groupId => JSON.stringify(['space', groupId])
export const presenceKey = (entityId, groupId) => JSON.stringify([entityId, groupId])

export function inSpace(entity, snapshot, groupId) {
  if (groupId === undefined) return true
  if (entity.kind === 'subagent') {
    const root = snapshot.sessions.find(session => session.id === entity.rootSessionId && session.entityId === entity.rootEntityId)
    return Boolean(root) && (root.groupId ?? null) === groupId
      && (groupId === null || snapshot.groups.some(group => group.id === groupId && group.members.includes(entity.rootEntityId)))
  }
  if (groupId === null) return !snapshot.groups.some(group => group.members.includes(entity.id))
  return snapshot.groups.some(group => group.id === groupId && group.members.includes(entity.id))
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
      ...officeSize(columns, rows, room.groupId === null),
      columns, rows,
    }
  })
  // Fixed ID order keeps unrelated polls and locale changes from shuffling rooms.
  rooms.sort((a, b) => a.key.localeCompare(b.key))
  const columns = Math.max(1, Math.ceil(Math.sqrt(rooms.length)))
  const rows = Math.ceil(rooms.length / columns)
  const widths = Array.from({ length: columns }, (_, col) => Math.max(0, ...rooms.filter((_, i) => i % columns === col).map(room => room.width)))
  const depths = Array.from({ length: rows }, (_, row) => Math.max(0, ...rooms.slice(row * columns, (row + 1) * columns).map(room => room.depth)))
  const width = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, columns - 1) * 2
  const depth = depths.reduce((sum, value) => sum + value, 0) + Math.max(0, rows - 1) * 2
  const presences = []
  rooms.forEach((room, index) => {
    const col = index % columns, row = Math.floor(index / columns)
    room.x = widths.slice(0, col).reduce((sum, value) => sum + value + 2, 0) + widths[col] / 2 - width / 2
    room.z = depths.slice(0, row).reduce((sum, value) => sum + value + 2, 0) + depths[row] / 2 - depth / 2
    room.entities.forEach((entity, seat) => presences.push({
      key: presenceKey(entity.id, room.groupId), entity, groupId: room.groupId,
      state: spaceState(entity, snapshot, room.groupId),
      x: room.x + (seat % room.columns - (room.columns - 1) / 2) * stationSpacing.x,
      z: room.z - room.depth / 2 + room.seatStart + Math.floor(seat / room.columns) * stationSpacing.z,
    }))
  })
  return {
    rooms, presences,
    truncated: allRooms.length > rooms.length || rooms.some(room => room.total > room.entities.length),
    width: Math.max(8, width + 1), depth: Math.max(8, depth + 1),
  }
}
