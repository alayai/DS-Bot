import { createElement as h } from 'react'
import { Hub, HubIcon } from './view.js'
import { createMonitorStore, request } from './store.js'
import { en, zh } from './locale.js'

export const inject = ['slots', 'layout', 'uiWorkspace', 'locale']

export function apply(ctx) {
  const store = createMonitorStore()
  ctx.effect(() => ctx.locale.register('bothub', { en, zh }), 'bothub: language')
  ctx.effect(() => () => store.stop(), 'bothub: monitor disposal')
  const open = async (entityId, sessionId) => {
    const value = await request({ action: 'resolve', entityId, ...(sessionId ? { sessionId } : {}) }, AbortSignal.timeout(10000))
    ctx.uiWorkspace.openSession(value.target)
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'bothub', locale: 'bothub',
    inject: () => ({ store, open }),
  }, Hub))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'bothub', order: 60, label: 'BotHub',
  }, HubIcon))
  for (const name of ['bot.sidebar.action', 'sidebar.footer.action']) {
    ctx.slots.inject(name, () => ctx.slots.register({
      name, id: 'bothub', order: 30,
      inject: () => ({ show: () => ctx.layout.selectPanel('bothub') }),
    }, ({ show }) => h('button', {
      type: 'button', onClick: show, title: 'BotHub', 'aria-label': 'BotHub',
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 36, height: 36, borderRadius: 12, background: 'none', border: '1px solid var(--bt-line, transparent)', color: 'inherit', cursor: 'pointer' },
    }, h(HubIcon, { size: 20 }))))
  }
}
