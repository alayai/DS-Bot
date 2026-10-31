// Native Windows Node → wsl.exe pipes → real Docker guest. No model credentials.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrokerProvider } from '../../ds-bot/src/host/computer/providers/broker.js'
import { createComputerService } from '../../ds-bot/src/host/computer/service.js'

const config = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''))
if (process.platform !== 'win32') throw new Error('Run this smoke with native Windows Node.')
const provider = createBrokerProvider(config.broker)
const home = await mkdtemp(join(tmpdir(), 'ds-bot-computer-bridge-'))
const service = createComputerService({ home, load: async () => {}, readOnly: () => undefined, botOf: id => id === 'bridge-fixture' ? { id } : undefined }, provider)
const run = promisify(execFile)
let record
try {
  record = await service.bind({ botId: 'bridge-fixture', expectedRevision: 0, grant: 'operate' })
  const args = { botId: record.botId, expectedGeneration: record.generation }
  await service.manage('start', args)
  const preview = await service.preview(args)
  assert.equal(preview.width, 1280)
  assert.equal(preview.height, 800)
  console.log('PASS: native Windows starts and views the real WSL desktop')
  args.controlToken = (await service.manage('takeover', args)).controlToken
  const frame = await service.preview(args)
  const input = { ...args, frameId: frame.frameId, requestId: 'win-click', actions: [{ type: 'click', x: 600, y: 400 }] }
  try {
    const first = await service.humanAct(input)
    assert.equal(first.outcome, 'unknown')
    assert.deepEqual(await service.humanAct(input), first)
    console.log('PASS: human input crosses the Windows bridge; unknown receipt is never replayed')
  } catch (error) {
    // A changing initial XFCE desktop may conservatively refuse input before dispatch.
    if (error.code !== 'bot/computer-stale-observation') throw error
    console.log('PASS: changing Windows-viewed frame is refused before input')
  }
  const data = Buffer.from('Windows bridge roundtrip\n').toString('base64')
  await service.files({ ...args, operation: 'write', name: 'bridge.txt', data })
  assert.equal((await service.files({ ...args, operation: 'read', name: 'bridge.txt' })).data, data)
  assert.equal((await service.files({ ...args, operation: 'list' })).files[0].name, 'bridge.txt')
  console.log('PASS: Windows import/list/export retains the exact file bytes')
  const old = args.controlToken
  args.controlToken = (await service.manage('takeover', args)).controlToken
  await assert.rejects(service.manage('release', { ...args, controlToken: old }), error => error.code === 'bot/computer-stale-control')
  await service.manage('release', args)
  await service.manage('stop', args)
  await service.manage('start', args)
  args.controlToken = (await service.manage('takeover', args)).controlToken
  assert.equal((await service.files({ ...args, operation: 'read', name: 'bridge.txt' })).data, data)
  console.log('PASS: stale windows cannot release control; restart retains guest files')
} finally {
  await service.dispose()
  if (record) {
    const docker = args => run('wsl.exe', ['--distribution', config.broker.wsl.distribution, '--exec', 'docker', ...args], { windowsHide: true, timeout: 30000 })
    await docker(['rm', '-f', `dsbot-${record.id}`])
    await docker(['volume', 'rm', `dsbot-${record.id}-home`])
  }
  await rm(home, { recursive: true, force: true })
}
