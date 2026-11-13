// Foreground, disposable native-Node bench. No shell, reset, shared profile or detached daemon.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateBaseline } from '../scripts/candidate-baseline.mjs'
import { benchOptions, packageSource, checkPort, BenchProcesses } from './bench-support.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const options = benchOptions(root, process.argv.slice(2))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run npm run bench -- bothub-<name> <web-port> <mock-port> [probe|full]')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 24 || (major === 24 && minor < 9)) throw new Error('The pinned DSH requires Node >=24.9.0; use native Node for this OS')
const baseline = await candidateBaseline(root)
const dependencies = {
  '@deepseek-ai/dsh': baseline.dsh,
  '@deepseek-ai/dsh-web': baseline.dsh,
  '@deepseek-ai/dsh-llm': baseline.dsh,
  '@deepseek-ai/dsh-scope': baseline.dsh,
  '@deepseek-ai/dsh-tools': baseline.dsh,
  '@deepseek-ai/cordis': baseline.cordis,
  'ds-bot': await packageSource(process.env.BENCH_BOT_PACKAGE, join(root, 'ds-bot')),
  'dsh-bothub': await packageSource(process.env.BENCH_HUB_PACKAGE, join(root, 'dsh-bothub')),
}
await checkPort(options.web)
await checkPort(options.mock)
// mkdir without recursive rejects existing homes, including symlinks/junctions.
await mkdir(options.home)
const profile = join(options.home, 'profiles', 'web')
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, dependencies,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', 'dsh-bothub'] } },
}, null, 2))
const patch = join(options.home, 'bench.patch.yml')
await writeFile(patch, '- id: bot\n  config:\n    checkRatio: 0.45\n- id: llm-deepseek\n  config:\n    models:\n      - { id: deepseek-flash, contextWindow: 100000, maxTokens: 8000, inputModalities: [text, image] }\n      - { id: deepseek-v4-pro, contextWindow: 100000, maxTokens: 8000 }\n')
// Carry OS plumbing, not the user's model credentials, DSH profile or Node hooks.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|temp|tmp|userprofile|home|appdata|localappdata|programfiles|programfiles\(x86\)|pnpm_home)$/i.test(key)))
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`
Object.assign(env, { DSH_HOME: options.home, DEEPSEEK_BASE_URL: `http://127.0.0.1:${options.mock}/v1`,
  DEEPSEEK_API_KEY: 'mock-key', MOCK_PORT: String(options.mock), MOCK_LOG: join(options.home, 'mock.jsonl') })
const processes = new BenchProcesses()
const controller = new AbortController()
const interrupt = () => controller.abort()
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
try {
  const install = await processes.start(process.execPath, [npm, 'install',
    '--install-links', '--legacy-peer-deps=false', '--strict-peer-deps', '--ignore-scripts', '--include=optional', '--no-fund', '--no-audit'],
  { cwd: profile, env, log: join(options.home, 'install.log') })
  await processes.wait(install, 300000, controller.signal)
  const manifest = JSON.parse(await readFile(join(profile, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (manifest.version !== baseline.dsh) throw new Error('Installed DSH differs from the declared baseline')
  const cli = join(profile, 'node_modules/@deepseek-ai/dsh', manifest.bin.dsh)
  const mockLog = join(options.home, 'mock.out')
  const mock = await processes.start(process.execPath, [join(root, 'ds-bot/dev/mock-llm.mjs')], { cwd: root, env, log: mockLog })
  await processes.ready(mock, mockLog, 'ds-bot mock on', 15000, controller.signal)
  const webLog = join(options.home, 'web.log')
  const web = await processes.start(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--port', String(options.web)],
    { cwd: root, env, log: webLog })
  await processes.ready(web, webLog, 'dsh web: http', 120000, controller.signal)
  if (options.mode === 'full') {
    const smoke = await processes.start(process.execPath, [join(root, 'ds-bot/dev/smoke.mjs'), options.name, String(options.web)],
      { cwd: root, env, log: join(options.home, 'host-smoke.log') })
    await processes.wait(smoke, 1800000, controller.signal)
  }
  const hub = await processes.start(process.execPath, [join(root, 'dsh-bothub/dev/smoke-bothub.mjs'), options.name, String(options.web), options.mode],
    { cwd: root, env, log: join(options.home, 'bothub-smoke.log') })
  await processes.wait(hub, 180000, controller.signal)
  console.log(`BotHub ${options.mode} passed; logs: ${options.home}`)
} finally {
  await processes.stop()
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
