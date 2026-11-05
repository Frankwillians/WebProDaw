/**
 * WAV read/write for the native side.
 *
 * 32-bit float keeps the plugin's headroom: an amp pushed into saturation must
 * not be quantised on the way back into the session. Everything the app already
 * does with these files (decodeAudioData on import) accepts this layout.
 */
const fs = require('node:fs')

/** Stereo, little-endian, IEEE float 32. */
function encodeStereoFloat32(interleavedL, interleavedR, sampleRate) {
  const frames = interleavedL.length
  const bytes = 44 + frames * 8
  const buffer = Buffer.alloc(bytes)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(bytes - 8, 4)
  buffer.write('WAVE', 8, 'latin1')
  buffer.write('fmt ', 12, 'latin1')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(3, 20) // IEEE float
  buffer.writeUInt16LE(2, 22) // channels
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 8, 28)
  buffer.writeUInt16LE(8, 32)
  buffer.writeUInt16LE(32, 34)
  buffer.write('data', 36, 'latin1')
  buffer.writeUInt32LE(frames * 8, 40)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  for (let i = 0; i < frames; i += 1) {
    view.setFloat32(44 + i * 8, interleavedL[i], true)
    view.setFloat32(44 + i * 8 + 4, interleavedR[i], true)
  }
  return buffer
}

/**
 * Read a PCM16 / PCM24 / float32 WAV into two Float32Arrays.
 * Only what the app writes back is supported, plus the 16/24-bit files a user
 * drags in from anywhere else.
 */
function decode(file) {
  const buffer = typeof file === 'string' ? fs.readFileSync(file) : file
  if (buffer.length < 44 || buffer.toString('latin1', 0, 4) !== 'RIFF') {
    throw new Error('não é um arquivo WAV')
  }
  let offset = 12
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = buffer.readUInt16LE(body)
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, buffer.length - body)
    }
    offset = body + size + (size % 2)
  }
  if (dataOffset < 0 || channels < 1) throw new Error('WAV sem dados')
  const bytesPer = bits / 8
  const frames = Math.floor(dataLength / (bytesPer * channels))
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const at = dataOffset + (i * channels + c) * bytesPer
      let value = 0
      if (format === 3 && bits === 32) value = view.getFloat32(at, true)
      else if (format === 1 && bits === 16) value = view.getInt16(at, true) / 32768
      else if (format === 1 && bits === 24) {
        const raw = buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16)
        value = (raw << 8) / 2147483648
      } else if (format === 1 && bits === 32) value = view.getInt32(at, true) / 2147483648
      if (c === 0) left[i] = value
      else if (c === 1) right[i] = value
      else if (c > 1) right[i] = value // fold extra channels onto the right
    }
  }
  return { left, right, sampleRate }
}

module.exports = { encodeStereoFloat32, decode }
