/**
 * Pure mix math shared by the live graph, the offline render and the tests.
 *
 * Nothing in here touches WebAudio: the engine asks these functions for numbers
 * and curves and then pushes them into nodes. That is what lets the exported
 * file and the monitors agree, and it keeps the interesting arithmetic
 * (`node --test src/audio/mix-math.test.ts`) checkable without a browser.
 */

/** -inf-safe dB → linear. Anything at or below -60 dB is treated as silence. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.pow(10, db / 20)
}

/** Linear → dB, floored at -60 so meters never print -Infinity. */
export function gainToDb(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0.0001) return -60
  return 20 * Math.log10(Math.max(0, gain))
}

/** Compact dB text for meters and knobs. */
export function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -59.5) return '-inf'
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

export function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * How much of the buffer actually plays. A clip with no stored length plays to
 * the end of the buffer; a trimmed clip stops where the user dragged, and may
 * never be allowed to run past the sample.
 */
export function clipEnd(clipDuration: number, bufferDuration: number): number {
  if (!(bufferDuration > 0)) return 0
  if (!(clipDuration > 0)) return bufferDuration
  return Math.min(clipDuration, bufferDuration)
}

/**
 * Gain a clip's edge-fade envelope has at `clipTime` seconds after the start of
 * the *clip*. The live scheduler reproduces exactly this piecewise line with
 * setValueAtTime / linearRampToValueAtTime (starting it at the point the
 * playback begins, so a loop that lands inside the fade-in resumes the ramp
 * instead of restarting it), and the offline render uses the same shape. A fade
 * you drew is therefore the fade you export.
 */
export function fadeGainAt(
  clipTime: number,
  clipEndSeconds: number,
  fadeIn: number,
  fadeOut: number,
): number {
  const end = Math.max(0, clipEndSeconds)
  if (!(end > 0)) return 0
  const t = clampRange(clipTime, 0, end)
  const fin = clampRange(fadeIn, 0, end)
  const fout = clampRange(fadeOut, 0, Math.max(0, end - fin))
  // Never fully silent at the very end: 0.0002 (-74 dBFS) is inaudible but keeps
  // meters and exponential ramps from dividing by zero.
  const floorLevel = 0.0002

  let gain = 1
  if (fin > 0.0005) gain = Math.min(gain, t / fin)
  if (fout > 0.0005 && t > end - fout) {
    gain = Math.min(gain, floorLevel + (1 - floorLevel) * ((end - t) / fout))
  }
  return clampRange(gain, 0, 1)
}

/**
 * Noise gate as a static downward expander: everything under the threshold is
 * pulled down by `rangeDb` instead of being switched off, which is what keeps
 * the crossover from clicking. Pure amplitude shaping, so it behaves identically
 * offline. No attack/hold/release is claimed — a static curve cannot have any.
 */
export function gateCurve(
  thresholdDb: number,
  rangeDb: number,
  size = 2048,
): Float32Array {
  const curve = new Float32Array(size)
  const th = Math.max(0.00001, dbToGain(clampRange(thresholdDb, -100, 0)))
  const floor = Math.max(0, dbToGain(-Math.abs(clampRange(rangeDb, 0, 96))))
  // Soft band around the threshold so the gain does not jump discontinuously.
  const lo = th * 0.75
  const hi = Math.min(1, th * 1.4)
  for (let i = 0; i < size; i += 1) {
    const x = (i / (size - 1)) * 2 - 1
    const abs = Math.abs(x)
    let gain: number
    if (abs <= lo) gain = floor
    else if (abs >= hi) gain = 1
    else gain = floor + (1 - floor) * ((abs - lo) / Math.max(0.00001, hi - lo))
    curve[i] = x * gain
  }
  return curve as Float32Array
}

/** A point on a drawn automation lane: song position in steps, level in dB. */
export interface AutomationBreakpoint {
  step: number
  value: number
}

/**
 * Gain an automation lane has at `step`. Points are connected by straight lines
 * in *dB* - which is what a drawn lane means and what a fader does - and the
 * first and last points hold outside the drawn range. No points means no change
 * to the fader, so unity.
 */
export function automationGainAt(
  points: AutomationBreakpoint[],
  step: number,
): number {
  if (points.length === 0) return 1
  const first = points[0]
  const last = points[points.length - 1]
  if (step <= first.step) return dbToGain(first.value)
  if (step >= last.step) return dbToGain(last.value)
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (step > b.step) continue
    const span = b.step - a.step
    const dB = span <= 0 ? b.value : a.value + ((b.value - a.value) * (step - a.step)) / span
    return dbToGain(dB)
  }
  return dbToGain(last.value)
}

/**
 * Gain the engine puts on an automation node for a dB value. Never zero: the
 * envelope is scheduled with exponential ramps (the only way a WebAudio param
 * can move linearly in dB), and an exponential ramp cannot start or end at 0.
 * Anything under -80 dB is silence anyway.
 */
export function automationNodeGain(db: number): number {
  return Math.max(0.0001, dbToGain(db))
}

/**
 * Breakpoints in song order, with junk removed. Two points on the same step are
 * collapsed to the later one so a ramp never has a zero-length span.
 */
export function sortedAutomation(points: AutomationBreakpoint[]): AutomationBreakpoint[] {
  const clean = points
    .filter(
      (point) =>
        point &&
        Number.isFinite(point.step) &&
        Number.isFinite(point.value) &&
        point.step >= 0,
    )
    .sort((a, b) => a.step - b.step)
  const out: AutomationBreakpoint[] = []
  for (const point of clean) {
    const previous = out[out.length - 1]
    if (previous && Math.abs(previous.step - point.step) < 1e-6) out[out.length - 1] = point
    else out.push(point)
  }
  return out
}

/**
 * Lane scale for a drawn volume envelope. Automation is relative to the fader,
 * so 0 dB means "leave it alone" and the neutral line is the middle of the lane.
 * The scale is piecewise-linear: the upper half carries 0..+12 dB, the lower
 * half 0..-60 dB. That gives the range you actually mix with real pixel
 * resolution while the deep fades stay reachable without spending most of the
 * lane on silence nobody needs to dial to a tenth of a dB.
 */
export const AUTO_MAX_DB = 12
export const AUTO_MIN_DB = -60

export function autoDbToY(db: number, height: number): number {
  const half = height / 2
  if (!Number.isFinite(db)) return half
  if (db >= 0) return half - (Math.min(db, AUTO_MAX_DB) / AUTO_MAX_DB) * half
  return half + (Math.min(-db, -AUTO_MIN_DB) / -AUTO_MIN_DB) * half
}

/**
 * Inverse of `autoDbToY`. A point within one pixel of the centre line is flat:
 * a pixel is the resolution a mouse has, and a lane of "flat" points that each
 * secretly carry -0.5 dB is not what anyone meant to draw.
 */
export function autoYToDb(y: number, height: number): number {
  const half = height / 2
  if (!Number.isFinite(y)) return 0
  const clamped = Math.min(height, Math.max(0, y))
  if (Math.abs(clamped - half) <= 1) return 0
  const db =
    clamped <= half
      ? ((half - clamped) / half) * AUTO_MAX_DB
      : -((clamped - half) / half) * -AUTO_MIN_DB
  const rounded = Math.round(db * 2) / 2
  return Math.abs(rounded) < 0.6 ? 0 : rounded
}

/**
 * unity at full scale, never exceeds 1, and adds mostly odd-order harmonics as
 * `drive` rises. `k` is derived from drive so 0 is transparent.
 */
export function saturationCurve(drive: number, size = 2048): Float32Array {
  const curve = new Float32Array(size)
  const k = clampRange(drive, 0, 1) * 9
  for (let i = 0; i < size; i += 1) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = (x * (1 + k)) / (1 + k * Math.abs(x))
  }
  return curve as Float32Array
}

/** Guitar-pedal overdrive: tanh with the slope folded into the drive. */
export function overdriveCurve(drive: number, size = 1024): Float32Array {
  const curve = new Float32Array(size)
  const k = 1 + clampRange(drive, 0, 1) * 60
  const normalizer = Math.tanh(k)
  for (let i = 0; i < size; i += 1) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / normalizer
  }
  return curve as Float32Array
}

/**
 * The sidechain sources a track should actually listen to, cleaned up.
 *
 * A duck can follow several tracks at once - the kick and the snare both pushing
 * the bass aside, say - so the request is a list rather than one id. The list is
 * still a producer's gesture, not a trusted instruction: a track cannot duck
 * itself (that would close the gate with its own signal and choke the fader),
 * an id repeated twice would wire the same source into the follower twice and
 * quietly double the depth, and a stale id left behind by a deleted track or an
 * older project file has no graph to read. The order survives, because the chips
 * in the mixer show them in the order they were added.
 */
export function normalizeDuckSources(
  wanted: readonly string[],
  ownId: string,
  knownIds: Iterable<string>,
): string[] {
  const known = new Set(knownIds)
  const out: string[] = []
  for (const id of wanted) {
    if (typeof id !== 'string' || id === '' || id === ownId) continue
    if (!known.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** Two id lists that mean the same thing: same ids, same order. */
export function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((id, index) => id === b[index])
}
