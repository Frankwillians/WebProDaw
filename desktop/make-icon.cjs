#!/usr/bin/env node
/**
 * Desenha o ícone do OpenDAW em desktop/icon.png.
 *
 * É PNG puro, escrito à mão: retângulo arredondado no grafite do app e as
 * barras de forma de onda nas cores da interface (azul, verde do ganho, laranja
 * do clip). Sem dependência de editor de imagem — assim o ícone pode ser
 * regenerado a qualquer momento com `node desktop/make-icon.cjs`.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 256
const OUT = path.join(__dirname, 'icon.png')

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encode(rgba) {
  const stride = SIZE * 4
  const raw = Buffer.alloc((stride + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0 // filtro "none" por linha
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const px = Buffer.alloc(SIZE * SIZE * 4)

function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return
  const at = (y * SIZE + x) * 4
  const base = px[at + 3] === 0 ? [0, 0, 0, 0] : [px[at], px[at + 1], px[at + 2], px[at + 3]]
  const mix = (a, b) => Math.round(a * alpha + b * (1 - alpha))
  const out = [mix(color[0], base[0]), mix(color[1], base[1]), mix(color[2], base[2]), mix(255, base[3])]
  px[at] = out[0]
  px[at + 1] = out[1]
  px[at + 2] = out[2]
  px[at + 3] = out[3]
}

/** Signed distance to a rounded rectangle: negative means inside. */
function rounded(x, y, box, radius) {
  const dx = Math.abs(x - (box[0] + box[2]) / 2) - (box[2] - box[0]) / 2 + radius
  const dy = Math.abs(y - (box[1] + box[3]) / 2) - (box[3] - box[1]) / 2 + radius
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
}

const plate = [16, 16, 240, 240]
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const inside = rounded(x, y, plate, 46)
    if (inside > 0.5) continue
    // Corpo em grafite, um dedo mais claro no topo para dar volume.
    const shade = 30 + Math.round((y / SIZE) * 8)
    blend(x, y, [shade + 4, shade + 10, shade + 18], Math.min(1, -inside + 0.5))
    const edge = Math.abs(inside) < 1.6
    if (edge) blend(x, y, [58, 71, 87], 1)
  }
}

// Barras de forma de onda: alturas fixas, as mesmas cores da interface.
const heights = [42, 78, 120, 160, 196, 150, 96, 176, 208, 132, 84, 110, 54]
const barWidth = 12
const gap = 6
const totalWidth = heights.length * barWidth + (heights.length - 1) * gap
const startX = Math.round((SIZE - totalWidth) / 2)
const middle = SIZE / 2
heights.forEach((height, index) => {
  const color = index === 8 ? [95, 211, 138] : index === 4 ? [224, 138, 74] : [74, 122, 168]
  const x0 = startX + index * (barWidth + gap)
  for (let x = x0; x < x0 + barWidth; x += 1) {
    for (let y = Math.round(middle - height / 2); y < middle + height / 2; y += 1) {
      const cap = Math.min(1, Math.min(y - (middle - height / 2), middle + height / 2 - y) / 4)
      blend(x, y, color, 0.55 + 0.45 * cap)
    }
  }
})

fs.writeFileSync(OUT, encode(px))
console.log(`ícone escrito em ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} kB)`)
