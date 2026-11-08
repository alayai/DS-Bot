import { createElement as h, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { entityState, runLabel, selectEntities } from './model.js'
import { Scene } from './world.js'
import css from './style.css'

export function HubIcon({ size = 20 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M3 7l7-4 7 4-7 4-7-4zm0 0v6l7 4 7-4V7M10 11v6' }))
}

const stateLabel = (state, t) => t(state === 'attention' ? 'attentionState' : state)
const Status = ({ state, t }) => h('span', { className: `bh-status bh-${state}` }, h('i'), stateLabel(state, t))

function Member({ entity, snapshot, selected, onSelect, t }) {
  const state = entityState(entity, snapshot)
  const count = snapshot.runs.filter(run => run.entityId === entity.id).length
  return h('button', {
    type: 'button', className: `bh-member${selected ? ' bh-selected' : ''}`,
    onClick: () => onSelect(entity.id), 'aria-pressed': selected,
    'data-entity': entity.id,
  },
  h('span', { className: 'bh-avatar', 'aria-hidden': true }, h(HubIcon, { size: 28 })),
  h('span', { className: 'bh-member-copy' }, h('strong', null, entity.name), h('span', null, entity.role || t(entity.kind))),
  h(Status, { state, t }),
  count > 0 && h('span', { className: 'bh-count' }, count))
}

function Detail({ entity, snapshot, open, connected, onSelect, t }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  if (!entity) return h('aside', { className: 'bh-detail bh-empty' }, h(HubIcon, { size: 40 }), h('p', null, t('select')))
  const sessions = snapshot.sessions.filter(item => item.entityId === entity.id)
  const runs = snapshot.runs.filter(item => item.entityId === entity.id)
  const parent = snapshot.entities.find(item => item.id === entity.parentEntityId)
  const children = snapshot.entities.filter(item => item.parentEntityId === entity.id)
  const go = async sessionId => {
    if (busy || !connected) return
    setBusy(true)
    setError(null)
    try { await open(entity.id, sessionId) } catch (failure) {
      if (mounted.current) setError(['not-found', 'unauthorized'].includes(failure.message) ? failure.message : 'unavailable')
    } finally { if (mounted.current) setBusy(false) }
  }
  return h('aside', { className: 'bh-detail', 'aria-label': entity.name },
    h('div', { className: 'bh-detail-top' }, h('div', { className: 'bh-avatar bh-avatar-large' }, h(HubIcon, { size: 36 })),
      h('h2', null, entity.name), h('p', null, entity.role),
      h(Status, { state: entityState(entity, snapshot), t })),
    h('div', { className: 'bh-tags' }, entity.main && h('span', null, t('main')), entity.private && h('span', null, t('private')), h('span', null, t(entity.kind))),
    parent && h('div', null, h('h3', null, t('parent')),
      h('button', { type: 'button', className: 'bh-context', onClick: () => onSelect(parent.id) }, parent.name)),
    children.length > 0 && h('div', null, h('h3', null, t('children')),
      ...children.map(child => h('button', { key: child.id, type: 'button', className: 'bh-context', onClick: () => onSelect(child.id) },
        child.name, h(Status, { state: entityState(child, snapshot), t })))),
    entity.mode === 'external' && h('p', { className: 'bh-note' }, t('external')),
    entity.kind !== 'bot' && entity.mode !== 'external' && h('p', { className: 'bh-note' }, t('agentCoverage')),
    entity.kind !== 'bot' && sessions.some(session => session.detailState !== 'observed') && h('p', { className: 'bh-note' }, t('detailCoverage')),
    h('h3', null, t('runs')),
    runs.length === 0 && h('p', { className: 'bh-muted' }, t('noRuns')),
    ...runs.map(run => {
      const duration = run.startedAt ? Math.max(0, Math.floor((snapshot.capturedAt - run.startedAt) / 1000)) : null
      return h('div', { className: 'bh-run', key: run.id },
        h('strong', null, t(runLabel(run))),
        (run.tools?.length > 0 || run.tool) && h('span', { className: 'bh-tools' }, (run.tools ?? [run.tool]).join(' · ')),
        h('span', null, run.groupId ? snapshot.groups.find(group => group.id === run.groupId)?.name || t('group') : t('own')),
        duration !== null && h('small', null, duration < 60 ? `${duration}${t('seconds')}` : `${Math.floor(duration / 60)}${t('minutes')}`))
    }),
    h('h3', null, t('contexts')),
    ...sessions.map(session => h('button', {
      className: 'bh-context', type: 'button', key: session.id,
      disabled: busy || !connected, onClick: () => go(session.id),
    },
    h('span', null, session.groupId ? snapshot.groups.find(group => group.id === session.groupId)?.name || t('group')
      : entity.kind !== 'bot' ? `${t('session')} ${sessions.indexOf(session) + 1}` : t('own')),
    h('small', null, session.blockers.length ? session.blockers.map(kind => t(kind === 'input' && session.pendingInput === 'continued' ? 'pendingInput' : kind)).join(' · ') : t(session.status)),
    h('span', { 'aria-hidden': true }, '↗'))),
    entityState(entity, snapshot) === 'unknown' && h('p', { className: 'bh-note' }, t('unknownNote')),
    h('div', { className: 'bh-detail-bottom' },
      error && h('p', { role: 'alert', className: 'bh-error' }, t(error)),
      h('button', { className: 'bh-primary', type: 'button', disabled: !entity.sessionId || busy || !connected, onClick: () => go() }, t(busy ? 'opening' : 'open')),
      h('p', { className: 'bh-note' }, t('native'))))
}

export function Hub({ store, open, t }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [view, setView] = useState('3d')
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [group, setGroup] = useState('all')
  const [sceneError, setSceneError] = useState(false)
  useEffect(() => store.start(), [store])
  const data = state.data
  const visible = useMemo(() => data ? selectEntities(data, { query, status, group }) : [], [data, query, status, group])
  const entity = data?.entities.find(item => item.id === selected)
  const attention = data?.entities.filter(item => entityState(item, data) === 'attention').length ?? 0
  return h('section', { className: 'bh-root', 'aria-label': 'BotHub' },
    h('style', null, css),
    h('header', { className: 'bh-header' }, h('div', null, h('div', { className: 'bh-title' }, h(HubIcon, { size: 24 }), h('h1', null, 'BotHub')), h('p', null, t('subtitle'))),
      h('div', { className: 'bh-connection', role: 'status' }, h('i', { className: state.phase === 'live' ? 'bh-live-dot' : '' }), t(state.phase)),
      h('button', { type: 'button', className: 'bh-button', onClick: () => void store.refresh() }, t('refresh'))),
    h('div', { className: 'bh-metrics' },
      ...[[data?.entities.length ?? 0, 'members'], [data?.runs.length ?? 0, 'runs'], [attention, 'attention']].map(([value, label]) =>
        h('div', { key: label }, h('strong', null, value), h('span', null, t(label)))),
      h('span', { className: 'bh-coverage' }, t('coverage'))),
    state.error && h('div', { className: 'bh-banner', role: 'alert' }, t(state.error)),
    data?.readOnly && h('div', { className: 'bh-banner' }, t('readOnly')),
    data?.partial && h('div', { className: 'bh-banner', role: 'status' }, t('partial')),
    h('div', { className: 'bh-toolbar' },
      h('input', { type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: query, onChange: event => setQuery(event.target.value) }),
      h('select', { value: status, 'aria-label': t('all'), onChange: event => setStatus(event.target.value) },
        ...['all', 'running', 'attention', 'waiting', 'idle', 'unknown'].map(key => h('option', { key, value: key }, key === 'all' ? t('all') : stateLabel(key, t)))),
      h('select', { value: group, 'aria-label': t('groups'), onChange: event => setGroup(event.target.value) },
        h('option', { value: 'all' }, t('groups')), ...(data?.groups ?? []).map(item => h('option', { key: item.id, value: item.id }, item.name))),
      h('div', { className: 'bh-switch', role: 'group', 'aria-label': t('scene') }, ...['2d', '3d'].map(mode => h('button', {
        key: mode, type: 'button', 'aria-pressed': view === mode, disabled: mode === '3d' && sceneError, onClick: () => setView(mode),
      }, mode.toUpperCase())))),
    sceneError && h('p', { className: 'bh-banner' }, t('webgl')),
    h('div', { className: 'bh-content' },
      h('main', { className: 'bh-workspace' },
        data && visible.length > 0
          ? view === '3d' ? h(Scene, { entities: visible, snapshot: data, selected, onSelect: setSelected, t, onError: () => { setSceneError(true); setView('2d') } })
            : h('div', { className: 'bh-members' }, ...visible.map(item => h(Member, { key: item.id, entity: item, snapshot: data, selected: item.id === selected, onSelect: setSelected, t })))
          : h('div', { className: 'bh-empty' }, h(HubIcon, { size: 48 }), h('p', null, t(!data ? state.error ? state.error : 'loading' : data.entities.length ? 'empty' : 'noTeam')))),
      h(Detail, { key: entity?.id ?? 'none', entity, snapshot: data, connected: state.phase === 'live', open, onSelect: setSelected, t })),
    h('footer', { className: 'bh-footer' }, data && `${t('updated')} ${new Date(data.capturedAt).toLocaleTimeString()}`, state.phase === 'stale' && ` · ${t('stale')}`))
}
