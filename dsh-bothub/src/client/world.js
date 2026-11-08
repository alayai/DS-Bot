import { createElement as h, useEffect, useRef, useState } from 'react'
import { presenceKey } from './rooms.js'
import { allowsShortcut, cameraFrame } from './camera.js'
import { roomFixtures } from './office-layout.js'
import { motionKey, normalizeMotion, readMotion, saveMotion, normalizeQuality, qualityKey, readQuality, saveQuality } from './scene-settings.js'
import { mountWorld } from './world-renderer.js'

export function Scene({ layout, selected, onSelect, onFocus, onClear, onDesktop, focused, connected, previewEnabled = true, onError, t }) {
  const container = useRef(null)
  const labels = useRef(null)
  const renderer = useRef(null)
  const [quality, setQuality] = useState(readQuality)
  const [motion, setMotion] = useState(readMotion)
  const actions = useRef({ onSelect, onFocus, onClear, onDesktop, onError, t })
  actions.current = { onSelect, onFocus, onClear, onDesktop, onError, t }
  const act = callback => {
    callback()
    container.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    const value = mountWorld(container.current, labels.current,
      (id, groupId) => actions.current.onSelect(id, groupId), groupId => actions.current.onFocus(groupId),
      () => actions.current.onClear(),
      () => actions.current.onError(), key => actions.current.t(key),
      (id, groupId) => actions.current.onDesktop?.(id, groupId))
    renderer.current = value
    return () => { value.dispose(); renderer.current = null }
  }, [])
  useEffect(() => { renderer.current?.update(layout, selected, focused, connected, previewEnabled) }, [layout, selected, focused, connected, previewEnabled])
  useEffect(() => { renderer.current?.quality(quality) }, [quality])
  useEffect(() => { renderer.current?.motion(motion) }, [motion])
  useEffect(() => {
    const changed = event => {
      if (event.key === qualityKey || event.key === null) setQuality(readQuality())
      if (event.key === motionKey || event.key === null) setMotion(readMotion())
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  const frame = cameraFrame(layout, selected, focused)
  const closeup = frame.key.startsWith('member:')
  const common = layout.rooms.length === 1 && layout.rooms[0].groupId === null ? layout.rooms[0] : null
  return h('div', {
    className: 'bh-scene', ref: container, tabIndex: 0, role: 'group', 'aria-label': t('scene'),
    'aria-description': t('cameraHelp'),
    onKeyDown: event => {
      if (event.target === event.currentTarget && allowsShortcut(event) && renderer.current?.key(event.key)) event.preventDefault()
    },
  },
    h('div', { className: 'bh-scene-labels', ref: labels },
      ...(!closeup && common ? roomFixtures(common).map((fixture, index) =>
        ['coffee', 'snooker', 'lounge', 'fitness'].includes(fixture.kind) && h('span', {
          key: fixture.kind, className: 'bh-facility-label', 'data-fixture': index,
        }, t(fixture.kind))) : []),
      ...layout.rooms.map((room, index) => !closeup && h('button', {
        key: room.key, type: 'button', className: 'bh-scene-label bh-room-label', 'data-room': index,
        'data-space': room.key, 'aria-label': `${t('enterRoom')}: ${room.name ?? t('publicSpace')}`,
        onClick: () => act(() => onFocus(room.groupId)),
      }, h('strong', null, room.name ?? t('publicSpace')),
      h('span', null, `${room.total} ${t('members')}`))),
      ...layout.presences.map(({ entity, groupId, key, state }, index) => {
        if (closeup && key !== presenceKey(selected.entityId, selected.groupId)) return null
        return h('button', {
          key, type: 'button', className: 'bh-scene-label', 'data-seat': index,
          'data-entity': entity.id, 'data-space': JSON.stringify(groupId),
          'aria-label': `${entity.name} · ${layout.rooms.find(room => room.groupId === groupId)?.name ?? t('publicSpace')}`,
          'aria-pressed': selected?.entityId === entity.id && selected?.groupId === groupId,
          onClick: () => act(() => onSelect(entity.id, groupId)),
        }, h('strong', null, entity.name),
        h('span', { className: `bh-status bh-${state}` }, h('i'), t(state === 'attention' ? 'attentionState' : state)),
        h('span', { className: 'bh-activity', 'data-activity': '', 'aria-hidden': 'true' }),
        entity.kind === 'bot' && h('span', { className: 'bh-desktop', 'data-desktop': 'standby' }))
      })),
    h('div', { className: 'bh-scene-controls' },
      h('button', { type: 'button', className: 'bh-button', onClick: () => act(() => renderer.current?.reset()) }, t('overview')),
      h('label', { className: 'bh-quality', title: t('motionHelp') }, t('motion'),
        h('select', {
          value: motion, 'aria-label': t('motion'),
          onChange: event => { const value = normalizeMotion(event.target.value); setMotion(value); saveMotion(value) },
        }, ...['quiet', 'normal', 'lively'].map(value => h('option', { key: value, value }, t(`motion_${value}`))))),
      h('label', { className: 'bh-quality' }, t('quality'),
        h('select', {
          value: quality, 'aria-label': t('quality'),
          onChange: event => { const value = normalizeQuality(event.target.value); setQuality(value); saveQuality(value) },
        }, ...['low', 'balanced', 'high'].map(value => h('option', { key: value, value }, t(`quality_${value}`)))))),
    h('div', { className: 'bh-scene-help' },
      h('div', null, t(layout.truncated ? 'roomLimit' : 'roomHelp')),
      h('div', null, t('cameraHelp')),
      motion === 'lively' && h('div', null, t('motionHelp'))))
}
