// Explicit public Bot export for DSH cloud. This provider is separate from the
// bounded read-only preview so a truncated preview can never be published.
export function install(rt) {
  rt.ctx.effect(() => rt.ctx.provide('botExport', {
    version: 1,
    get(botId) {
      if (!rt.snapshotReady()) return { version: 1, exportable: false, reason: 'NOT_READY' }
      const bot = rt.botOf(botId)
      if (bot === undefined) return { version: 1, exportable: false, reason: 'NOT_FOUND' }
      if (bot.private === true) return { version: 1, exportable: false, reason: 'PRIVATE_BOT' }
      const name = typeof bot.name === 'string' ? bot.name.trim() : ''
      const role = typeof bot.role === 'string' ? bot.role : ''
      const instructions = typeof bot.instructions === 'string' ? bot.instructions : ''
      if (name.length < 1 || name.length > 100 || role.length > 120 || instructions.length > 16_000) {
        return { version: 1, exportable: false, reason: 'TOO_LARGE' }
      }
      return {
        version: 1,
        exportable: true,
        definition: { schemaVersion: 1, name, role, instructions, requiredCapabilities: [] },
      }
    },
  }), 'ds-bot: public cloud export')
}
