// Older hosts do not advertise Computers. False means supported but not configured.
export const hasComputerEntry = roster => typeof roster?.computer === 'boolean'

export function imagePoint(frame, rect, clientX, clientY) {
  if (!frame || rect.width <= 0 || rect.height <= 0) return null
  const x = Math.floor((clientX - rect.left) * frame.width / rect.width)
  const y = Math.floor((clientY - rect.top) * frame.height / rect.height)
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height ? { x, y } : null
}
export const freshFrame = (frame, now = Date.now()) => Boolean(frame && now - frame.receivedAt < frame.validForMs)
