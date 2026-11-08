import { monitorRoute } from './src/host/channel.js'

export const name = 'dsh-bothub'
export const inject = ['connection']

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/bothub',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => monitorRoute(request, ctx.get('botMonitor')),
  }), 'bothub: monitor channel')
}
