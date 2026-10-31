import { encodePng } from '../../../office/png.js'
import { PROTOCOL_VERSION, refused } from '../contract.js'

// Explicitly injected by tests; never selected by a user's serialized configuration.
export function createFakeComputer({ beforePerform } = {}) {
  const targets = new Map()
  const calls = []
  const target = record => {
    let value = targets.get(record.id)
    if (!value) targets.set(record.id, value = { running: false, generation: record.generation, actions: [], fence: null })
    if (value.generation !== record.generation) {
      value.generation = record.generation
      value.fence = null
    }
    return value
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'fake',
    calls,
    targets,
    async inspect(record) {
      return { phase: target(record).running ? 'ready' : 'stopped', isolation: 'none', provider: 'fake' }
    },
    async start(record) { target(record).running = true },
    async stop(record) { target(record).running = false; target(record).fence = null },
    async revoke(record) { target(record).fence = null },
    async observe(record, { fence, signal }) {
      signal?.throwIfAborted()
      const value = target(record)
      if (!value.running) throw refused('not-ready', 'The test desktop is stopped.')
      value.fence = fence
      const width = 64, height = 48
      const data = Buffer.alloc(width * height * 4, 255)
      // Each accepted action changes a visible pixel in this synthetic test frame.
      data[0] = value.actions.length % 256
      calls.push({ method: 'observe', computerId: record.id })
      return { data: encodePng({ width, height, data }), width, height }
    },
    async preview(record, options) {
      const value = target(record)
      const fence = value.fence
      const frame = await this.observe(record, { ...options, fence })
      value.fence = fence
      return frame
    },
    async files(record, { operation, name, data }) {
      const value = target(record)
      value.files ??= new Map()
      if (operation === 'list') return { files: [...value.files].map(([name, data]) => ({ name, bytes: Buffer.from(data, 'base64').length })) }
      if (operation === 'read') return { name, data: value.files.get(name) }
      if (value.files.has(name)) throw refused('invalid', 'File exists.')
      value.files.set(name, data)
      return { name, bytes: Buffer.from(data, 'base64').length }
    },
    async perform(record, { actions, fence, signal, operationId }) {
      await beforePerform?.({ record, actions, signal })
      const value = target(record)
      for (const action of actions) {
        signal?.throwIfAborted()
        if (!value.running || value.fence !== fence || value.generation !== record.generation) {
          throw refused('stale-lease', 'The test provider rejected a revoked fence.')
        }
        value.actions.push({ ...action })
      }
      calls.push({ method: 'perform', computerId: record.id, operationId })
      return { outcome: 'completed', completedActions: actions.length }
    },
  }
}
