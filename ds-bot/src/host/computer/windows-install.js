import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

const run = promisify(execFile)
const PACKAGES = { docker: 'Docker.DockerDesktop', podman: 'RedHat.Podman' }
const ENV = ['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramData', 'TEMP', 'TMP']
const environment = () => Object.fromEntries(ENV.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
const powershell = () => win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const encoded = text => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; ${text}`, 'utf16le').toString('base64')]
function supported(kind, platform) {
  if (platform !== 'win32' || !Object.hasOwn(PACKAGES, kind)) throw new Error('System installation is available only on a Windows DSH host.')
}
export async function windowsSystemStatus(kind, { platform = process.platform, execute = run, engineExecutable } = {}) {
  supported(kind, platform)
  const options = { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: environment() }
  const boot = JSON.parse((await execute(powershell(), encoded(
    "$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); @{bootId=$boot} | ConvertTo-Json -Compress",
  ), options)).stdout.replace(/^\uFEFF/, ''))
  if (typeof boot.bootId !== 'string' || !/^[0-9T:.Z+-]{15,48}$/.test(boot.bootId)) throw new Error('Windows did not return a valid restart identity.')
  const succeeds = async (file, args) => { try { await execute(file, args, options); return true } catch { return false } }
  const [wslReady, engineInstalled, wingetAvailable] = await Promise.all([
    succeeds(win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'), ['--status']),
    succeeds(engineExecutable ?? `${kind}.exe`, ['--version']),
    succeeds('winget.exe', ['--version']),
  ])
  return { bootId: boot.bootId, wslReady, engineInstalled, wingetAvailable }
}
export async function installWindowsComponent(kind, component, { signal, log = () => {} } = {}, {
  platform = process.platform, execute = run,
} = {}) {
  supported(kind, platform)
  if (!['wsl', 'engine'].includes(component)) throw new Error('Unknown system installation step.')
  signal?.throwIfAborted()
  if (component === 'wsl') {
    log('Windows will request permission to enable WSL. No automatic restart will be performed.\n')
    const command = "$p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\wsl.exe') -ArgumentList @('--install','--no-distribution','--no-launch') -Verb RunAs -Wait -PassThru; @{exitCode=$p.ExitCode} | ConvertTo-Json -Compress"
    const result = JSON.parse((await execute(powershell(), encoded(command), {
      env: environment(), windowsHide: true, signal, timeout: 45 * 60_000, maxBuffer: 64 * 1024,
    })).stdout.replace(/^\uFEFF/, ''))
    if (![0, 3010, 1641].includes(result.exitCode)) throw new Error('WSL installation did not complete. Check the Windows permission or installer prompt before retrying.')
    return { restartRequired: true }
  }
  log(`Installing ${PACKAGES[kind]} from the Windows Package Manager community source. Complete its installer and permission prompts.\n`)
  try {
    await execute('winget.exe', ['install', '--id', PACKAGES[kind], '--exact', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements', '--interactive', '--disable-interactivity'], {
      env: environment(), windowsHide: true, signal, timeout: 45 * 60_000, maxBuffer: 512 * 1024,
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if ([3010, 1641].includes(error.code)) return { restartRequired: true }
    // An installer may have committed changes before winget loses its result.
    throw new Error('The installer result could not be confirmed. Check Windows before retrying; installed components will not be removed.')
  }
  return { restartRequired: false }
}
export async function openWindowsEngine(kind, { platform = process.platform, launch = spawn, exists = existsSync } = {}) {
  supported(kind, platform)
  if (kind !== 'docker') return
  const executable = [
    process.env.LOCALAPPDATA && win32.join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'Docker Desktop.exe'),
    win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
  ].find(path => path && exists(path))
  if (!executable) throw new Error('Open Docker Desktop on the DSH host to finish setup.')
  await new Promise((resolve, reject) => {
    const child = launch(executable, [], { env: environment(), detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
