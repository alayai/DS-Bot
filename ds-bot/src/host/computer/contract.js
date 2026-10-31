export const PROTOCOL_VERSION = 1
export const TOOL_NAMES = ['computer_status', 'computer_observe', 'computer_act', 'computer_release', 'computer_request_takeover', 'computer_files', 'computer_import', 'computer_export']

export function refused(code, message) {
  return Object.assign(new Error(message), { code: `bot/computer-${code}` })
}

export function checkId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value) || Object.hasOwn(Object.prototype, value)) {
    throw refused('invalid', 'Invalid Computer identifier.')
  }
  return value
}

export function checkActions(actions, frame) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 8) {
    throw refused('invalid', 'Provide between one and eight actions.')
  }
  return actions.map(action => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw refused('invalid', 'Invalid action.')
    const fields = {
      click: ['type', 'x', 'y', 'button'],
      text: ['type', 'text'],
      key: ['type', 'key'],
      scroll: ['type', 'x', 'y', 'deltaY'],
    }
    const keys = Object.hasOwn(fields, action.type) ? fields[action.type] : undefined
    if (!keys || Object.keys(action).some(key => !keys.includes(key))) throw refused('invalid', 'Unsupported action or field.')
    if (action.type === 'click' || action.type === 'scroll') {
      if (!Number.isInteger(action.x) || !Number.isInteger(action.y)
        || action.x < 0 || action.y < 0 || action.x >= frame.width || action.y >= frame.height) {
        throw refused('invalid', 'Coordinates must be inside the observed image.')
      }
    }
    if (action.type === 'click' && action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) {
      throw refused('invalid', 'Unsupported mouse button.')
    }
    if (action.type === 'text' && (typeof action.text !== 'string' || action.text.length < 1 || action.text.length > 4000 || action.text.includes('\0'))) {
      throw refused('invalid', 'Text must contain between one and 4000 characters without NUL.')
    }
    if (action.type === 'key' && !/^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(action.key)) {
      throw refused('invalid', 'Unsupported key. Key combinations are not enabled yet.')
    }
    if (action.type === 'scroll' && (!Number.isInteger(action.deltaY) || Math.abs(action.deltaY) > 50 || action.deltaY === 0)) {
      throw refused('invalid', 'Scroll distance must be a nonzero integer between -50 and 50 line steps.')
    }
    return { ...action }
  })
}

export function checkProvider(provider) {
  if (provider?.protocolVersion !== PROTOCOL_VERSION
    || !['inspect', 'start', 'stop', 'observe', 'perform', 'revoke'].every(name => typeof provider[name] === 'function')) {
    throw refused('provider-unavailable', 'A compatible Computer provider is required.')
  }
  return provider
}

// The first protocol supports unscaled PNG frames only. No implicit coordinate conversion.
export function checkFrame(frame) {
  const data = frame?.data
  if (!Buffer.isBuffer(data) || data.length < 33 || data.length > 8 * 1024 * 1024
    || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') {
    throw refused('observation-unavailable', 'The provider did not return a bounded PNG frame.')
  }
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216
    || width !== frame.width || height !== frame.height) {
    throw refused('observation-unavailable', 'The screenshot dimensions do not match its coordinate space.')
  }
  return { data, width, height, mediaType: 'image/png' }
}
