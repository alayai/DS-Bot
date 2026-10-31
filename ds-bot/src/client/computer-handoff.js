import { createElement as h } from 'react'
import { t } from './i18n.js'

export function ComputerHandoffDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId?.[sessionId]
  const items = (roster.computerHandoffs ?? []).filter(item => item.roomId
    ? item.roomId === sessionId : bot?.id === item.botId)
  if (!items.length) return null
  return h('div', { className: 'bt-q-dock' }, items.map(item =>
    h('section', { key: item.id, className: 'bt-q bt-q-raised bt-handoff', role: 'group', 'aria-label': t('Desktop help requested') },
      h('div', { className: 'bt-q-head' }, h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title' }, t('Desktop help requested')),
        h('div', { className: 'bt-q-detail' }, item.note))),
      h('div', { className: 'bt-q-foot' }, h('button', { type: 'button', className: 'bt-q-submit',
        onClick: () => actions.openComputer(item.botId),
      }, t('Open desktop'))))))
}
