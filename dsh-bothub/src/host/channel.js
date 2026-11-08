const reply = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

// The DSH connection service owns authentication. This route is an authenticated
// user view of the local team, not a workspace-selectable or model-callable API.
export async function monitorRoute(request, service) {
  // Connection routes receive a normalized Request URL, not the browser's
  // public origin. Authentication belongs to DSH; reject browser cross-site
  // calls without comparing that normalized URL with the Origin header.
  if (request.headers.get('sec-fetch-site') === 'cross-site') return reply({ error: 'forbidden' }, 403)
  if (!service) return reply({ error: 'bridge-missing' }, 503)
  if (service.version !== 2) return reply({ error: 'incompatible' }, 409)
  try {
    if (request.method === 'GET') return reply(await service.snapshot())
    if (request.method !== 'POST') return reply({ error: 'method' }, 405)
    const body = await request.json().catch(() => null)
    if (body?.action !== 'resolve' || typeof body.entityId !== 'string'
      || body.entityId.length > 256 || (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || body.sessionId.length > 256))
      || (body.groupId !== undefined && (typeof body.groupId !== 'string' || !body.groupId || body.groupId.length > 256))) {
      return reply({ error: 'invalid' }, 400)
    }
    const target = await service.resolve(body.entityId, body.sessionId, body.groupId)
    return target ? reply({ target }) : reply({ error: 'not-found' }, 404)
  } catch {
    // Host errors can contain local paths and configuration. Keep the channel bounded.
    return reply({ error: 'unavailable' }, 503)
  }
}
