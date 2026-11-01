import { randomUUID } from 'node:crypto'

export const FILE_LIMIT = 200 * 1024 * 1024
export const CHUNK_SIZE = 256 * 1024
const TTL = 120_000
const plainName = name => typeof name === 'string' && /^[^/\\\x00-\x1f]{1,120}$/.test(name) && !name.startsWith('.')

// State belongs to one desktop generation. The caller serializes file operations
// with input/lifecycle operations; no guest path or staging name comes from IPC.
export function createTransfers(helper, now = Date.now) {
  let active
  async function clear() {
    if (!active) return
    const previous = active
    await helper({ operation: 'abort', temporary: previous.temporary })
    if (active === previous) active = null
  }
  async function call(args, signal) {
    if (active && active.expires <= now()) await clear()
    const operation = args.operation
    if (operation === 'delete') {
      if (active) throw new Error('Finish or cancel the current file transfer first.')
      if (!plainName(args.name) || typeof args.version !== 'string' || !/^[a-f0-9]{64}$/.test(args.version)) {
        throw new Error('List files before deleting a plain file name.')
      }
      return helper({ operation, name: args.name, version: args.version }, signal)
    }
    if (['begin-write', 'begin-read'].includes(operation)) {
      if (active) throw new Error('Finish or cancel the current file transfer first.')
      if (!plainName(args.name)) throw new Error('Use a plain file name.')
      if (operation === 'begin-write' && (!Number.isSafeInteger(args.bytes) || args.bytes < 0 || args.bytes > FILE_LIMIT
        || typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.sha256))) throw new Error('Invalid file size or checksum.')
      const id = randomUUID()
      active = { id, temporary: `.transfer-${id}`, operation, name: args.name, bytes: args.bytes, sha256: args.sha256, offset: 0, expires: now() + TTL }
      try {
        const value = await helper({ operation, temporary: active.temporary, name: args.name, bytes: args.bytes }, signal)
        if (operation === 'begin-read') {
          if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > FILE_LIMIT || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid export snapshot.')
          active.bytes = value.bytes
          active.sha256 = value.sha256
        }
        active.expires = now() + TTL
        return { transferId: id, name: active.name, bytes: active.bytes, sha256: active.sha256, chunkSize: CHUNK_SIZE }
      } catch (error) {
        await clear()
        throw error
      }
    }
    if (!active || args.transferId !== active.id) throw new Error('The file transfer expired or was cancelled. Start a new transfer.')
    if (operation === 'abort') { await clear(); return { cancelled: true } }
    const item = active
    item.expires = now() + TTL
    if (operation === 'commit') {
      if (item.offset !== item.bytes) throw new Error('The file transfer is incomplete.')
      try {
        if (item.operation === 'begin-write') await helper({ ...item, operation }, signal)
        return { name: item.name, bytes: item.bytes, sha256: item.sha256 }
      } finally { await clear() }
    }
    const writing = item.operation === 'begin-write'
    if (operation !== (writing ? 'write-chunk' : 'read-chunk') || args.offset !== item.offset) throw new Error('Invalid file transfer order.')
    let data
    if (writing) {
      if (typeof args.data !== 'string' || args.data.length > Math.ceil(CHUNK_SIZE / 3) * 4) throw new Error('Invalid file chunk.')
      data = Buffer.from(args.data, 'base64')
      if (!data.length || data.length > CHUNK_SIZE || data.toString('base64') !== args.data || item.offset + data.length > item.bytes) throw new Error('Invalid file chunk.')
    }
    try {
      const value = await helper({ ...item, operation, data: args.data, length: Math.min(CHUNK_SIZE, item.bytes - item.offset) }, signal)
      const length = writing ? data.length : value.bytes
      if (!Number.isSafeInteger(length) || length < 1 || length > CHUNK_SIZE || item.offset + length > item.bytes) throw new Error('Invalid file chunk length.')
      item.offset += length
      return { ...value, offset: item.offset, total: item.bytes }
    } catch (error) {
      // A lost reply never authorizes replaying a write at the same offset.
      await clear()
      throw error
    }
  }
  return { call, clear, expired: () => active && active.expires <= now() }
}
