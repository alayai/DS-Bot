import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runTarget } from '../src/client/run-navigation.js'

function fixture(kind = 'bot') {
  const entity = { id: 'b', kind, sessionId: 'private' }
  const sessions = [null, 'g1', 'g2'].map(groupId => ({
    id: groupId ?? 'private', entityId: 'b', groupId,
  }))
  return {
    entities: [entity], sessions,
    runs: sessions.map(session => ({
      id: `${session.id}:turn1`, entityId: 'b', sessionId: session.id, groupId: session.groupId,
    })),
    groups: ['g1', 'g2'].map(id => ({ id, members: ['b'] })),
  }
}

test('each run preserves its own session and group instead of the default private chat', () => {
  const snapshot = fixture()
  for (const session of snapshot.sessions) {
    assert.deepEqual(runTarget(snapshot, 'b', `${session.id}:turn1`), {
      sessionId: session.id, groupId: session.groupId,
    })
  }
})

test('ordinary and child agents retain their session identity for host resolution', () => {
  assert.deepEqual(runTarget(fixture('agent'), 'b', 'private:turn1'), {
    sessionId: 'private', groupId: null,
  })
  const snapshot = fixture('subagent')
  snapshot.entities[0].rootEntityId = 'root'
  snapshot.groups[0].members = ['root']
  snapshot.sessions[1].target = { parentSessionId: 'parent', childSessionId: 'g1', mode: 'local' }
  assert.deepEqual(runTarget(snapshot, 'b', 'g1:turn1'), { sessionId: 'g1', groupId: 'g1' })
})

test('removed, replaced and inconsistent identities cannot fall back to another run', () => {
  const snapshot = fixture()
  assert.equal(runTarget(snapshot, 'other', 'private:turn1'), null)
  assert.equal(runTarget(snapshot, 'b', 'private:old-turn'), null)
  snapshot.sessions[0].id = 'successor'
  assert.equal(runTarget(snapshot, 'b', 'private:turn1'), null)
  snapshot.sessions[1].groupId = 'g2'
  assert.equal(runTarget(snapshot, 'b', 'g1:turn1'), null)
  snapshot.groups[1].members = []
  assert.equal(runTarget(snapshot, 'b', 'g2:turn1'), null)
})

test('read-only conversations remain viewable, but external agents have no local target', () => {
  const snapshot = fixture()
  snapshot.readOnly = true
  assert.ok(runTarget(snapshot, 'b', 'private:turn1'))
  snapshot.entities[0].mode = 'external'
  assert.equal(runTarget(snapshot, 'b', 'private:turn1'), null)
})
