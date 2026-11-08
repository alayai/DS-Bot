export const flush = () => new Promise(resolve => setImmediate(resolve))

export function clock() {
  let now = 0, id = 0
  const timers = new Map()
  const environment = {
    random: () => 0,
    setTimeout(callback, ms) { const key = ++id; timers.set(key, { callback, at: now + ms }); return key },
    clearTimeout(key) { timers.delete(key) },
  }
  return {
    environment, timers,
    async advance(ms) {
      const end = now + ms
      for (let n = 0; n < 1000; n++) {
        const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) { now = end; await flush(); return }
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await flush()
      }
      throw new Error('timer loop')
    },
  }
}
