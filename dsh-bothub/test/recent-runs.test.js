import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recentRuns } from '../src/client/recent-runs.js'
import { entityState } from '../src/client/model.js'
import { spaceSnapshot } from '../src/client/rooms.js'

test('recent endings stay separate from running counts and retain their conversation target', () => {
  const snapshot = { entities: [{ id: 'b', kind: 'bot' }], groups: [], runs: [],
    sessions: ['own', 'group'].map((id, index) => ({
      id, entityId: 'b', groupId: index ? 'g' : null, status: 'idle', blockers: [],
      recentRuns: [{ turn: 1, seq: 2, startedAt: 1, endedAt: index + 2, outcome: 'completed' }],
    })) }
  assert.equal(entityState(snapshot.entities[0], snapshot), 'idle')
  assert.deepEqual(recentRuns(snapshot.sessions).map(run => run.id), ['group:1', 'own:1'])
  assert.deepEqual(recentRuns(spaceSnapshot(snapshot, 'g').sessions).map(run => run.sessionId), ['group'])
  assert.deepEqual(recentRuns([{ id: 'old-bridge' }]), [])
  assert.equal(recentRuns(snapshot.sessions, 1).length, 1)
})
