import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
const localDateTime = date => {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const queueReasons = {
  scheduled: 'Waiting for the scheduled time.', 'previous-task': 'Waiting for the previous task to finish or be reviewed.',
  'access-off': 'Desktop access is off.', 'control-held': 'Waiting for desktop control to be returned.',
  'desktop-stopped': 'Start the desktop to run this task.', 'bot-busy': 'Waiting for the Bot chat to become idle.',
  'waiting-dispatch': 'Waiting for the next queue check.',
}
export function ComputerTasks({ record, call }) {
  const [items, setItems] = useState([]), [goal, setGoal] = useState(''), [runAt, setRunAt] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(null)
  const [kind, setKind] = useState('once'), [time, setTime] = useState('09:00'), [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [days, setDays] = useState([1]), [missed, setMissed] = useState('once'), [maxMinutes, setMaxMinutes] = useState('60'), [stallMinutes, setStallMinutes] = useState('10')
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
      const scheduled = method === 'add' && kind === 'once' && runAt ? Date.parse(runAt) : undefined
      if (scheduled !== undefined && (!Number.isSafeInteger(scheduled) || scheduled <= Date.now()
        || localDateTime(new Date(scheduled)) !== runAt)) throw Error('Choose a future time within one year.')
      const value = await call('tasks', {
        method, id, goal, confirm: method === 'resume',
        ...(scheduled === undefined ? {} : { runAt: scheduled }),
        ...(method !== 'add' ? {} : {
          maxRunMs: Number(maxMinutes) * 60000, stallMs: Number(stallMinutes) * 60000,
          ...(kind === 'once' ? {} : { repeat: { kind, time, timeZone: timeZone.trim(), missed, ...(kind === 'weekly' ? { weekdays: days } : {}) } }),
        }),
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
    h('p', { className: 'bt-muted' }, t('Repeating tasks run again only after success. Failures and uncertain results require review. Pause or cancel stops the whole schedule. Missing daylight-saving times are skipped; repeated times run once.')),
    h('form', { onSubmit: e => { e.preventDefault(); void command('add') } },
      h('textarea', { value: goal, maxLength: 4000, disabled: busy, 'aria-label': t('Desktop task goal'), onChange: e => setGoal(e.target.value) }),
      h('label', { className: 'bt-computer-row' }, t('Task schedule'), h('select', { 'aria-label': t('Task schedule'), value: kind, disabled: busy, onChange: e => setKind(e.target.value) },
        [['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly']].map(([value, label]) => h('option', { key: value, value }, t(label))))),
      kind === 'once' ? h('label', { className: 'bt-computer-row' }, t('Run at (optional)'), h('input', {
        type: 'datetime-local', value: runAt, disabled: busy, min: localDateTime(new Date(Date.now() + 60_000)),
        onChange: e => setRunAt(e.target.value),
      })) : h('fieldset', { disabled: busy },
        h('legend', null, t('Repeating schedule')),
        h('label', { className: 'bt-computer-row' }, t('Time of day'), h('input', { type: 'time', required: true, value: time, onChange: e => setTime(e.target.value) })),
        h('label', { className: 'bt-computer-row' }, t('IANA time zone'), h('input', { required: true, value: timeZone, maxLength: 100, placeholder: 'Asia/Shanghai', onChange: e => setTimeZone(e.target.value) })),
        kind === 'weekly' ? h('div', { className: 'bt-computer-row' }, weekdays.map((day, index) => h('label', { key: day },
          h('input', { type: 'checkbox', checked: days.includes(index + 1), onChange: e => setDays(e.target.checked ? [...days, index + 1].sort() : days.filter(n => n !== index + 1)) }), t(day)))) : null,
        h('label', { className: 'bt-computer-row' }, t('Missed occurrence'), h('select', { 'aria-label': t('Missed occurrence'), value: missed, onChange: e => setMissed(e.target.value) },
          h('option', { value: 'once' }, t('Run once when available')), h('option', { value: 'skip' }, t('Skip when over 5 minutes late'))))),
      h('label', { className: 'bt-computer-row' }, t('Total time limit (minutes)'), h('input', { type: 'number', min: 1, max: 1440, step: 1, required: true, disabled: busy, value: maxMinutes, onChange: e => setMaxMinutes(e.target.value) })),
      h('label', { className: 'bt-computer-row' }, t('No-progress limit (minutes)'), h('input', { type: 'number', min: 1, max: 1440, step: 1, required: true, disabled: busy, value: stallMinutes, onChange: e => setStallMinutes(e.target.value) })),
      h('p', { className: 'bt-muted' }, t('A waiting task still has a time limit. Timeout checks run every 30 seconds and pause the task for review.')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || !goal.trim() }, t('Add desktop task'))),
    error ? h('p', { role: 'alert', className: 'bt-error' }, t(error)) : null,
    items.map(item => h('section', { key: item.id, className: 'bt-computer-help' },
      h('p', null, item.goal), h('p', { role: 'status' }, `${t('Task status')}: ${t(item.status)}`),
      item.repeat ? h('p', { className: 'bt-muted' }, `${t(item.repeat.kind === 'daily' ? 'Daily' : 'Weekly')} ${item.repeat.time} · ${item.repeat.timeZone}${item.repeat.weekdays ? ` · ${item.repeat.weekdays.map(n => t(weekdays[n - 1])).join(', ')}` : ''} · ${t(item.repeat.missed === 'skip' ? 'Skip when over 5 minutes late' : 'Run once when available')}`) : null,
      item.runAt ? h('p', { className: 'bt-muted' }, t('Scheduled for {time}', { time: new Date(item.runAt).toLocaleString() })) : null,
      item.queueReason ? h('p', { className: 'bt-muted' }, t(queueReasons[item.queueReason] || item.queueReason)) : null,
      item.startedAt !== undefined ? h('p', { className: 'bt-muted' }, t('Elapsed: {minutes} min', { minutes: Math.floor(item.elapsedMs / 60000) })) : null,
      h('p', { className: 'bt-muted' }, t('Limits: {total} min total / {stall} min without progress', { total: (item.maxRunMs ?? 3600000) / 60000, stall: (item.stallMs ?? 600000) / 60000 })),
      item.step ? h('p', null, `${t('Current step')}: ${item.step}`) : null,
      item.progress !== undefined ? h('label', null, `${t('Task progress')}: ${item.progress}% `, h('progress', { max: 100, value: item.progress, 'aria-label': t('Task progress') })) : null,
      item.progressAt !== undefined ? h('p', { className: 'bt-muted' }, t('Last progress: {time}', { time: new Date(item.progressAt).toLocaleString() })) : null,
      item.waitReason ? h('p', { role: 'status' }, t(item.waitReason)) : null,
      item.note ? h('p', null, item.note) : null,
      item.history?.length ? h('details', null, h('summary', null, t('Run history ({count} total; latest 20)', { count: item.runs })),
        item.history.slice().reverse().map((result, index) => h('p', { key: index }, `${new Date(result.at).toLocaleString()} · ${t(result.status)} · ${result.note}`))) : null,
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
