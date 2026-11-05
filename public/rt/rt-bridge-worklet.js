/**
 * The spike that decides whether a native plugin can sit in the live signal.
 *
 * A browser audio thread does not call out to another process: it draws 128
 * samples at a time and has to answer in microseconds. The plugin lives in the
 * app's own child process, so the only way it can be heard in real time is a
 * pipe that crosses two boundaries — renderer to main process, main process to
 * the plugin worker — and back, without the audio thread waiting on any of it.
 *
 * This module is that pipe, measured before anything is built on it. The probe
 * asks the far end for an answer and counts what the thread had to render while
 * it waited. That number, in frames, is the whole decision: it is how much
 * lookahead a live chain would need, and how much of it the audio thread lost
 * asking. Nothing here reads a clock that the audio scope does not own — the
 * frame counter is the audio thread's own time.
 */
const PROBE_EVERY_BLOCKS = 4

class RtBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    /** The port to the app's main process, once the page hands it over. */
    this.rt = null
    /** Blocks counted: proof that the audio thread is really running. */
    this.blocks = 0
    this.frames = 0
    /** Frames rendered per hop between asking and being answered. */
    this.samples = { main: [], worker: [] }
    this.pending = null
    this.sinceProbe = 0
    this.errors = 0
    this.port.onmessage = (event) => {
      const data = event.data || {}
      if (data.attachPort) {
        this.rt = data.attachPort
        this.rt.onmessage = (reply) => this.onReply(reply.data)
        this.rt.start?.()
        this.port.postMessage({ kind: 'ready' })
        return
      }
      if (data.kind === 'stop') this.rt = null
    }
  }

  onReply(data) {
    if (!data || data.kind !== 'probe-echo' || !this.pending) return
    if (data.hop !== this.pending.hop) return
    const waited = currentFrame - this.pending.frame
    this.pending = null
    const list = this.samples[data.hop]
    if (list && list.length < 4000) list.push(waited)
  }

  process(inputs, outputs) {
    try {
      this.blocks += 1
      this.frames += 128
      const output = outputs[0]
      const input = inputs[0]
      // Pass the input through while there is nothing to mix in: the bridge must
      // never be the reason a producer hears nothing.
      if (input && output) {
        for (let channel = 0; channel < output.length; channel += 1) {
          const source = input[channel]
          const target = output[channel]
          if (source && source.length === target.length) target.set(source)
          else if (target) target.fill(0)
        }
      }
      if (!this.rt) return true
      if (!this.pending) {
        this.sinceProbe += 1
        if (this.sinceProbe >= PROBE_EVERY_BLOCKS) {
          this.sinceProbe = 0
          const hop = this.blocks % 2 === 0 ? 'main' : 'worker'
          this.pending = { hop, frame: currentFrame }
          this.rt.postMessage({ kind: 'probe', hop, frame: currentFrame })
        }
      }
      // The report the test reads: how many blocks ran, and the wait so far. The
      // first block is reported on its own — a run that never gets a second
      // quantum is a different fact from a run that gets slow answers.
      if (this.blocks === 1 || this.blocks % 32 === 0) this.report()
      return true
    } catch (error) {
      // A throwing render quantum is itself the answer the spike needs: the node
      // stops producing sound, so say which line broke instead of going quiet.
      this.errors += 1
      if (this.errors < 4) {
        this.port.postMessage({ kind: 'worklet-error', text: String(error && error.message ? error.message : error) })
      }
      return true
    }
  }

  report() {
    const summarise = (list) => {
      if (list.length === 0) return null
      const sorted = [...list].sort((a, b) => a - b)
      const total = sorted.reduce((sum, value) => sum + value, 0)
      return {
        n: sorted.length,
        avg: Math.round(total / sorted.length),
        median: sorted[Math.floor(sorted.length / 2)],
        worst: sorted[sorted.length - 1],
      }
    }
    this.port.postMessage({
      kind: 'stats',
      blocks: this.blocks,
      frames: this.frames,
      rate: sampleRate,
      main: summarise(this.samples.main),
      worker: summarise(this.samples.worker),
    })
  }
}

registerProcessor('rt-bridge', RtBridgeProcessor)
