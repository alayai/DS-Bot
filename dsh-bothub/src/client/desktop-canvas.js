// A clear invalidates decodes already in flight, including expiry while decoding.
export function createDesktopCanvas(canvas, ImageClass = Image) {
  let revision = 0, disposed = false
  const pending = new Set()
  const clear = () => {
    revision++
    for (const image of pending) image.src = ''
    pending.clear()
    canvas.width = canvas.height = 1
  }
  return {
    clear,
    async paint(frame, signal) {
      const version = revision
      if (disposed || signal.aborted) return false
      const image = new ImageClass()
      const abort = () => { image.src = '' }
      pending.add(image)
      signal.addEventListener('abort', abort, { once: true })
      try {
        image.src = `data:image/png;base64,${frame.data}`
        await image.decode()
        if (disposed || signal.aborted || revision !== version) return false
        if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) throw new Error('Desktop size changed')
        canvas.width = frame.width
        canvas.height = frame.height
        canvas.getContext('2d').drawImage(image, 0, 0)
        return true
      } finally {
        signal.removeEventListener('abort', abort)
        pending.delete(image)
        image.src = ''
      }
    },
    dispose() { disposed = true; clear() },
  }
}
