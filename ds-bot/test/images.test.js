import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { imageModelPrompt, imageReplyText, install, offloadTargets } from '../src/host/images.js'

test('offloadTargets selects live images from prior user and tool messages', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'user/message' },
    { type: 'user/message' },
  ]
  const messages = new Map([
    [events[0], { content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ] }],
    [events[1], { content: [{ type: 'image', attachment: { attachmentId: 'ignored' } }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'd' } }] }],
    [events[3], { content: [{ type: 'text', text: 'no image' }] }],
    [events[4], { content: [{ type: 'image', attachment: { attachmentId: 'new' } }] }],
  ])
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
  }

  assert.deepEqual(offloadTargets(session, 4), [
    { seq: 0, imageIndexes: [0, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
})

test('imageModelPrompt keeps user and assistant text and skips tool output', () => {
  const prompt = imageModelPrompt({
    system: '你是平面设计师',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '画一个红圆' }, { type: 'image', attachment: {} }] },
      { role: 'tool', content: [{ type: 'text', text: '忽略' }] },
      { role: 'assistant', content: [{ type: 'text', text: '上一稿' }] },
    ],
  })
  assert.equal(prompt, '你是平面设计师\n\n用户：画一个红圆\n\n助手：上一稿')
})

test('imageReplyText points markdown at a local file', () => {
  assert.equal(
    imageReplyText('完成', 'C:\\My Project (#1)\\bot\\generated-images\\a.png'),
    '完成\n\n![Image](<C:/My Project (%231)/bot/generated-images/a.png>)',
  )
})

async function imageTurn(t) {
  const home = await mkdtemp(join(tmpdir(), 'image test '))
  t.after(() => rm(home, { recursive: true, force: true }))
  const handlers = [], profile = { apiKeyEnv: 'MOCK_REF' }
  const ctx = {
    llm: { listConfigurableProviders: () => [{ provider: 'test', settingsNs: 'test', settingsPath: ['profile'], defaultBaseURL: 'https://default.invalid/v1' }] },
    on: (event, fn) => { if (event === 'llm/stream') handlers.push(fn) },
    get: name => name === 'settings' ? { describe: () => [{ ns: 'test', value: { profile } }] } : { resolve: async ref => ref === 'MOCK_REF' ? { value: 'fixture' } : undefined },
  }
  install({ ctx, home, config: {}, ownRequest: () => false })
  return { home, profile, run: signal => Array.fromAsync(handlers[0]({ model: 'gpt-image-1', provider: 'test', sessionId: 's', messages: [{ role: 'user', content: 'Draw a tree' }], signal })) }
}

test('image turns post to the default or overridden Images endpoint and save its PNG', async t => {
  const { home, profile, run } = await imageTurn(t)
  const urls = []
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF5kAAAAASUVORK5CYII='
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url)
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { model: 'gpt-image-1', prompt: '用户：Draw a tree', output_format: 'png' })
    return Response.json({ data: [{ b64_json: png }] })
  })
  for (const baseURL of [undefined, 'https://custom.invalid/v1/']) {
    profile.baseURL = baseURL
    const chunks = await run()
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const text = chunks.find(chunk => chunk.type === 'text-delta').text
    assert.ok((await readdir(join(home, 'generated-images'))).some(name => text.includes(name)))
  }
  assert.deepEqual(urls, ['https://default.invalid/v1/images/generations', 'https://custom.invalid/v1/images/generations'])
  for (const name of await readdir(join(home, 'generated-images'))) assert.deepEqual(await readFile(join(home, 'generated-images', name)), Buffer.from(png, 'base64'))
})

test('image turns distinguish user cancellation, timeout and provider failure', async t => {
  const { run, home } = await imageTurn(t)
  const user = new AbortController(), deadline = new AbortController()
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => { user.abort(); signal.throwIfAborted() })
  const reason = async signal => (await run(signal)).at(-1).reason
  assert.deepEqual(await reason(user.signal), { kind: 'aborted', failure: { code: 'ABORTED', message: 'Image generation cancelled' } })
  const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  fetch.mock.mockImplementationOnce(async (_url, { signal }) => { deadline.abort(); signal.throwIfAborted() })
  assert.equal((await reason()).failure.code, 'TIMEOUT')
  timeout.mock.restore()
  fetch.mock.mockImplementationOnce(async () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
  assert.deepEqual(await reason(), { kind: 'error', failure: { code: 'IMAGE_GENERATION_FAILED', message: 'Unavailable', status: 503 } })
  assert.deepEqual(await readdir(home), [])
})
