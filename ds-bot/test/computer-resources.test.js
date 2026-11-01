import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { resourceLimits, DEFAULT_RESOURCE_LIMITS } from '../src/shared/computer-resources.js'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/computer-resources.js', import.meta.url))],
  bundle: true, format: 'cjs', write: false, external: ['react'],
  plugins: [{ name: 'translations', setup(builder) {
    builder.onResolve({ filter: /\/i18n\.js$/ }, () => ({ path: 'translations', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const t = value => value' }))
  } }],
})
const find = (node, predicate) => Array.isArray(node) ? node.map(item => find(item, predicate)).find(Boolean)
  : node && typeof node === 'object' ? predicate(node) ? node : find(node.props.children, predicate) : undefined

test('resource editor preserves the original revision while polling updates and discards explicitly', () => {
  let draft = null
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: () => [draft, value => { draft = value }],
  }) })
  let state = { revision: 2, limits: { ...DEFAULT_RESOURCE_LIMITS } }, saved
  const render = () => module.exports.ComputerResources({ state, save: args => { saved = args } })
  const input = label => find(render(), node => node.type === 'input' && node.props['aria-label'] === label)
  const button = label => find(render(), node => node.type === 'button' && node.props.children[0] === label)
  input('Maximum running desktops').props.onChange({ target: { value: '3' } })
  state = { ...state, revision: 3, limits: { ...state.limits, maxRunning: 4 } }
  button('Save resource settings').props.onClick()
  assert.equal(saved.expectedRevision, 2)
  assert.equal(saved.limits.maxRunning, 3)
  button('Discard changes').props.onClick()
  assert.equal(input('Maximum running desktops').props.value, 4)
  assert.equal(input('Hard quota for new homes (GiB, 0 disables)'), undefined)
  state.quotaBackend = 'podman-xfs'
  assert.ok(input('Hard quota for new homes (GiB, 0 disables)'))
})

test('resource settings reject non-finite, fractional and out-of-bounds limits', () => {
  for (const change of [{ maxRunning: 9 }, { maxRunning: 0 }, { maxRunning: 1.5 }, { idleStopMs: 1 },
    { freeWarningBytes: NaN }, { homeWarningBytes: Infinity }, { newHomeQuotaBytes: 1 }]) {
    assert.throws(() => resourceLimits({ ...DEFAULT_RESOURCE_LIMITS, ...change }))
  }
  assert.equal(resourceLimits({ ...DEFAULT_RESOURCE_LIMITS, idleStopMs: 0 }).idleStopMs, 0)
})
