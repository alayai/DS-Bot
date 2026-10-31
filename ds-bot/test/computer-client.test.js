import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imagePoint, freshFrame, hasComputerEntry } from '../src/client/computer-model.js'
import { drawerMenuKeys, panelHasStrip } from '../src/client/side-model.js'
import { teamActions } from '../src/client/team-actions.js'
import { createSource } from '../src/client/sources.js'

test('scaled desktop pixels stay in the image bounds and frozen frames disable input', () => {
  const frame = { width: 1280, height: 800, receivedAt: 100, validForMs: 5000 }
  const rect = { left: 100, top: 50, width: 640, height: 400 }
  assert.deepEqual(imagePoint(frame, rect, 420, 250), { x: 640, y: 400 })
  assert.equal(imagePoint(frame, rect, 740, 250), null)
  assert.equal(imagePoint(frame, rect, 99, 250), null)
  assert.equal(freshFrame(frame, 5100), false)
  assert.equal(freshFrame(frame, 5099), true)
})

test('Computer opens without the Electron browser bridge and follows only Bot conversations', () => {
  assert.equal(panelHasStrip(false, 0, 0, true), true)
  assert.ok(drawerMenuKeys({ bot: true, canComputer: true }).includes('computer'))
  const ui = createSource({ settings: { page: 'bots' } })
  const roster = createSource({ byId: { a: { id: 'a' } } })
  const actions = teamActions({ ui, roster })
  actions.openComputer('a')
  assert.equal(ui.getSnapshot().view, 'computer')
  assert.equal(ui.getSnapshot().settings, null)
  actions.followPanel('group')
  assert.equal(ui.getSnapshot().view, 'details')
})


test('an installed but disabled Computer runtime keeps its discoverable setup entry', () => {
  for (const computer of [true, false]) {
    const canComputer = hasComputerEntry({ computer })
    assert.equal(canComputer, true)
    assert.equal(panelHasStrip(false, 0, 0, canComputer), true)
    assert.ok(drawerMenuKeys({ bot: true, canComputer }).includes('computer'))
    assert.equal(drawerMenuKeys({ bot: false, room: true, canComputer }).includes('computer'), false)
  }
  for (const roster of [undefined, {}, { computer: null }, { computer: 'false' }]) assert.equal(hasComputerEntry(roster), false)
})
