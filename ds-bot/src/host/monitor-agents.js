import { readActivity } from './monitor-activity.js'
import { readRecent } from './monitor-recent.js'

const MAX_CHILDREN = 64
const MAX_DEPTH = 4
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 240

export function agentActivity(ctx, entityId, sessionId, groupId = null, hasQuestion) {
  const agent = ctx?.get('agents')?.get(sessionId)
  const status = ['running', 'idle'].includes(agent?.status) ? agent.status : 'unknown'
  const details = readActivity(ctx, agent, hasQuestion)
  return {
    session: {
      id: sessionId, entityId, groupId, openSessionId: sessionId, status,
      blockers: details.blockers, pendingInput: details.pendingInput, detailState: details.detailState,
      ...readRecent(ctx, sessionId),
    },
    run: status === 'running' ? {
      id: `${sessionId}:${details.turn ?? 'active'}`, entityId, sessionId, groupId,
      turn: details.turn, startedAt: details.startedAt,
      phase: details.waiting ? 'waiting' : details.toolActive ? 'tool' : 'active',
      tool: details.tools[0] ?? null, tools: details.tools,
      blockers: details.blockers.filter(kind => kind !== 'input' || details.pendingInput === 'open'),
    } : null,
  }
}

// Bound both latency and catalog work. The abort listener is removed even when
// a provider fails without honoring cancellation.
function childrenOf(service, id, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => service.listChildren(id, signal)).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function discoverChildren(ctx, roots, signal) {
  const service = ctx.get('subagents')
  const result = { nodes: [], partial: false }
  if (!service?.listChildren) return { ...result, partial: roots.length > 0 }
  const queue = roots.map(root => ({ root, id: root.id, entityId: root.entityId, depth: 0 }))
  const seen = new Set(roots.map(root => root.id))
  let reads = 0
  while (queue.length) {
    if (signal.aborted || reads >= MAX_CHILDREN || result.nodes.length >= MAX_CHILDREN) {
      result.partial = true
      break
    }
    const parent = queue.shift()
    reads++
    let children
    try {
      children = await childrenOf(service, parent.id, signal)
      if (!Array.isArray(children)) throw new Error('invalid')
    } catch {
      result.partial = true
      continue
    }
    if (children.length > MAX_CHILDREN) result.partial = true
    for (const child of children.slice(0, MAX_CHILDREN)) {
      if (!validId(child?.id) || !['one-shot', 'continuable', 'unknown', 'external'].includes(child.mode)) {
        result.partial = true
        continue
      }
      if (seen.has(child.id)) { result.partial = true; continue }
      if (parent.depth >= MAX_DEPTH || result.nodes.length >= MAX_CHILDREN) {
        result.partial = true
        break
      }
      seen.add(child.id)
      const node = {
        root: parent.root, id: child.id, entityId: `subagent:${child.id}`,
        parentSessionId: parent.id, parentEntityId: parent.entityId,
        depth: parent.depth + 1, mode: child.mode,
        name: typeof child.label === 'string' ? child.label.slice(0, 120) : 'Subagent',
      }
      result.nodes.push(node)
      if (child.mode !== 'external') queue.push(node)
    }
  }
  return result
}

export function appendChildren(ctx, snapshot, discovery, hasQuestion) {
  snapshot.partial = discovery.partial
  for (const node of discovery.nodes) {
    // Refreshing after I/O prevents removed/rotated roots leaking into the view.
    if (!snapshot.sessions.some(session => session.id === node.root.id && session.entityId === node.root.entityId)) continue
    const external = node.mode === 'external'
    snapshot.entities.push({
      id: node.entityId, kind: 'subagent', name: node.name, role: '',
      main: false, private: false, waiting: false,
      sessionId: external ? null : node.id,
      rootEntityId: node.root.entityId, rootSessionId: node.root.id,
      parentEntityId: node.parentEntityId, parentSessionId: node.parentSessionId,
      mode: node.mode,
    })
    if (external) continue
    const { session, run } = agentActivity(ctx, node.entityId, node.id, node.root.groupId, hasQuestion)
    session.target = { parentSessionId: node.parentSessionId, childSessionId: node.id, mode: node.mode }
    snapshot.sessions.push(session)
    if (run) snapshot.runs.push(run)
  }
  return snapshot
}
