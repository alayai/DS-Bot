import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maintainStorage } from '../../computer-runtime/broker/maintenance.mjs'

const base = `sha256:${'a'.repeat(64)}`, upgrade = `sha256:${'b'.repeat(64)}`
const id = `cmp_${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`
const revision = '22222222-2222-2222-2222-222222222222'
function fixture() {
  const record = { id, runtimeImage: base, previousHomes: [] }
  const registry = { revision: 1, computers: { [id]: record }, checkpoints: {}, lifecycle: {} }
  const volumes = new Map(), containers = new Map(), images = new Map([base, upgrade].map(Id => [Id, { Id, Size: 1024 }]))
  const removed = []
  const docker = async args => {
    const [kind, command, value] = args
    let result
    if (kind === 'ps') return { stdout: [...containers.keys()].join('\n') }
    if (kind === 'inspect') result = [containers.get(command)]
    else if (kind === 'volume' && command === 'ls') return { stdout: [...volumes.keys()].sort().join('\n') }
    else if (command === 'inspect') {
      const item = (kind === 'volume' ? volumes : images).get(value)
      if (!item) throw Object.assign(Error('missing'), { stderr: `No such ${kind}` })
      result = [item]
    } else if (command === 'rm') {
      removed.push(args)
      ;(kind === 'volume' ? volumes : images).delete(value)
      return { stdout: value }
    } else throw Error(`Unexpected command: ${args}`)
    return { stdout: JSON.stringify(result) }
  }
  const deps = { docker, images: [base, upgrade], baseImage: base, runtimeKey: 'test-engine' }
  const scan = () => maintainStorage('scan', { registry }, deps)
  const remove = async (kind, target, token) => maintainStorage('remove', { registry, kind, id: target, token: token ?? (await scan()).token }, deps)
  const volume = (name, image = base, owner = id) => {
    volumes.set(name, { Name: name, CreatedAt: '2026-11-01', Driver: 'local', Options: {}, Labels: {
      'org.ds-bot.computer.id': owner, 'org.ds-bot.computer.image': image,
    } })
    return volumes.get(name)
  }
  return { record, registry, deps, scan, remove, volume, volumes, containers, images, removed }
}
test('default, stopped/archived desktops, rollback and checkpoint images stay protected', async () => {
  for (const reference of ['current', 'rollback', 'checkpoint', 'volume', 'container']) {
    const h = fixture()
    h.record.archived = true
    if (reference === 'current') h.record.runtimeImage = upgrade
    if (reference === 'rollback') { h.record.previousHomes = [revision]; h.record.previousImages = { [revision]: upgrade } }
    if (reference === 'checkpoint') h.registry.checkpoints[revision] = { id: revision, computerId: id, image: upgrade }
    if (reference === 'volume') h.volume(`dsbot-${id}-home-${revision}`, upgrade)
    if (reference === 'container') h.containers.set('other', { Id: 'other', Image: upgrade, Mounts: [] })
    await assert.rejects(h.remove('image', upgrade), /referenced/)
    await assert.rejects(h.remove('image', base), /referenced/)
    assert.deepEqual(h.removed, [])
  }
})
test('current, retained and checkpoint volumes are protected even without a container', async () => {
  const h = fixture()
  h.record.previousHomes = [revision]
  h.registry.checkpoints[revision] = { id: revision, computerId: id, image: base }
  for (const name of [`dsbot-${id}-home`, `dsbot-${id}-home-${revision}`, `dsbot-${id}-backup-${revision}`]) {
    h.volume(name)
    await assert.rejects(h.remove('volume', name), /referenced/)
  }
})
test('only unreferenced, proven owned orphan volumes may be deleted without force', async () => {
  const h = fixture(), name = `dsbot-${id}-home-${revision}`
  h.volume(name)
  await h.remove('volume', name)
  assert.deepEqual(h.removed, [['volume', 'rm', name]])
  await h.remove('image', upgrade)
  assert.deepEqual(h.removed[1], ['image', 'rm', upgrade])
})
test('foreign, malformed, externally mounted and container-held orphan volumes are retained', async () => {
  for (const kind of ['foreign', 'name', 'image', 'driver', 'mounted', 'container']) {
    const h = fixture(), name = `dsbot-${id}-home-${revision}`
    const info = h.volume(name)
    if (kind === 'foreign') delete h.registry.computers[id]
    if (kind === 'name') info.Labels['org.ds-bot.computer.id'] = `cmp_${revision}`
    if (kind === 'image') delete info.Labels['org.ds-bot.computer.image']
    if (kind === 'driver') info.Driver = 'nfs'
    if (kind === 'mounted') info.Options.device = '/some/host/path'
    if (kind === 'container') h.containers.set('other', { Id: 'other', Image: base, Mounts: [{ Type: 'volume', Name: name }] })
    await assert.rejects(h.remove('volume', name), /referenced|ownership/)
    assert.deepEqual(h.removed, [])
  }
})
test('stale confirmation, new references, engine changes and recovery intents refuse deletion', async () => {
  for (const change of [h => h.registry.revision++, h => { h.deps.runtimeKey = 'another-engine' },
    h => { h.record.runtimeImage = upgrade }, h => { h.registry.lifecycle[id] = {} },
    h => { h.containers.set('new', { Id: 'new', Image: upgrade, Mounts: [] }) }]) {
    const h = fixture(), scan = await h.scan()
    change(h)
    await assert.rejects(h.remove('image', upgrade, scan.token), /changed|recovery/)
    assert.deepEqual(h.removed, [])
  }
})
test('missing unused image pins can be removed after an interrupted deletion', async () => {
  const h = fixture()
  h.images.delete(upgrade)
  assert.equal((await h.scan()).items.find(item => item.id === upgrade).missing, true)
  assert.deepEqual(await h.remove('image', upgrade), { removed: upgrade, kind: 'image' })
  assert.deepEqual(h.removed, [])
})
test('engine inspection and deletion failures are propagated without force or unrelated cleanup', async () => {
  const h = fixture(), scan = await h.scan(), original = h.deps.docker
  h.deps.docker = args => args[1] === 'rm' ? Promise.reject(Error('in use')) : original(args)
  await assert.rejects(h.remove('image', upgrade, scan.token), /in use/)
  assert.equal(h.images.has(upgrade), true)
  h.deps.docker = () => Promise.reject(Error('engine offline'))
  await assert.rejects(h.scan(), /offline/)
})

test('legacy evidence binds engine, creation metadata and registered ownership without relabelling', async () => {
  const h = fixture(), name = `dsbot-${id}-home`, volume = h.volume(name)
  delete volume.Labels['org.ds-bot.computer.image']
  let scan = await h.scan()
  assert.equal(scan.items.find(item => item.id === name).canVerify, true)
  const result = await maintainStorage('verify', { registry: h.registry, kind: 'volume', id: name, token: scan.token }, h.deps)
  h.registry.storageClaims = { [name]: result.verified }; h.registry.revision++
  scan = await h.scan()
  assert.equal(scan.items.find(item => item.id === upgrade).removable, true)
  assert.equal(volume.Labels['org.ds-bot.computer.image'], undefined)
  for (const change of [() => { volume.CreatedAt = 'changed' }, () => { h.deps.runtimeKey = 'changed' }]) {
    change(); assert.equal((await h.scan()).items.find(item => item.id === upgrade).removable, false)
  }
  assert.deepEqual(h.removed, [])
})

test('legacy claims cannot verify mismatched owners or stale scans', async () => {
  const h = fixture(), name = `dsbot-${id}-home`, volume = h.volume(name)
  delete volume.Labels['org.ds-bot.computer.image']
  const scan = await h.scan()
  volume.CreatedAt = 'replacement'
  await assert.rejects(maintainStorage('verify', { registry: h.registry, kind: 'volume', id: name, token: scan.token }, h.deps), /changed/)
  volume.Labels['org.ds-bot.computer.id'] = `cmp_${revision}`
  h.registry.computers[`cmp_${revision}`] = { ...h.record, id: `cmp_${revision}` }
  assert.equal((await h.scan()).items.find(item => item.id === name).canVerify, false)
})
