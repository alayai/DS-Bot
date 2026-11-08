// Keep crowded labels keyboard reachable; the focused label gets first choice.
export function arrangeLabels(items, width, height) {
  const occupied = []
  const gap = 5
  const placed = items.map((item, index) => {
    const w = Math.min(item.width, Math.max(1, width - 16))
    const h = item.height
    const left = Math.max(8, Math.min(width - w - 8, item.x - w / 2))
    const top = Math.max(64, Math.min(Math.max(64, height - h - 64), item.y - h))
    return { ...item, index, left, top, width: w, height: h }
  }).sort((a, b) => b.priority - a.priority || a.index - b.index)
  for (const item of placed) {
    const intersects = other => item.left < other.left + other.width + gap
      && item.left + item.width + gap > other.left
      && item.top < other.top + other.height + gap
      && item.top + item.height + gap > other.top
    item.hidden = !item.focused && (!item.inView || occupied.some(intersects))
    if (!item.hidden) occupied.push(item)
  }
  return placed.sort((a, b) => a.index - b.index)
}
