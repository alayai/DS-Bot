import { createHash } from 'node:crypto'
import { assertVolume } from './boundary.mjs'
import { homeVolume, backupVolume } from './checkpoint.mjs'

const imageId = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '')
const computerId = value => /^cmp_[a-f0-9-]{36}$/.test(value ?? '')
const uuid = '[a-f0-9-]{36}'
const fail = message => { throw Object.assign(new Error(message), { public: true }) }
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function maintainStorage(method, options, { docker, signal, images, baseImage, runtimeKey }) {
  const registry = options.registry
  if (!registry || !Number.isSafeInteger(registry.revision) || !registry.computers || !registry.checkpoints
    || !registry.lifecycle || Object.keys(registry.lifecycle).length) fail('Finish desktop storage recovery before scanning for cleanup.')
  const records = Object.values(registry.computers)
  if (records.some(record => !computerId(record.id) || registry.computers[record.id] !== record)) fail('Invalid cleanup registry.')
  const json = async args => JSON.parse((await docker(args, signal)).stdout)
  const names = async args => (await docker(args, signal)).stdout.trim().split(/\s+/).filter(Boolean).sort()
  const knownVolumes = new Map(), knownOwners = new Map()
  const protectedVolumes = new Map(), protectedImages = new Map([[baseImage, 'Default desktop image']])
  for (const record of records) {
    knownOwners.set(homeVolume(record), record.id)
    knownVolumes.set(homeVolume(record), record.runtimeImage)
    protectedVolumes.set(homeVolume(record), 'Current desktop home')
    protectedImages.set(record.runtimeImage ?? baseImage, 'Current desktop image')
    for (const revision of record.previousHomes ?? []) {
      knownOwners.set(homeVolume({ ...record, homeRevision: revision }), record.id)
      knownVolumes.set(homeVolume({ ...record, homeRevision: revision }), record.previousImages?.[revision ?? 'original'] ?? record.runtimeImage)
      protectedVolumes.set(homeVolume({ ...record, homeRevision: revision }), 'Retained home for rollback')
      protectedImages.set(record.previousImages?.[revision ?? 'original'] ?? record.runtimeImage ?? baseImage, 'Retained image for rollback')
    }
  }
  for (const item of Object.values(registry.checkpoints)) {
    const record = registry.computers[item.computerId]
    if (!record) fail('Invalid checkpoint owner.')
    knownOwners.set(backupVolume(record, item.id), record.id)
    knownVolumes.set(backupVolume(record, item.id), item.image ?? record.runtimeImage)
    protectedVolumes.set(backupVolume(record, item.id), 'Saved checkpoint')
    protectedImages.set(item.image ?? record.runtimeImage ?? baseImage, 'Saved checkpoint image')
  }
  const containers = []
  for (const id of await names(['ps', '-aq'])) {
    const info = (await json(['inspect', id]))[0]
    if (!info || !imageId(info.Image) || !Array.isArray(info.Mounts)) fail('Container references could not be verified.')
    containers.push({ id: info.Id, image: info.Image, mounts: info.Mounts.filter(m => m.Type === 'volume').map(m => m.Name).sort() })
    protectedImages.set(info.Image, 'Referenced by a container')
    for (const mount of info.Mounts) if (mount.Type === 'volume') protectedVolumes.set(mount.Name, 'Referenced by a container')
  }
  const volumes = [], items = []
  for (const name of await names(['volume', 'ls', '-q', '--filter', 'label=org.ds-bot.computer.id'])) {
    const info = (await json(['volume', 'inspect', name]))[0]
    if (!info || info.Name !== name) fail('Volume identity could not be verified.')
    const labels = info.Labels ?? {}, owner = labels['org.ds-bot.computer.id']
    let image = labels['org.ds-bot.computer.image']
    const stamp = fingerprint({ runtimeKey, name, created: info.CreatedAt, labels, driver: info.Driver, options: info.Options })
    const claim = registry.storageClaims?.[name]
    if (!image && knownOwners.get(name) === owner && claim?.stamp === stamp && claim.image === knownVolumes.get(name)) image = claim.image
    volumes.push({ name, created: info.CreatedAt, labels, driver: info.Driver, options: info.Options })
    if (imageId(image)) protectedImages.set(image, 'Referenced by desktop storage')
    else for (const id of images) protectedImages.set(id, 'Storage image identity is unknown')
    const home = computerId(owner) && new RegExp(`^dsbot-${owner}-home(?:-${uuid})?$`).test(name)
    const backup = computerId(owner) && new RegExp(`^dsbot-${owner}-backup-(${uuid})$`).exec(name)
    const storage = labels['org.ds-bot.computer.storage']
    let boundary = false
    if (Object.hasOwn(registry.computers, owner)) {
      try { assertVolume(info, { record: registry.computers[owner], volume: name }); boundary = true } catch {}
    }
    const shape = (home && (!storage || storage === 'staged-home')) || (backup && backup[1] === labels['org.ds-bot.computer.checkpoint'] && storage === 'checkpoint')
    const owned = boundary && typeof info.CreatedAt === 'string' && computerId(owner) && Object.hasOwn(registry.computers, owner) && imageId(image)
      && shape
    const reason = protectedVolumes.get(name) ?? (owned ? null : 'Ownership cannot be verified for this team')
    items.push({ kind: 'volume', id: name, removable: !reason, reason, image: imageId(image) ? image : null,
      canVerify: Boolean(shape) && !image && knownOwners.get(name) === owner && boundary && typeof info.CreatedAt === 'string' && imageId(knownVolumes.get(name)),
      evidence: { stamp, image: knownVolumes.get(name) } })
  }
  const imageMetadata = []
  for (const id of [...images].sort()) {
    let info
    try { info = (await json(['image', 'inspect', id]))[0] }
    catch (error) { if (!/no such image|image not known/i.test(error.stderr ?? '')) throw error }
    if (info && info.Id !== id) fail('Image identity could not be verified.')
    imageMetadata.push({ id, exists: Boolean(info), tags: info?.RepoTags, size: info?.Size })
    const reason = protectedImages.get(id) ?? null
    items.push({ kind: 'image', id, removable: !reason, reason, bytes: info?.Size ?? 0, missing: !info })
  }
  const token = fingerprint({ runtimeKey, registry, containers, volumes, imageMetadata })
  if (method === 'scan') return { token, items }
  if (!['remove', 'verify'].includes(method) || options.token !== token) fail('Cleanup information changed. Scan again before deleting.')
  const selected = items.find(item => item.id === options.id && item.kind === options.kind)
  if (method === 'verify') {
    if (!selected?.canVerify) fail('This legacy volume has no verifiable image reference in this team.')
    return { verified: { name: selected.id, ...selected.evidence } }
  }
  if (!selected?.removable) fail('This resource is still referenced or its ownership cannot be verified.')
  // No force: the engine must also refuse a resource claimed by another container.
  if (selected.kind === 'volume') await docker(['volume', 'rm', selected.id], signal)
  else if (!selected.missing) await docker(['image', 'rm', selected.id], signal)
  return { removed: selected.id, kind: selected.kind }
}
