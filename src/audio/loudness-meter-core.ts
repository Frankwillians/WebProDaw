/**
 * The loudness meter that runs on the audio thread.
 *
 * A meter polled from JavaScript is only as good as the polling: a background
 * tab, or one frame that arrived late, drops part of the 400 ms window the
 * standard measures, and the number on screen then describes a different moment
 * than the one you heard. This class does the same job as the offline
 * measurement, but it is fed every sample by the worklet, so a window is never
 * missing anything.
 *
 * It is a `class` with no imports on purpose. The browser registers it by
 * turning this exact source into a string and evaluating it inside an
 * AudioWorklet, and `node --test` runs the very same class directly - which is
 * how the two implementations are kept in agreement rather than hoped to be.
 */

export interface MeterReading {
  /** Last 400 ms, in LUFS. -Infinity when it is under the -70 LUFS floor. */
  momentaryLufs: number
  /** Last 3 s, in LUFS; -Infinity until three seconds have been metered. */
  shortTermLufs: number
  /** Sample peak inside the last 400 ms window, in dBFS. */
  peakDb: number
  /**
   * True peak inside the same window, in dBTP: the level the converter hears
   * between two samples. This is the number that keeps a master from distorting
   * on a phone, and it is always at or above `peakDb`.
   */
  truePeakDb: number
}

export class LoudnessMeterCore {
  sampleRate: number
  /** Locked by the first block: a stereo pair or one mono channel. */
  stereo: boolean | null
  windowSize: number
  stepSize: number
  gatesShort: number
  shelf: number[]
  hpf: number[]
  /**
   * True peak is read from an interpolated copy of the signal: `oversample`
   * inserted points per sample, each built from `taps` samples. The tap count is
   * odd so the middle tap lands on a whole sample and the half-sample point is
   * really between two of them; an even count puts that phase exactly between
   * two taps and throws the overshoot away.
   *
   * Both are plain literals on the instance rather than imported constants
   * because the browser runs this class from its own source text. The offline
   * meter has its own copy, and a test compares the two filters tap for tap, so
   * the number on screen and the number written into the exported file cannot
   * drift apart.
   */
  oversample: number
  taps: number
  /** One branch per inserted point; branch 0 is the sample itself. */
  kernel: number[][]
  /** [x1, x2, y1, y2, nextIn1, nextIn2, z1, z2] per channel: the two cascaded stages. */
  stateL: number[]
  stateR: number[]
  ringL: Float32Array
  ringR: Float32Array
  blockPeaks: Float32Array
  /** The same ring, one entry per block, for the interpolated (true) peak. */
  tpPeaks: Float32Array
  /** The tail of the previous block: the window needs samples from both sides. */
  prevLeft: Float32Array
  prevRight: Float32Array
  powers: Float32Array
  ringIndex: number
  ringFilled: number
  sumL: number
  sumR: number
  peakIndex: number
  peakFilled: number
  blockPeak: number
  powerIndex: number
  powerFilled: number
  powerSum: number
  samplesUntilGate: number

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000
    this.stereo = null
    this.windowSize = Math.max(1, Math.round(0.4 * this.sampleRate))
    this.stepSize = Math.max(1, Math.round(0.1 * this.sampleRate))
    this.gatesShort = Math.max(1, Math.round(3 / 0.1))
    this.shelf = this.designShelf(this.sampleRate)
    this.hpf = this.designHpf(this.sampleRate)
    this.oversample = 4
    this.taps = 13
    this.kernel = this.designInterpolator()
    this.stateL = [0, 0, 0, 0, 0, 0, 0, 0]
    this.stateR = [0, 0, 0, 0, 0, 0, 0, 0]
    // One squared sample per sample of the window, with a running sum: the
    // window slides a sample at a time, so its mean square is always exact.
    this.ringL = new Float32Array(this.windowSize)
    this.ringR = new Float32Array(this.windowSize)
    // The peak of a window is the loudest block peak inside it. Sized for the
    // 128-sample blocks an AudioWorklet hands over, with room to spare.
    this.blockPeaks = new Float32Array(Math.ceil(this.windowSize / 128) + 8)
    this.tpPeaks = new Float32Array(this.blockPeaks.length)
    // The interpolator reads `taps` samples centred on the point it is making,
    // so it needs the samples that came just before this block.
    this.prevLeft = new Float32Array(this.taps - 1)
    this.prevRight = new Float32Array(this.taps - 1)
    // Window powers, for the 3 s short-term reading.
    this.powers = new Float32Array(this.gatesShort)
    this.ringIndex = 0
    this.ringFilled = 0
    this.sumL = 0
    this.sumR = 0
    this.peakIndex = 0
    this.peakFilled = 0
    this.blockPeak = 0
    this.powerIndex = 0
    this.powerFilled = 0
    this.powerSum = 0
    // The first window is thrown away: a filter that just started is still
    // settling, and charging that to the level of the material is a meter error,
    // not a mix error. This is the same start-up skip the offline measurement
    // makes, which is why the two agree window for window.
    this.samplesUntilGate = this.windowSize * 2
  }

  /** High shelf of the K-weighting curve: +4 dB around 1681.97 Hz, Q 0.707. */
  designShelf(sampleRate: number): number[] {
    if (Math.abs(sampleRate - 48000) < 1) return [1.5351248, -2.698163, 1.1983909, -1.6906593, 0.7324808]
    const gainDb = 4
    const f0 = 1681.97445
    const q = 0.70717523
    const a = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * f0) / sampleRate
    const alpha = Math.sin(w0) / (2 * q)
    const cos = Math.cos(w0)
    const stretch = 2 * Math.sqrt(a) * alpha
    const b0 = a * (a + 1 + (a - 1) * cos + stretch)
    const b1 = -2 * a * (a - 1 + (a + 1) * cos)
    const b2 = a * (a + 1 + (a - 1) * cos - stretch)
    const a0 = a + 1 - (a - 1) * cos + stretch
    const a1 = 2 * (a - 1 - (a + 1) * cos)
    const a2 = a + 1 - (a - 1) * cos - stretch
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
  }

  /** RLB high-pass of the K-weighting curve: 38.13 Hz, Q 0.501. */
  designHpf(sampleRate: number): number[] {
    if (Math.abs(sampleRate - 48000) < 1) return [1.0, -2.0, 1.0, -1.9900475, 0.9900723]
    const f0 = 38.13485
    const q = 0.5010523
    const w0 = (2 * Math.PI * f0) / sampleRate
    const alpha = Math.sin(w0) / (2 * q)
    const cos = Math.cos(w0)
    const b0 = (1 + cos) / 2
    const b1 = -(1 + cos)
    const b2 = (1 + cos) / 2
    const a0 = 1 + alpha
    return [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
  }

  /**
   * One branch of the interpolator per inserted point, each the sinc of its own
   * fractional delay, windowed (Blackman) so the truncation cannot add ringing of
   * its own, and normalized so a steady signal stays steady. Branch 0 is the
   * original sample: a filter must not move what is already there.
   */
  designInterpolator(): number[][] {
    const branches: number[][] = []
    for (let phase = 0; phase < this.oversample; phase += 1) {
      const delay = phase / this.oversample
      const taps: number[] = []
      let total = 0
      for (let i = 0; i < this.taps; i += 1) {
        const offset = i - this.interpolatorHalf()
        const x = offset - delay
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
        const window =
          0.42 -
          0.5 * Math.cos((2 * Math.PI * i) / (this.taps - 1)) +
          0.08 * Math.cos((4 * Math.PI * i) / (this.taps - 1))
        const value = sinc * window
        taps.push(value)
        total += value
      }
      branches.push(taps.map((value) => value / total))
    }
    return branches
  }

  interpolatorHalf(): number {
    return (this.taps - 1) / 2
  }

  /**
   * The loudest interpolated point inside this block, in linear amplitude.
   *
   * Every inserted point needs the samples on both sides of it, so the last few
   * points of a block are measured at the start of the next one, when those
   * samples exist - which is why the loop runs from `-half` and stops `half`
   * before the end. Nothing is skipped and nothing is invented: the six samples
   * a point waits for are 0.125 ms, and the tail of the previous block is kept
   * precisely so the window can straddle the block boundary.
   */
  blockTruePeak(left: Float32Array, right: Float32Array): number {
    const half = this.interpolatorHalf()
    const length = left.length
    const span = this.taps - 1
    let peak = 0
    for (let i = -half; i <= length - half - 1; i += 1) {
      for (let phase = 1; phase < this.oversample; phase += 1) {
        const branch = this.kernel[phase]
        let sumL = 0
        let sumR = 0
        for (let t = 0; t < this.taps; t += 1) {
          const index = i - half + t
          sumL += branch[t] * (index < 0 ? this.prevLeft[span + index] : left[index])
          sumR += branch[t] * (index < 0 ? this.prevRight[span + index] : right[index])
        }
        if (Math.abs(sumL) > peak) peak = Math.abs(sumL)
        if (Math.abs(sumR) > peak) peak = Math.abs(sumR)
      }
    }
    return peak
  }

  /** Keep the last `taps - 1` samples of a block for the next one to lean on. */
  rememberTail(tail: Float32Array, block: Float32Array): void {
    const span = tail.length
    const length = block.length
    if (length >= span) {
      for (let i = 0; i < span; i += 1) tail[i] = block[length - span + i]
      return
    }
    // A block shorter than the tail (a final partial quantum): shift what is
    // already there left and put the new samples at the end.
    tail.copyWithin(0, span - length)
    for (let i = 0; i < length; i += 1) tail[span - length + i] = block[i]
  }

  /**
   * Feed one block (128 samples in a browser) and get back the reading it
   * closed, or null when no 100 ms gate fell inside it - the usual case.
   *
   * A gate that lands mid-block is closed exactly where it lands: the block is
   * walked in pieces, so a window never borrows samples from the next one.
   */
  processBlock(left: Float32Array, right: Float32Array | null): MeterReading | null {
    const length = left.length
    if (length === 0) return null
    if (this.stereo === null) this.stereo = right != null
    const stereo = this.stereo === true
    const partner = right ?? left
    let reading: MeterReading | null = null
    let at = 0
    while (at < length) {
      const chunk = Math.min(length - at, this.samplesUntilGate)
      this.walk(left, partner, at, chunk, stereo)
      at += chunk
      this.samplesUntilGate -= chunk
      if (this.samplesUntilGate > 0) continue
      this.samplesUntilGate = this.stepSize
      const closed = this.closeWindow(stereo)
      if (closed) reading = closed
    }
    // One entry per block, so the window can read back the peaks it covered.
    // A worklet hands 128 samples at a time; the ring is sized for that.
    this.tpPeaks[this.peakIndex] = this.blockTruePeak(left, partner)
    this.blockPeaks[this.peakIndex] = this.blockPeak
    this.rememberTail(this.prevLeft, left)
    this.rememberTail(this.prevRight, partner)
    this.blockPeak = 0
    this.peakIndex += 1
    if (this.peakIndex >= this.blockPeaks.length) this.peakIndex = 0
    if (this.peakFilled < this.blockPeaks.length) this.peakFilled += 1
    return reading
  }

  /** K-weight both channels, keep their squares in the sliding rings. */
  walk(left: Float32Array, right: Float32Array, start: number, count: number, stereo: boolean): void {
    const shelf = this.shelf
    const hpf = this.hpf
    const stateL = this.stateL
    const stateR = this.stateR
    const windowSize = this.windowSize
    const end = start + count
    for (let i = start; i < end; i += 1) {
      const x = left[i]
      const y = right[i]
      // Stage 1: the shelf. Stage 2: the RLB high-pass, whose input is the
      // shelf's output and which keeps its own memory.
      const shelfOut =
        shelf[0] * x + shelf[1] * stateL[0] + shelf[2] * stateL[1] - shelf[3] * stateL[2] - shelf[4] * stateL[3]
      const weighted =
        hpf[0] * shelfOut +
        hpf[1] * stateL[4] +
        hpf[2] * stateL[5] -
        hpf[3] * stateL[6] -
        hpf[4] * stateL[7]
      stateL[1] = stateL[0]
      stateL[0] = x
      stateL[3] = stateL[2]
      stateL[2] = shelfOut
      stateL[5] = stateL[4]
      stateL[4] = shelfOut
      stateL[7] = stateL[6]
      stateL[6] = weighted

      const shelfOutR =
        shelf[0] * y + shelf[1] * stateR[0] + shelf[2] * stateR[1] - shelf[3] * stateR[2] - shelf[4] * stateR[3]
      const weightedR =
        hpf[0] * shelfOutR +
        hpf[1] * stateR[4] +
        hpf[2] * stateR[5] -
        hpf[3] * stateR[6] -
        hpf[4] * stateR[7]
      stateR[1] = stateR[0]
      stateR[0] = y
      stateR[3] = stateR[2]
      stateR[2] = shelfOutR
      stateR[5] = stateR[4]
      stateR[4] = shelfOutR
      stateR[7] = stateR[6]
      stateR[6] = weightedR

      const square = weighted * weighted
      const drop = this.ringL[this.ringIndex]
      this.ringL[this.ringIndex] = square
      this.sumL = this.sumL - drop + square
      if (stereo) {
        const squareR = weightedR * weightedR
        const dropR = this.ringR[this.ringIndex]
        this.ringR[this.ringIndex] = squareR
        this.sumR = this.sumR - dropR + squareR
      }

      const loudest = Math.abs(x) > Math.abs(y) ? Math.abs(x) : Math.abs(y)
      if (loudest > this.blockPeak) this.blockPeak = loudest

      this.ringIndex += 1
      if (this.ringIndex >= windowSize) this.ringIndex = 0
      if (this.ringFilled < windowSize) this.ringFilled += 1
    }
  }

  /** Close one 400 ms window: its loudness, its peak, and the 3 s mean so far. */
  closeWindow(stereo: boolean): MeterReading | null {
    if (this.ringFilled < this.windowSize) return null

    const meanL = this.sumL / this.windowSize
    const meanR = stereo ? this.sumR / this.windowSize : 0
    // Stereo sums both channel powers and takes the -0.7 dB the standard uses
    // for alignment; mono is weighted once and carries no offset.
    const power = stereo ? meanL + meanR : meanL
    const lufs = power > 0 ? 10 * Math.log10(power) - (stereo ? 0.7 : 0) : Number.NEGATIVE_INFINITY
    // Under the absolute gate the reading is silence, and an R128 meter says so
    // with -inf rather than with a number a filter's ringing tail invented.
    const gated = !Number.isFinite(lufs) || lufs <= -70
    this.pushPower(gated ? 0 : Math.pow(10, lufs / 10))

    const windowPeak = this.maxBlockPeak(this.blockPeaks)
    const windowTruePeak = this.maxBlockPeak(this.tpPeaks)
    return {
      momentaryLufs: gated ? Number.NEGATIVE_INFINITY : lufs,
      shortTermLufs: this.shortTerm(),
      peakDb: windowPeak > 0 ? 20 * Math.log10(windowPeak) : Number.NEGATIVE_INFINITY,
      truePeakDb: windowTruePeak > 0 ? 20 * Math.log10(windowTruePeak) : Number.NEGATIVE_INFINITY,
    }
  }

  pushPower(power: number): void {
    const old = this.powers[this.powerIndex]
    this.powers[this.powerIndex] = power
    this.powerSum = this.powerSum - old + power
    this.powerIndex += 1
    if (this.powerIndex >= this.powers.length) this.powerIndex = 0
    if (this.powerFilled < this.powers.length) this.powerFilled += 1
  }

  /** Power mean of the last three seconds of windows, in LUFS. */
  shortTerm(): number {
    // A partial pool is not a three second measurement, and showing one would
    // be a number with a label that does not describe it.
    if (this.powerFilled < this.gatesShort) return Number.NEGATIVE_INFINITY
    const average = this.powerSum / this.powerFilled
    return average > 0 ? 10 * Math.log10(average) : Number.NEGATIVE_INFINITY
  }

  /**
   * The loudest block entry still inside the window. Blocks are about 2.7 ms, so
   * a window holds roughly 150 of them at 48 kHz; reading them once every 100 ms
   * is cheaper than a sorted structure and exact. Both rings - the sample peak
   * and the interpolated one - are written and read with the same index, so one
   * scan serves both readings.
   */
  maxBlockPeak(ring: Float32Array): number {
    const blocksInWindow = Math.min(
      ring.length,
      Math.max(1, Math.ceil(this.windowSize / 128) + 1),
    )
    const total = ring.length
    let peak = 0
    for (let back = 0; back < blocksInWindow && back < this.peakFilled; back += 1) {
      let index = this.peakIndex - 1 - back
      while (index < 0) index += total
      const value = ring[index]
      if (value > peak) peak = value
    }
    return peak
  }
}
