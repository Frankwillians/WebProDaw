/**
 * Audio Engine - Web Audio API
 *
 * Per track signal path:
 *   input device ─┐
 *   recorded clip ─┼─> panner -> fxInput -> [plugin chain] -> shaper -> filter -> gain -> analyser -> master
 *
 * Plugin chain supports:
 *   - IR / cabinet convolution (ConvolverNode)
 *   - external AudioWorklet plugins (.js files registering a processor)
 *   - Neural Amp Modeler models (.nam) running through the TONE3000 WASM engine
 *
 * The same chain can be rebuilt inside an OfflineAudioContext to export audio.
 */

import { NamEngine } from 'neural-amp-modeler-wasm/engine'
import type { NamModelInfo } from 'neural-amp-modeler-wasm/engine'

export type PluginKind = 'ir' | 'worklet' | 'nam'

// ------------------------------------------------------------ native FX rack

export const BUILTIN_FX_IDS = ['dist', 'chorus', 'reverb', 'delay'] as const
export type BuiltinFxId = (typeof BUILTIN_FX_IDS)[number]

export interface BuiltinFxParams {
  drive: number
  tone: number
  rate: number
  depth: number
  decay: number
  time: number
  feedback: number
}

export interface BuiltinFxUnit {
  enabled: boolean
  mix: number
  params: BuiltinFxParams
}

export type BuiltinFxRack = Record<BuiltinFxId, BuiltinFxUnit>

export function defaultBuiltinFx(): BuiltinFxRack {
  const params = (): BuiltinFxParams => ({
    drive: 0.45,
    tone: 3800,
    rate: 1.1,
    depth: 3.5,
    decay: 2.4,
    time: 320,
    feedback: 0.32,
  })
  return {
    dist: { enabled: false, mix: 0.5, params: params() },
    chorus: { enabled: false, mix: 0.4, params: params() },
    reverb: { enabled: false, mix: 0.28, params: params() },
    delay: { enabled: false, mix: 0.25, params: params() },
  }
}

export type DrumInstrument = 'kick' | 'snare' | 'hihat'

export interface DrumStepData {
  /** 0 = off, 1 = normal, 2 = acento */
  kick: number
  snare: number
  hihat: number
}

export interface PluginParamInfo {
  name: string
  value: number
  min: number
  max: number
}

export interface PluginInfo {
  id: string
  name: string
  kind: PluginKind
  params: PluginParamInfo[]
  detail?: string
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

interface EngineTrack {
  panner: StereoPannerNode
  fxInput: GainNode
  shaper: WaveShaperNode
  filter: BiquadFilterNode
  fx: BuiltinChain
  gain: GainNode
  analyser: AnalyserNode
  plugins: PluginInstance[]
  muted: boolean
  volume: number
  pan: number
  buffer: AudioBuffer | null
  clipStart: number
  clipDuration: number
}

interface InputEntry {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  gain: GainNode
}

export interface RenderRequest {
  bpm: number
  bars: number
  drumSteps: DrumStepData[]
  /** Frequencies for each row of the piano roll grid. */
  synthNotes: number[]
  synthGrid: boolean[][]
  /** When set, renders only this track (recorded clip) instead of the full mix. */
  trackId?: string
  masterVolume: number
  masterMuted: boolean
}

export interface RenderResult {
  buffer: AudioBuffer
  warnings: string[]
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

function velocityGain(velocity: number): number {
  return velocity >= 2 ? 1.35 : velocity >= 1 ? 1 : 0
}

// ------------------------------------------------------------ sound design
// Standalone schedulers so the sequencer can be rendered offline (export) or
// scheduled live on the running AudioContext.

function scheduleKick(ctx: BaseAudioContext, destination: AudioNode, time: number, velocity = 1): void {
  const level = velocityGain(velocity)
  if (level === 0) return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.setValueAtTime(155, time)
  osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.42)
  gain.gain.setValueAtTime(level, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5)
  osc.connect(gain)
  gain.connect(destination)
  osc.start(time)
  osc.stop(time + 0.52)
}

function scheduleSnare(ctx: BaseAudioContext, destination: AudioNode, time: number, velocity = 1): void {
  const level = velocityGain(velocity)
  if (level === 0) return
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.2))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1

  const noise = ctx.createBufferSource()
  noise.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 1200
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.55 * level, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2)
  noise.connect(filter)
  filter.connect(gain)
  gain.connect(destination)
  noise.start(time)
  noise.stop(time + 0.22)

  // A little body under the noise makes it read as a snare instead of a hiss.
  const body = ctx.createOscillator()
  const bodyGain = ctx.createGain()
  body.type = 'triangle'
  body.frequency.setValueAtTime(190, time)
  body.frequency.exponentialRampToValueAtTime(120, time + 0.12)
  bodyGain.gain.setValueAtTime(0.28 * level, time)
  bodyGain.gain.exponentialRampToValueAtTime(0.001, time + 0.14)
  body.connect(bodyGain)
  bodyGain.connect(destination)
  body.start(time)
  body.stop(time + 0.16)
}

function scheduleHiHat(ctx: BaseAudioContext, destination: AudioNode, time: number, velocity = 1): void {
  const level = velocityGain(velocity)
  if (level === 0) return
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.05))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1

  const noise = ctx.createBufferSource()
  noise.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 7500
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.32 * level, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
  noise.connect(filter)
  filter.connect(gain)
  gain.connect(destination)
  noise.start(time)
  noise.stop(time + 0.06)
}

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

function scheduleNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  time: number,
  frequency: number,
  duration: number,
  type: OscillatorType = 'sawtooth',
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(Math.min(9000, frequency * 8), time)
  osc.type = type
  osc.frequency.setValueAtTime(frequency, time)
  gain.gain.setValueAtTime(0.0001, time)
  gain.gain.exponentialRampToValueAtTime(0.18, time + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration)
  osc.connect(filter)
  filter.connect(gain)
  gain.connect(destination)
  osc.start(time)
  osc.stop(time + duration + 0.02)
}

// ------------------------------------------------------------ native FX nodes

interface BuiltinUnitNodes {
  input: GainNode
  output: GainNode
  dry: GainNode
  wet: GainNode
  shaper?: WaveShaperNode
  tone?: BiquadFilterNode
  lfo?: OscillatorNode
  lfoDepth?: GainNode
  convolver?: ConvolverNode
  delay?: DelayNode
  feedback?: GainNode
  decay?: number
}

export interface BuiltinChain {
  units: Record<BuiltinFxId, BuiltinUnitNodes>
  input: GainNode
  output: GainNode
  state: BuiltinFxRack
}

function makeDistortionCurve(drive: number): Float32Array {
  const size = 1024
  const curve = new Float32Array(size)
  const k = 1 + Math.max(0, Math.min(1, drive)) * 60
  const normalizer = Math.tanh(k)
  for (let i = 0; i < size; i += 1) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / normalizer
  }
  return curve as Float32Array
}

function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.max(1, Math.floor(Math.max(0.15, seconds) * rate))
  const buffer = ctx.createBuffer(2, length, rate)
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel)
    let low = 0
    for (let i = 0; i < length; i += 1) {
      const decay = Math.pow(1 - i / length, 2.4)
      const noise = Math.random() * 2 - 1
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
  return { input, output, dry, wet }
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
  chorus.delay = chorusDelay

  const reverb = createUnitShell(ctx)
  const convolver = ctx.createConvolver()
  convolver.normalize = true
  convolver.buffer = makeImpulse(ctx, rack.reverb.params.decay)
  reverb.input.connect(convolver)
  convolver.connect(reverb.wet)
  reverb.convolver = convolver
  reverb.decay = rack.reverb.params.decay

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

  dist.output.connect(chorus.input)
  chorus.output.connect(reverb.input)
  reverb.output.connect(delay.input)

  const chain: BuiltinChain = {
    units: { dist, chorus, reverb, delay },
    input: dist.input,
    output: delay.output,
    state: rack,
  }
  for (const id of BUILTIN_FX_IDS) applyBuiltinUnit(chain.units[id], rack[id])
  return chain
}

export function applyBuiltinUnit(nodes: BuiltinUnitNodes, unit: BuiltinFxUnit): void {
  const mix = unit.enabled ? Math.max(0, Math.min(1, unit.mix)) : 0
  nodes.dry.gain.value = 1 - mix
  nodes.wet.gain.value = mix

  if (nodes.shaper) nodes.shaper.curve = makeDistortionCurve(unit.params.drive) as any
  if (nodes.tone) nodes.tone.frequency.value = unit.params.tone
  if (nodes.lfo) nodes.lfo.frequency.value = unit.params.rate
  if (nodes.lfoDepth) nodes.lfoDepth.gain.value = unit.params.depth / 1000
  if (nodes.convolver && nodes.decay !== unit.params.decay) {
    void nodes.convolver.context
    nodes.convolver.buffer = makeImpulse(nodes.convolver.context, unit.params.decay)
    nodes.decay = unit.params.decay
  }
  if (nodes.delay) nodes.delay.delayTime.value = Math.max(0.01, unit.params.time / 1000)
  if (nodes.feedback) nodes.feedback.gain.value = Math.min(0.92, Math.max(0, unit.params.feedback))
}

export class AudioEngine {
  readonly ctx: AudioContext
  readonly masterGain: GainNode

  private readonly masterAnalyser: AnalyserNode
  private readonly tracks = new Map<string, EngineTrack>()
  private readonly sources: AudioBufferSourceNode[] = []
  private readonly inputs = new Map<string, InputEntry>()
  private readonly recorders = new Map<string, { recorder: MediaRecorder; chunks: Blob[] }>()
  private readonly loadedWorklets = new Set<string>()

  private namEnginePromise: Promise<NamEngine> | null = null
  private masterVolume = 0.9
  private masterMuted = false

  constructor() {
    const Ctor = getAudioContextCtor()
    this.ctx = new Ctor()

    this.masterGain = this.ctx.createGain()
    this.masterGain.gain.value = this.masterVolume

    this.masterAnalyser = this.ctx.createAnalyser()
    this.masterAnalyser.fftSize = 256

    this.masterGain.connect(this.masterAnalyser)
    this.masterAnalyser.connect(this.ctx.destination)
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume()
    }
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

  // ---------------------------------------------------------------- tracks

  addTrack(id: string, volume = 1, pan = 0): void {
    const panner = this.ctx.createStereoPanner()
    const fxInput = this.ctx.createGain()
    const shaper = this.ctx.createWaveShaper()
    const filter = this.ctx.createBiquadFilter()
    const fx = createBuiltinChain(this.ctx, defaultBuiltinFx())
    const gain = this.ctx.createGain()
    const analyser = this.ctx.createAnalyser()

    analyser.fftSize = 256
    gain.gain.value = volume
    panner.pan.value = pan
    filter.type = 'allpass'
    filter.frequency.value = 20000

    this.tracks.set(id, {
      panner,
      fxInput,
      shaper,
      filter,
      fx,
      gain,
      analyser,
      plugins: [],
      muted: false,
      volume,
      pan,
      buffer: null,
      clipStart: 0,
      clipDuration: 0,
    })

    this.rewire(id)
    shaper.connect(filter)
    filter.connect(fx.input)
    fx.output.connect(gain)
    gain.connect(analyser)
    analyser.connect(this.masterGain)
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
    track.fx.units.chorus.lfo?.stop()
    for (const unit of Object.values(track.fx.units)) {
      unit.input.disconnect()
      unit.output.disconnect()
      unit.dry.disconnect()
      unit.wet.disconnect()
      unit.shaper?.disconnect()
      unit.tone?.disconnect()
      unit.convolver?.disconnect()
      unit.delay?.disconnect()
      unit.feedback?.disconnect()
      unit.lfoDepth?.disconnect()
    }
    track.gain.disconnect()
    track.analyser.disconnect()
    this.tracks.delete(id)
  }

  private rewire(id: string): void {
    const track = this.tracks.get(id)
    if (!track) return

    track.panner.disconnect()
    track.fxInput.disconnect()
    for (const plugin of track.plugins) plugin.output.disconnect()

    track.panner.connect(track.fxInput)

    let cursor: AudioNode = track.fxInput
    for (const plugin of track.plugins) {
      if (!plugin.enabled) continue
      cursor.connect(plugin.input)
      cursor = plugin.output
    }
    cursor.connect(track.shaper)
  }

  setVolume(id: string, value: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.volume = value
    if (!track.muted) {
      track.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01)
    }
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
    track.gain.gain.setTargetAtTime(muted ? 0 : track.volume, this.ctx.currentTime, 0.01)
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

  addIrPlugin(trackId: string, buffer: AudioBuffer, name: string): PluginInfo {
    const track = this.findTrack(trackId)

    const input = this.ctx.createGain()
    const output = this.ctx.createGain()
    const dry = this.ctx.createGain()
    const wet = this.ctx.createGain()
    const convolver = this.ctx.createConvolver()
    convolver.normalize = true
    convolver.buffer = buffer
    dry.gain.value = 0
    wet.gain.value = 1

    input.connect(dry)
    dry.connect(output)
    input.connect(convolver)
    convolver.connect(wet)
    wet.connect(output)

    const plugin: PluginInstance = {
      id: newId(),
      name,
      kind: 'ir',
      enabled: true,
      params: [{ name: 'Mix', value: 1, min: 0, max: 1 }],
      detail: `${(buffer.duration * 1000).toFixed(0)} ms · ${buffer.numberOfChannels}ch`,
      input,
      output,
      source: { irBuffer: buffer },
      setParam: (paramName, value) => {
        if (paramName !== 'Mix') return
        const now = this.ctx.currentTime
        dry.gain.setTargetAtTime(1 - value, now, 0.02)
        wet.gain.setTargetAtTime(value, now, 0.02)
      },
      dispose: () => {
        input.disconnect()
        dry.disconnect()
        convolver.disconnect()
        wet.disconnect()
        output.disconnect()
      },
    }

    track.plugins.push(plugin)
    this.rewire(trackId)
    return toInfo(plugin)
  }

  async addWorkletPlugin(trackId: string, file: File): Promise<PluginInfo> {
    const track = this.findTrack(trackId)
    await this.resume()

    const sourceText = await file.text()
    const match = /registerProcessor\s*\(\s*['"`]([^'"`]+)['"`]/.exec(sourceText)
    if (!match) {
      throw new Error('o arquivo não registra um AudioWorkletProcessor')
    }
    const processorName = match[1]

    if (!this.loadedWorklets.has(processorName)) {
      const url = URL.createObjectURL(new Blob([sourceText], { type: 'application/javascript' }))
      try {
        await this.ctx.audioWorklet.addModule(url)
        this.loadedWorklets.add(processorName)
      } finally {
        URL.revokeObjectURL(url)
      }
    }

    const node = new AudioWorkletNode(this.ctx, processorName)
    const params: PluginParamInfo[] = []
    node.parameters.forEach((param, paramName) => {
      const minRaw = Math.abs(param.minValue) > 1e6 ? 0 : param.minValue
      const maxRaw = Math.abs(param.maxValue) > 1e6 ? 1 : param.maxValue
      params.push({ name: paramName, value: param.value, min: minRaw, max: maxRaw })
    })

    const plugin: PluginInstance = {
      id: newId(),
      name: file.name.replace(/\.js$/i, ''),
      kind: 'worklet',
      enabled: true,
      params,
      detail: processorName,
      input: node,
      output: node,
      source: { workletSource: sourceText, processorName },
      setParam: (paramName, value) => {
        node.parameters.get(paramName)?.setTargetAtTime(value, this.ctx.currentTime, 0.02)
        const meta = params.find((param) => param.name === paramName)
        if (meta) meta.value = value
      },
      dispose: () => {
        node.disconnect()
        node.port.close()
      },
    }

    track.plugins.push(plugin)
    this.rewire(trackId)
    return toInfo(plugin)
  }

  private getNamEngine(): Promise<NamEngine> {
    if (!this.namEnginePromise) {
      this.namEnginePromise = NamEngine.attach(this.ctx, { assetBaseUrl: NAM_ASSET_BASE })
    }
    return this.namEnginePromise
  }

  async addNamPlugin(trackId: string, file: File): Promise<PluginInfo> {
    const track = this.findTrack(trackId)
    await this.resume()

    const json = await file.text()
    try {
      JSON.parse(json)
    } catch {
      throw new Error('arquivo .nam inválido (JSON malformado)')
    }

    const engine = await this.getNamEngine()
    const node = await engine.createNode()
    node.channelCount = 1
    node.channelCountMode = 'explicit'
    node.channelInterpretation = 'speakers'

    const input = this.ctx.createGain()
    const output = this.ctx.createGain()
    input.connect(node)
    node.connect(output)

    let model: NamModelInfo
    try {
      model = await node.loadModel(json)
    } catch (error) {
      void node.dispose()
      input.disconnect()
      output.disconnect()
      throw error
    }

    const params: PluginParamInfo[] = [
      { name: 'Input', value: 1, min: 0, max: 4 },
      { name: 'Output', value: 1, min: 0, max: 4 },
    ]
    if (model.slimmable) {
      params.push({ name: 'Slim', value: 1, min: 0, max: 1 })
    }

    const sampleRateMismatch =
      model.expectedSampleRate > 0 && Math.abs(model.expectedSampleRate - this.ctx.sampleRate) > 1

    const detailParts = [
      model.slimmable ? 'A2 slimmable' : 'modelo estático',
      model.hasLoudness ? `${model.loudness.toFixed(1)} dB` : 'sem loudness',
      model.expectedSampleRate > 0 ? `${Math.round(model.expectedSampleRate)} Hz` : 'sr n/d',
    ]
    if (sampleRateMismatch) detailParts.push('⚠ resample')

    let slim = 1

    const plugin: PluginInstance = {
      id: newId(),
      name: file.name.replace(/\.nam$/i, ''),
      kind: 'nam',
      enabled: true,
      params,
      detail: detailParts.join(' · '),
      input,
      output,
      source: { namJson: json, namSlim: slim },
      setParam: (paramName, value) => {
        const now = this.ctx.currentTime
        if (paramName === 'Input') {
          input.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Output') {
          output.gain.setTargetAtTime(value, now, 0.02)
        } else if (paramName === 'Slim') {
          slim = Math.max(0, Math.min(1, value))
          plugin.source.namSlim = slim
          void node.setSlimSize(slim)
        }
      },
      dispose: () => {
        void node.dispose()
        input.disconnect()
        output.disconnect()
      },
    }

    track.plugins.push(plugin)
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
  }

  removePlugin(trackId: string, pluginId: string): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    const index = track.plugins.findIndex((item) => item.id === pluginId)
    if (index < 0) return
    track.plugins[index].dispose()
    track.plugins.splice(index, 1)
    this.rewire(trackId)
  }

  movePlugin(trackId: string, pluginId: string, direction: -1 | 1): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    const index = track.plugins.findIndex((item) => item.id === pluginId)
    if (index < 0) return
    const target = index + direction
    if (target < 0 || target >= track.plugins.length) return
    const [plugin] = track.plugins.splice(index, 1)
    track.plugins.splice(target, 0, plugin)
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

  async connectInput(trackId: string, deviceId: string, monitor: boolean): Promise<void> {
    await this.resume()
    this.disconnectInput(trackId)

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    const track = this.tracks.get(trackId)
    if (!track) {
      stream.getTracks().forEach((item) => item.stop())
      throw new Error('Track não encontrada')
    }

    const source = this.ctx.createMediaStreamSource(stream)
    const gain = this.ctx.createGain()
    gain.gain.value = monitor ? 0.6 : 0
    source.connect(gain)
    gain.connect(track.panner)

    this.inputs.set(trackId, { stream, source, gain })
  }

  setInputMonitor(trackId: string, enabled: boolean): void {
    const entry = this.inputs.get(trackId)
    if (!entry) return
    entry.gain.gain.setTargetAtTime(enabled ? 0.6 : 0, this.ctx.currentTime, 0.02)
  }

  disconnectInput(trackId: string): void {
    const entry = this.inputs.get(trackId)
    if (!entry) return
    entry.source.disconnect()
    entry.gain.disconnect()
    entry.stream.getTracks().forEach((track) => track.stop())
    this.inputs.delete(trackId)
  }

  hasInput(trackId: string): boolean {
    return this.inputs.has(trackId)
  }

  // ------------------------------------------------------------- recording

  async startRecording(trackIds: string[]): Promise<string[]> {
    await this.resume()
    const started: string[] = []
    for (const trackId of trackIds) {
      const entry = this.inputs.get(trackId)
      if (!entry) continue
      if (this.recorders.has(trackId)) continue

      const chunks: Blob[] = []
      const recorder = new MediaRecorder(entry.stream)
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.start()
      this.recorders.set(trackId, { recorder, chunks })
      started.push(trackId)
    }
    return started
  }

  async stopRecording(): Promise<Map<string, AudioBuffer>> {
    const entries = [...this.recorders.entries()]
    this.recorders.clear()
    const result = new Map<string, AudioBuffer>()

    await Promise.all(
      entries.map(
        ([trackId, { recorder, chunks }]) =>
          new Promise<void>((resolve) => {
            recorder.onstop = () => {
              const blob = new Blob(chunks, {
                type: chunks[0]?.type || 'audio/webm',
              })
              blob
                .arrayBuffer()
                .then((data) => this.ctx.decodeAudioData(data))
                .then((buffer) => {
                  result.set(trackId, buffer)
                  resolve()
                })
                .catch(() => resolve())
            }
            recorder.stop()
          }),
      ),
    )

    return result
  }

  private stopTrackRecorder(trackId: string): void {
    const entry = this.recorders.get(trackId)
    if (!entry) return
    try {
      entry.recorder.stop()
    } catch {
      /* already stopped */
    }
    this.recorders.delete(trackId)
  }

  isRecordingTrack(trackId: string): boolean {
    return this.recorders.has(trackId)
  }

  // ---------------------------------------------------------------- sounds

  playKick(velocity = 1, when = this.ctx.currentTime): void {
    scheduleKick(this.ctx, this.masterGain, when, velocity)
  }

  playSnare(velocity = 1, when = this.ctx.currentTime): void {
    scheduleSnare(this.ctx, this.masterGain, when, velocity)
  }

  playHiHat(velocity = 1, when = this.ctx.currentTime): void {
    scheduleHiHat(this.ctx, this.masterGain, when, velocity)
  }

  playClick(accent = false, when = this.ctx.currentTime): void {
    scheduleClick(this.ctx, this.masterGain, when, accent)
  }

  playNote(
    frequency = 440,
    type: OscillatorType = 'sawtooth',
    duration = 0.3,
    when = this.ctx.currentTime,
  ): void {
    scheduleNote(this.ctx, this.masterGain, when, frequency, duration, type)
  }

  // ----------------------------------------------------------------- clips

  setBuffer(id: string, buffer: AudioBuffer | null): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.buffer = buffer
    track.clipDuration = buffer ? buffer.duration : 0
  }

  setClipStart(id: string, step: number): void {
    const track = this.tracks.get(id)
    if (!track) return
    track.clipStart = Math.max(0, step)
  }

  hasBuffer(id: string): boolean {
    return Boolean(this.tracks.get(id)?.buffer)
  }

  /**
   * Schedules every recorded clip relative to the song position.
   * `stepDuration` is the length of a 16th note in seconds.
   */
  startBuffersAt(when: number, stepDuration: number, fromStep: number): void {
    this.tracks.forEach((track) => {
      if (!track.buffer) return
      const source = this.ctx.createBufferSource()
      source.buffer = track.buffer
      source.connect(track.panner)

      const delta = track.clipStart - fromStep
      if (delta >= 0) {
        source.start(when + delta * stepDuration)
      } else {
        const offset = -delta * stepDuration
        if (offset >= track.buffer.duration) return
        source.start(when, offset)
      }
      this.sources.push(source)
    })
  }

  playBuffers(when = this.ctx.currentTime): void {
    this.stopBuffers()
    this.startBuffersAt(when, 0.125, 0)
  }

  stopBuffers(): void {
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    })
    this.sources.length = 0
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
      const convolver = ctx.createConvolver()
      convolver.normalize = true
      convolver.buffer = plugin.source.irBuffer
      const mix = paramValue('Mix', 1)
      dry.gain.value = 1 - mix
      wet.gain.value = mix
      input.connect(dry)
      dry.connect(output)
      input.connect(convolver)
      convolver.connect(wet)
      wet.connect(output)
      return { input, output }
    }

    if (plugin.kind === 'worklet' && plugin.source.workletSource && plugin.source.processorName) {
      const name = plugin.source.processorName
      try {
        if (!this.loadedWorklets.has(`offline:${name}`)) {
          const url = URL.createObjectURL(
            new Blob([plugin.source.workletSource], { type: 'application/javascript' }),
          )
          try {
            await ctx.audioWorklet.addModule(url)
            this.loadedWorklets.add(`offline:${name}`)
          } finally {
            URL.revokeObjectURL(url)
          }
        }
        const node = new AudioWorkletNode(ctx, name)
        for (const param of plugin.params) {
          node.parameters.get(param.name)?.setValueAtTime(param.value, 0)
        }
        return { input: node, output: node }
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
        const input = ctx.createGain()
        const output = ctx.createGain()
        input.gain.value = paramValue('Input', 1)
        output.gain.value = paramValue('Output', 1)
        input.connect(node)
        node.connect(output)
        return { input, output }
      } catch (error) {
        warnings.push(`NAM "${plugin.name}" ignorado no export: ${(error as Error).message}`)
        return null
      }
    }

    return null
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    const sampleRate = this.ctx.sampleRate
    const stepCount = Math.max(1, request.drumSteps.length)
    const bars = Math.max(1, Math.floor(request.bars))
    const totalSteps = bars * stepCount
    const stepDuration = 60 / Math.max(30, request.bpm) / 4
    // A single track export only needs to cover its recorded clip.
    const sequenceDuration = request.trackId ? 0 : totalSteps * stepDuration

    const entries: Array<[string, EngineTrack]> = []
    for (const [id, track] of this.tracks) {
      if (request.trackId && id !== request.trackId) continue
      entries.push([id, track])
    }

    let contentDuration = sequenceDuration
    for (const [, track] of entries) {
      if (track.buffer) {
        contentDuration = Math.max(
          contentDuration,
          track.clipStart * stepDuration + track.buffer.duration,
        )
      }
    }

    // Reverb/delay tails must fit in the exported file.
    let tail = 0
    for (const [, track] of entries) {
      if (!track.buffer) continue
      if (track.fx.state.reverb.enabled) {
        tail = Math.max(tail, track.fx.state.reverb.params.decay * 0.9)
      }
      if (track.fx.state.delay.enabled) {
        const delay = track.fx.state.delay.params
        tail = Math.max(tail, (delay.time / 1000) * (2 + delay.feedback * 4))
      }
    }
    const duration = contentDuration + 0.35 + tail

    const offline = new OfflineAudioContext(
      2,
      Math.max(1, Math.ceil(duration * sampleRate)),
      sampleRate,
    )

    const master = offline.createGain()
    master.gain.value = request.masterMuted ? 0 : request.masterVolume
    master.connect(offline.destination)

    const warnings: string[] = []
    let renderedTracks = 0

    for (const [, track] of entries) {
      if (!track.buffer) continue
      renderedTracks += 1

      const panner = offline.createStereoPanner()
      panner.pan.value = track.pan

      const fxInput = offline.createGain()
      const shaper = offline.createWaveShaper()
      const filter = offline.createBiquadFilter()
      const fx = createBuiltinChain(offline, track.fx.state)
      const gain = offline.createGain()

      if (track.shaper.curve) {
        shaper.curve = new Float32Array(track.shaper.curve)
      }
      filter.type = track.filter.type
      filter.frequency.value = track.filter.frequency.value
      gain.gain.value = track.muted ? 0 : track.volume

      panner.connect(fxInput)

      let cursor: AudioNode = fxInput
      for (const plugin of track.plugins) {
        if (!plugin.enabled) continue
        const built = await this.buildOfflinePlugin(offline, plugin, warnings)
        if (!built) continue
        cursor.connect(built.input)
        cursor = built.output
      }

      cursor.connect(shaper)
      shaper.connect(filter)
      filter.connect(fx.input)
      fx.output.connect(gain)
      gain.connect(master)

      const source = offline.createBufferSource()
      source.buffer = track.buffer
      source.connect(panner)
      source.start(track.clipStart * stepDuration)
    }

    if (!request.trackId) {
      for (let step = 0; step < totalSteps; step += 1) {
        const time = step * stepDuration
        const pattern = request.drumSteps[step % stepCount]
        if (pattern) {
          scheduleKick(offline, master, time, pattern.kick)
          scheduleSnare(offline, master, time, pattern.snare)
          scheduleHiHat(offline, master, time, pattern.hihat)
        }
        const rowCount = Math.min(request.synthGrid.length, request.synthNotes.length)
        for (let row = 0; row < rowCount; row += 1) {
          if (request.synthGrid[row]?.[step % stepCount]) {
            scheduleNote(
              offline,
              master,
              time,
              request.synthNotes[row],
              stepDuration * 0.92,
            )
          }
        }
      }
    }

    if (renderedTracks === 0) {
      warnings.push('nenhuma track com áudio gravado — o arquivo pode ficar silencioso')
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
    }

    return { buffer, warnings }
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
