// Only the Host owner receives these summaries through dshCloud/readLocal.
// This provider reads already loaded memory: never refresh, load, save or resolve an Agent here.
export function install(rt) {
  rt.ctx.effect(() => rt.ctx.provide('botReadOnly', {
    version: 1,
    list(offset, limit) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError('Invalid read-only Bot page')
      if (!rt.snapshotReady()) return { ready: false, items: [], nextOffset: null }
      const bots = Object.values(rt.state.bots)
      return {
        ready: true,
        items: bots.slice(offset, offset + limit).map(bot => ({
          id: bot.id,
          name: bot.name.slice(0, 120),
          role: (bot.role ?? '').slice(0, 120),
          instructions: (bot.instructions ?? '').slice(0, 4096),
          model: (bot.model ?? '').slice(0, 200),
          private: bot.private === true,
          truncated: (bot.instructions?.length ?? 0) > 4096,
        })),
        nextOffset: offset + limit < bots.length ? offset + limit : null,
      }
    },
  }), 'ds-bot: loaded read-only settings')
}
