import { createElement as h, useEffect, useSyncExternalStore } from 'react'
import { Hub, HubIcon } from './view.js'
import { createMonitorStore, request } from './store.js'
import { en, zh } from './locale.js'
import { createMessageStore } from './messages.js'

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'locale']

const TAB_ID = 'dsh-bothub'
const TAB_KIND = 'bothub'

export function HubTab({ useTabInfo, ...props }) {
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => void props.store.refresh() }), [tab.actions, props.store])
  return tab.visible ? h(Hub, props) : null
}

function Launcher({ sidebar, show, t }) {
  const session = useSyncExternalStore(sidebar.mounted.subscribe, sidebar.mounted.getSnapshot)
  return h('button', {
    type: 'button', onClick: show, disabled: !session,
    title: session ? 'BotHub' : t('openSessionFirst'), 'aria-label': 'BotHub',
    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 36, height: 36, borderRadius: 12, background: 'none', border: '1px solid var(--bt-line, transparent)', color: 'inherit', cursor: session ? 'pointer' : 'default', opacity: session ? 1 : .45 },
  }, h(HubIcon, { size: 20 }))
}

export function apply(ctx) {
  const store = createMonitorStore()
  const messages = createMessageStore()
  ctx.effect(() => ctx.locale.register('bothub', { en, zh }), 'bothub: language')
  ctx.effect(() => () => store.stop(), 'bothub: monitor disposal')
  ctx.effect(() => () => messages.dispose(), 'bothub: message disposal')
  // A newly authenticated DSH generation must recheck capabilities even if the
  // previous HTTP attempt stopped retrying during Host startup.
  ctx.effect(() => ctx.on('connection/reset', () => { void store.refresh() }), 'bothub: host reconnection')
  const open = async (entityId, sessionId, groupId) => {
    const value = await request({ action: 'resolve', entityId, ...(sessionId ? { sessionId } : {}), ...(groupId ? { groupId } : {}) }, AbortSignal.timeout(10000))
    ctx.uiWorkspace.openSession(value.target)
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: TAB_KIND, title: () => 'BotHub',
    guide: [{ id: 'bothub', order: 60, title: () => 'BotHub', icon: HubIcon }],
  }), 'bothub: right sidebar type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: 'bothub',
    inject: () => ({ store, open, messages, openReceipt: receipt => ctx.uiWorkspace.openSession(receipt.sessionId) }),
  }, HubTab))
  for (const name of ['bot.sidebar.action', 'sidebar.footer.action']) {
    ctx.slots.inject(name, () => ctx.slots.register({
      name, id: 'bothub', order: 30, locale: 'bothub',
      inject: () => ({ sidebar: ctx.sidebarRight, show: () => ctx.sidebarRight.openTab(TAB_KIND) }),
    }, Launcher))
  }
}
