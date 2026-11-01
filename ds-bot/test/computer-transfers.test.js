import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createTransfers, FILE_LIMIT, CHUNK_SIZE } from '../../computer-runtime/broker/transfers.mjs'
import { uploadFile, downloadFile, checkTransfer, FILE_LIMIT as CLIENT_FILE_LIMIT } from '../src/shared/computer-files.js'
import { importDesktopFile, importDesktopFiles, validateDesktopFiles, exportDesktopFile } from '../src/client/computer-files.js'
import { checkActions } from '../src/host/computer/contract.js'
import { driverInput } from '../../computer-runtime/broker/input.mjs'

test('Host and Broker admit chords and gestures and reject malformed variants', () => {
  const frame = { width: 100, height: 100, screenshot_width: 100, screenshot_height: 100, capture_id: 'capture' }
  const good = [
    { type: 'click', x: 4, y: 5, count: 2 },
    { type: 'key', key: 'a', modifiers: ['Control'] },
    { type: 'key', key: 'F12', modifiers: ['Control', 'Shift'] },
    { type: 'drag', x: 3, y: 4, toX: 90, toY: 90, durationMs: 700 },
  ]
  for (const action of good) {
    assert.deepEqual(checkActions([action], frame), [action])
    assert.ok(driverInput([action], frame).args)
  }
  assert.deepEqual(driverInput([good[1]], frame).args.modifiers, ['ctrl'])
  assert.equal(driverInput([good[0]], frame).args.capture_id, 'capture')
  assert.equal(driverInput([good[3]], frame).args.to_x, 90)
  for (const action of [
    { ...good[0], count: 3 }, { ...good[0], count: '2' },
    { ...good[1], modifiers: ['Control', 'Control'] }, { ...good[1], modifiers: ['__proto__'] },
    { ...good[1], modifiers: 'Control' }, { ...good[1], key: ['a'] }, { ...good[1], key: 'Ctrl+a' },
    { ...good[3], toX: 100 }, { ...good[3], toY: -1 }, { ...good[3], x: 0.1 },
    { ...good[3], durationMs: 10000 }, { ...good[3], durationMs: '500' },
    { ...good[3], command: 'exec' },
  ]) {
    assert.throws(() => checkActions([action], frame))
    assert.throws(() => driverInput([action], frame))
  }
})

function fixture() {
  let now = 0, staged, published
  const calls = [], hash = data => createHash('sha256').update(data).digest('hex')
  const broker = createTransfers(async args => {
    calls.push(args)
    switch (args.operation) {
      case 'begin-write': staged = Buffer.alloc(0); return {}
      case 'begin-read': staged = Buffer.from(published); return { bytes: staged.length, sha256: hash(staged) }
      case 'write-chunk': staged = Buffer.concat([staged, Buffer.from(args.data, 'base64')]); return { bytes: staged.length - args.offset }
      case 'read-chunk': return { bytes: args.length, data: staged.subarray(args.offset, args.offset + args.length).toString('base64') }
      case 'commit':
        assert.equal(staged.length, args.bytes)
        assert.equal(hash(staged), args.sha256)
        published = Buffer.from(staged); return {}
      case 'abort': staged = null; return {}
      default: assert.fail(args.operation)
    }
  }, () => now)
  return { broker, calls, hash, get published() { return published }, get staged() { return staged }, advance: () => { now += 120001 } }
}

test('file deletion validates both contracts and cannot interrupt an active transfer', async () => {
  const calls = []
  const broker = createTransfers(async args => { calls.push(args); return { name: args.name, deleted: true } })
  const deletion = { operation: 'delete', name: 'report.bin', version: 'a'.repeat(64) }
  for (const invalid of [{ name: '../report.bin' }, { name: '.hidden' }, { version: 'bad' }, { version: null }]) {
    assert.throws(() => checkTransfer({ ...deletion, ...invalid }))
    await assert.rejects(broker.call({ ...deletion, ...invalid }))
  }
  assert.equal(calls.length, 0)
  const transfer = await broker.call({ operation: 'begin-write', name: 'report.bin', bytes: 0, sha256: 'a'.repeat(64) })
  await assert.rejects(broker.call(deletion), /Finish or cancel/)
  assert.equal(calls.filter(item => item.operation === 'delete').length, 0)
  await broker.call({ operation: 'abort', transferId: transfer.transferId })
  assert.deepEqual(checkTransfer({ ...deletion, temporary: '/host/path', recursive: true }), deletion)
  assert.deepEqual(await broker.call({ ...deletion, temporary: '/host/path', recursive: true }), { name: deletion.name, deleted: true })
  assert.deepEqual(calls.at(-1), deletion)
})

test('browser file roundtrip spans chunks and only reports acknowledged bytes', async () => {
  const h = fixture(), data = Buffer.alloc(CHUNK_SIZE * 2 + 13, 37), progress = []
  const file = new File([data], 'large.bin')
  const options = { check() {}, progress: (bytes, total) => progress.push([bytes, total]) }
  await importDesktopFile(args => h.broker.call(args), file, options)
  assert.deepEqual(h.published, data)
  assert.deepEqual(progress.map(value => value[0]), [0, CHUNK_SIZE, CHUNK_SIZE * 2, data.length])
  assert.equal(h.staged, null)
  const exported = await exportDesktopFile(args => h.broker.call(args), 'large.bin', options)
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), data)
  assert.equal(h.staged, null)
})

test('cancel after acknowledged chunk cleans up without publishing or replaying', async () => {
  const h = fixture(), data = Buffer.alloc(CHUNK_SIZE + 1)
  let cancelled = false
  await assert.rejects(uploadFile(args => h.broker.call(args), {
    name: 'cancel.bin', bytes: data.length, sha256: h.hash(data),
    chunk: (start, end) => data.subarray(start, end).toString('base64'),
    check() { if (cancelled) throw new Error('cancelled') },
    progress(bytes) { if (bytes) cancelled = true },
  }), /cancelled/)
  assert.equal(h.published, undefined)
  assert.equal(h.staged, null)
  assert.equal(h.calls.filter(item => item.operation === 'write-chunk').length, 1)
})

test('transfer scope expires and refuses wrong identities, order and oversized input', async () => {
  const h = fixture()
  const begin = { operation: 'begin-write', name: 'file', bytes: 1, sha256: h.hash(Buffer.from('a')) }
  await assert.rejects(h.broker.call({ ...begin, bytes: FILE_LIMIT + 1 }))
  assert.throws(() => checkTransfer({ ...begin, bytes: FILE_LIMIT + 1 }))
  const value = await h.broker.call(begin)
  await assert.rejects(h.broker.call(begin), /Finish or cancel/)
  await assert.rejects(h.broker.call({ operation: 'abort', transferId: 'other' }), /expired/)
  await assert.rejects(h.broker.call({ operation: 'commit', transferId: value.transferId }), /incomplete/)
  await assert.rejects(h.broker.call({ operation: 'write-chunk', transferId: value.transferId, offset: 1, data: 'YQ==' }), /order/)
  await assert.rejects(h.broker.call({ operation: 'write-chunk', transferId: value.transferId, offset: 0, data: 'YQ' }), /chunk/)
  h.advance()
  await assert.rejects(h.broker.call({ operation: 'commit', transferId: value.transferId }), /expired/)
  assert.equal(h.staged, null)
  assert.equal(h.published, undefined)
})

test('corrupt export is never committed or delivered', async () => {
  const h = fixture(), data = Buffer.from('export')
  await importDesktopFile(args => h.broker.call(args), new File([data], 'file'), { check() {} })
  const before = h.calls.filter(item => item.operation === 'commit').length
  await assert.rejects(downloadFile(async args => {
    const result = await h.broker.call(args)
    return args.operation === 'read-chunk' ? { ...result, bytes: 200 } : result
  }, { name: 'file', chunk() {}, verify() {} }), /Invalid export chunk/)
  assert.equal(h.calls.filter(item => item.operation === 'commit').length, before)
  assert.equal(h.staged, null)
})

test('lost commit acknowledgement is never replayed or reported as success', async () => {
  const h = fixture(), data = Buffer.from('published')
  let commits = 0
  await assert.rejects(uploadFile(async args => {
    const result = await h.broker.call(args)
    if (args.operation === 'commit') { commits++; throw new Error('lost reply') }
    return result
  }, {
    name: 'file', bytes: data.length, sha256: h.hash(data), chunk: () => data.toString('base64'),
  }), /lost reply/)
  assert.equal(commits, 1)
  assert.deepEqual(h.published, data)
  assert.equal(h.staged, null)
})

test('200 MiB is admitted by both contracts and one extra byte is refused before reading', async () => {
  assert.equal(FILE_LIMIT, 209_715_200)
  assert.equal(CLIENT_FILE_LIMIT, FILE_LIMIT)
  const h = fixture()
  const args = { operation: 'begin-write', name: 'limit.bin', bytes: FILE_LIMIT, sha256: 'a'.repeat(64) }
  checkTransfer(args)
  const transfer = await h.broker.call(args)
  assert.equal(transfer.bytes, FILE_LIMIT)
  await h.broker.call({ operation: 'abort', transferId: transfer.transferId })
  assert.throws(() => checkTransfer({ ...args, bytes: FILE_LIMIT + 1 }))
  await assert.rejects(h.broker.call({ ...args, bytes: FILE_LIMIT + 1 }))
  await assert.rejects(importDesktopFile(() => assert.fail('No request is allowed'), {
    name: 'large.bin', size: FILE_LIMIT + 1, slice: () => assert.fail('No bytes may be read'),
  }, { check() {} }), /200 MiB/)
})

test('browser upload reads bounded slices and can cancel during checksum preparation', async () => {
  const h = fixture(), bytes = Buffer.alloc(CHUNK_SIZE * 2 + 1, 91)
  const file = {
    name: 'sliced.bin', size: bytes.length,
    arrayBuffer() { assert.fail('Do not materialize the entire file') },
    slice(start, end) {
      assert.ok(end - start <= CHUNK_SIZE)
      return new Blob([bytes.subarray(start, end)])
    },
  }
  await importDesktopFile(args => h.broker.call(args), file, { check() {} })
  assert.deepEqual(h.published, bytes)
  let cancelled = false
  await assert.rejects(importDesktopFile(() => assert.fail('Checksum cancellation must precede begin-write'), {
    ...file, slice(start, end) { cancelled = true; return file.slice(start, end) },
  }, { check() { if (cancelled) throw new Error('cancelled') } }), /cancelled/)
})

test('an export snapshot gets a full idle lease after slow preparation', async () => {
  let clock = 0
  const broker = createTransfers(async ({ operation }) => {
    if (operation === 'begin-read') { clock = 120_001; return { bytes: 1, sha256: 'a'.repeat(64) } }
    return { bytes: 1, data: 'YQ==' }
  }, () => clock)
  const transfer = await broker.call({ operation: 'begin-read', name: 'slow.bin' })
  const chunk = await broker.call({ operation: 'read-chunk', transferId: transfer.transferId, offset: 0 })
  assert.equal(chunk.offset, 1)
  await broker.clear()
})

test('multi-file selection limits each file, admits larger batch totals and rejects the whole invalid batch before reading', async () => {
  validateDesktopFiles([{ name: 'first.bin', size: FILE_LIMIT }, { name: 'second.bin', size: FILE_LIMIT }])
  const oversized = { name: 'too-large.bin', size: FILE_LIMIT + 1, slice() { assert.fail('Must not read an oversized selection') } }
  await assert.rejects(importDesktopFiles(() => assert.fail('Must not contact the guest'), [
    new File(['valid'], 'valid.txt'), oversized,
  ], { check() {} }), error => error.fileName === 'too-large.bin' && /200 MiB/.test(error.message))
  assert.throws(() => validateDesktopFiles([{ name: 'same.txt', size: 0 }, { name: 'same.txt', size: 1 }]), /different names/)
  assert.throws(() => validateDesktopFiles([{ name: '../outside', size: 1 }]), /plain file name/)
})

test('multiple files publish serially, including Unicode names and empty files', async () => {
  const h = fixture(), statuses = [], completed = [], current = []
  await importDesktopFiles(args => h.broker.call(args), [new File(['first'], '中文.txt'), new File([], 'empty.txt')], {
    check() {},
    current: (file, index, count) => current.push([file.name, index, count]),
    status: (index, status) => {
      statuses.push([index, status])
      if (status === 'Uploaded') completed.push(Buffer.from(h.published))
    },
  })
  assert.deepEqual(current, [['中文.txt', 0, 2], ['empty.txt', 1, 2]])
  assert.deepEqual(statuses, [[0, 'Uploading'], [0, 'Uploaded'], [1, 'Uploading'], [1, 'Uploaded']])
  assert.deepEqual(completed, [Buffer.from('first'), Buffer.alloc(0)])
  assert.deepEqual(h.calls.filter(call => ['begin-write', 'commit'].includes(call.operation)).map(call => call.operation),
    ['begin-write', 'commit', 'begin-write', 'commit'])
})

test('cancelling a batch keeps completed files and never starts the remaining transfers', async () => {
  const h = fixture(), statuses = []
  let cancelled = false
  await assert.rejects(importDesktopFiles(args => h.broker.call(args), [
    new File(['keep'], 'first.txt'), new File(['skip'], 'second.txt'), new File([], 'third.txt'),
  ], {
    check() { if (cancelled) throw new Error('cancelled') },
    status(index, status) { statuses.push([index, status]); if (status === 'Uploaded') cancelled = true },
  }), /cancelled/)
  assert.equal(h.calls.filter(call => call.operation === 'begin-write').length, 1)
  assert.deepEqual(h.published, Buffer.from('keep'))
  assert.deepEqual(statuses.slice(-2), [[1, 'Check destination'], [2, 'Not uploaded']])
})

test('a lost batch commit reply stops the queue without replay or false completion', async () => {
  const h = fixture(), statuses = []
  await assert.rejects(importDesktopFiles(async args => {
    const result = await h.broker.call(args)
    if (args.operation === 'commit') throw new Error('lost reply')
    return result
  }, [new File(['published'], 'first.txt'), new File(['skip'], 'second.txt')], {
    check() {}, status: (index, status) => statuses.push([index, status]),
  }), /lost reply/)
  assert.deepEqual(h.published, Buffer.from('published'))
  assert.equal(h.calls.filter(call => call.operation === 'begin-write').length, 1)
  assert.equal(h.calls.filter(call => call.operation === 'commit').length, 1)
  assert.deepEqual(statuses, [[0, 'Uploading'], [0, 'Check destination'], [1, 'Not uploaded']])
})
