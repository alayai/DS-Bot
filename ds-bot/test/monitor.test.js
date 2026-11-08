import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { monitorSnapshot } from '../src/host/monitor.js'
import { fakeContext } from './fake-ctx.js'

function fixture() {
  return {
    state: {
      workspaceId: 'team', mainBotIds: ['b'],
      bots: { b: { id: 'b', name: 'Builder', role: 'Engineer', instructions: 'private instructions', workDir: '/secret', private: true } },
      agents: { a: { id: 'a', name: 'Agent', sessions: ['as'] } },
      rooms: { g: { id: 'g', name: 'Review', members: ['b'], announcement: 'private announcement' } },
      questions: { gs: { text: 'private question' } },
    },
    chatOf: () => 'own',
    groupOwners: new Map([['gs', { botId: 'b', roomId: 'g' }]]),
    live: new Map([
      ['own', { turn: 2, since: 100, tool: 'read_file', calls: [{ arguments: 'credential' }], step: 'private summary' }],
      ['gs', { turn: 4, since: 200 }],
    ]),
    approvalsView: () => [{ id: 'approval', sessionId: 'gs', reason: 'sensitive', detail: 'sensitive' }],
    waitingView: () => ({ b: { bots: ['another'] } }),
    readOnly: () => undefined,
  }
}

test('monitor keeps concurrent own and group runs under one stable Bot', () => {
  const snapshot = monitorSnapshot(fixture(), 500)
  assert.equal(snapshot.entities.length, 2)
  assert.equal(snapshot.runs.length, 2)
  assert.deepEqual(snapshot.runs.map(run => run.entityId), ['b', 'b'])
  assert.equal(snapshot.sessions.find(item => item.id === 'gs').openSessionId, 'g')
  assert.deepEqual(snapshot.sessions.find(item => item.id === 'gs').blockers, ['approval', 'input'])
  assert.equal(snapshot.sessions.find(item => item.id === 'as').status, 'unknown')
  assert.equal(snapshot.capturedAt, 500)
})

test('monitor omits conversation content, settings, paths and approval details', () => {
  const result = JSON.stringify(monitorSnapshot(fixture()))
  for (const secret of ['private instructions', '/secret', 'private question', 'private announcement', 'credential', 'private summary', 'sensitive']) {
    assert.equal(result.includes(secret), false)
  }
})

test('monitor does not invent completion or idle before observing a session', () => {
  const rt = fixture()
  rt.live.clear()
  assert.equal(monitorSnapshot(rt).sessions.every(item => item.status === 'unknown'), true)
  rt.live.set('own', {})
  assert.equal(monitorSnapshot(rt).sessions.find(item => item.id === 'own').status, 'idle')
  rt.readOnly = () => 'another host'
  assert.equal(monitorSnapshot(rt).readOnly, true)
})

test('monitor snapshots cannot mutate group membership and do not expose raw tool identifiers', () => {
  const rt = fixture()
  rt.live.get('own').tool = 'secret credential\nvalue'
  const snapshot = monitorSnapshot(rt)
  snapshot.groups[0].members.push('x')
  assert.deepEqual(rt.state.rooms.g.members, ['b'])
  assert.equal(snapshot.runs[0].tool, null)
})

test('opening the monitor never bootstraps a team or prompts a model', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-monitor-'))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  rt.bootstrap = () => { throw new Error('monitor must not bootstrap') }
  const service = ctx.get('botMonitor')
  assert.equal(service.version, 2)
  assert.deepEqual((await service.snapshot()).entities, [])
  assert.equal(await service.resolve('missing'), null)
})

test('monitor resolves current segments and rejects unrelated sessions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-monitor-'))
  await writeFile(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: ['b'],
    bots: { b: { id: 'b', name: 'Builder', role: 'Engineer', instructions: '', createdAt: 1, sessionId: 'own' } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  const service = ctx.get('botMonitor')
  assert.equal(await service.resolve('b'), 'own')
  assert.equal(await service.resolve('b', 'unrelated'), null)
  rt.state.bots.b.sessionId = 'new-part'
  assert.equal(await service.resolve('b'), 'new-part')
  assert.equal(await service.resolve('b', 'own'), null)
  delete rt.state.bots.b
  assert.equal(await service.resolve('b'), null)
})

test('ordinary Agent status comes from the resident registry, without resolving an Agent', () => {
  const rt = fixture()
  let status = 'running'
  rt.ctx = { get: name => name === 'agents' ? { get: id => id === 'as' && { status } } : undefined }
  let snapshot = monitorSnapshot(rt)
  assert.equal(snapshot.sessions.find(item => item.id === 'as').status, 'running')
  assert.equal(snapshot.runs.find(item => item.sessionId === 'as').phase, 'active')
  assert.equal(snapshot.runs.find(item => item.sessionId === 'as').startedAt, null)
  status = 'idle'
  snapshot = monitorSnapshot(rt)
  assert.equal(snapshot.sessions.find(item => item.id === 'as').status, 'idle')
  assert.equal(snapshot.runs.some(item => item.sessionId === 'as'), false)
  status = undefined
  assert.equal(monitorSnapshot(rt).sessions.find(item => item.id === 'as').status, 'unknown')
})
