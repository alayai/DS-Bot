import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newestCodex } from '../src/host/local-agents/codex-executable.js'

const probe = versions => async path => ({ ok: versions[path] !== undefined, version: versions[path] })

test('a newer Desktop Codex replaces the old npm CLI that lists only legacy models', async () => {
  assert.equal(await newestCodex('npm.cmd', ['desktop.exe'], probe({
    'npm.cmd': 'codex-cli 0.118.0', 'desktop.exe': 'codex-cli 0.167.0-alpha.3.2',
  })), 'desktop.exe')
})

test('a newer or same-version PATH CLI is preserved, including release over prerelease', async () => {
  for (const version of ['0.168.0', '0.167.0', '0.167.0-alpha.3.2', '0.167.0-alpha.10']) {
    assert.equal(await newestCodex('npm.cmd', ['desktop.exe'], probe({
      'npm.cmd': `codex-cli ${version}`, 'desktop.exe': 'codex-cli 0.167.0-alpha.3.2',
    })), 'npm.cmd')
  }
})

test('missing or broken Desktop installs never replace the PATH CLI', async () => {
  assert.equal(await newestCodex('npm.cmd', [], probe({})), 'npm.cmd')
  for (const version of [undefined, 'unrecognized output']) {
    assert.equal(await newestCodex('npm.cmd', ['desktop.exe'], probe({
      'npm.cmd': 'codex-cli 0.118.0', 'desktop.exe': version,
    })), 'npm.cmd')
  }
  assert.equal(await newestCodex('npm.cmd', ['desktop.exe'], async () => { throw Error('not executable') }), 'npm.cmd')
})

test('Desktop-only installs work; failed probes and multiple installed versions are handled', async () => {
  assert.equal(await newestCodex(undefined, ['missing', 'older', 'current', 'current'], probe({
    older: 'codex-cli 0.165.0', current: 'codex-cli 0.167.0-alpha.3.2',
  })), 'current')
  assert.equal(await newestCodex(undefined, ['missing'], probe({})), undefined)
})
