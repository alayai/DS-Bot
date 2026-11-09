import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

test('BotHub opens a native right-sidebar page while preserving the main conversation', async () => {
  const entries = [], types = [], effects = [], calls = []
  let plugin, session = 'chat'
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(module) {
      plugin = module.factory(name => {
        assert.equal(name, 'react')
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
          useEffect: callback => { effects.push(callback) },
        }
      })
    } } },
    AbortController, AbortSignal, setTimeout, clearTimeout,
  })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  const sidebar = {
    mounted: { subscribe() {}, getSnapshot: () => session },
    openTab: kind => calls.push(kind),
  }
  plugin.apply({
    effect: callback => callback(), on: () => () => {},
    locale: { register: () => () => {} },
    sidebarRight: sidebar,
    sidebarRightTabs: { register: value => { types.push(value); return () => {} } },
    slots: { inject(_name, callback) { callback() }, register(options, component) { entries.push({ options, component }) } },
    uiWorkspace: { openSession() { assert.fail('Opening the panel must preserve the selected session') } },
  })
  assert.equal(entries.some(({ options }) => options.name === 'main' || options.name === 'sidebar.panellist'), false)
  assert.equal(types.length, 1)
  assert.equal(types[0].kind, 'bothub')
  assert.equal(types[0].guide[0].title(), 'BotHub')
  const body = entries.find(({ options }) => options.name === 'sidebar.right.pane.tab')
  assert.equal(body.options.key, types[0].id)
  for (const name of ['bot.sidebar.action', 'sidebar.footer.action']) {
    const entry = entries.find(({ options }) => options.name === name)
    const button = entry.component({ ...entry.options.inject(), t: key => key })
    assert.equal(button.props.disabled, false)
    button.props.onClick()
    assert.equal(calls.at(-1), 'bothub')
    session = undefined
    assert.equal(entry.component({ ...entry.options.inject(), t: key => key }).props.disabled, true)
    session = 'chat'
  }
  const props = body.options.inject()
  let refresh
  const tab = { visible: false, actions: { bindCommands: value => { refresh = value.refresh; return () => {} } } }
  assert.equal(body.component({ ...props, useTabInfo: () => ({ tab }) }), null)
  effects.pop()()
  assert.equal(typeof refresh, 'function')
  tab.visible = true
  assert.ok(body.component({ ...props, useTabInfo: () => ({ tab }) }))
})
