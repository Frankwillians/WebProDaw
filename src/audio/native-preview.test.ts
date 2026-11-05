/**
 * Tests for the native plugin preview rule - run with `npm test`.
 *
 * A native .dll or .vst3 lives in its own process, so the plugin cannot sit in
 * the live Web Audio graph: the app renders the lane's clip through it and the
 * engine plays and exports that pass. Two rules decide whether the producer
 * hears the plugin at all, and both are checked here without a browser, a
 * plugin, or a sound card: what counts as a change that needs a fresh render,
 * and which pass a lane actually hands to the output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativePreviewKey, takeToPlay } from './native-preview.ts'
import type { PreviewSource } from './native-preview.ts'

const slot = (path: string, values: number[], bypass = false): PreviewSource['nativeVst2'] => ({
  path,
  params: values.map((value, index) => ({ index, value })),
  bypass,
})

const lane = (over: Partial<PreviewSource> = {}): PreviewSource => ({
  kind: 'audio',
  bufferId: 'clip-1',
  clipDuration: 4,
  nativeVst2: slot('C:/VST/amp.dll', [0.5, 0.25]),
  ...over,
})

test('a lane with a plugin and a clip has a preview key', () => {
  const key = nativePreviewKey(lane(), 48000)
  assert.ok(key.includes('amp.dll'))
  assert.ok(key.includes('clip-1'))
  assert.ok(key.includes('48000'))
})

test('nothing to preview: no plugin, a bypass, no clip, or an instrument', () => {
  assert.equal(nativePreviewKey(lane({ nativeVst2: null }), 48000), '')
  assert.equal(nativePreviewKey(lane({ nativeVst2: slot('C:/VST/amp.dll', [0.5], true) }), 48000), '')
  assert.equal(nativePreviewKey(lane({ bufferId: '' }), 48000), '')
  assert.equal(nativePreviewKey(lane({ clipDuration: 0 }), 48000), '')
  assert.equal(nativePreviewKey(lane({ kind: 'instrument' }), 48000), '')
})

test('the key follows the knobs, the clip, the plugin and the rate', () => {
  const base = nativePreviewKey(lane(), 48000)
  assert.notEqual(base, nativePreviewKey(lane(), 44100))
  assert.notEqual(base, nativePreviewKey(lane({ bufferId: 'clip-2' }), 48000))
  assert.notEqual(base, nativePreviewKey(lane({ nativeVst2: slot('C:/VST/other.dll', [0.5, 0.25]) }), 48000))
  assert.notEqual(base, nativePreviewKey(lane({ nativeVst2: slot('C:/VST/amp.dll', [0.5, 0.75]) }), 48000))
})

test('the same settings always give the same key, in any order', () => {
  const forward = nativePreviewKey(lane({ nativeVst2: slot('C:/VST/amp.dll', [0.5, 0.25]) }), 48000)
  // The same two parameters, listed the other way round: a slot rebuilt from a
  // saved project can arrive in a different order, and that must not cost a
  // render of a pass that is already in the lane.
  const shuffled = nativePreviewKey(
    lane({ nativeVst2: { path: 'C:/VST/amp.dll', params: [{ index: 1, value: 0.25 }, { index: 0, value: 0.5 }] } }),
    48000,
  )
  assert.equal(forward, shuffled)
})

test('a knob moved by one hundredth is a new pass, a rounding error is not', () => {
  const base = nativePreviewKey(lane({ nativeVst2: slot('C:/VST/amp.dll', [0.5]) }), 48000)
  assert.notEqual(base, nativePreviewKey(lane({ nativeVst2: slot('C:/VST/amp.dll', [0.51]) }), 48000))
  assert.equal(base, nativePreviewKey(lane({ nativeVst2: slot('C:/VST/amp.dll', [0.500001]) }), 48000))
})

test('a lane plays the plugin pass while the engine holds one', () => {
  const dry = { name: 'seco' }
  const wet = { name: 'molhado' }
  assert.equal(takeToPlay({ monitor: { buffer: wet }, buffer: dry }), wet)
  assert.equal(takeToPlay({ monitor: null, buffer: dry }), dry)
  assert.equal(takeToPlay({ monitor: null, buffer: null }), null)
})

test('a stale pass is dropped before it can play: null clears the monitor', () => {
  // `setBuffer` is what a new take, a trim that replaced the file, or a cleared
  // lane calls, and it hands the monitor back to null. What the lane plays after
  // that is the clip itself, never the pass rendered from the file before it.
  const dry = { name: 'seco' }
  const wet = { name: 'molhado' }
  const track: { monitor: { buffer: typeof wet } | null; buffer: typeof dry | null } = {
    monitor: { buffer: wet },
    buffer: dry,
  }
  assert.equal(takeToPlay(track), wet)
  track.monitor = null
  assert.equal(takeToPlay(track), dry)
})
