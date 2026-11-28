import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { imageModelPrompt, imageReplyText, install as imagesInstall, offloadTargets } from '../src/host/images.js'
import { install as servicesInstall } from '../src/host/deepseek-services.js'
import { assembleLlmStream } from '../src/host/models.js'

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

test('image OCR retries transient TRANSPORT failures instead of caching a 2-minute failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let calls = 0
  const ctx = {
    on: () => () => {},
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'Image: Retry banner.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    warn: () => {},
    catalog: async () => [{ ref: 'deepseek-account/deepseek-flash', name: 'DeepSeek-V4.1-Flash', input: ['text', 'image'] }],
    defaultRef: () => 'deepseek-account/deepseek-flash',
    isLocalAgentRef: () => false,
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)
  const [line] = await rt.imagesForGroup([{ attachmentId: 'sha256:abcdef1234567890', name: 'shot.png' }], 'g1')
  assert.equal(calls, 2)
  assert.match(line, /Image: Retry banner\./)
})

test('the image note names read_document only when DeepSeek OCR is on', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const attachment = { attachmentId: 'sha256:img-1', name: 'note.png' }
  const makeRt = (prefs) => {
    const rt = {
      ctx: { on: () => () => {}, effect: f => f(), llm: { resolveModelInfo: async () => ({}) } },
      config: {}, home, warn: () => {},
      state: { prefs },
      teamTools: [],
      catalog: async () => [], defaultRef: () => undefined,
      isLocalAgentRef: () => false, ownRequest: () => false,
      tagUsage: m => m,
    }
    servicesInstall(rt)
    imagesInstall(rt)
    return rt
  }
  // With OCR on, the group note names the tool and the full attachment id.
  const on = makeRt({ deepseekServices: { ocr: true } })
  const [line] = await on.imagesForGroup([attachment], 'g1')
  assert.match(line, /read_document/)
  assert.match(line, /sha256:img-1/)
  // With OCR off, the note stays as before.
  const off = makeRt({})
  const [plain] = await off.imagesForGroup([attachment], 'g1')
  assert.doesNotMatch(plain, /read_document/)
})

test('imagesForGroup stays neutral when no OCR model is available, while text-only members still receive the fallback warning', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const hooks = new Map()
  const sent = []
  const ctx = {
    on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name) },
    get: name => (name === 'attachments' ? { imageHostPath: () => '/tmp/shot.png' } : undefined),
    llm: {
      resolveModelInfo: async (_provider, model) => ({
        inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'],
      }),
      async *stream(options) {
        sent.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    load: async () => {},
    warn: () => {},
    roomOf: () => undefined,
    catalog: async () => [
      { ref: 'deepseek/text-only', name: 'TextOnly', input: ['text'] },
      { ref: 'local-claude-code/sonnet', name: 'Claude', input: ['text', 'image'] },
    ],
    defaultRef: () => 'deepseek/text-only',
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('local-'),
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)

  const attachment = { attachmentId: 'sha256:1234567890abcdef', name: 'shot.png' }
  const [groupLine] = await rt.imagesForGroup([attachment], 'r1')
  assert.equal(groupLine, '[Image "shot.png" (read-only copy saved at "/tmp/shot.png") attached]')
  assert.doesNotMatch(groupLine, /could not be read|Ask the user/i)

  const streamHook = hooks.get('llm/stream')
  const msg = { role: 'user', content: [{ type: 'text', text: groupLine }, { type: 'image', attachment }] }
  // Vision member passes straight through with the raw image block intact.
  let passedVision = false
  const visionChunks = []
  for await (const chunk of streamHook({ sessionId: 'm1', provider: 'local-claude-code', model: 'sonnet', messages: [msg] }, async function* () {
    passedVision = true
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) visionChunks.push(chunk)
  assert.equal(passedVision, true)
  assert.equal(visionChunks.length, 1)

  // Text-only member rewrites the raw image block into an explicit "you cannot see images" fallback.
  const textChunks = []
  for await (const chunk of streamHook({ sessionId: 'm2', provider: 'deepseek', model: 'text-only', messages: [msg] }, async function* () {})) textChunks.push(chunk)
  assert.equal(textChunks.length, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].messages[0].content[1].type, 'text')
  assert.match(sent[0].messages[0].content[1].text, /you cannot see images and it could not be read right now/i)
})

test('assembleLlmStream forwards lifetime disposal signal to in-flight streams and stops on disabled retry policies', async () => {
  const lifetime = new AbortController()
  let seenSignal
  const streaming = assembleLlmStream({
    llm: {
      async *stream(options) {
        seenSignal = options.signal
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'disposed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [], signal: AbortSignal.timeout(60_000) }, { signal: lifetime.signal })
  lifetime.abort()
  const aborted = await streaming
  assert.equal(seenSignal.aborted, true)
  assert.equal(aborted.finish.kind, 'aborted')

  let disabledCalls = 0
  const disabled = await assembleLlmStream({
    llm: {
      providerRetryPolicy: () => ({ mode: 'disabled', initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      async *stream() {
        disabledCalls += 1
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [] })
  assert.equal(disabledCalls, 1)
  assert.equal(disabled.finish.kind, 'error')
})


// A request carrying an uploaded file must tell the model the attachment_id
// read_document accepts: the file block's handle text names only the saved
// private path. The llm/stream seam keeps the file block and adds a hint note.
function streamBench(t, { prefs = {}, vision = true, bot = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-files-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const listeners = new Map()
  const streamCalls = []
  const ctx = {
    on: (name, listener) => { listeners.set(name, listener); return () => {} },
    effect: f => f(),
    get: () => undefined,
    llm: {
      listConfigurableProviders: () => [],
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 1, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      // The request model 'v4' reads images unless the bench asks for text-only;
      // the OCR route 'v4v' always does so the image-reading path stays usable.
      resolveModelInfo: async (provider, model) => ({ inputModalities: ['text', ...(vision || model === 'v4v' ? ['image'] : [])] }),
      async *stream(options) {
        streamCalls.push(options)
        yield { type: 'text-delta', index: 0, text: 'Image: page corner.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx, config: {}, home,
    state: { prefs },
    teamTools: [],
    warn: () => {},
    load: async () => {},
    roomOf: () => undefined,
    ownRequest: () => false,
    isBotSession: () => bot,
    readOnly: () => undefined,
    catalog: async () => [{ ref: 'deepseek/v4v', name: 'Vision', input: ['text', 'image'] }],
    defaultRef: () => 'deepseek/v4v',
    isLocalAgentRef: () => false,
    tagUsage: m => m,
  }
  servicesInstall(rt)
  imagesInstall(rt)
  const drain = async (options) => {
    let nextUsed = false
    const next = async function* () { nextUsed = true; yield { type: 'finish', reason: { kind: 'stop' } } }
    for await (const chunk of listeners.get('llm/stream')(options, next)) void chunk
    return nextUsed
  }
  const options = messages => ({ provider: 'deepseek', model: 'v4', sessionId: 's1', messages })
  return { streamCalls, drain, options }
}

test('a file block gains a read_document attachment_id hint only when OCR is on', async (t) => {
  const file = id => ({ type: 'file', attachment: { attachmentId: id, name: `${id}.pdf`, bytes: 10 } })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'read this' }, file('sha256:file-1')] }]

  const off = streamBench(t)
  assert.equal(await off.drain(off.options(messages)), true, 'OCR off passes the request downstream untouched')
  assert.equal(off.streamCalls.length, 0)

  const on = streamBench(t, { prefs: { deepseekServices: { ocr: true } } })
  assert.equal(await on.drain(on.options(messages)), false)
  assert.equal(on.streamCalls.length, 1)
  const content = on.streamCalls[0].messages[0].content
  assert.equal(content.length, 3, 'text + file + hint')
  assert.equal(content[1], messages[0].content[1], 'the original file block is kept')
  const hint = content[2]
  assert.deepEqual(Object.keys(hint), ['type', 'text'], 'the hint uses only public text-block fields')
  assert.match(hint.text, /read_document/)
  assert.match(hint.text, /attachment_id "sha256:file-1"/)
  assert.match(hint.text, /do not pass its storage path/)
  // The caller's blocks were not mutated.
  assert.equal(messages[0].content.length, 2)
})

test('file hints name each upload by its own id and stay idempotent on re-entry', async (t) => {
  const on = streamBench(t, { prefs: { deepseekServices: { ocr: true } } })
  const blocks = [
    { type: 'file', attachment: { attachmentId: 'sha256:one', name: 'a.pdf', bytes: 1 } },
    { type: 'file', attachment: { attachmentId: 'sha256:two', name: 'b.pdf', bytes: 2 } },
  ]
  assert.equal(await on.drain(on.options([{ role: 'user', content: blocks }])), false)
  const content = on.streamCalls[0].messages[0].content
  assert.equal(content.filter(block => block.type === 'file').length, 2)
  const hints = content.filter(block => block.type === 'text')
  assert.match(hints[0].text, /attachment_id "sha256:one"/)
  assert.match(hints[1].text, /attachment_id "sha256:two"/)
  // A request whose files are already hinted (this listener's own rewrite on
  // re-entry) passes downstream unchanged instead of re-dispatching forever.
  assert.equal(await on.drain(on.options(on.streamCalls[0].messages)), true)
  assert.equal(on.streamCalls.length, 1)
})

test('file + image coexist: the image becomes its reading, the file keeps its hint', async (t) => {
  const on = streamBench(t, { prefs: { deepseekServices: { ocr: true } }, vision: false })
  const content = [
    { type: 'image', attachment: { attachmentId: 'sha256:img-9', name: 'page.png' } },
    { type: 'file', attachment: { attachmentId: 'sha256:doc-9', name: 'doc.pdf', bytes: 5 } },
  ]
  await on.drain(on.options([{ role: 'user', content }]))
  // Call 1 is the vision model's own OCR read; call 2 is the rewritten request.
  const sent = on.streamCalls.at(-1).messages[0].content
  assert.equal(sent[0].type, 'text')
  assert.match(sent[0].text, /\[Image "page\.png"/)
  assert.match(sent[0].text, /page corner/)
  assert.equal(sent[1].type, 'file', 'the file block still rides the request')
  assert.equal(sent[2].type, 'text')
  assert.match(sent[2].text, /attachment_id "sha256:doc-9"/)
})

test('a plain DSH session gets no read_document hints — it lacks the tool', async (t) => {
  const file = { type: 'file', attachment: { attachmentId: 'sha256:out', name: 'out.pdf', bytes: 3 } }
  const prefs = { deepseekServices: { ocr: true } }
  // OCR on, but the session is not the team's: files pass downstream unhinted.
  const plain = streamBench(t, { prefs, bot: false })
  assert.equal(await plain.drain(plain.options([{ role: 'user', content: [file] }])), true)
  assert.equal(plain.streamCalls.length, 0)
  // The same gate stops the image note's read_document mention while the
  // image→text conversion itself is unchanged.
  const withImage = streamBench(t, { prefs, vision: false, bot: false })
  await withImage.drain(withImage.options([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:im-1', name: 'p.png' } }] }]))
  const sent = withImage.streamCalls.at(-1).messages[0].content
  assert.equal(sent[0].type, 'text')
  assert.match(sent[0].text, /page corner/)
  assert.doesNotMatch(sent[0].text, /read_document/)
})

test('a file block without a usable attachment id passes through unhinted', async (t) => {
  const on = streamBench(t, { prefs: { deepseekServices: { ocr: true } } })
  const content = [{ type: 'file', attachment: { name: 'nameless.pdf' } }]
  assert.equal(await on.drain(on.options([{ role: 'user', content }])), true)
  assert.equal(on.streamCalls.length, 0)
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
  imagesInstall({ ctx, home, config: {}, ownRequest: () => false })
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

