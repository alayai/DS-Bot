import { createElement as h, Fragment, useRef } from 'react'
import { BotAvatar } from './mark.js'
import { Bubbles } from './cells.js'
import { UserBubble } from './user-message.js'
import { RightSidebarIcon, ChevronDownIcon, GlobeIcon } from './icons.js'
import { t } from './i18n.js'
import { BOT_COMPOSER_SURFACE } from './styles.js'

export function CloudChatHeader({ bot, title, controls, openResources, resourcesLabel }) {
  const details = useRef(null)
  return h('header', { className: 'bt-head bt-cloud-head' },
    h('details', { ref: details, onKeyDown: event => {
      if (event.key === 'Escape' && details.current?.open) {
        event.stopPropagation(); details.current.open = false; details.current.querySelector('summary')?.focus()
      }
    } },
    h('summary', { className: 'bt-pill', title: t('View conversation details') },
      bot ? h(BotAvatar, { bot, size: 24, badge: false }) : h(GlobeIcon),
      h('span', { className: 'bt-pill-name' }, bot?.name || title), h(ChevronDownIcon)),
    h('div', { className: 'bt-cloud-pickers' }, controls)),
    h('button', { type: 'button', className: 'bt-icon-btn bt-head-side', title: resourcesLabel, 'aria-label': resourcesLabel, onClick: openResources }, h(RightSidebarIcon)))
}

export function CloudChatMessage({ item, bot, stateLabel, errorLabel, toolLabel, emptyLabel }) {
  const time = Date.parse(item.createdAt)
  if (item.kind === 'user') return h(UserBubble, { text: item.text, time })
  if (item.kind === 'tool') return h('details', { className: 'bt-cloud-call' },
    h('summary', null, item.text || toolLabel, ' · ', stateLabel),
    h('pre', null, item.detail || emptyLabel))
  if (item.kind === 'error') return h('div', { className: 'bt-error', role: 'status' }, errorLabel)
  return h(Fragment, null,
    bot && h('div', { className: 'bt-group-name bt-cloud-speaker' }, h(BotAvatar, { bot, size: 22, badge: false }), bot.name),
    h(Bubbles, { texts: [item.text], streaming: item.state === 'running', time }),
    ['failed', 'interrupted'].includes(item.state) && h('small', { className: 'bt-set-hint' }, stateLabel))
}

export const CLOUD_CHAT_CSS = `
.bt-cloud-head{height:52px;z-index:2}
.bt-cloud-head details{pointer-events:auto;max-width:70%}
.bt-cloud-head summary{list-style:none;max-width:100%;box-sizing:border-box}
.bt-cloud-head summary::-webkit-details-marker{display:none}
.bt-cloud-head .bt-pill-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.bt-cloud-pickers{position:absolute;inset-block-start:100%;inset-inline-start:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 24px);box-sizing:border-box;display:flex;flex-wrap:wrap;gap:10px;padding:12px;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:14px;box-shadow:var(--bt-glass-shadow)}
.bt-cloud-pickers>div{flex-wrap:wrap;max-width:100%}
.bt-cloud-call{color:var(--bt-ink-2);font-size:13px}
.bt-cloud-call summary{cursor:pointer}
.bt-cloud-call pre{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px;border-left:2px solid var(--bt-line-2)}
.bt-cloud-speaker{display:none}
body[data-bt-layout=flat] .bt-cloud-speaker{display:flex}
[data-cloud-conversation]:has(.bt-cloud-head) [data-event-kind=user]{align-self:stretch;max-width:none}
[data-cloud-conversation]:has(.bt-cloud-head) [data-event-kind=tool]{margin-inline-start:0}
[data-cloud-conversation]:has(.bt-cloud-head) [data-cloud-composer]{${BOT_COMPOSER_SURFACE}}
[data-cloud-conversation]:has(.bt-cloud-head) [data-cloud-composer] textarea{min-height:24px;padding:0 8px;flex:1 1 12em;width:auto}
[data-cloud-conversation]:has(.bt-cloud-head) [data-cloud-composer]>div{margin:0;gap:4px}
[data-cloud-conversation]:has(.bt-cloud-head) [data-cloud-composer] button[type=submit]{border-radius:50%;width:28px;height:28px;background:var(--bt-accent);color:var(--bt-accent-ink,#fff)}
`
