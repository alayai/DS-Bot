export const collections = ['entities', 'sessions', 'runs', 'groups']
export const streamVersion = 1

export function snapshotMeta(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => !collections.includes(key)))
}

export function diffSnapshot(before, after) {
  const changes = {}
  for (const key of collections) {
    const previous = new Map(before[key].map(item => [item.id, JSON.stringify(item)]))
    const next = new Set(after[key].map(item => item.id))
    changes[key] = {
      upsert: after[key].filter(item => previous.get(item.id) !== JSON.stringify(item)),
      remove: before[key].filter(item => !next.has(item.id)).map(item => item.id),
    }
  }
  return { meta: snapshotMeta(after), changes }
}

export function hasChanges(patch, before) {
  const { capturedAt: _oldTime, ...oldMeta } = snapshotMeta(before)
  const { capturedAt: _newTime, ...newMeta } = patch.meta
  return JSON.stringify(oldMeta) !== JSON.stringify(newMeta)
    || collections.some(key => patch.changes[key].upsert.length || patch.changes[key].remove.length)
}

export const cursorOf = frame => `${frame.epoch}:${frame.seq}`
