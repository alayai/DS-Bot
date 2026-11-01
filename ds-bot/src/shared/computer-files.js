export const FILE_LIMIT = 200 * 1024 * 1024
export const CHUNK_SIZE = 256 * 1024

export function checkTransfer(args) {
  const { operation } = args
  const fields = {
    'begin-write': ['name', 'bytes', 'sha256'], 'begin-read': ['name'],
    'write-chunk': ['transferId', 'offset', 'data'], 'read-chunk': ['transferId', 'offset'],
    commit: ['transferId'], abort: ['transferId'], delete: ['name', 'version'],
  }
  if (!Object.hasOwn(fields, operation)) throw new Error('Unknown file transfer operation.')
  const result = { operation }
  for (const field of fields[operation]) result[field] = args[field]
  if (operation.startsWith('begin-') || operation === 'delete') {
    if (typeof args.name !== 'string' || !/^[^/\\]{1,120}$/.test(args.name) || args.name.startsWith('.')
      || Array.from(args.name).some(char => char.charCodeAt(0) < 32)) throw new Error('Use a plain file name without folders or hidden names.')
    if (operation === 'begin-write' && (!Number.isSafeInteger(args.bytes) || args.bytes < 0 || args.bytes > FILE_LIMIT
      || typeof args.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.sha256))) throw new Error('Files must be at most 200 MiB and have a SHA-256 checksum.')
  } else if (typeof args.transferId !== 'string' || !/^[a-f0-9-]{36}$/.test(args.transferId)) throw new Error('Invalid file transfer identity.')
  if (operation === 'delete' && (typeof args.version !== 'string' || !/^[a-f0-9]{64}$/.test(args.version))) throw new Error('List files before deleting.')
  if (operation.endsWith('-chunk') && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > FILE_LIMIT)) throw new Error('Invalid file chunk offset.')
  if (operation === 'write-chunk' && (typeof args.data !== 'string' || args.data.length > Math.ceil(CHUNK_SIZE / 3) * 4)) throw new Error('Invalid file chunk.')
  return result
}

// call is bound to the initiating desktop, generation and control identity.
// Progress counts acknowledgements, never bytes merely queued for transport.
export async function uploadFile(call, { name, bytes, sha256, chunk, check = () => {}, progress = () => {} }) {
  let transfer
  try {
    check()
    transfer = await call({ operation: 'begin-write', name, bytes, sha256 })
    check()
    if (transfer.chunkSize !== CHUNK_SIZE || transfer.bytes !== bytes) throw new Error('Invalid file transfer response.')
    progress(0, bytes)
    for (let offset = 0; offset < bytes;) {
      check()
      const end = Math.min(offset + CHUNK_SIZE, bytes)
      const data = await chunk(offset, end)
      check()
      const result = await call({ operation: 'write-chunk', transferId: transfer.transferId, offset, data })
      check()
      if (result.offset !== end || result.total !== bytes) throw new Error('Invalid file transfer acknowledgement.')
      offset = end
      progress(offset, bytes)
    }
    check()
    const result = await call({ operation: 'commit', transferId: transfer.transferId })
    transfer = null
    check()
    return result
  } finally {
    if (transfer) await call({ operation: 'abort', transferId: transfer.transferId }).catch(() => {})
  }
}

export async function downloadFile(call, { name, chunk, verify, check = () => {}, progress = () => {} }) {
  let transfer
  try {
    check()
    transfer = await call({ operation: 'begin-read', name })
    check()
    if (!Number.isSafeInteger(transfer.bytes) || transfer.bytes < 0 || transfer.bytes > FILE_LIMIT
      || transfer.chunkSize !== CHUNK_SIZE || !/^[a-f0-9]{64}$/.test(transfer.sha256)) throw new Error('Invalid export snapshot.')
    progress(0, transfer.bytes)
    for (let offset = 0; offset < transfer.bytes;) {
      check()
      const result = await call({ operation: 'read-chunk', transferId: transfer.transferId, offset })
      check()
      const expected = Math.min(CHUNK_SIZE, transfer.bytes - offset)
      if (result.bytes !== expected || result.offset !== offset + expected || result.total !== transfer.bytes
        || typeof result.data !== 'string' || result.data.length > Math.ceil(CHUNK_SIZE / 3) * 4) throw new Error('Invalid export chunk.')
      await chunk(result.data, expected)
      offset += expected
      progress(offset, transfer.bytes)
    }
    check()
    await verify(transfer.sha256)
    check()
    await call({ operation: 'commit', transferId: transfer.transferId })
    const completed = transfer
    transfer = null
    check()
    return completed
  } finally {
    if (transfer) await call({ operation: 'abort', transferId: transfer.transferId }).catch(() => {})
  }
}
