const reply = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})
const commandErrors = {
  invalid: 400, 'read-only': 403, 'not-found': 404, 'scope-changed': 409,
  'command-conflict': 409, 'target-changed': 409, 'command-capacity': 429,
  'command-busy': 429, 'command-store': 503, 'send-unavailable': 503, unavailable: 503,
}
async function bodyOf(request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch { return null } finally { reader.releaseLock() }
}

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
    const body = await bodyOf(request)
    if (body?.action === 'send' || body?.action === 'receipt') {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply({ error: 'invalid' }, 400)
      if (typeof service.send !== 'function' || typeof service.receipt !== 'function') return reply({ error: 'send-unavailable' }, 503)
      const receipt = body.action === 'send' ? await service.send({
        commandId: body.commandId, entityId: body.entityId, groupId: body.groupId,
        workspaceId: body.workspaceId, text: body.text,
      }) : await service.receipt(body.commandId)
      return reply({ receipt })
    }
    if (body?.action !== 'resolve' || typeof body.entityId !== 'string'
      || body.entityId.length > 256 || (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || body.sessionId.length > 256))
      || (body.groupId !== undefined && (typeof body.groupId !== 'string' || !body.groupId || body.groupId.length > 256))) {
      return reply({ error: 'invalid' }, 400)
    }
    const target = await service.resolve(body.entityId, body.sessionId, body.groupId)
    return target ? reply({ target }) : reply({ error: 'not-found' }, 404)
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code.startsWith('bothub/') ? error.code.slice(7) : null
    if (Object.hasOwn(commandErrors, code)) return reply({ error: code }, commandErrors[code])
    // Host errors can contain local paths and configuration. Keep the channel bounded.
    return reply({ error: 'unavailable' }, 503)
  }
}
