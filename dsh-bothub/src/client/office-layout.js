export const stationSize = { width: 2.7, depth: 2.7 }
export const stationSpacing = { x: 3.3, z: 3.5 }

export function officeSize(columns, rows, common) {
  return {
    width: Math.max(common ? 16 : 10.4, columns * stationSpacing.x + 3),
    depth: rows * stationSpacing.z + (common ? 10.5 : 3.8),
    seatStart: common ? 10 : 3.4,
  }
}

// Coordinates are local to a room. Back-wall storage and common-area amenities
// occupy a reserved band, independent of member count and state.
export function roomFixtures(room) {
  const back = -room.depth / 2
  const items = room.groupId === null ? [
    { kind: 'coffee', x: -2.8, z: back + .8, width: 5.2, depth: 1.3 },
    { kind: 'shelf', x: -6.6, z: back + .45, width: 2, depth: .7 },
    { kind: 'snooker', x: -4.4, z: back + 5.2, width: 2.8, depth: 4.8 },
    { kind: 'lounge', x: -.2, z: back + 5.2, width: 3.2, depth: 3.4 },
    { kind: 'fitness', x: 4.6, z: back + 5.2, width: 4.2, depth: 4.8 },
  ] : [
    { kind: 'shelf', x: -room.width / 2 + 1.6, z: back + .45, width: 2.4, depth: .7 },
    { kind: 'cabinet', x: -.2, z: back + .45, width: 1.6, depth: .7 },
    { kind: 'whiteboard', x: 2.1, z: back + .18, width: 2.5, depth: .2 },
  ]
  items.push(
    { kind: 'plant', x: room.width / 2 - .65, z: back + .75, width: .8, depth: .8 },
    { kind: 'plant', x: -room.width / 2 + .65, z: room.depth / 2 - .7, width: .8, depth: .8 },
  )
  return items
}
