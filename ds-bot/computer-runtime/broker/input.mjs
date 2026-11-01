const keys = Object.freeze({
  Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace',
  Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left',
  ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup',
  PageDown: 'pagedown', Space: 'space',
})

export function driverInput(actions, frame) {
  if (!Array.isArray(actions) || actions.length !== 1 || !frame) throw new Error('One action and a current observation are required.')
  const action = actions[0]
  const fields = { click: ['type', 'x', 'y', 'button', 'count'], text: ['type', 'text'], key: ['type', 'key', 'modifiers'], drag: ['type', 'x', 'y', 'toX', 'toY', 'button', 'durationMs'], scroll: ['type', 'x', 'y', 'deltaY'] }
  if (!action || !Object.hasOwn(fields, action.type) || Object.keys(action).some(key => !fields[action.type].includes(key))) {
    throw new Error('Unsupported desktop action.')
  }
  if (['click', 'scroll', 'drag'].includes(action.type)) {
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y)
      || action.x < 0 || action.y < 0 || action.x >= frame.screenshot_width || action.y >= frame.screenshot_height) {
      throw new Error('Input coordinates are outside the observed image.')
    }
  }
  const args = { scope: 'desktop' }
  if (action.type === 'click') {
    if (!['left', 'middle', 'right'].includes(action.button ?? 'left')) throw new Error('Unsupported mouse button.')
    if (action.count !== undefined && ![1, 2].includes(action.count)) throw new Error('Invalid click count.')
    return { name: 'click', args: { ...args, x: action.x, y: action.y, button: action.button ?? 'left', ...(action.count !== undefined ? { count: action.count } : {}), capture_id: frame.capture_id } }
  }
  if (action.type === 'drag') {
    if (!Number.isInteger(action.toX) || !Number.isInteger(action.toY) || action.toX < 0 || action.toY < 0
      || action.toX >= frame.screenshot_width || action.toY >= frame.screenshot_height
      || !['left', 'middle', 'right'].includes(action.button ?? 'left')
      || (action.durationMs !== undefined && (!Number.isInteger(action.durationMs) || action.durationMs < 100 || action.durationMs > 2000))) {
      throw new Error('Invalid drag endpoint, button or duration.')
    }
    return { name: 'drag', args: { ...args, from_x: action.x, from_y: action.y, to_x: action.toX, to_y: action.toY,
      button: action.button ?? 'left', duration_ms: action.durationMs ?? 500, steps: 20 } }
  }
  if (action.type === 'text') {
    if (typeof action.text !== 'string' || action.text.length < 1 || action.text.length > 4000 || action.text.includes('\0')) {
      throw new Error('Text must contain between one and 4000 characters without NUL.')
    }
    return { name: 'type_text', args: { ...args, text: action.text } }
  }
  if (action.type === 'key') {
    if (typeof action.key !== 'string' || (!Object.hasOwn(keys, action.key) && !/^([a-zA-Z0-9]|F[1-9]|F1[0-2])$/.test(action.key))) throw new Error('Unsupported keyboard key.')
    const modifiers = { Control: 'ctrl', Shift: 'shift', Alt: 'alt', Super: 'super' }
    if (action.modifiers !== undefined && (!Array.isArray(action.modifiers) || action.modifiers.length > 4
      || new Set(action.modifiers).size !== action.modifiers.length || action.modifiers.some(key => !Object.hasOwn(modifiers, key)))) throw new Error('Invalid key modifiers.')
    return { name: 'press_key', args: { ...args, key: keys[action.key] ?? action.key.toLowerCase(),
      ...(action.modifiers ? { modifiers: action.modifiers.map(key => modifiers[key]) } : {}) } }
  }
  if (!Number.isInteger(action.deltaY) || Math.abs(action.deltaY) > 50 || action.deltaY === 0) throw new Error('Scroll distance must be between one and 50 steps.')
  return { name: 'scroll', args: { ...args, x: action.x, y: action.y, by: 'line', direction: action.deltaY < 0 ? 'up' : 'down', amount: Math.abs(action.deltaY) } }
}

export function driverReceipt(result) {
  // No business outcome can be inferred from a transport acknowledgment.
  // Only an explicit pre-dispatch refusal proves that nothing was performed.
  return { outcome: result?.effect === 'refused' ? 'rejected' : 'unknown', completedActions: 0 }
}
