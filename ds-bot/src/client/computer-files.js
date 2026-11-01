import { sha256 } from '@noble/hashes/sha2.js'
import { uploadFile, downloadFile, checkTransfer, FILE_LIMIT, CHUNK_SIZE } from '../shared/computer-files.js'

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
async function readChunk(file, start, end, check) {
  check()
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
  check()
  if (bytes.length !== end - start) throw new Error('The file length changed.')
  return bytes
}
async function digest(file, check) {
  const hash = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      hash.update(await readChunk(file, offset, Math.min(offset + CHUNK_SIZE, file.size), check))
    }
    check()
    return hex(hash.digest())
  } finally { hash.destroy() }
}
export async function importDesktopFile(call, file, options) {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_LIMIT) throw new Error('Files must be at most 200 MiB.')
  options.check()
  const checksum = await digest(file, options.check)
  return uploadFile(call, {
    ...options, name: file.name, bytes: file.size, sha256: checksum,
    async chunk(start, end) {
      const bytes = await readChunk(file, start, end, options.check)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary)
    },
  })
}
export function validateDesktopFiles(files) {
  const names = new Set()
  for (const file of files) {
    try {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_LIMIT) throw new Error('Files must be at most 200 MiB.')
      checkTransfer({ operation: 'begin-read', name: file.name })
      if (names.has(file.name)) throw new Error('Choose files with different names.')
      names.add(file.name)
    } catch (error) {
      error.fileName = file.name
      throw error
    }
  }
}
export async function importDesktopFiles(call, files, options) {
  // Check the whole selection before reading or publishing any of its files.
  validateDesktopFiles(files)
  for (let index = 0; index < files.length; index++) {
    try {
      options.check()
      options.current?.(files[index], index, files.length)
      options.status?.(index, 'Uploading')
      await importDesktopFile(call, files[index], options)
      options.check()
      options.status?.(index, 'Uploaded')
    } catch (error) {
      options.status?.(index, 'Check destination', error.message)
      for (let remaining = index + 1; remaining < files.length; remaining++) options.status?.(remaining, 'Not uploaded')
      throw error
    }
  }
}
export async function exportDesktopFile(call, name, options) {
  const chunks = []
  const hash = sha256.create()
  try {
    await downloadFile(call, {
      ...options, name,
      chunk(data, expected) {
        const binary = atob(data)
        if (binary.length !== expected || btoa(binary) !== data) throw new Error('Invalid export chunk.')
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
        hash.update(bytes)
        chunks.push(new Blob([bytes]))
      },
      verify(checksum) {
        if (hex(hash.digest()) !== checksum) throw new Error('File checksum did not match.')
      },
    })
    return new Blob(chunks, { type: 'application/octet-stream' })
  } finally { hash.destroy() }
}
