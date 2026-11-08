import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

export function Composer({ entity, groupId, snapshot, connected, messages, openReceipt, t }) {
  useSyncExternalStore(messages.subscribe, messages.getSnapshot)
  const [openError, setOpenError] = useState(false)
  const target = { workspaceId: snapshot.workspaceId ?? null, entityId: entity.id, groupId: groupId ?? null }
  const state = messages.get(target)
  const unknown = state.phase === 'unknown'
  const pending = state.phase === 'submitting' || state.checking
  const available = connected && !snapshot.readOnly && snapshot.messaging === 1
  const blocked = !available || pending || unknown || !messages.capacity(target)
  useEffect(() => {
    if (connected && state.restore) void messages.check(target)
  }, [connected, state.restore, state.command?.commandId])
  const group = groupId != null ? snapshot.groups.find(room => room.id === groupId) : null
  return h('form', {
    className: 'bh-composer', 'aria-label': t('quickMessage'),
    onSubmit: event => { event.preventDefault(); if (!blocked) void messages.send(target) },
  },
  h('h3', null, t('quickMessage')),
  h('p', { className: 'bh-message-target' }, `${t(group ? 'sendToGroup' : 'sendToBot')}: ${group?.name ?? entity.name}`),
  group && h('p', { className: 'bh-note' }, t('groupMessageScope')),
  h('textarea', {
    value: state.draft, maxLength: 4000, rows: 3, disabled: blocked,
    placeholder: t('messagePlaceholder'), 'aria-label': t('messageText'),
    onChange: event => messages.draft(target, event.target.value),
  }),
  h('div', { className: 'bh-compose-actions' },
    h('span', { className: 'bh-muted' }, `${state.draft.length}/4000`),
    h('button', { type: 'submit', className: 'bh-button', disabled: blocked || !state.draft.trim() }, t(state.phase === 'submitting' ? 'sending' : 'sendMessage'))),
  state.phase !== 'idle' && h('p', {
    role: state.phase === 'rejected' ? 'alert' : 'status',
    className: `bh-note${state.phase === 'rejected' ? ' bh-error' : ''}`,
  }, t(state.phase === 'accepted' ? 'messageAccepted' : state.phase === 'submitting' ? 'sending'
    : unknown ? 'receipt-unknown' : state.error && state.error !== 'unavailable' ? state.error : 'sendFailed')),
  !messages.capacity(target) && h('p', { className: 'bh-note' }, t('draftCapacity')),
  openError && h('p', { className: 'bh-error', role: 'alert' }, t('unavailable')),
  snapshot.readOnly && h('p', { className: 'bh-note' }, t('readOnly')),
  snapshot.messaging !== 1 && h('p', { className: 'bh-note' }, t('send-unavailable')),
  (unknown || state.phase === 'accepted') && h('div', { className: 'bh-receipt-actions' },
    unknown && h('button', { type: 'button', className: 'bh-button', disabled: !connected || pending,
      onClick: () => void messages.check(target) }, t(state.checking ? 'checkingReceipt' : 'checkReceipt')),
    state.receipt && h('button', { type: 'button', className: 'bh-button', disabled: !connected || pending,
      onClick: () => {
        setOpenError(false)
        void messages.check(target).then(receipt => { if (receipt) return openReceipt(receipt) }).catch(() => setOpenError(true))
      } }, t('viewDelivery')),
    h('button', { type: 'button', className: 'bh-button', disabled: pending,
      onClick: () => messages.clear(target) }, t('newMessage'))))
}
