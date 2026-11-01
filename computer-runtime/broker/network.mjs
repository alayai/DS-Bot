import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { desktopPolicy } from './policy.mjs'
const label = 'org.ds-bot.computer.network'
const names = value => ({ network: `dsbot-net-${value.record.id}`, proxy: `dsbot-proxy-${value.record.id}` })
const stamp = value => createHash('sha256').update(JSON.stringify([value.record.id, value.record.botId, desktopPolicy(value.record.policy).domains])).digest('hex')
async function read(docker, kind, name, signal) {
  try { return JSON.parse((await docker([...kind, 'inspect', name], signal)).stdout)[0] }
  catch (e) { if (/no such (object|container|network)|network .* not found/i.test(e.stderr ?? '')) return null; throw e }
}
function checkNetwork(data, value) {
  const { network, proxy } = names(value)
  const guest = `dsbot-${value.record.id}`, candidate = `dsbot-upgrade-${value.record.id}-`
  if (Object.values(data.Containers ?? {}).some(item => item.Name !== proxy && item.Name !== guest && !(item.Name?.startsWith(candidate) && /^[a-f0-9-]{36}$/.test(item.Name.slice(candidate.length))))) throw new Error('An unexpected container joined the restricted network.')
  if (data.Name !== network || data.Driver !== 'bridge' || data.Internal !== true || data.EnableIPv6
    || data.Labels?.[label] !== value.record.id || data.Labels?.['org.ds-bot.computer.owner'] !== value.record.botId
    || data.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') throw new Error('The restricted desktop network cannot be verified.')
}
function checkProxy(data, value, image, code) {
  const { network, proxy } = names(value), config = data.HostConfig ?? {}, labels = data.Config?.Labels ?? {}
  const endpoints = data.NetworkSettings?.Networks ?? {}
  const address = endpoints[network]?.IPAddress
  if (data.Name !== `/${proxy}` || data.Image !== image || labels[label] !== value.record.id || labels['org.ds-bot.computer.policy'] !== stamp(value)
    || data.Config.User !== '1000:1000' || config.Privileged || !config.ReadonlyRootfs || config.Binds?.length || data.Mounts?.length
    || config.CapAdd?.length || !config.CapDrop?.includes('ALL') || config.SecurityOpt?.join(',') !== 'no-new-privileges'
    || config.NetworkMode !== 'bridge' || config.PidMode === 'host' || config.IpcMode === 'host' || config.UTSMode === 'host'
    || config.Devices?.length || config.DeviceRequests?.length || config.PublishAllPorts || Object.keys(config.PortBindings ?? {}).length
    || config.Memory !== 128 * 1024 ** 2 || config.MemorySwap !== 128 * 1024 ** 2 || config.NanoCpus !== 500_000_000 || config.PidsLimit !== 64 || config.RestartPolicy?.Name !== 'no'
    || Object.keys(endpoints).sort().join(',') !== ['bridge', network].sort().join(',') || !/^\d+\.\d+\.\d+\.\d+$/.test(address ?? '')
    || JSON.stringify(data.Config.Entrypoint) !== JSON.stringify(['python3'])
    || JSON.stringify(data.Config.Cmd) !== JSON.stringify(['-c', code, JSON.stringify({ bind: 'dsbot-egress', domains: desktopPolicy(value.record.policy).domains })])) throw new Error('The restricted network proxy boundary changed.')
  return address
}
export async function prepareNetwork(value, { docker, engine, image, signal }) {
  if (desktopPolicy(value.record.policy).network !== 'restricted') return null
  if (engine?.kind === 'podman') throw new Error('Allowed-domain networking requires Docker with isolated internal bridge support. Use offline mode on this engine.')
  const { network, proxy } = names(value), code = await readFile(new URL('./proxy.py', import.meta.url), 'utf8')
  let net = await read(docker, ['network'], network, signal)
  if (!net) {
    await docker(['network', 'create', '--internal', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      '--label', `${label}=${value.record.id}`, '--label', `org.ds-bot.computer.owner=${value.record.botId}`, network], signal)
    net = await read(docker, ['network'], network, signal)
  }
  checkNetwork(net, value)
  let peer = await read(docker, [], proxy, signal)
  if (!peer) {
    await docker(['create', '--name', proxy, '--label', `${label}=${value.record.id}`, '--label', `org.ds-bot.computer.policy=${stamp(value)}`,
      '--network', 'bridge', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64', '--restart', 'no', '--log-driver', 'none',
      '--entrypoint', 'python3', image, '-c', code, JSON.stringify({ bind: 'dsbot-egress', domains: desktopPolicy(value.record.policy).domains })], signal)
    await docker(['network', 'connect', '--alias', 'dsbot-egress', network, proxy], signal)
    peer = await read(docker, [], proxy, signal)
  }
  // A stopped container has no allocated address. Validate using a placeholder before start.
  const before = structuredClone(peer)
  if (!before.State?.Running && before.NetworkSettings?.Networks?.[network]) before.NetworkSettings.Networks[network].IPAddress ||= '0.0.0.0'
  checkProxy(before, value, image, code)
  if (!peer.State?.Running) await docker(['start', proxy], signal)
  peer = await read(docker, [], proxy, signal)
  const address = checkProxy(peer, value, image, code)
  return { address }
}
export async function verifyNetwork(value, data, { docker, image, signal }) {
  if (desktopPolicy(value.record.policy).network !== 'restricted') return
  const { network, proxy } = names(value), net = await read(docker, ['network'], network, signal)
  if (!net) throw new Error('The restricted network is missing.')
  checkNetwork(net, value)
  if (Object.keys(data.NetworkSettings?.Networks ?? {}).join(',') !== network || data.HostConfig?.Dns?.join(',') !== '127.0.0.1') throw new Error('The desktop has an unexpected network connection.')
  if (data.State?.Running) {
    const peer = await read(docker, [], proxy, signal), code = await readFile(new URL('./proxy.py', import.meta.url), 'utf8')
    if (peer?.State?.Running) checkProxy(peer, value, image, code)
  }
}
export async function removeNetwork(value, { docker, image, signal }) {
  if (desktopPolicy(value.record.policy).network !== 'restricted') return
  const { network, proxy } = names(value), net = await read(docker, ['network'], network, signal)
  if (!net) return
  checkNetwork(net, value)
  const peer = await read(docker, [], proxy, signal)
  if (peer) {
    const code = await readFile(new URL('./proxy.py', import.meta.url), 'utf8'), copy = structuredClone(peer)
    if (!copy.State?.Running && copy.NetworkSettings?.Networks?.[network]) copy.NetworkSettings.Networks[network].IPAddress ||= '0.0.0.0'
    checkProxy(copy, value, image, code)
    await docker(['rm', '-f', proxy], signal)
  }
  // Docker refuses removal while any guest still references this network.
  await docker(['network', 'rm', network], signal)
}
export const proxyEnvironment = value => desktopPolicy(value.record.policy).network === 'restricted'
  ? ['--dns', '127.0.0.1', ...['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].flatMap(key => ['--env', `${key}=http://dsbot-egress:3128`]),
    '--env', 'NO_PROXY=', '--env', 'no_proxy='] : []
// A separate browser profile avoids silently changing the user's normal browser settings.
export const browserBootstrap = `import os,json,stat\nfrom pathlib import Path\np=Path('/home/cua/.dsbot-restricted-browser')\nif p.is_symlink(): raise RuntimeError('Unsafe browser profile')\np.mkdir(mode=0o700,exist_ok=True)\nf=p/'user.js'\nfd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)\nsettings={'network.proxy.type':1,'network.proxy.http':'dsbot-egress','network.proxy.http_port':3128,'network.proxy.ssl':'dsbot-egress','network.proxy.ssl_port':3128,'network.proxy.no_proxies_on':'','network.trr.mode':5}\nwith os.fdopen(fd,'w') as out:\n for key,val in settings.items(): out.write('user_pref('+json.dumps(key)+','+json.dumps(val)+');\\n')\np=Path('/home/cua/Desktop')\nif p.is_symlink(): raise RuntimeError('Unsafe desktop folder')\np.mkdir(exist_ok=True)\nfd=os.open(p/'DSBot Restricted Browser.desktop',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o700)\nwith os.fdopen(fd,'w') as out: out.write('[Desktop Entry]\\nType=Application\\nName=DSBot Restricted Browser\\nExec=firefox --no-remote --profile /home/cua/.dsbot-restricted-browser\\nIcon=firefox\\nTerminal=false\\n')\nos.execv('/opt/venv/bin/python3',['/opt/venv/bin/python3','/opt/dsbot/launch.py'])`
export async function stopNetwork(value, { docker, image, signal }) {
  if (desktopPolicy(value.record.policy).network !== 'restricted') return
  const { proxy } = names(value), peer = await read(docker, [], proxy, signal)
  if (!peer?.State?.Running) return
  const code = await readFile(new URL('./proxy.py', import.meta.url), 'utf8')
  checkProxy(peer, value, image, code)
  await docker(['stop', '--time', '2', proxy], signal)
}
