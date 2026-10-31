import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { stringify } from 'yaml'
import { bundledComputerConfig } from './computer-runtime.mjs'

// An explicit operator opt-in; no runtime download or alteration of an existing profile.
export function computerPatch(profile, configFile = process.env.DS_BOT_COMPUTER_CONFIG, runtimeOptions) {
  if (!configFile) return []
  const text = readFileSync(configFile, 'utf8')
  if (text.length > 8192) throw new Error('Computer configuration exceeds 8 KiB.')
  let computer = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (computer?.enabled !== true || !computer.broker || typeof computer.broker !== 'object') {
    throw new Error('Computer configuration requires enabled: true and a Broker configuration.')
  }
  computer = bundledComputerConfig(computer, runtimeOptions)
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const bot = entries.find(entry => entry.id === 'bot')
  if (!bot || bot.disabled) throw new Error('The Computer configuration requires the ds-bot plugin.')
  const file = join(dirname(profile.dir), 'computer-launch.patch.yml')
  writeFileSync(file, stringify([{ id: 'bot', config: { ...bot.config, computer } }]), 'utf8')
  return [file]
}
