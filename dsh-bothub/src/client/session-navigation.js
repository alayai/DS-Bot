// Host resolution and the client's Session catalog arrive independently.
export function createSessionNavigation(sessions, open, environment = globalThis) {
  let cancel = () => {}, disposed = false
  const current = () => Object.values(sessions.list.getSnapshot().byId ?? {})
    .find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id
  return {
    open(resolveTarget) {
      cancel()
      if (disposed) return Promise.resolve(false)
      return new Promise((resolve, reject) => {
        let done = false, target, timer, off = () => {}
        const from = current()
        const finish = (error, opened = false) => {
          if (done) return
          done = true
          off()
          environment.clearTimeout(timer)
          cancel = () => {}
          if (error) reject(error)
          else resolve(opened)
        }
        cancel = () => finish(null)
        const check = () => {
          if (done) return
          if (current() !== from) { finish(null); return }
          if (target === undefined || typeof target === 'string' && !sessions.list.getSnapshot().byId?.[target]) return
          // Opening changes mainView references synchronously; stop observing first.
          off()
          off = () => {}
          try { open(target); finish(null, true) } catch (error) { finish(error) }
        }
        off = sessions.list.subscribe(check)
        timer = environment.setTimeout(() => finish(new Error('unavailable')), 10000)
        Promise.resolve().then(() => done ? undefined : resolveTarget()).then(value => {
          if (done) return
          target = value
          check()
          if (!done) Promise.resolve().then(() => done ? undefined : sessions.refresh()).catch(error => finish(error))
        }).catch(error => finish(error))
      })
    },
    dispose() { disposed = true; cancel() },
  }
}
