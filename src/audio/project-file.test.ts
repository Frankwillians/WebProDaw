/**
 * Tests for the `.opdaw` file format - run with `npm test`.
 *
 * The producer's sessions live in this file. If the encode/decode round trip
 * loses a byte, the tape they hand over is corrupt, so the binary path, the
 * reference bookkeeping and the rejection of junk all get checked here - and so
 * does the promise that a file saved under the old WebDAW name still opens.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  base64ToBytes,
  buildChainFile,
  buildProjectFile,
  bytesToBase64,
  parseChainFile,
  parseProjectFile,
  projectFileToText,
  sampleIdsUsedBy,
} from './project-file.ts'

function wavBytes(fill: number, length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) bytes[i] = (fill + i * 37) % 256
  return bytes
}

test('base64 round trips every byte value, including long inputs', () => {
  const all = new Uint8Array(1000)
  for (let i = 0; i < all.length; i += 1) all[i] = i % 256
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(all))), Array.from(all))

  // Larger than one base64 chunk (0x8000), which is where a sloppy
  // String.fromCharCode spread would blow the argument limit.
  const long = wavBytes(7, 70000)
  const encoded = bytesToBase64(long)
  assert.ok(!/\s/.test(encoded), 'base64 must not contain line breaks')
  assert.deepEqual(Array.from(base64ToBytes(encoded)), Array.from(long))

  assert.equal(base64ToBytes('').length, 0)
})

test('a project file carries exactly the clips the tracks reference', async () => {
  const project = {
    tracks: [
      { id: 'a', bufferId: 'sample-one' },
      { id: 'b', bufferId: 'sample-two' },
      { id: 'c', bufferId: '' },
      { id: 'd' },
    ],
  }
  const stored = [
    { id: 'sample-one', blob: new Blob([wavBytes(1, 320)]) },
    { id: 'sample-two', blob: new Blob([wavBytes(2, 640)]) },
    { id: 'sample-not-referenced', blob: new Blob([wavBytes(3, 4096)]) },
  ]
  const file = await buildProjectFile(project, stored)
  assert.equal(file.kind, 'opdaw-project')
  assert.equal(file.version, 1)
  assert.deepEqual(
    file.samples.map((sample) => sample.id),
    ['sample-one', 'sample-two'],
  )
  assert.deepEqual(sampleIdsUsedBy(project), ['sample-one', 'sample-two'])
})

test('a project file survives the JSON round trip byte for byte', async () => {
  const bytes = wavBytes(11, 5000)
  const project = { bpm: 125, tracks: [{ id: 'a', bufferId: 'take-1' }] }
  const file = await buildProjectFile(project, [{ id: 'take-1', blob: new Blob([bytes]) }])
  const parsed = parseProjectFile(projectFileToText(file))
  assert.equal(parsed.samples.length, 1)
  assert.deepEqual(Array.from(parsed.samples[0].bytes), Array.from(bytes))
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.project, project)
})

test('a clip the file never carried is reported, not silently dropped', async () => {
  const project = {
    tracks: [
      { id: 'a', bufferId: 'present' },
      { id: 'b', bufferId: 'gone' },
    ],
  }
  const file = await buildProjectFile(project, [
    { id: 'present', blob: new Blob([wavBytes(4, 128)]) },
  ])
  const parsed = parseProjectFile(projectFileToText(file))
  assert.deepEqual(parsed.missing, ['gone'])
})

test('duplicate references do not duplicate the audio', async () => {
  const project = { tracks: [{ bufferId: 'same' }, { bufferId: 'same' }] }
  const file = await buildProjectFile(project, [
    { id: 'same', blob: new Blob([wavBytes(5, 64)]) },
  ])
  assert.equal(file.samples.length, 1)
  assert.deepEqual(sampleIdsUsedBy(project), ['same'])
})

test('a take sitting on the shelf travels with the project', async () => {
  const project = {
    tracks: [
      { bufferId: 'active', takes: [{ id: 'old-one' }, { id: 'old-two' }, { bufferId: 'junk' }] },
      { bufferId: 'active', takes: null },
    ],
  }
  assert.deepEqual(sampleIdsUsedBy(project), ['active', 'old-one', 'old-two'])
  const file = await buildProjectFile(project, [
    { id: 'active', blob: new Blob([wavBytes(6, 64)]) },
    { id: 'old-one', blob: new Blob([wavBytes(7, 64)]) },
    { id: 'old-two', blob: new Blob([wavBytes(8, 64)]) },
    { id: 'not-referenced', blob: new Blob([wavBytes(9, 64)]) },
  ])
  assert.deepEqual(file.samples.map((sample) => sample.id), ['active', 'old-one', 'old-two'])
})

test('a loaded NAM or cabinet travels with the project as its own asset', async () => {
  const project = {
    tracks: [
      {
        id: 'a',
        bufferId: 'clip',
        plugins: [
          { id: 'p1', kind: 'nam', assetId: 'nam-bytes' },
          { id: 'p2', kind: 'ir', assetId: 'ir-bytes' },
          // A session plugin loaded before assets were stored has no bytes to
          // carry; it must not invent an entry.
          { id: 'p3', kind: 'worklet' },
        ],
      },
      { id: 'b', plugins: [{ kind: 'nam', assetId: 'nam-bytes' }] },
    ],
  }
  assert.deepEqual(sampleIdsUsedBy(project), ['clip', 'nam-bytes', 'ir-bytes'])
  const file = await buildProjectFile(project, [
    { id: 'clip', blob: new Blob([wavBytes(10, 64)]) },
    { id: 'nam-bytes', blob: new Blob([wavBytes(11, 64)]) },
    { id: 'ir-bytes', blob: new Blob([wavBytes(12, 64)]) },
  ])
  assert.deepEqual(file.samples.map((sample) => sample.id), ['clip', 'nam-bytes', 'ir-bytes'])
})

test('junk is rejected with a message instead of half-loading a session', () => {
  assert.throws(() => parseProjectFile('not json at all'), /nao é|não é/)
  assert.throws(() => parseProjectFile(JSON.stringify({ hello: 'world' })), /opdaw/)
  assert.throws(
    () => parseProjectFile(JSON.stringify({ kind: 'opdaw-project', version: 2, project: {} })),
    /mais nova/,
  )
  assert.throws(
    () => parseProjectFile(JSON.stringify({ kind: 'opdaw-project', version: 1 })),
    /nenhum projeto/,
  )
})

/**
 * Sessions saved before the OpenDAW name say `webdaw-project` inside them. They
 * are the user's takes, so the reader keeps taking them - the rename is allowed
 * to reach the product, not somebody's archive.
 */
test('a file from before the OpenDAW name still opens', () => {
  const text = JSON.stringify({
    kind: 'webdaw-project',
    version: 1,
    savedAt: 'então',
    project: { tracks: [{ id: 'a', bufferId: 'old' }] },
    samples: [{ id: 'old', wav: bytesToBase64(wavBytes(7, 128)) }],
  })
  const parsed = parseProjectFile(text)
  assert.deepEqual(
    parsed.samples.map((sample) => sample.id),
    ['old'],
  )
  assert.deepEqual(parsed.missing, [])
})

test('a broken clip inside the file does not lose the rest of the session', () => {
  const text = JSON.stringify({
    kind: 'opdaw-project',
    version: 1,
    savedAt: 'now',
    project: { tracks: [{ id: 'a', bufferId: 'good' }, { id: 'b', bufferId: 'bad' }] },
    samples: [
      { id: 'good', wav: bytesToBase64(wavBytes(9, 256)) },
      { id: 'bad', wav: '!!! not base64 !!!' },
    ],
  })
  const parsed = parseProjectFile(text)
  assert.deepEqual(
    parsed.samples.map((sample) => sample.id),
    ['good'],
  )
  assert.ok(parsed.missing.includes('bad'))
})

test('chain presets keep the rack and the order, and no plugin ids', () => {
  const rack = { gate: { enabled: true, mix: 1, params: { gateThreshold: -40 } } }
  const file = buildChainFile('Voz limpa', rack, ['fx:gate', 'plugin-abc', 'fx:comp'])
  assert.equal(file.kind, 'opdaw-chain')
  assert.deepEqual(file.order, ['fx:gate', 'fx:comp'])

  const parsed = parseChainFile(JSON.stringify(file))
  assert.equal(parsed.name, 'Voz limpa')
  assert.deepEqual(parsed.order, ['fx:gate', 'fx:comp'])
  assert.deepEqual(parsed.rack, rack)
})

test('a chain file that is not a chain file is refused', () => {
  assert.throws(() => parseChainFile('{'), /cadeia/)
  assert.throws(() => parseChainFile(JSON.stringify({ kind: 'other' })), /cadeia/)
  // The old `webdaw-chain` identity is still accepted: this one gets as far as
  // complaining about the missing effects, not about the name on the box.
  assert.throws(
    () => parseChainFile(JSON.stringify({ kind: 'webdaw-chain', version: 1 })),
    /efeitos/,
  )
})
