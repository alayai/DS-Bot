import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleRuntime } from '../../computer-runtime/runtime.mjs'
import { verifyComputerRuntime } from '../src/computer-runtime.mjs'

export async function prepareComputerRuntime({ output }, bundle = bundleRuntime) {
  await mkdir(output, { recursive: true })
  const lock = join(output, '.computer-runtime.prepare.lock')
  await mkdir(lock)
  let work
  let preserveWork = false
  const destination = join(output, 'computer-runtime')
  try {
    work = await mkdtemp(join(output, '.computer-runtime-'))
    const staged = join(work, 'next')
    await bundle(staged)
    verifyComputerRuntime(staged)
    let previous
    try { previous = await readFile(join(destination, 'manifest.json'), 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (previous === await readFile(join(staged, 'manifest.json'), 'utf8')) {
      try {
        verifyComputerRuntime(destination)
        return { output: destination, changed: false }
      } catch { /* A valid staged copy repairs an incomplete generated payload. */ }
    }
    let moved = false
    try { await rename(destination, join(work, 'previous')); moved = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    try { await rename(staged, destination) }
    catch (error) {
      if (moved) {
        try { await rename(join(work, 'previous'), destination) }
        catch {
          preserveWork = true
          throw new Error(`Computer payload publication failed. The previous payload is retained at ${join(work, 'previous')}.`, { cause: error })
        }
      }
      throw error
    }
    return { output: destination, changed: true }
  } finally {
    if (work && !preserveWork) await rm(work, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ?? fileURLToPath(new URL('../build/runtime', import.meta.url))
  console.log(JSON.stringify(await prepareComputerRuntime({ output }), null, 2))
}
