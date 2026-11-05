/**
 * Audio Engine - Web Audio API
 *
 * Per track signal path:
 *   input device ─┐
 *   recorded clip ─┼─> panner -> fxInput -> shaper -> filter -> [signal chain]
 *                  │    -> gain -> mono fold-down -> duck -> master or sub-group
 *
 * Master bus: every track (or sub-group) sums into `masterSum`, passes through
 * a full built-in FX rack (glue EQ / compressor / limiter live there), then the
 * master volume. Two shared send buses (reverb + delay) are fed by a tap on
 * each track and return into the same sum, so the master FX processes them.
 *
 * Sub-groups are a second, smaller version of the master: member tracks land on
 * the group's sum, and the group's fader, pan and mute sit between them and
 * `masterSum`. The duck that a sidechain source applies is computed by an
 * AudioWorklet on the audio thread, so it never depends on a JavaScript timer.
 *
 * Plugin chain supports:
 *   - IR / cabinet convolution (ConvolverNode)
 *   - external AudioWorklet plugins (.js files registering a processor)
 *   - Neural Amp Modeler models (.nam) running through the TONE3000 WASM engine
 *
 * NAM models are wired in parallel and summed back into the chain, so multiple
 * amps play at the same time and can be panned independently.
 *
 * The same chain can be rebuilt inside an OfflineAudioContext to export audio.
 */

import { NamEngine } from 'neural-amp-modeler-wasm/engine'
import type { NamModelInfo, NamNode } from 'neural-amp-modeler-wasm/engine'
import { scheduleVoice } from './instruments'
import type { InstrumentKind, InstrumentNote } from './instruments'
import {
  automationGainAt,
  automationNodeGain,
  clampRange,
  dbToGain,
  fadeGainAt,
  gateCurve,
  normalizeDuckSources,
  overdriveCurve,
  sameIdList,
  saturationCurve,
  sortedAutomation,
} from './mix-math'
import type { AutomationBreakpoint } from './mix-math'
import { clipEnd as clipEndOf } from './mix-math'
import { measureLoudness } from './loudness'
import type { LoudnessReport } from './loudness'
import { SIDECHAIN_PROCESSOR_NAME, SIDECHAIN_WORKLET_SOURCE } from './sidechain-worklet'
import { LOUDNESS_PROCESSOR_NAME, LOUDNESS_WORKLET_SOURCE } from './loudness-worklet'
import type { LiveLoudness } from './loudness-worklet'
import { isPatterned, patternContentEnd } from './step-pattern'
import { takeToPlay } from './native-preview'

export type { AutomationBreakpoint } from './mix-math'
export type { LoudnessReport } from './loudness'

export type { InstrumentKind, InstrumentNote }
export {
  DRUM_PIECES,
  PIANO_VOICES,
  DRUM_KITS,
  BASS_VOICES,
  INSTRUMENT_KINDS,
  defaultVoice,
  instrumentLabel,
  voicesFor,
} from './instruments'

export type PluginKind = 'ir' | 'worklet' | 'nam'

// ------------------------------------------------------------ native FX rack

// Default serial order, from the source end of the chain to the speaker:
// dynamics/level first, then tone, then modulation, then space, limiter last.
export const BUILTIN_FX_IDS = [
  'gate', 'sat', 'dist', 'eq', 'comp', 'deess', 'trem',
  'chorus', 'delay', 'reverb', 'limiter'
] as const
export type BuiltinFxId = (typeof BUILTIN_FX_IDS)[number]

export interface BuiltinFxParams {
  // Distortion
  drive: number
  tone: number
  // Chorus
  rate: number
  depth: number
  // Reverb
  decay: number
  // Delay
  time: number
  feedback: number
  // EQ (3-band parametric)
  eqLowFreq: number
  eqLowGain: number
  eqMidFreq: number
  eqMidGain: number
  eqMidQ: number
  eqHighFreq: number
  eqHighGain: number
  // Compressor
  compThreshold: number
  compRatio: number
  compAttack: number
  compRelease: number
  compKnee: number
  compMakeup: number
  // Gate (static downward expander - no attack/release exists in this design)
  gateThreshold: number
  gateRange: number
  // Saturator (tape soft clip)
  satDrive: number
  satTone: number
  satTrim: number
  // Tremolo
  tremRate: number
  tremDepth: number
  // De-esser (split-band: the band above deessFreq gets its own compressor)
  deessFreq: number
  deessThreshold: number
  deessRatio: number
  deessAttack: number
  deessRelease: number
  // Limiter
  limThreshold: number
  limRelease: number
  limCeiling: number
}

export interface BuiltinFxUnit {
  enabled: boolean
  mix: number
  params: BuiltinFxParams
}

export type BuiltinFxRack = Record<BuiltinFxId, BuiltinFxUnit>

export function defaultBuiltinFx(): BuiltinFxRack {
  const params = (): BuiltinFxParams => ({
    // Distortion
    drive: 0.45,
    tone: 3800,
    // Chorus
    rate: 1.1,
    depth: 3.5,
    // Reverb
    decay: 2.4,
    // Delay
    time: 320,
    feedback: 0.32,
    // EQ
    eqLowFreq: 100,
    eqLowGain: 0,
    eqMidFreq: 1000,
    eqMidGain: 0,
    eqMidQ: 1,
    eqHighFreq: 5000,
    eqHighGain: 0,
    // Compressor
    compThreshold: -18,
    compRatio: 4,
    compAttack: 10,
    compRelease: 100,
    compKnee: 6,
    compMakeup: 0,
    // Gate
    gateThreshold: -40,
    gateRange: 40,
    // Saturator
    satDrive: 0.3,
    satTone: 12000,
    satTrim: -3,
    // Tremolo
    tremRate: 4.5,
    tremDepth: 0.5,
    // De-esser
    deessFreq: 6500,
    deessThreshold: -22,
    deessRatio: 6,
    deessAttack: 2,
    deessRelease: 60,
    // Limiter
    limThreshold: -1,
    limRelease: 50,
    limCeiling: -0.5,
  })
  return {
    gate: { enabled: false, mix: 1, params: params() },
    sat: { enabled: false, mix: 1, params: params() },
    dist: { enabled: false, mix: 0.5, params: params() },
    eq: { enabled: false, mix: 1, params: params() },
    comp: { enabled: false, mix: 1, params: params() },
    deess: { enabled: false, mix: 1, params: params() },
    trem: { enabled: false, mix: 1, params: params() },
    chorus: { enabled: false, mix: 0.4, params: params() },
    delay: { enabled: false, mix: 0.25, params: params() },
    reverb: { enabled: false, mix: 0.28, params: params() },
    limiter: { enabled: false, mix: 1, params: params() },
  }
}

export type PluginParamUnit = 'db' | 'hz' | 'pan' | 'percent' | 'ratio' | 'bool' | 'ms'

export interface PluginParamInfo {
  name: string
  value: number
  min: number
  max: number
  step?: number
  unit?: PluginParamUnit
}

export interface PluginInfo {
  id: string
  name: string
  kind: PluginKind
  params: PluginParamInfo[]
  detail?: string
}

/**
 * A plugin restored from a saved project keeps the id its chain already names.
 * Without this, reload would create a new instance while the saved signal path
 * still pointed at the old id, which is how a NAM could be "loaded" and remain
 * outside the audio.
 */
export interface PluginRestoreInfo {
  id: string
  enabled?: boolean
  params?: PluginParamInfo[]
}

interface PluginSource {
  irBuffer?: AudioBuffer
  workletSource?: string
  processorName?: string
  namJson?: string
  namSlim?: number
}

interface PluginInstance extends PluginInfo {
  enabled: boolean
  input: AudioNode
  output: AudioNode
  source: PluginSource
  setParam(name: string, value: number): void
  dispose(): void
}

type ChainStage =
  | { kind: 'builtin'; id: BuiltinFxId }
  | { kind: 'plugin'; id: string }

interface EngineTrack {
  panner: StereoPannerNode
  fxInput: GainNode
  shaper: WaveShaperNode
  filter: BiquadFilterNode
  fx: BuiltinChain
  chain: ChainStage[]
  namSplit: GainNode
  namSum: GainNode
  gain: GainNode
  /**
   * The chain's output in front of the fader — where a take recorded "com efeitos"
   * is read from. It carries the same signal the lane plays, without the fader,
   * the automation or the meter, so printing the effects never prints the mix.
   */
  recordPoint: GainNode
  /**
   * The gain the lane's playing clip passes through on its way into the chain. A
   * printed wet take is the sound of the input alone, so while one is running this
   * is closed — the way a desk mutes a track's own tape during an over-dub, which
   * also keeps the file and the headphones saying the same thing. Null between
   * passes: it belongs to the scheduled source, not to the lane.
   */
  clipMute: GainNode | null
  // Volume automation multiplies the fader from its own node, so drawing a lane
  // never moves the fader the user set, and moving the fader never destroys a
  // scheduled envelope.
  autoGain: GainNode
  automation: AutomationBreakpoint[]
  analyser: AnalyserNode
  // Gain staging: trim (linear multiplier), polarity (±1) and mono fold-down.
  trim: number
  phase: number
  mono: boolean
  monoSplitter: ChannelSplitterNode
  monoMerger: ChannelMergerNode
  monoGains: [GainNode, GainNode, GainNode, GainNode]
  // Send taps feeding the shared reverb / delay buses.
  rvSend: GainNode
  dlSend: GainNode
  /**
   * Sidechain duck: sits after the mono fold-down and before the meter, so the
   * fader, the sends and the export all hear the ducked signal. Its gain is 1
   * and inert until `duck` connects a control signal to it.
   */
  duckGain: GainNode
  duck: DuckLink | null
  /** Tracks whose signal opens this gate; empty when there is no sidechain. */
  duckSourceIds: string[]
  duckDepth: number
  plugins: PluginInstance[]
  muted: boolean
  volume: number
  pan: number
  // Sub-bus this track feeds. '' means the master bus directly.
  groupId: string
  buffer: AudioBuffer | null
  // Identifies which stored sample the current buffer came from, so the app
  // can tell "already loaded" from "needs rehydrating" when rewinding history.
  bufferLabel: string
  /**
   * What the lane actually plays: a pass rendered through a plugin that lives in
   * its own process (the native VST bridge). It is a preview, not the project —
   * `buffer` stays the recorded take, the waveform, the trim and the undo
   * target, and this only stands in front of the speakers and the export while
   * it is set. `key` names the plugin, its knobs and the clip it was rendered
   * from, so the app can tell a fresh preview from a stale one.
   */
  monitor: { buffer: AudioBuffer; key: string } | null
  clipStart: number
  clipDuration: number
  // Edge fades in seconds, applied to the clip and mirrored in the offline mix.
  fadeIn: number
  fadeOut: number
  instrument: InstrumentKind | null
  notes: InstrumentNote[]
  /**
   * Loop length for the notes, in steps. 0 keeps the old behaviour (every note
   * sits where it was drawn); 16/32/64 means the notes are one bar (or two, or
   * four) of a pattern that the transport repeats for the whole arrangement.
   */
  patternSteps: number
  voice: string
}

interface SendBus {
  input: GainNode
  output: GainNode
  // Reverb bus
  convolver?: ConvolverNode
  decay?: number
  // Delay bus
  delayNode?: DelayNode
  feedback?: GainNode
}

/**
 * Sub-group: a second mix bus that tracks feed instead of the master. Sits
 * between its members and `masterSum`, so a group fader, pan and mute are part
 * of the sound the master hears - and part of the exported file, because the
 * offline render builds the same shape.
 */
interface GroupBus {
  /** Where member tracks land (pre-fader sum). */
  input: GainNode
  panner: StereoPannerNode
  /** Post-fader tap, so the strip meter reads what the group really sends. */
  analyser: AnalyserNode
  output: GainNode
  volume: number
  pan: number
  muted: boolean
}

/**
 * The nodes a live sidechain adds to a track: the envelope follower that reads
 * the sources, the silent branch that keeps it pulled by the graph, and the
 * sources actually wired into it. Chrome only runs an AudioWorkletNode whose
 * output reaches the destination, and a connection to an AudioParam alone is not
 * enough.
 *
 * More than one source can feed one follower: their signals add at the node's
 * input, which is what an external compressor's summing amp does too - the duck
 * then follows the two tracks together, not the louder of the two.
 */
interface DuckLink {
  follower: AudioWorkletNode
  sink: GainNode
  /** The tracks currently connected to the follower, in the order they were added. */
  sources: string[]
}

export interface SendConfig {
  rvDecay: number
  dlTime: number
  dlFeedback: number
  rvReturn: number
  dlReturn: number
}

export function defaultSendConfig(): SendConfig {
  return { rvDecay: 2.4, dlTime: 380, dlFeedback: 0.35, rvReturn: 1, dlReturn: 1 }
}

interface InputEntry {
  stream: MediaStream
  /** The key this lane's stream is cached under, for shared release. */
  streamKey: string
  source: MediaStreamAudioSourceNode
  /** Carries exactly the channel(s) this lane picked, before monitoring. */
  out: GainNode
  gain: GainNode
  /**
   * The lane's way into its effects while a wet take runs. Silent between takes:
   * it exists so the recorded pass is the one the producer hears, without making
   * the monitor button decide what reaches the printer.
   */
  wet: GainNode
  splitter: ChannelSplitterNode | null
  /** Whether the producer is hearing the live input right now. */
  monitor: boolean
  /**
   * 'wet' prints the take from the end of the lane's effects instead of the raw
   * input: the sound the producer heard while playing is the sound on disk, the
   * way a hardware re-amp prints. It is a baked choice — the effects of a wet take
   * cannot be changed afterwards, only the fader — so the lane can go back to
   * 'dry' for the next take and keep both files.
   */
  recordMode: 'dry' | 'wet'
  /** What the device actually gave us, reported straight from the track. */
  status: InputStatus
  /**
   * True when the stream was handed to us by somebody else — a call room's SDK.
   * The lane may unplug from it, but it must never stop its tracks: the same
   * stream is still feeding the call's own return meter, and a stopped WebRTC
   * track does not come back on its own.
   */
  borrowed?: boolean
  /**
   * A node the lane's input goes through before it reaches the monitor and the
   * wet print — today, a native plugin heard in real time. The recorder's dry tap
   * stays on `out` above it, so printing seco is unaffected by whatever is here.
   */
  liveInsert?: AudioNode | null
}

/**
 * A live input stream shared by every lane that opened the same device. An
 * interface with two inputs is one physical stream: taking channel 1 on one
 * track and channel 2 on another has to read the same stream, because asking
 * the browser twice for the same hardware is not guaranteed to work.
 */
interface SharedStream {
  stream: MediaStream
  users: number
}

/**
 * A running take. MediaRecorder hands back one compressed blob when it stops,
 * which cannot guarantee a stereo take and gives nothing until then, so the
 * take is captured from a sample tap instead: raw floats per channel, plus one
 * peak per chunk so the lane can draw the waveform while the take is running.
 */
interface RecorderEntry {
  node: ScriptProcessorNode
  sink: GainNode
  /** The node the take is read from: the lane's input, or the end of its effects. */
  tap: AudioNode
  /** True when this tap is the chain's output, so a rewire has to re-hook it. */
  wet: boolean
  channels: number
  chunks: Float32Array[][]
  written: number
  /**
   * A second tap of the same signal, for the live spectrum shown while the take
   * runs. It reads what the lane really carries (after the input patch), which
   * is also what lands on disk — so the picture cannot lie about the take.
   */
  analyser: AnalyserNode
}

/**
 * Which part of a device a lane owns. 0 takes the pair as it arrives — a stereo
 * source stays stereo. 1..N takes that single input of the device, which is what
 * an interface with more than two inputs needs: guitar in 1, vocal in 2, a synth
 * across 3 and 4. How many exist is the device's own answer, not ours.
 */
export type InputChannel = number

/** The most channels any lane has needed from one interface. */
export const MAX_INPUT_CHANNELS = 8

/**
 * The name a playback device gives itself, for the report that goes back to the
 * screen. The browser only shows labels once a device has been allowed, so the
 * label can legitimately be missing; the id's own tail is better than a blank.
 *
 * The kind filter is not decoration. A driver is allowed to answer with the same
 * id for its capture and its render endpoint — the fake device Chromium uses does
 * exactly that — and then the first row that matches is the microphone, which
 * makes the mix claim to be leaving through an input.
 */
async function outputLabelFor(deviceId: string): Promise<string> {
  try {
    const listed = await navigator.mediaDevices.enumerateDevices()
    const found = listed.find((item) => item.kind === 'audiooutput' && item.deviceId === deviceId)
    if (found?.label) return found.label
  } catch {
    /* the device list is not the point of this call */
  }
  return `Saída ${deviceId.slice(0, 6)}`
}

/**
 * The truth about a live input. The channel counts are read from the device
 * itself, not from what we asked for, because a stereo interface and a mono
 * webcam mic look identical in the browser UI until something is connected.
 */
export interface InputStatus {
  deviceId: string
  label: string
  /** Channels this lane actually carries: 2 for a stereo pair, 1 when a single input was patched in. */
  channels: number
  /** Channels the device itself delivers, before the lane picked one. */
  sourceChannels: number
  /** What the lane ended up with; 0 when a mono device left nothing to pick. */
  channel: InputChannel
  sampleRate: number
}

/**
 * The answer about where the mix goes out. `routed` says whether the chosen card
 * really took the audio; when it is false the mix is on the system default and
 * `error` carries the device's own refusal, so the producer reads why instead of
 * guessing from silence.
 */
export interface OutputRoute {
  deviceId: string
  label: string
  routed: boolean
  error: string
}

export interface RenderRequest {
  bpm: number
  bars: number
  /** When set, renders only this track instead of the full mix. */
  trackId?: string
  /** When set, renders only the members of this sub-group. */
  groupId?: string
  /**
   * Stems are rendered at the full arrangement length so they line up when the
   * producer drags them into another session, instead of ending wherever the
   * last clip stopped.
   */
  aligned?: boolean
  masterVolume: number
  masterMuted: boolean
}

export interface RenderResult {
  buffer: AudioBuffer
  warnings: string[]
  /** BS.1770 loudness of the bytes that were written, measured after any safety trim. */
  loudness: LoudnessReport
}

type AudioContextCtor = typeof AudioContext

const NAM_ASSET_BASE = '/nam/'

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getAudioContextCtor(): AudioContextCtor {
  const withWebkit = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  const ctor = withWebkit.AudioContext ?? withWebkit.webkitAudioContext
  if (!ctor) {
    throw new Error('Web Audio API não é suportada neste navegador.')
  }
  return ctor
}

function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024
  const curve = new Float32Array(samples)
  const k = Math.max(1, amount)
  const deg = Math.PI / 180
  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x))
  }
  return curve
}

function toInfo(plugin: PluginInstance): PluginInfo {
  return {
    id: plugin.id,
    name: plugin.name,
    kind: plugin.kind,
    params: plugin.params.map((param) => ({ ...param })),
    detail: plugin.detail,
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

// ------------------------------------------------------------ sound design

function scheduleClick(ctx: BaseAudioContext, destination: AudioNode, time: number, accent = false): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'square'
  osc.frequency.setValueAtTime(accent ? 1600 : 1000, time)
  gain.gain.setValueAtTime(0.0001, time)
  gain.gain.exponentialRampToValueAtTime(0.22, time + 0.002)
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05)
  osc.connect(gain)
  gain.connect(destination)
  osc.start(time)
  osc.stop(time + 0.06)
}

// ------------------------------------------------------------ native FX nodes

interface BuiltinUnitNodes {
  input: GainNode
  output: GainNode
  dry: GainNode
  wet: GainNode
  /**
   * Every internal node of this unit, so tearing the track down is one loop
   * instead of a growing list of optional fields.
   */
  extra: AudioNode[]
  // Distortion
  shaper?: WaveShaperNode
  tone?: BiquadFilterNode
  // Chorus
  lfo?: OscillatorNode
  lfoDepth?: GainNode
  delayNode?: DelayNode
  // Reverb
  convolver?: ConvolverNode
  decay?: number
  // Delay
  delay?: DelayNode
  feedback?: GainNode
  // EQ (3-band)
  eqLow?: BiquadFilterNode
  eqMid?: BiquadFilterNode
  eqHigh?: BiquadFilterNode
  // Compressor
  compNode?: DynamicsCompressorNode
  compMakeup?: GainNode
  // Gate
  gateShaper?: WaveShaperNode
  gateThreshold?: number
  // Saturator
  satShaper?: WaveShaperNode
  satTone?: BiquadFilterNode
  satTrim?: GainNode
  // Tremolo
  tremGain?: GainNode
  tremLfo?: OscillatorNode
  tremLfoDepth?: GainNode
  // De-esser
  deessLow?: BiquadFilterNode
  deessBandSum?: GainNode
  deessComp?: DynamicsCompressorNode
  deessOut?: GainNode
  // Limiter
  limNode?: DynamicsCompressorNode
  limCeil?: GainNode
}

export interface BuiltinChain {
  units: Record<BuiltinFxId, BuiltinUnitNodes>
  input: GainNode
  output: GainNode
  state: BuiltinFxRack
}

/**
 * Deterministic white noise (xorshift32). Math.random() here would give every
 * render a different impulse, so exporting the same project twice would not
 * match the monitors - a fixed seed makes it the same room every time.
 */
function seededNoise(seed: number): () => number {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x80000000 - 1
  }
}

function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.max(1, Math.floor(Math.max(0.15, seconds) * rate))
  const buffer = ctx.createBuffer(2, length, rate)
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel)
    // Two decorrelated channels, but the same pair on every render.
    const rand = seededNoise(0x9e37 + Math.round(seconds * 1000) + channel * 7919)
    let low = 0
    for (let i = 0; i < length; i += 1) {
      const decay = Math.pow(1 - i / length, 2.4)
      const noise = rand()
      // Slight low-pass on the tail keeps the reverb from sounding fizzy.
      low += (noise - low) * 0.35
      data[i] = low * decay * (i < 120 ? 0.4 : 1)
    }
  }
  return buffer
}

function createUnitShell(ctx: BaseAudioContext): BuiltinUnitNodes {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const dry = ctx.createGain()
  const wet = ctx.createGain()
  input.connect(dry)
  dry.connect(output)
  wet.connect(output)
  return { input, output, dry, wet, extra: [input, output, dry, wet] }
}

/** Registers a unit's internal nodes so removing the track can tear them all down. */
function keep(unit: BuiltinUnitNodes, ...nodes: AudioNode[]): void {
  unit.extra.push(...nodes)
}

function createBuiltinChain(ctx: BaseAudioContext, rack: BuiltinFxRack): BuiltinChain {
  const dist = createUnitShell(ctx)
  const shaper = ctx.createWaveShaper()
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = rack.dist.params.tone
  shaper.connect(tone)
  tone.connect(dist.wet)
  dist.input.connect(shaper)
  dist.shaper = shaper
  dist.tone = tone
  keep(dist, shaper, tone)

  const chorus = createUnitShell(ctx)
  const chorusDelay = ctx.createDelay(0.08)
  chorusDelay.delayTime.value = 0.02
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = rack.chorus.params.rate
  const lfoDepth = ctx.createGain()
  lfoDepth.gain.value = rack.chorus.params.depth / 1000
  lfo.connect(lfoDepth)
  lfoDepth.connect(chorusDelay.delayTime)
  lfo.start(0)
  chorus.input.connect(chorusDelay)
  chorusDelay.connect(chorus.wet)
  chorus.lfo = lfo
  chorus.lfoDepth = lfoDepth
  chorus.delayNode = chorusDelay
  keep(chorus, chorusDelay, lfo, lfoDepth)

  const reverb = createUnitShell(ctx)
  const convolver = ctx.createConvolver()
  convolver.normalize = true
  convolver.buffer = makeImpulse(ctx, rack.reverb.params.decay)
  reverb.input.connect(convolver)
  convolver.connect(reverb.wet)
  reverb.convolver = convolver
  reverb.decay = rack.reverb.params.decay
  keep(reverb, convolver)

  const delay = createUnitShell(ctx)
  const delayNode = ctx.createDelay(2)
  delayNode.delayTime.value = rack.delay.params.time / 1000
  const feedback = ctx.createGain()
  feedback.gain.value = rack.delay.params.feedback
  delay.input.connect(delayNode)
  delayNode.connect(feedback)
  feedback.connect(delayNode)
  delayNode.connect(delay.wet)
  delay.delay = delayNode
  delay.feedback = feedback
  keep(delay, delayNode, feedback)

  const eq = createUnitShell(ctx)
  const eqLow = ctx.createBiquadFilter()
  eqLow.type = 'lowshelf'
  eqLow.frequency.value = rack.eq.params.eqLowFreq
  eqLow.gain.value = rack.eq.params.eqLowGain
  const eqMid = ctx.createBiquadFilter()
  eqMid.type = 'peaking'
  eqMid.frequency.value = rack.eq.params.eqMidFreq
  eqMid.gain.value = rack.eq.params.eqMidGain
  eqMid.Q.value = rack.eq.params.eqMidQ
  const eqHigh = ctx.createBiquadFilter()
  eqHigh.type = 'highshelf'
  eqHigh.frequency.value = rack.eq.params.eqHighFreq
  eqHigh.gain.value = rack.eq.params.eqHighGain
  eq.input.connect(eqLow)
  eqLow.connect(eqMid)
  eqMid.connect(eqHigh)
  eqHigh.connect(eq.wet)
  eq.eqLow = eqLow
  eq.eqMid = eqMid
  eq.eqHigh = eqHigh
  keep(eq, eqLow, eqMid, eqHigh)

  const comp = createUnitShell(ctx)
  const compNode = ctx.createDynamicsCompressor()
  compNode.threshold.value = rack.comp.params.compThreshold
  compNode.ratio.value = rack.comp.params.compRatio
  compNode.attack.value = rack.comp.params.compAttack / 1000
  compNode.release.value = rack.comp.params.compRelease / 1000
  compNode.knee.value = rack.comp.params.compKnee
  const compMakeup = ctx.createGain()
  comp.input.connect(compNode)
  compNode.connect(compMakeup)
  compMakeup.connect(comp.wet)
  comp.compNode = compNode
  comp.compMakeup = compMakeup
  keep(comp, compNode, compMakeup)

  // Gate: a static downward expander drawn as a curve, so it behaves the same
  // whether it is running live or inside the offline mixdown.
  const gate = createUnitShell(ctx)
  const gateShaper = ctx.createWaveShaper()
  gateShaper.oversample = 'none'
  gateShaper.curve = gateCurve(rack.gate.params.gateThreshold, rack.gate.params.gateRange) as any
  gate.input.connect(gateShaper)
  gateShaper.connect(gate.wet)
  gate.gateShaper = gateShaper
  gate.gateThreshold = rack.gate.params.gateThreshold
  keep(gate, gateShaper)

  // Saturator: soft clip, then a tone filter, then a make-up trim.
  const sat = createUnitShell(ctx)
  const satShaper = ctx.createWaveShaper()
  satShaper.oversample = '2x'
  satShaper.curve = saturationCurve(rack.sat.params.satDrive) as any
  const satTone = ctx.createBiquadFilter()
  satTone.type = 'lowpass'
  satTone.frequency.value = rack.sat.params.satTone
  const satTrimNode = ctx.createGain()
  satTrimNode.gain.value = dbToGain(rack.sat.params.satTrim)
  sat.input.connect(satShaper)
  satShaper.connect(satTone)
  satTone.connect(satTrimNode)
  satTrimNode.connect(sat.wet)
  sat.satShaper = satShaper
  sat.satTone = satTone
  sat.satTrim = satTrimNode
  keep(sat, satShaper, satTone, satTrimNode)

  // Tremolo: the LFO rides the wet path's own gain param.
  const trem = createUnitShell(ctx)
  const tremGain = ctx.createGain()
  const tremLfo = ctx.createOscillator()
  tremLfo.type = 'sine'
  tremLfo.frequency.value = rack.trem.params.tremRate
  const tremLfoDepth = ctx.createGain()
  const tremDepth = clampRange(rack.trem.params.tremDepth, 0, 1)
  tremGain.gain.value = 1 - tremDepth / 2
  tremLfoDepth.gain.value = tremDepth / 2
  tremLfo.connect(tremLfoDepth)
  tremLfoDepth.connect(tremGain.gain)
  tremLfo.start(0)
  trem.input.connect(tremGain)
  tremGain.connect(trem.wet)
  trem.tremGain = tremGain
  trem.tremLfo = tremLfo
  trem.tremLfoDepth = tremLfoDepth
  keep(trem, tremGain, tremLfo, tremLfoDepth)

  // De-esser: an honest split-band. The low part passes untouched; the band
  // above the crossover is rebuilt by subtracting that low-passed copy from the
  // input and only that band sees the compressor, so plosives and sibilants get
  // pulled down without dulling the rest of the voice.
  const deess = createUnitShell(ctx)
  const deessLow = ctx.createBiquadFilter()
  deessLow.type = 'lowpass'
  deessLow.frequency.value = rack.deess.params.deessFreq
  const deessBandSum = ctx.createGain()
  const deessInvert = ctx.createGain()
  deessInvert.gain.value = -1
  const deessComp = ctx.createDynamicsCompressor()
  deessComp.threshold.value = rack.deess.params.deessThreshold
  deessComp.ratio.value = rack.deess.params.deessRatio
  deessComp.attack.value = rack.deess.params.deessAttack / 1000
  deessComp.release.value = rack.deess.params.deessRelease / 1000
  deessComp.knee.value = 6
  const deessOut = ctx.createGain()
  deess.input.connect(deessLow)
  deess.input.connect(deessBandSum)
  deessLow.connect(deessInvert)
  deessInvert.connect(deessBandSum)
  deessBandSum.connect(deessComp)
  deessComp.connect(deessOut)
  deessLow.connect(deessOut)
  deessOut.connect(deess.wet)
  deess.deessLow = deessLow
  deess.deessBandSum = deessBandSum
  deess.deessComp = deessComp
  deess.deessOut = deessOut
  keep(deess, deessLow, deessInvert, deessBandSum, deessComp, deessOut)

  const limiter = createUnitShell(ctx)
  const limNode = ctx.createDynamicsCompressor()
  limNode.threshold.value = rack.limiter.params.limThreshold
  limNode.ratio.value = 20 // Brick wall
  limNode.attack.value = 0.001
  limNode.release.value = rack.limiter.params.limRelease / 1000
  limNode.knee.value = 0
  const limCeil = ctx.createGain()
  limCeil.gain.value = dbToGain(rack.limiter.params.limCeiling)
  limiter.input.connect(limNode)
  limNode.connect(limCeil)
  limCeil.connect(limiter.wet)
  limiter.limNode = limNode
  limiter.limCeil = limCeil
  keep(limiter, limNode, limCeil)

  // Units are self-contained; the signal order is wired dynamically so the
  // built-in effects can share the same reorderable chain as external plugins.
  // The ends of the chain follow BUILTIN_FX_IDS, so re-ordering the rack moves
  // the input and output with it.
  const units = { gate, sat, dist, eq, comp, deess, trem, chorus, delay, reverb, limiter } as Record<
    BuiltinFxId,
    BuiltinUnitNodes
  >
  const chain: BuiltinChain = {
    units,
    input: units[BUILTIN_FX_IDS[0]].input,
    output: units[BUILTIN_FX_IDS[BUILTIN_FX_IDS.length - 1]].output,
    state: rack,
  }
  for (const id of BUILTIN_FX_IDS) applyBuiltinUnit(chain.units[id], rack[id])
  return chain
}

/**
 * Connects the built-in units in series (default stompbox order). Track
 * chains get rewired dynamically per stage list; the master bus uses the
 * plain serial form. Safe to call on live and offline contexts.
 */
function wireBuiltinSerial(fx: BuiltinChain): void {
  let cursor: AudioNode = fx.units[BUILTIN_FX_IDS[0]].input
  for (const id of BUILTIN_FX_IDS) {
    const unit = fx.units[id]
    if (cursor !== unit.input) cursor.connect(unit.input)
    cursor = unit.output
  }
}

function applyMonoGains(
  gains: [GainNode, GainNode, GainNode, GainNode],
  mono: boolean,
  when: number,
): void {
  const [lToL, lToR, rToL, rToR] = gains
  const direct = mono ? 0.5 : 1
  const cross = mono ? 0.5 : 0
  lToL.gain.setTargetAtTime(direct, when, 0.01)
  rToR.gain.setTargetAtTime(direct, when, 0.01)
  lToR.gain.setTargetAtTime(cross, when, 0.01)
  rToL.gain.setTargetAtTime(cross, when, 0.01)
}

export function applyBuiltinUnit(nodes: BuiltinUnitNodes, unit: BuiltinFxUnit): void {
  const mix = unit.enabled ? Math.max(0, Math.min(1, unit.mix)) : 0
  nodes.dry.gain.value = 1 - mix
  nodes.wet.gain.value = mix

  const p = unit.params

  // Distortion
  if (nodes.shaper) nodes.shaper.curve = overdriveCurve(p.drive) as any
  if (nodes.tone) nodes.tone.frequency.value = p.tone

  // Chorus
  if (nodes.lfo) nodes.lfo.frequency.value = p.rate
  if (nodes.lfoDepth) nodes.lfoDepth.gain.value = p.depth / 1000

  // Reverb
  if (nodes.convolver && nodes.decay !== p.decay) {
    void nodes.convolver.context
    nodes.convolver.buffer = makeImpulse(nodes.convolver.context, p.decay)
    nodes.decay = p.decay
  }

  // Delay
  if (nodes.delay) nodes.delay.delayTime.value = Math.max(0.01, p.time / 1000)
  if (nodes.feedback) nodes.feedback.gain.value = Math.min(0.92, Math.max(0, p.feedback))

  // EQ
  if (nodes.eqLow) {
    nodes.eqLow.frequency.value = p.eqLowFreq
    nodes.eqLow.gain.value = p.eqLowGain
  }
  if (nodes.eqMid) {
    nodes.eqMid.frequency.value = p.eqMidFreq
    nodes.eqMid.gain.value = p.eqMidGain
    nodes.eqMid.Q.value = p.eqMidQ
  }
  if (nodes.eqHigh) {
    nodes.eqHigh.frequency.value = p.eqHighFreq
    nodes.eqHigh.gain.value = p.eqHighGain
  }

  // Compressor
  if (nodes.compNode) {
    nodes.compNode.threshold.value = p.compThreshold
    nodes.compNode.ratio.value = p.compRatio
    nodes.compNode.attack.value = p.compAttack / 1000
    nodes.compNode.release.value = p.compRelease / 1000
    nodes.compNode.knee.value = p.compKnee
  }
  // Output gain the UI promises as "makeup".
  if (nodes.compMakeup) nodes.compMakeup.gain.value = dbToGain(p.compMakeup)

  // Gate: static downward expander, rebuilt whenever the threshold or the
  // reduction range move. No attack/release because this curve has no memory.
  if (nodes.gateShaper) {
    nodes.gateShaper.curve = gateCurve(p.gateThreshold, p.gateRange) as any
    nodes.gateThreshold = p.gateThreshold
  }

  // Saturator
  if (nodes.satShaper) nodes.satShaper.curve = saturationCurve(p.satDrive) as any
  if (nodes.satTone) nodes.satTone.frequency.value = p.satTone
  if (nodes.satTrim) nodes.satTrim.gain.value = dbToGain(p.satTrim)

  // Tremolo: LfoDepth offsets the carrier gain so depth 1 reaches silence.
  if (nodes.tremLfo) nodes.tremLfo.frequency.value = p.tremRate
  if (nodes.tremGain && nodes.tremLfoDepth) {
    const depth = clampRange(p.tremDepth, 0, 1)
    nodes.tremGain.gain.value = 1 - depth / 2
    nodes.tremLfoDepth.gain.value = depth / 2
  }

  // De-esser: only the band above `deessFreq` is compressed.
  if (nodes.deessLow) nodes.deessLow.frequency.value = p.deessFreq
  if (nodes.deessComp) {
    nodes.deessComp.threshold.value = p.deessThreshold
    nodes.deessComp.ratio.value = p.deessRatio
    nodes.deessComp.attack.value = p.deessAttack / 1000
    nodes.deessComp.release.value = p.deessRelease / 1000
  }

  // Limiter
  if (nodes.limNode) {
    nodes.limNode.threshold.value = p.limThreshold
    nodes.limNode.release.value = p.limRelease / 1000
  }
  if (nodes.limCeil) nodes.limCeil.gain.value = dbToGain(p.limCeiling)
}

/**
 * Schedules a clip's edge fades on a per-playback gain node. `playOffset` is
 * how far into the buffer this playback starts, so a loop point that lands
 * inside the fade region picks the ramp up where it should be instead of
 * restarting it.
 *
 * The envelope itself is `fadeGainAt` - the same definition the offline render
 * and the mix-math tests use. This function only translates it into WebAudio
 * events, which is what makes a fade you drew in the timeline the fade that
 * reaches the exported file.
 */
function scheduleClipFade(
  shape: GainNode,
  t0: number,
  playOffset: number,
  clipEndSeconds: number,
  fadeIn: number,
  fadeOut: number,
): void {
  // A clip with nothing to play keeps its node transparent.
  if (!(clipEndSeconds > 0)) {
    shape.gain.setValueAtTime(1, t0)
    return
  }
  // Maps a clip time to context time; clamps because a playback that starts
  // past a point must not schedule events in the past.
  const at = (clipTime: number) => t0 + Math.max(0, clipTime - playOffset)
  const g = (clipTime: number) => fadeGainAt(clipTime, clipEndSeconds, fadeIn, fadeOut)
  const fin = clampRange(fadeIn, 0, clipEndSeconds)
  const fout = clampRange(fadeOut, 0, Math.max(0, clipEndSeconds - fin))

  shape.gain.setValueAtTime(g(playOffset), t0)
  if (fin > 0.0005 && playOffset < fin) shape.gain.linearRampToValueAtTime(g(fin), at(fin))
  if (fout > 0.0005) {
    const start = Math.max(playOffset, clipEndSeconds - fout)
    shape.gain.setValueAtTime(g(start), at(start))
    shape.gain.linearRampToValueAtTime(g(clipEndSeconds), at(clipEndSeconds))
  }
}

/**
 * Writes a volume-automation lane onto a gain param.
 *
 * Both the live graph and the offline render call this one function, which is
 * what guarantees that the ramp you drew is the ramp in the exported WAV.
 * Distances use `exponentialRampToValueAtTime`: equal ratios per equal time are
 * equal dB per second, so a straight line on the lane behaves like a straight
 * console fader move. The gain floor in `automationNodeGain` keeps a ramp away
 * from exactly zero, which WebAudio refuses to interpolate exponentially.
 *
 * `stepZeroTime` is the context time of step 0 (`fromStep` may be mid-lane when
 * playback resumed inside it) and `notBefore` is the earliest time an event may
 * land on - the current clock while rolling, zero for an offline render.
 */
function scheduleAutomationEnvelope(
  param: AudioParam,
  points: AutomationBreakpoint[],
  stepZeroTime: number,
  stepDuration: number,
  fromStep: number,
  notBefore: number,
): void {
  const timeOf = (step: number) => stepZeroTime + step * stepDuration
  const seedTime = Math.max(notBefore, timeOf(fromStep))
  param.cancelScheduledValues(seedTime)
  if (points.length === 0) {
    param.setValueAtTime(1, seedTime)
    return
  }
  param.setValueAtTime(Math.max(0.0001, automationGainAt(points, fromStep)), seedTime)
  for (const point of points) {
    if (point.step <= fromStep + 1e-6) continue
    const at = timeOf(point.step)
    if (at <= seedTime) continue
    param.exponentialRampToValueAtTime(automationNodeGain(point.value), at)
  }
}

export class AudioEngine {
  readonly ctx: AudioContext
  readonly masterGain: GainNode

  // Mix bus: tracks sum here, then pass through a full built-in FX rack
  // (glue EQ / compressor / limiter live here) before master volume.
  private readonly masterSum: GainNode
  private readonly masterFx: BuiltinChain
  private readonly reverbBus: SendBus
  private readonly delayBus: SendBus
  private sendConfig: SendConfig = defaultSendConfig()

  private readonly masterAnalyser: AnalyserNode
  /**
   * The chosen playback device, when there is one. A Web Audio graph cannot name
   * a card, so the mix is handed to a stream and a hidden media element plays that
   * stream on the device the producer picked; `null` on both means the mix still
   * leaves through the context's own destination.
   */
  private outputSink: MediaStreamAudioDestinationNode | null = null
  private outputElement: HTMLAudioElement | null = null
  private outputDevice = ''
  /**
   * The virtual cable to the call room, and the two nodes that make it a mix-minus.
   *
   * `callSend` hangs off the master fader and drains into a stream, so the fader
   * the producer rides really is the level the room gets. `callReturn` is where
   * the room comes back in: it joins the graph *after* that tap, on the way to the
   * speakers only. A hardware desk needs a second master bus to do this; here it
   * is one extra connect, and it is the reason a remote musician does not hear
   * their own drum kit come back a hundred milliseconds late.
   */
  private callSendNode: GainNode | null = null
  private callAnalyserNode: AnalyserNode | null = null
  private callSinkNode: MediaStreamAudioDestinationNode | null = null
  private callReturnNode: GainNode | null = null
  private callReturnAnalyser: AnalyserNode | null = null
  /** Um por canal remoto: o retorno que entra pelos alto-falantes sem voltar pelo cabo. */
  private readonly callReturnFeeds = new Map<
    string,
    { source: MediaStreamAudioSourceNode; gain: GainNode }
  >()
  /**
   * O que o ganho do envio deveria ser, separado em duas causas. O fader do cabo
   * e o botão de mudo mexem no mesmo parâmetro do mesmo nó, e quem gravasse só um
   * deles esqueceria o outro ao mexer no primeiro — em uma mesa isso não acontece
   * porque o trim é um atenuador e o mudo é uma porta; aqui são dois campos e um
   * único `applyCallSendGain()` que os multiplica.
   */
  private callSendDb = 0
  private callSendMuted = false
  /**
   * Live BS.1770 meter on the master bus, attached when the app asks for it.
   * It runs on the audio thread and posts one reading per 100 ms window, so the
   * number on screen is the same measurement the exported file gets - not a
   * sample of a sample taken whenever a frame happened to arrive.
   */
  private loudnessNode: AudioWorkletNode | null = null
  private loudnessSink: GainNode | null = null
  private loudnessReading: LiveLoudness | null = null
  /**
   * Called with every reading the meter closes - ten times a second while the
   * audio thread runs. Message driven rather than polled, because a poll only
   * sees whatever was last posted, and a frame that arrived late in a hidden tab
   * would otherwise freeze the number on screen at a moment that already passed.
   */
  onLoudness: ((reading: LiveLoudness) => void) | null = null
  /** One registration attempt at a time, shared by whoever asks first. */
  private loudnessPatch: Promise<void> | null = null
  private readonly tracks = new Map<string, EngineTrack>()
  /** Sub-group buses, keyed by group id. */
  private readonly groups = new Map<string, GroupBus>()
  private readonly sources: AudioBufferSourceNode[] = []
  // Live instrument voices share a per-note gate; disconnecting the gate
  // silences every node of the voice at once (seek, stop, loop restart).
  private readonly voiceGates: Array<{ gate: GainNode; timer: number }> = []
  private readonly inputs = new Map<string, InputEntry>()
  /** Capture streams shared by every lane reading the same device. */
  private readonly sharedStreams = new Map<string, SharedStream>()
  private readonly recorders = new Map<string, RecorderEntry>()
  // Peak-per-chunk of each running take, handed to its lane so the waveform
  // grows while the producer plays instead of only after the take stops.
  private readonly takePeaks = new Map<string, { peaks: Float32Array; written: number; reported: number }>()
  /** Called (throttled) while a take is running: peaks so far, seconds so far. */
  onTakeProgress: ((trackId: string, peaks: number[], seconds: number) => void) | null = null

  /**
   * A worklet name is only registered inside the context it was added to, so the
   * set lives per context: a second export builds a fresh OfflineAudioContext and
   * has to run `addModule` again, or its plugin nodes would fail to be created.
   */
  private readonly loadedWorklets = new WeakMap<BaseAudioContext, Set<string>>()
  /** In-flight `addModule` calls, so two tracks asking at once share one. */
  private readonly workletLoads = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>()

  private namEnginePromise: Promise<NamEngine> | null = null
  /**
   * Context time of step 0 for the current playback pass, and the length of a
   * 16th. Automation is written in steps but scheduled in seconds, so the graph
   * needs this translation while the song rolls.
   */
  private songOriginTime: number | null = null
  private songStepDuration = 0.125
  private masterVolume = 0.9
  private masterMuted = false

  constructor() {
    const Ctor = getAudioContextCtor()
    this.ctx = new Ctor()

    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this.masterVolume

    this.masterAnalyser = this.ctx.createAnalyser()
    this.masterAnalyser.fftSize = 256

    this.masterSum = this.ctx.createGain()
    this.masterFx = createBuiltinChain(this.ctx, defaultBuiltinFx())
    wireBuiltinSerial(this.masterFx)
    this.masterSum.connect(this.masterFx.input)
    this.masterFx.output.connect(this.masterGain)

    this.reverbBus = this.createSendBus('reverb')
    this.delayBus = this.createSendBus('delay')

    this.masterGain.connect(this.masterAnalyser)
    this.masterAnalyser.connect(this.ctx.destination)
  }

  private createSendBus(
    kind: 'reverb' | 'delay',
    ctx: BaseAudioContext = this.ctx,
    destination?: AudioNode,
  ): SendBus {
    const input = ctx.createGain()
    const output = ctx.createGain()
    const dest = destination ?? this.masterSum
    if (kind === 'reverb') {
      const convolver = ctx.createConvolver()
      convolver.normalize = true
      convolver.buffer = makeImpulse(ctx, this.sendConfig.rvDecay)
      input.connect(convolver)
      convolver.connect(output)
      output.gain.value = this.sendConfig.rvReturn
      const bus: SendBus = { input, output, convolver, decay: this.sendConfig.rvDecay }
      output.connect(dest)
      return bus
    }
    const delayNode = ctx.createDelay(2)
    delayNode.delayTime.value = this.sendConfig.dlTime / 1000
    const feedback = ctx.createGain()
    feedback.gain.value = Math.min(0.92, this.sendConfig.dlFeedback)
    input.connect(delayNode)
    delayNode.connect(feedback)
    feedback.connect(delayNode)
    delayNode.connect(output)
    output.gain.value = this.sendConfig.dlReturn
    const bus: SendBus = { input, output, delayNode, feedback }
    output.connect(dest)
    return bus
  }

  /**
   * Ask the browser to start the clock.
   *
   * A page that has not seen a gesture yet can keep `resume()` waiting, and a
   * plugin restore that waits on it never builds its graph — the producer would
   * open the project and find no amps at all. So the wait is bounded: the nodes
   * are created either way, and the audio starts the moment the producer plays.
   */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'suspended') return
    await Promise.race([
      this.ctx.resume().catch(() => undefined),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, 300)
      }),
    ])
  }

  // ---------------------------------------------------------------- master

  setMasterVolume(value: number): void {
    this.masterVolume = value
    if (!this.masterMuted) {
      this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01)
    }
  }

  setMasterMuted(muted: boolean): void {
    this.masterMuted = muted
    this.masterGain.gain.setTargetAtTime(
      muted ? 0 : this.masterVolume,
      this.ctx.currentTime,
      0.01,
    )
  }

  getMasterLevel(): number {
    return measurePeak(this.masterAnalyser)
  }

  // ------------------------------------------------------- cabo virtual (chamada)

  /**
   * Build, once, the cable that carries the mix out to a call room.
   *
   * It is lazy because the nodes belong to this context and a producer who never
   * opens a call should not pay for a stream destination and a meter they will not
   * read. Everything hangs off `masterGain`, which is the master fader: pull it
   * down and the room gets quieter, exactly like unpluging a send cable halfway.
   */
  ensureCallCable(): { send: GainNode; stream: MediaStream } {
    if (this.callSendNode && this.callSinkNode) {
      return { send: this.callSendNode, stream: this.callSinkNode.stream }
    }
    const send = this.ctx.createGain()
    // A cable rebuilt after a release starts from the settings the window still
    // shows, not from unity — otherwise the trim on screen would be a lie.
    send.gain.value = this.callSendMuted ? 0 : 10 ** (this.callSendDb / 20)
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0
    const sink = this.ctx.createMediaStreamDestination()
    this.masterGain.connect(send)
    send.connect(analyser)
    analyser.connect(sink)
    this.callSendNode = send
    this.callAnalyserNode = analyser
    this.callSinkNode = sink
    return { send, stream: sink.stream }
  }

  /** O que sai pelo cabo, em pico 0..1 — o medidor do jack, não o do master. */
  getCallSendLevel(): number {
    return this.callAnalyserNode ? measurePeak(this.callAnalyserNode) : 0
  }

  /** Nível do que chega da sala (só existe enquanto houver retorno patcheado). */
  getCallReturnLevel(): number {
    if (!this.callReturnNode) return 0
    if (!this.callReturnAnalyser) {
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0
      this.callReturnNode.connect(analyser)
      this.callReturnAnalyser = analyser
    }
    return measurePeak(this.callReturnAnalyser)
  }

  setCallSendDb(value: number): void {
    this.callSendDb = Number.isFinite(value) ? Math.max(-90, Math.min(12, value)) : 0
    this.applyCallSendGain()
  }

  get callSendTrimDb(): number {
    return this.callSendDb
  }

  /**
   * Mudo do cabo: a sala deixa de ouvir a DAW, e a DAW continua ouvindo a sala.
   * É o botão "mix minus" de uma mesa, não o mute do canal — nada aqui toca o
   * master fader, então os alto-falantes seguem fazendo o que fazem.
   */
  setCallSendMuted(muted: boolean): void {
    this.callSendMuted = muted
    this.applyCallSendGain()
  }

  get isCallSendMuted(): boolean {
    return this.callSendMuted
  }

  private applyCallSendGain(): void {
    if (!this.callSendNode) return
    const gain = this.callSendMuted ? 0 : 10 ** (this.callSendDb / 20)
    this.callSendNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01)
  }

  /**
   * O ponto de entrada do retorno da sala. Ele se liga ao `masterAnalyser`, que é
   * justamente o nó que a janela de saída já escolhe como caminho para a caixa de
   * som: assim o retorno obedece ao dispositivo roteado sem que o roteamento
   * precise saber que a chamada existe.
   */
  get callReturn(): GainNode {
    if (!this.callReturnNode) {
      const node = this.ctx.createGain()
      node.gain.value = 1
      node.connect(this.masterAnalyser)
      this.callReturnNode = node
    }
    return this.callReturnNode
  }

  /**
   * Põe o retorno da sala no caminho dos alto-falantes sem voltar pelo cabo.
   *
   * A faixa gravável do participante já imprime o que chega (`connectCallInput`),
   * mas o monitor dele entra por aqui, depois do ponto de envio: é o que evita que
   * o outro músico escute a própria bateria atrasada. Um `key` por canal, para o
   * app poder desligar exatamente o que apagou.
   */
  connectCallReturn(key: string, stream: MediaStream, listen = true): void {
    const existing = this.callReturnFeeds.get(key)
    if (existing) {
      try {
        existing.source.disconnect()
        existing.gain.disconnect()
      } catch {
        /* re-patch do mesmo canal */
      }
    }
    const source = this.ctx.createMediaStreamSource(stream)
    const gain = this.ctx.createGain()
    gain.gain.value = listen ? 1 : 0
    source.connect(gain)
    gain.connect(this.callReturn)
    this.callReturnFeeds.set(key, { source, gain })
  }

  /**
   * O nível de escuta de um canal da sala — a lâmpada IN da faixa dele.
   *
   * Fica no retorno, e não na mixagem da faixa, por um motivo: o fader da faixa
   * alimenta o master, e o master é o que sai pelo cabo. Abrir a escuta por ali
   * faria o músico do outro lado ouvir a si mesmo com o atraso da rede, que é o
   * eco que quebra qualquer jam. Por aqui ele some dos seus alto-falantes sem
   * mudar nada do que a sala recebe.
   */
  setCallReturnGain(key: string, value: number): void {
    const feed = this.callReturnFeeds.get(key)
    if (!feed) return
    const gain = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0
    feed.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02)
  }

  getCallReturnGain(key: string): number {
    return this.callReturnFeeds.get(key)?.gain.gain.value ?? 0
  }

  /** As chaves de retorno ligadas agora, para quem desmonta o cabo por completo. */
  callReturnKeys(): string[] {
    return [...this.callReturnFeeds.keys()]
  }

  disconnectCallReturn(key: string): void {
    const feed = this.callReturnFeeds.get(key)
    if (!feed) return
    try {
      feed.source.disconnect()
      feed.gain.disconnect()
    } catch {
      /* já solto */
    }
    this.callReturnFeeds.delete(key)
  }

  /** Solta o cabo de vez: a faixa do stream morre e os nós saem da cadeia. */
  releaseCallCable(): void {
    try {
      this.callSendNode?.disconnect()
      this.callAnalyserNode?.disconnect()
      this.callSinkNode?.stream.getTracks().forEach((track) => track.stop())
    } catch {
      /* já solto */
    }
    this.callSendNode = null
    this.callAnalyserNode = null
    this.callSinkNode = null
  }

  /**
   * How much the master compressor and limiter are squeezing, in dB of gain
   * reduction (0 means neither is working). `reduction` is the browser's own
   * audio-thread measurement, so the meter shows what the master is really doing
   * rather than what the knobs suggest it should do.
   */
  getMasterReduction(): number {
    const comp = this.masterFx.units.comp
    const limiter = this.masterFx.units.limiter
    const working = (unit: BuiltinUnitNodes, active: boolean): number => {
      if (!active) return 0
      const node = unit.compNode ?? unit.limNode
      return node ? node.reduction : 0
    }
    return (
      working(comp, this.masterFx.state.comp.enabled) +
      working(limiter, this.masterFx.state.limiter.enabled)
    )
  }

  /**
   * Attach the live loudness meter to the master bus.
   *
   * It taps the signal after the master fader and after the master FX, which is
   * the same place the export measures, and it is only ever created on the live
   * context: the offline render computes its own loudness from the bytes it
   * wrote, so it has no use for a meter and no reason to pay for one.
   */
  async enableLoudnessMeter(): Promise<void> {
    if (this.loudnessNode) return
    if (!this.loudnessPatch) {
      this.loudnessPatch = this.patchLoudnessMeter().catch((error) => {
        // A worklet that failed to register must not fail forever: forget the
        // attempt so the next call can try again after a reload of the page.
        this.loudnessPatch = null
        throw error
      })
    }
    await this.loudnessPatch
  }

  private async patchLoudnessMeter(): Promise<void> {
    await this.ensureWorkletModule(this.ctx, LOUDNESS_PROCESSOR_NAME, LOUDNESS_WORKLET_SOURCE)
    if (this.loudnessNode && this.loudnessSink) return
    const node = new AudioWorkletNode(this.ctx, LOUDNESS_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    node.port.onmessage = (event: MessageEvent<LiveLoudness>) => {
      this.loudnessReading = event.data
      // Only while the thread is actually running: a reading posted the moment
      // before a pause is not a measurement of anything happening now.
      if (this.ctx.state === 'running') this.onLoudness?.(event.data)
    }
    // A processor whose output goes nowhere is not pulled, and a meter that is
    // never pulled never closes a window. Give it a silent way out of the graph.
    const sink = this.ctx.createGain()
    sink.gain.value = 0
    node.connect(sink)
    sink.connect(this.ctx.destination)
    this.masterGain.connect(node)
    this.loudnessNode = node
    this.loudnessSink = sink
  }

  /**
   * The last reading the master produced, or null when there is nothing honest
   * to show: the meter is not attached, the audio thread is paused - and a
   * number from before the pause describes a moment that is not happening - or
   * the first 400 ms window has not closed yet.
   */
  getMasterLoudness(): LiveLoudness | null {
    if (!this.loudnessNode || this.ctx.state !== 'running') return null
    return this.loudnessReading
  }

  /**
   * Forget the window. A new project is not the tail of the one that was just
   * on screen, and a three second mean that still carries the old mix would be
   * the first dishonest number in the app.
   */
  resetLoudnessMeter(): void {
    this.loudnessNode?.port.postMessage('reset')
    this.loudnessReading = null
  }

  // ------------------------------------------------------------ sub-groups
  /**
   * Create a sub-group bus. Members are tracks whose `groupId` names it; their
   * output lands on `input` and leaves through the group fader, so one move of
   * this fader moves every member - which is exactly what the export does too.
   */
  addGroup(id: string, volume = 1, pan = 0): void {
    if (this.groups.has(id)) return
    const input = this.ctx.createGain()
    const panner = this.ctx.createStereoPanner()
    const analyser = this.ctx.createAnalyser()
    const output = this.ctx.createGain()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.55
    panner.pan.value = pan
    output.gain.value = this.groupsGain(volume, false)
    input.connect(panner)
    panner.connect(output)
    output.connect(analyser)
    analyser.connect(this.masterSum)
    this.groups.set(id, { input, panner, analyser, output, volume, pan, muted: false })
  }

  hasGroup(id: string): boolean {
    return this.groups.has(id)
  }

  listGroups(): string[] {
    return [...this.groups.keys()]
  }

  /** Every member is rewired to the master before the bus disappears. */
  removeGroup(id: string): void {
    const group = this.groups.get(id)
    if (!group) return
    for (const [trackId, track] of this.tracks) {
      if (track.groupId === id) this.setTrackGroup(trackId, '')
    }
    group.input.disconnect()
    group.panner.disconnect()
    group.analyser.disconnect()
    group.output.disconnect()
    this.groups.delete(id)
  }

  /**
   * Route a track's post-fader output to a group ('' = straight to master).
   * Only that one edge moves: the buffer, plugins and sends of the track stay
   * exactly as they were.
   */
  setTrackGroup(trackId: string, groupId: string): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    const target = this.groups.has(groupId) ? groupId : ''
    if (track.groupId === target) return
    track.groupId = target
    track.analyser.disconnect()
    track.analyser.connect(this.groupInput(target))
  }

  setGroupVolume(id: string, value: number): void {
    const group = this.groups.get(id)
    if (!group) return
    group.volume = value
    group.output.gain.setTargetAtTime(
      this.groupsGain(value, group.muted),
      this.ctx.currentTime,
      0.01,
    )
  }

  setGroupPan(id: string, value: number): void {
    const group = this.groups.get(id)
    if (!group) return
    group.pan = value
    group.panner.pan.setTargetAtTime(value, this.ctx.currentTime, 0.01)
  }

  setGroupMuted(id: string, muted: boolean): void {
    const group = this.groups.get(id)
    if (!group) return
    group.muted = muted
    group.output.gain.setTargetAtTime(
      this.groupsGain(group.volume, muted),
      this.ctx.currentTime,
      0.01,
    )
  }

  getGroupLevel(id: string): number {
    const group = this.groups.get(id)
    return group ? measurePeak(group.analyser) : 0
  }

  private groupsGain(volume: number, muted: boolean): number {
    return muted ? 0 : Math.max(0, volume)
  }

  private groupInput(groupId: string): AudioNode {
    const group = this.groups.get(groupId)
    return group ? group.input : this.masterSum
  }

  // --------------------------------------------------------------- sidechain

  /**
   * Make one track duck whenever others speak - kick against bass, voice against
   * music, kick *and* snare against a rhythm guitar. `sourceIds` of [] removes
   * the duck.
   *
   * Every source lands on the same follower input, so their signals add before
   * the envelope is measured - the same summing amp an external compressor has.
   *
   * The envelope is followed on the audio thread by the shared worklet, and the
   * result drives `duckGain.gain` directly, so the same numbers run in the
   * offline render: what you hear ducked is what the file exports.
   */
  async setSidechainDuck(trackId: string, sourceIds: string[], depth = 0.7): Promise<void> {
    const track = this.tracks.get(trackId)
    if (!track) return
    const level = clampRange(depth, 0, 1)
    track.duckDepth = level
    const wanted = normalizeDuckSources(sourceIds, trackId, this.tracks.keys())

    // Claimed or live, the right sources are already recorded: then only the
    // depth moves, and a second call cannot start a second follower.
    if (sameIdList(track.duckSourceIds, wanted)) {
      track.duck?.follower.parameters.get('depth')?.setValueAtTime(level, this.ctx.currentTime)
      return
    }
    if (wanted.length === 0) {
      this.releaseDuck(track)
      return
    }
    // Record the claim before awaiting the module, so concurrent calls for the
    // same duck cannot both reach the build step. The last one to arrive owns it.
    track.duckSourceIds = wanted
    await this.buildDuck(trackId, wanted, level)
  }

  /** Which tracks currently open this track's gate, in the order they were added. */
  getSidechainSources(trackId: string): string[] {
    return [...(this.tracks.get(trackId)?.duckSourceIds ?? [])]
  }

  /**
   * The follower's output is connected to `duckGain.gain`, whose intrinsic value
   * must be 0: an AudioParam adds its own value to every connected input, so a
   * leftover 1 would put the whole duck back under the signal.
   *
   * Adding or removing a source keeps the existing follower: its envelope has
   * memory (attack and release), and throwing it away would make the duck hiccup
   * at the moment the producer is only trying to change who controls it.
   */
  private async buildDuck(trackId: string, wanted: string[], depth: number): Promise<void> {
    await this.ensureWorkletModule(this.ctx, SIDECHAIN_PROCESSOR_NAME, SIDECHAIN_WORKLET_SOURCE)
    // Either the track is gone, or a later call has since claimed a different
    // list; that call does the wiring, and honouring this one would undo it.
    const track = this.tracks.get(trackId)
    if (!track || !sameIdList(track.duckSourceIds, wanted)) return

    let link = track.duck
    if (!link) {
      const follower = new AudioWorkletNode(this.ctx, SIDECHAIN_PROCESSOR_NAME, {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      // A worklet whose only destination is an AudioParam is not pulled by Chrome,
      // so give the control signal a silent way out of the graph.
      const sink = this.ctx.createGain()
      sink.gain.value = 0
      follower.connect(sink)
      sink.connect(this.masterSum)
      follower.connect(track.duckGain.gain)
      track.duckGain.gain.value = 0
      link = { follower, sink, sources: [] }
      track.duck = link
    }
    link.follower.parameters.get('depth')?.setValueAtTime(depth, this.ctx.currentTime)

    const still = new Set(wanted)
    for (const id of link.sources) {
      if (still.has(id)) continue
      // A source that is gone with its track needs no unplugging; its nodes were
      // disconnected when it was removed.
      this.tracks.get(id)?.monoMerger.disconnect(link.follower)
    }
    const wired: string[] = []
    for (const id of wanted) {
      const source = this.tracks.get(id)
      if (!source) continue
      if (!link.sources.includes(id)) source.monoMerger.connect(link.follower)
      wired.push(id)
    }
    link.sources = wired
  }

  /** Tear the control path down and hand the fader back to the track. */
  private releaseDuck(track: EngineTrack): void {
    if (track.duck) {
      for (const id of track.duck.sources) {
        this.tracks.get(id)?.monoMerger.disconnect(track.duck.follower)
      }
      track.duck.follower.disconnect()
      track.duck.follower.disconnect(track.duckGain.gain)
      track.duck.sink.disconnect()
      track.duck = null
    }
    track.duckSourceIds = []
    track.duckGain.gain.value = 1
  }

  /**
   * Register a worklet from source text once per context. Callers that arrive
   * together share one promise: two `addModule` calls racing on the same
   * processor name throw, and a duck turned on while the export runs would
   * otherwise be enough to trip it.
   */
  private async ensureWorkletModule(
    ctx: BaseAudioContext,
    processorName: string,
    source: string,
  ): Promise<void> {
    const registered = this.workletNamesFor(ctx)
    if (registered.has(processorName)) return
    const loads = this.workletLoadsFor(ctx)
    const pending = loads.get(processorName)
    if (pending) {
      await pending
      return
    }
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
    const load = (async () => {
      try {
        await ctx.audioWorklet.addModule(url)
        registered.add(processorName)
      } finally {
        URL.revokeObjectURL(url)
        loads.delete(processorName)
      }
    })()
    loads.set(processorName, load)
    await load
  }

  private workletNamesFor(ctx: BaseAudioContext): Set<string> {
    let names = this.loadedWorklets.get(ctx)
    if (!names) {
      names = new Set<string>()
      this.loadedWorklets.set(ctx, names)
    }
    return names
  }

  private workletLoadsFor(ctx: BaseAudioContext): Map<string, Promise<void>> {
    let loads = this.workletLoads.get(ctx)
    if (!loads) {
      loads = new Map<string, Promise<void>>()
      this.workletLoads.set(ctx, loads)
    }
    return loads
  }

  // ---------------------------------------------------------------- tracks

  addTrack(id: string, volume = 1, pan = 0): void {
    // Never stack two graphs on one id: the old nodes would stay wired to the
    // mix bus and keep contributing to the output.
    if (this.tracks.has(id)) this.removeTrack(id)
    const panner = this.ctx.createStereoPanner()
    const fxInput = this.ctx.createGain()
    const shaper = this.ctx.createWaveShaper()
    const filter = this.ctx.createBiquadFilter()
    const fx = createBuiltinChain(this.ctx, defaultBuiltinFx())
    const namSplit = this.ctx.createGain()
    const namSum = this.ctx.createGain()
    const gain = this.ctx.createGain()
    // The chain's own output, sitting in front of the fader: a take recorded with
    // the lane's effects is the sound the chain made, while the fader stays a mix
    // decision the producer can still change after the performance.
    const recordPoint = this.ctx.createGain()
    const autoGain = this.ctx.createGain()
    const analyser = this.ctx.createAnalyser()
    // Mono fold-down lives between the track gain and the analyser so the meter
    // still shows what actually reaches the mix.
    const monoSplitter = this.ctx.createChannelSplitter(2)
    const monoMerger = this.ctx.createChannelMerger(2)
    const monoGains: [GainNode, GainNode, GainNode, GainNode] = [
      this.ctx.createGain(),
      this.ctx.createGain(),
      this.ctx.createGain(),
      this.ctx.createGain(),
    ]
    const rvSend = this.ctx.createGain()
    const dlSend = this.ctx.createGain()
    const duckGain = this.ctx.createGain()

    analyser.fftSize = 256
    gain.gain.value = volume
    panner.pan.value = pan
    filter.type = 'allpass'
    filter.frequency.value = 20000
    monoGains[0].gain.value = 1
    monoGains[1].gain.value = 0
    monoGains[2].gain.value = 0
    monoGains[3].gain.value = 1
    rvSend.gain.value = 0
    dlSend.gain.value = 0
    duckGain.gain.value = 1

    const track: EngineTrack = {
      panner,
      fxInput,
      shaper,
      filter,
      fx,
      chain: BUILTIN_FX_IDS.map((fxId) => ({ kind: 'builtin', id: fxId })),
      namSplit,
      namSum,
      gain,
      recordPoint,
      clipMute: null,
      autoGain,
      automation: [],
      analyser,
      trim: 1,
      phase: 1,
      mono: false,
      monoSplitter,
      monoMerger,
      monoGains,
      rvSend,
      dlSend,
      duckGain,
      duck: null,
      duckSourceIds: [],
      duckDepth: 0.7,
      plugins: [],
      muted: false,
      volume,
      pan,
      groupId: '',
      buffer: null,
      bufferLabel: '',
      monitor: null,
      clipStart: 0,
      clipDuration: 0,
      fadeIn: 0.005,
      fadeOut: 0.005,
      instrument: null,
      notes: [],
      patternSteps: 0,
      voice: '',
    }
    this.tracks.set(id, track)

    this.rewire(id)

    gain.connect(autoGain)
    autoGain.connect(monoSplitter)
    // 0: L -> L   1: L -> R   2: R -> L   3: R -> R
    monoSplitter.connect(monoGains[0], 0)
    monoSplitter.connect(monoGains[1], 0)
    monoSplitter.connect(monoGains[2], 1)
    monoSplitter.connect(monoGains[3], 1)
    monoGains[0].connect(monoMerger, 0, 0)
    monoGains[1].connect(monoMerger, 0, 1)
    monoGains[2].connect(monoMerger, 0, 0)
    monoGains[3].connect(monoMerger, 0, 1)
    monoMerger.connect(duckGain)
    duckGain.connect(analyser)
    analyser.connect(this.groupInput(track.groupId))
    duckGain.connect(rvSend)
    rvSend.connect(this.reverbBus.input)
    duckGain.connect(dlSend)
    dlSend.connect(this.delayBus.input)
  }

  /**
   * Whether the graph for `id` already exists. Callers that re-apply a full
   * track state must check this first: `addTrack` builds a brand new node
   * graph, so rebuilding a live track would drop its buffer and its loaded
   * NAM/IR plugins.
   */
  hasTrack(id: string): boolean {
    return this.tracks.has(id)
  }

  removeTrack(id: string): void {
    const track = this.tracks.get(id)
    if (!track) return
    this.disconnectInput(id)
    this.stopTrackRecorder(id)
    track.plugins.forEach((plugin) => plugin.dispose())
    track.panner.disconnect()
    track.fxInput.disconnect()
    track.shaper.disconnect()
    track.filter.disconnect()
    track.namSplit.disconnect()
    track.namSum.disconnect()
    // Every node a unit created is in its `extra` list, including the internal
    // wiring (shapers, LFOs, band splits, makeup gains) that used to leak when
    // only the shell was disconnected. Oscillators are stopped as well - a
    // running OscillatorNode keeps its context slice alive even when unplugged.
    for (const unit of Object.values(track.fx.units)) {
      unit.lfo?.stop()
      unit.tremLfo?.stop()
      for (const node of unit.extra) node.disconnect()
    }
    track.gain.disconnect()
    track.autoGain.disconnect()
    track.analyser.disconnect()
    track.monoSplitter.disconnect()
    track.monoMerger.disconnect()
    for (const stage of track.monoGains) stage.disconnect()
    track.rvSend.disconnect()
    track.dlSend.disconnect()
    this.releaseDuck(track)
    track.duckGain.disconnect()
    // A track that was ducked by this one loses that source: the others it was
    // listening to keep working, and only a track left with nobody to follow is
    // handed its fader back.
    for (const other of this.tracks.values()) {
      if (other === track || !other.duckSourceIds.includes(id)) continue
      const rest = other.duckSourceIds.filter((sourceId) => sourceId !== id)
      if (rest.length === 0) {
        this.releaseDuck(other)
        continue
      }
      const link = other.duck
      if (link) {
        // The removed track's own outputs were unplugged above, so only the
        // follower's guest list needs updating.
        link.sources = link.sources.filter((sourceId) => sourceId !== id)
      }
      other.duckSourceIds = rest
    }
    this.tracks.delete(id)
  }

  private rewire(id: string): void {
    const track = this.tracks.get(id)
    if (!track) return

    track.panner.disconnect()
    track.fxInput.disconnect()
    track.recordPoint.disconnect()
    track.shaper.disconnect()
    track.filter.disconnect()
    track.namSplit.disconnect()
    track.namSum.disconnect()
    for (const plugin of track.plugins) plugin.output.disconnect()
    for (const unit of Object.values(track.fx.units)) unit.output.disconnect()

    track.panner.connect(track.fxInput)
    track.fxInput.connect(track.shaper)
    track.shaper.connect(track.filter)

    const plugins = new Map(track.plugins.map((plugin) => [plugin.id, plugin]))

    // Identify parallel branches: each branch begins with an enabled NAM stage.
    // Subsequent enabled IR or worklet stages before the next NAM/builtin belong
    // to that branch (e.g. NAM1 -> IR1).
    //
    // A native plugin never joins a branch. An amp, a pedal and a second amp are
    // three stages in a row, the way a rack is bolted together, and folding the
    // pedal into one of the amp paths would put it in a lane the producer did not
    // choose — so it breaks the branch and is wired in series below.
    interface Branch {
      id: string
      plugins: PluginInstance[]
    }
    const branches: Branch[] = []
    const branchPluginIds = new Set<string>()

    let currentBranch: Branch | null = null
    for (const stage of track.chain) {
      if (stage.kind === 'builtin') {
        currentBranch = null
        continue
      }
      const plugin = plugins.get(stage.id)
      if (!plugin || !plugin.enabled) continue

      if (plugin.kind === 'nam') {
        currentBranch = { id: plugin.id, plugins: [plugin] }
        branches.push(currentBranch)
        branchPluginIds.add(plugin.id)
      } else if (currentBranch) {
        currentBranch.plugins.push(plugin)
        branchPluginIds.add(plugin.id)
      }
    }

    let cursor: AudioNode = track.filter
    let parallelConnected = false

    for (const stage of track.chain) {
      if (branchPluginIds.has(stage.id)) {
        if (!parallelConnected && branches.length > 0) {
          cursor.connect(track.namSplit)
          for (const branch of branches) {
            let bCursor: AudioNode = track.namSplit
            for (const plugin of branch.plugins) {
              bCursor.connect(plugin.input)
              bCursor = plugin.output
            }
            bCursor.connect(track.namSum)
          }
          cursor = track.namSum
          parallelConnected = true
        }
        continue
      }

      if (stage.kind === 'builtin') {
        const unit = track.fx.units[stage.id]
        cursor.connect(unit.input)
        cursor = unit.output
        continue
      }

      const plugin = plugins.get(stage.id)
      if (!plugin || !plugin.enabled) continue

      cursor.connect(plugin.input)
      cursor = plugin.output
    }

    cursor.connect(track.gain)
    // The same pass, one branch earlier: what a wet take records is the chain's
    // output before the fader, so the mix stays editable after the performance.
    cursor.connect(track.recordPoint)

    // A take printed from the end of the chain survives an edit of that chain.
    // The disconnect at the top of this method cut the branch the recorder was
    // reading, so the running tap is put back on the new end of the road instead
    // of stopping at the length it had reached.
    const running = this.recorders.get(id)
    if (running?.wet) {
      track.recordPoint.connect(running.node)
      track.recordPoint.connect(running.analyser)
    }
  }

  setChainOrder(trackId: string, ids: string[]): void {
    const track = this.tracks.get(trackId)
    if (!track) return

    const chain: ChainStage[] = []
    const pluginSeen = new Set<string>()
    for (const id of ids) {
      if (id.startsWith('fx:')) {
        const fxId = id.slice(3) as BuiltinFxId
        if (!BUILTIN_FX_IDS.includes(fxId)) continue
        if (chain.some((stage) => stage.kind === 'builtin' && stage.id === fxId)) continue
        chain.push({ kind: 'builtin', id: fxId })
      } else {
        const plugin = track.plugins.find((item) => item.id === id)
        if (!plugin || pluginSeen.has(id)) continue
        pluginSeen.add(id)
        chain.push({ kind: 'plugin', id })
      }
    }
    // A built-in unit is wired because the chain says so: the producer adds it
    // and removes it, and a unit that is not in the list does not touch the
    // signal. Plugins are different — a file the producer loaded is never
    // dropped from the path just because the order list forgot it.
    for (const plugin of track.plugins) {
      if (!pluginSeen.has(plugin.id)) chain.push({ kind: 'plugin', id: plugin.id })
    }

    track.chain = chain
    this.rewire(trackId)
  }

  /**
   * Put a plugin instance on the track and in its signal path.
   *
   * A plugin is only half back until the chain names it: an instance that sits
   * in the rack but not in the list is a card with knobs and no audio, which is
   * exactly how a restored NAM used to come back. `insertPluginIntoChain` is
   * idempotent, so a caller that will re-apply the saved order right after loses
   * nothing by the plugin landing at a provisional spot first.
   */
  private registerPlugin(track: EngineTrack, plugin: PluginInstance): void {
    if (track.plugins.some((item) => item.id === plugin.id)) {
      // The id is taken: this instance lost a race between two restores. Take it
      // off the graph instead of leaving it silent and undisposable.
      plugin.dispose()
      return
    }
    track.plugins.push(plugin)
    this.insertPluginIntoChain(track, plugin.id)
  }

  private insertPluginIntoChain(track: EngineTrack, pluginId: string): void {
    if (track.chain.some((entry) => entry.kind === 'plugin' && entry.id === pluginId)) return
    const stage: ChainStage = { kind: 'plugin', id: pluginId }
    const plugin = track.plugins.find((item) => item.id === pluginId)

    if (plugin?.kind === 'nam') {
      // Keep all amps next to each other so the parallel group stays visually
      // obvious in the chain.
      let lastNam = -1
      track.chain.forEach((entry, index) => {
        if (entry.kind !== 'plugin') return
        const item = track.plugins.find((candidate) => candidate.id === entry.id)
        if (item?.kind === 'nam') lastNam = index
      })
      if (lastNam >= 0) {
        track.chain.splice(lastNam + 1, 0, stage)
        return
      }
    }

    const index = track.chain.findIndex((entry) => entry.kind === 'builtin')
    if (index < 0) track.chain.push(stage)
    else track.chain.splice(index, 0, stage)
  }

  setVolume(id: string, value: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.volume = value
    this.applyTrackGain(track)
  }

  setPan(id: string, value: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    const clamped = Math.max(-1, Math.min(1, value))
    track.pan = clamped
    track.panner.pan.setTargetAtTime(clamped, this.ctx.currentTime, 0.01)
  }

  setBuiltinFx(id: string, fxId: BuiltinFxId, unit: BuiltinFxUnit): void {
    const track = this.tracks.get(id)
    if (!track) return
    const copy: BuiltinFxUnit = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } }
    track.fx.state[fxId] = copy
    applyBuiltinUnit(track.fx.units[fxId], copy)
  }

  setMuted(id: string, muted: boolean): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.muted = muted
    this.applyTrackGain(track)
  }

  /**
   * Track fader = volume x trim x polarity. Folding trim/phase into the single
   * gain node keeps the live and offline graphs identical.
   */
  private applyTrackGain(track: EngineTrack): void {
    const value = track.muted ? 0 : track.volume * track.trim * track.phase
    track.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01)
  }

  setTrim(id: string, linear: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.trim = Math.max(0, Math.min(4, linear))
    this.applyTrackGain(track)
  }

  setPhaseInvert(id: string, invert: boolean): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.phase = invert ? -1 : 1
    this.applyTrackGain(track)
  }

  setMono(id: string, mono: boolean): void {
    const track = this.tracks.get(id)
    if (!track) return
    if (track.mono === mono) return
    track.mono = mono
    applyMonoGains(track.monoGains, mono, this.ctx.currentTime)
  }

  // ------------------------------------------------------------------ sends

  setTrackSend(id: string, kind: 'rv' | 'dl', value: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    const gain = Math.max(0, Math.min(1, value))
    const node = kind === 'rv' ? track.rvSend : track.dlSend
    node.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02)
  }

  setSendConfig(next: Partial<SendConfig>): void {
    const merged = { ...this.sendConfig, ...next }
    const rvDecay = clampRange(merged.rvDecay, 0.3, 8)
    const dlTime = clampRange(merged.dlTime, 20, 2000)
    const dlFeedback = clampRange(merged.dlFeedback, 0, 0.9)
    const rvReturn = clampRange(merged.rvReturn, 0, 2)
    const dlReturn = clampRange(merged.dlReturn, 0, 2)
    const changed = { ...this.sendConfig }
    this.sendConfig = { rvDecay, dlTime, dlFeedback, rvReturn, dlReturn }

    if (changed.rvDecay !== rvDecay) {
      this.reverbBus.decay = rvDecay
      if (this.reverbBus.convolver) {
        this.reverbBus.convolver.buffer = makeImpulse(this.ctx, rvDecay)
      }
    }
    if (this.reverbBus.output) this.reverbBus.output.gain.value = rvReturn
    if (this.delayBus.delayNode && changed.dlTime !== dlTime) {
      this.delayBus.delayNode.delayTime.setTargetAtTime(dlTime / 1000, this.ctx.currentTime, 0.05)
    }
    if (this.delayBus.feedback && changed.dlFeedback !== dlFeedback) {
      this.delayBus.feedback.gain.setTargetAtTime(dlFeedback, this.ctx.currentTime, 0.05)
    }
    if (this.delayBus.output) this.delayBus.output.gain.value = dlReturn
  }

  getSendConfig(): SendConfig {
    return { ...this.sendConfig }
  }

  // -------------------------------------------------------------- master bus

  setMasterFx(fxId: BuiltinFxId, unit: BuiltinFxUnit): void {
    const copy: BuiltinFxUnit = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } }
    this.masterFx.state[fxId] = copy
    applyBuiltinUnit(this.masterFx.units[fxId], copy)
  }

  getMasterFx(): BuiltinFxRack {
    const rack = defaultBuiltinFx()
    for (const id of BUILTIN_FX_IDS) {
      const unit = this.masterFx.state[id]
      rack[id] = { enabled: unit.enabled, mix: unit.mix, params: { ...unit.params } }
    }
    return rack
  }

  applyMasterFxPreset(rack: BuiltinFxRack): void {
    for (const id of BUILTIN_FX_IDS) this.setMasterFx(id, rack[id])
  }

  getTrackStaging(id: string): { trim: number; phase: number; mono: boolean; rv: number; dl: number } | null {
    const track = this.tracks.get(id)
    if (!track) return null
    return {
      trim: track.trim,
      phase: track.phase,
      mono: track.mono,
      rv: track.rvSend.gain.value,
      dl: track.dlSend.gain.value,
    }
  }

  getLevel(id: string): number {
    const track = this.tracks.get(id)
    if (!track) return 0
    return measurePeak(track.analyser)
  }

  // --------------------------------------------------------------- plugins

  private findTrack(trackId: string): EngineTrack {
    const track = this.tracks.get(trackId)
    if (!track) throw new Error('Track não encontrada')
    return track
  }

  hasPlugin(trackId: string, pluginId: string): boolean {
    return this.tracks.get(trackId)?.plugins.some((plugin) => plugin.id === pluginId) === true
  }

  addIrPlugin(
    trackId: string,
    buffer: AudioBuffer,
    name: string,
    restore?: PluginRestoreInfo,
  ): PluginInfo {
    const track = this.findTrack(trackId)

    const input = this.ctx.createGain()
    const output = this.ctx.createGain()
    const dry = this.ctx.createGain()
    const wet = this.ctx.createGain()
    const sum = this.ctx.createGain()
    const level = this.ctx.createGain()
    const panner = this.ctx.createStereoPanner()
    const lowCut = this.ctx.createBiquadFilter()
    const highCut = this.ctx.createBiquadFilter()
    const convolver = this.ctx.createConvolver()

    lowCut.type = 'highpass'
    lowCut.frequency.value = 20
    highCut.type = 'lowpass'
    highCut.frequency.value = 20000
    convolver.normalize = true
    convolver.buffer = buffer
    dry.gain.value = 0
    wet.gain.value = 1
    level.gain.value = 1.2

    // input -> dry ------------------------\
    // input -> filters -> IR -> wet -> sum -> level -> pan -> output
    input.connect(dry)
    dry.connect(sum)
    input.connect(lowCut)
    lowCut.connect(highCut)
    highCut.connect(convolver)
    convolver.connect(wet)
    wet.connect(sum)
    sum.connect(level)
    level.connect(panner)
    panner.connect(output)

    const params: PluginParamInfo[] = [
      { name: 'Mix', value: 1, min: 0, max: 1, step: 0.01, unit: 'percent' },
      { name: 'Output', value: 1.2, min: 0, max: 3, step: 0.01, unit: 'ratio' },
      { name: 'Pan', value: 0, min: -1, max: 1, step: 0.01, unit: 'pan' },
      { name: 'Low Cut', value: 20, min: 20, max: 1000, step: 1, unit: 'hz' },
      { name: 'High Cut', value: 20000, min: 1000, max: 20000, step: 10, unit: 'hz' },
    ]

    const plugin: PluginInstance = {
      id: restore?.id ?? newId(),
      name,
      kind: 'ir',
      enabled: restore?.enabled ?? true,
      params,
      detail: `${(buffer.duration * 1000).toFixed(0)} ms · ${buffer.numberOfChannels}ch`,
      input,
      output,
      source: { irBuffer: buffer },
      setParam: (paramName, value) => {
        const now = this.ctx.currentTime
        if (paramName === 'Mix') {
          dry.gain.setTargetAtTime(1 - value, now, 0.02)
          wet.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Output') {
          level.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Pan') {
          panner.pan.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Low Cut') {
          lowCut.frequency.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'High Cut') {
          highCut.frequency.setTargetAtTime(value, now, 0.02)
        }
      },
      dispose: () => {
        input.disconnect()
        dry.disconnect()
        lowCut.disconnect()
        highCut.disconnect()
        convolver.disconnect()
        wet.disconnect()
        sum.disconnect()
        level.disconnect()
        panner.disconnect()
        output.disconnect()
      },
    }

    this.registerPlugin(track, plugin)
    if (restore?.params) {
      for (const saved of restore.params) {
        const param = plugin.params.find((item) => item.name === saved.name)
        if (!param) continue
        param.value = saved.value
        plugin.setParam(saved.name, saved.value)
      }
    }
    this.rewire(trackId)
    return toInfo(plugin)
  }

  async addWorkletPlugin(
    trackId: string,
    file: File,
    restore?: PluginRestoreInfo,
  ): Promise<PluginInfo> {
    const track = this.findTrack(trackId)
    await this.resume()

    const sourceText = await file.text()
    const match = /registerProcessor\s*\(\s*['"`]([^'"`]+)['"`]/.exec(sourceText)
    if (!match) {
      throw new Error('o arquivo não registra um AudioWorkletProcessor')
    }
    const processorName = match[1]

    await this.ensureWorkletModule(this.ctx, processorName, sourceText)

    const node = new AudioWorkletNode(this.ctx, processorName)
    const panner = this.ctx.createStereoPanner()
    node.connect(panner)
    const params: PluginParamInfo[] = []
    node.parameters.forEach((param, paramName) => {
      const minRaw = Math.abs(param.minValue) > 1e6 ? 0 : param.minValue
      const maxRaw = Math.abs(param.maxValue) > 1e6 ? 1 : param.maxValue
      params.push({ name: paramName, value: param.value, min: minRaw, max: maxRaw })
    })
    params.push({ name: 'Pan', value: 0, min: -1, max: 1, step: 0.01, unit: 'pan' })

    const plugin: PluginInstance = {
      id: restore?.id ?? newId(),
      name: file.name.replace(/\.js$/i, ''),
      kind: 'worklet',
      enabled: restore?.enabled ?? true,
      params,
      detail: processorName,
      input: node,
      output: panner,
      source: { workletSource: sourceText, processorName },
      setParam: (paramName, value) => {
        if (paramName === 'Pan') {
          panner.pan.setTargetAtTime(value, this.ctx.currentTime, 0.02)
          return
        }
        node.parameters.get(paramName)?.setTargetAtTime(value, this.ctx.currentTime, 0.02)
      },
      dispose: () => {
        node.disconnect()
        panner.disconnect()
        node.port.close()
      },
    }

    this.registerPlugin(track, plugin)
    if (restore?.params) {
      for (const saved of restore.params) {
        const param = plugin.params.find((item) => item.name === saved.name)
        if (!param) continue
        param.value = saved.value
        plugin.setParam(saved.name, saved.value)
      }
    }
    this.rewire(trackId)
    return toInfo(plugin)
  }

  private getNamEngine(): Promise<NamEngine> {
    if (!this.namEnginePromise) {
      this.namEnginePromise = NamEngine.attach(this.ctx, { assetBaseUrl: NAM_ASSET_BASE })
    }
    return this.namEnginePromise
  }

  async addNamPlugin(
    trackId: string,
    file: File,
    restore?: PluginRestoreInfo,
  ): Promise<PluginInfo> {
    const track = this.findTrack(trackId)
    await this.resume()

    const json = await file.text()
    try {
      JSON.parse(json)
    } catch {
      throw new Error('arquivo .nam inválido (JSON malformado)')
    }

    const engine = await this.getNamEngine()
    let slim = 1
    // NAM is a mono model. Run one instance per channel so the pan control of
    // every amp in the chain survives the next stage instead of being summed.
    const nodes: NamNode[] = []
    const input = this.ctx.createGain()
    const output = this.ctx.createGain()
    const dry = this.ctx.createGain()
    const wet = this.ctx.createGain()
    const sum = this.ctx.createGain()
    const level = this.ctx.createGain()
    const panner = this.ctx.createStereoPanner()
    const stereo = this.ctx.createGain()
    const splitter = this.ctx.createChannelSplitter(2)
    const merger = this.ctx.createChannelMerger(2)
    const bass = this.ctx.createBiquadFilter()
    const mid = this.ctx.createBiquadFilter()
    const treble = this.ctx.createBiquadFilter()
    const presence = this.ctx.createBiquadFilter()

    bass.type = 'lowshelf'
    bass.frequency.value = 120
    mid.type = 'peaking'
    mid.frequency.value = 700
    mid.Q.value = 0.9
    treble.type = 'highshelf'
    treble.frequency.value = 3200
    presence.type = 'peaking'
    presence.frequency.value = 4500
    presence.Q.value = 0.7
    stereo.channelCount = 2
    stereo.channelCountMode = 'explicit'
    stereo.channelInterpretation = 'speakers'
    dry.gain.value = 0
    wet.gain.value = 1
    level.gain.value = 1

    let model: NamModelInfo
    try {
      const left = await engine.createNode()
      left.channelCount = 1
      left.channelCountMode = 'explicit'
      left.channelInterpretation = 'speakers'
      nodes.push(left)
      const right = await engine.createNode()
      right.channelCount = 1
      right.channelCountMode = 'explicit'
      right.channelInterpretation = 'speakers'
      nodes.push(right)
      model = await left.loadModel(json, { slimSize: slim })
      await right.loadModel(json, { slimSize: slim })
    } catch (error) {
      nodes.forEach((node) => void node.dispose())
      throw error
    }

    input.connect(stereo)
    stereo.connect(splitter)
    splitter.connect(nodes[0], 0)
    splitter.connect(nodes[1], 1)
    nodes[0].connect(merger, 0, 0)
    nodes[1].connect(merger, 0, 1)
    merger.connect(bass)
    bass.connect(mid)
    mid.connect(treble)
    treble.connect(presence)
    presence.connect(wet)
    wet.connect(sum)
    input.connect(dry)
    dry.connect(sum)
    sum.connect(level)
    level.connect(panner)
    panner.connect(output)

    const params: PluginParamInfo[] = [
      { name: 'Input', value: 1, min: 0, max: 4, step: 0.01, unit: 'ratio' },
      { name: 'Bass', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
      { name: 'Mid', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
      { name: 'Treble', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
      { name: 'Presence', value: 0, min: -12, max: 12, step: 0.1, unit: 'db' },
      { name: 'Output', value: 1, min: 0, max: 4, step: 0.01, unit: 'ratio' },
      { name: 'Mix', value: 1, min: 0, max: 1, step: 0.01, unit: 'percent' },
      { name: 'Pan', value: 0, min: -1, max: 1, step: 0.01, unit: 'pan' },
    ]
    if (model.slimmable) {
      params.push({ name: 'Slim', value: 1, min: 0, max: 1, step: 0.01, unit: 'percent' })
    }

    const sampleRateMismatch =
      model.expectedSampleRate > 0 && Math.abs(model.expectedSampleRate - this.ctx.sampleRate) > 1

    const detailParts = [
      'stereo (2x mono)',
      model.slimmable ? 'A2 slimmable' : 'modelo estático',
      model.hasLoudness ? `${model.loudness.toFixed(1)} dB` : 'sem loudness',
      model.expectedSampleRate > 0 ? `${Math.round(model.expectedSampleRate)} Hz` : 'sr n/d',
    ]
    if (sampleRateMismatch) detailParts.push('⚠ resample')

    const plugin: PluginInstance = {
      id: restore?.id ?? newId(),
      name: file.name.replace(/\.nam$/i, ''),
      kind: 'nam',
      enabled: restore?.enabled ?? true,
      params,
      detail: detailParts.join(' · '),
      input,
      output,
      source: { namJson: json, namSlim: slim },
      setParam: (paramName, value) => {
        const now = this.ctx.currentTime
        if (paramName === 'Input') {
          input.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Bass') {
          bass.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Mid') {
          mid.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Treble') {
          treble.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Presence') {
          presence.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Output') {
          level.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Mix') {
          dry.gain.setTargetAtTime(1 - value, now, 0.02)
          wet.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Pan') {
          panner.pan.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Slim') {
          slim = Math.max(0, Math.min(1, value))
          plugin.source.namSlim = slim
          nodes.forEach((node) => void node.setSlimSize(slim))
        }
      },
      dispose: () => {
        nodes.forEach((node) => void node.dispose())
        input.disconnect()
        dry.disconnect()
        stereo.disconnect()
        splitter.disconnect()
        merger.disconnect()
        bass.disconnect()
        mid.disconnect()
        treble.disconnect()
        presence.disconnect()
        wet.disconnect()
        sum.disconnect()
        level.disconnect()
        panner.disconnect()
        output.disconnect()
      },
    }

    this.registerPlugin(track, plugin)
    if (restore?.params) {
      for (const saved of restore.params) {
        const param = plugin.params.find((item) => item.name === saved.name)
        if (!param) continue
        param.value = saved.value
        plugin.setParam(saved.name, saved.value)
      }
    }
    this.rewire(trackId)
    return toInfo(plugin)
  }

  setPluginEnabled(trackId: string, pluginId: string, enabled: boolean): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    const plugin = track.plugins.find((item) => item.id === pluginId)
    if (!plugin) return
    plugin.enabled = enabled
    this.rewire(trackId)
  }

  setPluginParam(trackId: string, pluginId: string, name: string, value: number): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    const plugin = track.plugins.find((item) => item.id === pluginId)
    if (!plugin) return
    plugin.setParam(name, value)
    const param = plugin.params.find((item) => item.name === name)
    if (param) param.value = value
  }

  removePlugin(trackId: string, pluginId: string): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    const index = track.plugins.findIndex((item) => item.id === pluginId)
    if (index < 0) return
    track.plugins[index].dispose()
    track.plugins.splice(index, 1)
    track.chain = track.chain.filter((stage) => !(stage.kind === 'plugin' && stage.id === pluginId))
    this.rewire(trackId)
  }

  // ------------------------------------------------------- built-in amp sim

  setFxEnabled(id: string, enabled: boolean): void {
    const track = this.tracks.get(id)
    if (!track) return
    if (enabled) {
      track.shaper.curve = makeDriveCurve(35)
      track.filter.type = 'lowpass'
      track.filter.frequency.setTargetAtTime(4500, this.ctx.currentTime, 0.02)
    } else {
      track.shaper.curve = null
      track.filter.type = 'allpass'
      track.filter.frequency.setTargetAtTime(20000, this.ctx.currentTime, 0.02)
    }
  }

  setDrive(id: string, amount: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.shaper.curve = makeDriveCurve(amount)
  }

  setCabinet(id: string, frequency: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.filter.type = 'lowpass'
    track.filter.frequency.setTargetAtTime(frequency, this.ctx.currentTime, 0.02)
  }

  // ---------------------------------------------------------- input devices

  async listInputs(): Promise<MediaDeviceInfo[]> {
    await this.resume()
    try {
      // Asking for permission is what reveals device labels.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((track) => track.stop())
    } catch {
      /* permission denied: still try to list what the browser exposes */
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((device) => device.kind === 'audioinput')
  }

  /**
   * The same list without touching the microphone, so the app can auto-detect
   * an input on load without triggering the permission prompt. Labels stay
   * empty until the user has granted permission at least once, so the caller
   * must accept unnamed devices and prefer the ones that came back labelled.
   */
  async listInputsQuietly(): Promise<MediaDeviceInfo[]> {
    await this.resume()
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((device) => device.kind === 'audioinput')
  }

  /**
   * The first real input the browser exposes, system default first. Used when
   * a track is armed but no device was chosen — the producer should hear the
   * guitar the moment they plug it in, not after pressing a "detect" button.
   */
  async detectInput(): Promise<string> {
    const devices = await this.listInputs()
    // A device id is only published once the page holds microphone permission,
    // so an unnamed/ id-less list means "the browser will not let us in", not
    // "there is no hardware". Say which, instead of opening a phantom input.
    const usable = devices.filter((device) => device.deviceId)
    if (usable.length === 0) {
      throw new Error(
        devices.length > 0
          ? 'O navegador negou permissão de microfone — libere o acesso no cadeado da barra de endereço'
          : 'Nenhum microfone ou interface encontrado pelo navegador',
      )
    }
    return usable[0].deviceId
  }

  /**
   * Open a live input for a track. The saved project can hold a device id that
   * no longer exists (an interface unplugged, a browser that renamed it), and
   * `exact` then throws `OverconstrainedError` — which is what makes an entry
   * look dead in a DAW that remembers its routing. So ask for that device, and
   * if the browser cannot give it, fall back to the system default and report
   * which one actually opened.
   *
   * `channel` picks which part of the device this lane owns. A two-input
   * interface is one browser stream, so lane A takes channel 1 and lane B takes
   * channel 2 by splitting that shared stream — the way a real console patches
   * two mic cables into two channels.
   */
  async connectInput(
    trackId: string,
    deviceId: string,
    monitor: boolean,
    channel: InputChannel = 0,
  ): Promise<InputStatus> {
    await this.resume()
    // A lane re-patching its device keeps the mode it was recording in: changing
    // the cable is not a decision to stop printing effects.
    const before = this.inputs.get(trackId)
    const recordMode: 'dry' | 'wet' = before?.recordMode ?? 'dry'
    this.disconnectInput(trackId)

    const track = this.tracks.get(trackId)
    if (!track) throw new Error('Track não encontrada')

    const constraints = (id: string, strict: boolean): MediaStreamConstraints => ({
      audio: {
        deviceId: id ? (strict ? { exact: id } : { ideal: id }) : undefined,
        // Ask for everything the interface can give: a lane that wants input 5
        // can only take it if the stream carries five. A two-input device still
        // answers with two, and nothing breaks.
        channelCount: { ideal: MAX_INPUT_CHANNELS },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    // One interface is one physical stream. Two lanes patching channel 1 and
    // channel 2 must read the same stream instead of asking the browser for the
    // same hardware twice.
    const cached = this.sharedStreams.get(deviceId)
    let stream: MediaStream
    if (cached) {
      stream = cached.stream
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId, true))
      } catch (error) {
        const name = (error as DOMException)?.name
        if (name === 'OverconstrainedError' || name === 'NotFoundError') {
          stream = await navigator.mediaDevices.getUserMedia(constraints('', false))
        } else {
          throw error
        }
      }
    }

    const live = stream.getAudioTracks()[0]
    if (!live) {
      if (!cached) stream.getTracks().forEach((item) => item.stop())
      throw new Error('A entrada não tem pista de áudio')
    }

    // getSettings() is the only honest answer about how many channels the
    // device is really sending; the graph would happily duplicate a mono one.
    const settings = live.getSettings()
    const resolvedId = settings.deviceId || deviceId
    const sourceChannels =
      (typeof settings.channelCount === 'number' && settings.channelCount > 0
        ? settings.channelCount
        : stream.getAudioTracks()[0].getSettings().channelCount) || 1

    // The lane that gets here twice with the same device id reuses the stream
    // already open, so channel 1 and channel 2 come from one capture.
    const sharedKey = deviceId
    let shared = this.sharedStreams.get(sharedKey)
    if (!shared) {
      shared = { stream, users: 0 }
      this.sharedStreams.set(sharedKey, shared)
    }
    shared.users += 1

    const source = this.ctx.createMediaStreamSource(stream)
    // `out` carries exactly the channel(s) this lane picked, at unity gain.
    const out = this.ctx.createGain()
    const gain = this.ctx.createGain()
    // The wet take has its own feed to the chain: a producer who chose "gravar com
    // efeitos" wants the effects printed even with the monitor closed, and at the
    // level the lane actually carries — the monitor's 0.6 is a listening level.
    const wet = this.ctx.createGain()
    // Only one of the two feeds is open, or the chain would hear the same input
    // twice and print it twice.
    gain.gain.value = monitor && recordMode === 'dry' ? 0.6 : 0
    wet.gain.value = recordMode === 'wet' ? 1 : 0

    let splitter: ChannelSplitterNode | null = null
    let laneChannels = sourceChannels
    // A lane that asked for a channel the device does not send gets the whole
    // stream instead of silence: a mono mic patched as "entrada 3" is still the
    // mic, and the report below says which of the two happened.
    let effectiveChannel: InputChannel = channel
    if (effectiveChannel >= 1 && sourceChannels >= 2) {
      splitter = this.ctx.createChannelSplitter(
        Math.min(MAX_INPUT_CHANNELS, Math.max(2, sourceChannels)),
      )
      source.connect(splitter)
      // A splitter output is a single-channel feed, so this lane really is mono:
      // it hears, and records, only the input it was patched into.
      const index = Math.min(splitter.numberOfOutputs, effectiveChannel) - 1
      splitter.connect(out, index)
      laneChannels = 1
      effectiveChannel = index + 1
    } else {
      source.connect(out)
      if (sourceChannels < 2) {
        effectiveChannel = 0
        laneChannels = 1
      }
    }

    out.connect(gain)
    gain.connect(track.panner)
    out.connect(wet)
    wet.connect(track.panner)

    const status: InputStatus = {
      deviceId: resolvedId,
      label: live.label || 'Entrada de áudio',
      channels: laneChannels,
      sourceChannels,
      channel: effectiveChannel,
      sampleRate: typeof settings.sampleRate === 'number' ? settings.sampleRate : this.ctx.sampleRate,
    }
    this.inputs.set(trackId, {
      stream,
      streamKey: sharedKey,
      source,
      out,
      gain,
      wet,
      splitter,
      monitor,
      recordMode,
      status,
    })
    return status
  }

  /** The live input of a track, or null when nothing is connected. */
  inputStatus(trackId: string): InputStatus | null {
    return this.inputs.get(trackId)?.status ?? null
  }

  /**
   * Patches an external MediaStream — the call room — into a track.
   *
   * Same lane as a hardware input (`source -> out -> gain -> track.panner`, with
   * the wet printer on `out`), because that is what makes the monitor button, the
   * lane's meter and the recorder work without a second copy of any of them. The
   * `streamKey` deliberately is not a device id: `disconnectInput` only stops a
   * shared stream when the key exists in `sharedStreams`, and the call's stream
   * belongs to the SDK, not to this engine.
   */
  connectCallInput(trackId: string, stream: MediaStream, monitor = true, label = 'Chamada'): InputStatus {
    const track = this.tracks.get(trackId)
    if (!track) throw new Error('Track não encontrada')
    const recordMode: 'dry' | 'wet' = this.inputs.get(trackId)?.recordMode ?? 'dry'
    this.disconnectInput(trackId)

    const live = stream.getAudioTracks()[0]
    if (!live) throw new Error('O stream da chamada não tem pista de áudio')

    const source = this.ctx.createMediaStreamSource(stream)
    const out = this.ctx.createGain()
    const gain = this.ctx.createGain()
    const wet = this.ctx.createGain()
    gain.gain.value = monitor && recordMode === 'dry' ? 0.6 : 0
    wet.gain.value = recordMode === 'wet' ? 1 : 0

    source.connect(out)
    out.connect(gain)
    gain.connect(track.panner)
    out.connect(wet)
    wet.connect(track.panner)

    const channels = live.getSettings().channelCount || 1
    const status: InputStatus = {
      deviceId: 'call',
      label,
      channels,
      sourceChannels: channels,
      channel: 0,
      sampleRate: live.getSettings().sampleRate || this.ctx.sampleRate,
    }
    this.inputs.set(trackId, {
      stream,
      streamKey: `call:${label}`,
      borrowed: true,
      source,
      out,
      gain,
      wet,
      splitter: null,
      monitor,
      recordMode,
      status,
    })
    return status
  }

  /**
   * What the lane prints: the raw input, or the sound at the end of its effects.
   * A lane with no input connected has no print mode to report.
   */
  recordMode(trackId: string): 'dry' | 'wet' | null {
    return this.inputs.get(trackId)?.recordMode ?? null
  }

  /**
   * Choose what a lane prints, and open the feed the take is made from.
   *
   * 'wet' hands the input to the chain at unity and closes the monitor's listening
   * level, because the printed pass and the pass in the headphones have to be the
   * same one — the way a re-amp prints what you hear. The live input therefore runs
   * through the lane's effects whether or not the monitor button is lit: to hear
   * nothing, mute the lane.
   */
  setRecordMode(trackId: string, mode: 'dry' | 'wet'): void {
    const entry = this.inputs.get(trackId)
    if (!entry || entry.recordMode === mode) return
    entry.recordMode = mode
    const now = this.ctx.currentTime
    entry.wet.gain.setTargetAtTime(mode === 'wet' ? 1 : 0, now, 0.02)
    entry.gain.gain.setTargetAtTime(
      mode === 'wet' ? 0 : entry.monitor ? 0.6 : 0,
      now,
      0.02,
    )
    // A take already running on this lane keeps its tap: switching modes mid-take
    // would print half of it from one place and half from another.
  }

  setInputMonitor(trackId: string, enabled: boolean): void {
    const entry = this.inputs.get(trackId)
    if (!entry) return
    entry.monitor = enabled
    // Printing wet already carries the input, so the monitor only moves the dry
    // listening feed; changing it must not steal the printer's signal.
    if (entry.recordMode === 'wet') return
    entry.gain.gain.setTargetAtTime(enabled ? 0.6 : 0, this.ctx.currentTime, 0.02)
  }

  /**
   * Whether the live input of a lane is reaching the mix — either because the
   * producer lit the monitor, or because the lane is printing its effects.
   */
  isInputLive(trackId: string): boolean {
    const entry = this.inputs.get(trackId)
    if (!entry) return false
    return entry.monitor || entry.recordMode === 'wet'
  }

  /**
   * Puts a node between a lane's input and the two feeds it already has, or takes
   * it out again.
   *
   * `out -> insert -> {gain, wet}` is the only order that keeps the promises the
   * lane already makes: the monitor hears the inserted processing, a wet take
   * prints it, and the dry recorder tap — which reads `out` further up — still
   * gets the device exactly as it came. Only this lane's two destinations are
   * disconnected, never the whole `out`, because the recorder may be reading it.
   */
  setLiveInsert(trackId: string, node: AudioNode | null): boolean {
    const entry = this.inputs.get(trackId)
    if (!entry) return false
    const previous = entry.liveInsert ?? null
    if (previous === node) return true
    if (previous) {
      previous.disconnect()
      entry.out.connect(entry.gain)
      entry.out.connect(entry.wet)
    }
    entry.liveInsert = node
    if (node) {
      entry.out.disconnect(entry.gain)
      entry.out.disconnect(entry.wet)
      entry.out.connect(node)
      node.connect(entry.gain)
      node.connect(entry.wet)
    }
    return true
  }

  /** The node a lane's input currently passes through, if any. */
  liveInsert(trackId: string): AudioNode | null {
    return this.inputs.get(trackId)?.liveInsert ?? null
  }

  disconnectInput(trackId: string): void {
    const entry = this.inputs.get(trackId)
    if (!entry) return
    entry.splitter?.disconnect()
    entry.source.disconnect()
    entry.liveInsert?.disconnect()
    entry.liveInsert = null
    entry.out.disconnect()
    entry.gain.disconnect()
    entry.wet.disconnect()
    // The stream belongs to the device, not to the lane: only stop it when the
    // last lane patching into it lets go. A borrowed stream — the call room's — is
    // never ours to stop at all.
    const shared = this.sharedStreams.get(entry.streamKey)
    if (entry.borrowed) {
      // leave the SDK's stream running; it owns its tracks
    } else if (shared) {
      shared.users -= 1
      if (shared.users <= 0) {
        shared.stream.getTracks().forEach((track) => track.stop())
        this.sharedStreams.delete(entry.streamKey)
      }
    } else {
      entry.stream.getTracks().forEach((track) => track.stop())
    }
    this.inputs.delete(trackId)
  }

  hasInput(trackId: string): boolean {
    return this.inputs.has(trackId)
  }

  // ------------------------------------------------------------- recording

  /** Frames per sample-tap callback; also the resolution of the live peaks. */
  private static readonly TAKE_CHUNK = 2048

  /**
   * Tap each armed lane and start its take. The tap depends on what the lane was
   * set to print: 'dry' reads the input exactly as the device gave it, patched to
   * the channel this lane owns, while 'wet' reads the end of the lane's effects —
   * the sound the producer heard in the headphones, the way a hardware re-amp
   * prints. A wet tap is the whole lane, so a clip already playing on that lane
   * comes along in the file; printing onto a lane that is not playing something is
   * what a take normally is.
   *
   * Reading the samples ourselves, rather than through MediaRecorder, is what lets
   * a stereo interface really give a two-channel take and lets the lane redraw
   * while the take grows instead of only after the transport stops.
   */
  async startRecording(trackIds: string[]): Promise<string[]> {
    await this.resume()
    const started: string[] = []
    this.takePeaks.clear()

    for (const trackId of trackIds) {
      const entry = this.inputs.get(trackId)
      if (!entry) continue
      if (this.recorders.has(trackId)) continue

      const track = this.tracks.get(trackId)
      const wet = entry.recordMode === 'wet' && Boolean(track)
      const tap: AudioNode = wet ? (track as EngineTrack).recordPoint : entry.out
      const channels = wet ? 2 : Math.max(1, Math.min(2, entry.status.channels || 1))
      const node = this.ctx.createScriptProcessor(AudioEngine.TAKE_CHUNK, channels, 1)
      const sink = this.ctx.createGain()
      // Silent, but the tap only runs if its output reaches the destination —
      // a dangling ScriptProcessor never fires its callback in Chrome.
      sink.gain.value = 0
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.55
      const recorder: RecorderEntry = {
        node,
        sink,
        tap,
        wet,
        channels,
        chunks: [],
        written: 0,
        analyser,
      }

      node.onaudioprocess = (event: AudioProcessingEvent) => {
        const input = event.inputBuffer
        const taken: Float32Array[] = []
        let peak = 0
        for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
          const data = input.getChannelData(channel)
          taken.push(data.slice(0))
          // Every fourth sample is enough for a peak readout and keeps the
          // work off the audio thread's critical path.
          for (let i = 0; i < data.length; i += 4) {
            const value = Math.abs(data[i])
            if (value > peak) peak = value
          }
        }
        recorder.chunks.push(taken)
        recorder.written += input.length
        this.recordPeak(trackId, peak)
      }

      // Tap what the lane actually carries, not the raw device: a lane patched to
      // input 1 must record input 1 alone.
      tap.connect(node)
      tap.connect(analyser)
      node.connect(sink)
      sink.connect(this.ctx.destination)
      this.recorders.set(trackId, recorder)
      started.push(trackId)
    }
    return started
  }

  /**
   * Live spectrum of a running take, in 0..255 per frequency bin, or null when
   * that lane is not recording. The caller owns the returned array.
   */
  takeSpectrum(trackId: string): Uint8Array | null {
    const recorder = this.recorders.get(trackId)
    if (!recorder) return null
    const data = new Uint8Array(recorder.analyser.frequencyBinCount)
    recorder.analyser.getByteFrequencyData(data)
    return data
  }

  /** Bin resolution, so the caller can label the frequency axis honestly. */
  get takeSpectrumBinHz(): number {
    return this.ctx.sampleRate / 512
  }

  private recordPeak(trackId: string, peak: number): void {
    let entry = this.takePeaks.get(trackId)
    if (!entry) {
      entry = { peaks: new Float32Array(4096), written: 0, reported: 0 }
      this.takePeaks.set(trackId, entry)
    }
    if (entry.written >= entry.peaks.length) {
      const grown = new Float32Array(entry.peaks.length * 2)
      grown.set(entry.peaks)
      entry.peaks = grown
    }
    entry.peaks[entry.written] = peak
    entry.written += 1

    const now = performance.now()
    if (!this.onTakeProgress || now - entry.reported < 120) return
    entry.reported = now
    this.onTakeProgress(
      trackId,
      Array.from(entry.peaks.subarray(0, entry.written)),
      (entry.written * AudioEngine.TAKE_CHUNK) / this.ctx.sampleRate,
    )
  }

  /** Assemble each running tap into an AudioBuffer, channel for channel. */
  async stopRecording(): Promise<Map<string, AudioBuffer>> {
    const entries = [...this.recorders.entries()]
    this.recorders.clear()
    this.takePeaks.clear()
    const result = new Map<string, AudioBuffer>()

    for (const [trackId, recorder] of entries) {
      recorder.node.onaudioprocess = null
      // The tap belongs to the graph (the lane's input, or the end of its
      // effects), so only the connection into the recorder is taken down.
      try {
        recorder.tap.disconnect(recorder.node)
      } catch {
        /* already detached */
      }
      try {
        recorder.tap.disconnect(recorder.analyser)
      } catch {
        /* already detached */
      }
      try {
        recorder.node.disconnect()
      } catch {
        /* already detached */
      }
      try {
        recorder.sink.disconnect()
      } catch {
        /* already detached */
      }
      try {
        recorder.analyser.disconnect()
      } catch {
        /* already detached */
      }

      const length = recorder.written
      if (length === 0) continue
      const width = Math.max(1, recorder.chunks[0]?.length ?? 1)

      // A stereo request can still come back with a silent second channel;
      // keeping it would fake a stereo clip out of a mono mic.
      let channels = width
      if (width > 1) {
        const hasSecond = recorder.chunks.some((chunk) => {
          const data = chunk[1]
          if (!data) return false
          for (let i = 0; i < data.length; i += 1) {
            if (data[i] !== 0) return true
          }
          return false
        })
        if (!hasSecond) channels = 1
      }

      const buffer = this.ctx.createBuffer(channels, length, this.ctx.sampleRate)
      let offset = 0
      for (const chunk of recorder.chunks) {
        const frames = chunk[0]?.length ?? 0
        if (frames === 0) continue
        for (let channel = 0; channel < channels; channel += 1) {
          const data = chunk[channel]
          if (data) buffer.getChannelData(channel).set(data, offset)
        }
        offset += frames
      }
      result.set(trackId, buffer)
    }

    return result
  }

  private stopTrackRecorder(trackId: string): void {
    const recorder = this.recorders.get(trackId)
    if (!recorder) return
    recorder.node.onaudioprocess = null
    try {
      recorder.tap.disconnect(recorder.node)
    } catch {
      /* already detached */
    }
    try {
      recorder.tap.disconnect(recorder.analyser)
    } catch {
      /* already detached */
    }
    try {
      recorder.node.disconnect()
    } catch {
      /* already detached */
    }
    try {
      recorder.sink.disconnect()
    } catch {
      /* already detached */
    }
    this.recorders.delete(trackId)
    this.takePeaks.delete(trackId)
  }

  isRecordingTrack(trackId: string): boolean {
    return this.recorders.has(trackId)
  }

  // ---------------------------------------------------------------- sounds

  playClick(accent = false, when = this.ctx.currentTime): void {
    scheduleClick(this.ctx, this.masterGain, when, accent)
  }

  // ----------------------------------------------------------------- clips

  setBuffer(id: string, buffer: AudioBuffer | null, label = ''): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.buffer = buffer
    track.bufferLabel = buffer ? label : ''
    track.clipDuration = buffer ? buffer.duration : 0
    // A preview rendered from the old clip must not play over the new one.
    track.monitor = null
  }

  /**
   * Put a rendered pass in front of the speakers and the export without
   * touching the recorded clip. Passing null gives the dry take back.
   */
  setMonitorBuffer(id: string, buffer: AudioBuffer | null, key = ''): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.monitor = buffer ? { buffer, key } : null
  }

  /** The key of the preview this lane is playing, or '' when it plays the take. */
  monitorKey(id: string): string {
    return this.tracks.get(id)?.monitor?.key ?? ''
  }

  /** Which stored sample is currently loaded in this track, if any. */
  getBufferLabel(id: string): string {
    const track = this.tracks.get(id)
    return track && track.buffer ? track.bufferLabel : ''
  }

  /**
   * Edge fades for the clip, in seconds. Tiny default ramps (5 ms) are always
   * present so a trimmed edge never clicks; the user can extend them.
   */
  setClipFade(id: string, fadeIn: number, fadeOut: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.fadeIn = Math.max(0, Math.min(10, fadeIn))
    track.fadeOut = Math.max(0, Math.min(10, fadeOut))
  }

  getClipFade(id: string): { fadeIn: number; fadeOut: number } {
    const track = this.tracks.get(id)
    return { fadeIn: track?.fadeIn ?? 0, fadeOut: track?.fadeOut ?? 0 }
  }

  // -------------------------------------------------------------- automation

  /**
   * Volume automation for one track: breakpoints at 16th-note steps, levels in
   * dB relative to the fader. It runs on its own gain node, so drawing a lane
   * never moves the fader the user set and riding the fader never erases a lane.
   */
  setAutomation(id: string, points: AutomationBreakpoint[]): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.automation = sortedAutomation(points)
    // Live edit while rolling: re-cut the envelope from where the song is now.
    if (this.songOriginTime !== null) this.scheduleAutomation(track)
  }

  getAutomation(id: string): AutomationBreakpoint[] {
    return [...(this.tracks.get(id)?.automation ?? [])]
  }

  /**
   * Schedules one track's envelope onto its automation node. Ramps are
   * exponential between successive gains, which is what makes the param move in a
   * straight line in dB - the same line the lane draws and the same shape the
   * offline render builds.
   */
  private scheduleAutomation(track: EngineTrack, fromStep = 0): void {
    const origin = this.songOriginTime
    if (origin === null) return
    const stepDuration = this.songStepDuration
    const now = this.ctx.currentTime
    // A playback that starts mid-envelope has to resume it, not restart it.
    const startStep = Math.max(0, fromStep, (now - origin) / stepDuration)
    scheduleAutomationEnvelope(
      track.autoGain.gain,
      track.automation,
      origin,
      stepDuration,
      startStep,
      now,
    )
  }

  /**
   * Clears every automation envelope. Called on stop so a parked playhead never
   * leaves a track sitting at the last drawn gain.
   */
  private resetAutomation(): void {
    this.songOriginTime = null
    const now = this.ctx.currentTime
    this.tracks.forEach((track) => {
      track.autoGain.gain.cancelScheduledValues(now)
      track.autoGain.gain.setValueAtTime(1, now)
    })
  }

  /**
   * Round-trip estimate in milliseconds (render quantum + output latency).
   * What you hear through the monitors arrives this late, so a take sung "in
   * time" lands behind the grid by roughly the same amount.
   */
  latencyMs(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number }
    const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency ?? 0 : 0
    const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency ?? 0 : 0
    return Math.max(0, Math.round((base + out) * 1000))
  }

  // ------------------------------------------------------------ output device

  /**
   * Which playback device the mix leaves through. Empty means the system
   * default, which is the only path a browser gives without asking.
   */
  get outputDeviceId(): string {
    return this.outputDevice
  }

  /**
   * Send the whole mix — every lane, the sends, the metronome and the live
   * input — out of one chosen speaker instead of the default one.
   *
   * A Web Audio graph cannot name a device, but it can hand its output to a
   * media stream, and a media element can be told which playback device to use.
   * So the sum goes to a hidden stream and that stream plays on the chosen
   * card. It is a real gain: an interface with its own outputs for headphones
   * and monitors can be picked here. It costs a little latency, which is why
   * the number next to it is shown, and it is not ASIO: a browser and Electron
   * reach the card through the system mixer (WASAPI shared on Windows), so the
   * exclusive-driver path of a pro interface is not available to this program.
   */
  async setOutputDevice(deviceId: string): Promise<OutputRoute> {
    const wanted = deviceId.trim()
    if (!wanted) {
      this.releaseOutputStream()
      this.outputDevice = ''
      // Back on the card the context picked for itself.
      this.masterAnalyser.disconnect()
      this.masterAnalyser.connect(this.ctx.destination)
      return { deviceId: '', label: 'Dispositivo padrão do sistema', routed: false, error: '' }
    }

    const label = await outputLabelFor(wanted)
    if (!this.outputSink) {
      try {
        this.outputSink = this.ctx.createMediaStreamDestination()
      } catch (error) {
        return { deviceId: '', label, routed: false, error: (error as Error).message }
      }
      this.masterAnalyser.connect(this.outputSink)
    }
    if (!this.outputElement) {
      const element = document.createElement('audio')
      element.srcObject = this.outputSink.stream
      element.autoplay = true
      // The element is the speaker: keeping it in the page but invisible is the
      // only way to name a playback device for a Web Audio graph.
      element.style.position = 'absolute'
      element.style.width = '1px'
      element.style.height = '1px'
      element.style.opacity = '0'
      element.setAttribute('aria-hidden', 'true')
      document.body.appendChild(element)
      this.outputElement = element
    }
    const element = this.outputElement
    try {
      if (typeof element.setSinkId === 'function') await element.setSinkId(wanted)
      else throw new Error('esta máquina não expõe dispositivos de saída')
      await element.play()
    } catch (error) {
      // The chosen card refused: say so, and leave the mix on the default path
      // rather than in a silent room.
      const message = (error as Error).message || 'a saída escolhida não aceitou o áudio'
      this.releaseOutputStream()
      this.outputDevice = ''
      this.masterAnalyser.disconnect()
      this.masterAnalyser.connect(this.ctx.destination)
      return { deviceId: '', label, routed: false, error: message }
    }
    // Only take the default road away once the chosen one is carrying sound.
    this.masterAnalyser.disconnect(this.ctx.destination)
    this.outputDevice = wanted
    return { deviceId: wanted, label, routed: true, error: '' }
  }

  /** Everything the mix's exit looks like, for the device window. */
  describeOutput(): { deviceId: string; routed: boolean; latencyMs: number; inputLatencyMs: number } {
    return {
      deviceId: this.outputDevice,
      routed: Boolean(this.outputElement?.sinkId && this.outputSink),
      latencyMs: this.latencyMs(),
      inputLatencyMs: this.inputLatencyMs(),
    }
  }

  /**
   * What the browser admits about the entry side. Chrome reports it on the
   * AudioContext when the input is a real device; a value of 0 means the
   * browser gave nothing, which is reported as 0 rather than guessed at.
   */
  inputLatencyMs(): number {
    const ctx = this.ctx as AudioContext & { inputLatency?: number }
    const inLatency = Number.isFinite(ctx.inputLatency) ? ctx.inputLatency ?? 0 : 0
    return Math.max(0, Math.round(inLatency * 1000))
  }

  private releaseOutputStream(): void {
    const element = this.outputElement
    if (element) {
      try {
        element.pause()
      } catch {
        /* never started */
      }
      element.srcObject = null
      element.remove()
      this.outputElement = null
    }
    if (this.outputSink) {
      try {
        this.masterAnalyser.disconnect(this.outputSink)
      } catch {
        /* already detached */
      }
      this.outputSink.stream.getTracks().forEach((track) => track.stop())
      this.outputSink = null
    }
  }

  setClipStart(id: string, step: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.clipStart = Math.max(0, step)
  }

  /**
   * Trims the tail of a recorded clip without touching the stored sample, so
   * the edit stays reversible. `seconds` is clamped to the buffer length.
   */
  setClipDuration(id: string, seconds: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    if (!track.buffer) {
      track.clipDuration = 0
      return
    }
    const max = track.buffer.duration
    track.clipDuration = Math.min(max, Math.max(0.02, seconds || max))
  }

  getClipDuration(id: string): number {
    return this.tracks.get(id)?.clipDuration ?? 0
  }

  /** Full length of the stored sample, used to clamp timeline trims. */
  getBufferDuration(id: string): number {
    return this.tracks.get(id)?.buffer?.duration ?? 0
  }

  /**
   * Copies `from`..`to` seconds of a track's take into a fresh buffer. Used by
   * the razor: a lane holds one clip, so the second half becomes its own file
   * that another lane can carry.
   */
  sliceBuffer(id: string, from: number, to: number): AudioBuffer | null {
    const src = this.tracks.get(id)?.buffer
    if (!src) return null
    const a = Math.max(0, Math.min(src.length, Math.round(from * src.sampleRate)))
    const b = Math.max(a, Math.min(src.length, Math.round(to * src.sampleRate)))
    if (b - a <= 0) return null
    const out = this.ctx.createBuffer(src.numberOfChannels, b - a, src.sampleRate)
    for (let channel = 0; channel < src.numberOfChannels; channel += 1) {
      out.copyToChannel(src.getChannelData(channel).slice(a, b), channel)
    }
    return out
  }

  private clipEnd(track: EngineTrack): number {
    return clipEndOf(track.clipDuration, track.buffer?.duration ?? 0)
  }

  hasBuffer(id: string): boolean {
    return Boolean(this.tracks.get(id)?.buffer)
  }

  /**
   * Schedules every recorded clip relative to the song position.
   * `stepDuration` is the length of a 16th note in seconds.
   */
  startBuffersAt(when: number, stepDuration: number, fromStep: number): void {
    // Automation is written in steps and scheduled in seconds; this is the
    // translation for the pass that is about to start.
    this.songStepDuration = stepDuration > 0 ? stepDuration : 0.125
    this.songOriginTime = when - fromStep * this.songStepDuration
    this.tracks.forEach((track) => this.scheduleAutomation(track, fromStep))
    this.tracks.forEach((track, trackId) => {
      // A lane with a rendered native pass plays that pass; the take underneath
      // stays where the producer left it.
      const take = takeToPlay(track)
      if (!take) return
      const source = this.ctx.createBufferSource()
      source.buffer = take
      const shape = this.ctx.createGain()
      // The lane's own clip reaches the chain through a gain of its own, so a wet
      // print can close it without disturbing the fades scheduled above.
      const clipMute = this.ctx.createGain()
      clipMute.gain.value = this.recorders.get(trackId)?.wet ? 0 : 1
      track.clipMute = clipMute
      source.connect(shape)
      shape.connect(clipMute)
      clipMute.connect(track.panner)

      const end = this.clipEnd(track)
      const delta = track.clipStart - fromStep
      if (delta >= 0) {
        const t0 = when + delta * stepDuration
        source.start(t0, 0, Math.max(0.02, end))
        scheduleClipFade(shape, t0, 0, end, track.fadeIn, track.fadeOut)
      } else {
        const offset = -delta * stepDuration
        if (offset >= end) return
        source.start(when, offset, Math.max(0.02, end - offset))
        scheduleClipFade(shape, when, offset, end, track.fadeIn, track.fadeOut)
      }
      // Prune finished sources so a long looping session never accumulates them.
      source.onended = () => {
        const idx = this.sources.indexOf(source)
        if (idx >= 0) this.sources.splice(idx, 1)
        if (track.clipMute === clipMute) track.clipMute = null
      }
      this.sources.push(source)
    })
  }

  playBuffers(when = this.ctx.currentTime): void {
    this.stopBuffers()
    this.startBuffersAt(when, 0.125, 0)
  }

  /**
   * Stops every scheduled source. `keepAutomation` is for the loop wrap, where
   * a stop is only the other half of a restart: resetting the lanes there would
   * drop every track back to the fader for the few milliseconds between the two
   * calls, and that seam is audible.
   */
  stopBuffers(keepAutomation = false): void {
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    })
    this.sources.length = 0
    this.stopNotes()
    // A stopped song must not leave a track parked at whatever the last drawn
    // breakpoint said; the fader is what you hear again.
    if (!keepAutomation) this.resetAutomation()
  }

  // ------------------------------------------------------------ instruments

  setInstrument(trackId: string, kind: InstrumentKind | null, voice = ''): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.instrument = kind
    track.voice = voice
  }

  setNotes(trackId: string, notes: InstrumentNote[], patternSteps = 0): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.notes = notes
    track.patternSteps = isPatterned(patternSteps) ? Math.round(patternSteps) : 0
  }

  /** Plays one synth voice through the track's full signal chain. */
  playNote(
    trackId: string,
    kind: InstrumentKind,
    pitch: number,
    velocity: number,
    when: number,
    duration: number,
  ): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    // Live playing (MIDI pad or the computer keyboard) is often the first thing
    // a visitor does, before the transport ever ran. A suspended context keeps a
    // frozen currentTime, so wake it up and schedule against the clock it has
    // afterwards instead of a timestamp that is already in the past.
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().then(() => this.voice(track, kind, pitch, velocity, when, duration)).catch(() => {})
      return
    }
    this.voice(track, kind, pitch, velocity, when, duration)
  }

  private voice(
    track: EngineTrack,
    kind: InstrumentKind,
    pitch: number,
    velocity: number,
    when: number,
    duration: number,
  ): void {
    const gate = this.ctx.createGain()
    gate.gain.value = 1
    gate.connect(track.panner)
    scheduleVoice(this.ctx, gate, kind, pitch, velocity, Math.max(when, this.ctx.currentTime), duration, track.voice)
    const entry = {
      gate,
      timer: window.setTimeout(() => {
        const idx = this.voiceGates.indexOf(entry)
        if (idx >= 0) this.voiceGates.splice(idx, 1)
        gate.disconnect()
      }, (duration + 2.5) * 1000),
    }
    this.voiceGates.push(entry)
  }

  /** Silences every in-flight instrument voice (seek / stop / loop restart). */
  stopNotes(): void {
    for (const { gate, timer } of this.voiceGates) {
      window.clearTimeout(timer)
      try {
        gate.disconnect()
      } catch {
        /* already detached */
      }
    }
    this.voiceGates.length = 0
  }

  // ------------------------------------------------------------- rendering

  /**
   * Rebuilds the track chain inside an OfflineAudioContext so the exported file
   * sounds like what you hear (plugins included).
   */
  private async buildOfflinePlugin(
    ctx: OfflineAudioContext,
    plugin: PluginInstance,
    warnings: string[],
  ): Promise<{ input: AudioNode; output: AudioNode } | null> {
    const paramValue = (name: string, fallback: number): number => {
      const param = plugin.params.find((item) => item.name === name)
      return param ? param.value : fallback
    }

    if (plugin.kind === 'ir' && plugin.source.irBuffer) {
      const input = ctx.createGain()
      const output = ctx.createGain()
      const dry = ctx.createGain()
      const wet = ctx.createGain()
      const sum = ctx.createGain()
      const level = ctx.createGain()
      const panner = ctx.createStereoPanner()
      const lowCut = ctx.createBiquadFilter()
      const highCut = ctx.createBiquadFilter()
      const convolver = ctx.createConvolver()
      const mix = paramValue('Mix', 1)

      lowCut.type = 'highpass'
      lowCut.frequency.value = paramValue('Low Cut', 20)
      highCut.type = 'lowpass'
      highCut.frequency.value = paramValue('High Cut', 20000)
      convolver.normalize = true
      convolver.buffer = plugin.source.irBuffer
      dry.gain.value = 1 - mix
      wet.gain.value = mix
      level.gain.value = paramValue('Output', 1.2)
      panner.pan.value = paramValue('Pan', 0)

      input.connect(dry)
      dry.connect(sum)
      input.connect(lowCut)
      lowCut.connect(highCut)
      highCut.connect(convolver)
      convolver.connect(wet)
      wet.connect(sum)
      sum.connect(level)
      level.connect(panner)
      panner.connect(output)
      return { input, output: panner }
    }

    if (plugin.kind === 'worklet' && plugin.source.workletSource && plugin.source.processorName) {
      const name = plugin.source.processorName
      try {
        await this.ensureWorkletModule(ctx, name, plugin.source.workletSource)
        const node = new AudioWorkletNode(ctx, name)
        const panner = ctx.createStereoPanner()
        panner.pan.value = paramValue('Pan', 0)
        node.connect(panner)
        for (const param of plugin.params) {
          node.parameters.get(param.name)?.setValueAtTime(param.value, 0)
        }
        return { input: node, output: panner }
      } catch (error) {
        warnings.push(`Plugin "${plugin.name}" ignorado no export: ${(error as Error).message}`)
        return null
      }
    }

    if (plugin.kind === 'nam' && plugin.source.namJson) {
      try {
        const namEngine = await withTimeout(
          NamEngine.attach(ctx, { assetBaseUrl: NAM_ASSET_BASE }),
          5000,
          'motor NAM não respondeu no contexto offline',
        )
        const nodes: NamNode[] = []
        for (let channel = 0; channel < 2; channel += 1) {
          const node = await withTimeout(
            namEngine.createNode(),
            5000,
            'nó NAM não pôde ser criado offline',
          )
          node.channelCount = 1
          node.channelCountMode = 'explicit'
          await withTimeout(
            node.loadModel(plugin.source.namJson, {
              slimSize: plugin.source.namSlim,
            }),
            8000,
            'modelo NAM não carregou offline',
          )
          nodes.push(node)
        }

        const input = ctx.createGain()
        const output = ctx.createGain()
        const dry = ctx.createGain()
        const wet = ctx.createGain()
        const sum = ctx.createGain()
        const level = ctx.createGain()
        const panner = ctx.createStereoPanner()
        const stereo = ctx.createGain()
        const splitter = ctx.createChannelSplitter(2)
        const merger = ctx.createChannelMerger(2)
        const bass = ctx.createBiquadFilter()
        const mid = ctx.createBiquadFilter()
        const treble = ctx.createBiquadFilter()
        const presence = ctx.createBiquadFilter()

        stereo.channelCount = 2
        stereo.channelCountMode = 'explicit'
        stereo.channelInterpretation = 'speakers'
        bass.type = 'lowshelf'
        bass.frequency.value = 120
        bass.gain.value = paramValue('Bass', 0)
        mid.type = 'peaking'
        mid.frequency.value = 700
        mid.Q.value = 0.9
        mid.gain.value = paramValue('Mid', 0)
        treble.type = 'highshelf'
        treble.frequency.value = 3200
        treble.gain.value = paramValue('Treble', 0)
        presence.type = 'peaking'
        presence.frequency.value = 4500
        presence.Q.value = 0.7
        presence.gain.value = paramValue('Presence', 0)

        const mix = paramValue('Mix', 1)
        input.gain.value = paramValue('Input', 1)
        dry.gain.value = 1 - mix
        wet.gain.value = mix
        level.gain.value = paramValue('Output', 1)
        panner.pan.value = paramValue('Pan', 0)

        input.connect(stereo)
        stereo.connect(splitter)
        splitter.connect(nodes[0], 0)
        splitter.connect(nodes[1], 1)
        nodes[0].connect(merger, 0, 0)
        nodes[1].connect(merger, 0, 1)
        merger.connect(bass)
        bass.connect(mid)
        mid.connect(treble)
        treble.connect(presence)
        presence.connect(wet)
        wet.connect(sum)
        input.connect(dry)
        dry.connect(sum)
        sum.connect(level)
        level.connect(panner)
        panner.connect(output)
        return { input, output: panner }
      } catch (error) {
        warnings.push(`NAM "${plugin.name}" ignorado no export: ${(error as Error).message}`)
        return null
      }
    }

    return null
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    const sampleRate = this.ctx.sampleRate
    const bars = Math.max(1, Math.floor(request.bars))
    const totalSteps = bars * 16
    const stepDuration = 60 / Math.max(30, request.bpm) / 4
    // A single track export only needs to cover its recorded clip; a stem has to
    // be as long as the arrangement so all of them start and end together.
    const stem = Boolean(request.trackId) || Boolean(request.groupId)
    const sequenceDuration = stem && !request.aligned ? 0 : totalSteps * stepDuration

    const entries: Array<[string, EngineTrack]> = []
    for (const [id, track] of this.tracks) {
      if (request.trackId && id !== request.trackId) continue
      if (request.groupId && track.groupId !== request.groupId) continue
      entries.push([id, track])
    }

    let contentDuration = sequenceDuration
    const noteEnd = (track: EngineTrack): number =>
      patternContentEnd(track.notes, track.patternSteps, totalSteps) * stepDuration
    for (const [, track] of entries) {
      if (track.buffer) {
        contentDuration = Math.max(
          contentDuration,
          track.clipStart * stepDuration + this.clipEnd(track),
        )
      }
      if (track.instrument && track.notes.length > 0) {
        contentDuration = Math.max(contentDuration, noteEnd(track))
      }
    }

    // Reverb/delay tails must fit in the exported file.
    let tail = 0
    const busTail = (reverbEnabled: boolean, delayEnabled: boolean): void => {
      if (reverbEnabled) tail = Math.max(tail, this.sendConfig.rvDecay * 0.9)
      if (delayEnabled) {
        tail = Math.max(
          tail,
          (this.sendConfig.dlTime / 1000) * (2 + this.sendConfig.dlFeedback * 4),
        )
      }
    }
    for (const [, track] of entries) {
      if (!track.buffer && !(track.instrument && track.notes.length > 0)) continue
      if (track.fx.state.reverb.enabled) {
        tail = Math.max(tail, track.fx.state.reverb.params.decay * 0.9)
      }
      if (track.fx.state.delay.enabled) {
        const delay = track.fx.state.delay.params
        tail = Math.max(tail, (delay.time / 1000) * (2 + delay.feedback * 4))
      }
      // Shared send buses only ring when a track actually feeds them.
      busTail(track.rvSend.gain.value > 0, track.dlSend.gain.value > 0)
    }
    if (this.masterFx.state.reverb.enabled) {
      tail = Math.max(tail, this.masterFx.state.reverb.params.decay * 0.9)
    }
    if (this.masterFx.state.delay.enabled) {
      const delay = this.masterFx.state.delay.params
      tail = Math.max(tail, (delay.time / 1000) * (2 + delay.feedback * 4))
    }
    const duration = contentDuration + 0.35 + tail

    const offline = new OfflineAudioContext(
      2,
      Math.max(1, Math.ceil(duration * sampleRate)),
      sampleRate,
    )

    const master = offline.createGain()
    // A stem is the track as it leaves its own fader, not the master bus with one
    // track soloed: putting the glue/limiting on every stem would make them sum
    // to something that is not the mix. The mix keeps the full chain.
    master.gain.value = stem ? 1 : request.masterMuted ? 0 : request.masterVolume
    master.connect(offline.destination)

    const masterSum = offline.createGain()
    if (stem) {
      masterSum.connect(master)
    } else {
      // Mirror of the live master bus: sum -> glue FX -> volume.
      const masterFx = createBuiltinChain(offline, this.masterFx.state)
      wireBuiltinSerial(masterFx)
      masterSum.connect(masterFx.input)
      masterFx.output.connect(master)
    }

    const reverbBus = this.createSendBus('reverb', offline, masterSum)
    const delayBus = this.createSendBus('delay', offline, masterSum)

    // Sub-groups, built on demand so only the buses this export actually feeds
    // exist. Same shape as live: member -> pan -> fader -> master sum.
    const groupBuses = new Map<string, GainNode>()
    const groupDestination = (groupId: string): GainNode => {
      if (groupId === '') return masterSum
      const existing = groupBuses.get(groupId)
      if (existing) return existing
      const group = this.groups.get(groupId)
      if (!group) return masterSum
      const input = offline.createGain()
      const panner = offline.createStereoPanner()
      const output = offline.createGain()
      panner.pan.value = group.pan
      output.gain.value = this.groupsGain(group.volume, group.muted)
      input.connect(panner)
      panner.connect(output)
      output.connect(masterSum)
      groupBuses.set(groupId, input)
      return input
    }

    interface DuckWire {
      trackId: string
      duckGain: GainNode
      /** Every source of the duck, joined at the follower's input like the live graph. */
      sourceIds: string[]
      depth: number
    }
    const duckWires: DuckWire[] = []
    const trackOutputs = new Map<string, ChannelMergerNode>()

    const warnings: string[] = []
    let renderedTracks = 0

    for (const [trackId, track] of entries) {
      const hasNotes = Boolean(track.instrument) && track.notes.length > 0
      if (!track.buffer && !hasNotes) continue
      renderedTracks += 1

      const panner = offline.createStereoPanner()
      panner.pan.value = track.pan

      const fxInput = offline.createGain()
      const shaper = offline.createWaveShaper()
      const filter = offline.createBiquadFilter()
      const fx = createBuiltinChain(offline, track.fx.state)
      const namSplit = offline.createGain()
      const namSum = offline.createGain()
      const gain = offline.createGain()
      const autoGain = offline.createGain()
      const monoSplitter = offline.createChannelSplitter(2)
      const monoMerger = offline.createChannelMerger(2)
      const monoGains = [
        offline.createGain(),
        offline.createGain(),
        offline.createGain(),
        offline.createGain(),
      ]
      const rvSend = offline.createGain()
      const dlSend = offline.createGain()
      const duckGain = offline.createGain()

      if (track.shaper.curve) {
        shaper.curve = new Float32Array(track.shaper.curve)
      }
      filter.type = track.filter.type
      filter.frequency.value = track.filter.frequency.value
      gain.gain.value = track.muted ? 0 : track.volume * track.trim * track.phase
      const direct = track.mono ? 0.5 : 1
      const cross = track.mono ? 0.5 : 0
      monoGains[0].gain.value = direct
      monoGains[1].gain.value = cross
      monoGains[2].gain.value = cross
      monoGains[3].gain.value = direct
      rvSend.gain.value = track.rvSend.gain.value
      dlSend.gain.value = track.dlSend.gain.value
      duckGain.gain.value = 1

      panner.connect(fxInput)
      fxInput.connect(shaper)
      shaper.connect(filter)

      const pluginsMap = new Map(track.plugins.map((plugin) => [plugin.id, plugin]))

      interface OfflineBranch {
        id: string
        plugins: Array<{ input: AudioNode; output: AudioNode }>
      }
      const offlineBranches: OfflineBranch[] = []
      const branchPluginIds = new Set<string>()

      let currentOffBranch: OfflineBranch | null = null
      for (const stage of track.chain) {
        if (stage.kind === 'builtin') {
          currentOffBranch = null
          continue
        }
        const plugin = pluginsMap.get(stage.id)
        if (!plugin || !plugin.enabled) continue

        const built = await this.buildOfflinePlugin(offline, plugin, warnings)
        if (!built) continue

        if (plugin.kind === 'nam') {
          currentOffBranch = { id: plugin.id, plugins: [built] }
          offlineBranches.push(currentOffBranch)
          branchPluginIds.add(plugin.id)
        } else if (currentOffBranch) {
          currentOffBranch.plugins.push(built)
          branchPluginIds.add(plugin.id)
        }
      }

      const builtStandalone = new Map<string, { input: AudioNode; output: AudioNode }>()

      let cursor: AudioNode = filter
      let parallelConnected = false

      for (const stage of track.chain) {
        if (branchPluginIds.has(stage.id)) {
          if (!parallelConnected && offlineBranches.length > 0) {
            cursor.connect(namSplit)
            for (const branch of offlineBranches) {
              let bCursor: AudioNode = namSplit
              for (const built of branch.plugins) {
                bCursor.connect(built.input)
                bCursor = built.output
              }
              bCursor.connect(namSum)
            }
            cursor = namSum
            parallelConnected = true
          }
          continue
        }

        if (stage.kind === 'builtin') {
          const unit = fx.units[stage.id]
          cursor.connect(unit.input)
          cursor = unit.output
          continue
        }

        const plugin = pluginsMap.get(stage.id)
        if (!plugin || !plugin.enabled) continue

        let built = builtStandalone.get(plugin.id)
        if (!built) {
          const res = await this.buildOfflinePlugin(offline, plugin, warnings)
          if (!res) continue
          built = res
          builtStandalone.set(plugin.id, built)
        }

        cursor.connect(built.input)
        cursor = built.output
      }

      cursor.connect(gain)
      gain.connect(autoGain)
      scheduleAutomationEnvelope(autoGain.gain, track.automation, 0, stepDuration, 0, 0)
      autoGain.connect(monoSplitter)
      monoSplitter.connect(monoGains[0], 0)
      monoSplitter.connect(monoGains[1], 0)
      monoSplitter.connect(monoGains[2], 1)
      monoSplitter.connect(monoGains[3], 1)
      monoGains[0].connect(monoMerger, 0, 0)
      monoGains[1].connect(monoMerger, 0, 1)
      monoGains[2].connect(monoMerger, 0, 0)
      monoGains[3].connect(monoMerger, 0, 1)
      monoMerger.connect(duckGain)
      duckGain.connect(groupDestination(track.groupId))
      duckGain.connect(rvSend)
      rvSend.connect(reverbBus.input)
      duckGain.connect(dlSend)
      dlSend.connect(delayBus.input)
      trackOutputs.set(trackId, monoMerger)
      // The follower needs both ends of the graph, so it is wired after every
      // track exists; a source may be later in the list than the duck.
      if (track.duck && track.duckSourceIds.length > 0) {
        duckWires.push({
          trackId,
          duckGain,
          sourceIds: [...track.duckSourceIds],
          depth: track.duckDepth,
        })
      }

      // The same question the live transport asks, so a plugin that is audible in
      // the room is in the file, and one that is not is missing from both.
      const take = takeToPlay(track)
      if (take) {
        const source = offline.createBufferSource()
        source.buffer = take
        const shape = offline.createGain()
        source.connect(shape)
        shape.connect(panner)
        const start = track.clipStart * stepDuration
        const end = this.clipEnd(track)
        source.start(start, 0, Math.max(0.02, end))
        scheduleClipFade(shape, start, 0, end, track.fadeIn, track.fadeOut)
      }

      if (track.instrument) {
        for (const note of track.notes) {
          if (!isPatterned(track.patternSteps)) {
            scheduleVoice(
              offline,
              panner,
              track.instrument,
              note.pitch,
              note.velocity,
              note.step * stepDuration,
              note.length * stepDuration,
              track.voice,
            )
            continue
          }
          // A pattern repeats to the end of the arrangement: the same
          // `patternContentEnd` the duration above used, so the exported take
          // has exactly the hits the grid showed.
          for (
            let step = note.step;
            step < totalSteps;
            step += track.patternSteps
          ) {
            scheduleVoice(
              offline,
              panner,
              track.instrument,
              note.pitch,
              note.velocity,
              step * stepDuration,
              note.length * stepDuration,
              track.voice,
            )
          }
        }
      }
    }

    if (renderedTracks === 0) {
      warnings.push('nenhuma track com áudio gravado — o arquivo pode ficar silencioso')
    }

    // Sidechain ducks, second pass: every track node exists now, so each follower
    // can read its sources and drive the ducked track's gain, exactly as live.
    if (duckWires.length > 0) {
      await this.ensureWorkletModule(offline, SIDECHAIN_PROCESSOR_NAME, SIDECHAIN_WORKLET_SOURCE)
      for (const wire of duckWires) {
        const sources = wire.sourceIds
          .map((sourceId) => ({ sourceId, node: trackOutputs.get(sourceId) }))
          .filter((entry): entry is { sourceId: string; node: ChannelMergerNode } =>
            Boolean(entry.node),
          )
        const missing = wire.sourceIds.filter(
          (sourceId) => !sources.some((entry) => entry.sourceId === sourceId),
        )
        if (missing.length > 0) {
          warnings.push(
            `sidechain da track ${wire.trackId}: ${missing.join(', ')} não está nesta exportação - o duck do arquivo seguiu as fontes que restam`,
          )
        }
        // With none of its sources present, the follower would open the gate for
        // the whole file; leaving the track alone is what the meters showed.
        if (sources.length === 0) continue
        const follower = new AudioWorkletNode(offline, SIDECHAIN_PROCESSOR_NAME, {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        })
        follower.parameters.get('depth')?.setValueAtTime(wire.depth, 0)
        const sink = offline.createGain()
        sink.gain.value = 0
        follower.connect(sink)
        sink.connect(masterSum)
        follower.connect(wire.duckGain.gain)
        // Every source joins the same input, so the file ducks to their sum - the
        // same summing the live graph does, not the louder of the two.
        for (const { node } of sources) node.connect(follower)
        wire.duckGain.gain.value = 0
      }
    }

    const buffer = await offline.startRendering()

    // Keep exported files from clipping when a hot input or stacked plugins
    // push the mix above 0 dBFS.
    let peak = 0
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel)
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i])
        if (value > peak) peak = value
      }
    }
    if (peak > 0.99) {
      const scale = 0.99 / peak
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel)
        for (let i = 0; i < data.length; i += 1) data[i] *= scale
      }
      warnings.push(
        `o mix estourou 0 dBFS: tudo foi rebaixado ${(-20 * Math.log10(scale)).toFixed(1)} dB para caber no arquivo`,
      )
    }

    // Measured on what the file actually contains, after any trim, so the number
    // the producer reads is the number the player will hear.
    const channels: ArrayLike<number>[] = []
    for (let channel = 0; channel < Math.min(2, buffer.numberOfChannels); channel += 1) {
      channels.push(buffer.getChannelData(channel))
    }
    const loudness = measureLoudness(channels, buffer.sampleRate)

    // The trim above only ever looks at the samples. A file that stops just
    // below 0 dBFS can still overshoot between two of them, and that overshoot
    // is what a phone's converter turns into crackle - so it gets said out loud
    // rather than left for the producer to discover after the upload.
    if (Number.isFinite(loudness.truePeakDb) && loudness.truePeakDb > -0.5) {
      warnings.push(
        `true peak em ${loudness.truePeakDb.toFixed(1)} dBTP: acima de -1 dBTP os codificadores de streaming costumam distorcer - rebaixe o master ou segure o limitador`,
      )
    }

    return { buffer, warnings, loudness }
  }
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels)
  const length = buffer.length
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = length * blockAlign
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  const channelData: Float32Array[] = []
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(buffer.getChannelData(channel))
  }

  let offset = 44
  for (let i = 0; i < length; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][i] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

function measurePeak(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let peak = 0
  for (let i = 0; i < data.length; i += 1) {
    const value = Math.abs(data[i] - 128) / 128
    if (value > peak) peak = value
  }
  return peak
}
