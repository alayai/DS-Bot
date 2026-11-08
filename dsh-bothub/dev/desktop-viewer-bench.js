// Development-only fixture controls; the rendered Hub and desktop API are real.
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { Hub } from '../src/client/view.js'
import { en } from '../src/client/locale.js'
import { createMessageStore } from '../src/client/messages.js'

const entities = ['alpha', 'beta', 'gamma'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), kind: 'bot' }))
entities.push({ id: 'agent', name: 'Ordinary Agent', kind: 'agent' })
let state = {
  phase: 'live', transport: 'stream',
  data: { workspaceId: 'viewer-test', capturedAt: Date.now(), entities,
    groups: [{ id: 'design', name: 'Design room', members: entities.map(bot => bot.id) }],
    sessions: [], runs: [] },
}
const listeners = new Set(), requests = []
const fetcher = window.fetch.bind(window)
window.fetch = (url, options) => {
  if (url === 'api/bot') requests.push({ ...JSON.parse(options.body), at: performance.now() })
  return fetcher(url, options)
}
const update = change => { state = change(state); for (const listener of listeners) listener() }
const store = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  getSnapshot: () => state,
  start: () => () => {},
  refresh: () => {},
}
const messages = createMessageStore()
const root = createRoot(document.querySelector('#hub'))
const mount = () => root.render(h(Hub, { store, messages, open: async () => {}, openReceipt: async () => {}, t: key => en[key] ?? key }))
window.viewerTest = {
  requests, mount,
  unmount() { root.render(null) },
  connected(value) { update(s => ({ ...s, phase: value ? 'live' : 'stale' })) },
  readOnly(value) { update(s => ({ ...s, data: { ...s.data, readOnly: value } })) },
  workspace(id) { update(s => ({ ...s, data: { ...s.data, workspaceId: id } })) },
  remove(id) { update(s => ({ ...s, data: { ...s.data, entities: s.data.entities.filter(e => e.id !== id) } })) },
  async command(action) { await fetch('/fixture', { method: 'POST', body: JSON.stringify({ action }) }) },
}
mount()
