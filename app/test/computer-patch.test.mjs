import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { computerPatch } from '../src/computer-patch.mjs'

test('desktop Computer opt-in preserves existing Bot config and never changes profile patches', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-computer-patch-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const dir = join(root, 'profiles', 'ds-bot')
  mkdirSync(dir, { recursive: true })
  const profile = { dir, layers: [{ patches: [{ insert: [{ id: 'bot', name: 'ds-bot', config: { memory: false } }] }] }], patches: [] }
  assert.deepEqual(computerPatch(profile, ''), [])
  const file = join(root, 'computer.json')
  writeFileSync(file, '\uFEFF' + JSON.stringify({ enabled: true, broker: { image: 'fixture' } }))
  const [patch] = computerPatch(profile, file)
  const value = parse(readFileSync(patch, 'utf8'))[0]
  assert.equal(value.config.memory, false)
  assert.equal(value.config.computer.enabled, true)
  assert.deepEqual(profile.patches, [])
  assert.deepEqual(computerPatch(profile, ''), [])
  writeFileSync(file, '{}')
  assert.throws(() => computerPatch(profile, file), /requires enabled/)
})

test('a missing opted-in bundled runtime fails without writing a launch patch', t => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-missing-computer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'profiles', 'ds-bot')
  mkdirSync(dir, { recursive: true })
  const profile = { dir, layers: [{ patches: [{ insert: [{ id: 'bot', name: 'ds-bot' }] }] }], patches: [] }
  const config = join(root, 'computer.json')
  writeFileSync(config, JSON.stringify({ enabled: true, broker: { bundled: true, image: `sha256:${'a'.repeat(64)}` } }))
  assert.throws(() => computerPatch(profile, config, { runtimeDir: root, platform: 'linux', arch: 'x64' }), /ENOENT/)
  assert.throws(() => readFileSync(join(root, 'profiles', 'computer-launch.patch.yml')), /ENOENT/)
  assert.deepEqual(computerPatch(profile, '', { runtimeDir: root }), [])
})
