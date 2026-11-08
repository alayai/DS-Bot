import { agentActivity, appendChildren, discoverChildren } from './monitor-agents.js'
import { installActivity } from './monitor-activity.js'

// A user-facing read model. Keep content and configuration out of this service:
// consumers must open the real conversation to read or act on them.
export function monitorSnapshot(rt, now = Date.now()) {
  const { state } = rt
  const approvals = rt.approvalsView()
  const waiting = rt.waitingView()
  const sessions = []
  const runs = []
  const addSession = (entityId, sessionId, groupId) => {
    if (!sessionId) return
    const live = rt.live.get(sessionId)
    const blockers = []
    if (approvals.some(item => item.sessionId === sessionId)) blockers.push('approval')
    if (state.questions?.[sessionId] || state.views?.[sessionId]?.interactive) blockers.push('input')
    const running = live?.turn !== undefined
    sessions.push({
      id: sessionId, entityId, groupId: groupId ?? null,
      openSessionId: groupId ?? sessionId,
      status: running ? 'running' : live ? 'idle' : 'unknown',
      blockers,
    })
    if (running) runs.push({
      id: `${sessionId}:${live.turn}`, entityId, sessionId, groupId: groupId ?? null,
      turn: live.turn, startedAt: live.since ?? null,
      phase: blockers.length ? 'waiting' : live.tool ? 'tool' : 'thinking',
      // Tool names are identifiers; neither arguments nor free-form descriptions leave here.
      tool: typeof live.tool === 'string' && /^[\w./:-]{1,100}$/.test(live.tool) ? live.tool : null,
      blockers,
    })
  }
  const entities = Object.values(state.bots).map(bot => {
    addSession(bot.id, rt.chatOf(bot.id))
    for (const [id, owner] of rt.groupOwners) if (owner.botId === bot.id) addSession(bot.id, id, owner.roomId)
    return {
      id: bot.id, kind: 'bot', name: bot.name, role: bot.role ?? '',
      main: state.mainBotIds.includes(bot.id), private: bot.private === true,
      waiting: Boolean(waiting[bot.id]),
      sessionId: rt.chatOf(bot.id),
    }
  })
  for (const agent of Object.values(state.agents ?? {})) {
    const entityId = `agent:${agent.id}`
    for (const sessionId of agent.sessions ?? []) {
      const activity = agentActivity(rt.ctx, entityId, sessionId, null, rt.monitorHasQuestion)
      sessions.push(activity.session)
      if (activity.run) runs.push(activity.run)
    }
    entities.push({
      id: entityId, kind: 'agent', name: agent.name, role: 'DSH Agent',
      main: false, private: false, waiting: false, sessionId: agent.sessions?.[0] ?? null,
    })
  }
  return {
    version: 2, capturedAt: now, workspaceId: state.workspaceId ?? null,
    readOnly: rt.readOnly() !== undefined,
    coverage: 'bot-agent-live', groupNavigation: true,
    entities, sessions, runs,
    groups: Object.values(state.rooms).map(room => ({
      id: room.id, name: room.name, members: [...room.members],
    })),
  }
}

export function install(rt) {
  rt.monitorHasQuestion = installActivity(rt.ctx)
  const lifetime = new AbortController()
  let inFlight
  const collect = async () => {
    if (lifetime.signal.aborted) throw new Error('disposed')
    await rt.refresh()
    if (lifetime.signal.aborted) throw new Error('disposed')
    const controller = new AbortController()
    const abort = () => controller.abort()
    lifetime.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 2000)
    try {
      const discovery = await discoverChildren(rt.ctx, monitorSnapshot(rt).sessions, controller.signal)
      if (lifetime.signal.aborted) throw new Error('disposed')
      await rt.refresh()
      if (lifetime.signal.aborted) throw new Error('disposed')
      return appendChildren(rt.ctx, monitorSnapshot(rt), discovery, rt.monitorHasQuestion)
    } finally {
      clearTimeout(timeout)
      lifetime.signal.removeEventListener('abort', abort)
    }
  }
  const service = {
    version: 2,
    async snapshot() {
      inFlight ??= collect().finally(() => { inFlight = undefined })
      return inFlight
    },
    async resolve(entityId, sessionId, groupId) {
      // Navigation always performs a fresh catalog read, never a cached poll.
      if (inFlight) await inFlight
      const snapshot = await service.snapshot()
      const entity = snapshot.entities.find(item => item.id === entityId)
      if (!entity) return null
      if (groupId !== undefined) {
        const group = snapshot.groups.find(item => item.id === groupId)
        if (!group?.members.includes(entity.rootEntityId ?? entity.id)) return null
        if (entity.kind === 'bot' && sessionId === undefined) return group.id
        const session = snapshot.sessions.find(item => item.entityId === entityId
          && item.id === (sessionId ?? entity.sessionId) && item.groupId === groupId)
        return session?.target ?? session?.openSessionId ?? null
      }
      const session = snapshot.sessions.find(item => item.entityId === entityId && item.id === (sessionId ?? entity.sessionId))
      return session?.target ?? session?.openSessionId ?? null
    },
  }
  rt.ctx.effect(() => {
    const dispose = rt.ctx.provide('botMonitor', service)
    return () => { lifetime.abort(); dispose() }
  }, 'ds-bot: read-only monitor')
}
