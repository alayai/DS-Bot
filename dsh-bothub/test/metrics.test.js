import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { teamMetrics } from '../src/client/metrics.js'
import { roomLayout } from '../src/client/rooms.js'

function fixture() {
  const bots = Array.from({ length: 6 }, (_, index) => ({ id: `b${index}`, kind: 'bot', name: `Bot ${index}`, role: '' }))
  return {
    entities: [...bots, { id: 'a', kind: 'agent' }, { id: 's', kind: 'subagent' }, { id: 'future', kind: 'unknown' }],
    groups: ['g1', 'g2'].map(id => ({ id, name: id, members: bots.slice(0, 5).map(bot => bot.id) })),
    sessions: [{ entityId: 'b0', blockers: ['approval'] }, { entityId: 's', blockers: ['input'] }],
    runs: [{ entityId: 'b0', groupId: null }, { entityId: 'b0', groupId: 'g1' }, { entityId: 'a' }, { entityId: 's' }],
  }
}

test('six Bots plus three other entities count as six in 3D and nine in 2D', () => {
  const snapshot = fixture()
  assert.deepEqual(teamMetrics(snapshot, '3d'), { members: 6, runs: 2, attention: 1 })
  assert.deepEqual(teamMetrics(snapshot, '2d'), { members: 9, runs: 4, attention: 2 })
  assert.equal(snapshot.entities.length, 9)
})

test('team totals count each Bot once across rooms and remain independent of scene filters and limits', () => {
  const snapshot = fixture()
  assert.equal(roomLayout(snapshot).presences.length, 11)
  assert.equal(roomLayout(snapshot, { query: 'Bot 5', groupId: null }).presences.length, 1)
  snapshot.groups = Array.from({ length: 30 }, (_, index) => ({ id: `g${index}`, name: 'Group', members: ['b0'] }))
  assert.equal(roomLayout(snapshot).truncated, true)
  assert.deepEqual(teamMetrics(snapshot, '3d'), { members: 6, runs: 2, attention: 1 })
})

test('missing data stays unknown; empty or Agent-only teams have zero Bot metrics', () => {
  assert.deepEqual(teamMetrics(null, '3d'), { members: '—', runs: '—', attention: '—' })
  assert.deepEqual(teamMetrics({ entities: [], sessions: [], runs: [] }, '3d'), { members: 0, runs: 0, attention: 0 })
  const snapshot = fixture()
  snapshot.entities = snapshot.entities.filter(entity => entity.kind !== 'bot')
  assert.deepEqual(teamMetrics(snapshot, '3d'), { members: 0, runs: 0, attention: 0 })
  assert.deepEqual(teamMetrics(snapshot, '2d'), { members: 3, runs: 2, attention: 1 })
})

test('bundled Hub switches its header counts and labels with the 3D/2D controls', async () => {
  let plugin, cursor = 0
  const states = []
  const context = vm.createContext({ setTimeout, clearTimeout, window: { __ModuleLoader__: { load(module) {
    plugin = module.factory(() => ({
      createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], value => { states[index] = value }]
      },
      useEffect() {}, useId: () => 'detail', useRef: () => ({ current: null }),
      useMemo: callback => callback(), useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    }))
  } } } })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  const hub = plugin.HubTab({ useTabInfo: () => ({ tab: { visible: true, actions: {} } }) }).type
  const data = { ...fixture(), workspaceId: 'test', capturedAt: 0 }
  const props = { store: { subscribe() {}, getSnapshot: () => ({ data, phase: 'live' }) }, t: key => key }
  const render = () => { cursor = 0; return hub(props) }
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    return node.children?.map(child => find(child, predicate)).find(Boolean)
  }
  const header = tree => find(tree, node => node.props?.className === 'bh-metrics')
    .children.slice(0, 3).map(metric => metric.children.map(child => child.children[0]).join(':')).join(',')
  let tree = render()
  assert.equal(header(tree), '6:botMembers,2:runs,1:attention')
  assert.ok(find(tree, node => node.children?.includes('botCoverage')))
  find(tree, node => node.type === 'button' && node.children.includes('2D')).props.onClick()
  tree = render()
  assert.equal(header(tree), '9:members,4:runs,2:attention')
  find(tree, node => node.type === 'button' && node.children.includes('3D')).props.onClick()
  assert.equal(header(render()), '6:botMembers,2:runs,1:attention')
})
