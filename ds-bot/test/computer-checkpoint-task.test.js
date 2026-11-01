import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkpointTask } from '../../computer-runtime/broker/checkpoint-task.mjs'

test('checkpoint subprocess streams bounded progress and keeps only the final result', async () => {
  const progress = []
  const value = await checkpointTask(process.execPath, ['-e', `
    process.stdin.resume();
    console.log(JSON.stringify({progress:{stage:'copying',doneBytes:201*1024**2,totalBytes:256*1024**2}}));
    console.log(JSON.stringify({bytes:256*1024**2,hash:'checked'}));
  `], {}, { onProgress: value => progress.push(value) })
  assert.equal(value.bytes, 256 * 1024 ** 2)
  assert.equal(progress.length, 1)
})
test('checkpoint subprocess abort, invalid progress, overflow and timeout fail without success', async () => {
  const controller = new AbortController()
  const pending = checkpointTask(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], {}, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending)
  for (const code of [
    "console.log('x'.repeat(70000))",
    "console.log(JSON.stringify({progress:{stage:'copying',doneBytes:-1,totalBytes:0}}))",
    "console.log('{}');console.log('{}')",
  ]) await assert.rejects(checkpointTask(process.execPath, ['-e', code], {}))
  await assert.rejects(checkpointTask(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, { timeout: 30 }), /timed out/)
})
