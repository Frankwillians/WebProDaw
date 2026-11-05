/**
 * Loudness measurement, ITU-R BS.1770 / EBU R128, as pure data in - numbers out.
 *
 * Why this exists next to the peak meter: a peak meter only tells you that one
 * transient nearly clipped. Two mixes with the same peak can be 6 LU apart in
 * how loud they *feel*, and a master that reads -14 LUFS integrated is what a
 * streaming service expects. This module measures the thing the ear follows.
 *
 * The chain is the standard's: K-weighting (a high shelf that adds the +4 dB
 * the ear is missing above 2 kHz, then the RLB high-pass that takes away the
 * LF energy that does not contribute to loudness), mean square per channel over
 * a 400 ms window that slides 100 ms at a time, the -0.7 dB stereo alignment
 * offset, and then gating - silence is not allowed to make a programme look
 * quiet, and material 10 LU under the average is not allowed to make it look
 * loud.
 *
 * The tracker is streaming: blocks go in, windows come out. The same code
 * measures a finished offline render (push the whole buffer) and a bus that is
 * playing right now (push what the audio thread hands over), so a live meter
 * and an export report cannot disagree.
 *
 * Self-contained on purpose (no imports), so `node --test` can load it directly.
 */

/** A normalized biquad: b0, b1, b2, a1, a2 (a0 divided out). */
export type Biquad = [number, number, number, number, number]

/**
 * The normative coefficients, for the 48 kHz the standard was written at: high
 * shelf (f0 = 1681.97 Hz, +4 dB, Q = 0.707) and RLB high-pass (38.13 Hz).
 */
const SHELF_48: Biquad = [1.5351248, -2.698163, 1.1983909, -1.6906593, 0.7324808]
const HPF_48: Biquad = [1.0, -2.0, 1.0, -1.9900475, 0.9900723]

/** The same two stages, designed for any other sample rate. */
function highShelf(sampleRate: number, f0: number, gainDb: number, q: number): Biquad {
  const a = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosine = Math.cos(w0)
  const stretch = 2 * Math.sqrt(a) * alpha
  const b0 = a * (a + 1 + (a - 1) * cosine + stretch)
  const b1 = -2 * a * (a - 1 + (a + 1) * cosine)
  const b2 = a * (a + 1 + (a - 1) * cosine - stretch)
  const a0 = a + 1 - (a - 1) * cosine + stretch
  const a1 = 2 * (a - 1 - (a + 1) * cosine)
  const a2 = a + 1 - (a - 1) * cosine - stretch
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

function highPass(sampleRate: number, f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosine = Math.cos(w0)
  const b0 = (1 + cosine) / 2
  const b1 = -(1 + cosine)
  const b2 = (1 + cosine) / 2
  const a0 = 1 + alpha
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cosine) / a0, (1 - alpha) / a0]
}

/**
 * K-weighting for the context that will use it. 48 kHz gets the standard's own
 * numbers; anything else gets the same filters re-designed from their f0 / gain
 * / Q, which agrees with them to a couple of tenths of a dB - accurate enough
 * for a mix decision, and worth knowing if you master at 44.1 kHz.
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  if (Math.abs(sampleRate - 48000) < 1) return [SHELF_48, HPF_48]
  return [
    highShelf(sampleRate, 1681.97445, 4, 0.70717523),
    highPass(sampleRate, 38.13485, 0.5010523),
  ]
}

/** One biquad with its own memory, so a block can end mid-window. */
class BiquadStage {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(coefficients: Biquad) {
    this.b0 = coefficients[0]
    this.b1 = coefficients[1]
    this.b2 = coefficients[2]
    this.a1 = coefficients[3]
    this.a2 = coefficients[4]
  }

  process(input: number): number {
    const output =
      this.b0 * input +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = input
    this.y2 = this.y1
    this.y1 = output
    return output
  }
}

/** A K-weighted channel: shelf, then the RLB high-pass. */
class WeightedChannel {
  private readonly shelf: BiquadStage
  private readonly hpf: BiquadStage

  constructor(shelf: Biquad, hpf: Biquad) {
    this.shelf = new BiquadStage(shelf)
    this.hpf = new BiquadStage(hpf)
  }

  /** The squared value the window wants, already weighted. */
  power(input: number): number {
    const value = this.hpf.process(this.shelf.process(input))
    return value * value
  }
}

export function dbFromPower(meanSquare: number): number {
  // -Infinity for silence: log(0) is not a number a meter should pretend to be.
  return meanSquare > 0 ? 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY
}

/**
 * One gated window per measurement: 400 ms of audio, advanced 100 ms. The step,
 * not the window, is what "momentary" and "short term" are built from.
 */
export interface LoudnessReport {
  /** Integrated programme loudness in LUFS; -Infinity for a silent file. */
  integratedLufs: number
  /** Loudest 400 ms window, in LUFS. */
  momentaryMaxLufs: number
  /** EBU Tech 3342 loudness range in LU: how much the level actually moves. */
  loudnessRangeLu: number
  /** Sample peak in dBFS: what the numbers in the file reach. */
  peakDb: number
  /**
   * True peak in dBTP: what the converter after the file hears between the
   * samples. Measured by four-times oversampling with an interpolation filter
   * (see `measureTruePeak`), which is what the standards ask for; this is the
   * number that keeps a master from clipping on a phone.
   */
  truePeakDb: number
  /** Measured duration in seconds. */
  durationSeconds: number
  /** Windows above the -70 LUFS floor, i.e. the ones the gate actually looked at. */
  measuredWindows: number
}

const WINDOW_SECONDS = 0.4
const STEP_SECONDS = 0.1
const SHORT_TERM_SECONDS = 3
const ABSOLUTE_GATE = -70
const INTEGRATED_RELATIVE_GATE = -10
const RANGE_RELATIVE_GATE = -20

/** A single reading, for a meter that updates while the mix plays. */
export interface LoudnessReading {
  /** Last 400 ms in LUFS; -Infinity until a full window has been fed. */
  momentaryLufs: number
  /** Last 3 s power mean in LUFS; -Infinity until 3 s have been fed. */
  shortTermLufs: number
  /** Loudest sample seen so far, in dBFS. */
  peakDb: number
}

/**
 * Streaming BS.1770 meter. Feed it blocks of any size - a 128-sample render
 * quantum or a whole rendered buffer - and read the windows as they complete.
 */
export class LoudnessTracker {
  readonly sampleRate: number

  private readonly windowSize: number
  private readonly stepSize: number
  private readonly shortTermWindows: number
  private readonly leftChannel: WeightedChannel
  private readonly rightChannel: WeightedChannel

  /** The last `windowSize` weighted squares per channel, so the sum slides. */
  private readonly ringLeft: Float64Array
  private readonly ringRight: Float64Array
  private ringPosition = 0
  private sumLeft = 0
  private sumRight = 0

  /** The last `shortTermWindows` momentary powers, for the short-term mean. */
  private readonly powerRing: Float64Array
  private powerPosition = 0
  private powerCount = 0
  private powerSum = 0

  private samplesUntilWindow: number
  private samplesFed = 0
  private mode: 'stereo' | 'mono' | null = null

  private readonly moments: number[] = []
  private readonly shorts: Array<{ lufs: number; endTime: number }> = []
  private momentary = Number.NEGATIVE_INFINITY
  private shortTerm = Number.NEGATIVE_INFINITY
  private momentaryMax = Number.NEGATIVE_INFINITY
  private peak = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.windowSize = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate))
    this.stepSize = Math.max(1, Math.round(STEP_SECONDS * sampleRate))
    this.shortTermWindows = Math.max(1, Math.round(SHORT_TERM_SECONDS / STEP_SECONDS))
    const [shelf, hpf] = kWeighting(sampleRate)
    this.leftChannel = new WeightedChannel(shelf, hpf)
    this.rightChannel = new WeightedChannel(shelf, hpf)
    this.ringLeft = new Float64Array(this.windowSize)
    this.ringRight = new Float64Array(this.windowSize)
    this.powerRing = new Float64Array(this.shortTermWindows)
    // The first gate completes one full window after the start; from there they
    // step, which is the momentary / short-term grid the standard defines.
    this.samplesUntilWindow = this.windowSize
  }

  /**
   * Measure a block. Leaving `right` out means a mono programme, which BS.1770
   * weights once and without the stereo offset - one channel is not two.
   */
  push(left: ArrayLike<number>, right?: ArrayLike<number>): void {
    if (this.mode === null) this.mode = right === undefined ? 'mono' : 'stereo'
    const stereo = this.mode === 'stereo'
    const rightBlock = right ?? left

    for (let i = 0; i < left.length; i += 1) {
      const sample = left[i] ?? 0
      const weightedLeft = this.leftChannel.power(sample)
      this.sumLeft += weightedLeft - this.ringLeft[this.ringPosition]
      this.ringLeft[this.ringPosition] = weightedLeft

      if (stereo) {
        const other = rightBlock[i] ?? 0
        const weightedRight = this.rightChannel.power(other)
        this.sumRight += weightedRight - this.ringRight[this.ringPosition]
        this.ringRight[this.ringPosition] = weightedRight
        const absolute = Math.abs(other)
        if (absolute > this.peak) this.peak = absolute
      }

      const absolute = Math.abs(sample)
      if (absolute > this.peak) this.peak = absolute

      this.samplesFed += 1
      this.ringPosition += 1
      if (this.ringPosition === this.windowSize) this.ringPosition = 0

      this.samplesUntilWindow -= 1
      if (this.samplesUntilWindow === 0) {
        this.samplesUntilWindow = this.stepSize
        this.closeWindow(stereo)
      }
    }
  }

  /**
   * One gate over the window that just finished: the mean square of each
   * channel, summed (stereo) or alone (mono), minus the alignment offset.
   */
  private closeWindow(stereo: boolean): void {
    const meanLeft = this.sumLeft / this.windowSize
    const meanRight = this.sumRight / this.windowSize
    const lufs = stereo ? dbFromPower(meanLeft + meanRight) - 0.7 : dbFromPower(meanLeft)
    // -70 LUFS is the floor the standard gates at and what every R128 meter
    // shows as -inf. It also keeps a filter's ringing tail - which is never
    // exactly zero - from counting as material.
    const audible = lufs > ABSOLUTE_GATE

    this.momentary = lufs
    if (audible) {
      this.moments.push(lufs)
      if (lufs > this.momentaryMax) this.momentaryMax = lufs
    }

    // Below the floor the window is silence, and silence is a real zero in the
    // short-term mean, not a skipped window.
    const power = audible ? 10 ** (lufs / 10) : 0
    this.powerSum += power - this.powerRing[this.powerPosition]
    this.powerRing[this.powerPosition] = power
    this.powerPosition += 1
    if (this.powerPosition === this.shortTermWindows) this.powerPosition = 0
    if (this.powerCount < this.shortTermWindows) this.powerCount += 1

    if (this.powerCount === this.shortTermWindows) {
      const value = dbFromPower(this.powerSum / this.shortTermWindows)
      this.shortTerm = value
      if (Number.isFinite(value)) {
        this.shorts.push({ lufs: value, endTime: this.samplesFed / this.sampleRate })
      }
    }
  }

  reading(): LoudnessReading {
    return {
      momentaryLufs: this.momentary,
      shortTermLufs: this.shortTerm,
      peakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : Number.NEGATIVE_INFINITY,
    }
  }

  /**
   * Integrated loudness and loudness range over everything fed so far.
   *
   * EBU Tech 3342 measures the range from short-term values with the first and
   * last five seconds (or ten per cent of the programme, whichever is bigger)
   * cut off, so a fade-in does not read as dynamics. Material too short to
   * survive that trim is measured whole rather than reported as no range.
   */
  /**
   * The programme the blocks that were fed add up to. True peak is not here: a
   * streaming meter does not keep the audio, and dBTP is measured over the
   * samples themselves - which `measureLoudness`, holding the whole buffer, does.
   */
  report(): Omit<LoudnessReport, 'truePeakDb'> {
    const durationSeconds = this.samplesFed / this.sampleRate
    const skip = Math.max(5, durationSeconds * 0.1)
    const trimmed = this.shorts
      .filter((entry) => entry.endTime > skip && entry.endTime <= durationSeconds - skip)
      .map((entry) => entry.lufs)
    const pool = trimmed.length >= 2 ? trimmed : this.shorts.map((entry) => entry.lufs)
    const range = gateValues(pool, RANGE_RELATIVE_GATE)
    const sorted = [...range].sort((a, b) => a - b)
    const loudnessRange =
      sorted.length > 2 ? Math.max(0, percentile(sorted, 0.95) - percentile(sorted, 0.1)) : 0

    return {
      integratedLufs: loudnessOf(gateValues(this.moments, INTEGRATED_RELATIVE_GATE)),
      momentaryMaxLufs: this.momentaryMax,
      loudnessRangeLu: loudnessRange,
      peakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : Number.NEGATIVE_INFINITY,
      durationSeconds,
      measuredWindows: this.moments.length,
    }
  }
}

/**
 * The two-pass gate the standard asks for: keep everything above -70 LUFS, take
 * the loudness of what is left, then keep only what is above that average minus
 * `relative`. Returns the surviving windows.
 */
function gateValues(values: number[], relative: number): number[] {
  const first = values.filter((value) => value > ABSOLUTE_GATE)
  if (first.length === 0) return []
  const reference = loudnessOf(first)
  const second = first.filter((value) => value > reference + relative)
  return second.length > 0 ? second : first
}

/** Power mean of a set of windows, in LUFS - the loudness of the group. */
function loudnessOf(values: number[]): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY
  let sum = 0
  for (const value of values) sum += 10 ** (value / 10)
  return sum > 0 ? 10 * Math.log10(sum / values.length) : Number.NEGATIVE_INFINITY
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NEGATIVE_INFINITY
  const at = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * fraction))
  const low = Math.floor(at)
  const high = Math.ceil(at)
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

/**
 * Measure a whole programme at once. `channels` is the list of channel arrays;
 * only the first two matter, which is all a stereo mix has.
 */
export function measureLoudness(channels: ArrayLike<number>[], sampleRate: number): LoudnessReport {
  const tracker = new LoudnessTracker(sampleRate)
  const left = channels[0]
  const right = channels[1]
  const length = left ? left.length : 0
  const chunk = 16384
  for (let start = 0; start < length; start += chunk) {
    const end = Math.min(length, start + chunk)
    if (right) tracker.push(view(left, start, end), view(right, start, end))
    else tracker.push(view(left, start, end))
  }
  return { ...tracker.report(), truePeakDb: measureTruePeak(channels) }
}

/** Four times oversampling, the ratio BS.1770-4 asks for. */
const OVERSAMPLE = 4
/**
 * Taps per phase - and it has to be an odd number.
 *
 * With an odd count the middle tap sits on a whole sample, so every inserted
 * point is a fraction of a sample away from a real one and the sinc sees it. An
 * even count puts the half-sample phase exactly between two taps, which turns
 * that phase into a copy of a sample that does not exist and silently throws the
 * whole overshoot away. Long enough to stop the image, short enough to stay
 * cheap.
 */
const PHASE_TAPS = 13

/**
 * The interpolation kernel, one branch per inserted point.
 *
 * Each phase is the sinc of its own fractional delay, windowed (Blackman) so the
 * truncation cannot add ringing of its own, and normalized so a steady signal
 * stays steady. Phase 0 is the original sample - the filter cannot move what is
 * already there.
 */
export function interpolationFilter(): number[][] {
  const phases: number[][] = []
  for (let phase = 0; phase < OVERSAMPLE; phase += 1) {
    const delay = phase / OVERSAMPLE
    const taps: number[] = []
    let total = 0
    for (let i = 0; i < PHASE_TAPS; i += 1) {
      const offset = i - (PHASE_TAPS - 1) / 2
      const x = offset - delay
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (PHASE_TAPS - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (PHASE_TAPS - 1))
      const value = sinc * window
      taps.push(value)
      total += value
    }
    phases.push(taps.map((value) => value / total))
  }
  return phases
}

let kernel: number[][] | null = null

/**
 * True-peak level in dBTP, by four-times oversampling.
 *
 * The filter works in samples, not hertz, so the sample rate is not part of it.
 * Only the neighbourhood of the loudest samples is interpolated: an overshoot
 * between two samples cannot pass them by more than a few tenths of a dB, so
 * anything six dB below the file's own peak is not the answer being looked for.
 * That keeps a four-minute master to a few thousand filter runs instead of
 * hundreds of millions.
 */
export function measureTruePeak(channels: ArrayLike<number>[]): number {
  const phases = kernel ?? (kernel = interpolationFilter())
  const half = (PHASE_TAPS - 1) / 2
  let peak = 0
  for (let channel = 0; channel < Math.min(2, channels.length); channel += 1) {
    const data = channels[channel]
    const length = data.length
    for (let i = 0; i < length; i += 1) {
      const value = Math.abs(data[i])
      if (value > peak) peak = value
    }
    if (peak === 0) continue
    const threshold = peak * 0.5
    for (let i = 0; i < length; i += 1) {
      const next = i + 1 < length ? Math.abs(data[i + 1]) : 0
      if (Math.abs(data[i]) < threshold && next < threshold) continue
      // The first and last few samples cannot be interpolated: part of the
      // window would hang off the end of the file, and dropping those taps
      // invents level that is not there. Their own value is still counted,
      // because the scan above already took the samples themselves.
      if (i - half < 0 || i + half >= length) continue
      for (let phase = 1; phase < OVERSAMPLE; phase += 1) {
        const taps = phases[phase]
        let sum = 0
        for (let t = 0; t < PHASE_TAPS; t += 1) {
          const index = i - half + t
          if (index < 0 || index >= length) continue
          sum += taps[t] * data[index]
        }
        if (Math.abs(sum) > peak) peak = Math.abs(sum)
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY
}

/**
 * A window over one channel without copying it: typed arrays (what a rendered
 * AudioBuffer hands out) have `subarray`; plain arrays, which tests use, slice.
 */
function view(channel: ArrayLike<number>, start: number, end: number): ArrayLike<number> {
  const typed = channel as { subarray?: (from: number, to: number) => ArrayLike<number> }
  if (typeof typed.subarray === 'function') return typed.subarray(start, end)
  return Array.prototype.slice.call(channel, start, end)
}
