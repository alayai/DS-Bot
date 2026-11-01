import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readFile, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomUUID, createHash } from 'node:crypto'
import { engineCommand, engineEnvironment } from '../engine.mjs'
import { homeVolume, ownedVolume } from './checkpoint.mjs'
import { assertVolume, assertHomeImage, quotaArguments } from './boundary.mjs'

export async function portableHome(operation, value, options, { docker, image, engine, executable, signal }) {
  const record = value.record, importing = operation === 'import'
  if (typeof options.path !== 'string' || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1024 ** 3 || options.maxBytes > 1024 ** 4
    || (importing && !/^[a-f0-9-]{36}$/.test(options.homeRevision ?? ''))) throw new Error('Invalid portable backup request.')
  const volume = importing ? homeVolume({ ...record, homeRevision: options.homeRevision }) : value.volume
  if (importing) {
    if (!(await lstat(options.path)).isFile()) throw new Error('Invalid backup source.')
    if (await ownedVolume(volume, value, docker, signal, { missing: true })) throw new Error('Import staging storage already exists.')
    await docker(['volume', 'create', ...quotaArguments(record.homeQuotaBytes, engine), '--label', `org.ds-bot.computer.id=${record.id}`,
      '--label', `org.ds-bot.computer.image=${image}`, '--label', 'org.ds-bot.computer.storage=staged-home', volume], signal)
  } else {
    const data = JSON.parse((await docker(['volume', 'inspect', volume], signal)).stdout)[0]
    assertVolume(data, value); assertHomeImage(data, record, image)
    if ((await docker(['ps', '-q', '--filter', `volume=${volume}`], signal)).stdout.trim()) throw new Error('Stop all users of the home before exporting.')
  }
  const name = `dsbot-portable-${randomUUID()}`
  let complete = false
  try {
    const code = await readFile(new URL('./portable.py', import.meta.url), 'utf8')
    const args = engineCommand(engine, ['run', '--rm', '-i', '--name', name, '--read-only', '--user', '1000:1000', '--network', 'none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '32',
      '--mount', `type=volume,source=${volume},target=${importing ? '/home/cua' : '/source,readonly'}`,
      '--entrypoint', 'python3', image, '-c', code])
    const child = spawn(executable, args, { signal, windowsHide: true, env: engine ? engineEnvironment(engine) : process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', status => status === 0 ? resolve() : reject(new Error('Portable backup validation or copy failed. Check the image, archive integrity and available storage.'))) })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdin.write(JSON.stringify({ operation, image, maxBytes: options.maxBytes }) + '\n')
    const hash = createHash('sha256'); let bytes = 0
    if (importing) {
      child.stdout.resume()
      await Promise.all([exited, pipeline(createReadStream(options.path), child.stdin)])
    } else {
      child.stdin.end()
      child.stdout.on('data', chunk => { bytes += chunk.length; hash.update(chunk) })
      await Promise.all([exited, pipeline(child.stdout, createWriteStream(options.path, { flags: 'wx', mode: 0o600 }))])
    }
    complete = true
    return importing ? { imported: true } : { bytes, sha256: hash.digest('hex') }
  } finally {
    await docker(['rm', '-f', name]).catch(() => {})
    if (!complete && importing) await docker(['volume', 'rm', volume]).catch(() => {})
    if (!complete && !importing) await rm(options.path, { force: true })
  }
}
