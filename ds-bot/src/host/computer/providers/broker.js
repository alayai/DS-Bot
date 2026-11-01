import { createHash } from 'node:crypto'
import { uploadFile, downloadFile } from '../../../shared/computer-files.js'
import { brokerLaunch, openBroker } from './transport.js'
import { PROTOCOL_VERSION, refused } from '../contract.js'

const LIFECYCLE = new Set(['start', 'stop', 'upgrade', 'checkpoint', 'restore', 'cleanup', 'rollback', 'recreate'])

export function createBrokerProvider(config = {}) {
  let launch = brokerLaunch(config)
  const images = [...new Set([config.image, ...(config.images ?? [])])]
  let child
  let sequence = 0
  let closed = false
  let disconnected = false
  let reconnecting = false
  let runtimeKey
  let uncertainLifecycle = false
  const pending = new Map()
  const streams = new Map()
  function connect(internal = false) {
    if (closed) throw refused('unavailable', 'The Computer provider is closed.')
    if (reconnecting && !internal) throw refused('busy', 'Desktop service recovery is running.')
    if (disconnected) throw refused('provider-unavailable', 'The Computer Broker disconnected. Recover the desktop service before continuing.')
    if (child?.connected) return child
    const peer = openBroker(launch)
    child = peer
    peer.on('message', message => {
      if (child !== peer) return
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
      if (typeof message.runtimeKey === 'string' && /^[a-f0-9]{64}$/.test(message.runtimeKey)) {
        if (runtimeKey && message.runtimeKey !== runtimeKey) {
          disconnected = true
          for (const stream of streams.values()) stream.close()
          for (const item of pending.values()) item.reject(refused('runtime-changed', 'The desktop engine connection changed. Restore the previous connection before retrying.'))
          return
        }
        runtimeKey = message.runtimeKey
      }
      if (message.progress) {
        const p = message.progress
        if (['checking', 'copying', 'verifying'].includes(p.stage)
          && [p.doneBytes, p.totalBytes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1024 ** 4)) request.onProgress?.(p)
        return
      }
      if (message.ok) request.resolve(message.value)
      else request.reject(refused('provider-failed', typeof message.error === 'string'
        ? message.error.slice(0, 300) : 'The Computer operation failed. Its effect may be unknown.'))
    })
    const failed = () => {
      if (child !== peer) return
      disconnected = true
      for (const stream of streams.values()) stream.close()
      for (const request of pending.values()) {
        if (request.peer === peer) {
          if (LIFECYCLE.has(request.method)) uncertainLifecycle = true
          request.reject(refused('provider-unavailable', 'The Computer Broker disconnected. Input may have executed.'))
        }
      }
    }
    peer.on('error', failed)
    peer.on('disconnect', failed)
    peer.on('exit', code => {
      if (child !== peer) return
      failed()
      // The bundled Broker exits zero only after draining its shutdown work.
      if (code === 0) uncertainLifecycle = false
      child = undefined
    })
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
  function call(method, record, options = {}, internal = false) {
    const peer = connect(internal)
    const { signal, onProgress, ...payload } = options
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
        if (LIFECYCLE.has(method)) uncertainLifecycle = true
        if (peer.connected) peer.send({ cancel: id }, () => {})
        pending.get(id)?.reject(refused('result-unknown', 'The Computer request ended before its effect was confirmed.'))
      }
      const longFile = method === 'files' && ['begin-read', 'commit'].includes(payload.operation)
      const timer = setTimeout(abort, ['checkpoint', 'restore', 'upgrade'].includes(method) ? 65 * 60_000 : longFile ? 180_000 : 45_000)
      pending.set(id, { peer, method, onProgress, resolve: finish(resolve), reject: finish(reject) })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        peer.send({ id, method, record, options: payload }, error => {
          if (error && pending.get(id)?.peer === peer) {
            if (LIFECYCLE.has(method)) uncertainLifecycle = true
            pending.get(id)?.reject(refused('provider-unavailable', 'The Computer Broker could not receive this request.'))
          }
        })
      } catch {
        if (LIFECYCLE.has(method)) uncertainLifecycle = true
        pending.get(id)?.reject(refused('provider-unavailable', 'The Computer Broker could not receive this request.'))
      }
    })
  }
  return {
    protocolVersion: PROTOCOL_VERSION, kind: 'local-container', image: config.image, images, actions: ['click', 'text', 'key', 'scroll', 'drag'], maxActions: 1,
    async registerImage(image) {
      if (!/^sha256:[a-f0-9]{64}$/.test(image) || (!images.includes(image) && images.length >= 5)) throw refused('image-incompatible', 'Choose an immutable image within the prepared image limit.')
      await call('image-add', undefined, { image })
      if (!images.includes(image)) images.push(image)
      launch = brokerLaunch({ ...config, images: images.filter(id => id !== config.image) })
    },
    recoverySupported: Boolean(launch.entrypoint),
    connectionState: () => disconnected ? 'disconnected' : 'connected',
    async reconnect({ signal } = {}) {
      if (!launch.entrypoint) throw refused('unavailable', 'Restart DSH to recover a legacy WSL desktop bridge.')
      if (closed) throw refused('unavailable', 'The Computer provider is closed.')
      if (reconnecting) throw refused('busy', 'Desktop service recovery is running.')
      reconnecting = true
      disconnected = true
      try {
        for (const stream of streams.values()) stream.close()
        const peer = child
        if (peer && peer.exitCode === null && peer.signalCode === null) {
          await new Promise((resolve, reject) => {
            const finish = error => {
              clearTimeout(timer)
              peer.removeListener('exit', exited)
              signal?.removeEventListener('abort', aborted)
              if (error) reject(error)
              else resolve()
            }
            const exited = () => finish()
            const aborted = () => finish(refused('cancelled', 'Desktop service recovery was cancelled.'))
            const timer = setTimeout(() => finish(refused('recovery-required', 'The previous desktop service has not exited. Wait before retrying recovery.')), 35_000)
            peer.once('exit', exited)
            signal?.addEventListener('abort', aborted, { once: true })
            if (signal?.aborted) { aborted(); return }
            try { if (peer.connected) peer.disconnect() }
            catch { finish(refused('recovery-required', 'The previous desktop service could not be stopped.')) }
          })
        }
        signal?.throwIfAborted()
        if (closed) throw refused('unavailable', 'The Computer provider is closed.')
        if (uncertainLifecycle) throw refused('recovery-unsafe', 'A desktop startup or storage operation was interrupted. Restart DSH and check desktop recovery before continuing.')
        disconnected = false
        const result = await call('health', undefined, { signal }, true)
        if (result?.protocolVersion !== PROTOCOL_VERSION || !/^[a-f0-9]{64}$/.test(result.runtimeKey ?? '')
          || result.runtimeKey !== runtimeKey) throw refused('provider-unavailable', 'Update the desktop runtime before recovering its service.')
      } catch (error) {
        disconnected = true
        throw error
      } finally { reconnecting = false }
    },
    inspect: (record, options) => call('inspect', record, options),
    start: (record, options) => call('start', record, options),
    stop: (record, options) => call('stop', record, options),
    revoke: (record, options) => call('revoke', record, options),
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
        const result = await call('viewer-open', record, { ...options, stream: id })
        stream.interactive = result?.interactive === true
        if (options.interactive && !stream.interactive) throw refused('viewer-unavailable', 'Update the runtime before using live control.')
        return stream
      } catch (error) {
        stream.close()
        throw error
      }
    },
    diagnostics: (record, options) => call('diagnostics', record, options),
    quotaBackend: launch.engine?.kind === 'podman' ? 'podman-xfs' : null,
    checkQuota: (record, options) => call('quota-check', record, options),
    upgrade: (record, options) => call('upgrade', record, options),
    checkpoint: (record, options) => call('checkpoint', record, options),
    restore: (record, options) => call('restore', record, options),
    cleanup: (record, options) => call('cleanup', record, options),
    rollback: (record, options) => call('rollback', record, options),
    recreate: (record, options) => call('recreate', record, options),
    chunkedFiles: true,
    async importFile(record, { name, data, signal }) {
      return uploadFile(args => call('files', record, { ...args, ...(args.operation === 'abort' ? {} : { signal }) }), {
        name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
        chunk: (start, end) => data.subarray(start, end).toString('base64'), check: () => signal?.throwIfAborted(),
      })
    },
    async exportFile(record, { name, signal }) {
      let output
      let offset = 0
      const hash = createHash('sha256')
      await downloadFile(args => call('files', record, { ...args, ...(args.operation === 'abort' ? {} : { signal }) }), {
        name, check: () => signal?.throwIfAborted(),
        progress(_received, total) { output ??= Buffer.allocUnsafe(total) },
        chunk(data, expected) {
          const bytes = Buffer.from(data, 'base64')
          if (bytes.length !== expected || bytes.toString('base64') !== data) throw refused('invalid', 'Invalid export chunk.')
          output.set(bytes, offset)
          offset += bytes.length
          hash.update(bytes)
        },
        verify(sha256) {
          if (hash.digest('hex') !== sha256) throw refused('invalid', 'File checksum did not match.')
        },
      })
      return output
    },
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
