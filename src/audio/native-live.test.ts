/**
 * Tests for the live native bridge - run with `npm test`.
 *
 * A .dll answers in the app's plugin process, and the audio thread has 128
 * samples to spend, so the bridge is built out of decisions rather than out of
 * audio: how big a batch is worth carrying, what a late reply costs, when a
 * plugin has stopped being worth asking, and which bytes actually cross the
 * process boundary. Those are all answerable without a browser, a plugin, or a
 * sound card, and they are the parts that decide whether the producer hears the
 * amp or hears nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIVE_BATCH,
  NATIVE_LIVE_PROCESSOR_NAME,
  NATIVE_LIVE_WORKLET_SOURCE,
  EMPTY_LIVE_STATS,
  audioMsPerBatch,
  canRunLive,
  liveLatencyMs,
  mergeLiveStats,
  pickLiveBatch,
  shouldGiveUp,
  toFloat32,
} from './native-live.ts'

test('a batch is always a whole number of quanta, sized to the rate', () => {
  for (const rate of [44100, 48000, 88200, 96000, 22050]) {
    assert.equal(pickLiveBatch(rate) % 128, 0, `${rate} Hz escolheu um bloco fora do quantum`)
    assert.ok(pickLiveBatch(rate) >= 128, `${rate} Hz escolheu menos de um bloco`)
    assert.ok(pickLiveBatch(rate) <= 2048, `${rate} Hz escolheu um bloco maior que o anel`)
  }
  // 11 ms at 48 kHz is 528 samples, which rounds to four quanta: 512.
  assert.equal(pickLiveBatch(48000), DEFAULT_LIVE_BATCH)
  assert.equal(pickLiveBatch(96000), 1024)
})

test('a batch says how much music it carries, and what the trip costs', () => {
  assert.ok(Math.abs(audioMsPerBatch(48000, 512) - 10.6667) < 0.001)
  assert.equal(audioMsPerBatch(0, 512), 0)
  assert.equal(audioMsPerBatch(48000, 0), 0)
  // In and out, one batch each way, plus the hop: ~24 ms at 48 kHz/512.
  assert.equal(liveLatencyMs(48000, 512, 3), 24)
  assert.ok(liveLatencyMs(48000) > 0, 'a latência ao vivo tem que ser dita, não escondida')
})

test('float32 survives every shape the process boundary can hand back', () => {
  const source = new Float32Array([1, -2, 0.5, 0.25])

  // Electron: a Buffer over its own memory.
  const asBuffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  assert.deepEqual([...toFloat32(asBuffer) ?? new Float32Array(0)], [...source])

  // A plain Node fork: {type:'Buffer', data:[...]}.
  assert.deepEqual([...toFloat32(JSON.parse(JSON.stringify(asBuffer))) ?? new Float32Array(0)], [...source])

  // A Float32Array that never had to be converted at all.
  assert.equal(toFloat32(source), source)

  // The nasty one: a view at an offset that is not a multiple of four. A Float32Array
  // taken over it in place throws; copying is what makes it readable.
  const pool = new Uint8Array(source.byteLength + 1)
  pool.set(new Uint8Array(source.buffer), 1)
  const misaligned = pool.subarray(1)
  const recovered = toFloat32(misaligned)
  assert.deepEqual([...(recovered ?? new Float32Array(0))], [...source])

  assert.equal(toFloat32(null), null)
  assert.equal(toFloat32('não é áudio'), null)
  assert.equal(toFloat32(new Float32Array(0))?.length ?? 0, 0)
})

test('a partial report cannot erase what the audio thread already counted', () => {
  const counted = { ...EMPTY_LIVE_STATS, quanta: 512, batches: 40, underruns: 3 }
  assert.deepEqual(mergeLiveStats(counted, { answered: 37 }), {
    ...counted,
    answered: 37,
  })
  assert.equal(mergeLiveStats(counted, null), counted)
  // A field that arrived as text or NaN is not a number the panel may show.
  assert.equal(mergeLiveStats(counted, { drops: Number.NaN }).drops, counted.drops)
})

test('a plugin that stops answering is given up on, a plugin that is merely late is not', () => {
  assert.equal(shouldGiveUp(1, { ok: false, late: true }), false, 'uma resposta atrasada é um soluço')
  assert.equal(shouldGiveUp(2, { ok: false, late: true }), false)
  assert.equal(shouldGiveUp(3, { ok: false, late: true }), true, 'três atrasos seguidos são uma cadeia quebrada')
  assert.equal(shouldGiveUp(1, { ok: false, error: 'sem sessão' }), true, 'um "não" do plugin é definitivo')
  assert.equal(shouldGiveUp(9, { ok: true }), false, 'um plugin que respondeu está bem')
  assert.equal(shouldGiveUp(1, null), false, 'sem resposta ainda não é resposta')
})

test('only a VST2 that is switched on and has a file goes in the live path', () => {
  assert.equal(canRunLive({ path: 'C:/vst/Ratatouillevst.dll', kind: 'vst2' }), true)
  assert.equal(canRunLive({ path: 'C:/vst/Ratatouillevst.dll', kind: 'vst2', bypass: true }), false)
  // A .vst3 is honestly excluded rather than silently dry: the panel says so.
  assert.equal(canRunLive({ path: 'C:/vst/Gateway.vst3', kind: 'vst3' }), false)
  assert.equal(canRunLive({ path: 'C:/vst/Gateway.vst3' }), false)
  assert.equal(canRunLive({ path: '', kind: 'vst2' }), false)
  assert.equal(canRunLive(null), false)
})

test('the worklet registers under the name the page asks for', () => {
  // A name that drifts apart from the constant is a silent failure: the node is
  // never created, and the lane just stays dry forever.
  const match = /registerProcessor\(\s*'([^']+)'/.exec(NATIVE_LIVE_WORKLET_SOURCE)
  assert.equal(match?.[1], NATIVE_LIVE_PROCESSOR_NAME)
  assert.match(NATIVE_LIVE_WORKLET_SOURCE, /class RingBuffer/)
  // The two promises the module makes: bypass when there is no session, and the
  // dry input when an answer was late — never silence.
  assert.match(NATIVE_LIVE_WORKLET_SOURCE, /if \(!this\.live\)/)
  assert.match(NATIVE_LIVE_WORKLET_SOURCE, /stats\.underruns \+= 1/)
})
