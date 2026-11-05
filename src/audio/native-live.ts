/**
 * The native plugin in the live signal path.
 *
 * A .dll does not run in Web Audio: it runs in the app's own plugin process, on
 * the other side of an inter-process call. The audio thread cannot wait for that
 * call — it has 128 samples to answer in about 2.7 ms at 48 kHz, and a trip to
 * the plugin process costs roughly that much — so this bridge never makes it
 * wait. The worklet holds two rings: the input it has not sent yet, and the
 * processed audio that came back. Each round trip carries a batch of samples
 * (512 by default, about 10.7 ms of music) instead of one quantum, so the main
 * thread does a fraction of the work and the audio thread does none of the
 * waiting.
 *
 * What that costs is latency, and it is stated rather than hidden: a batch going
 * in, a batch coming out, and the trip between them. What it never costs is
 * sound — if the plugin is slow, faults, or was never opened, the worklet hands
 * over the dry input, so a producer with a dead plugin still hears the guitar.
 */

// The Node test project typechecks this file without the DOM lib; the bridge
// really does build an AudioWorkletNode, so it declares the lib it needs instead
// of making the whole test project a browser.
/// <reference lib="dom" />

/** Registered name of the worklet below. */
export const NATIVE_LIVE_PROCESSOR_NAME = 'webdaw-native-live'

/** Samples each way per round trip: 512 is ~10.7 ms at 48 kHz, ~11.6 at 44.1. */
export const DEFAULT_LIVE_BATCH = 512

/** How many rings' worth of audio may pile up before the oldest is dropped. */
export const LIVE_QUEUE_LIMIT_BATCHES = 2

/**
 * The batch a lane should use at this rate: always a whole number of 128-sample
 * quanta, and never so small that the process hop dominates the audio it carries.
 */
export function pickLiveBatch(sampleRate: number, targetMs = 11): number {
  const wanted = Math.max(1, Math.round((sampleRate * targetMs) / 1000))
  const quanta = Math.max(1, Math.round(wanted / 128))
  return Math.min(2048, quanta * 128)
}

/** Milliseconds of audio one batch carries — the price of a late answer. */
export function audioMsPerBatch(sampleRate: number, batch: number): number {
  if (!(sampleRate > 0) || !(batch > 0)) return 0
  return (batch / sampleRate) * 1000
}

/**
 * Added delay, in milliseconds, a live plugin puts between the string and the
 * speaker: one batch waiting to go, one batch waiting to be played, and the hop.
 * The panel shows this number instead of promising zero.
 */
export function liveLatencyMs(sampleRate: number, batch = DEFAULT_LIVE_BATCH, hopMs = 3): number {
  const per = audioMsPerBatch(sampleRate, batch)
  return Math.round(per * 2 + hopMs)
}

/**
 * A block answer comes back as a Buffer (Electron) or as {type:'Buffer', data}
 * (a plain fork). Neither can be read as float32 in place — the revived Buffer
 * may sit at an offset that is not a multiple of four — so this copies, which is
 * also the only place the page pays for the conversion.
 */
export function toFloat32(payload: unknown): Float32Array | null {
  if (!payload) return null
  if (payload instanceof Float32Array) return payload
  let bytes: Uint8Array
  if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload)
  else if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  } else if (isBufferLike(payload)) bytes = new Uint8Array(payload.data)
  else return null
  const values = new Float32Array(Math.floor(bytes.byteLength / 4))
  new Uint8Array(values.buffer).set(bytes.subarray(0, values.byteLength))
  return values
}

function isBufferLike(value: unknown): value is { type: 'Buffer'; data: number[] } {
  const record = value as { type?: unknown; data?: unknown }
  return !!record && record.type === 'Buffer' && Array.isArray(record.data)
}

/** What the lane asks the plugin process for when it starts listening. */
export interface LiveOpenRequest {
  path: string
  sampleRate: number
  block: number
  params?: { index: number; value: number }[]
}

/** The answers this bridge needs from the app. Every one of them may say no. */
export interface LiveOpenReply {
  ok: boolean
  error?: string
  geometry?: { block?: number; channels?: number; outputs?: number; sampleRate?: number }
}

export interface LiveBlockReply {
  ok: boolean
  error?: string
  late?: boolean
  left?: unknown
  right?: unknown
  peak?: number
  bad?: number
}

/** The four calls the app's preload exposes; absent in a browser, by design. */
export interface LiveBridge {
  liveOpen?: (request: LiveOpenRequest) => Promise<LiveOpenReply>
  liveBlock?: (request: { path: string; left: Float32Array; right: Float32Array }) => Promise<LiveBlockReply>
  liveParams?: (request: { path: string; params: { index: number; value: number }[] }) => Promise<{ ok: boolean; error?: string }>
  liveClose?: (request: { path: string }) => Promise<{ ok: boolean; blocks?: number; error?: string }>
}

/** What the audio thread counted, handed up when the panel asks. */
export interface LiveStats {
  quanta: number
  batches: number
  answered: number
  underruns: number
  drops: number
  late: number
}

export const EMPTY_LIVE_STATS: LiveStats = {
  quanta: 0,
  batches: 0,
  answered: 0,
  underruns: 0,
  drops: 0,
  late: 0,
}

/** A merge, so a report that only carries some fields cannot lose the rest. */
export function mergeLiveStats(before: LiveStats, next: Partial<LiveStats> | null | undefined): LiveStats {
  if (!next) return before
  return {
    quanta: numberOr(next.quanta, before.quanta),
    batches: numberOr(next.batches, before.batches),
    answered: numberOr(next.answered, before.answered),
    underruns: numberOr(next.underruns, before.underruns),
    drops: numberOr(next.drops, before.drops),
    late: numberOr(next.late, before.late),
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * When a live session stops being worth keeping. One late answer is a hiccup;
 * three in a row, or any reply that says the plugin is not there, means the
 * process faulted or the producer unloaded it — and the lane goes back to dry
 * instead of clicking at the edges of every buffer.
 */
export function shouldGiveUp(failures: number, reply: LiveBlockReply | null): boolean {
  // An answer is an answer: the counter belongs to the link and it resets there.
  if (reply?.ok) return false
  if (failures >= 3) return true
  if (!reply) return false
  // A late reply is the main thread being busy; a refusal is the plugin not being
  // there any more. Only the second one takes the lane back to dry.
  return reply.late !== true
}

/**
 * Whether a lane has anything to put in the live path at all: a VST2 file that is
 * not bypassed. A VST3 is honestly excluded until that engine has a session, and
 * the panel says so rather than going quiet. When the caller does not name the
 * engine, the extension decides — a .vst3 is a bundle, everything else this host
 * loads live is a .dll.
 */
export function canRunLive(slot: { path?: string; bypass?: boolean; kind?: string } | null): boolean {
  if (!slot || slot.bypass) return false
  if (typeof slot.path !== 'string' || slot.path.length === 0) return false
  const kind = slot.kind ?? (/\.vst3([\\/]|$)/i.test(slot.path) ? 'vst3' : 'vst2')
  return kind === 'vst2'
}

/**
 * The worklet, as source text: the engine registers it from a blob so the same
 * module can exist in the live context and, if a bounce ever wants it, in an
 * OfflineAudioContext. Inside an offline render nobody answers the rings, and the
 * `live` flag is simply never raised — the pass goes through the plugin process
 * as a file instead, which is what a bounce should do.
 */
export const NATIVE_LIVE_WORKLET_SOURCE = `
const RING_FRAMES = 8192

/** A single-channel ring: written by the audio thread, drained by both sides. */
class RingBuffer {
  constructor(size) {
    this.size = size
    this.data = new Float32Array(size)
    this.tail = 0
    this.length = 0
  }

  space() {
    return this.size - this.length
  }

  write(values) {
    const count = Math.min(values.length, this.space())
    if (count <= 0) return 0
    const head = (this.tail + this.length) % this.size
    const first = Math.min(count, this.size - head)
    this.data.set(values.subarray(0, first), head)
    if (count > first) this.data.set(values.subarray(first, count), 0)
    this.length += count
    return count
  }

  read(target) {
    const count = Math.min(target.length, this.length)
    if (count <= 0) return 0
    const first = Math.min(count, this.size - this.tail)
    target.set(this.data.subarray(this.tail, this.tail + first), 0)
    if (count > first) target.set(this.data.subarray(0, count - first), first)
    this.tail = (this.tail + count) % this.size
    this.length -= count
    return count
  }

  /** Throw away the oldest samples: fresh audio beats a queue that grew late. */
  skip(count) {
    const dropped = Math.min(count, this.length)
    this.tail = (this.tail + dropped) % this.size
    this.length -= dropped
    return dropped
  }

  reset() {
    this.tail = 0
    this.length = 0
  }
}

class NativeLiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const asked = options && options.processorOptions ? options.processorOptions.batch : 512
    // Always a whole number of quanta, so a batch is never split across blocks.
    this.batch = Math.max(128, Math.min(RING_FRAMES, Math.round(asked / 128) * 128))
    this.inL = new RingBuffer(RING_FRAMES)
    this.inR = new RingBuffer(RING_FRAMES)
    this.outL = new RingBuffer(RING_FRAMES)
    this.outR = new RingBuffer(RING_FRAMES)
    // Pre-allocated send buffers: the audio thread must not shop for garbage.
    this.sendL = new Float32Array(this.batch)
    this.sendR = new Float32Array(this.batch)
    this.live = false
    this.awaiting = false
    this.seq = 0
    this.pending = 0
    this.stats = { quanta: 0, batches: 0, answered: 0, underruns: 0, drops: 0, late: 0 }
    this.port.onmessage = (event) => {
      const data = event.data || {}
      if (data.kind === 'mode') {
        const on = !!data.live
        if (on !== this.live) {
          this.live = on
          this.awaiting = false
          this.inL.reset(); this.inR.reset(); this.outL.reset(); this.outR.reset()
        }
        return
      }
      if (data.kind === 'audio') {
        this.awaiting = false
        // A reply for a batch that was already thrown away must not be played:
        // it would land in the middle of audio the thread has since sent.
        if (data.seq !== this.pending) {
          this.stats.late += 1
          return
        }
        const left = data.left
        const right = data.right && data.right.length ? data.right : left
        if (!left || !left.length) return
        this.stats.answered += 1
        this.outL.write(left)
        this.outR.write(right)
        return
      }
      if (data.kind === 'stats') this.report()
    }
  }

  report() {
    this.port.postMessage({ kind: 'stats', ...this.stats, batch: this.batch })
  }

  process(inputs, outputs) {
    const stats = this.stats
    stats.quanta += 1
    const input = inputs[0]
    const output = outputs[0]
    if (!input || !input[0] || !output || !output[0]) return true
    const inLeft = input[0]
    const inRight = input[1] || inLeft
    const size = output[0].length

    if (!this.live) {
      // Nothing is listening through the plugin: hand the lane exactly what it
      // asked for. This is also the offline path — a bounce never raises the flag.
      output[0].set(inLeft.subarray(0, size))
      if (output[1]) output[1].set(inRight.subarray(0, size))
      return true
    }

    this.inL.write(inLeft)
    this.inR.write(inRight)
    // The ring is a pipeline, not a queue: past two batches the oldest audio is
    // already useless, and keeping it would only push the producer further away.
    const limit = this.batch * 2
    if (this.inL.length > limit) {
      const overflow = this.inL.length - limit
      this.inL.skip(overflow)
      this.inR.skip(overflow)
      stats.drops += 1
    }

    const taken = this.outL.read(output[0])
    const rightTaken = output[1] ? this.outR.read(output[1]) : 0
    // Whatever the plugin did not deliver in time is the dry input, not silence:
    // a slow answer changes the tone for a moment, it never mutes the take.
    if (taken < size) {
      stats.underruns += 1
      output[0].set(inLeft.subarray(0, size - taken), taken)
    }
    if (output[1] && rightTaken < size) {
      output[1].set(inRight.subarray(0, size - rightTaken), rightTaken)
    }

    if (!this.awaiting && this.inL.length >= this.batch) {
      this.inL.read(this.sendL)
      this.inR.read(this.sendR)
      this.pending = ++this.seq
      this.awaiting = true
      stats.batches += 1
      this.port.postMessage({ kind: 'batch', seq: this.pending, left: this.sendL, right: this.sendR })
    }

    if (stats.quanta % 256 === 0) this.report()
    return true
  }
}

registerProcessor('webdaw-native-live', NativeLiveProcessor)
`

/**
 * The main-thread half: it owns one worklet node and one plugin path, answers the
 * batches the audio thread posts, and knows when to stop trying.
 *
 * One request in flight at a time is deliberate. The plugin process handles calls
 * in order, and two outstanding batches would come back in the order they were
 * processed rather than the order the thread filled them — the audio would be
 * reassembled out of turn. A busy link simply lets the worklet drop the samples
 * it could not send, which the report counts.
 */
export class NativeLiveLink {
  readonly node: AudioWorkletNode
  readonly path: string
  readonly batch: number
  readonly bridge: LiveBridge

  private busy = false
  private failures = 0
  private closed = false
  private stats: LiveStats = EMPTY_LIVE_STATS
  private running = false
  private lastError = ''

  private constructor(
    node: AudioWorkletNode,
    bridge: LiveBridge,
    path: string,
    batch: number,
  ) {
    this.node = node
    this.bridge = bridge
    this.path = path
    this.batch = batch
    node.port.onmessage = (event: MessageEvent) => this.onMessage(event.data)
  }

  /** True while the audio thread is handing its input through the plugin. */
  get live(): boolean {
    return this.running
  }

  get error(): string {
    return this.lastError
  }

  get report(): LiveStats {
    return this.stats
  }

  /**
   * Open the session in the plugin process, then raise the flag in the worklet.
   * The order matters: enabling the node before the process is ready would have
   * the thread posting batches into a call that answers "no session open".
   *
   * Returns null when this page simply has no live path — no bridge, or no
   * AudioWorklet — and throws the plugin's own words when the plugin refused,
   * because "this .dll has no live session" is something the producer has to read
   * rather than a lane that quietly went back to dry.
   */
  static async open(
    ctx: AudioContext,
    bridge: LiveBridge | undefined,
    options: { path: string; sampleRate: number; params?: { index: number; value: number }[]; batch?: number },
  ): Promise<NativeLiveLink | null> {
    if (!bridge?.liveOpen || !bridge.liveBlock) return null
    const batch = options.batch ?? pickLiveBatch(options.sampleRate)
    if (!(await ensureNativeLiveModule(ctx))) return null
    const node = new AudioWorkletNode(ctx, NATIVE_LIVE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: { batch },
    })
    const link = new NativeLiveLink(node, bridge, options.path, batch)
    const answer = await bridge.liveOpen({
      path: options.path,
      sampleRate: options.sampleRate,
      block: batch,
      params: options.params ?? [],
    })
    if (!answer?.ok) {
      link.lastError = answer?.error || 'o plugin não abriu uma sessão ao vivo'
      node.disconnect()
      throw new Error(link.lastError)
    }
    link.running = true
    node.port.postMessage({ kind: 'mode', live: true })
    return link
  }

  /** Push panel values into the running session; the plugin answers with its own. */
  async setParams(params: { index: number; value: number }[]): Promise<void> {
    if (!this.running || this.closed) return
    await this.bridge.liveParams?.({ path: this.path, params }).catch(() => undefined)
  }

  /**
   * Close for good: the thread goes back to dry first, so the producer never
   * hears the moment the session was taken away.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.running = false
    try {
      this.node.port.postMessage({ kind: 'mode', live: false })
    } catch {
      // A node already disconnected cannot be told anything; the session below
      // still has to be closed or the plugin keeps its mains open forever.
    }
    this.node.disconnect()
    await this.bridge.liveClose?.({ path: this.path }).catch(() => undefined)
  }

  askForStats(): void {
    if (this.closed) return
    try {
      this.node.port.postMessage({ kind: 'stats' })
    } catch {
      // The node is gone; the last report is the answer.
    }
  }

  private onMessage(data: MessageEvent['data']): void {
    const message = (data ?? {}) as { kind?: string; seq?: number; left?: Float32Array; right?: Float32Array } & Partial<LiveStats>
    if (message.kind === 'stats') {
      this.stats = mergeLiveStats(this.stats, message)
      return
    }
    if (message.kind !== 'batch' || this.closed || !this.running) return
    const left = toFloat32(message.left)
    const right = toFloat32(message.right) ?? left
    if (!left || !right || left.length === 0 || this.busy) return
    this.busy = true
    const seq = message.seq
    void this.bridge
      .liveBlock!({ path: this.path, left, right })
      .then((reply) => this.onReply(seq, reply))
      .catch((error: unknown) => this.onReply(seq, { ok: false, error: (error as Error)?.message ?? String(error) }))
  }

  private onReply(seq: number | undefined, reply: LiveBlockReply | undefined): void {
    this.busy = false
    if (this.closed) return
    if (reply?.ok) {
      this.failures = 0
      const left = toFloat32(reply.left)
      const right = toFloat32(reply.right) ?? left
      if (left && left.length) {
        this.node.port.postMessage({ kind: 'audio', seq, left, right })
      }
      return
    }
    this.failures += 1
    this.lastError = reply?.error || 'o plugin não respondeu'
    if (shouldGiveUp(this.failures, reply ?? null)) {
      // Back to dry, and said out loud: the number of underruns the worklet
      // counted is what the producer heard before the lane gave up.
      this.running = false
      try {
        this.node.port.postMessage({ kind: 'mode', live: false })
      } catch {
        // Node already gone.
      }
    }
  }
}

/** One registration per context; two lanes asking at once share one load. */
const liveLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()

export function ensureNativeLiveModule(ctx: BaseAudioContext): Promise<boolean> {
  const existing = liveLoads.get(ctx)
  if (existing) return existing
  const load = (async () => {
    try {
      const url = URL.createObjectURL(new Blob([NATIVE_LIVE_WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
        return true
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch {
      // A context without an audioWorklet (an older engine) simply has no live
      // plugins, and the panel keeps the offline path it already proved.
      return false
    }
  })()
  liveLoads.set(ctx, load)
  return load
}
