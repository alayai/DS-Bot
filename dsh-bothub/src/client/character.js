import { Group, Mesh, Vector3 } from 'three'

// Original articulated character. Every rig shares geometry and prop materials.
export function createCharacter(geometry, bodyMaterial, ink, office) {
  const group = new Group(), head = new Group(), up = new Vector3(0, 1, 0), direction = new Vector3()
  const mesh = (shape, material, parent = group) => {
    const value = new Mesh(shape, material); parent.add(value); return value
  }
  const body = mesh(geometry.body, bodyMaterial)
  group.add(head)
  mesh(geometry.head, bodyMaterial, head)
  const eyes = [-.1, .1].map(x => {
    const eye = mesh(geometry.eye, ink, head); eye.position.set(x, .02, -.24); return eye
  })
  const limbs = Array.from({ length: 8 }, () => mesh(geometry.limb, bodyMaterial))
  limbs[1].name = 'left-forearm'; limbs[3].name = 'right-forearm'
  const shoes = [-1, 1].map(() => {
    const shoe = mesh(geometry.head, ink); shoe.scale.set(.4, .22, .6); return shoe
  })
  shoes[0].name = 'left-shoe'; shoes[1].name = 'right-shoe'
  const prop = (shape, material, scale, parent = group) => {
    const value = mesh(office.geometry[shape], office.materials[material], parent)
    value.scale.set(...scale); return value
  }
  const cup = new Group(); group.add(cup)
  cup.name = 'cup'
  prop('cylinder', 'white', [.08, .15, .08], cup)
  const liquid = prop('cylinder', 'brown', [.068, .008, .068], cup); liquid.position.y = .079
  liquid.name = 'drink-liquid'
  const handle = prop('torus', 'white', [.055, .055, .055], cup); handle.position.x = .09
  const steam = Array.from({ length: 3 }, () => prop('sphere', 'white', [.025, .055, .025], cup))
  const pouring = prop('cylinder', 'screenLine', [.01, .06, .01])
  pouring.name = 'drink-pour'
  const weights = [-1, 1].map(() => {
    const weight = new Group(); group.add(weight)
    prop('cylinder', 'metal', [.025, .38, .025], weight).rotation.z = Math.PI / 2
    for (const x of [-.16, .16]) {
      const end = prop('cylinder', 'dark', [.12, .08, .12], weight)
      end.rotation.z = Math.PI / 2; end.position.x = x
    }
    return weight
  })
  const cue = prop('cylinder', 'oak', [.015, 2.3, .015]); cue.rotation.x = Math.PI / 2
  const ball = prop('sphere', 'white', [.055, .055, .055])
  const drops = Array.from({ length: 4 }, () => prop('sphere', 'screenLine', [.025, .055, .025]))
  const snores = Array.from({ length: 3 }, () => {
    const z = new Group(); group.add(z)
    for (const [y, rotation] of [[.08, 0], [0, .8], [-.08, 0]]) {
      const bar = prop('box', 'screenLine', [.16, .025, .025], z)
      bar.position.y = y; bar.rotation.z = rotation
    }
    return z
  })
  let initialized = false
  const move = (object, value, blend) => {
    object.position.x += (value[0] - object.position.x) * blend
    object.position.y += (value[1] - object.position.y) * blend
    object.position.z += (value[2] - object.position.z) * blend
  }
  const bone = (object, a, b, radius, blend) => {
    direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    move(object, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], blend)
    object.scale.set(radius, direction.length(), radius)
    object.quaternion.setFromUnitVectors(up, direction.normalize())
  }
  const update = ({ action = 'sit', time = 0, counter = false, drink = null, filled = false }, dt = 1) => {
    const blend = initialized ? 1 - Math.exp(-dt * 18) : 1
    initialized = true
    const standing = !['sit', 'type', 'sleep'].includes(action), height = standing ? .28 : 0
    const sleeping = action === 'sleep', working = action === 'type', walking = action === 'walk'
    const drinking = action === 'water' || action === 'coffee'
    const beverage = drinking ? action : walking && ['water', 'coffee'].includes(drink) ? drink : null
    const wipe = working && time % 7 > 5.4
    const sway = walking ? Math.sin(time * 9) : 0
    const curl = .5 + .5 * Math.sin(time * 2.7)
    const breathing = sleeping ? Math.sin(time * 2) * .012 : 0
    move(body, [0, .85 + height + (walking ? Math.abs(sway) * .025 : breathing), sleeping ? -.02 : .3], blend)
    body.rotation.x += ((sleeping ? -.85 : working ? -.12 : action === 'snooker' ? -.3 : 0) - body.rotation.x) * blend
    move(head, [0, sleeping ? 1.13 + breathing : 1.26 + height + (working ? Math.sin(time * 13) * .012 : 0), sleeping ? -.48 : .3], blend)
    head.rotation.x += ((sleeping ? -.65 : working ? -.15 : 0) - head.rotation.x) * blend
    for (const eye of eyes) eye.scale.y = sleeping ? .12 : 1
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      let elbow = [side * .32, .78 + height, -.06], hand = [side * .27, .91 + height, -.27]
      if (working) {
        hand = [side * .23 - .1, .94 + Math.sin(time * 30 + i * Math.PI) * .045, -.32]
        if (wipe && i === 1) { elbow = [.4, 1.16, .15]; hand = [.1 + Math.sin(time * 12) * .09, 1.41, .12] }
      } else if (sleeping) {
        elbow = [side * .32, .94, -.28]; hand = [-side * .12, .96, -.47]
      } else if (standing) {
        elbow = [side * .3, 1.05, .3 - side * sway * .16]
        hand = [side * .32, .85, .3 - side * sway * .3]
        if (action === 'stretch') {
          elbow = [side * .48, 1.48 + curl * .12, .25]
          hand = [side * (.25 + curl * .2), 1.77 + curl * .13, .2]
        } else if (action === 'dumbbell') hand = [side * .35, .86 + curl * .55, .15 - curl * .2]
        else if (walking && beverage && i === 1) {
          elbow = [.4, 1.1, .24]; hand = [.36, 1.1, .02]
        } else if (drinking && i === 1) {
          const sip = .5 + .5 * Math.sin(time * 1.6)
          elbow = [.38, 1.16, .13]; hand = [.23, 1.15 + sip * .3, -.02 + sip * .04]
          if (time < 2) {
            elbow = [.3, 1.05, -.1]
            hand = action === 'water' && !counter ? [.19, .72, -.465] : [.24, 1.25, -.565]
          }
        } else if (action === 'snooker') {
          elbow = [side * .32, 1.17, -.03]
          hand = [side * .12, 1.27, i === 0 ? -.58 : -.1 + Math.sin(time * 2) * .12]
        }
      }
      bone(limbs[i * 2], [side * .24, .94 + height, sleeping ? .05 : .28], elbow, .06, blend)
      bone(limbs[i * 2 + 1], elbow, hand, .05, blend)
      const knee = [side * .13, standing ? .48 : .53, standing ? .3 + side * sway * .16 : .03]
      const foot = [side * .13, standing ? .17 + Math.max(0, side * sway) * .1 : .22, standing ? .25 + side * sway * .34 : .03]
      bone(limbs[4 + i * 2], [side * .12, .65 + height, .3], knee, .075, blend)
      bone(limbs[5 + i * 2], knee, foot, .06, blend)
      move(shoes[i], [foot[0], foot[1] - .05, foot[2] - .07], blend)
      weights[i].visible = action === 'dumbbell'
      move(weights[i], hand, blend)
      if (i === 1) {
        move(cup, [hand[0] - .09, hand[1] + .025, hand[2] - .035], blend)
        cup.rotation.x = time >= 2 && drinking ? -.25 - curl * .25 : 0
      }
    }
    cup.visible = Boolean(beverage)
    liquid.visible = drinking ? time > 0 : filled
    liquid.material = office.materials[beverage === 'water' ? 'screenLine' : 'brown']
    pouring.visible = drinking && time < 2
    pouring.material = office.materials[beverage === 'water' ? 'screenLine' : 'brown']
    const dispenser = action === 'water' && !counter
    pouring.position.set(dispenser ? .1 : .15, dispenser ? .83 : 1.39, dispenser ? -.5 : -.6)
    steam.forEach((item, i) => {
      item.visible = beverage === 'coffee' && (drinking ? time >= 2 : filled)
      item.position.set(Math.sin(time * 2 + i) * .025, .14 + (time * .15 + i * .08) % .28, 0)
    })
    cue.visible = ball.visible = action === 'snooker'
    cue.position.set(0, 1.27, -.75 + Math.sin(time * 2) * .12)
    ball.position.set(0, 1.23, -1.25 - Math.max(0, Math.sin(time * 2)) * .8)
    drops.forEach((item, i) => {
      item.visible = working
      const phase = (time * 1.4 + i * .25) % 1
      item.position.set((i % 2 ? 1 : -1) * (.21 + phase * .12), 1.43 - phase * .45, .2)
      const size = (1 - phase) * .8 + .2
      item.scale.set(.025 * size, .055 * size, .025 * size)
    })
    snores.forEach((item, i) => {
      item.visible = sleeping
      const phase = (time * .22 + i / 3) % 1
      item.position.set(.2 + phase * .35, 1.45 + phase * .65, -.48)
      item.scale.setScalar(.5 + phase * .6)
    })
  }
  update({})
  return { group, update }
}
