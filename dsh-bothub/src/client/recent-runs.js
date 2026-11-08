export function recentRuns(sessions, limit = 16) {
  return sessions.flatMap(session => (session.recentRuns ?? []).map(run => ({
    ...run, id: `${session.id}:${run.turn}`, sessionId: session.id, groupId: session.groupId,
  }))).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.seq - a.seq).slice(0, limit)
}
