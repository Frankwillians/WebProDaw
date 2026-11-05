/**
 * The AudioWorklet that carries the live loudness meter.
 *
 * The source is the same class `node --test` runs, turned into text at build
 * time, so the meter on screen cannot drift away from the meter that was tested:
 * there is one implementation, not a browser copy and a test copy.
 *
 * It reads the master bus - after the fader and after the master FX, which is
 * the signal the exported file is - and posts one reading every 100 ms, which
 * is the rate the standard's sliding window moves at. Nothing is polled from
 * the main thread, so a frozen tab or a late frame cannot hole up a window and
 * invent a number.
 */
import { LoudnessMeterCore } from './loudness-meter-core'

export const LOUDNESS_PROCESSOR_NAME = 'webdaw-loudness'

export interface LiveLoudness {
  /** Last 400 ms, in LUFS; -Infinity means the meter shows -inf. */
  momentaryLufs: number
  /** Last 3 s, in LUFS; -Infinity until three seconds have been metered. */
  shortTermLufs: number
  /** Sample peak inside the last 400 ms, in dBFS. */
  peakDb: number
  /** True peak inside the last 400 ms, in dBTP: what the converter hears. */
  truePeakDb: number
}

export const LOUDNESS_WORKLET_SOURCE = `
const LoudnessMeterCore = ${LoudnessMeterCore.toString()}

class WebdawLoudnessMeter extends AudioWorkletProcessor {
  constructor() {
    super()
    this.core = new LoudnessMeterCore(sampleRate)
    this.zeros = new Float32Array(128)
    this.port.onmessage = (event) => {
      // A fresh project deserves a fresh meter: the window is thrown away rather
      // than reported across two different mixes.
      if (event.data === 'reset') this.core = new LoudnessMeterCore(sampleRate)
    }
  }

  process(inputs) {
    const input = inputs[0]
    const left = input && input[0] && input[0].length > 0 ? input[0] : this.zeros
    const right = input && input[1] && input[1].length > 0 ? input[1] : null
    const reading = this.core.processBlock(left, right)
    if (reading) this.port.postMessage(reading)
    // The node's own output stays silent; it exists so the graph keeps pulling
    // this processor, which is the only way the window sees every sample.
    return true
  }
}

registerProcessor('webdaw-loudness', WebdawLoudnessMeter)
`
