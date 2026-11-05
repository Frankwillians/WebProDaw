/**
 * Synthesized instruments for the Web DAW: pianos, basses and a drum kit.
 *
 * Voices are built from plain Web Audio nodes so they work identically in a
 * live AudioContext (playback, live jam, recording) and inside an
 * OfflineAudioContext (WAV export). Every voice connects into the track's
 * signal chain, so instruments run through the same NAM / cab / FX rack as
 * guitars and vocals.
 *
 * A track carries an `instrument` kind ('piano' | 'drums' | 'bass') plus a
 * `voice` string that selects the concrete timbre — one of PIANO_VOICES for
 * pianos, DRUM_KITS for drums or BASS_VOICES for basses. Unknown voice ids
 * fall back to the default.
 */

export type InstrumentKind = 'piano' | 'drums' | 'bass'

/** A MIDI note inside a clip, measured in 16th-note steps of the song. */
export interface InstrumentNote {
  step: number // absolute 16th-note position in the arrangement
  pitch: number // MIDI note number
  length: number // in steps (>= 1)
  velocity: number // 0..1
}

/** GM-style layout used by the drum sequencer lanes. */
export const DRUM_PIECES: ReadonlyArray<{ pitch: number; label: string }> = [
  { pitch: 36, label: 'Kick' },
  { pitch: 37, label: 'Rimshot' },
  { pitch: 38, label: 'Snare' },
  { pitch: 39, label: 'Clap' },
  { pitch: 42, label: 'Hi-hat' },
  { pitch: 44, label: 'Pedal HH' },
  { pitch: 46, label: 'Open HH' },
  { pitch: 45, label: 'Low Tom' },
  { pitch: 47, label: 'Mid Tom' },
  { pitch: 48, label: 'High Tom' },
  { pitch: 51, label: 'Ride' },
  { pitch: 53, label: 'Ride Bell' },
  { pitch: 49, label: 'Crash' },
  { pitch: 52, label: 'China' },
  { pitch: 56, label: 'Cowbell' },
  { pitch: 54, label: 'Tambourine' },
  { pitch: 70, label: 'Shaker' },
]

export const PIANO_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'epiano', label: 'Elétrico (Rhodes)' },
  { id: 'grand', label: 'Grande (acústico)' },
  { id: 'tine', label: 'Tine (bell)' },
  { id: 'honky', label: 'Honky-tonk' },
  { id: 'musicbox', label: 'Caixa de música' },
]

export const DRUM_KITS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'standard', label: 'Bateria padrão' },
  { id: '808', label: 'Bateria 808' },
  { id: 'lofi', label: 'Bateria lo-fi' },
]

export const BASS_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'finger', label: 'Baixo finger (warm)' },
  { id: 'pick', label: 'Baixo com palheta' },
  { id: 'slap', label: 'Slap bass' },
  { id: 'sub', label: 'Sub 808' },
  { id: 'synth', label: 'Synth bass' },
]

export function defaultVoice(kind: InstrumentKind): string {
  if (kind === 'piano') return 'epiano'
  if (kind === 'bass') return 'finger'
  return 'standard'
}

export function voicesFor(kind: InstrumentKind): ReadonlyArray<{ id: string; label: string }> {
  if (kind === 'piano') return PIANO_VOICES
  if (kind === 'bass') return BASS_VOICES
  return DRUM_KITS
}

/** The three basic instruments, in the order the add-track menu shows them. */
export const INSTRUMENT_KINDS: ReadonlyArray<InstrumentKind> = ['piano', 'bass', 'drums']

const INSTRUMENT_LABELS: Record<InstrumentKind, string> = {
  piano: 'Piano',
  bass: 'Baixo',
  drums: 'Bateria',
}

export function instrumentLabel(kind: InstrumentKind): string {
  return INSTRUMENT_LABELS[kind] ?? 'Piano'
}

type AnyAudioContext = AudioContext | OfflineAudioContext

// One shared 2 s noise buffer per context — created lazily, then GC'd with it.
const noiseCache = new WeakMap<AnyAudioContext, AudioBuffer>()

function noiseBuffer(ctx: AnyAudioContext): AudioBuffer {
  let buffer = noiseCache.get(ctx)
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
    noiseCache.set(ctx, buffer)
  }
  return buffer
}

function midiToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12)
}

interface HitOptions {
  when: number
  peak: number
  attack?: number
  decay: number
  filterType?: BiquadFilterType
  frequency?: number
  q?: number
}

function noiseHit(ctx: AnyAudioContext, dest: AudioNode, options: HitOptions): void {
  const { when, peak, decay } = options
  const source = ctx.createBufferSource()
  source.buffer = noiseBuffer(ctx)
  source.loop = true

  const amp = ctx.createGain()
  const g = amp.gain
  g.setValueAtTime(0.0001, when)
  g.linearRampToValueAtTime(peak, when + (options.attack ?? 0.002))
  g.exponentialRampToValueAtTime(0.0001, when + decay)

  let head: AudioNode = source
  if (options.filterType) {
    const filter = ctx.createBiquadFilter()
    filter.type = options.filterType
    filter.frequency.value = options.frequency ?? 1000
    filter.Q.value = options.q ?? 1
    source.connect(filter)
    head = filter
  }
  head.connect(amp)
  amp.connect(dest)

  source.start(when, Math.random() * 1.4)
  source.stop(when + decay + 0.05)
}

interface ToneHitOptions extends HitOptions {
  type: OscillatorType
  from: number
  to: number
  sweep: number
}

function toneHit(ctx: AnyAudioContext, dest: AudioNode, options: ToneHitOptions): void {
  const { when, peak, decay } = options
  const osc = ctx.createOscillator()
  osc.type = options.type
  osc.frequency.setValueAtTime(options.from, when)
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.to), when + options.sweep)

  const amp = ctx.createGain()
  const g = amp.gain
  g.setValueAtTime(0.0001, when)
  g.linearRampToValueAtTime(peak, when + (options.attack ?? 0.003))
  g.exponentialRampToValueAtTime(0.0001, when + decay)

  osc.connect(amp)
  amp.connect(dest)
  osc.start(when)
  osc.stop(when + decay + 0.05)
}

interface PianoConfig {
  partials: Array<[number, number]> // [harmonic ratio, level]
  filterBase: number
  filterMul: number
  q: number
  decayBoost: number
  releaseExtra: number
  hammer: number
  detune: number
  subOffset: number
  tremolo: number
}

const PIANO_CONFIGS: Record<string, PianoConfig> = {
  epiano: {
    partials: [[1, 1], [2, 0.24], [3.01, 0.08], [4.76, 0.035]],
    filterBase: 800,
    filterMul: 3.4,
    q: 0.5,
    decayBoost: 1,
    releaseExtra: 0.25,
    hammer: 0.16,
    detune: 6,
    subOffset: 0,
    tremolo: 0,
  },
  grand: {
    partials: [[1, 1], [2, 0.5], [3, 0.28], [4, 0.14], [5, 0.08], [6, 0.05]],
    filterBase: 500,
    filterMul: 6.5,
    q: 0.3,
    decayBoost: 1.3,
    releaseExtra: 0.5,
    hammer: 0.22,
    detune: 4,
    subOffset: 0,
    tremolo: 0,
  },
  tine: {
    partials: [[1, 1], [2.76, 0.35], [5.4, 0.12], [8.9, 0.05]],
    filterBase: 900,
    filterMul: 4.5,
    q: 0.7,
    decayBoost: 1.5,
    releaseExtra: 0.6,
    hammer: 0.08,
    detune: 8,
    subOffset: 0,
    tremolo: 5,
  },
  honky: {
    partials: [[1, 1], [2, 0.4], [3, 0.22], [4, 0.12]],
    filterBase: 700,
    filterMul: 2.6,
    q: 0.6,
    decayBoost: 0.8,
    releaseExtra: 0.2,
    hammer: 0.18,
    detune: 22,
    subOffset: 0,
    tremolo: 0,
  },
  musicbox: {
    partials: [[1, 1], [3.4, 0.3], [7.1, 0.1]],
    filterBase: 1500,
    filterMul: 7,
    q: 0.8,
    decayBoost: 0.5,
    releaseExtra: 0.15,
    hammer: 0.05,
    detune: 5,
    subOffset: 12,
    tremolo: 0,
  },
}

/** Additive piano voice; the timbre is chosen by `voice`. */
function pianoVoice(
  ctx: AnyAudioContext,
  dest: AudioNode,
  pitch: number,
  velocity: number,
  when: number,
  duration: number,
  voice: string,
): void {
  const cfg = PIANO_CONFIGS[voice] ?? PIANO_CONFIGS.epiano
  const freq = midiToHz(pitch + cfg.subOffset)
  const peak = 0.42 * Math.max(0.08, Math.min(1, velocity))
  const dur = Math.max(0.08, Math.min(8, duration))
  const rel = cfg.releaseExtra
  const releaseEnd = when + dur + rel
  const decayTo = when + Math.min(0.35 + dur * 0.5, (dur + rel) * 0.6) * cfg.decayBoost

  const amp = ctx.createGain()
  const g = amp.gain
  g.setValueAtTime(0.0001, when)
  g.linearRampToValueAtTime(peak, when + 0.005)
  g.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.22), decayTo)
  g.exponentialRampToValueAtTime(0.0001, releaseEnd)

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = Math.min(11000, cfg.filterBase + freq * cfg.filterMul)
  filter.Q.value = cfg.q
  amp.connect(filter)
  filter.connect(dest)

  for (const [ratio, level] of cfg.partials) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq * ratio
    osc.detune.value = (Math.random() - 0.5) * cfg.detune
    const pg = ctx.createGain()
    pg.gain.value = level
    osc.connect(pg)
    pg.connect(amp)
    osc.start(when)
    osc.stop(releaseEnd + 0.02)
  }

  // Optional tremolo (Rhodes-style) modulating the amp gain.
  if (cfg.tremolo > 0) {
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = cfg.tremolo
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = peak * 0.12
    lfo.connect(lfoGain)
    lfoGain.connect(amp.gain)
    lfo.start(when)
    lfo.stop(releaseEnd)
  }

  // Hammer transient: a filtered noise tick that keeps the attack lively.
  if (cfg.hammer > 0) {
    noiseHit(ctx, dest, {
      when,
      peak: peak * cfg.hammer,
      decay: 0.02,
      filterType: 'bandpass',
      frequency: Math.min(6000, freq * 6),
      q: 0.9,
    })
  }
}

interface BassConfig {
  partials: Array<[OscillatorType, number, number]> // [type, harmonic ratio, level]
  filterStart: number // lowpass cutoff, as a multiple of the note, at the attack
  filterEnd: number // cutoff once the pluck settles
  q: number
  attack: number
  decayPeak: number // fraction of the peak that keeps ringing
  release: number
  pitchDrop: number // semitones the note falls from (808 glide)
  brightness: number // pick / string transient level
  detune: number
}

const BASS_CONFIGS: Record<string, BassConfig> = {
  finger: {
    partials: [['sawtooth', 1, 0.5], ['sine', 1, 0.5], ['sawtooth', 2, 0.14]],
    filterStart: 7, filterEnd: 2.2, q: 1.1, attack: 0.006, decayPeak: 0.45,
    release: 0.16, pitchDrop: 0, brightness: 0.05, detune: 3,
  },
  pick: {
    partials: [['square', 1, 0.36], ['sawtooth', 1, 0.38], ['sawtooth', 3, 0.12]],
    filterStart: 11, filterEnd: 3.4, q: 1.6, attack: 0.003, decayPeak: 0.4,
    release: 0.13, pitchDrop: 0, brightness: 0.12, detune: 2,
  },
  slap: {
    partials: [['sawtooth', 1, 0.44], ['sine', 1, 0.38], ['square', 2, 0.18], ['sawtooth', 4, 0.09]],
    filterStart: 15, filterEnd: 4.2, q: 2.1, attack: 0.002, decayPeak: 0.34,
    release: 0.11, pitchDrop: 0, brightness: 0.2, detune: 4,
  },
  sub: {
    partials: [['sine', 1, 0.9], ['triangle', 2, 0.08], ['sine', 0.5, 0.22]],
    filterStart: 4, filterEnd: 1.6, q: 0.7, attack: 0.004, decayPeak: 0.62,
    release: 0.3, pitchDrop: 3, brightness: 0.02, detune: 0,
  },
  synth: {
    partials: [['sawtooth', 1, 0.38], ['square', 1, 0.34], ['square', 2, 0.16], ['sine', 0.5, 0.26]],
    filterStart: 9, filterEnd: 2.6, q: 3.1, attack: 0.005, decayPeak: 0.55,
    release: 0.18, pitchDrop: 0, brightness: 0.04, detune: 8,
  },
}

/**
 * Synthesized bass. The note is shaped by `duration` (like the piano) and
 * colored by `voice`: a rounded finger tone, an aggressive pick, a bright
 * slap, a gliding 808 sub, or a filtered synth bass.
 */
function bassVoice(
  ctx: AnyAudioContext,
  dest: AudioNode,
  pitch: number,
  velocity: number,
  when: number,
  duration: number,
  voice: string,
): void {
  const cfg = BASS_CONFIGS[voice] ?? BASS_CONFIGS.finger
  const freq = Math.max(25, midiToHz(pitch))
  const nyquist = Math.max(2000, ctx.sampleRate / 2 - 200)
  const peak = 0.5 * Math.max(0.08, Math.min(1, velocity))
  const dur = Math.max(0.06, Math.min(8, duration))
  const releaseEnd = when + dur + cfg.release
  const decayTo = when + Math.min(0.22 + dur * 0.35, (dur + cfg.release) * 0.55)
  const hold = Math.max(0.0002, peak * cfg.decayPeak)

  const amp = ctx.createGain()
  const g = amp.gain
  g.setValueAtTime(0.0001, when)
  g.linearRampToValueAtTime(peak, when + cfg.attack)
  g.exponentialRampToValueAtTime(hold, decayTo)
  g.exponentialRampToValueAtTime(0.0001, releaseEnd)

  // The pluck opens the filter and lets it close again — that sag is what
  // makes a synth bass read as a bass instead of a organ.
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = cfg.q
  filter.frequency.setValueAtTime(Math.min(nyquist, freq * cfg.filterStart + 120), when)
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(80, Math.min(nyquist, freq * cfg.filterEnd + 90)),
    decayTo,
  )
  amp.connect(filter)
  filter.connect(dest)

  for (const [type, ratio, level] of cfg.partials) {
    const osc = ctx.createOscillator()
    osc.type = type
    const target = Math.max(16, freq * ratio)
    if (cfg.pitchDrop > 0) {
      const start = Math.max(20, target * 2 ** (cfg.pitchDrop / 12))
      osc.frequency.setValueAtTime(start, when)
      osc.frequency.exponentialRampToValueAtTime(target, when + 0.09)
    } else {
      osc.frequency.setValueAtTime(target, when)
    }
    osc.detune.value = (Math.random() - 0.5) * cfg.detune
    const pg = ctx.createGain()
    pg.gain.value = level
    osc.connect(pg)
    pg.connect(amp)
    osc.start(when)
    osc.stop(releaseEnd + 0.02)
  }

  // String / pick transient, kept outside the filter so it stays crisp.
  if (cfg.brightness > 0) {
    noiseHit(ctx, dest, {
      when,
      peak: peak * cfg.brightness,
      decay: 0.03,
      filterType: 'bandpass',
      frequency: Math.min(9000, freq * 12),
      q: 0.9,
    })
  }
}

interface KitCharacter {
  amp: number // overall peak multiplier
  decay: number // decay multiplier
  freq: number // filter frequency multiplier (darker when < 1)
}

const KIT_CHARACTERS: Record<string, KitCharacter> = {
  standard: { amp: 1, decay: 1, freq: 1 },
  '808': { amp: 1.05, decay: 1.35, freq: 1.05 },
  lofi: { amp: 0.82, decay: 0.72, freq: 0.72 },
}

/** One synthesized drum hit chosen by GM-style pitch; `kit` colors it. */
function drumVoice(
  ctx: AnyAudioContext,
  dest: AudioNode,
  pitch: number,
  velocity: number,
  when: number,
  kit: string,
): void {
  const ch = KIT_CHARACTERS[kit] ?? KIT_CHARACTERS.standard
  const v = Math.max(0.1, Math.min(1, velocity)) * ch.amp
  const d = ch.decay
  const f = ch.freq
  switch (pitch) {
    case 36: // kick
      if (kit === '808') {
        toneHit(ctx, dest, { when, peak: 1.0 * v, decay: 0.7 * d, type: 'sine', from: 130, to: 28, sweep: 0.32 })
        noiseHit(ctx, dest, { when, peak: 0.16 * v, decay: 0.012, filterType: 'highpass', frequency: 900 })
      } else {
        toneHit(ctx, dest, { when, peak: 0.95 * v, decay: 0.3 * d, type: 'sine', from: 160, to: 42, sweep: 0.1 })
        noiseHit(ctx, dest, { when, peak: 0.18 * v, decay: 0.014, filterType: 'highpass', frequency: 900 })
      }
      break
    case 37: // rimshot
      toneHit(ctx, dest, { when, peak: 0.4 * v, decay: 0.05 * d, type: 'triangle', from: 820 * f, to: 600 * f, sweep: 0.02 })
      noiseHit(ctx, dest, { when, peak: 0.32 * v, decay: 0.02, filterType: 'highpass', frequency: 2500 * f })
      break
    case 38: // snare
      noiseHit(ctx, dest, { when, peak: 0.6 * v, decay: 0.18 * d, filterType: 'bandpass', frequency: 1900 * f, q: 0.8 })
      toneHit(ctx, dest, { when, peak: 0.35 * v, decay: 0.09 * d, type: 'triangle', from: 195, to: 160, sweep: 0.05 })
      break
    case 39: // clap — three fast noise bursts
      for (let i = 0; i < 3; i += 1) {
        noiseHit(ctx, dest, {
          when: when + i * 0.012,
          peak: (i === 2 ? 0.5 : 0.3) * v,
          decay: (i === 2 ? 0.14 : 0.02) * d,
          filterType: 'bandpass',
          frequency: 1250 * f,
          q: 1.4,
        })
      }
      break
    case 42: // closed hat
      noiseHit(ctx, dest, { when, peak: 0.32 * v, decay: 0.05 * d, filterType: 'highpass', frequency: 7200 * f })
      break
    case 44: // pedal (chick) hat — two very short ticks
      noiseHit(ctx, dest, { when, peak: 0.28 * v, decay: 0.02, filterType: 'highpass', frequency: 6400 * f })
      noiseHit(ctx, dest, { when: when + 0.02, peak: 0.22 * v, decay: 0.03 * d, filterType: 'highpass', frequency: 6000 * f })
      break
    case 46: // open hat
      noiseHit(ctx, dest, { when, peak: 0.26 * v, decay: 0.3 * d, filterType: 'highpass', frequency: 6800 * f })
      break
    case 45: // low tom
      toneHit(ctx, dest, { when, peak: 0.7 * v, decay: 0.26 * d, type: 'sine', from: 115, to: 78, sweep: 0.12 })
      break
    case 47: // mid tom
      toneHit(ctx, dest, { when, peak: 0.65 * v, decay: 0.22 * d, type: 'sine', from: 160, to: 110, sweep: 0.1 })
      break
    case 48: // high tom
      toneHit(ctx, dest, { when, peak: 0.6 * v, decay: 0.18 * d, type: 'sine', from: 215, to: 150, sweep: 0.08 })
      break
    case 51: // ride
      noiseHit(ctx, dest, { when, peak: 0.2 * v, decay: 0.55 * d, filterType: 'bandpass', frequency: 5200 * f, q: 0.7 })
      toneHit(ctx, dest, { when, peak: 0.08 * v, decay: 0.4 * d, type: 'square', from: 520, to: 512, sweep: 0.3 })
      break
    case 53: // ride bell
      toneHit(ctx, dest, { when, peak: 0.16 * v, decay: 0.4 * d, type: 'triangle', from: 1500 * f, to: 1480 * f, sweep: 0.3 })
      noiseHit(ctx, dest, { when, peak: 0.1 * v, decay: 0.3 * d, filterType: 'bandpass', frequency: 5400 * f, q: 1.2 })
      break
    case 49: // crash
      noiseHit(ctx, dest, { when, peak: 0.34 * v, decay: 0.95 * d, filterType: 'highpass', frequency: 4200 * f })
      break
    case 52: // china — trashy, darker
      noiseHit(ctx, dest, { when, peak: 0.3 * v, decay: 0.7 * d, filterType: 'bandpass', frequency: 3600 * f, q: 0.5 })
      toneHit(ctx, dest, { when, peak: 0.1 * v, decay: 0.5 * d, type: 'sawtooth', from: 300, to: 150, sweep: 0.2 })
      break
    case 56: // cowbell — two detuned squares
      toneHit(ctx, dest, { when, peak: 0.28 * v, decay: 0.12 * d, type: 'square', from: 560, to: 560, sweep: 0.1 })
      toneHit(ctx, dest, { when, peak: 0.22 * v, decay: 0.09 * d, type: 'square', from: 845, to: 845, sweep: 0.1 })
      break
    case 54: // tambourine — noise + jingle
      noiseHit(ctx, dest, { when, peak: 0.24 * v, decay: 0.18 * d, filterType: 'highpass', frequency: 7000 * f })
      noiseHit(ctx, dest, { when, peak: 0.18 * v, decay: 0.12 * d, filterType: 'bandpass', frequency: 8200 * f, q: 1.5 })
      break
    case 70: // shaker — soft filtered noise
      noiseHit(ctx, dest, { when, peak: 0.22 * v, decay: 0.12 * d, attack: 0.01, filterType: 'bandpass', frequency: 6000 * f, q: 1 })
      break
    default:
      // Unknown pitch: a neutral short click so nothing is silently lost.
      toneHit(ctx, dest, { when, peak: 0.4 * v, decay: 0.08, type: 'triangle', from: midiToHz(pitch), to: midiToHz(pitch), sweep: 0.05 })
      break
  }
}

/**
 * Schedule one instrument voice. `duration` shapes the piano and bass notes;
 * drums use their own fixed decays. `voice` selects the timbre (piano), kit
 * (drums) or bass character; unknown ids fall back to the default.
 */
export function scheduleVoice(
  ctx: AnyAudioContext,
  destination: AudioNode,
  kind: InstrumentKind,
  pitch: number,
  velocity: number,
  when: number,
  duration: number,
  voice?: string,
): void {
  const clamped = Math.max(0, Math.min(127, Math.round(pitch)))
  const at = Math.max(when, ctx.currentTime)
  if (kind === 'piano') {
    pianoVoice(ctx, destination, clamped, velocity, at, duration, voice || 'epiano')
  } else if (kind === 'bass') {
    bassVoice(ctx, destination, clamped, velocity, at, duration, voice || 'finger')
  } else {
    drumVoice(ctx, destination, clamped, velocity, at, voice || 'standard')
  }
}
