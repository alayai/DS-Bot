import { brokerLaunch, openBroker } from './transport.js'
import { PROTOCOL_VERSION, refused } from '../contract.js'

export function createBrokerProvider(config = {}) {
  const launch = brokerLaunch(config)
  let child
  let sequence = 0
  let closed = false
  let disconnected = false
  const pending = new Map()
  const streams = new Map()
  function connect() {
    if (closed) throw refused('unavailable', 'The Computer provider is closed.')
    if (disconnected) throw refused('provider-unavailable', 'The Computer Broker disconnected. Restart the host to reconcile desktop ownership.')
    if (child?.connected) return child
    const peer = openBroker(launch)
    child = peer
    peer.on('message', message => {
      if (message?.stream !== undefined) {
        const stream = streams.get(message.stream)
        if (!stream) return
        if (message.type === 'data') {
          if (typeof message.data !== 'string' || message.data.length > 87384
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) {
            stream.close()
            return
          }
          const data = Buffer.from(message.data, 'base64')
          if (data.length > 65536) stream.close()
          else stream.push(data)
        } else if (message.type === 'written') stream.written()
        else if (message.type === 'close') stream.close()
        return
      }
      const request = pending.get(message?.id)
      if (!request || request.peer !== peer) return
      if (message.ok) request.resolve(message.value)
      else request.reject(refused('provider-failed', typeof message.error === 'string'
        ? message.error.slice(0, 300) : 'The Computer operation failed. Its effect may be unknown.'))
    })
    const failed = () => {
      disconnected = true
      for (const stream of streams.values()) stream.close()
      for (const request of pending.values()) {
        if (request.peer === peer) request.reject(refused('provider-unavailable', 'The Computer Broker disconnected. Input may have executed.'))
      }
    }
    peer.on('error', failed)
    peer.on('disconnect', failed)
    peer.on('exit', () => { failed(); if (child === peer) child = undefined })
    return child
  }
  function makeStream(peer, id) {
    let queued, listener, writing
    const closeListeners = new Set()
    const send = message => {
      try { peer.send({ stream: id, ...message }, error => { if (error) stream.close() }) }
      catch { stream.close() }
    }
    const deliver = data => {
      let acknowledged = false
      listener(data, () => {
        if (acknowledged || stream.closed) return
        acknowledged = true
        send({ type: 'ack' })
      })
    }
    const stream = {
      closed: false,
      push(data) {
        if (stream.closed) return
        if (data.length > 65536 || queued) return stream.close()
        if (listener) deliver(data)
        else queued = data
      },
      close() {
        if (stream.closed) return
        stream.closed = true
        streams.delete(id)
        if (peer.connected) send({ type: 'close' })
        writing?.reject(refused('viewer-unavailable', 'The viewer closed.'))
        writing = null
        for (const callback of closeListeners) callback()
        closeListeners.clear()
        queued = listener = null
      },
      written() { writing?.resolve(); writing = null },
      write(data) {
        if (stream.closed || writing || !Buffer.isBuffer(data) || data.length > 65536) {
          return Promise.reject(refused('viewer-unavailable', 'Invalid viewer write.'))
        }
        return new Promise((resolve, reject) => {
          writing = { resolve, reject }
          send({ type: 'write', data: data.toString('base64') })
        })
      },
      onData(callback) {
        if (!stream.closed) {
          listener = callback
          if (queued) { const data = queued; queued = null; deliver(data) }
        }
        return () => { listener = null }
      },
      onClose(callback) {
        if (stream.closed) callback()
        else closeListeners.add(callback)
        return () => closeListeners.delete(callback)
      },
    }
    return stream
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
    async openViewer(record, options = {}) {
      const peer = connect()
      const id = `viewer-${++sequence}`
      const stream = makeStream(peer, id)
      streams.set(id, stream)
      try {
        await call('viewer-open', record, { ...options, stream: id })
        return stream
      } catch (error) {
        stream.close()
        throw error
      }
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
      for (const stream of streams.values()) stream.close()
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
