import { brokerLaunch, openBroker } from './transport.js'
import { PROTOCOL_VERSION, refused } from '../contract.js'

export function createBrokerProvider(config = {}) {
  const launch = brokerLaunch(config)
  let child
  let sequence = 0
  let closed = false
  let disconnected = false
  const pending = new Map()
  function connect() {
    if (closed) throw refused('unavailable', 'The Computer provider is closed.')
    if (disconnected) throw refused('provider-unavailable', 'The Computer Broker disconnected. Restart the host to reconcile desktop ownership.')
    if (child?.connected) return child
    const peer = openBroker(launch)
    child = peer
    peer.on('message', message => {
      const request = pending.get(message?.id)
      if (!request || request.peer !== peer) return
      if (message.ok) request.resolve(message.value)
      else request.reject(refused('provider-failed', typeof message.error === 'string'
        ? message.error.slice(0, 300) : 'The Computer operation failed. Its effect may be unknown.'))
    })
    const failed = () => {
      disconnected = true
      for (const request of pending.values()) {
        if (request.peer === peer) request.reject(refused('provider-unavailable', 'The Computer Broker disconnected. Input may have executed.'))
      }
    }
    peer.on('error', failed)
    peer.on('disconnect', failed)
    peer.on('exit', () => { failed(); if (child === peer) child = undefined })
    return child
  }
  function call(method, record, options = {}) {
    const peer = connect()
    const { signal, ...payload } = options
    signal?.throwIfAborted()
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const finish = callback => value => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pending.delete(id)
        callback(value)
      }
      const abort = () => {
        if (peer.connected) peer.send({ cancel: id }, () => {})
        pending.get(id)?.reject(refused('result-unknown', 'The Computer request ended before its effect was confirmed.'))
      }
      const timer = setTimeout(abort, method === 'upgrade' ? 180_000 : 45_000)
      pending.set(id, { peer, resolve: finish(resolve), reject: finish(reject) })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        peer.send({ id, method, record, options: payload }, error => {
          if (error) pending.get(id)?.reject(refused('provider-unavailable', 'The Computer Broker could not receive this request.'))
        })
      } catch {
        pending.get(id)?.reject(refused('provider-unavailable', 'The Computer Broker could not receive this request.'))
      }
    })
  }
  return {
    protocolVersion: PROTOCOL_VERSION, kind: 'local-container', image: config.image, images: [...new Set([config.image, ...(config.images ?? [])])], actions: ['click', 'text', 'key', 'scroll'], maxActions: 1,
    inspect: record => call('inspect', record),
    start: (record, options) => call('start', record, options),
    stop: record => call('stop', record),
    revoke: record => call('revoke', record),
    async observe(record, options) {
      const result = await call('observe', record, options)
      if (typeof result?.data !== 'string' || result.data.length > 12 * 1024 * 1024) throw refused('observation-unavailable', 'Invalid desktop frame.')
      return { ...result, data: Buffer.from(result.data, 'base64') }
    },
    async preview(record, options) {
      const result = await call('preview', record, options)
      if (typeof result?.data !== 'string' || result.data.length > 12 * 1024 * 1024) throw refused('observation-unavailable', 'Invalid desktop frame.')
      return { ...result, data: Buffer.from(result.data, 'base64') }
    },
    diagnostics: (record, options) => call('diagnostics', record, options),
    upgrade: (record, options) => call('upgrade', record, options),
    checkpoint: (record, options) => call('checkpoint', record, options),
    restore: (record, options) => call('restore', record, options),
    cleanup: (record, options) => call('cleanup', record, options),
    rollback: (record, options) => call('rollback', record, options),
    recreate: (record, options) => call('recreate', record, options),
    files: (record, options) => call('files', record, options),
    perform: (record, options) => call('perform', record, options),
    async dispose() {
      closed = true
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const peer = child
      if (peer.connected) peer.disconnect()
      await new Promise(resolve => {
        const timer = setTimeout(() => { peer.kill('SIGKILL'); resolve() }, 35_000)
        peer.once('exit', () => { clearTimeout(timer); resolve() })
      })
    },
  }
}
