import { entityState } from './model.js'
import { isSceneEntity } from './rooms.js'

export function teamMetrics(snapshot, view) {
  if (!snapshot) return { members: '—', runs: '—', attention: '—' }
  const entities = snapshot.entities.filter(entity => view !== '3d' || isSceneEntity(entity))
  const members = new Set(entities.map(entity => entity.id))
  return {
    members: members.size,
    runs: snapshot.runs.filter(run => members.has(run.entityId)).length,
    attention: new Set(entities.filter(entity => entityState(entity, snapshot) === 'attention').map(entity => entity.id)).size,
  }
}
