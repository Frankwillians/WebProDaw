/**
 * Tests for the mix math - run with `npm test`.
 *
 * These are the numbers the DAW promises the producer: what a dB readout means,
 * how long a clip plays, what a drawn fade does to the signal, and that the FX
 * curves stay bounded. The live graph and the offline export both read these
 * functions, so if they are right here, the file you export cannot disagree with
 * what you heard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_MAX_DB,
  AUTO_MIN_DB,
  autoDbToY,
  automationGainAt,
  automationNodeGain,
  autoYToDb,
  clampRange,
  clipEnd,
  dbToGain,
  fadeGainAt,
  formatDb,
  gainToDb,
  gateCurve,
  normalizeDuckSources,
  overdriveCurve,
  saturationCurve,
  sameIdList,
  sortedAutomation,
} from './mix-math.ts'

// ------------------------------------------------------------------ dB

test('0 dB is unity gain and -6 dB is half amplitude', () => {
  assert.equal(dbToGain(0), 1)
  assert.ok(Math.abs(dbToGain(-6.0206) - 0.5) < 0.0001)
  assert.equal(dbToGain(6), Math.pow(10, 0.3))
})

test('gain staging never produces NaN or negative gain', () => {
  for (const db of [-120, -60, -24, 0, 12]) {
    const gain = dbToGain(db)
    assert.ok(gain >= 0 && gain <= 10, `dbToGain(${db}) = ${gain}`)
  }
  assert.equal(dbToGain(Number.NaN), 0)
  assert.equal(dbToGain(Number.POSITIVE_INFINITY), 0)
})

test('anything at or below -60 dB is treated as silence', () => {
  assert.equal(dbToGain(-60), 0)
  assert.equal(dbToGain(-999), 0)
})

test('dB and linear gain are exact inverses', () => {
  for (const db of [-59, -40, -18, -6, -1, 0, 6, 12, 24]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-9, `round trip failed at ${db}`)
  }
})

test('meters floor instead of printing -Infinity', () => {
  assert.equal(gainToDb(0), -60)
  assert.equal(gainToDb(0.00001), -60)
  assert.equal(formatDb(gainToDb(0)), '-inf')
  assert.equal(formatDb(0), '0.0')
  assert.equal(formatDb(-1.5), '-1.5')
  assert.equal(formatDb(3), '+3.0')
  assert.equal(formatDb(Number.NaN), '-inf')
})

// ---------------------------------------------------------------- clip length

test('a clip with no stored duration plays the whole buffer', () => {
  assert.equal(clipEnd(0, 3.25), 3.25)
  assert.equal(clipEnd(-1, 3.25), 3.25)
})

test('a trimmed clip stops where the user dragged, never past the sample', () => {
  assert.equal(clipEnd(1.5, 3.25), 1.5)
  assert.equal(clipEnd(9, 3.25), 3.25)
})

test('a clip on a missing buffer has nothing to play', () => {
  assert.equal(clipEnd(2, 0), 0)
  assert.equal(clipEnd(0, 0), 0)
})

// ------------------------------------------------------------------ fades

test('a fade-in starts silent and reaches unity', () => {
  assert.equal(fadeGainAt(0, 4, 1, 0), 0)
  assert.ok(fadeGainAt(0.5, 4, 1, 0) > 0.49)
  assert.ok(fadeGainAt(0.5, 4, 1, 0) < 0.51)
  assert.equal(fadeGainAt(1, 4, 1, 0), 1)
  assert.equal(fadeGainAt(3.4, 4, 1, 0), 1)
})

test('a fade-out is a straight line down and never fully divides by zero', () => {
  assert.equal(fadeGainAt(3, 4, 0, 1), 1)
  assert.ok(Math.abs(fadeGainAt(3.5, 4, 0, 1) - 0.5) < 0.001)
  const last = fadeGainAt(4, 4, 0, 1)
  assert.ok(last > 0, 'the tail must not be exactly zero')
  assert.ok(last < 0.001, 'but it must be inaudible')
})

test('fades never exceed unity and never go negative', () => {
  for (let t = 0; t <= 4; t += 0.05) {
    const g = fadeGainAt(t, 4, 1.2, 1.4)
    assert.ok(g >= 0 && g <= 1, `fade gain out of range at ${t}: ${g}`)
  }
})

test('a fade is monotonically up at the head and down at the tail', () => {
  let previous = -1
  for (let t = 0; t <= 1; t += 0.02) {
    const g = fadeGainAt(t, 4, 1, 0)
    assert.ok(g >= previous - 1e-9, 'fade-in must not dip')
    previous = g
  }
  previous = 2
  for (let t = 3; t <= 4; t += 0.02) {
    const g = fadeGainAt(t, 4, 0, 1)
    assert.ok(g <= previous + 1e-9, 'fade-out must not rise')
    previous = g
  }
})

test('overlapping fades do not produce a gap or a bump', () => {
  // 1.5 s of fade on a 1 s clip: the fades have to share the clip, not fight.
  for (let t = 0; t <= 1; t += 0.05) {
    const g = fadeGainAt(t, 1, 0.8, 0.8)
    assert.ok(g >= 0 && g <= 1, `gain out of range at ${t}: ${g}`)
  }
  assert.equal(fadeGainAt(0, 1, 0.8, 0.8), 0)
})

test('no fade means the clip plays at unity', () => {
  assert.equal(fadeGainAt(0.3, 4, 0, 0), 1)
  assert.equal(fadeGainAt(3.9, 4, 0, 0), 1)
})

test('a fade on a zero-length clip is silence', () => {
  assert.equal(fadeGainAt(0, 0, 0.1, 0.1), 0)
})

/**
 * The engine draws this envelope with setValueAtTime / linearRampToValueAtTime
 * instead of evaluating fadeGainAt per sample. This mirrors WebAudio's event
 * list (a linear ramp interpolates from the value of the preceding event) so the
 * test proves the two agree - which is exactly the claim "the fade you drew is
 * the fade you exported".
 */
function simulateScheduledFade(
  playOffset: number,
  clipEndSeconds: number,
  fadeIn: number,
  fadeOut: number,
  samples: number[],
): number[] {
  const at = (clipTime: number) => Math.max(0, clipTime - playOffset)
  const g = (clipTime: number) => fadeGainAt(clipTime, clipEndSeconds, fadeIn, fadeOut)
  const fin = clampRange(fadeIn, 0, clipEndSeconds)
  const fout = clampRange(fadeOut, 0, Math.max(0, clipEndSeconds - fin))

  const events: Array<{ t: number; v: number; ramp: boolean }> = [
    { t: 0, v: g(playOffset), ramp: false },
  ]
  if (fin > 0.0005 && playOffset < fin) events.push({ t: at(fin), v: g(fin), ramp: true })
  if (fout > 0.0005) {
    const start = Math.max(playOffset, clipEndSeconds - fout)
    events.push({ t: at(start), v: g(start), ramp: false })
    events.push({ t: at(clipEndSeconds), v: g(clipEndSeconds), ramp: true })
  }

  return samples.map((clipTime) => {
    const t = at(clipTime)
    let k = 0
    for (let i = 0; i < events.length; i += 1) {
      if (events[i].t <= t + 1e-12) k = i
    }
    const current = events[k]
    const next = events[k + 1]
    if (next && next.ramp) {
      const span = next.t - current.t
      if (span > 0) return current.v + (next.v - current.v) * ((t - current.t) / span)
    }
    return current.v
  })
}

test('the scheduled ramps reproduce the fade curve exactly', () => {
  const times: number[] = []
  for (let t = 0.0; t <= 4.0001; t += 0.05) times.push(Number(t.toFixed(4)))
  const cases: Array<[number, number, number]> = [
    [4, 1, 0],
    [4, 0, 1],
    [4, 1, 1],
    [4, 2, 0.5],
    [4, 0, 0],
  ]
  for (const [end, fin, fout] of cases) {
    const scheduled = simulateScheduledFade(0, end, fin, fout, times)
    for (let i = 0; i < times.length; i += 1) {
      assert.ok(
        Math.abs(scheduled[i] - fadeGainAt(times[i], end, fin, fout)) < 1e-6,
        `fade ${fin}/${fout} diverges at ${times[i]}: ${scheduled[i]} vs ${fadeGainAt(times[i], end, fin, fout)}`,
      )
    }
  }
})

test('a loop point inside a fade-in resumes the ramp instead of restarting it', () => {
  const end = 4
  const fin = 2
  // Playback starts 1 s into the clip: it must already be at half gain.
  assert.ok(Math.abs(fadeGainAt(1, end, fin, 0) - 0.5) < 1e-9)
  const times = [1, 1.5, 2, 3]
  const scheduled = simulateScheduledFade(1, end, fin, 0, times)
  const expected = times.map((t) => fadeGainAt(t, end, fin, 0))
  for (let i = 0; i < times.length; i += 1) {
    assert.ok(Math.abs(scheduled[i] - expected[i]) < 1e-6, `mid-fade restart at ${times[i]}`)
  }
})

// ------------------------------------------------------------------ gate

test('the gate curve attenuates below the threshold by the range', () => {
  const size = 4096
  const range = 40
  const curve = gateCurve(-40, range, size)
  const indexFor = (x: number) => Math.round(((x + 1) / 2) * (size - 1))
  // A curve entry is only meaningful against the input value it was built for.
  const gainAt = (x: number) => {
    const i = indexFor(x)
    return curve[i] / ((i / (size - 1)) * 2 - 1)
  }

  // Well below the threshold the reduction is the full range.
  assert.ok(Math.abs(gainAt(-0.004) * Math.pow(10, range / 20) - 1) < 0.02)
  // Well above it, nothing is lost.
  assert.ok(Math.abs(gainAt(0.9) - 1) < 1e-6)
  assert.ok(Math.abs(gainAt(0.02) - 1) < 1e-6)
  // Half-way through the soft band the reduction is between the two.
  const middle = gainAt(0.009)
  assert.ok(middle > 0.011 && middle < 0.9, `soft band gain is ${middle}`)
})

test('the gate is odd-symmetric so it does not add DC or rectify', () => {
  const curve = gateCurve(-50, 60)
  // Index i and length-1-i map to exactly opposite input values.
  for (let i = 0; i < 60; i += 1) {
    const negative = curve[i]
    const positive = curve[curve.length - 1 - i]
    assert.ok(
      Math.abs(negative + positive) < 1e-6,
      `asymmetry at ${i}: ${negative} vs ${positive}`,
    )
  }
})

test('the gate crosses over smoothly - no click at the threshold', () => {
  const curve = gateCurve(-40, 40)
  let biggestJump = 0
  for (let i = 1; i < curve.length; i += 1) {
    biggestJump = Math.max(biggestJump, Math.abs(curve[i] - curve[i - 1]))
  }
  // A hard switch would jump by ~0.006 in a single sample here; a soft
  // expander stays well under that at full scale.
  assert.ok(biggestJump < 0.004, `largest single-sample jump is ${biggestJump}`)
})

test('a gate with zero range passes everything', () => {
  const curve = gateCurve(-40, 0)
  for (const x of [0.25, 0.5, 0.9]) {
    const index = Math.round(((x + 1) / 2) * (curve.length - 1))
    assert.ok(Math.abs(curve[index] - x) < 0.02, `${x} became ${curve[index]}`)
  }
})

test('gate thresholds are clamped out of the absurd', () => {
  const a = gateCurve(-500, 40)
  const b = gateCurve(-100, 40)
  assert.deepEqual(Array.from(a), Array.from(b))
  const c = gateCurve(20, 40)
  const d = gateCurve(0, 40)
  assert.deepEqual(Array.from(c), Array.from(d))
})

// -------------------------------------------------------------- saturation

test('the saturator is transparent at zero drive', () => {
  const curve = saturationCurve(0)
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1
    assert.ok(Math.abs(curve[i] - x) < 1e-6)
  }
})

test('the saturator stays bounded and keeps full scale at unity', () => {
  for (const drive of [0.2, 0.5, 1]) {
    const curve = saturationCurve(drive)
    let peak = 0
    for (let i = 1; i < curve.length; i += 1) {
      peak = Math.max(peak, Math.abs(curve[i]))
      // Soft clipping compresses, it never folds the signal back on itself.
      assert.ok(curve[i] >= curve[i - 1] - 1e-9, 'curve must keep rising with input')
    }
    assert.ok(peak <= 1.000001, `drive ${drive} peaks at ${peak}`)
    assert.ok(Math.abs(curve[curve.length - 1] - 1) < 1e-6, `drive ${drive} is not unity at full scale`)
  }
})

test('more drive means more gain at low level but never more than full scale', () => {
  const soft = saturationCurve(0.2)
  const hard = saturationCurve(1)
  for (const target of [0.05, 0.1, 0.2]) {
    const i = Math.round(((target + 1) / 2) * (soft.length - 1))
    assert.ok(Math.abs(hard[i]) > Math.abs(soft[i]), `drive 1 should push ${target} harder`)
    assert.ok(Math.abs(hard[i]) <= 1)
  }
})

// --------------------------------------------------------------- overdrive

test('the pedal overdrive is bounded, odd and unity at full scale', () => {
  const curve = overdriveCurve(0.5)
  assert.ok(Math.abs(curve[curve.length - 1] - 1) < 1e-6)
  assert.ok(Math.abs(curve[0] + 1) < 1e-6)
  for (let i = 0; i < 60; i += 1) {
    assert.ok(
      Math.abs(curve[i] + curve[curve.length - 1 - i]) < 1e-9,
      `asymmetry at ${i}: ${curve[i]} vs ${curve[curve.length - 1 - i]}`,
    )
  }
  for (const value of curve) assert.ok(Math.abs(value) <= 1.000001)
})

test('overdrive at zero drive is almost clean', () => {
  const curve = overdriveCurve(0)
  // k = 1, so tanh(x)/tanh(1) is a gentle soft clip, not a square wave.
  const i = Math.round(((0.2 + 1) / 2) * (curve.length - 1))
  assert.ok(curve[i] > 0.15 && curve[i] < 0.32, `small signal became ${curve[i]}`)
})

// ------------------------------------------------------------------ helpers

test('clampRange rejects junk instead of spreading it', () => {
  assert.equal(clampRange(5, 0, 1), 1)
  assert.equal(clampRange(-5, 0, 1), 0)
  assert.equal(clampRange(0.5, 0, 1), 0.5)
  assert.equal(clampRange(Number.NaN, 0.25, 1), 0.25)
  assert.equal(clampRange(Number.POSITIVE_INFINITY, 0, 10), 0)
})

// ------------------------------------------------------------------ automation

test('a lane with no points leaves the fader exactly alone', () => {
  for (const step of [0, 1, 7.5, 999]) assert.equal(automationGainAt([], step), 1)
})

test('the lane holds its level outside the outer breakpoints', () => {
  const points = [
    { step: 8, value: -6 },
    { step: 24, value: 0 },
  ]
  // Before the first point the song does not fade in from nothing: the level the
  // producer drew is what plays from bar one.
  assert.equal(automationGainAt(points, 0), dbToGain(-6))
  assert.equal(automationGainAt(points, 8), dbToGain(-6))
  assert.equal(automationGainAt(points, 400), 1)
})

test('a straight line drawn between two points is straight in dB', () => {
  const points = [
    { step: 0, value: -12 },
    { step: 16, value: 0 },
  ]
  for (let step = 0; step <= 16; step += 1) {
    const expected = -12 + (12 * step) / 16
    assert.ok(
      Math.abs(gainToDb(automationGainAt(points, step)) - expected) < 1e-9,
      `step ${step} is ${gainToDb(automationGainAt(points, step))} dB, expected ${expected}`,
    )
  }
})

test('segments interpolate piecewise, each between its own pair of points', () => {
  const points = [
    { step: 0, value: -6 },
    { step: 16, value: 0 },
    { step: 32, value: -12 },
  ]
  assert.ok(Math.abs(gainToDb(automationGainAt(points, 8)) + 3) < 1e-9)
  assert.ok(Math.abs(gainToDb(automationGainAt(points, 24)) + 6) < 1e-9)
  assert.ok(Math.abs(gainToDb(automationGainAt(points, 16)) - 0) < 1e-9)
})

/**
 * Mirrors what the engine actually schedules: `setValueAtTime` on every
 * breakpoint then `exponentialRampToValueAtTime` between them, because that is
 * the only way a WebAudio param can travel linearly in dB. The test proves the
 * scheduled envelope and the drawn envelope are the same curve, so a fade that
 * is heard is a fade that is exported.
 */
function scheduledLaneDb(
  points: Array<{ step: number; value: number }>,
  stepDuration: number,
  step: number,
): number {
  const times = points.map((point) => point.step * stepDuration)
  const gains = points.map((point) => automationNodeGain(point.value))
  if (step <= points[0].step) return gainToDb(gains[0])
  const last = points.length - 1
  if (step >= points[last].step) return gainToDb(gains[last])
  for (let i = 1; i < points.length; i += 1) {
    if (step * stepDuration > times[i]) continue
    const ratio = (step * stepDuration - times[i - 1]) / (times[i] - times[i - 1])
    return gainToDb(gains[i - 1] * Math.pow(gains[i] / gains[i - 1], ratio))
  }
  return gainToDb(gains[last])
}

test('the ramps the engine schedules are the lane that was drawn', () => {
  const points = [
    { step: 0, value: -6 },
    { step: 8, value: 3 },
    { step: 20, value: -18 },
    { step: 32, value: 0 },
  ]
  const stepDuration = 60 / 120 / 4
  for (let step = 0; step <= 32; step += 0.25) {
    const drawn = gainToDb(automationGainAt(points, step))
    const scheduled = scheduledLaneDb(points, stepDuration, step)
    assert.ok(Math.abs(drawn - scheduled) < 1e-6, `step ${step}: ${drawn} vs ${scheduled}`)
  }
})

test('an automation node never asks for a gain of zero', () => {
  // An exponential ramp cannot start or end at 0, and the engine schedules with
  // exponential ramps, so the floor is a hard requirement, not a preference.
  for (const db of [-60, -80, -600, Number.NEGATIVE_INFINITY]) {
    assert.ok(automationNodeGain(db) > 0, `${db} dB became ${automationNodeGain(db)}`)
  }
  assert.equal(automationNodeGain(-60), 0.0001)
  assert.ok(Math.abs(automationNodeGain(-6) - dbToGain(-6)) < 1e-12)
})

test('breakpoints are sorted and junk cannot reach the graph', () => {
  const clean = sortedAutomation([
    { step: Number.NaN, value: 0 },
    { step: -4, value: 0 },
    { step: 16, value: Number.NaN },
    { step: 24, value: -6 },
    { step: 8, value: 3 },
  ])
  assert.deepEqual(clean, [{ step: 8, value: 3 }, { step: 24, value: -6 }])
})

test('two points on the same step collapse to the one drawn last', () => {
  // The lane UI relies on this: a dragged point is re-appended last, so it is
  // always the survivor and never disappears under the cursor.
  assert.deepEqual(
    sortedAutomation([
      { step: 4, value: 0 },
      { step: 8, value: -12 },
      { step: 4, value: -3 },
    ]),
    [{ step: 4, value: -3 }, { step: 8, value: -12 }],
  )
})

// ---------------------------------------------------------------- lane scale

const LANE_H = 46

test('the lane puts the fader in the middle of its own height', () => {
  assert.equal(autoDbToY(0, LANE_H), LANE_H / 2)
  assert.equal(autoDbToY(AUTO_MAX_DB, LANE_H), 0)
  assert.equal(autoDbToY(AUTO_MIN_DB, LANE_H), LANE_H)
})

test('a point dragged to a height is the dB the lane was drawn with', () => {
  for (const db of [-60, -48, -30, -12, -6, -3, 0, 3, 6, 12]) {
    const back = autoYToDb(autoDbToY(db, LANE_H), LANE_H)
    assert.ok(Math.abs(back - db) < 1e-9, `${db} dB came back as ${back}`)
  }
})

test('the lane grabs the centre line instead of leaving a stray half dB', () => {
  // One pixel near the middle must not commit -0.5 dB, or a lane of "flat"
  // points ends up quietly dipping the track.
  for (const y of [22, 23, 24]) assert.equal(autoYToDb(y, LANE_H), 0)
  assert.equal(autoYToDb(0, LANE_H), AUTO_MAX_DB)
  assert.equal(autoYToDb(LANE_H, LANE_H), AUTO_MIN_DB)
})

test('the lane scale refuses to draw outside its own lane', () => {
  assert.equal(autoDbToY(999, LANE_H), 0)
  assert.equal(autoDbToY(-999, LANE_H), LANE_H)
  assert.equal(autoYToDb(-500, LANE_H), AUTO_MAX_DB)
  assert.equal(autoYToDb(500, LANE_H), AUTO_MIN_DB)
  assert.equal(autoDbToY(Number.NaN, LANE_H), LANE_H / 2)
})
test('the sidechain keeps the sources that can actually be heard', () => {
  const tracks = ['kick', 'bass', 'voice']
  assert.deepEqual(normalizeDuckSources(['kick', 'bass'], 'voice', tracks), ['kick', 'bass'])
  // Order is the order the producer added them, which is the order the mixer shows.
  assert.deepEqual(normalizeDuckSources(['bass', 'kick'], 'voice', tracks), ['bass', 'kick'])
})

test('a duck cannot follow itself, twice, or a track that is gone', () => {
  const tracks = ['kick', 'bass']
  // A track ducking on its own signal closes its own gate and chokes the fader.
  assert.deepEqual(normalizeDuckSources(['bass', 'bass'], 'bass', tracks), [])
  // The same source wired twice sums at the follower input and doubles the depth.
  assert.deepEqual(normalizeDuckSources(['kick', 'kick'], 'bass', tracks), ['kick'])
  // A stale id from a deleted track, or from an older project file.
  assert.deepEqual(normalizeDuckSources(['kick', 'ghost'], 'bass', tracks), ['kick'])
  assert.deepEqual(normalizeDuckSources(['', 'kick'], 'bass', tracks), ['kick'])
})

test('the engine only rebuilds a duck when the source list really moved', () => {
  assert.ok(sameIdList(['kick', 'bass'], ['kick', 'bass']))
  assert.ok(!sameIdList(['kick', 'bass'], ['bass', 'kick']), 'order is part of the claim')
  assert.ok(!sameIdList(['kick'], ['kick', 'bass']))
  assert.ok(sameIdList([], []))
  const same: string[] = []
  assert.ok(sameIdList(same, same))
})
