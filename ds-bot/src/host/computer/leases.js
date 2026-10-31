import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { refused } from './contract.js'

export function createLeases({ now = () => performance.now(), ttl = 30_000 } = {}) {
  const entries = new Map()
  const epoch = randomUUID()
  let sequence = 0
  const same = (a, b) => a?.id === b?.id && a?.fence === b?.fence && a?.generation === b?.generation
  function acquire(computer, owner) {
    const previous = entries.get(computer.id)
    if (previous && previous.expiresAt > now()) {
      if (previous.generation !== computer.generation || previous.sessionId !== owner.sessionId || previous.turnId !== owner.turnId) {
        throw refused('busy', 'Another Session is using this desktop.')
      }
      previous.expiresAt = now() + ttl
      return { ...previous }
    }
    const next = {
      id: randomUUID(), computerId: computer.id, generation: computer.generation,
      sessionId: owner.sessionId, turnId: owner.turnId,
      fence: `${epoch}:${++sequence}`, expiresAt: now() + ttl,
    }
    entries.set(computer.id, next)
    return { ...next }
  }
  function check(lease) {
    const current = entries.get(lease.computerId)
    if (!same(current, lease) || current.expiresAt <= now()) throw refused('stale-lease', 'The desktop lease expired. Observe again.')
  }
  function renew(lease) {
    check(lease)
    entries.get(lease.computerId).expiresAt = now() + ttl
  }
  function keepAlive(lease, expired) {
    renew(lease)
    const timer = setInterval(() => {
      try { renew(lease) } catch (error) { clearInterval(timer); expired(error) }
    }, Math.max(1, Math.floor(ttl / 3)))
    timer.unref?.()
    return () => clearInterval(timer)
  }
  function release(lease) {
    if (!same(entries.get(lease.computerId), lease)) return false
    entries.delete(lease.computerId)
    return true
  }
  function revoke(id) { entries.delete(id) }
  return { acquire, check, renew, keepAlive, release, revoke }
}
