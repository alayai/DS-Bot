const LIMIT = 65536

export function rfbInput(interactive = false) {
  let stage = 0
  let pending = Buffer.alloc(0)
  const keys = new Set()
  let pointer
  const filter = data => {
    if (pending.length + data.length > LIMIT) throw new Error('Viewer input exceeds its limit.')
    pending = Buffer.concat([pending, data])
    const output = []
    while (pending.length) {
      let size
      if (stage < 3) {
        size = stage === 0 ? 12 : 1
        if (pending.length < size) break
        if (stage === 0 ? pending.subarray(0, 12).toString() !== 'RFB 003.008\n' : pending[0] !== 1) {
          throw new Error('Unsupported viewer handshake.')
        }
        stage++
      } else {
        const type = pending[0]
        if (type === 0) size = 20
        else if (type === 4 && interactive) size = 8
        else if (type === 5 && interactive) size = 6
        else if (type === 2) {
          if (pending.length < 4) break
          size = 4 + pending.readUInt16BE(2) * 4
        } else if (type === 3 || type === 150) size = 10
        else if (type === 248) {
          if (pending.length < 9) break
          if (pending[8] > 64) throw new Error('Invalid fence.')
          size = 9 + pending[8]
        } else throw new Error('Viewer input is read-only.')
        if (size > LIMIT) throw new Error('Viewer input exceeds its limit.')
        if (pending.length < size) break
      }
      let message = pending.subarray(0, size)
      if (stage === 3 && message[0] === 4 && message[1] > 1) throw new Error('Invalid key state.')
      if (stage === 3 && message[0] === 4) {
        const key = message.readUInt32BE(4)
        if (message[1]) keys.add(key)
        else keys.delete(key)
        if (keys.size > 256) throw new Error('Too many held keys.')
      }
      if (stage === 3 && message[0] === 5) pointer = Buffer.from(message)
      // Do not advertise clipboard, resize, power or extended-key capabilities.
      if (stage === 3 && size >= 4 && message[0] === 2) {
        const encodings = []
        for (let offset = 4; offset < size; offset += 4) {
          const encoding = message.readInt32BE(offset)
          if (![-308, -309, -258, 0xc0a1e5ce | 0].includes(encoding)) encodings.push(message.subarray(offset, offset + 4))
        }
        const header = Buffer.from([2, 0, 0, 0])
        header.writeUInt16BE(encodings.length, 2)
        message = Buffer.concat([header, ...encodings])
      }
      output.push(message)
      pending = pending.subarray(size)
    }
    return Buffer.concat(output)
  }
  filter.release = () => {
    const messages = [...keys].map(key => {
      const message = Buffer.alloc(8)
      message[0] = 4
      message.writeUInt32BE(key, 4)
      return message
    })
    keys.clear()
    if (pointer) { pointer[1] = 0; messages.push(pointer); pointer = undefined }
    return Buffer.concat(messages)
  }
  return filter
}
