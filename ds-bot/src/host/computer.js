import { defineTool } from '@deepseek-ai/dsh-tools'
import { computerOutput } from './computer/artifacts.js'
import { TOOL_NAMES, refused } from './computer/contract.js'
import { createComputerService } from './computer/service.js'
import { createBrokerProvider } from './computer/providers/broker.js'
import { createComputerSetup } from './computer/setup.js'
import { registerComputerViewer } from './computer/viewer.js'

export function install(rt) {
  let computer
  const activate = broker => {
    if (computer) return
    // Test providers are in-process injections, never serialized settings.
    const provider = rt.config.computerProvider ?? createBrokerProvider(broker)
    computer = createComputerService(rt, provider)
    rt.computer = computer
    installTools(rt, provider, computer)
  }
  const setup = createComputerSetup(rt, activate, rt.config.computerSetupOptions)
  rt.computerSetup = setup
  rt.ctx.effect(() => {
    const dispose = registerComputerViewer(rt, () => computer)
    return () => dispose?.()
  }, 'ds-bot: computer viewer')
  rt.ctx.effect(() => {
    void setup.restore().catch(() => {})
    return async () => { await setup.dispose(); await computer?.dispose() }
  }, 'ds-bot: computers')
  if (rt.config.computer?.enabled === true) activate(rt.config.computer.broker)
}

function installTools(rt, provider, computer) {
  const maxActions = provider.maxActions ?? 8
  const names = new Set(TOOL_NAMES)
  const actionParameters = {
    observationId: { type: 'string', required: true, description: 'The observation returned in this Session.' },
    actions: {
      type: 'array', required: true, description: `Between one and ${maxActions} action(s).`,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: provider.actions ?? ['click', 'text', 'key', 'scroll', 'drag'], required: true },
          x: { type: 'integer' }, y: { type: 'integer' },
          toX: { type: 'integer', description: 'Drag endpoint in observed pixels.' }, toY: { type: 'integer' },
          durationMs: { type: 'integer', description: 'Drag duration, 100–2000 ms; default 500.' },
          count: { type: 'integer', enum: [1, 2], description: 'Click count; 2 performs one double-click gesture.' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Super'] } },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          text: { type: 'string', description: 'Between one and 4000 characters.' },
          key: { type: 'string', description: 'Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp/Down, Space, F1–F12, or one ASCII letter/digit. Use modifiers for chords.' }, deltaY: { type: 'integer', description: 'Signed line steps: -50 to 50, excluding zero; positive scrolls down.' },
        },
        additionalProperties: false,
      },
    },
  }
  const definitions = [
    ['computer_status', 'Check your assigned desktop without starting it. Assisted mode does not isolate your other tools.', {}, (_args, exec) => computer.status(exec)],
    ['computer_observe', 'Observe your assigned desktop. The user must start it first. Coordinates belong to this screenshot and Session.', {}, (_args, exec) => computer.observe(exec)],
    ['computer_act', `Perform up to ${maxActions} desktop action(s) using your latest observation. Approval is required unless the user selected YOLO for this desktop. Observe again after each batch. Never replay unknown results.`, actionParameters, (args, exec) => computer.act(args, exec)],
    ['computer_request_takeover', 'Ask the user to help on your private desktop, pause automatic access and end this turn. Use for login, CAPTCHA, payment or another human-only step. Never include passwords in the note.', {
      reason: { type: 'string', enum: ['login', 'captcha', 'payment', 'other'], required: true },
      note: { type: 'string', required: true, description: 'What the user should do, at most 1000 characters.' },
    }, (args, exec) => computer.handoffs.request(args, exec)],
    ['computer_release', 'Release your desktop so another Session of your Bot can use it.', {}, (_args, exec) => computer.release(exec)],
    ['computer_files', 'List files in your private desktop /home/cua/DSBot transfer folder.', {}, (args, exec) => computer.modelFiles('list', args, exec)],
    ['computer_import', 'Import a file attached in this Session into /home/cua/DSBot. Flat names only, 200 MiB maximum; existing files are never overwritten.', {
      attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true },
    }, (args, exec) => computer.modelFiles('import', args, exec)],
    ['computer_export', 'Attach a file from /home/cua/DSBot to this conversation. Flat names only, 200 MiB maximum.', {
      name: { type: 'string', required: true },
    }, (args, exec) => computer.modelFiles('export', args, exec)],
  ].map(([name, description, parameters, execute]) => defineTool({
    name, description, parameters, output: computerOutput,
    async execute(args, exec) {
      if (!computer) throw refused('off', 'Prepare a private desktop before using Computer tools.')
      const result = await execute(args, exec)
      return result?.attachment || result?.file ? result : JSON.stringify(result)
    },
  }))
  const installed = new WeakSet()
  async function scope(agent) {
    await rt.load()
    if (!computer || !agent || installed.has(agent) || !rt.isBotSession(agent.session?.id ?? agent.id)) return
    if (typeof agent.ctx?.tools?.register !== 'function') throw refused('scope-unavailable', 'DSH scoped tools are unavailable.')
    for (const definition of definitions) agent.ctx.tools.register(definition)
    installed.add(agent)
  }
  rt.ctx.on('agent/created', ({ agent }) => scope(agent))
  rt.ctx.on('agent/pre-step', async ({ agent }, next) => {
    await scope(agent)
    return next()
  })
  rt.ctx.tools.guard(exec => {
    if (!names.has(exec.name)) return
    const id = exec.agent?.session?.id ?? exec.agent?.id
    if (!rt.isBotSession(id)) return 'Only current Bot Sessions can use Computer tools. Subagents are not enabled.'
    if (rt.readOnly() !== undefined) return 'This host does not own the Bot team.'
  })
  rt.ctx.on('session/event', (session, event) => {
    if (!computer) return
    if (event.type === 'user/message' && ['user', 'user-question-reply'].includes(event.data?.source?.kind)) {
      return computer.handoffs.cancel(session.id).catch(() => rt.warn('ds-bot: desktop help cancellation failed'))
    }
    if (event.type !== 'turn/end') return
    if (event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user') {
      void computer.handoffs.cancel(session.id).catch(() => rt.warn('ds-bot: desktop help cancellation failed'))
    }
    void computer.endTurn(session.id, event.data?.turn).catch(() => rt.warn('ds-bot: desktop release failed; the desktop remains blocked'))
  })
  rt.ctx.effect(() => {
    const timer = setInterval(() => { void computer?.reapIdle().catch(() => rt.warn('ds-bot: idle desktop shutdown failed')) }, 30_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: computer idle')
}
