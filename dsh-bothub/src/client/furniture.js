import {
  BoxGeometry, Color, CylinderGeometry, DataTexture, Group, InstancedMesh, Matrix4,
  MeshStandardMaterial, Object3D, RepeatWrapping, RGBAFormat, SphereGeometry,
  SRGBColorSpace, TorusGeometry, Vector3,
} from 'three'
import { roomFixtures } from './office-layout.js'

// Original procedural surfaces: no image requests or per-room texture copies.
function surface(kind) {
  const size = 64, data = new Uint8Array(size * size * 4)
  let seed = 41
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const noise = (seed >>> 24) / 255
    const grain = kind === 'wood' ? Math.sin(x * .65 + Math.sin(y * .13) * .8) * 8 : (x + y) % 2 * 7
    const value = 224 + noise * 18 + grain
    const offset = (y * size + x) * 4
    data.set([value, value, value, 255], offset)
  }
  const texture = new DataTexture(data, size, size, RGBAFormat)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.needsUpdate = true
  return texture
}

export function createOfficeAssets() {
  const wood = surface('wood'), fabric = surface('fabric')
  const geometry = {
    box: new BoxGeometry(1, 1, 1), cylinder: new CylinderGeometry(1, 1, 1, 16),
    sphere: new SphereGeometry(1, 12, 8), torus: new TorusGeometry(1, .12, 6, 20),
  }
  const palette = {
    oak: [0xb98e62, .65, 0, wood], walnut: [0x654631, .6, 0, wood],
    floor: [0xd9c9ae, .95, 0, wood], carpet: [0xa8b7b6, 1, 0, fabric],
    wall: [0xe5e7e1, .95], trim: [0xf4f0e7, .6], metal: [0x667680, .35, .65],
    dark: [0x29343d, .5, .2], black: [0x121e26, .8], white: [0xf2eee2, .4],
    screen: [0x315d73, .35], screenLine: [0x8ebbbb, .5],
    sofa: [0x50787c, .95, 0, fabric], cushion: [0xc2a479, .95, 0, fabric],
    green: [0x467958, .9], leaf: [0x73976c, .85], soil: [0x46392e, 1], pot: [0xd0b99b, .85],
    felt: [0x21664b, 1, 0, fabric], red: [0xb93137, .3], blue: [0x376a9c, .3],
    yellow: [0xd5b746, .3], pink: [0xd78c99, .3], brown: [0x875137, .4],
    paper: [0xe3d6b8, .95], bookBlue: [0x526d86, .9], bookRed: [0xa26755, .9], bookGold: [0xb09a60, .9],
  }
  const materials = Object.fromEntries(Object.entries(palette).map(([name, [color, roughness, metalness = 0, map]]) =>
    [name, new MeshStandardMaterial({ color, roughness, metalness, ...(map ? { map } : {}) })]))
  return {
    geometry, materials,
    theme({ background, card, dark }) {
      materials.wall.color.copy(new Color(card))
      materials.trim.color.copy(new Color(background))
      for (const name of ['floor', 'carpet']) {
        materials[name].color.setHex(palette[name][0]).multiplyScalar(dark ? .42 : 1)
      }
    },
    dispose() {
      for (const item of Object.values(geometry)) item.dispose()
      for (const item of Object.values(materials)) item.dispose()
      wood.dispose(); fabric.dispose()
    },
  }
}

export function createOfficeEnvironment(layout, assets) {
  const group = new Group(), batches = new Map(), object = new Object3D()
  const up = new Vector3(0, 1, 0), direction = new Vector3()
  let base = new Matrix4(), target = null
  const put = (kind, material, matrix) => {
    const key = `${kind}:${material}`
    if (!batches.has(key)) batches.set(key, { kind, material, items: [] })
    batches.get(key).items.push({ matrix: base.clone().multiply(matrix), target })
  }
  const shape = (kind, material, x, y, z, w, h, d, rotation = [0, 0, 0]) => {
    object.position.set(x, y, z); object.scale.set(w, h, d); object.rotation.set(...rotation)
    object.updateMatrix(); put(kind, material, object.matrix)
  }
  const box = (m, x, y, z, w, h, d, rotation) => shape('box', m, x, y, z, w, h, d, rotation)
  const cylinder = (m, x, y, z, r, h) => shape('cylinder', m, x, y, z, r, h, r)
  const sphere = (m, x, y, z, r) => shape('sphere', m, x, y, z, r, r, r)
  const rod = (m, from, to, r) => {
    direction.set(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    object.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2)
    object.scale.set(r, direction.length(), r)
    object.quaternion.setFromUnitVectors(up, direction.normalize())
    object.updateMatrix(); put('cylinder', m, object.matrix)
  }
  const at = (x, z, build, angle = 0) => {
    const before = base
    base = base.clone().multiply(new Matrix4().makeRotationY(angle).setPosition(x, 0, z))
    build(); base = before
  }
  const mug = (x, y, z) => {
    cylinder('white', x, y + .09, z, .085, .18)
    cylinder('brown', x, y + .181, z, .067, .006)
    shape('torus', 'white', x + .095, y + .1, z, .065, .065, .065)
  }
  const plant = () => {
    cylinder('pot', 0, .22, 0, .27, .44)
    cylinder('soil', 0, .445, 0, .245, .02)
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4, x = Math.cos(angle) * .22, z = Math.sin(angle) * .22, y = .8 + i % 3 * .17
      rod('green', [0, .43, 0], [x, y, z], .018)
      shape('sphere', i % 2 ? 'leaf' : 'green', x, y, z, .12, .25, .08, [0, angle, .5])
    }
  }
  const shelf = width => {
    box('oak', 0, 1.05, -.29, width, 2.1, .09)
    for (const x of [-width / 2 + .04, width / 2 - .04]) box('oak', x, 1.05, 0, .09, 2.1, .64)
    for (let level = 0; level < 5; level++) {
      const y = .08 + level * .5
      box('oak', 0, y, 0, width, .08, .65)
      if (level === 4) continue
      for (let book = 0; book < 9; book++) {
        const x = -width / 2 + .2 + book * (width - .35) / 9
        const height = .25 + (book * 7 + level * 3) % 5 * .025
        const color = ['bookBlue', 'bookRed', 'paper', 'bookGold'][(book + level) % 4]
        box(color, x, y + .05 + height / 2, .03, .105, height, .36)
        box('paper', x, y + height * .7, .215, .075, .018, .008)
      }
    }
  }
  const cabinet = () => {
    box('white', 0, .46, 0, 1.6, .88, .62)
    box('oak', 0, .93, 0, 1.7, .07, .72)
    for (const x of [-.4, .4]) {
      box('trim', x, .47, .32, .76, .8, .03)
      rod('metal', [x + .25, .46, .35], [x + .25, .62, .35], .015)
    }
    box('paper', -.35, 1.02, 0, .45, .12, .28)
    box('bookBlue', -.35, 1.09, 0, .47, .025, .3)
  }
  const whiteboard = () => {
    box('metal', 0, 1.5, 0, 2.5, 1.25, .07)
    box('white', 0, 1.5, .045, 2.37, 1.12, .025)
    for (let i = 0; i < 3; i++) {
      box('bookBlue', -.75 + i * .73, 1.7, .063, .45, .2, .006)
      box('metal', -.75 + i * .73, 1.41, .063, .44, .014, .006)
      box('metal', -.75 + i * .73, 1.33, .063, .3, .014, .006)
    }
    box('metal', 0, .86, .09, 2.3, .035, .15)
    box('bookRed', .6, .9, .09, .22, .045, .04)
  }
  const station = () => {
    box('oak', 0, .82, -.65, 2.25, .1, 1.08)
    for (const x of [-1, 1]) for (const z of [-1.06, -.24]) box('metal', x, .39, z, .065, .78, .065)
    box('metal', 0, .61, -1.06, 2, .06, .06)
    box('white', .78, .37, -.64, .47, .66, .79)
    for (const y of [.2, .43, .64]) {
      box('trim', .78, y, -.235, .43, .19, .025)
      box('metal', .78, y + .04, -.215, .16, .02, .025)
    }
    box('dark', -.12, .9, -.91, .4, .035, .25)
    rod('metal', [-.12, .91, -.94], [-.12, 1.15, -.94], .035)
    box('dark', -.12, 1.35, -.94, 1, .59, .07)
    box('screen', -.12, 1.36, -.899, .91, .49, .01)
    for (let row = 0; row < 5; row++) box('screenLine', -.27 + row % 2 * .08, 1.51 - row * .075, -.891, .45 - row % 3 * .07, .018, .005)
    box('dark', -.2, .893, -.3, .68, .035, .25)
    for (let row = 0; row < 3; row++) box('metal', -.2, .915, -.38 + row * .065, .59, .008, .015)
    box('carpet', .4, .879, -.3, .28, .015, .28)
    shape('sphere', 'dark', .4, .91, -.3, .065, .035, .09)
    mug(-.83, .875, -.29)
    cylinder('dark', .87, .9, -.97, .13, .035)
    rod('metal', [.87, .9, -.97], [.87, 1.42, -.97], .018)
    rod('metal', [.87, 1.42, -.97], [.62, 1.5, -.8], .018)
    shape('sphere', 'white', .62, 1.47, -.8, .15, .065, .12)
    cylinder('metal', 0, .3, .4, .04, .36)
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5, x = Math.cos(angle) * .37, z = .4 + Math.sin(angle) * .37
      rod('metal', [0, .13, .4], [x, .1, z], .025)
      sphere('dark', x, .07, z, .065)
    }
    box('sofa', 0, .52, .4, .67, .13, .62)
    box('dark', 0, .91, .72, .65, .65, .09, [-.1, 0, 0])
    box('sofa', 0, .94, .66, .56, .5, .08, [-.1, 0, 0])
    for (const x of [-.37, .37]) {
      rod('metal', [x, .5, .45], [x, .76, .45], .022)
      box('dark', x, .77, .35, .085, .055, .4)
    }
  }
  const coffee = () => {
    box('oak', 0, .5, 0, 5.2, 1, 1.15)
    box('white', 0, 1.03, 0, 5.35, .1, 1.3)
    for (let i = 0; i < 6; i++) {
      const x = -2.15 + i * .86
      box('trim', x, .51, .585, .8, .91, .025)
      box('metal', x, .84, .61, .24, .025, .035)
    }
    // Espresso machine: boiler, drip tray, two group heads and steam wand.
    box('metal', -1.25, 1.49, -.05, 1.1, .78, .69)
    box('dark', -1.25, 1.49, .305, .96, .52, .035)
    box('metal', -1.25, 1.16, .4, 1.1, .065, .35)
    for (const x of [-1.48, -1.1]) {
      cylinder('metal', x, 1.45, .4, .07, .12)
      rod('dark', [x, 1.45, .4], [x, 1.45, .59], .025)
      mug(x, 1.2, .42)
      sphere('white', x, 1.67, .33, .036)
    }
    rod('metal', [-.83, 1.55, .32], [-.78, 1.27, .51], .018)
    box('dark', -2.15, 1.27, -.05, .38, .38, .4)
    cylinder('brown', -2.15, 1.62, -.05, .16, .35)
    cylinder('dark', -2.15, 1.81, -.05, .18, .035)
    // Microwave: dark door, vertical handle, controls and ventilation slots.
    box('metal', .55, 1.43, -.02, 1.28, .66, .78)
    box('black', .43, 1.43, .384, .94, .48, .018)
    box('screen', .35, 1.43, .397, .68, .32, .009)
    rod('white', [.84, 1.26, .43], [.84, 1.61, .43], .022)
    box('screenLine', 1.06, 1.59, .386, .14, .07, .01)
    for (const y of [1.42, 1.3]) sphere('dark', 1.06, y, .39, .035)
    for (let i = 0; i < 5; i++) box('dark', .25 + i * .14, 1.768, -.03, .07, .009, .29)
    cylinder('metal', 1.8, 1.31, 0, .19, .44)
    cylinder('dark', 1.8, 1.55, 0, .2, .035)
    mug(2.2, 1.08, .28)
    box('walnut', 0, 2.05, -.2, 5.2, .09, .5)
    for (const x of [-1.7, -.8, .1, 1]) mug(x, 2.1, -.17)
  }
  const snooker = () => {
    for (const x of [-1, 1]) for (const z of [-1.75, 0, 1.75]) {
      cylinder('walnut', x, .52, z, .17, 1.04)
      cylinder('metal', x, .1, z, .19, .08)
    }
    box('walnut', 0, .98, 0, 2.75, .3, 4.75)
    box('felt', 0, 1.15, 0, 2.4, .055, 4.38)
    for (const x of [-1.3, 1.3]) box('oak', x, 1.2, 0, .18, .17, 4.6)
    for (const z of [-2.27, 2.27]) box('oak', 0, 1.2, z, 2.65, .17, .18)
    for (const x of [-1.11, 1.11]) box('green', x, 1.2, 0, .11, .09, 4.21)
    for (const z of [-2.08, 2.08]) box('green', 0, 1.2, z, 2.18, .09, .11)
    for (const x of [-1.18, 1.18]) for (const z of [-2.15, 0, 2.15]) cylinder('black', x, 1.3, z, .115, .025)
    for (const x of [-1.3, 1.3]) for (const z of [-1.5, -.75, .75, 1.5]) sphere('paper', x, 1.293, z, .022)
    box('paper', 0, 1.181, 1.2, 2.14, .004, .012)
    // A full rack of reds and the coloured balls, distinct from a pool table.
    for (let row = 0; row < 5; row++) for (let col = 0; col <= row; col++) sphere('red', (col - row / 2) * .115, 1.23, -.38 - row * .1, .055)
    for (const [m, x, z] of [['black', 0, -1.7], ['pink', 0, -.18], ['blue', 0, .45], ['yellow', -.45, 1.2], ['brown', 0, 1.2], ['green', .45, 1.2], ['white', .2, 1.65]]) sphere(m, x, 1.23, z, .055)
    rod('oak', [1.31, 1.32, -.9], [1.31, 1.32, 1.55], .018)
  }
  const lounge = () => {
    box('carpet', 0, .015, 0, 3.2, .025, 3.4)
    for (const x of [-1.15, 1.15]) for (const z of [-1.15, -.5]) box('walnut', x, .15, z, .09, .3, .09)
    box('sofa', 0, .42, -.8, 2.65, .38, .9)
    box('sofa', 0, .83, -1.22, 2.65, .72, .19)
    for (const x of [-1.23, 1.23]) box('sofa', x, .69, -.8, .2, .45, 1)
    for (const x of [-.78, 0, .78]) box('sofa', x, .64, -.78, .72, .1, .66)
    for (const x of [-.85, .85]) box('cushion', x, .89, -1.02, .4, .37, .14, [.1, 0, x > 0 ? .15 : -.15])
    box('oak', 0, .44, .48, 1.5, .08, .8)
    for (const x of [-.6, .6]) for (const z of [.2, .76]) box('metal', x, .22, z, .045, .44, .045)
    box('bookBlue', -.2, .51, .5, .38, .055, .28)
    mug(.4, .49, .4)
  }
  const fitness = () => {
    box('carpet', 0, .015, 0, 4.2, .025, 4.8)
    at(-.95, -.25, () => {
      box('metal', 0, .15, 0, 1.05, .23, 2.35)
      box('black', 0, .28, 0, .78, .025, 2.1)
      for (const x of [-.48, .48]) {
        rod('metal', [x, .2, -.85], [x, 1.35, -1], .04)
        rod('dark', [x, 1.18, -.95], [x, 1.12, -.28], .035)
      }
      box('dark', 0, 1.38, -.95, .98, .3, .16, [-.3, 0, 0])
      box('screen', 0, 1.4, -.85, .4, .16, .02, [-.3, 0, 0])
      for (const z of [-.9, -.45, 0, .45, .9]) box('metal', 0, .296, z, .75, .003, .008)
    })
    at(1.05, -1.4, () => {
      for (const x of [-.65, .65]) box('metal', x, .48, 0, .06, .96, .52)
      for (const y of [.48, .84]) {
        box('metal', 0, y, 0, 1.5, .05, .4)
        for (const x of [-.48, 0, .48]) {
          rod('metal', [x - .15, y + .12, 0], [x + .15, y + .12, 0], .023)
          for (const end of [-.15, .15]) shape('cylinder', 'dark', x + end, y + .12, 0, .1, .1, .1, [0, 0, Math.PI / 2])
        }
      }
    })
    box('sofa', 1.05, .045, .65, .85, .035, 2.1)
    shape('cylinder', 'cushion', 1.05, .16, 1.55, .12, .85, .12, [0, 0, Math.PI / 2])
    sphere('bookBlue', .55, .3, -.2, .26)
  }
  for (const room of layout.rooms) {
    base = new Matrix4().makeTranslation(room.x, 0, room.z)
    target = { room: true, groupId: room.groupId }
    box('trim', 0, -.19, 0, room.width + .15, .28, room.depth + .15)
    box(room.groupId === null ? 'floor' : 'carpet', 0, -.035, 0, room.width, .04, room.depth)
    const back = -room.depth / 2
    box('wall', 0, 1.18, back, room.width, 2.4, .15)
    box('oak', 0, .12, back + .09, room.width, .22, .07)
    for (const x of [-room.width / 2, room.width / 2]) {
      box('wall', x, .23, 0, .12, .5, room.depth)
      box('oak', x, .49, 0, .15, .04, room.depth)
    }
    for (let x = -room.width / 2 + 1.5; x < room.width / 2; x += 3) {
      box('white', x, 2.33, back + .14, 1.6, .04, .06)
    }
    // Inset floor seams give the common area scale without another texture.
    if (room.groupId === null) for (let z = back + 1; z < room.depth / 2; z += 1) box('oak', 0, -.012, z, room.width - .1, .006, .012)
    const clockX = room.groupId === null ? 4.2 : .1
    shape('cylinder', 'dark', clockX, 1.87, back + .13, .27, .07, .27, [Math.PI / 2, 0, 0])
    shape('cylinder', 'white', clockX, 1.87, back + .174, .235, .02, .235, [Math.PI / 2, 0, 0])
    rod('dark', [clockX, 1.87, back + .19], [clockX, 2.03, back + .19], .012)
    rod('dark', [clockX, 1.87, back + .19], [clockX + .12, 1.81, back + .19], .012)
    for (const fixture of roomFixtures(room)) at(fixture.x, fixture.z, () => {
      if (fixture.kind === 'shelf') shelf(fixture.width)
      else ({ cabinet, whiteboard, plant, coffee, snooker, lounge, fitness })[fixture.kind]()
    })
  }
  for (const seat of layout.presences) {
    base = new Matrix4().makeTranslation(seat.x, 0, seat.z)
    target = { entityId: seat.entity.id, groupId: seat.groupId, key: seat.key }
    station()
  }
  let instances = 0
  for (const { kind, material, items } of batches.values()) {
    const mesh = new InstancedMesh(assets.geometry[kind], assets.materials[material], items.length)
    items.forEach((item, index) => mesh.setMatrixAt(index, item.matrix))
    mesh.userData.targets = items.map(item => item.target)
    mesh.castShadow = !['screen', 'screenLine', 'carpet', 'floor'].includes(material)
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh); instances += items.length
  }
  return {
    group, batchCount: batches.size, instances,
    dispose() {
      for (const mesh of group.children) mesh.dispose()
      group.clear()
    },
  }
}
