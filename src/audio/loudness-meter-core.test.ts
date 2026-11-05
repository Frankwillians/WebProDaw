/**
 * Tests for the audio-thread loudness meter - run with `npm test`.
 *
 * The browser registers `LoudnessMeterCore` by stringifying it, so the class has
 * to be right here, at 128-sample blocks and with the filter state carried from
 * block to block, rather than only in the one-pass measurement the export uses.
 * The important test is the last one: both implementations, fed the same audio,
 * have to print the same numbers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LoudnessMeterCore } from './loudness-meter-core.ts'
import {
  interpolationFilter,
  kWeighting,
  measureLoudness,
  measureTruePeak,
  LoudnessTracker,
} from './loudness.ts'

const RATE = 48000

function sine(frequency: number, amplitude: number, samples: number, phase = 0): Float64Array {
  const out = new Float64Array(samples)
  for (let i = 0; i < samples; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE + phase)
  }
  return out
}

/** Feed a signal to the meter in 128-sample blocks, the way a worklet does. */
function feed(
  core: LoudnessMeterCore,
  left: ArrayLike<number>,
  right: ArrayLike<number> | null,
  blockSize = 128,
) {
  const readings: ReturnType<LoudnessMeterCore['processBlock']>[] = []
  for (let start = 0; start < left.length; start += blockSize) {
    const chunkLeft = Float32Array.from(
      Array.from({ length: Math.min(blockSize, left.length - start) }, (_, i) => left[start + i]),
    )
    const chunkRight = right
      ? Float32Array.from(
          Array.from({ length: Math.min(blockSize, right.length - start) }, (_, i) => right[start + i]),
        )
      : null
    readings.push(core.processBlock(chunkLeft, chunkRight))
  }
  return readings.filter((reading) => reading !== null)
}

test('the worklet designs the same K-weighting as the offline measurement', () => {
  for (const rate of [48000, 44100, 96000]) {
    const core = new LoudnessMeterCore(rate)
    const [shelf, hpf] = kWeighting(rate)
    assert.deepEqual(core.designShelf(rate), shelf, `shelf at ${rate}`)
    assert.deepEqual(core.designHpf(rate), hpf, `high-pass at ${rate}`)
  }
})

test('the meter fills in the two stages, window first then three seconds', () => {
  const core = new LoudnessMeterCore(RATE)
  const first = feed(core, sine(1000, 0.1, 4800), sine(1000, 0.1, 4800))
  assert.equal(first.length, 0, 'a 100 ms tone cannot close the 400 ms window')

  const next = feed(core, sine(1000, 0.1, RATE), sine(1000, 0.1, RATE))
  assert.ok(next.length > 0, 'the window closes one second in')
  assert.ok(!Number.isFinite(next[next.length - 1].shortTermLufs), 'but three seconds have not been metered yet')

  const after = feed(core, sine(1000, 0.1, RATE * 4), sine(1000, 0.1, RATE * 4))
  const last = after[after.length - 1]
  assert.ok(last)
  assert.ok(Number.isFinite(last.shortTermLufs), 'short term is live after three seconds of windows')
})

test('a steady tone reads the same on the audio thread as offline', () => {
  // A sine at exactly -20 dBFS peak in both channels is -20.4 LUFS: +3.01 for
  // the second channel, +0.30 for the K-weighting at 1 kHz, -0.7 for alignment.
  const left = sine(1000, 0.1, RATE * 5)
  const right = sine(1000, 0.1, RATE * 5)
  const offline = measureLoudness([left, right], RATE)
  const live = feed(new LoudnessMeterCore(RATE), left, right)
  const last = live[live.length - 1]
  assert.ok(last)
  assert.ok(Math.abs(last.momentaryLufs - offline.momentaryMaxLufs) < 0.05)
  assert.ok(Math.abs(last.momentaryLufs - -20.4) < 0.2, `momentary ${last.momentaryLufs}`)
  assert.ok(Math.abs(last.shortTermLufs - -20.4) < 0.2, `short term ${last.shortTermLufs}`)
  assert.ok(Math.abs(last.peakDb - -20.0) < 0.1, `peak ${last.peakDb}`)
})

test('the short term follows a level change within three seconds', () => {
  const core = new LoudnessMeterCore(RATE)
  feed(core, sine(1000, 0.1, RATE * 4), sine(1000, 0.1, RATE * 4))
  const after = feed(core, sine(1000, 0.316228, RATE * 4), sine(1000, 0.316228, RATE * 4))
  const last = after[after.length - 1]
  assert.ok(last)
  // +10 dB of material, four seconds in: momentary is there and so is short term.
  assert.ok(Math.abs(last.momentaryLufs - -10.4) < 0.2, `momentary ${last.momentaryLufs}`)
  assert.ok(Math.abs(last.shortTermLufs - -10.4) < 0.6, `short term ${last.shortTermLufs}`)
})

test('silence reads -inf and takes the memory with it', () => {
  const core = new LoudnessMeterCore(RATE)
  feed(core, sine(1000, 0.1, RATE * 4), sine(1000, 0.1, RATE * 4))
  const zeros = new Float32Array(RATE * 6)
  const quiet = feed(core, zeros, zeros)
  const last = quiet[quiet.length - 1]
  assert.ok(last)
  assert.ok(!Number.isFinite(last.momentaryLufs), 'momentary must fall off the scale')
  assert.ok(!Number.isFinite(last.shortTermLufs), 'and the 3 s mean with it')
  assert.ok(!Number.isFinite(last.peakDb), `peak ${last.peakDb}`)
})

test('a mono lane meters without the stereo alignment offset', () => {
  const left = sine(1000, 0.0958, RATE * 4)
  const offline = measureLoudness([left], RATE)
  const live = feed(new LoudnessMeterCore(RATE), left, null)
  const last = live[live.length - 1]
  assert.ok(last)
  assert.ok(Math.abs(last.momentaryLufs - offline.integratedLufs) < 0.1)
})

test('the streaming tracker and the block meter are one measurement', () => {
  const left = sine(997, 0.12, RATE * 6, 0.7)
  const right = sine(251, 0.07, RATE * 6, 1.9)
  const tracker = new LoudnessTracker(RATE)
  const core = new LoudnessMeterCore(RATE)
  let lastLive: { momentaryLufs: number; shortTermLufs: number } | null = null
  let gates = 0
  for (let start = 0; start < left.length; start += 128) {
    const chunk = Math.min(128, left.length - start)
    const a = Float32Array.from(Array.from({ length: chunk }, (_, i) => left[start + i]))
    const b = Float32Array.from(Array.from({ length: chunk }, (_, i) => right[start + i]))
    tracker.push(a, b)
    const reading = core.processBlock(a, b)
    if (reading) {
      gates += 1
      lastLive = reading
    }
  }
  assert.equal(core.processBlock(new Float32Array(0), null), null, 'an empty block closes nothing')
  const fromTracker = tracker.reading()
  assert.ok(fromTracker && lastLive)
  assert.ok(gates > 40, `expected a reading every 100 ms, got ${gates}`)
  assert.ok(Math.abs(fromTracker.momentaryLufs - lastLive.momentaryLufs) < 0.02, 'both window meters agree')
  assert.ok(Math.abs(fromTracker.shortTermLufs - lastLive.shortTermLufs) < 0.02, 'and so do the three second means')
})

test('the worklet interpolates with the offline filter, tap for tap', () => {
  // The live meter and the export report have to be the same instrument. These
  // two kernels are written twice, on purpose - once as a class that can be
  // stringified into an AudioWorklet, once as a module function - so the only
  // thing keeping them honest is this comparison.
  const core = new LoudnessMeterCore(RATE)
  const offline = interpolationFilter()
  assert.equal(core.kernel.length, offline.length)
  for (let phase = 0; phase < offline.length; phase += 1) {
    assert.equal(core.kernel[phase].length, offline[phase].length, `phase ${phase} length`)
    for (let t = 0; t < offline[phase].length; t += 1) {
      assert.ok(
        Math.abs(core.kernel[phase][t] - offline[phase][t]) < 1e-12,
        `phase ${phase} tap ${t}: ${core.kernel[phase][t]} vs ${offline[phase][t]}`,
      )
    }
  }
})

test('the live true peak reads the overshoot the export reports', () => {
  // Crest placed exactly between two samples: the samples top out at -0.69 dBFS
  // and the wave itself reaches 0 dBTP. Fed in 128-sample blocks, the meter has
  // to find the same number, or the on-screen peak is a different peak.
  const wave = sine(RATE / 8, 1, RATE * 2, (3 * Math.PI) / 8)
  const core = new LoudnessMeterCore(RATE)
  const readings = feed(core, wave, wave)
  const last = readings[readings.length - 1]
  assert.ok(last)
  const offlineDbtp = measureTruePeak([wave])
  assert.ok(Math.abs(last.truePeakDb - offlineDbtp) < 0.05, `live ${last.truePeakDb} vs file ${offlineDbtp}`)
  assert.ok(Math.abs(last.truePeakDb) < 0.1, `expected about 0 dBTP, got ${last.truePeakDb}`)
  assert.ok(last.truePeakDb > last.peakDb + 0.5, 'and it must beat the sample peak')
})

test('a crest that lands on a sample is not inflated', () => {
  const wave = sine(1000, Math.pow(10, -6 / 20), RATE * 2, Math.PI / 2)
  const core = new LoudnessMeterCore(RATE)
  const readings = feed(core, wave, wave)
  const last = readings[readings.length - 1]
  assert.ok(last)
  assert.ok(Math.abs(last.peakDb + 6) < 0.05, `sample peak read ${last.peakDb}`)
  assert.ok(Math.abs(last.truePeakDb + 6) < 0.08, `true peak read ${last.truePeakDb}`)
})

test('silence has no live true peak either', () => {
  const core = new LoudnessMeterCore(RATE)
  const blank = new Float64Array(RATE * 4)
  const readings = feed(core, blank, blank)
  const last = readings[readings.length - 1]
  assert.ok(last)
  assert.equal(last.truePeakDb, Number.NEGATIVE_INFINITY)
  assert.equal(last.peakDb, Number.NEGATIVE_INFINITY)
})
