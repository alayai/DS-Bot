import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { install, repairToolCallChunk } from '../src/host/tool-calls.js'

test('an empty streamed tool call id is filled once and kept', () => {
  const ids = new Map()
  const first = repairToolCallChunk({ type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{' }, ids)
  const second = repairToolCallChunk({ type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '}' }, ids)
  const end = repairToolCallChunk({
    type: 'block-end', index: 0,
    block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
  }, ids)
  assert.equal(first.id, second.id)
  assert.equal(end.block.id, first.id)
  assert.ok(first.id.length > 0)
  const kept = repairToolCallChunk({
    type: 'block-end', index: 1,
    block: { type: 'tool-call', id: 'call-real', name: 'web_fetch', arguments: '{}' },
  }, ids)
  assert.equal(kept.block.id, 'call-real')
  assert.equal(repairToolCallChunk({ type: 'text-delta', index: 2, text: 'ok' }, ids).text, 'ok')
})

test('the installed stream hook isolates ids between requests and preserves provider ids', async () => {
  let hook
  install({ ctx: { on: (name, listener) => { assert.equal(name, 'llm/stream'); hook = listener } } })
  async function* source(id) {
    yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: '{}' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: '{}' } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const collect = id => Array.fromAsync(hook({}, () => source(id)))
  const [first, second, real] = await Promise.all([collect(''), collect(''), collect('provider-id')])
  assert.notEqual(first[0].id, second[0].id)
  for (const chunks of [first, second, real]) {
    assert.ok(chunks[0].id.length > 0)
    assert.equal(chunks[0].id, chunks[1].block.id)
    assert.equal(chunks[0].name, 'read')
    assert.equal(chunks[0].argumentsDelta, '{}')
    assert.deepEqual(chunks[2], { type: 'finish', reason: { kind: 'tool-calls' } })
  }
  assert.equal(real[0].id, 'provider-id')
})

for (const readOnly of [false, true]) for (const torn of [false, true]) {
  test(`plugin startup preserves ${torn ? 'torn' : 'complete'} historical logs in a ${readOnly ? 'read-only' : 'writable'} home`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-tool-call-'))
    try {
      const home = join(root, 'bot')
      const directory = join(root, 'sessions', 'fixture')
      const path = join(directory, 'session.v4.jsonl.zstd')
      const stamp = join(home, 'repaired-tool-call-ids')
      mkdirSync(directory, { recursive: true })
      const frame = text => zstdCompressSync(Buffer.from(text))
      const complete = Buffer.concat([
        frame('{"type":"session","version":4,"id":"fixture"}\n'),
        frame(JSON.stringify({ type: 'assistant/message', seq: 1, data: {
          message: { content: [{ type: 'tool-call', id: '', name: 'read', arguments: '{}' }] },
        } }) + '\n'),
      ])
      const bytes = torn ? Buffer.concat([complete, frame('incomplete').subarray(0, 5)]) : complete
      writeFileSync(path, bytes, { mode: 0o600 })
      const mode = statSync(path).mode
      // Exercise production startup without node:test's historical migration bypass.
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const start = () => execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { install } from ${JSON.stringify(new URL('../src/host/tool-calls.js', import.meta.url).href)}
        install({ ctx: { on() {} }, home: process.argv[1], dshHome: process.argv[2],
          readOnly: () => ${readOnly ? "'Another host owns the team'" : 'undefined'}, warn() {} })
      `, home, root], { env })
      start()
      assert.deepEqual(readFileSync(path), bytes)
      assert.equal(statSync(path).mode, mode)
      assert.equal(existsSync(stamp), false)
      // Completing a torn tail or appending a new frame must survive later startup too.
      const appended = Buffer.concat([complete, frame('{"type":"turn/end","seq":2,"data":{}}\n')])
      writeFileSync(path, appended)
      start()
      assert.deepEqual(readFileSync(path), appended)
      assert.equal(existsSync(stamp), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
