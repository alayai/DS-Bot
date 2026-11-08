import { monitorRoute } from './src/host/channel.js'
import { createMonitorFeed } from './src/host/stream.js'

export const name = 'dsh-bothub'
export const inject = ['connection']

export function apply(ctx) {
  ctx.effect(() => {
    const feed = createMonitorFeed(() => ctx.get('botMonitor'))
    const off = ['agent/status', 'agent/created', 'agent/disposed', 'session/event']
      .map(event => ctx.on(event, () => feed.invalidate()))
    const unregister = ctx.connection.fetch.register({
      path: '/api/bothub/events', methods: ['GET'], requestBody: 'buffered',
      fetch: request => feed.open(request),
    })
    return () => {
      feed.dispose()
      for (const dispose of off) dispose()
      return unregister()
    }
  }, 'bothub: projection stream')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bothub',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => monitorRoute(request, ctx.get('botMonitor')),
  }), 'bothub: monitor channel')
}
