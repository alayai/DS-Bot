// Some OpenAI-compatible models emit an empty tool call id. Give it a stable
// nonempty id before DSH assembles and persists the assistant message.
// Historical session recovery belongs to DSH; this plugin never rewrites its logs.
import { randomUUID } from 'node:crypto'

const blankId = value => value === ''

function missingToolCallId(ids, index) {
  const known = ids.get(index)
  if (typeof known === 'string' && known.length > 0) return known
  const id = `repaired-call-${index}-${randomUUID()}`
  ids.set(index, id)
  return id
}

// One streamed chunk. A real id replaces a stand-in chosen for an earlier empty
// delta, so block-end still agrees with the id the provider did send.
export function repairToolCallChunk(chunk, ids) {
  if (chunk?.type === 'tool-call-delta') {
    if (blankId(chunk.id)) return { ...chunk, id: missingToolCallId(ids, chunk.index) }
    if (typeof chunk.id === 'string' && chunk.id.length > 0) ids.set(chunk.index, chunk.id)
    return chunk
  }
  if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
    if (!blankId(chunk.block.id)) {
      if (typeof chunk.block.id === 'string' && chunk.block.id.length > 0) ids.set(chunk.index, chunk.block.id)
      return chunk
    }
    return { ...chunk, block: { ...chunk.block, id: missingToolCallId(ids, chunk.index) } }
  }
  return chunk
}

export function install(rt) {
  rt.ctx.on('llm/stream', (_options, next) => {
    const ids = new Map()
    return (async function* repairToolCallIds() {
      for await (const chunk of next()) yield repairToolCallChunk(chunk, ids)
    })()
  })
}
