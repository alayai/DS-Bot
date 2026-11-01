import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowsSystemStatus, installWindowsComponent } from '../src/host/computer/windows-install.js'

test('Windows status is read-only and returns boot identity independently of missing tools', async () => {
  const calls = []
  const status = await windowsSystemStatus('docker', { platform: 'win32', engineExecutable: 'C:\\fixture\\docker.exe',
    execute: async (file, args, options) => {
      calls.push({ file, args })
      assert.equal(options.env.API_KEY, undefined)
      if (file.endsWith('powershell.exe')) {
        const text = Buffer.from(args.at(-1), 'base64').toString('utf16le')
        assert.ok(text.includes('LastBootUpTime'))
        assert.ok(!text.includes('Start-Process'))
        return { stdout: '\uFEFF{"bootId":"2026-11-01T01:00:00.000Z"}' }
      }
      if (file.endsWith('wsl.exe')) throw Error('missing')
      return { stdout: 'installed' }
    } })
  assert.deepEqual(status, { bootId: '2026-11-01T01:00:00.000Z', wslReady: false, engineInstalled: true, wingetAvailable: true })
  assert.ok(calls.some(call => call.file === 'C:\\fixture\\docker.exe'))
})

test('install commands are fixed, require Windows, and never request automatic reboot', async () => {
  const calls = []
  const execute = async (file, args) => {
    calls.push({ file, args })
    return { stdout: '{"exitCode":3010}' }
  }
  const deps = { platform: 'win32', execute }
  assert.equal((await installWindowsComponent('docker', 'wsl', {}, deps)).restartRequired, true)
  const command = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le')
  assert.ok(command.includes("'--install','--no-distribution','--no-launch'"))
  assert.ok(command.includes('-Verb RunAs'))
  assert.ok(!/Restart-Computer|shutdown/i.test(command))
  await installWindowsComponent('podman', 'engine', {}, deps)
  assert.deepEqual(calls[1].args, ['install', '--id', 'RedHat.Podman', '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--interactive', '--disable-interactivity'])
  await assert.rejects(installWindowsComponent('docker;echo', 'engine', {}, deps))
  await assert.rejects(installWindowsComponent('docker', 'arbitrary', {}, deps))
  await assert.rejects(installWindowsComponent('docker', 'engine', {}, { ...deps, platform: 'linux' }))
  assert.equal(calls.length, 2)
})

test('denied or uncertain installers do not report success and cancellation never starts an installer', async () => {
  const execute = async () => { throw Error('private installer output') }
  const deps = { platform: 'win32', execute }
  await assert.rejects(installWindowsComponent('docker', 'engine', {}, deps), error =>
    /could not be confirmed/.test(error.message) && !error.message.includes('private'))
  await assert.rejects(installWindowsComponent('docker', 'wsl', {}, {
    ...deps, execute: async () => ({ stdout: '{"exitCode":5}' }),
  }), /did not complete/)
  const signal = AbortSignal.abort(new Error('cancelled'))
  await assert.rejects(installWindowsComponent('docker', 'engine', { signal }, {
    ...deps, execute: async () => assert.fail('Installer must not start'),
  }), /cancelled/)
})
