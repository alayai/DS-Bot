const KEY = 'dsBotMonitorActivity'
const LIMIT = 128
const idOf = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
const integer = value => Number.isSafeInteger(value) && value >= 0
const toolName = value => typeof value === 'string' && /^[\w./:-]{1,100}$/.test(value) ? value : null
const empty = inherited => ({ inherited, turn: null, startedAt: null, calls: [], approvals: [], partial: false })

const stateSchema = {
  parse(value) {
    if (!value || !integer(value.inherited) || !(value.turn === null || integer(value.turn))
      || !(value.startedAt === null || (Number.isFinite(value.startedAt) && value.startedAt >= 0))
      || !Array.isArray(value.calls) || value.calls.length > LIMIT
      || !Array.isArray(value.approvals) || value.approvals.length > LIMIT || typeof value.partial !== 'boolean'
      || value.calls.some(call => !idOf(call?.id) || !(call.name === null || toolName(call.name)))
      || value.approvals.some(id => !idOf(id))) throw new Error('Invalid monitor projection')
    return {
      inherited: value.inherited, turn: value.turn, startedAt: value.startedAt,
      calls: value.calls.map(({ id, name }) => ({ id, name })),
      approvals: [...value.approvals], partial: value.partial,
    }
  },
}

export const activityProjection = {
  key: KEY, stateVersion: 1, stateSchema,
  init(_header, inherited = 0) { return empty(inherited) },
  apply(state, event) {
    if (!integer(event.seq) || event.seq < state.inherited) return state
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      if (!integer(data.turn)) return state
      return { ...empty(state.inherited), turn: data.turn, startedAt: Number.isFinite(event.time) && event.time >= 0 ? event.time : null }
    }
    if (state.turn === null) return state
    if (event.type === 'turn/end' && data.turn === state.turn) return empty(state.inherited)
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      if (event.type === 'tool/call' && data.turn !== state.turn) return state
      const id = idOf(event.type === 'tool/call' ? data.callId : data.subCallId)
      if (!id || state.calls.some(call => call.id === id)) return state
      if (state.calls.length >= LIMIT) return { ...state, partial: true }
      return { ...state, calls: [...state.calls, { id, name: toolName(data.name) }] }
    }
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const id = event.type === 'tool/result' ? data.message?.toolCallId : data.subCallId
      if (!state.calls.some(call => call.id === id)) return state
      return { ...state, calls: state.calls.filter(call => call.id !== id) }
    }
    if (event.type === 'approval/asked') {
      const id = idOf(data.id)
      if (!id || state.approvals.includes(id)) return state
      if (state.approvals.length >= LIMIT) return { ...state, partial: true }
      return { ...state, approvals: [...state.approvals, id] }
    }
    if (event.type === 'approval/decided' && state.approvals.includes(data.id)) {
      return { ...state, approvals: state.approvals.filter(id => id !== data.id) }
    }
    return state
  },
}

export function installActivity(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], scope => scope.sessionProjections.register(activityProjection))
  } else {
    const projections = ctx.get('sessionProjections')
    if (projections?.register) ctx.effect(() => projections.register(activityProjection), 'ds-bot: monitor activity projection')
  }

  // Legacy blocking questions have no durable question projection. Observe the
  // public answerer chain without reading its question, claiming it or cancelling it.
  const waiting = new WeakMap()
  const cleanups = new Set()
  let active = true
  ctx.effect(() => {
    const off = ctx.on('user-questions/request', async (request, next) => {
      const { agent, signal } = request
      if (!active || !agent || signal?.aborted) return next()
      const tokens = waiting.get(agent) ?? new Set()
      const token = Symbol()
      tokens.add(token)
      waiting.set(agent, tokens)
      const cleanup = () => {
        tokens.delete(token)
        cleanups.delete(cleanup)
        signal?.removeEventListener('abort', cleanup)
      }
      cleanups.add(cleanup)
      signal?.addEventListener('abort', cleanup, { once: true })
      try { return await next() } finally { cleanup() }
    }, { prepend: true })
    return () => {
      active = false
      off()
      for (const cleanup of cleanups) cleanup()
    }
  }, 'ds-bot: monitor question waits')
  return agent => active && (waiting.get(agent)?.size ?? 0) > 0
}

export function readActivity(ctx, agent, hasQuestion) {
  const result = {
    turn: null, startedAt: null, tools: [], toolActive: false,
    blockers: [], waiting: false, pendingInput: null, detailState: 'unavailable',
  }
  if (!agent || !['idle', 'running'].includes(agent.status)) return result
  const running = agent.status === 'running'
  const liveQuestion = running && hasQuestion?.(agent)
  let state
  let questions
  let failed = false
  const projections = ctx?.get('sessionProjections')
  if (projections?.stateOf && agent.session) {
    try { state = projections.stateOf(agent.session, KEY) } catch { failed = true }
    try { questions = projections.stateOf(agent.session, 'userQuestions')?.questions } catch { failed = true }
  }
  result.detailState = state && !failed ? state.partial ? 'partial' : 'observed' : 'unavailable'
  if (running && state?.turn !== null && state?.turn !== undefined) {
    result.turn = state.turn
    result.startedAt = state.startedAt
    result.tools = [...new Set(state.calls.map(call => call.name).filter(Boolean))]
    result.toolActive = state.calls.length > 0
    if (state.approvals.length) {
      result.blockers.push('approval')
      result.waiting = true
    }
  }
  const openQuestion = running && questions?.active?.some(question => question.state === 'open')
  const continuedQuestion = questions?.active?.some(question => question.state === 'continued')
  if (liveQuestion || openQuestion || continuedQuestion) {
    result.blockers.push('input')
    result.pendingInput = liveQuestion || openQuestion ? 'open' : 'continued'
    result.waiting ||= Boolean(liveQuestion || openQuestion)
  }
  return result
}
