import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
const localDateTime = date => {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
export function ComputerTasks({ record, call }) {
  const [items, setItems] = useState([]), [goal, setGoal] = useState(''), [runAt, setRunAt] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(null)
  const alive = useRef(true), pending = useRef(false), polling = useRef(null)
  useEffect(() => {
    alive.current = true
    const poll = () => {
      if (pending.current || polling.current || document.visibilityState === 'hidden') return
      polling.current = call('tasks').then(value => { if (alive.current) setItems(value) }, e => { if (alive.current) setError(e.message) }).finally(() => { polling.current = null })
    }
    void poll(); const timer = setInterval(poll, 3000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [record?.botId])
  async function command(method, id) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      await polling.current
      const scheduled = method === 'add' && runAt ? Date.parse(runAt) : undefined
      if (scheduled !== undefined && (!Number.isSafeInteger(scheduled) || scheduled <= Date.now()
        || localDateTime(new Date(scheduled)) !== runAt)) throw Error('Choose a future time within one year.')
      const value = await call('tasks', {
        method, id, goal, confirm: method === 'resume',
        ...(scheduled === undefined ? {} : { runAt: scheduled }),
      })
      if (alive.current) { setItems(value); setConfirm(null); if (method === 'add') { setGoal(''); setRunAt('') } }
    }
    catch (e) { if (alive.current) setError(e.message) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  if (!record) return null
  const button = (label, method, id) => h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void command(method, id) }, t(label))
  return h('details', { className: 'bt-computer-help' }, h('summary', null, t('Desktop task queue')),
    h('p', { className: 'bt-muted' }, t('Tasks run in order when the desktop is running and the Bot chat is idle. A restart or uncertain result requires review. Pausing only controls Computer tools; other tools remain in assisted mode.')),
    h('p', { className: 'bt-muted' }, t('The optional time uses your local time zone. Keep DSH and the desktop running. Due tasks wait until the Bot is available; future tasks do not block ready tasks.')),
    h('form', { onSubmit: e => { e.preventDefault(); void command('add') } },
      h('textarea', { value: goal, maxLength: 4000, disabled: busy, 'aria-label': t('Desktop task goal'), onChange: e => setGoal(e.target.value) }),
      h('label', { className: 'bt-computer-row' }, t('Run at (optional)'), h('input', {
        type: 'datetime-local', value: runAt, disabled: busy, min: localDateTime(new Date(Date.now() + 60_000)),
        onChange: e => setRunAt(e.target.value),
      })),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || !goal.trim() }, t('Add desktop task'))),
    error ? h('p', { role: 'alert', className: 'bt-error' }, t(error)) : null,
    items.map(item => h('section', { key: item.id, className: 'bt-computer-help' },
      h('p', null, item.goal), h('p', { role: 'status' }, `${t('Task status')}: ${t(item.status)}`),
      item.runAt ? h('p', { className: 'bt-muted' }, t('Scheduled for {time}', { time: new Date(item.runAt).toLocaleString() })) : null,
      item.note ? h('p', null, item.note) : null,
      h('div', { className: 'bt-computer-row' },
        ['queued', 'sending', 'running', 'unknown'].includes(item.status) ? button('Pause task', 'pause', item.id) : null,
        ['paused', 'interrupted', 'needs-review', 'unknown', 'failed'].includes(item.status) ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => setConfirm({ id: item.id, generation: record.generation }) }, t('Review and resume')) : null,
        !['completed', 'failed', 'cancelled'].includes(item.status) ? button('Cancel task', 'cancel', item.id) : button('Remove finished task', 'remove', item.id)),
      confirm?.id === item.id ? h('div', null, h('p', null, t('Review the desktop and previous progress first. Resume sends a fresh instruction to observe before continuing; it does not replay previous actions.')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || confirm.generation !== record.generation,
          onClick: () => void command('resume', item.id) }, t('Confirm task resume')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(null) }, t('Cancel'))) : null)))
}
