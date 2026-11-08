import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { version } = JSON.parse(await readFile(join(root, 'dsh-bothub/package.json'), 'utf8'))
const destination = resolve(process.argv[2] ?? join(root, `artifacts/bothub-${version}`))
if (!process.env.npm_execpath) throw new Error('Run with npm run candidate -- <new-output-directory>')
await mkdir(dirname(destination), { recursive: true })
await mkdir(destination, { recursive: false })
const packages = []
for (const name of ['ds-bot', 'dsh-bothub']) {
  const cwd = join(root, name)
  const output = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json',
    '--pack-destination', destination], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const [info] = JSON.parse(output)
  const files = info.files.map(file => file.path)
  if (files.some(file => /(^|\/)(node_modules|\.dsh[^/]*|\.env|test|dev|\.playwright-mcp)(\/|$)/.test(file))) {
    throw new Error(`Unexpected private or development content in ${name}`)
  }
  for (const file of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'LICENSE', 'NOTICE']) {
    if (!files.includes(file)) throw new Error(`Missing ${name}/${file}`)
  }
  const bytes = await readFile(join(destination, info.filename))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  packages.push({ name, version: info.version, filename: info.filename, bytes: bytes.length, sha256, files })
  await writeFile(join(destination, `${info.filename}.sha256`), `${sha256}  ${info.filename}\n`)
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim())
await writeFile(join(destination, 'manifest.json'), JSON.stringify({
  candidate: 'BotHub MVP', createdAt: new Date().toISOString(), revision, dirty,
  dsh: '0.2.1-rc.4', cordis: '4.0.5', packages,
  note: 'Local working-tree candidate. Install both archives; version alone does not identify the companion DS Bot build.',
}, null, 2) + '\n')
console.log(JSON.stringify({ destination, packages: packages.map(({ files, ...info }) => ({ ...info, fileCount: files.length })) }, null, 2))
