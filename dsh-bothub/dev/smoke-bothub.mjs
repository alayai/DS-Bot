// Run after ds-bot/dev/smoke.mjs, using only a disposable bothub-* bench.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port, mode = 'full'] = process.argv.slice(2)
if (!/^bothub-[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '')
  || Number(port) === 3080 || !['full', 'probe', 'disabled', 'recover'].includes(mode)) {
  throw new Error('Usage: node dev/smoke-bothub.mjs bothub-<bench> <port> [full|probe|disabled|recover]')
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const home = join(root, `.dsh-test-${name}`)
const base = `http://127.0.0.1:${port}`
const checks = []
try {
  const log = await readFile(join(home, 'web.log'), 'utf8')
  const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  assert.ok(login, 'test bench login unavailable')
  const auth = await fetch(login, { redirect: 'manual' })
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'test bench authentication failed')
  const call = (path, data) => fetch(base + path, {
    method: data ? 'POST' : 'GET',
    headers: { cookie, ...(data ? { 'content-type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000),
  })
  const hub = async payload => {
    const response = await call('/api/bothub', payload)
    assert.equal(response.status, 200, 'monitor request failed')
    return response.json()
  }
  const state = await (await call('/api/bot', { endpoint: 'state', payload: {} })).json()
  assert.equal(state.ok, true)
  checks.push('native DS Bot channel available')
  if (mode === 'disabled') {
    assert.equal((await call('/api/bothub')).status, 404)
    checks.push('disabled BotHub route removed while DS Bot remains available')
  } else {
    assert.equal((await fetch(base + '/api/bothub')).status, 401)
    checks.push('unauthenticated access rejected')
    const snapshot = await hub()
    assert.equal(snapshot.version, 2)
    assert.ok(snapshot.entities.length)
    assert.equal(snapshot.messaging, 1)
    checks.push('packaged bridge and monitor compatible')
    if (mode === 'recover') {
      const saved = JSON.parse(await readFile(join(home, 'bothub-receipt-check.json'), 'utf8'))
      const receipt = (await hub({ action: 'receipt', commandId: saved.commandId })).receipt
      assert.equal(receipt.status, 'accepted')
      assert.equal(receipt.sessionId, saved.sessionId)
      checks.push('accepted receipt survives host restart and package replacement')
    }
    if (mode === 'full') {
      const before = await readFile(join(home, 'mock.jsonl'), 'utf8')
      await hub(); await hub()
      assert.equal(await readFile(join(home, 'mock.jsonl'), 'utf8'), before)
      checks.push('passive snapshots make no model calls')
      const bot = snapshot.entities.find(item => item.kind === 'bot')
      assert.ok(bot)
      const commandId = randomUUID()
      const command = { action: 'send', commandId, entityId: bot.id, groupId: null,
        workspaceId: snapshot.workspaceId, text: `MVP acceptance ${commandId}` }
      const sentAt = Date.now()
      const replies = await Promise.all([hub(command), hub(command)])
      assert.equal(replies[0].receipt.status, 'accepted')
      assert.deepEqual(replies[0].receipt, replies[1].receipt)
      await writeFile(join(home, 'bothub-receipt-check.json'), JSON.stringify(replies[0].receipt))
      checks.push('duplicate command has one accepted receipt and target')
      const initial = new Set(snapshot.sessions.flatMap(session => (session.recentRuns ?? [])
        .map(run => `${session.id}:${run.turn}`)))
      let completed
      const deadline = Date.now() + 60000
      while (Date.now() < deadline && !completed) {
        const current = await hub()
        completed = current.sessions.filter(session => session.id === replies[0].receipt.sessionId)
          .flatMap(session => (session.recentRuns ?? []).filter(run => !initial.has(`${session.id}:${run.turn}`)))
          .find(run => run.outcome === 'completed' && run.endedAt >= sentAt)
        if (!completed) await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.ok(completed, 'short turn ending was not observed through the public projection')
      // The mock log truncates merged user messages to 160 characters. Count
      // durable user admissions, not a substring in that truncated diagnostic.
      const chat = await (await call('/api/bot', { endpoint: 'chat', payload: { botId: bot.id } })).json()
      assert.equal(chat.ok, true)
      assert.equal(chat.value.items.filter(item => item.kind === 'user' && item.text.includes(command.text)).length, 1)
      checks.push('one durable user message; authoritative short turn completion retained')
      const conflict = await call('/api/bothub', { ...command, text: 'conflicting payload' })
      assert.equal(conflict.status, 409)
      checks.push('same command ID with changed payload rejected')
    }
  }
  console.log(JSON.stringify({ mode, checks, passed: true }, null, 2))
} catch (error) {
  // Neither login URLs nor cookies belong in test diagnostics.
  console.error('BotHub smoke failed:', error.code ?? error.name)
  console.error(checks.join('\n'))
  process.exitCode = 1
}
