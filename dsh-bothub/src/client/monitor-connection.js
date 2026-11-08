// DSH also owns a long-lived connection in each page. A single additional Hub
// stream leaves room for authenticated reads on hosts using HTTP/1.
export function coordinateMonitorStream(stream, {
  locks = globalThis.navigator?.locks,
  path = globalThis.document ? new URL('api/bothub/events', document.baseURI).pathname : '/api/bothub/events',
} = {}) {
  return async (signal, cursor, receive) => {
    signal.throwIfAborted()
    if (!locks?.request) throw new Error('stream-occupied')
    let entered = false
    try {
      return await locks.request(`bothub:monitor:${path}`, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('stream-occupied')
        entered = true
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          Promise.resolve().then(() => {
            signal.throwIfAborted()
            return stream(signal, cursor, (type, frame) => { if (!signal.aborted) receive(type, frame) })
          }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        })
      })
    } catch (error) {
      if (!entered && ['SecurityError', 'NotSupportedError'].includes(error?.name)) throw new Error('stream-occupied')
      throw error
    }
  }
}
