// This is a navigation address, never a cancellation command. The native view
// must show the current work again before the user decides to stop anything.
export function runTarget(snapshot, entityId, runId) {
  const entity = snapshot.entities.find(item => item.id === entityId)
  if (!entity || entity.mode === 'external') return null
  const run = snapshot.runs.find(item => item.id === runId && item.entityId === entityId)
  if (!run?.sessionId) return null
  const session = snapshot.sessions.find(item => item.id === run.sessionId && item.entityId === entityId)
  if (!session || (session.groupId ?? null) !== (run.groupId ?? null)) return null
  if (run.groupId != null && !snapshot.groups.some(group =>
    group.id === run.groupId && group.members.includes(entity.rootEntityId ?? entityId))) return null
  return { sessionId: run.sessionId, groupId: run.groupId ?? null }
}
