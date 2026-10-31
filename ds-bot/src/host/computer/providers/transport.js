import { EventEmitter } from 'node:events'
import { fork, spawn } from 'node:child_process'
import { isAbsolute, posix, win32 } from 'node:path'
import { refused } from '../contract.js'

export function brokerLaunch({ entrypoint, image, images = [], wsl, native, engine } = {}, platform = process.platform) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw refused('provider-unavailable', 'An immutable local desktop image id is required.')
  if (!Array.isArray(images) || images.length > 4 || images.some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw refused('provider-unavailable', 'Choose up to four immutable upgrade images.')
  const extra = images.length ? [JSON.stringify([...new Set([image, ...images])])] : []
  if (native === true) {
    if (!['win32', 'linux'].includes(platform) || !(platform === 'win32' ? win32.isAbsolute(entrypoint ?? '') : isAbsolute(entrypoint ?? ''))
      || /[\x00-\x1f]/.test(entrypoint) || wsl) throw refused('provider-unavailable', 'Choose an absolute bundled Broker path on this host.')
    return { entrypoint, args: [image, ...(extra.length ? ['--ipc', ...extra] : [])], engine }
  }
  if (platform === 'win32') {
    if (!wsl || !/^[a-zA-Z0-9][\w.-]{0,79}$/.test(wsl.distribution ?? '') || !posix.isAbsolute(wsl.node ?? '')
      || !posix.isAbsolute(entrypoint ?? '') || [wsl.node, entrypoint].some(value => /[\x00-\x1f]/.test(value))) {
      throw refused('provider-unavailable', 'Windows Computers require a WSL distribution and absolute Linux Node and Broker paths.')
    }
    return { command: 'wsl.exe', args: ['--distribution', wsl.distribution, '--exec', wsl.node, entrypoint, image, '--stdio', ...extra] }
  }
  if (platform !== 'linux' || !isAbsolute(entrypoint ?? '')) throw refused('provider-unavailable', 'Computers require Linux or a configured Windows WSL bridge.')
  return { entrypoint, args: [image, ...(extra.length ? ['--ipc', ...extra] : [])] }
}

// A private pipe, not a listener. WSL never receives application cookies or model credentials.
export function openBroker(launch) {
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'SystemRoot', 'WINDIR', 'USERPROFILE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  if (launch.engine) {
    env.DS_BOT_COMPUTER_ENGINE = JSON.stringify(launch.engine)
    env.DOCKER_HOST = launch.engine.endpoint
    delete env.DOCKER_CONTEXT
  }
  if (launch.entrypoint) {
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    return fork(launch.entrypoint, launch.args, { env, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  }
  const child = spawn(launch.command, launch.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  const peer = new EventEmitter()
  peer.connected = true
  peer.exitCode = null
  peer.signalCode = null
  peer.kill = signal => child.kill(signal)
  peer.disconnect = () => { peer.connected = false; child.stdin.end() }
  peer.send = (message, done) => child.stdin.write(`${JSON.stringify(message)}\n`, done)
  let buffer = ''
  const fail = () => { peer.connected = false; peer.emit('disconnect'); child.stdin.end(); child.kill() }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 16 * 1024 * 1024) { fail(); return }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message
      try { message = JSON.parse(line) } catch { fail(); return }
      peer.emit('message', message)
    }
  })
  child.stdin.on('error', fail)
  child.on('error', error => peer.emit('error', error))
  child.on('exit', (code, signal) => { peer.connected = false; peer.exitCode = code; peer.signalCode = signal; peer.emit('exit', code, signal) })
  return peer
}
