import { createElement as h, useState } from 'react'
import { t } from './i18n.js'

const GIB = 1024 ** 3
export function ComputerResources({ state, record, busy, save, measure }) {
  const [draft, setDraft] = useState(null)
  if (!state?.limits) return null
  const values = draft ?? {
    revision: state.revision, maxRunning: state.limits.maxRunning,
    idleMinutes: state.limits.idleStopMs / 60_000,
    freeGiB: state.limits.freeWarningBytes / GIB, homeGiB: state.limits.homeWarningBytes / GIB,
    quotaGiB: (state.limits.newHomeQuotaBytes ?? 0) / GIB,
  }
  const input = (label, name, min, max, step = 1) => h('label', { className: 'bt-computer-row' }, t(label),
    h('input', { type: 'number', 'aria-label': t(label), min, max, step, value: values[name], disabled: busy,
      onChange: event => setDraft({ ...values, [name]: event.target.value }) }))
  const resource = record?.resources
  const storage = resource?.storage
  const stale = resource?.error || !resource?.at || Date.now() - resource.at > 120_000
  return h('details', { className: 'bt-computer-help' },
    h('summary', null, t('Desktop resources')),
    h('p', { className: 'bt-muted' }, t('These settings apply to every Bot desktop on this DSH host. Changing the running desktop limit never forcibly stops a desktop.')),
    input('Maximum running desktops', 'maxRunning', 1, 8),
    input('Idle stop after minutes (0 disables)', 'idleMinutes', 0, 10080),
    input('Warn below free space (GiB)', 'freeGiB', 0.25, 1024, 0.25),
    input('Warn above home size (GiB)', 'homeGiB', 0.25, 1024, 0.25),
    state.quotaBackend === 'podman-xfs' ? input('Hard quota for new homes (GiB, 0 disables)', 'quotaGiB', 0, 1024) : null,
    h('p', { className: 'bt-muted' }, t(state.quotaBackend === 'podman-xfs'
      ? 'Home quotas require XFS project quotas and a kernel enforcement check. They apply only to new homes; existing homes and engine disk space are not resized.'
      : 'This engine does not support managed persistent home quotas. Warning levels remain available.')),
    record?.homeQuotaBytes ? h('p', null, `${t('Current home hard quota')}: ${record.homeQuotaBytes / GIB} GiB`) : null,
    h('div', { className: 'bt-computer-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !draft,
        onClick: () => save({ expectedRevision: values.revision, limits: {
          maxRunning: Number(values.maxRunning), idleStopMs: Number(values.idleMinutes) * 60_000,
          freeWarningBytes: Number(values.freeGiB) * GIB, homeWarningBytes: Number(values.homeGiB) * GIB,
          newHomeQuotaBytes: Number(values.quotaGiB) * GIB,
        } }, () => setDraft(null)) }, t('Save resource settings')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !draft,
        onClick: () => setDraft(null) }, t('Discard changes')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !record || record.recoveryPending,
        onClick: measure }, t('Refresh disk usage'))),
    storage ? h('p', null, `${t('Home size')}: ${(storage.bytes / GIB).toFixed(2)} GiB · ${t('Disk available')}: ${(storage.freeBytes / GIB).toFixed(2)} / ${(storage.totalBytes / GIB).toFixed(2)} GiB`) : null,
    resource?.at ? h('p', { className: 'bt-muted' }, `${t('Measured at')}: ${new Date(resource.at).toLocaleTimeString()}`) : null,
    stale ? h('p', { className: 'bt-muted' }, t('Disk usage is unavailable or out of date. Refresh to check it.')) : null,
    resource?.warnings?.includes('low-space') ? h('p', { role: 'status', className: 'bt-error' }, t('Available disk space is below your warning level. Free space before continuing.')) : null,
    resource?.warnings?.includes('large-home') ? h('p', { role: 'status', className: 'bt-error' }, t('This desktop home is above your warning level. Review its files and saved copies.')) : null,
    h('p', { className: 'bt-muted' }, t('Warning levels do not enforce a disk quota. Disk space is shared with the container engine.')))
}
