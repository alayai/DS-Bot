import { createElement as h, useState } from 'react'
import { t } from './i18n.js'
export function ComputerPolicy({ record, call, changed }) {
  const [draft, setDraft] = useState(null), [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (!record) return null
  const value = draft ?? { ...record.policy, generation: record.generation, domains: (record.policy?.domains ?? []).join('\n') }
  const field = (label, name, min, max, step) => h('label', { className: 'bt-computer-row' }, t(label),
    h('input', { type: 'number', min, max, step, value: value[name], disabled: busy, onChange: e => { setConfirm(false); setDraft({ ...value, [name]: Number(e.target.value) }) } }))
  async function save() {
    setBusy(true); setError('')
    try { await call('configure', { expectedGeneration: value.generation, policy: {
      cpu: value.cpu, memoryMiB: value.memoryMiB, network: value.network,
      domains: value.domains.split(/[\s,]+/).filter(Boolean).map(name => name.toLowerCase()),
    } }); setDraft(null); setConfirm(false); changed() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return h('details', { className: 'bt-computer-help' }, h('summary', null, t('Desktop CPU, memory and network')),
    h('p', { className: 'bt-muted' }, t('Stop this desktop before saving. Its home is retained; the new limits apply on the next start.')),
    field('CPU cores', 'cpu', 1, 32, 1), field('Memory (MiB)', 'memoryMiB', 512, 65536, 256),
    h('label', { className: 'bt-computer-row' }, t('Network access'), h('select', { value: value.network, disabled: busy,
      onChange: e => { setConfirm(false); setDraft({ ...value, network: e.target.value }) } },
    ...['open', 'offline', 'restricted'].map(mode => h('option', { key: mode, value: mode, disabled: mode === 'restricted' && record.restrictedNetwork === false }, t(mode === 'open' ? 'Open internet' : mode === 'offline' ? 'Offline' : 'Allowed domains only'))))),
    value.network === 'restricted' ? h('p', { className: 'bt-muted' }, t('Only the exact listed domains are allowed through HTTP port 80 and HTTPS port 443. Subdomains must be listed separately. Open DSBot Restricted Browser on the desktop; other applications must use the configured HTTP proxy.')) : null,
    value.network === 'restricted' ? h('label', null, t('Allowed domains (one per line)'), h('textarea', { value: value.domains, disabled: busy,
      onChange: e => { setConfirm(false); setDraft({ ...value, domains: e.target.value }) } })) : null,
    error ? h('p', { className: 'bt-error', role: 'status' }, error) : null,
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !draft || record.phase !== 'stopped' || record.recoveryPending,
      onClick: () => confirm ? void save() : setConfirm(true) }, t(confirm ? 'Confirm desktop settings' : 'Save desktop settings')),
    draft ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { setDraft(null); setConfirm(false) } }, t('Discard changes')) : null)
}
