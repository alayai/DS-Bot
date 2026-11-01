import { refused } from './contract.js'

import { FILE_LIMIT } from '../../shared/computer-files.js'
export { FILE_LIMIT }
export function fileName(name) {
  if (typeof name !== 'string' || !/^[^/\\\x00-\x1f]{1,120}$/.test(name) || name.startsWith('.')) {
    throw refused('invalid', 'Use a plain file name without folders or hidden names.')
  }
  return name
}
export function fileBytes(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(FILE_LIMIT / 3) * 4) {
    throw refused('invalid', 'Invalid file bytes.')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > FILE_LIMIT || bytes.toString('base64') !== data) throw refused('invalid', 'Files must be at most 200 MiB.')
  return bytes
}
export async function contextFile(exec, attachments, id) {
  const reference = exec.agent.session.deriveMessages?.().flatMap(message => message.content ?? [])
    .find(block => block.type === 'file' && !block.offloaded && block.attachment?.attachmentId === id)?.attachment
  if (!reference) throw refused('owner-denied', 'The file must be attached in this Session context.')
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > FILE_LIMIT) {
    throw refused('invalid', 'Files must be at most 200 MiB.')
  }
  if (typeof attachments?.readFileStream !== 'function') throw refused('unavailable', 'File attachments are unavailable.')
  const data = Buffer.allocUnsafe(reference.bytes)
  let size = 0
  for await (const chunk of attachments.readFileStream(reference, exec.signal)) {
    size += chunk.length
    if (size > FILE_LIMIT) throw refused('invalid', 'Files must be at most 200 MiB.')
    data.set(chunk, size - chunk.length)
  }
  if (size !== reference.bytes) throw refused('invalid', 'The attachment length changed.')
  return data
}

export const computerOutput = {
  schema: { oneOf: [{ type: 'string' }, {
    type: 'object',
    properties: {
      text: { type: 'string', required: true },
      attachment: { type: 'object', additionalProperties: true },
      file: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  }] },
  render(_args, value) {
    if (typeof value === 'string') return [{ type: 'text', text: value }]
    return [
      { type: 'text', text: value.text },
      ...(value.attachment ? [{ type: 'image', attachment: value.attachment }] : []),
      ...(value.file ? [{ type: 'file', attachment: value.file }] : []),
    ]
  },
}
