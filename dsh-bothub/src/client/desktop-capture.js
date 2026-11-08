function pause(ms, signal, schedule, cancel) {
  return new Promise(resolve => {
    let timer
    const done = () => { cancel(timer); signal.removeEventListener('abort', done); resolve() }
    if (signal.aborted || ms <= 0) return resolve()
    signal.addEventListener('abort', done, { once: true })
    timer = schedule(done, ms)
  })
}

// Share capture time, not desktop pixels, between tabs in one storage partition.
// Resolving the image first avoids delaying display during the cooldown.
export function coordinateDesktopRequest(request, {
  locks = globalThis.navigator?.locks,
  path = globalThis.document ? new URL('api/bot', document.baseURI).pathname : '/api/bot',
  now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  return (endpoint, payload, signal) => {
    if (endpoint !== 'preview' || payload?.passive !== true || !locks?.request) return request(endpoint, payload, signal)
    return new Promise((resolve, reject) => {
      let acquired = false
      const abort = () => reject(signal.reason)
      const success = value => { signal.removeEventListener('abort', abort); resolve(value) }
      const failure = error => { signal.removeEventListener('abort', abort); reject(error) }
      if (signal.aborted) return failure(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      const name = `bothub:desktop:${JSON.stringify([path, payload.botId])}`
      Promise.resolve().then(() => locks.request(name, { signal }, async () => {
        acquired = true
        const started = now()
        try {
          signal.throwIfAborted()
          const value = await request(endpoint, payload, signal)
          signal.throwIfAborted()
          success(value)
        } catch (error) { failure(error) }
        finally { await pause(Math.max(0, 1000 - (now() - started)), signal, schedule, cancel) }
      })).catch(error => {
        // Storage policy can disable the API even when the property exists.
        // Never repeat a request that already entered the capture callback.
        if (!acquired && !signal.aborted && ['SecurityError', 'NotSupportedError'].includes(error?.name)) {
          Promise.resolve().then(() => request(endpoint, payload, signal)).then(success, failure)
        } else failure(error)
      })
    })
  }
}
