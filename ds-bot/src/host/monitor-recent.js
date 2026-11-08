const KEY = 'dsBotMonitorRecent'
const LIMIT = 16
const integer = value => Number.isSafeInteger(value) && value >= 0
const time = value => Number.isFinite(value) && value >= 0 ? value : null
const outcomes = new Set(['completed', 'aborted', 'error', 'unknown'])

// This bounded projection survives short turns between monitor samples. It
// retains no text and never infers a successful result from an idle Agent.
export const recentProjection = {
  key: KEY, stateVersion: 1,
  stateSchema: {
    parse(value) {
      if (!value || !integer(value.inherited) || !Number.isSafeInteger(value.seq)
        || value.seq < value.inherited - 1 || !(value.turn === null || integer(value.turn))
        || !(value.startedAt === null || time(value.startedAt) !== null)
        || typeof value.truncated !== 'boolean' || !Array.isArray(value.recent) || value.recent.length > LIMIT
        || value.recent.some(run => !integer(run.turn) || !integer(run.seq) || !outcomes.has(run.outcome)
          || !(run.startedAt === null || time(run.startedAt) !== null)
          || !(run.endedAt === null || time(run.endedAt) !== null))) throw new Error('Invalid recent runs')
      return {
        inherited: value.inherited, seq: value.seq, turn: value.turn, startedAt: value.startedAt,
        truncated: value.truncated,
        recent: value.recent.map(({ turn, seq, startedAt, endedAt, outcome }) => ({ turn, seq, startedAt, endedAt, outcome })),
      }
    },
  },
  init(_header, inherited = 0) {
    return { inherited, seq: inherited - 1, turn: null, startedAt: null, recent: [], truncated: false }
  },
  apply(state, event) {
    if (!integer(event.seq) || event.seq <= state.seq || event.seq < state.inherited) return state
    const next = { ...state, seq: event.seq }
    const data = event.data ?? {}
    if (event.type === 'turn/start' && integer(data.turn)) {
      return { ...next, turn: data.turn, startedAt: time(event.time) }
    }
    if (event.type !== 'turn/end' || !integer(data.turn)) return next
    // An inherited start is deliberately ignored; its end is not our run.
    if (state.turn !== data.turn) return next
    const outcome = outcomes.has(data.reason?.kind) ? data.reason.kind : 'unknown'
    const recent = [...state.recent, {
      turn: data.turn, seq: event.seq, startedAt: state.startedAt, endedAt: time(event.time), outcome,
    }]
    return { ...next, turn: null, startedAt: null,
      recent: recent.slice(-LIMIT), truncated: state.truncated || recent.length > LIMIT }
  },
}

export function installRecent(ctx) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], scope => scope.sessionProjections.register(recentProjection))
  } else {
    const projections = ctx.get('sessionProjections')
    if (projections?.register) ctx.effect(() => projections.register(recentProjection), 'ds-bot: recent run projection')
  }
}

export function readRecent(ctx, sessionId) {
  const agent = ctx?.get('agents')?.get(sessionId)
  if (!agent?.session) return { recentRuns: [], recentCoverage: 'unavailable' }
  try {
    const state = ctx.get('sessionProjections')?.stateOf(agent.session, KEY)
    if (!state) return { recentRuns: [], recentCoverage: 'unavailable' }
    const parsed = recentProjection.stateSchema.parse(state)
    return { recentRuns: parsed.recent, recentCoverage: parsed.truncated ? 'bounded' : 'observed' }
  } catch {
    return { recentRuns: [], recentCoverage: 'unavailable' }
  }
}
