/**
 * Tests for the BS.1770 / EBU R128 meter - run with `npm test`.
 *
 * These are the numbers a producer makes mix decisions with, so they are checked
 * against what the standard says a 1 kHz tone at -20 dBFS *must* read. The
 * tolerance is a few tenths of a LU: the filters are exact at 48 kHz and
 * re-designed elsewhere, and a meter that drifts by 1 LU is not a meter.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LoudnessTracker,
  interpolationFilter,
  measureLoudness,
  measureTruePeak,
} from './loudness.ts'

const SINE_LEVEL = -20.4

/** A sine of `seconds`, `amplitude` peak, optionally offset in time. */
function sine(sampleRate: number, seconds: number, amplitude: number, frequency = 1000): Float64Array {
  const out = new Float64Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return out
}

/** `seconds` of silence with one sine burst inside it. */
function burst(
  sampleRate: number,
  seconds: number,
  from: number,
  length: number,
  amplitude: number,
): Float64Array {
  const out = new Float64Array(Math.round(seconds * sampleRate))
  const start = Math.round(from * sampleRate)
  const count = Math.round(length * sampleRate)
  for (let i = 0; i < count && start + i < out.length; i += 1) {
    out[start + i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / sampleRate)
  }
  return out
}

const amplitudeOf = (db: number): number => 10 ** (db / 20)

test('a 1 kHz tone at -20 dBFS reads the -20.4 LUFS the standard defines', () => {
  const tone = sine(48000, 5, amplitudeOf(-20))
  const report = measureLoudness([tone, tone], 48000)
  assert.ok(
    Math.abs(report.integratedLufs - SINE_LEVEL) < 0.2,
    `expected near ${SINE_LEVEL}, got ${report.integratedLufs}`,
  )
  assert.ok(Math.abs(report.peakDb + 20) < 0.01, `peak read ${report.peakDb}`)
  assert.ok(Math.abs(report.momentaryMaxLufs - SINE_LEVEL) < 0.2)
  assert.equal(report.durationSeconds, 5)
})

test('6 dB more gain is 6 LU more loudness', () => {
  const quiet = sine(48000, 4, amplitudeOf(-20))
  const loud = sine(48000, 4, amplitudeOf(-14))
  const difference =
    measureLoudness([loud, loud], 48000).integratedLufs -
    measureLoudness([quiet, quiet], 48000).integratedLufs
  assert.ok(Math.abs(difference - 6) < 0.05, `6 dB read ${difference} LU`)
})

test('digital silence is not a number', () => {
  const silence = new Float64Array(48000 * 3)
  const report = measureLoudness([silence, silence], 48000)
  assert.equal(report.integratedLufs, Number.NEGATIVE_INFINITY)
  assert.equal(report.momentaryMaxLufs, Number.NEGATIVE_INFINITY)
  assert.equal(report.peakDb, Number.NEGATIVE_INFINITY)
  assert.equal(report.loudnessRangeLu, 0)
  assert.equal(report.measuredWindows, 0)
})

test('gating: silence around a burst does not make the file look quiet', () => {
  const sampleRate = 48000
  const one = burst(sampleRate, 20, 8, 4, amplitudeOf(-20))
  const report = measureLoudness([one, one], sampleRate)
  // Without the -70 LUFS absolute gate this would read near -27: the silence
  // would be averaged in, and a 4 second drop would look like a quiet mix.
  assert.ok(
    Math.abs(report.integratedLufs - SINE_LEVEL) < 0.6,
    `expected near ${SINE_LEVEL}, got ${report.integratedLufs}`,
  )
  assert.ok(report.measuredWindows < 60, `measured ${report.measuredWindows} windows of 20 s`)
})

test('a steady tone has no loudness range', () => {
  const tone = sine(48000, 20, amplitudeOf(-18))
  const report = measureLoudness([tone, tone], 48000)
  assert.ok(report.loudnessRangeLu < 0.05, `steady tone read ${report.loudnessRangeLu} LU`)
})

test('a quiet verse and a loud chorus read as range', () => {
  const sampleRate = 48000
  const seconds = 30
  const left = new Float64Array(sampleRate * seconds)
  const half = sampleRate * 15
  const quiet = amplitudeOf(-30)
  const loud = amplitudeOf(-15)
  for (let i = 0; i < left.length; i += 1) {
    const value = (i < half ? quiet : loud) * Math.sin((2 * Math.PI * 1000 * i) / sampleRate)
    left[i] = value
  }
  const report = measureLoudness([left, left], sampleRate)
  assert.ok(report.loudnessRangeLu > 11, `15 LU of steps read ${report.loudnessRangeLu} LU`)
  assert.ok(report.loudnessRangeLu < 18, `15 LU of steps read ${report.loudnessRangeLu} LU`)
  assert.ok(
    Math.abs(report.momentaryMaxLufs + 15.4) < 0.4,
    `the chorus peak read ${report.momentaryMaxLufs}`,
  )
  // The -10 LU relative gate lets the loud half dominate, so integrated sits with
  // the chorus instead of in the middle: that is the whole point of gating.
  assert.ok(report.integratedLufs > -17, `integrated read ${report.integratedLufs}`)
  assert.ok(report.integratedLufs < -15, `integrated read ${report.integratedLufs}`)
})

test('a mono programme is not dual mono', () => {
  const sampleRate = 48000
  const one = sine(sampleRate, 5, amplitudeOf(-20))
  const mono = measureLoudness([one], sampleRate).integratedLufs
  const dual = measureLoudness([one, one], sampleRate).integratedLufs
  // One channel carries its power once; two carry it twice (+3.01 dB), and the
  // -0.7 dB alignment offset only applies when there is a second channel to
  // align with. So the same signal, sent to both speakers, reads 2.31 LU up.
  assert.ok(Math.abs(mono + 22.71) < 0.2, `mono read ${mono}`)
  assert.ok(Math.abs(dual - mono - 2.31) < 0.05, `mono/dual gap was ${dual - mono}`)
})

test('44.1 kHz agrees with the normative 48 kHz filters', () => {
  const at48 = measureLoudness([sine(48000, 5, amplitudeOf(-20))], 48000).integratedLufs
  const at441 = measureLoudness([sine(44100, 5, amplitudeOf(-20))], 44100).integratedLufs
  assert.ok(Math.abs(at48 - at441) < 0.4, `48k read ${at48}, 44.1k read ${at441}`)
})

test('streaming blocks measure the same programme as one pass', () => {
  const sampleRate = 48000
  const left = sine(sampleRate, 6, amplitudeOf(-18))
  const right = sine(sampleRate, 6, amplitudeOf(-12))
  const whole = measureLoudness([left, right], sampleRate)

  const tracker = new LoudnessTracker(sampleRate)
  for (let start = 0; start < left.length; start += 128) {
    const end = Math.min(left.length, start + 128)
    tracker.push(left.subarray(start, end), right.subarray(start, end))
  }
  const streamed = tracker.report()
  assert.ok(Math.abs(streamed.integratedLufs - whole.integratedLufs) < 1e-6)
  assert.equal(streamed.measuredWindows, whole.measuredWindows)
  assert.equal(streamed.durationSeconds, whole.durationSeconds)
})

test('a live meter shows momentary and short term on their own grids', () => {
  const sampleRate = 48000
  const tracker = new LoudnessTracker(sampleRate)
  const tone = sine(sampleRate, 1, amplitudeOf(-20))

  // Below one 400 ms window there is nothing to report, and the meter says so.
  tracker.push(tone.subarray(0, 1000), tone.subarray(0, 1000))
  assert.equal(tracker.reading().momentaryLufs, Number.NEGATIVE_INFINITY)

  const rest = tone.subarray(1000)
  tracker.push(rest, rest)
  const momentary = tracker.reading().momentaryLufs
  assert.ok(Math.abs(momentary - SINE_LEVEL) < 0.3, `first window read ${momentary}`)

  // Short term needs its 3 s; until then it is not a reading a meter may show.
  assert.equal(tracker.reading().shortTermLufs, Number.NEGATIVE_INFINITY)
  for (let block = 0; block < 5; block += 1) tracker.push(tone, tone)
  const shortTerm = tracker.reading().shortTermLufs
  assert.ok(Math.abs(shortTerm - SINE_LEVEL) < 0.3, `short term read ${shortTerm}`)
})

test('peak tracks the loudest sample of either channel', () => {
  const sampleRate = 48000
  const quiet = sine(sampleRate, 2, amplitudeOf(-20))
  const hot = sine(sampleRate, 2, amplitudeOf(-6))
  const report = measureLoudness([quiet, hot], sampleRate)
  assert.ok(Math.abs(report.peakDb + 6) < 0.01, `peak read ${report.peakDb}`)
})

/** A sine with a phase, so the crest can be placed between two samples. */
function shifted(sampleRate: number, seconds: number, amplitude: number, frequency: number, phase: number): Float64Array {
  const out = new Float64Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase)
  }
  return out
}

test('true peak equals sample peak when a crest lands on a sample', () => {
  const sampleRate = 48000
  // Quarter period at 1 kHz: one sample sits exactly on the crest.
  const onCrest = shifted(sampleRate, 2, amplitudeOf(-6), 1000, Math.PI / 2)
  const dbtp = measureTruePeak([onCrest])
  assert.ok(Math.abs(dbtp + 6) < 0.05, `true peak read ${dbtp}`)
})

test('true peak finds the level between the samples', () => {
  const sampleRate = 48000
  // A eighth-period sine (Nyquist/4) with its crest placed exactly halfway
  // between two samples, the worst case: the samples top out at sin(67.5 deg),
  // -0.69 dB below the wave that is actually playing. This is the overshoot a
  // converter after the file hears, and the reason dBTP is not dBFS.
  const between = shifted(sampleRate, 2, 1, sampleRate / 8, (3 * Math.PI) / 8)
  let samplePeak = 0
  for (let i = 0; i < between.length; i += 1) samplePeak = Math.max(samplePeak, Math.abs(between[i]))
  const samplePeakDb = 20 * Math.log10(samplePeak)
  const dbtp = measureTruePeak([between])
  assert.ok(Math.abs(samplePeakDb + 0.69) < 0.05, `sample peak read ${samplePeakDb}`)
  assert.ok(dbtp > samplePeakDb + 0.5, `no overshoot found: ${dbtp} vs ${samplePeakDb}`)
  assert.ok(Math.abs(dbtp) < 0.1, `true peak read ${dbtp}, expected about 0 dBTP`)
})

test('the interpolator is a real reconstructor, not a guess', () => {
  // Phase 0 must hand the sample back untouched, and the three inserted points
  // must land on the wave. This is the check that catches a kernel built with an
  // even tap count, which puts the half-sample phase between two taps and turns
  // the whole measurement into a copy of the samples it was meant to beat.
  const filter = interpolationFilter()
  assert.ok(filter.every((taps) => Math.abs(taps.reduce((a, b) => a + b, 0) - 1) < 1e-9))
  assert.ok(Math.abs(filter[0][6] - 1) < 1e-9 && Math.abs(filter[0][5]) < 1e-9)
  // The same eighth-period wave the peak test uses, as a pure function of the
  // tap position, so the filter is checked on its own and not through a buffer.
  const wave = (i: number) => Math.sin((Math.PI / 4) * i + (3 * Math.PI) / 8)
  let best = 0
  for (let i = 0; i < 4800; i += 1) best = Math.max(best, Math.abs(wave(i)))
  const crest = Math.max(...[1, 2, 3].map((phase) => {
    const taps = filter[phase]
    let sum = 0
    for (let t = 0; t < taps.length; t += 1) sum += taps[t] * wave(t - 6)
    return Math.abs(sum)
  }))
  assert.ok(Math.abs(crest - 1) < 0.001, `reconstructed the crest as ${crest}`)
  assert.ok(best < 0.93, `the samples alone should miss it: ${best}`)
})

test('silence has no true peak to report', () => {
  const blank = new Float64Array(48000)
  assert.equal(measureTruePeak([blank]), Number.NEGATIVE_INFINITY)
  const report = measureLoudness([blank, blank], 48000)
  assert.equal(report.truePeakDb, Number.NEGATIVE_INFINITY)
})

test('the report never claims a true peak below the samples', () => {
  const sampleRate = 48000
  const left = shifted(sampleRate, 2, amplitudeOf(-3), sampleRate / 8, Math.PI / 6)
  const right = sine(sampleRate, 2, amplitudeOf(-14), 320)
  const report = measureLoudness([left, right], sampleRate)
  assert.ok(report.truePeakDb >= report.peakDb, `${report.truePeakDb} < ${report.peakDb}`)
  assert.ok(Math.abs(report.truePeakDb - report.peakDb) < 2, 'and not by a fanciful margin either')
})
