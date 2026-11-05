/**
 * Sidechain envelope follower, as a self-contained AudioWorklet source string.
 *
 * It is written as a string on purpose: the engine registers worklets from
 * source text (blob URL) for both the live context and the OfflineAudioContext
 * used by the export, so the duck you hear while mixing is the duck that ends
 * up in the rendered file, computed on the audio thread rather than by a
 * JavaScript timer that a hidden tab would freeze.
 *
 * The node outputs a control signal: 1.0 = no duck, (1 - depth) = fully ducked.
 * It is connected to a GainNode's `gain` AudioParam whose intrinsic value is 0,
 * so the control signal alone sets the level - which is why the duck node only
 * exists while a track actually has a sidechain source.
 */
export const SIDECHAIN_PROCESSOR_NAME = 'webdaw-sidechain'

export const SIDECHAIN_WORKLET_SOURCE = `
class SidechainEnvelope extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1 },
      { name: 'attack', defaultValue: 8, minValue: 0.5, maxValue: 200 },
      { name: 'release', defaultValue: 180, minValue: 1, maxValue: 2000 },
    ]
  }

  constructor() {
    super()
    this.env = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const blockSeconds = 128 / sampleRate
    const depth = parameters.depth
    const attack = parameters.attack
    const release = parameters.release

    // Block RMS: how the source actually felt, not one lucky sample.
    let sum = 0
    let counted = 0
    if (input) {
      for (let channel = 0; channel < input.length; channel += 1) {
        const data = input[channel]
        if (!data) continue
        for (let i = 0; i < data.length; i += 1) {
          sum += data[i] * data[i]
          counted += 1
        }
      }
    }
    const rms = counted > 0 ? Math.sqrt(sum / counted) : 0

    // A k-rate parameter arrives as a one-sample array; read it without
    // indexing past the end.
    const value = (param, index) => (param && param.length > 1 ? param[index] : param ? param[0] : 0)

    for (let i = 0; i < output[0].length; i += 1) {
      const target = Math.min(1, rms * 1.6)
      // Fast when the source arrives, slow when it leaves, so the duck breathes
      // instead of chopping.
      const tauMs = target > this.env ? value(attack, i) : value(release, i)
      const coeff = Math.exp(-blockSeconds / Math.max(0.0005, tauMs / 1000))
      this.env = target + (this.env - target) * coeff
      const gain = 1 - Math.min(1, value(depth, i)) * this.env
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][i] = gain
      }
    }
    return true
  }
}

registerProcessor('webdaw-sidechain', SidechainEnvelope)
`
