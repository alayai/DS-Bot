export function entityState(entity, snapshot) {
  const sessions = snapshot.sessions.filter(item => item.entityId === entity.id)
  if (sessions.some(item => item.blockers.length > 0)) return 'attention'
  if (snapshot.runs.some(item => item.entityId === entity.id)) return 'running'
  if (entity.waiting) return 'waiting'
  return sessions.length > 0 && sessions.every(item => item.status === 'idle') ? 'idle' : 'unknown'
}

export function runLabel(run) {
  if (run.phase === 'waiting') {
    if (run.blockers?.includes('approval')) return 'approval'
    if (run.blockers?.includes('input')) return 'input'
    return 'attentionState'
  }
  return run.phase === 'tool' ? 'tool' : run.phase === 'thinking' ? 'thinking' : 'active'
}

export function selectEntities(snapshot, { query = '', status = 'all', group = 'all' } = {}) {
  const term = query.trim().toLocaleLowerCase()
  const members = snapshot.groups.find(item => item.id === group)?.members ?? []
  return snapshot.entities.filter(entity =>
    (!term || `${entity.name} ${entity.role}`.toLocaleLowerCase().includes(term))
    && (status === 'all' || entityState(entity, snapshot) === status)
    && (group === 'all' || members.includes(entity.rootEntityId ?? entity.id)))
}

export function acceptSnapshot(value) {
  if (value?.version !== 2 || !Number.isFinite(value.capturedAt)
    || !['entities', 'sessions', 'runs', 'groups'].every(key => Array.isArray(value[key]))) {
    throw new Error('incompatible')
  }
  return value
}
