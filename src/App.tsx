import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import {
  AudioEngine,
  BUILTIN_FX_IDS,
  DRUM_PIECES,
  defaultBuiltinFx,
  defaultSendConfig,
  defaultVoice,
  encodeWav,
  INSTRUMENT_KINDS,
  instrumentLabel,
  MAX_INPUT_CHANNELS,
  voicesFor,
} from './audio/audio-engine'
import type { OutputRoute } from './audio/audio-engine'
import type { LoudnessReport } from './audio/loudness'
import type { LiveLoudness } from './audio/loudness-worklet'
import { clearSamples, deleteSample, listSamples, loadSample, saveSample } from './audio/sample-store'
import { nativePreviewKey } from './audio/native-preview'
import { NativeLiveLink, canRunLive, liveLatencyMs } from './audio/native-live'
import { SalaCableWindow } from './audio/SalaCableWindow'
import {
  buildChainFile,
  buildProjectFile,
  parseChainFile,
  parseProjectFile,
  projectFileToText,
  sampleIdsUsedBy,
} from './audio/project-file'
import {
  addVersion,
  describeAge,
  findVersion,
  formatClock,
  parseVersions,
  removeVersion,
  shouldRecord,
  trimToFit,
} from './audio/project-versions'
import type { StoredVersion } from './audio/project-versions'
import {
  AUTO_MAX_DB,
  AUTO_MIN_DB,
  autoDbToY,
  automationGainAt,
  autoYToDb,
  dbToGain,
  formatDb,
  gainToDb,
  normalizeDuckSources,
  sortedAutomation,
} from './audio/mix-math'
import {
  GROOVE_PRESETS,
  PATTERN_LENGTHS,
  foldIntoPattern,
  grooveNotes,
  hitAtStep,
  isPatterned,
  normalizePatternSteps,
} from './audio/step-pattern'
import {
  punchAction,
  punchBoundsOf,
  punchLeadStep,
  punchStartStep,
} from './audio/punch-in'
import type { PunchBounds } from './audio/punch-in'
import { countInBeat, countInClick, countInStart, isCountingIn } from './audio/count-in'
import {
  QUANTIZE_GRIDS,
  SCALE_MODES,
  SCALE_ROOTS,
  humanizeNotes,
  isScalePitch,
  nudgeNotes,
  quantizeNotes,
  shiftSelectionBox,
  snapNotesToScale,
  withVelocity,
} from './midi/midi-edit'
import type { NoteFilter, RollNote } from './midi/midi-edit'
import {
  bindMidiInput,
  listMidiInputs,
  openMidiAccess,
  watchMidiConnections,
} from './midi/midi-input'
import type { MidiDeviceInfo } from './midi/midi-input'
import PluginPanel from './desktop/PluginPanel'
import NativeVstInsert from './desktop/NativeVstInsert'
import type { NativePreviewStatus, NativeVstSlot } from './desktop/NativeVstInsert'
import {
  clickNativeMenuItem,
  isNativeApp,
  mirrorMenuBar,
  nativeNotify,
  nativeOpenAudio,
  nativeOpenText,
  nativeSaveBlob,
  onNativeMenu,
  pluginApi,
  setNativeToastHandler,
} from './desktop/native'
import type { NativeMenuAction } from './desktop/native'
import type {
  AutomationBreakpoint,
  BuiltinFxId,
  BuiltinFxParams,
  BuiltinFxRack,
  BuiltinFxUnit,
  InputChannel,
  InputStatus,
  InstrumentKind,
  InstrumentNote,
  PluginInfo,
  PluginKind,
  PluginParamInfo,
  PluginRestoreInfo,
  SendConfig,
} from './audio/audio-engine'
import './App.css'

type Tab = 'arrangement'
type PluginState = PluginInfo & {
  enabled: boolean
  /** Blob in IndexedDB: the NAM/IR/worklet bytes that make this plugin reloadable. */
  assetId?: string
}
interface Marker {
  id: string
  position: number // in steps
  name: string
  color: string
  isRegion: boolean
  regionEnd?: number // in steps, for regions
}

interface TrackState {
  id: string
  number: number
  name: string
  color: string
  volume: number
  pan: number
  // Gain staging for the final mix: trim in dB, polarity and mono fold-down.
  trimDb: number
  phaseInvert: boolean
  mono: boolean
  // Sends to the shared reverb / delay buses (0..1).
  rvSend: number
  dlSend: number
  isArmed: boolean
  isMuted: boolean
  isSoloed: boolean
  hasFx: boolean
  drive: number
  cabinet: number
  inputDeviceId: string
  /**
   * O canal de chamada (SALA) que esta faixa carrega, ou '' para uma faixa normal.
   *
   * Uma faixa de chamada existe enquanto o WebRTC existe: ela é gravável como
   * qualquer entrada, mas o stream dela vem do SDK da sala, não de um dispositivo,
   * então ela não pode ser tratada como `inputDeviceId` — nem ao pedir
   * permissão, nem ao salvar o projeto (um retorno de chamada não volta de um
   * arquivo; o cabo é que o recria quando a sala reconecta).
   */
  callChannelKey: string
  /**
   * Which part of the device this lane owns. 0 takes the pair as it arrives;
   * 1..N takes that one input of the interface, so a guitar in 1 and a vocal in 2
   * are two lanes over one cable. How many exist is the device's own answer.
   */
  inputChannel: InputChannel
  inputMonitor: boolean
  /**
   * What this lane prints when it records: the raw input, or the sound at the end
   * of its effects. Wet is a baked choice — the effects of that take can no longer
   * be changed, only the fader — so it is a per-lane decision, not a global one.
   */
  inputWet: boolean
  plugins: PluginState[]
  /**
   * The native VST insert of this lane, in the desktop executable. A Windows
   * .dll or .vst3 only answers to the native engine — it cannot sit in the live
   * Web Audio graph — so the clip is rendered through the plugin process and that
   * pass is what plays and what the export writes, while `bufferId` stays the dry
   * recording. "Aplicar ao clipe" commits the pass as the clip and
   * puts the dry take on the shelf. Null in the browser, where there is no native
   * engine.
   */
  nativeVst2: NativeVstSlot | null
  chain: string[]
  fxRack: BuiltinFxRack
  clipStart: number
  clipDuration: number
  // Edge fades in seconds, dragged on the clip corners.
  fadeIn: number
  fadeOut: number
  // Volume automation, in dB relative to the fader, drawn over the timeline.
  automation: AutomationBreakpoint[]
  clipName: string
  bufferId: string
  kind: 'audio' | 'instrument'
  instrument: InstrumentKind
  midiNotes: InstrumentNote[]
  /**
   * Loop length for the notes, in steps: 0 puts every note where it was drawn,
   * 16/32/64 makes the notes one bar (or two, or four) of a pattern the
   * transport repeats for the whole arrangement.
   */
  patternSteps: number
  voice: string
  /**
   * A folder is a row in the track list that owns the rows below it until the
   * next folder. It carries no audio of its own — it is for organization, and
   * it never reaches the engine, the mixer, or the export.
   */
  isFolder: boolean
  collapsed: boolean
  /** The folder this row belongs to, or null when it sits at the top level. */
  folderId: string | null
  /**
   * Recordings that used to sit on this lane. A new take never throws the
   * previous one away: it goes on the shelf and any of them can be put back in
   * use, which is how a vocal is compiled out of several passes.
   */
  takes: AudioTake[]
  /**
   * Sub-bus this track feeds ('' = straight to master). Unlike a folder, a group
   * is real signal: its fader, pan and mute sit in the graph and in the export.
   */
  groupId: string
  /**
   * Tracks whose signal ducks this one. More than one is normal - a bass that
   * has to get out of the way of the kick *and* the voice - and the follower reads
   * their sum, so the duck is as deep as the sources together, not as the loudest.
   */
  duckSourceIds: string[]
  /** How far the duck pulls this fader down, 0..1. */
  duckDepth: number
}

/**
 * A sub-group: one more strip in the mixer that several tracks are sent to.
 * Moving its fader moves every member, because the members' audio really does
 * pass through it - in the browser and in the exported file.
 */
interface GroupState {
  id: string
  name: string
  color: string
  volume: number
  pan: number
  isMuted: boolean
}

/** One recorded pass of a lane, kept until the user drops it. */
interface AudioTake {
  /** The WAV stored in IndexedDB for this take. */
  id: string
  name: string
  /** Where it was sung, in steps. */
  start: number
  /** Length in seconds, after any trim. */
  duration: number
  fadeIn: number
  fadeOut: number
}

/** One rendered row: a track (or folder header) plus its visual nesting. */
interface LaneRow {
  track: TrackState
  /** 0 at the top level, 1 inside a folder. */
  indent: number
  /** True when the owning folder is folded up. */
  hidden: boolean
  /** Index in `tracks`, so reorder still talks to the real list. */
  index: number
}

interface SavedProject {
  version: number
  bpm: number
  masterVolume: number
  masterMuted: boolean
  metronome: boolean
  loop: boolean
  countIn: boolean
  arrangementBars: number
  // Recording offset in ms; -1 means "follow the measured output latency".
  recordLatencyMs: number
  snapEnabled: boolean
  // Bars visible in the timeline; 0 means "fit the whole arrangement".
  zoomBars: number
  masterFx: BuiltinFxRack
  sends: SendConfig
  tracks: TrackState[]
  groups: GroupState[]
  markers: Marker[]
}

const STORAGE_KEY = 'web-daw-project-v1'
/** Rolling autosave history, so an overwrite is not the end of a take. */
const VERSIONS_KEY = 'web-daw-project-v1-versions'
/**
 * Which loudspeaker or interface output this machine mixes out of. Deliberately
 * kept out of the project file: a project travels between computers, a sound card
 * does not, so the routing choice belongs to the place where it was made.
 */
const OUTPUT_KEY = 'web-daw-output-device'
/**
 * Characters of history localStorage may hold. The live project, the undo stack
 * and the samples still need room, and a full store throws on every write.
 */
const VERSIONS_BUDGET = 2_000_000
// Sixteenth-note steps per bar, used by the arrangement grid.
const STEP_COUNT = 16
// Piano roll / step sequencer grid metrics.
const ROLL_COL_W = 16
const ROLL_ROW_H = 13
const DRUM_ROW_H = 30
// The velocity lane under the piano roll: short enough to stay out of the way,
// tall enough that a 20% drag is a visible move.
const VEL_LANE_H = 46
// Same idea under the drum grid, one step shorter so 16 columns still fit.
const SEQ_VEL_H = 40
// The sequencer's sticky lane-label column, shared by the grid template and the
// width measurement so the two can never disagree.
const SEQ_KEYS_W = 92
const PIANO_TOP = 84 // MIDI C6
const PIANO_BOTTOM = 36 // MIDI C2
// A bass lives an octave and a half lower than the piano window, otherwise the
// low strings (E1 = MIDI 28) could not be written at all.
const BASS_TOP = 67 // MIDI G4
const BASS_BOTTOM = 24 // MIDI C1
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const TRACK_COLORS = ['#79a8d6', '#e07b53', '#6fcf97', '#c084fc', '#eab308', '#ef4444', '#38bdf8', '#f472b6']

// The pitch window the roll shows per instrument; drums ignore it.
const PIANO_RANGE = { top: PIANO_TOP, bottom: PIANO_BOTTOM }
const BASS_RANGE = { top: BASS_TOP, bottom: BASS_BOTTOM }

function rollRange(instrument: InstrumentKind): { top: number; bottom: number } {
  return instrument === 'bass' ? BASS_RANGE : PIANO_RANGE
}

/** Anything but the drum kit is edited as pitched notes on the roll. */
function isMelodic(instrument: InstrumentKind): boolean {
  return instrument !== 'drums'
}

function instrumentIcon(instrument: InstrumentKind): string {
  if (instrument === 'bass') return '🎸'
  return instrument === 'piano' ? '🎹' : '🥁'
}

// Computer-keyboard playing: the classic two-row piano layout, in semitones
// from the base note. 'z'/'x' shift the octave because the letter rows need
// every other key on the board.
const PC_KEY_SEMITONES: Readonly<Record<string, number>> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
}
const PC_KEY_CAPTIONS: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(PC_KEY_SEMITONES).map(([key, semitone]) => [semitone, key.toUpperCase()]),
)
// Left to right on the on-screen strip, so the two board rows read as one piano.
const PC_KEY_LIST: ReadonlyArray<{ key: string; semitone: number }> = Object.entries(
  PC_KEY_SEMITONES,
)
  .map(([key, semitone]) => ({ key, semitone }))
  .sort((a, b) => a.semitone - b.semitone)
// Where the hand sits by default: middle C for a piano, low E region for a bass.
const PC_BASE_BY_INSTRUMENT: Record<'piano' | 'bass', number> = { piano: 60, bass: 36 }

/**
 * The kit on the computer keyboard: two rows read left to right, kick and
 * snares under the home row, cymbals and toys on the upper one. That is how a
 * pad controller is laid out, and it is far easier to aim than reusing the
 * interleaved piano rows for drums.
 */
const DRUM_KEY_PIECES: Readonly<Record<string, number>> = {
  a: 0, s: 1, d: 2, f: 3, g: 4, h: 5, j: 6, k: 7, l: 8, ';': 9,
  q: 10, w: 11, e: 12, r: 13, t: 14, y: 15, u: 16,
}
/** Lane index -> the key that hits it, for the caption beside each piece. */
const DRUM_PIECE_KEYS: ReadonlyArray<string> = (() => {
  const keys: string[] = []
  for (let i = 0; i < 64; i += 1) keys[i] = ''
  for (const [key, piece] of Object.entries(DRUM_KEY_PIECES)) keys[piece] = key.toUpperCase()
  return keys
})()

function pcRawKeyOf(event: KeyboardEvent): string | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined
  const key = event.key.toLowerCase()
  return key in PC_KEY_SEMITONES || key in DRUM_KEY_PIECES ? key : undefined
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Native color inputs only speak 6-digit hex, and track colors arrive as any CSS color. */
function toHexColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#79a8d6'
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// Volume automation is relative to the fader; the dB scale and the lane geometry
// that go with it live in mix-math, next to every other number the mix uses.
const AUTO_LANE_H = 46
const AUTO_MAX_STEP = 128 * 16
const AUTO_MAX_POINTS = 512

const BUILTIN_FX_META: Record<
  BuiltinFxId,
  {
    label: string
    hint: string
    params: Array<{ key: keyof BuiltinFxParams; label: string; min: number; max: number; step: number }>
  }
> = {
  dist: {
    label: 'DIST',
    hint: 'pedal de distorção',
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01 },
      { key: 'tone', label: 'Tone', min: 400, max: 9000, step: 10 },
    ],
  },
  chorus: {
    label: 'CHORUS',
    hint: 'modulação de delay',
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 6, step: 0.05 },
      { key: 'depth', label: 'Depth', min: 0.2, max: 8, step: 0.1 },
    ],
  },
  reverb: {
    label: 'REVERB',
    hint: 'convolução com cauda',
    params: [{ key: 'decay', label: 'Decay', min: 0.3, max: 6, step: 0.1 }],
  },
  delay: {
    label: 'DELAY',
    hint: 'eco com feedback',
    params: [
      { key: 'time', label: 'Time', min: 40, max: 1000, step: 10 },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.85, step: 0.01 },
    ],
  },
  eq: {
    label: 'EQ',
    hint: 'equalizador paramétrico 3-bandas',
    params: [
      { key: 'eqLowFreq', label: 'Low Freq', min: 20, max: 500, step: 1 },
      { key: 'eqLowGain', label: 'Low Gain', min: -24, max: 24, step: 0.5 },
      { key: 'eqMidFreq', label: 'Mid Freq', min: 200, max: 8000, step: 10 },
      { key: 'eqMidGain', label: 'Mid Gain', min: -24, max: 24, step: 0.5 },
      { key: 'eqMidQ', label: 'Mid Q', min: 0.1, max: 10, step: 0.1 },
      { key: 'eqHighFreq', label: 'High Freq', min: 1000, max: 20000, step: 10 },
      { key: 'eqHighGain', label: 'High Gain', min: -24, max: 24, step: 0.5 },
    ],
  },
  comp: {
    label: 'COMP',
    hint: 'compressor de dinâmica',
    params: [
      { key: 'compThreshold', label: 'Threshold', min: -60, max: 0, step: 1 },
      { key: 'compRatio', label: 'Ratio', min: 1, max: 20, step: 0.5 },
      { key: 'compAttack', label: 'Attack', min: 0.1, max: 100, step: 0.5 },
      { key: 'compRelease', label: 'Release', min: 10, max: 2000, step: 1 },
      { key: 'compKnee', label: 'Knee', min: 0, max: 40, step: 1 },
      { key: 'compMakeup', label: 'Makeup', min: 0, max: 24, step: 0.5 },
    ],
  },
  gate: {
    label: 'GATE',
    hint: 'expander para ruído de fundo',
    params: [
      { key: 'gateThreshold', label: 'Threshold', min: -80, max: 0, step: 1 },
      { key: 'gateRange', label: 'Range', min: 0, max: 96, step: 1 },
    ],
  },
  sat: {
    label: 'SAT',
    hint: 'saturador fita, soft clip',
    params: [
      { key: 'satDrive', label: 'Drive', min: 0, max: 1, step: 0.01 },
      { key: 'satTone', label: 'Tone', min: 1000, max: 20000, step: 100 },
      { key: 'satTrim', label: 'Trim', min: -24, max: 12, step: 0.5 },
    ],
  },
  trem: {
    label: 'TREM',
    hint: 'tremolo por LFO',
    params: [
      { key: 'tremRate', label: 'Rate', min: 0.5, max: 14, step: 0.1 },
      { key: 'tremDepth', label: 'Depth', min: 0, max: 1, step: 0.01 },
    ],
  },
  deess: {
    label: 'DE-ESS',
    hint: 'compressor só da banda dos esses',
    params: [
      { key: 'deessFreq', label: 'Freq', min: 2000, max: 16000, step: 100 },
      { key: 'deessThreshold', label: 'Threshold', min: -60, max: 0, step: 1 },
      { key: 'deessRatio', label: 'Ratio', min: 1, max: 20, step: 0.5 },
      { key: 'deessAttack', label: 'Attack', min: 0.1, max: 50, step: 0.5 },
      { key: 'deessRelease', label: 'Release', min: 5, max: 500, step: 1 },
    ],
  },
  limiter: {
    label: 'LIMIT',
    hint: 'limiter brickwall',
    params: [
      { key: 'limThreshold', label: 'Threshold', min: -30, max: 0, step: 0.5 },
      { key: 'limRelease', label: 'Release', min: 1, max: 500, step: 1 },
      { key: 'limCeiling', label: 'Ceiling', min: -10, max: 0, step: 0.1 },
    ],
  },
}

function formatFxParam(key: keyof BuiltinFxParams, value: number): string {
  const hz = new Set<string>([
    'tone',
    'satTone',
    'eqLowFreq',
    'eqMidFreq',
    'eqHighFreq',
    'deessFreq',
  ])
  const db = new Set<string>([
    'eqLowGain',
    'eqMidGain',
    'eqHighGain',
    'compThreshold',
    'compKnee',
    'compMakeup',
    'gateThreshold',
    'gateRange',
    'satTrim',
    'deessThreshold',
    'limThreshold',
    'limCeiling',
  ])
  const ms = new Set<string>([
    'time',
    'compAttack',
    'compRelease',
    'deessAttack',
    'deessRelease',
    'limRelease',
  ])
  const ratio = new Set<string>(['compRatio', 'deessRatio'])
  const frequency = new Set<string>(['rate', 'tremRate'])
  // Chorus depth is modulation in milliseconds; tremolo depth is a proportion.
  if (key === 'depth') return `${value.toFixed(1)} ms`
  if (hz.has(key)) return `${Math.round(value)} Hz`
  if (db.has(key)) return `${value.toFixed(1)} dB`
  if (ms.has(key)) return `${Math.round(value)} ms`
  if (ratio.has(key)) return `${value.toFixed(1)}:1`
  if (frequency.has(key)) return `${value.toFixed(1)} Hz`
  if (key === 'decay') return `${value.toFixed(1)} s`
  if (key === 'eqMidQ') return `${value.toFixed(1)}`
  return `${Math.round(value * 100)}%`
}

function formatPluginParam(param: PluginParamInfo): string {
  if (param.unit === 'db') return `${param.value > 0 ? '+' : ''}${param.value.toFixed(1)} dB`
  if (param.unit === 'hz') return `${Math.round(param.value)} Hz`
  if (param.unit === 'pan') {
    if (Math.abs(param.value) < 0.01) return 'C'
    return `${Math.abs(Math.round(param.value * 100))}${param.value < 0 ? 'L' : 'R'}`
  }
  if (param.unit === 'percent') return `${Math.round(param.value * 100)}%`
  if (param.unit === 'ratio') return `${param.value.toFixed(2)}x`
  if (param.unit === 'ms') return `${Math.round(param.value)} ms`
  if (param.unit === 'bool') return param.value >= 0.5 ? 'On' : 'Off'
  return param.value.toFixed(2)
}

const BUILTIN_FX_PRESETS: Record<
  string,
  {
    name: string
    rack: () => BuiltinFxRack
  }
> = {
  reset: {
    name: 'Reset / Clean',
    rack: () => defaultBuiltinFx(),
  },
  rockLead: {
    name: 'Rock Lead (Dist + Delay + Reverb + Limiter)',
    rack: () => {
      const r = defaultBuiltinFx()
      r.gate = { enabled: true, mix: 1, params: { ...r.gate.params, gateThreshold: -45 } }
      r.dist = { enabled: true, mix: 0.35, params: { ...r.dist.params, drive: 0.5, tone: 4800 } }
      r.eq = { enabled: true, mix: 1, params: { ...r.eq.params, eqLowGain: 2, eqMidGain: -1, eqHighGain: 3 } }
      r.delay = { enabled: true, mix: 0.25, params: { ...r.delay.params, time: 380, feedback: 0.35 } }
      r.reverb = { enabled: true, mix: 0.28, params: { ...r.reverb.params, decay: 2.8 } }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -1 } }
      return r
    },
  },
  stereoAmbient: {
    name: 'Stereo Ambient (Chorus + Delay + Reverb)',
    rack: () => {
      const r = defaultBuiltinFx()
      r.chorus = { enabled: true, mix: 0.45, params: { ...r.chorus.params, rate: 1.2, depth: 4 } }
      r.delay = { enabled: true, mix: 0.35, params: { ...r.delay.params, time: 450, feedback: 0.42 } }
      r.reverb = { enabled: true, mix: 0.4, params: { ...r.reverb.params, decay: 4.2 } }
      r.eq = { enabled: true, mix: 1, params: { ...r.eq.params, eqLowGain: 1.5, eqHighGain: 3.5 } }
      return r
    },
  },
  punchyComp: {
    name: 'Punchy Dynamics (Gate + Comp + EQ + Limiter)',
    rack: () => {
      const r = defaultBuiltinFx()
      r.gate = { enabled: true, mix: 1, params: { ...r.gate.params, gateThreshold: -40 } }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -16, compRatio: 4 } }
      r.eq = { enabled: true, mix: 1, params: { ...r.eq.params, eqLowGain: 3, eqMidGain: -2, eqHighGain: 4 } }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -0.5 } }
      return r
    },
  },
}

function builtinChainId(id: BuiltinFxId): string {
  return `fx:${id}`
}

/**
 * Chain orderings. A noise gate before a compressor is a different tool than a
 * noise gate after one, so the sequence is worth presets of its own - but only
 * the built-in units move. NAM and cabinet slots stay exactly where the user
 * put them; a preset that shuffles a loaded amplifier is not a preset, it is
 * vandalism.
 */
const CHAIN_ORDERS: Record<string, { name: string; order: BuiltinFxId[] }> = {
  standard: { name: 'Ordem padrão (stompbox)', order: [...BUILTIN_FX_IDS] },
  vocal: {
    name: 'Ordem voz (gate → de-ess → EQ → comp → limite)',
    order: ['gate', 'deess', 'eq', 'comp', 'sat', 'limiter', 'trem', 'chorus', 'delay', 'reverb', 'dist'],
  },
  guitar: {
    name: 'Ordem guitarra (gate → drive → tone → mod → eco)',
    order: ['gate', 'dist', 'sat', 'eq', 'comp', 'chorus', 'trem', 'delay', 'reverb', 'deess', 'limiter'],
  },
  drums: {
    name: 'Ordem bateria (gate → transientes → limite)',
    order: ['gate', 'sat', 'eq', 'comp', 'limiter', 'deess', 'dist', 'trem', 'chorus', 'delay', 'reverb'],
  },
}

function reorderBuiltinChain(chain: string[], order: BuiltinFxId[]): string[] {
  const wanted = [
    ...order,
    ...BUILTIN_FX_IDS.filter((id) => !order.includes(id)),
  ].map(builtinChainId)
  const present = new Set(chain.filter((entry) => entry.startsWith('fx:')))
  const ordered = wanted.filter((entry) => present.has(entry))
  const result: string[] = []
  let index = 0
  for (const entry of chain) {
    // Each built-in slot takes the next unit of the new order; plugins are
    // copied through untouched, in place. A chain that somehow listed one unit
    // twice keeps a single copy instead of wiring a loop.
    if (!entry.startsWith('fx:')) {
      result.push(entry)
      continue
    }
    const next = ordered[index]
    if (next) {
      result.push(next)
      index += 1
    }
  }
  return result
}

// ------------------------------------------------------------- mix presets

interface MixPatch {
  rack: BuiltinFxRack
  rvSend: number
  dlSend: number
  trimDb: number
}

/**
 * Channel strips presets: FX rack + send amounts + trim, tuned per source.
 */
const MIX_PRESETS: Record<string, { name: string; patch: () => MixPatch }> = {
  clean: {
    name: 'Clean / flat',
    patch: () => ({ rack: defaultBuiltinFx(), rvSend: 0, dlSend: 0, trimDb: 0 }),
  },
  popVocal: {
    name: 'Voz pop (gate + comp + de-ess + reverb)',
    patch: () => {
      const r = defaultBuiltinFx()
      r.gate = { enabled: true, mix: 1, params: { ...r.gate.params, gateThreshold: -48, gateRange: 30 } }
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 90, eqLowGain: -2.5, eqMidFreq: 2600, eqMidGain: 3, eqHighFreq: 9000, eqHighGain: 2.5 },
      }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -22, compRatio: 3.5, compAttack: 6, compRelease: 160, compMakeup: 3 } }
      r.deess = { enabled: true, mix: 1, params: { ...r.deess.params, deessFreq: 6800, deessThreshold: -24, deessRatio: 5 } }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -1.5 } }
      return { rack: r, rvSend: 0.28, dlSend: 0.08, trimDb: 0 }
    },
  },
  radioVocal: {
    name: 'Voz rádio (squash + banda estreita)',
    patch: () => {
      const r = defaultBuiltinFx()
      r.gate = { enabled: true, mix: 1, params: { ...r.gate.params, gateThreshold: -42 } }
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 180, eqLowGain: -6, eqMidFreq: 1600, eqMidGain: 5, eqMidQ: 1.8, eqHighFreq: 6000, eqHighGain: -4 },
      }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -28, compRatio: 8, compAttack: 2, compRelease: 120, compMakeup: 6 } }
      r.deess = { enabled: true, mix: 1, params: { ...r.deess.params, deessFreq: 5200, deessThreshold: -20, deessRatio: 8 } }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -2 } }
      return { rack: r, rvSend: 0.05, dlSend: 0, trimDb: 1.5 }
    },
  },
  drumPunch: {
    name: 'Bateria punchy (comp + EQ + limitador)',
    patch: () => {
      const r = defaultBuiltinFx()
      r.gate = { enabled: true, mix: 1, params: { ...r.gate.params, gateThreshold: -52, gateRange: 40 } }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -18, compRatio: 4, compAttack: 3, compRelease: 90, compMakeup: 4 } }
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 70, eqLowGain: 3.5, eqMidFreq: 400, eqMidGain: -2.5, eqHighFreq: 7000, eqHighGain: 4 },
      }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -1 } }
      return { rack: r, rvSend: 0.1, dlSend: 0, trimDb: 0 }
    },
  },
  softPiano: {
    name: 'Piano suave (chorus + reverb)',
    patch: () => {
      const r = defaultBuiltinFx()
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 110, eqLowGain: 1.5, eqMidFreq: 900, eqMidGain: -1.5, eqHighFreq: 5200, eqHighGain: 2 },
      }
      r.chorus = { enabled: true, mix: 0.25, params: { ...r.chorus.params, rate: 0.7, depth: 2.4 } }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -20, compRatio: 2.5, compAttack: 18, compRelease: 220 } }
      r.sat = { enabled: true, mix: 0.3, params: { ...r.sat.params, satDrive: 0.18, satTone: 11000, satTrim: -2 } }
      return { rack: r, rvSend: 0.32, dlSend: 0.12, trimDb: -1 }
    },
  },
  guitarRock: {
    name: 'Guitar rock (dist + cab EQ + delay)',
    patch: () => {
      const r = defaultBuiltinFx()
      r.dist = { enabled: true, mix: 0.4, params: { ...r.dist.params, drive: 0.55, tone: 4200 } }
      r.sat = { enabled: true, mix: 0.5, params: { ...r.sat.params, satDrive: 0.35, satTone: 8000, satTrim: -4 } }
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 120, eqLowGain: -2, eqMidFreq: 2200, eqMidGain: 4, eqHighFreq: 6500, eqHighGain: 1.5 },
      }
      r.delay = { enabled: true, mix: 0.2, params: { ...r.delay.params, time: 360, feedback: 0.3 } }
      return { rack: r, rvSend: 0.14, dlSend: 0.1, trimDb: -2 }
    },
  },
  ambient: {
    name: 'Ambiente (chorus + sends longos)',
    patch: () => {
      const r = defaultBuiltinFx()
      r.chorus = { enabled: true, mix: 0.4, params: { ...r.chorus.params, rate: 1.1, depth: 4.5 } }
      r.eq = { enabled: true, mix: 1, params: { ...r.eq.params, eqLowGain: 1, eqHighGain: 3 } }
      return { rack: r, rvSend: 0.5, dlSend: 0.35, trimDb: -3 }
    },
  },
}

/** Master bus presets for the final recording / export. */
const MASTER_PRESETS: Record<string, { name: string; rack: () => BuiltinFxRack }> = {
  none: {
    name: 'Sem processamento',
    rack: () => defaultBuiltinFx(),
  },
  glue: {
    name: 'Glue de mixagem (EQ + comp suave)',
    rack: () => {
      const r = defaultBuiltinFx()
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 80, eqLowGain: 1.5, eqMidFreq: 1200, eqMidGain: -1, eqHighFreq: 8000, eqHighGain: 1.5 },
      }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -12, compRatio: 2, compAttack: 20, compRelease: 250, compKnee: 12 } }
      return r
    },
  },
  broadcast: {
    name: 'Broadcast (comp forte + limitador)',
    rack: () => {
      const r = defaultBuiltinFx()
      r.eq = { enabled: true, mix: 1, params: { ...r.eq.params, eqLowGain: 1, eqMidGain: 1.5, eqHighGain: 2 } }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -18, compRatio: 4, compAttack: 8, compRelease: 160, compMakeup: 4 } }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -1, limCeiling: -0.3 } }
      return r
    },
  },
  masterLight: {
    name: 'Mastering leve (EQ + limitador)',
    rack: () => {
      const r = defaultBuiltinFx()
      r.eq = {
        enabled: true,
        mix: 1,
        params: { ...r.eq.params, eqLowFreq: 60, eqLowGain: 1.5, eqMidFreq: 300, eqMidGain: -0.5, eqHighFreq: 10000, eqHighGain: 1.5 },
      }
      r.comp = { enabled: true, mix: 1, params: { ...r.comp.params, compThreshold: -8, compRatio: 1.6, compAttack: 30, compRelease: 300, compKnee: 8 } }
      r.limiter = { enabled: true, mix: 1, params: { ...r.limiter.params, limThreshold: -0.8, limRelease: 30, limCeiling: -0.1 } }
      return r
    },
  },
}

function sanitizePlugins(value: unknown): PluginState[] {
  const raw = Array.isArray(value) ? value : []
  const out: PluginState[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const plugin = item as Record<string, unknown>
    const id = typeof plugin.id === 'string' && plugin.id ? plugin.id : ''
    const kind = plugin.kind
    if (!id || (kind !== 'ir' && kind !== 'nam' && kind !== 'worklet')) continue
    const params = Array.isArray(plugin.params)
      ? plugin.params
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry): PluginParamInfo => ({
            name: String(entry.name ?? ''),
            value: Number(entry.value ?? 0),
            min: Number(entry.min ?? 0),
            max: Number(entry.max ?? 1),
            ...(Number.isFinite(entry.step) ? { step: Number(entry.step) } : {}),
            ...(entry.unit === 'percent' ||
            entry.unit === 'ratio' ||
            entry.unit === 'pan' ||
            entry.unit === 'hz' ||
            entry.unit === 'db'
              ? { unit: entry.unit }
              : {}),
          }))
          .filter((entry) => entry.name !== '')
      : []
    out.push({
      id,
      name: typeof plugin.name === 'string' && plugin.name ? plugin.name.slice(0, 60) : 'Plugin',
      kind,
      params,
      detail: typeof plugin.detail === 'string' ? plugin.detail.slice(0, 120) : undefined,
      enabled: plugin.enabled !== false,
      assetId: typeof plugin.assetId === 'string' && plugin.assetId ? plugin.assetId : undefined,
    })
  }
  return out
}

function sanitizeChain(value: unknown, pluginIds: ReadonlySet<string> = new Set()): string[] {
  const chain: string[] = []
  const raw = Array.isArray(value) ? value : []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry || chain.includes(entry)) continue
    if (entry.startsWith('fx:')) {
      const id = entry.slice(3) as BuiltinFxId
      if (BUILTIN_FX_IDS.includes(id)) chain.push(entry)
      continue
    }
    // A plugin id is only meaningful while its descriptor survived. Dropping
    // the routing entry here would be the old bug in disguise: a loaded NAM
    // could be present in the rack but silently absent from the signal path.
    if (pluginIds.has(entry)) chain.push(entry)
  }
  return chain
}

/**
 * The chain is the signal path, so an effect that is switched on has to be in
 * it: a preset that enables the reverb of a track whose chain left the reverb
 * out would otherwise change nothing but the numbers on the rack. Effects that
 * are off stay exactly where the producer left them — a card that is bypassed
 * still holds its knobs — and an effect that is not in the chain at all is the
 * one thing the producer asked for by pressing ✕.
 */
function chainWithEnabledRack(chain: string[], rack: BuiltinFxRack): string[] {
  const next = [...chain]
  for (const fxId of BUILTIN_FX_IDS) {
    const key = builtinChainId(fxId)
    if (rack[fxId]?.enabled && !next.includes(key)) next.push(key)
  }
  return next
}

function chainWithPlugin(track: TrackState, pluginId: string): string[] {
  const next = track.chain.filter((entry) => entry !== pluginId)
  const plugin = track.plugins.find((item) => item.id === pluginId)

  if (plugin?.kind === 'nam') {
    let lastNam = -1
    next.forEach((entry, index) => {
      const item = track.plugins.find((candidate) => candidate.id === entry)
      if (item?.kind === 'nam') lastNam = index
    })
    if (lastNam >= 0) {
      next.splice(lastNam + 1, 0, pluginId)
      return next
    }
  }

  const index = next.findIndex((entry) => entry.startsWith('fx:'))
  if (index < 0) next.push(pluginId)
  else next.splice(index, 0, pluginId)
  return next
}

type ChainDisplayEntry =
  | { key: string; kind: 'builtin'; id: BuiltinFxId }
  | { key: string; kind: 'plugin'; plugin: PluginState }

function chainEntriesFor(track: TrackState): ChainDisplayEntry[] {
  const entries: ChainDisplayEntry[] = []
  const seen = new Set<string>()
  for (const entry of track.chain) {
    if (seen.has(entry)) continue
    if (entry.startsWith('fx:')) {
      const id = entry.slice(3) as BuiltinFxId
      if (!BUILTIN_FX_IDS.includes(id)) continue
      seen.add(entry)
      entries.push({ key: entry, kind: 'builtin', id })
    } else {
      const plugin = track.plugins.find((item) => item.id === entry)
      if (!plugin) continue
      seen.add(entry)
      entries.push({ key: entry, kind: 'plugin', plugin })
    }
  }
  // Built-ins are only ever what the chain says: the producer adds and removes
  // them, so a card that is not in the list is not in the window. Plugins are
  // the opposite — a file that was loaded belongs on the chain even if an old
  // order list forgot it, because dropping it from the view would drop the work
  // the producer did to get it there.
  for (const plugin of track.plugins) {
    if (seen.has(plugin.id)) continue
    seen.add(plugin.id)
    entries.push({ key: plugin.id, kind: 'plugin', plugin })
  }
  return entries
}

/**
 * Every parameter range the engine and the app agree on, collected from the UI
 * definitions. Sanitizing a saved rack against this map instead of a hand-copied
 * list means a knob added to `BUILTIN_FX_META` is automatically validated on
 * load - the old list had already drifted (it still clamped gate keys the engine
 * no longer reads and ignored the newer units entirely).
 */
const FX_PARAM_RANGES: Map<string, { min: number; max: number }> = (() => {
  const ranges = new Map<string, { min: number; max: number }>()
  for (const meta of Object.values(BUILTIN_FX_META)) {
    for (const param of meta.params) {
      if (!ranges.has(param.key)) ranges.set(param.key, { min: param.min, max: param.max })
    }
  }
  return ranges
})()

function sanitizeFxRack(value: unknown): BuiltinFxRack {
  const defaults = defaultBuiltinFx()
  if (!value || typeof value !== 'object') return defaults
  const raw = value as Record<string, unknown>
  const out = defaultBuiltinFx()
  for (const id of BUILTIN_FX_IDS) {
    const entry = raw[id]
    if (!entry || typeof entry !== 'object') continue
    const unit = entry as Record<string, unknown>
    const params =
      unit.params && typeof unit.params === 'object'
        ? (unit.params as Record<string, unknown>)
        : {}
    const sanitized: Record<string, number> = {}
    for (const [key, fallback] of Object.entries(defaults[id].params)) {
      const range = FX_PARAM_RANGES.get(key)
      sanitized[key] = range
        ? clampNumber(params[key], range.min, range.max, fallback)
        : clampNumber(params[key], -1e6, 1e6, fallback)
    }
    out[id] = {
      enabled: Boolean(unit.enabled),
      mix: clampNumber(unit.mix, 0, 1, defaults[id].mix),
      params: sanitized as unknown as BuiltinFxParams,
    }
  }
  return out
}

function sanitizeNotes(value: unknown): InstrumentNote[] {
  if (!Array.isArray(value)) return []
  const notes: InstrumentNote[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const step = clampNumber(item.step, 0, 100000, -1)
    if (step < 0) continue
    notes.push({
      step: Math.round(step),
      pitch: Math.round(clampNumber(item.pitch, 0, 127, 60)),
      length: Math.max(1, Math.round(clampNumber(item.length, 1, 4096, 1))),
      velocity: clampNumber(item.velocity, 0.05, 1, 0.85),
    })
    if (notes.length >= 4096) break
  }
  return notes
}

function sanitizeAutomation(value: unknown): AutomationBreakpoint[] {
  if (!Array.isArray(value)) return []
  const points: AutomationBreakpoint[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const step = clampNumber(item.step, 0, AUTO_MAX_STEP, -1)
    if (step < 0) continue
    // Steps stay as drawn: with snap off a point can sit between 16ths, and a
    // reload must not slide it onto the grid.
    points.push({ step, value: clampNumber(item.value, AUTO_MIN_DB, AUTO_MAX_DB, 0) })
    if (points.length >= AUTO_MAX_POINTS) break
  }
  // Out-of-order or duplicated steps are repaired, not thrown away: a lane that
  // survived an interrupted save still draws the envelope it was meant to.
  return sortedAutomation(points)
}

/** How many takes a lane remembers before the oldest pass is dropped. */
const MAX_TAKES = 8

/** A shelf of recorded passes survives a save and load; nothing untrusted gets in. */
function sanitizeTakes(raw: unknown): AudioTake[] {
  if (!Array.isArray(raw)) return []
  const shelf: AudioTake[] = []
  for (const item of raw) {
    const take = item as Record<string, unknown>
    const id = typeof take.id === 'string' ? take.id : ''
    if (!id) continue
    shelf.push({
      id,
      name: typeof take.name === 'string' && take.name ? take.name : 'Take',
      start: Number.isFinite(take.start) ? Math.max(0, Number(take.start)) : 0,
      duration: Number.isFinite(take.duration) ? Math.max(0, Number(take.duration)) : 0,
      fadeIn: Number.isFinite(take.fadeIn) ? Math.max(0, Number(take.fadeIn)) : 0,
      fadeOut: Number.isFinite(take.fadeOut) ? Math.max(0, Number(take.fadeOut)) : 0,
    })
  }
  return shelf.slice(-MAX_TAKES)
}

/**
 * What the panel shows about one lane's live plugin: that it is in the signal,
 * how much delay it adds, how much of the audio it managed to keep up with, and
 * the plugin's own words if it stopped answering. Kept as four numbers rather
 * than a green dot because a producer hearing an amp through a .dll on the other
 * side of a process boundary deserves to know what that costs.
 */
interface LiveVstState {
  name: string
  latencyMs: number
  batches: number
  /** Batches the plugin process answered with audio — the ear is not on dry. */
  answered: number
  underruns: number
  error: string
}

function sameLiveState(a: LiveVstState, b: LiveVstState): boolean {
  return (
    a.name === b.name &&
    a.latencyMs === b.latencyMs &&
    a.batches === b.batches &&
    a.answered === b.answered &&
    a.underruns === b.underruns &&
    a.error === b.error
  )
}

/** The lane's knob values as one string, so a change is only sent once. */
function liveParamSignature(slot: { params: { index: number; value: number }[] }): string {
  return slot.params
    .map((item) => `${item.index}:${item.value.toFixed(4)}`)
    .sort()
    .join(',')
}

/**
 * The native VST2 slot as it was stored. The path is a machine-specific file
 * location, so it is kept only as text a plugin scan can confirm; a project
 * opened on another PC simply shows the slot empty until the producer picks the
 * plugin again. Parameter values are clamped to the 0..1 the dispatcher takes.
 */
function sanitizeNativeVst(raw: unknown): NativeVstSlot | null {
  if (!raw || typeof raw !== 'object') return null
  const slot = raw as Record<string, unknown>
  const path = typeof slot.path === 'string' ? slot.path : ''
  // A VST2 is a .dll; a VST3 is a .vst3 bundle, which on Windows is a folder.
  // Both are native plugins the same slot holds, so the filter is by engine,
  // not by extension.
  if (!/\.(dll|vst3)$/i.test(path)) return null
  const params: { index: number; value: number }[] = []
  if (Array.isArray(slot.params)) {
    for (const item of slot.params) {
      const param = item as Record<string, unknown>
      const index = Number(param.index)
      // A VST3 has no parameter indexes: the panel lists them by id, and an id
      // is a 32-bit number (Bypass is conventionally 65536). The old 4095
      // ceiling was a VST2 thought and would silently drop VST3 ids.
      if (!Number.isInteger(index) || index < 0 || index > 0xff_ff_ff) continue
      params.push({ index, value: clampNumber(param.value, 0, 1, 0) })
      if (params.length >= 64) break
    }
  }
  return {
    path,
    name: typeof slot.name === 'string' && slot.name ? slot.name.slice(0, 40) : path.split(/[\\/]/).pop() ?? 'VST',
    params,
    bypass: slot.bypass === true,
  }
}

/**
 * The sidechain sources as they were stored. A project saved before a duck could
 * follow more than one track carries a single id; reading it as a one-item list
 * means an old file still ducks exactly the way it did, with the new controls on
 * top of it.
 */
function readDuckSources(track: Partial<TrackState>): string[] {
  if (Array.isArray(track.duckSourceIds)) {
    return track.duckSourceIds.filter((id): id is string => typeof id === 'string')
  }
  const legacy = (track as { duckSourceId?: unknown }).duckSourceId
  return typeof legacy === 'string' && legacy !== '' ? [legacy] : []
}

/**
 * The input a lane was given, as it was stored. The number is how many channels
 * the interface carries for this lane; 0 means the pair as it arrives. A project
 * written when the choice was three words reads back the same patch: `left` was
 * input 1 and `right` was input 2, and anything the file cannot answer becomes the
 * whole stream rather than a guessed channel.
 */
function readInputChannel(raw: unknown): InputChannel {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.max(0, Math.min(MAX_INPUT_CHANNELS, Math.round(raw))) : 0
  }
  if (raw === 'left') return 1
  if (raw === 'right') return 2
  return 0
}

/**
 * What a live input really is, in the words a producer uses. Read from the engine's
 * answer — how many channels the device handed over and which one this lane owns —
 * so a mono microphone asked for as a stereo pair is named as one channel instead
 * of being described as the pair it never became.
 */
function describeLiveInput(status: InputStatus | null | undefined): string {
  if (!status) return 'Entrada'
  if (status.channel >= 1) return `Entrada ${status.channel}`
  return status.channels > 1 ? 'Par estéreo' : 'Entrada mono'
}

function sanitizeTrack(track: Partial<TrackState>, index: number): TrackState {
  const plugins = sanitizePlugins(track.plugins)
  const pluginIds = new Set(plugins.map((plugin) => plugin.id))
  return {
    id: typeof track.id === 'string' && track.id ? track.id : newId(),
    number: index + 1,
    name: typeof track.name === 'string' ? track.name : `Track ${index + 1}`,
    color: typeof track.color === 'string' ? track.color : TRACK_COLORS[index % TRACK_COLORS.length],
    volume: clampNumber(track.volume, 0, 1.5, 1),
    pan: clampNumber(track.pan, -1, 1, 0),
    trimDb: clampNumber(track.trimDb, -24, 24, 0),
    phaseInvert: Boolean(track.phaseInvert),
    mono: Boolean(track.mono),
    rvSend: clampNumber(track.rvSend, 0, 1, 0),
    dlSend: clampNumber(track.dlSend, 0, 1, 0),
    isArmed: Boolean(track.isArmed),
    isMuted: Boolean(track.isMuted),
    isSoloed: Boolean(track.isSoloed),
    hasFx: Boolean(track.hasFx),
    drive: clampNumber(track.drive, 1, 100, 35),
    cabinet: clampNumber(track.cabinet, 1000, 8000, 4500),
    // A recording program remembers its patching: the device id and the input it
    // was given come back with the project, and `reconnectSavedInputs` reopens
    // them once the browser will name the hardware again. The monitor is the one
    // thing left off — a live microphone opening by itself in a room with speakers
    // is how feedback starts, and a producer lights it on purpose.
    inputDeviceId: typeof track.inputDeviceId === 'string' ? track.inputDeviceId : '',
    // A call lane is carried by a live WebRTC stream, which a file cannot hold.
    // The raw value is kept only so `sanitizeProject` can recognise the row and
    // drop it; nothing downstream ever sees a non-empty key in a loaded project.
    callChannelKey: typeof track.callChannelKey === 'string' ? track.callChannelKey : '',
    inputChannel: readInputChannel(track.inputChannel),
    inputWet: Boolean(track.inputWet),
    inputMonitor: false,
    // Plugin descriptors return from localStorage; their bytes return from
    // IndexedDB. A project opened on another machine may have metadata but no
    // asset, and restorePlugins removes only that stale slot.
    plugins,
    nativeVst2: sanitizeNativeVst(track.nativeVst2),
    chain: sanitizeChain(track.chain, pluginIds),
    fxRack: sanitizeFxRack(track.fxRack),
    clipStart: clampNumber(track.clipStart, 0, 100000, 0),
    clipDuration: clampNumber(track.clipDuration, 0, 100000, 0),
    fadeIn: clampNumber(track.fadeIn, 0, 10, 0.005),
    fadeOut: clampNumber(track.fadeOut, 0, 10, 0.005),
    automation: sanitizeAutomation(track.automation),
    clipName: typeof track.clipName === 'string' ? track.clipName : '',
    bufferId: typeof track.bufferId === 'string' ? track.bufferId : '',
    kind: track.kind === 'instrument' ? 'instrument' : 'audio',
    instrument:
      track.instrument === 'drums' || track.instrument === 'bass'
        ? track.instrument
        : 'piano',
    midiNotes: sanitizeNotes(track.midiNotes),
    patternSteps: normalizePatternSteps(track.patternSteps),
    isFolder: Boolean(track.isFolder),
    collapsed: Boolean(track.collapsed),
    folderId: typeof track.folderId === 'string' && track.folderId ? track.folderId : null,
    takes: sanitizeTakes(track.takes),
    groupId: typeof track.groupId === 'string' ? track.groupId : '',
    duckSourceIds: readDuckSources(track),
    duckDepth: clampNumber(track.duckDepth, 0, 1, 0.7),
    voice:
      typeof track.voice === 'string' && track.voice
        ? track.voice
        : defaultVoice(
            track.instrument === 'drums' || track.instrument === 'bass'
              ? track.instrument
              : 'piano',
          ),
  }
}

/**
 * Turn the track list into the rows the TCP and the arrange view paint. A row
 * belongs to the folder named by `folderId`; folding a folder hides (but does
 * not mute) its children. A child whose folder row is gone is shown top level,
 * so nothing can ever disappear from the list.
 */
function buildLaneRows(list: TrackState[]): LaneRow[] {
  const folders = new Map(list.filter((track) => track.isFolder).map((track) => [track.id, track]))
  return list.map((track, index) => {
    const parent = track.folderId ? (folders.get(track.folderId) ?? null) : null
    const ownFolder = Boolean(parent && parent.id !== track.id)
    return {
      track,
      indent: ownFolder ? 1 : 0,
      hidden: ownFolder && parent?.collapsed === true,
      index,
    }
  })
}

/** First index after every row that belongs to the folder at `headerIndex`. */
function folderEnd(list: TrackState[], headerIndex: number): number {
  const id = list[headerIndex]?.id
  if (!id) return list.length
  let end = headerIndex + 1
  for (let i = list.length - 1; i > headerIndex; i -= 1) {
    if (list[i].folderId === id) {
      end = i + 1
      break
    }
  }
  return end
}

/** "003.2" bar.beat readout for a step position, for range labels. */
function barBeatOf(step: number): string {
  const bar = Math.floor(Math.max(0, step) / STEP_COUNT) + 1
  const beat = Math.floor((Math.max(0, step) % STEP_COUNT) / 4) + 1
  return `${String(bar).padStart(3, '0')}.${beat}`
}

function sanitizeMarker(marker: Partial<Marker>): Marker {
  return {
    id: typeof marker.id === 'string' && marker.id ? marker.id : newId(),
    position: clampNumber(marker.position, 0, 100000, 0),
    name: typeof marker.name === 'string' ? marker.name : 'Marcador',
    color: typeof marker.color === 'string' ? marker.color : '#79a8d6',
    isRegion: Boolean(marker.isRegion),
    regionEnd: marker.regionEnd ? clampNumber(marker.regionEnd, 0, 100000, 0) : undefined,
  }
}

function sanitizeSends(value: unknown): SendConfig {
  const base = defaultSendConfig()
  if (!value || typeof value !== 'object') return base
  const raw = value as Record<string, unknown>
  return {
    rvDecay: clampNumber(raw.rvDecay, 0.3, 8, base.rvDecay),
    dlTime: clampNumber(raw.dlTime, 20, 2000, base.dlTime),
    dlFeedback: clampNumber(raw.dlFeedback, 0, 0.9, base.dlFeedback),
    rvReturn: clampNumber(raw.rvReturn, 0, 2, base.rvReturn),
    dlReturn: clampNumber(raw.dlReturn, 0, 2, base.dlReturn),
  }
}

/** A saved project can carry any shape; a group strip needs real numbers. */
function sanitizeGroup(value: Partial<GroupState>, index: number): GroupState {
  return {
    id: typeof value.id === 'string' && value.id ? value.id : newId(),
    name: typeof value.name === 'string' && value.name ? value.name : `Grupo ${index + 1}`,
    color:
      typeof value.color === 'string' && value.color
        ? value.color
        : TRACK_COLORS[index % TRACK_COLORS.length],
    volume: clampNumber(value.volume, 0, 1.5, 1),
    pan: clampNumber(value.pan, -1, 1, 0),
    isMuted: Boolean(value.isMuted),
  }
}

/**
 * References are cleaned up here rather than in `sanitizeTrack`, because only the
 * whole project knows which ids still exist: a track whose group was deleted goes
 * back to the master, and a sidechain source that is gone - or is a folder, which
 * carries no signal - is dropped instead of silently ducking from nothing.
 */
function reconcileReferences(list: TrackState[], groups: GroupState[]): TrackState[] {
  const groupIds = new Set(groups.map((group) => group.id))
  const sourceIds = new Set(list.filter((track) => !track.isFolder).map((track) => track.id))
  return list.map((track) => ({
    ...track,
    groupId: track.isFolder || !groupIds.has(track.groupId) ? '' : track.groupId,
    // The same cleaning the engine applies to a live request, so a loaded project
    // cannot show a source the graph refuses to wire.
    duckSourceIds: normalizeDuckSources(track.duckSourceIds, track.id, sourceIds),
  }))
}

function sanitizeProject(data: Partial<SavedProject>): SavedProject {
  // Uma faixa de chamada existe enquanto o WebRTC existe. O arquivo não pode
  // guardar o stream, nem o monitor dele, nem a mixagem de um retorno que não
  // está no ar — então a linha sai do projeto carregado e reaparece quando o
  // cabo liga de novo e a sala manda o canal outra vez.
  const tracks = Array.isArray(data.tracks)
    ? data.tracks.map(sanitizeTrack).filter((track) => !track.callChannelKey)
    : []
  const groups = Array.isArray(data.groups)
    ? data.groups.map((group, index) => sanitizeGroup(group, index))
    : []
  const markers = Array.isArray(data.markers) ? data.markers.map(sanitizeMarker) : []
  return {
    version: 5,
    bpm: clampNumber(data.bpm, 40, 280, 120),
    masterVolume: clampNumber(data.masterVolume, 0, 1.5, 0.9),
    masterMuted: Boolean(data.masterMuted),
    metronome: false,
    loop: data.loop !== false,
    countIn: Boolean(data.countIn),
    arrangementBars: clampNumber(data.arrangementBars, 1, 128, 16),
    recordLatencyMs:
      typeof data.recordLatencyMs === 'number' && Number.isFinite(data.recordLatencyMs)
        ? Math.max(-1, Math.min(200, Math.round(data.recordLatencyMs)))
        : -1,
    snapEnabled: data.snapEnabled !== false,
    zoomBars: clampNumber(data.zoomBars, 0, 128, 0),
    masterFx: sanitizeFxRack(data.masterFx),
    sends: sanitizeSends(data.sends),
    tracks: reconcileReferences(tracks, groups),
    groups,
    markers,
  }
}

// ------------------------------------------------------------ undo / redo
// Snapshots hold project metadata only: audio lives in IndexedDB and is
// referenced by id, so sixty states cost a few hundred kilobytes.

function cloneProject(project: SavedProject): SavedProject {
  if (typeof structuredClone === 'function') return structuredClone(project)
  return JSON.parse(JSON.stringify(project)) as SavedProject
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') {
    // Treat sub-LSB differences as the same value so knob drags coalesce.
    return Math.abs(a - b) < 0.0005
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Describes what changed between two states. The returned string doubles as
 * the coalescing key: repeated edits with the same signature inside a short
 * window (a knob or clip drag) collapse into a single undo step.
 *
 * View preferences (zoom, snap) and the latency compensation are deliberately
 * absent: they are how you are looking at the project, not the project, so
 * undo must never move your viewport or change a device offset under you.
 */
function projectSignature(before: SavedProject, after: SavedProject): string {
  const parts: string[] = []
  for (const key of [
    'bpm',
    'masterVolume',
    'masterMuted',
    'loop',
    'countIn',
    'arrangementBars',
  ] as const) {
    if (!sameValue(before[key], after[key])) parts.push(key)
  }
  if (!sameValue(before.masterFx, after.masterFx)) parts.push('masterFx')
  if (!sameValue(before.sends, after.sends)) parts.push('sends')
  if (!sameValue(before.markers, after.markers)) parts.push('markers')
  // Group buses are mix decisions like the sends: one step when one appears,
  // disappears or moves.
  if (!sameValue(before.groups ?? [], after.groups ?? [])) parts.push('groups')

  const ids = new Set<string>([
    ...before.tracks.map((track) => track.id),
    ...after.tracks.map((track) => track.id),
  ])
  for (const id of ids) {
    const prev = before.tracks.find((track) => track.id === id)
    const next = after.tracks.find((track) => track.id === id)
    if (!prev || !next) {
      parts.push(`${id}:track`)
      continue
    }
    const changed = TRACK_EDIT_KEYS.filter((key) => !sameValue(prev[key], next[key]))
    if (changed.length > 0) parts.push(`${id}:${changed.join(',')}`)
  }
  return parts.join('|')
}

const TRACK_EDIT_KEYS = [
  'name',
  'color',
  'volume',
  'pan',
  'trimDb',
  'phaseInvert',
  'mono',
  'rvSend',
  'dlSend',
  'isArmed',
  'isMuted',
  'isSoloed',
  'hasFx',
  'drive',
  'cabinet',
  'plugins',
  'chain',
  'fxRack',
  'clipStart',
  'clipDuration',
  'fadeIn',
  'fadeOut',
  'automation',
  'clipName',
  'bufferId',
  'kind',
  'instrument',
  'midiNotes',
  'patternSteps',
  'voice',
  'isFolder',
  'collapsed',
  'folderId',
  'groupId',
  'duckSourceIds',
  'duckDepth',
  // The take shelf holds recorded and bounced passes the producer can put back
  // at any moment, so it is project material like a clip is: throwing the takes
  // away (or a bounce moving one onto the shelf) has to be a step that Ctrl+Z
  // can walk back, not a silent edit.
  'takes',
] as const

function loadStored(): SavedProject | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedProject>
    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) return null
    return sanitizeProject(parsed)
  } catch {
    return null
  }
}

function computePeaks(buffer: AudioBuffer, count = 260): number[] {
  const channels = Math.min(2, buffer.numberOfChannels)
  const blocks: Float32Array[] = []
  for (let channel = 0; channel < channels; channel += 1) {
    blocks.push(buffer.getChannelData(channel))
  }
  const block = Math.max(1, Math.floor(buffer.length / count))
  const peaks: number[] = []
  for (let i = 0; i < count; i += 1) {
    let peak = 0
    // Stereo clips show the loudest of both channels.
    for (let channel = 0; channel < blocks.length; channel += 1) {
      const data = blocks[channel]
      let min = 1
      let max = -1
      for (let j = 0; j < block; j += 1) {
        const value = data[i * block + j] ?? 0
        if (value < min) min = value
        if (value > max) max = value
      }
      peak = Math.max(peak, Math.abs(min), Math.abs(max))
    }
    peaks.push(peak)
  }
  return peaks
}

function downloadBlob(blob: Blob, filename: string): void {
  if (isNativeApp()) {
    // The executable writes through the operating system's own dialog, so the
    // producer chooses the folder and the bridge reports where it went. An
    // <a download> click here would quietly dump the file into Downloads.
    void nativeSaveBlob(blob, filename).catch((error: unknown) =>
      nativeNotify(`Não deu para salvar: ${(error as Error).message}`),
    )
    return
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/**
 * A loudness number the way a meter shows it: one decimal, and `-inf` when the
 * gate found nothing. Producers read `-inf` as "digital silence", not as a crash.
 */
function formatLufs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '-inf'
}

/** One rendered file and the reading taken from its bytes. */
interface ExportReport {
  label: string
  file: string
  loudness: LoudnessReport
  warnings: string[]
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function Waveform({ peaks, color }: { peaks: number[]; color: string }) {
  const width = Math.max(peaks.length, 1)
  return (
    <svg className="waveform" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
      {peaks.map((peak, index) => {
        const height = Math.min(Math.max(2, peak * 96 * 2), 96)
        return (
          <rect
            key={index}
            x={index}
            y={50 - height / 2}
            width={1}
            height={height}
            fill={color}
          />
        )
      })}
    </svg>
  )
}

/**
 * The take being recorded right now: a strip on the lane that grows as the
 * producer plays, drawn from the peaks the capture tap reports. Keeping the
 * column count bounded keeps a long take from flooding the lane with rects.
 */
function LiveTake({
  peaks,
  seconds,
  startStep,
  stepDuration,
  totalSteps,
  color,
}: {
  peaks: number[]
  seconds: number
  startStep: number
  stepDuration: number
  totalSteps: number
  color: string
}) {
  const columns = 260
  const shown: number[] = []
  const block = Math.max(1, Math.floor(peaks.length / columns))
  for (let i = 0; i < peaks.length; i += block) {
    let peak = 0
    for (let j = 0; j < block && i + j < peaks.length; j += 1) {
      peak = Math.max(peak, peaks[i + j])
    }
    shown.push(peak)
  }

  const steps = stepDuration > 0 ? seconds / stepDuration : 0
  const left = (startStep / totalSteps) * 100
  const width = Math.max(0.5, Math.min((steps / totalSteps) * 100, 100 - left))

  return (
    <div
      className="audio-item live-take"
      style={{ left: `${left}%`, width: `${width}%`, borderColor: color }}
      title={`Gravando · ${seconds.toFixed(1)} s`}
    >
      <Waveform peaks={shown} color={color} />
      <span className="live-take-label">● {seconds.toFixed(1)} s</span>
    </div>
  )
}

/**
 * What the take sounds like while it is being born: one live spectrum per
 * recording lane. The bins come from an analyser fed by the same tap that
 * writes the file, so the picture is the recording and not the room — and if a
 * lane shows nothing, nothing is really being captured.
 */
function RecordHud({
  engine,
  items,
}: {
  engine: AudioEngine | null
  items: { id: string; name: string; color: string }[]
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const liveRef = useRef({ engine, items })
  useEffect(() => {
    liveRef.current = { engine, items }
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const bars = 44
    let raf = 0
    const render = () => {
      const { engine: liveEngine, items: list } = liveRef.current
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      ctx.clearRect(0, 0, width, height)
      const rowH = list.length > 0 ? height / list.length : height
      const labelW = 96
      ctx.font = '9px ui-monospace, Consolas, monospace'
      ctx.textBaseline = 'middle'
      list.forEach((item, index) => {
        const top = index * rowH
        ctx.fillStyle = '#8b98a6'
        ctx.fillText(item.name.slice(0, 15), 6, top + rowH / 2)
        const bins = liveEngine?.takeSpectrum(item.id) ?? null
        if (!bins) return
        // Log spacing gives the low end room to breathe, like a hardware
        // analyser; a linear axis hides everything under the first few bins.
        const usable = Math.max(1, Math.floor(bins.length * 0.72))
        const barW = (width - labelW - 10) / bars
        for (let bar = 0; bar < bars; bar += 1) {
          const from = Math.floor(Math.pow(bar / bars, 1.7) * usable)
          const to = Math.max(from + 1, Math.floor(Math.pow((bar + 1) / bars, 1.7) * usable))
          let peak = 0
          for (let i = from; i < to && i < bins.length; i += 1) peak = Math.max(peak, bins[i])
          const value = peak / 255
          const barH = Math.max(1, value * (rowH - 10))
          ctx.fillStyle = item.color
          ctx.globalAlpha = 0.3 + value * 0.7
          ctx.fillRect(labelW + bar * barW, top + rowH - 5 - barH, Math.max(1, barW - 1.5), barH)
        }
        ctx.globalAlpha = 1
      })
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="record-hud">
      <div className="record-hud-head">
        <span className="rec-dot" />
        GRAVANDO · espectro ao vivo
        <span className="record-hud-hint">o desenho é o que está entrando no arquivo</span>
      </div>
      <canvas ref={canvasRef} className="record-hud-canvas" />
    </div>
  )
}

function clampToStep(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min
  const text = String(step)
  const decimals = text.includes('.') ? text.split('.')[1].length : 0
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals))
}

// Rotary control in the spirit of AmpliTube/Gearbox: drag up/down (Shift for
// fine), mouse wheel for one step, value always visible under the label.
function Knob({
  label,
  value,
  min,
  max,
  step,
  display,
  accent = '#6fcf97',
  size = 56,
  onInput,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  accent?: string
  /** SVG edge in px; smaller sizes are used in the mixer strips. */
  size?: number
  onInput: (next: number) => void
}) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null)
  const ratio = max > min ? (value - min) / (max - min) : 0
  const angle = -135 + ratio * 270

  const point = (deg: number, radius: number) => {
    const rad = (deg * Math.PI) / 180
    return [28 + radius * Math.sin(rad), 28 - radius * Math.cos(rad)] as const
  }
  const arc = (from: number, to: number, radius: number) => {
    const [x1, y1] = point(from, radius)
    const [x2, y2] = point(to, radius)
    const large = Math.abs(to - from) > 180 ? 1 : 0
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }
  const [px, py] = point(angle, 13)
  const [qx, qy] = point(angle, 6)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    dragRef.current = { startY: event.clientY, startValue: value }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const scale = (max - min) / 160
    const delta = (drag.startY - event.clientY) * scale * (event.shiftKey ? 0.15 : 1)
    onInput(clampToStep(drag.startValue + delta, min, max, step))
  }
  const endDrag = () => {
    dragRef.current = null
  }
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const dir = event.deltaY < 0 ? 1 : -1
    onInput(clampToStep(value + dir * step, min, max, step))
  }

  return (
    <div
      className={`knob ${size < 56 ? 'knob-compact' : ''}`}
      title={`${label}: ${display} — arraste para ajustar, Shift = fino, scroll = 1 passo`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
    >
      <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
        <path d={arc(-135, 135, 20)} className="knob-track" />
        {ratio > 0.003 ? <path d={arc(-135, angle, 20)} stroke={accent} className="knob-arc" /> : null}
        <circle cx="28" cy="28" r="15" className="knob-cap" />
        <line x1={qx} y1={qy} x2={px} y2={py} stroke={accent} className="knob-pointer" />
      </svg>
      <span className="knob-label">{label}</span>
      <span className="knob-value">{display}</span>
    </div>
  )
}

/**
 * The offset that keeps a window of `width` x `height`, sitting at
 * (`baseLeft`, `baseTop`) with no offset on it, inside a viewport of the given
 * size — as close to the wanted offset as that allows.
 *
 * A window smaller than the screen can never be dragged or pulled out of it. One
 * that is not can be walked across it, but its edges only ever line up with the
 * screen's, so there is always something left on the page to press.
 */
function offsetIntoViewport(
  wantedX: number,
  wantedY: number,
  baseLeft: number,
  baseTop: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const axis = (wanted: number, base: number, size: number, viewport: number): number => {
    const atStart = -base
    const atEnd = viewport - size - base
    const lo = Math.min(atStart, atEnd)
    const hi = Math.max(atStart, atEnd)
    return Math.min(Math.max(wanted, lo), hi)
  }
  return {
    x: axis(wantedX, baseLeft, width, viewportWidth),
    y: axis(wantedY, baseTop, height, viewportHeight),
  }
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null)
  const initializedRef = useRef(false)
  const tracksRef = useRef<TrackState[]>([])
  const groupsRef = useRef<GroupState[]>([])
  const arrangementBarsRef = useRef(16)
  const songStartRef = useRef(0)
  const nextStepRef = useRef(0)
  const nextTimeRef = useRef(0)
  const playheadRef = useRef(0)
  const recordStartRef = useRef(0)
  const metronomeRef = useRef(false)
  const loopRef = useRef(true)
  const countInRef = useRef(false)
  const pendingBufferStartRef = useRef<number | null>(null)
  /**
   * Called by the scheduler on the exact step the song restarts after a count-in
   * bar, with that step. Recording uses it so the capture window opens on the
   * downbeat instead of one bar early, the way a tape machine drops into record
   * after the count — and so the take is anchored to the beat the transport is
   * actually on, not to wherever the clock happened to be when the recorder
   * finished answering.
   */
  const recordGateRef = useRef<((step: number) => void) | null>(null)
  const schedulerIdRef = useRef<number | null>(null)
  const stopTimerRef = useRef<number | null>(null)
  const isRecordingRef = useRef(false)
  /** The transport state as the audio clock sees it, for handlers and timers. */
  const isPlayingRef = useRef(false)
  /**
   * True only while the capture window is actually open — the mic recorder is
   * running or the MIDI take is being taken. During a punch pass `isRecording`
   * stays on from the moment the button is pressed so the transport keeps its
   * recording guards, but this one flips only inside the selected region.
   */
  const takeOpenRef = useRef(false)
  const scrubActiveRef = useRef(false)
  const dragChainKeyRef = useRef<string | null>(null)
  const dragTrackIdRef = useRef<string | null>(null)
  // In-memory audio clipboard: WAV bytes of a copied clip, ready to paste.
  const audioClipboardRef = useRef<{ blob: Blob; name: string; duration: number } | null>(null)
  const clipDragRef = useRef<{ trackId: string; startX: number; startStep: number; pxPerStep: number } | null>(
    null,
  )
  // In-memory MIDI clipboard: the pattern of a copied instrument clip.
  const midiClipboardRef = useRef<{
    notes: InstrumentNote[]
    instrument: InstrumentKind
    name: string
  } | null>(null)
  const selectedRef = useRef<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const pluginInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const markerNameInputRef = useRef<HTMLInputElement | null>(null)
  const markerIsRegionRef = useRef<HTMLInputElement | null>(null)
  const audioTargetRef = useRef<string | null>(null)
  const projectInputRef = useRef<HTMLInputElement | null>(null)
  const chainInputRef = useRef<HTMLInputElement | null>(null)
  const chainTargetRef = useRef<string | null>(null)
  const exportingProjectRef = useRef(false)
  const [exportingProject, setExportingProject] = useState(false)
  const pluginTarget = useRef<{ trackId: string; kind: PluginKind; attachToNam?: string } | null>(
    null,
  )

  const [tracks, setTracks] = useState<TrackState[]>([])
  /** Sub-group buses: real signal paths, so they have their own state. */
  const [groups, setGroups] = useState<GroupState[]>([])
  /**
   * The keyboard map is useful but it is not the arrangement. Collapsed by
   * default so the timeline keeps the vertical space; the toggle is one click.
   */
  const [hintsOpen, setHintsOpen] = useState(false)
  const [bpm, setBpm] = useState(120)
  const [arrangementBars, setArrangementBars] = useState(16)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [playheadStep, setPlayheadStep] = useState(0)
  /** Time range picked on the ruler with Shift+drag; edits act inside it. */
  const [timeSel, setTimeSel] = useState<{ from: number; to: number } | null>(null)
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null)
  const selDragRef = useRef<{ anchor: number } | null>(null)
  const timeSelRef = useRef<{ from: number; to: number } | null>(null)
  /** Record only inside the selected area while the transport is rolling. */
  const [punchIn, setPunchIn] = useState(false)
  const punchInRef = useRef(false)
  /** Region the open punch pass is armed for, in steps; null when not punching. */
  const punchBoundsRef = useRef<PunchBounds | null>(null)
  const punchBusyRef = useRef(false)
  /** Called by the scheduler on every pass so punch follows the audio clock. */
  const punchGateRef = useRef<() => void>(() => {})
  const [activeTab, setActiveTab] = useState<Tab>('arrangement')
  const [showMixer, setShowMixer] = useState(true)
  const [levels, setLevels] = useState<Record<string, number>>({})
  /**
   * The master bus as the standard measures it, straight off the audio thread:
   * momentary and short-term LUFS plus the sample and true peak of the last
   * 400 ms. Null means there is nothing to claim - the meter is not attached,
   * the thread is paused, or the first window has not closed.
   */
  const [masterLoudness, setMasterLoudness] = useState<LiveLoudness | null>(null)
  const [peaks, setPeaks] = useState<Record<string, number[]>>({})
  const [fxTrackId, setFxTrackId] = useState<string | null>(null)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [masterVolume, setMasterVolume] = useState(0.9)
  const [masterMuted, setMasterMuted] = useState(false)
  // Mixing bus: master FX rack + shared reverb/delay send config.
  const [masterFx, setMasterFx] = useState<BuiltinFxRack>(() => defaultBuiltinFx())
  const [sendConfig, setSendConfig] = useState<SendConfig>(() => defaultSendConfig())
  const [showMasterFx, setShowMasterFx] = useState(false)
  /**
   * A janela do cabo virtual (master → sala SALA).
   *
   * `showSala` é o que está na tela; `salaMounted` é o que existe. Os dois são
   * separados de propósito: uma chamada no ar não pode cair porque o produtor
   * fechou a janela para arrastar um clipe, então a primeira abertura monta o
   * componente e ele fica vivo mesmo invisível — a luz do jack no master é o que
   * diz que o cabo continua ligado.
   */
  const [showSala, setShowSala] = useState(false)
  const [salaMounted, setSalaMounted] = useState(false)
  const [salaLive, setSalaLive] = useState(false)
  const [metronome, setMetronome] = useState(false)
  const [loop, setLoop] = useState(true)
  const [countIn, setCountIn] = useState(false)
  // Recording offset: -1 follows the measured output latency of this device.
  const [recordLatencyMs, setRecordLatencyMs] = useState(-1)
  const [autoLatencyMs, setAutoLatencyMs] = useState(0)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [zoomBars, setZoomBars] = useState(0)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  /**
   * Playback devices, read from the browser. A browser will name them only once
   * some media permission exists, so the list can legitimately arrive empty and
   * the Devices window says so instead of showing an empty box.
   */
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  /**
   * Where the mix is going out right now: the id the engine accepted, whether it
   * really routed it, and the device's own refusal when it did not.
   */
  const [outputRoute, setOutputRoute] = useState<OutputRoute>({
    deviceId: '',
    label: 'Dispositivo padrão do sistema',
    routed: false,
    error: '',
  })
  /**
   * How many inputs each device was seen delivering. The browser only admits it
   * once a stream is open, so this is what the first connection taught us; it
   * lets a lane be patched to entrada 4 before that cable is opened a second time.
   */
  const [deviceChannels, setDeviceChannels] = useState<Record<string, number>>({})
  /** What the device itself reports as its input delay, in ms. */
  const [inputLatencyMs, setInputLatencyMs] = useState(0)
  /** The device window: one place for entries, outputs, latency and the print mode. */
  const [devicesOpen, setDevicesOpen] = useState(false)
  /**
   * The beat shown while a count-in bar plays — 3, 2, 1 — and 0 when there is no
   * count running. A producer singing into a microphone cannot watch the ruler, so
   * the number is on the screen, not in a corner.
   */
  const [countBeat, setCountBeat] = useState(0)
  // What each lane's live input actually delivered, straight from the device, so
  // the lane can say "par estéreo", "entrada 1" or "mono" from the real
  // hardware instead of from what was requested.
  const [liveInput, setLiveInput] = useState<Record<string, InputStatus | null>>({})
  // The takes currently being recorded, per lane: their peaks and how long
  // they have run, so the waveform is drawn live instead of only after the
  // take stops.
  const [takeProgress, setTakeProgress] = useState<
    Record<string, { peaks: number[]; seconds: number }>
  >({})
  const [toast, setToast] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [exportScope, setExportScope] = useState<'mix' | 'track' | 'stems'>('mix')
  const [exportBars, setExportBars] = useState(4)
  const [exporting, setExporting] = useState(false)
  /** What the rendered files actually measure, shown in the export window. */
  const [exportReports, setExportReports] = useState<ExportReport[]>([])
  // Rolling autosave history. The live autosave overwrites one key, so this is
  // the only way back to a take that was recorded over.
  const [versions, setVersions] = useState<StoredVersion[]>([])
  const versionsRef = useRef<StoredVersion[]>([])
  const [showVersions, setShowVersions] = useState(false)
  /** The native plugin browser; only ever mounted inside the desktop executable. */
  const [showPlugins, setShowPlugins] = useState(false)
  /** Bumping this remounts the panel, which is how "Procurar plugins VST…" forces a fresh scan. */
  const [pluginScan, setPluginScan] = useState(0)
  /** Lanes whose clip is crossing the native plugin process right now. */
  const [bouncingVst, setBouncingVst] = useState<Record<string, boolean>>({})
  /**
   * The native preview of each lane: the pass the plugin process rendered from
   * the clip, which is what plays and what exports while it is in place. This is
   * reporting only — the audio itself lives in the engine as the lane's monitor
   * buffer, so a project's clips and takes are never touched by a preview.
   */
  const [nativePreview, setNativePreview] = useState<Record<string, NativePreviewStatus>>({})
  /** The clock the ages are measured against; set when the window opens. */
  const [versionsNow, setVersionsNow] = useState(0)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [showMarkerInput, setShowMarkerInput] = useState<{ position: number } | null>(null)
  const [midiEditorId, setMidiEditorId] = useState<string | null>(null)
  const [midiNoteLen, setMidiNoteLen] = useState(2)
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null)
  const [scrubGhost, setScrubGhost] = useState<number | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null)
  // Right-click menu inside the arrangement lanes (copy / cut / paste / trim).
  const [clipMenu, setClipMenu] = useState<{
    x: number
    y: number
    trackId: string
    step: number
  } | null>(null)
  // Right-click on the track's own panel. Everything that used to sit under the
  // faders as four rows of small buttons lives here now, plus the keyboard.
  const [trackMenu, setTrackMenu] = useState<{
    x: number
    y: number
    trackId: string
  } | null>(null)
  const rollInnerRef = useRef<HTMLDivElement | null>(null)
  const rollDragRef = useRef<{
    index: number
    mode: 'move' | 'resize'
    grabPx: number
    x0: number
    y0: number
    moved: boolean
  } | null>(null)
  const suppressRollClickRef = useRef(false)
  const [rollDrag, setRollDrag] = useState<(InstrumentNote & { index: number }) | null>(null)
  /** Box picked with Shift+drag in the editor: steps left..right, pitches low..high. */
  const [rollSel, setRollSel] = useState<{ left: number; right: number; high: number; low: number } | null>(null)
  const rollSelAnchorRef = useRef<{ step: number; pitch: number } | null>(null)
  // Groove tools in the editor: how coarse the quantize grid is, which scale
  // tints the rows of each track, and the velocity bar currently being dragged.
  const [rollQuantum, setRollQuantum] = useState(4)
  const [rollScales, setRollScales] = useState<Record<string, { root: number; mode: string }>>({})
  const [rollVelDrag, setRollVelDrag] = useState<{ index: number; velocity: number } | null>(null)
  // The drum grid edits one column at a time: every hit in a step shares a level.
  const [seqVelDrag, setSeqVelDrag] = useState<{ step: number; velocity: number } | null>(null)
  const [showMidiPanel, setShowMidiPanel] = useState(false)
  const [midiDevices, setMidiDevices] = useState<MidiDeviceInfo[]>([])
  const [midiInputId, setMidiInputId] = useState<string | null>(null)
  const [midiError, setMidiError] = useState<string | null>(null)
  const [midiLed, setMidiLed] = useState(false)
  const midiUnbindRef = useRef<(() => void) | null>(null)
  const midiLedTimerRef = useRef<number | null>(null)
  const midiTakeCountRef = useRef(0)
  const midiPendingRef = useRef<
    Map<string, { trackId: string; pitch: number; step: number; velocity: number }>
  >(new Map())
  // Playing the selected instrument with the computer keyboard, for anyone
  // without a MIDI interface. Off by default so it cannot eat the shortcuts.
  const [pcKeys, setPcKeys] = useState(false)
  const [pcOctave, setPcOctave] = useState(0)
  const [pcHeld, setPcHeld] = useState<number[]>([])
  /** Kit lanes flashing because their key was just hit (one-shots, no note-off). */
  const [pcHeldPieces, setPcHeldPieces] = useState<number[]>([])
  const pcKeysRef = useRef(false)
  const pcOctaveRef = useRef(0)
  const pcHeldRef = useRef<Map<string, number>>(new Map())
  const pcPieceTimersRef = useRef<Map<number, number>>(new Map())
  // The global key handler is mounted once, so it reaches the live closures
  // through these.
  const pcNoteOnRef = useRef<(rawKey: string) => void>(() => {})
  const pcNoteOffRef = useRef<(rawKey: string) => void>(() => {})
  const pcAllNotesOffRef = useRef<() => void>(() => {})
  const nudgeRollRef = useRef<(deltaSteps: number, deltaPitch: number) => boolean>(() => false)
  const shiftPcOctaveRef = useRef<(delta: number) => void>(() => {})
  const pcHintRef = useRef(0)

  useEffect(() => {
    tracksRef.current = tracks
  }, [tracks])

  useEffect(() => {
    arrangementBarsRef.current = arrangementBars
  }, [arrangementBars])

  useEffect(() => {
    playheadRef.current = playheadStep
  }, [playheadStep])

  useEffect(() => {
    metronomeRef.current = metronome
  }, [metronome])

  useEffect(() => {
    loopRef.current = loop
  }, [loop])

  useEffect(() => {
    countInRef.current = countIn
  }, [countIn])

  useEffect(() => {
    isRecordingRef.current = isRecording
  }, [isRecording])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    punchInRef.current = punchIn
  }, [punchIn])

  useEffect(() => {
    timeSelRef.current = timeSel
  }, [timeSel])

  useEffect(() => {
    selectedRef.current = selectedTrackId
  }, [selectedTrackId])

  const bpmRef = useRef(120)
  useEffect(() => {
    bpmRef.current = bpm
  }, [bpm])

  const markersRef = useRef<Marker[]>([])
  useEffect(() => {
    markersRef.current = markers
  }, [markers])

  useEffect(() => {
    groupsRef.current = groups
  }, [groups])

  const notify = (message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3400)
  }

  // The native save/open dialogs report through this toast, so hand the bridge
  // the same notifier the rest of the app uses.
  useEffect(() => {
    setNativeToastHandler((message) => notify(message))
    return () => setNativeToastHandler(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The toast floats in the top-right corner, which is exactly where a window
  // keeps its close button and toolbar. Opening anything dismisses it.
  useEffect(() => {
    if (midiEditorId || fxTrackId || showExport || showMasterFx || showMidiPanel || showVersions || showPlugins) {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      setToast(null)
    }
  }, [midiEditorId, fxTrackId, showExport, showMasterFx, showMidiPanel, showVersions, showPlugins])

  const makeTrack = (
    index: number,
    name?: string,
    kind: 'audio' | 'instrument' = 'audio',
    instrument: InstrumentKind = 'piano',
  ): TrackState => ({
    id: newId(),
    number: index + 1,
    isFolder: false,
    collapsed: false,
    folderId: null,
    groupId: '',
    duckSourceIds: [],
    duckDepth: 0.7,
    name:
      name ??
      (kind === 'instrument'
        ? `${instrumentLabel(instrument)} ${index + 1}`
        : `Track ${index + 1}`),
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 1,
    pan: 0,
    trimDb: 0,
    phaseInvert: false,
    mono: false,
    rvSend: 0,
    dlSend: 0,
    isArmed: false,
    isMuted: false,
    isSoloed: false,
    hasFx: false,
    drive: 35,
    cabinet: 4500,
    inputDeviceId: '',
    callChannelKey: '',
    inputChannel: 0,
    inputWet: false,
    inputMonitor: false,
    plugins: [],
    nativeVst2: null,
    // A new track starts with the four units almost every vocal or instrument
    // pass ends up using, all switched off — nothing is in the signal until the
    // producer turns it on. The rest is one "+ Efeito" away; eleven bypassed
    // cards on every track is how a chain stops being read.
    chain: (['gate', 'eq', 'comp', 'limiter'] as BuiltinFxId[]).map(builtinChainId),
    fxRack: defaultBuiltinFx(),
    clipStart: 0,
    clipDuration: 0,
    fadeIn: 0.005,
    fadeOut: 0.005,
    automation: [],
    clipName: '',
    bufferId: '',
    takes: [],
    kind,
    instrument,
    midiNotes: [],
    // A fresh drum track starts as a one-bar step pattern: that is the whole
    // point of the sequencer, and it can still be switched back to free notes.
    patternSteps: kind === 'instrument' && instrument === 'drums' ? 16 : 0,
    voice: defaultVoice(instrument),
  })

  /** A folder header row: it organizes the list and carries no signal. */
  const makeFolder = (index: number, name: string): TrackState => ({
    ...makeTrack(index, name),
    isFolder: true,
    collapsed: false,
    plugins: [],
    chain: [],
    automation: [],
  })

  const laneRows = useMemo(() => buildLaneRows(tracks), [tracks])

  const visibleFolders = useMemo(
    () => tracks.filter((track) => track.isFolder),
    [tracks],
  )

  const commitTracks = (next: TrackState[]) => {
    tracksRef.current = next
    setTracks(next)
  }

  const commitPlugins = (trackId: string, updater: (prev: PluginState[]) => PluginState[]) => {
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === trackId ? { ...track, plugins: updater(track.plugins) } : track,
      ),
    )
  }

  const commitChain = (trackId: string, updater: (prev: string[]) => string[]) => {
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === trackId ? { ...track, chain: updater(track.chain) } : track,
      ),
    )
  }

  const applyMix = (list: TrackState[]) => {
    // A folder row owns no signal, so it neither solos nor mutes anything; the
    // children stay audible whatever the folder header looks like.
    const anySoloed = list.some((track) => track.isSoloed && !track.isFolder)
    for (const track of list) {
      if (track.isFolder) continue
      const audible = anySoloed ? track.isSoloed && !track.isMuted : !track.isMuted
      engineRef.current?.setMuted(track.id, !audible)
    }
  }

  /**
   * The sidechain is the one routing decision that can name a track the engine
   * has not built yet - a duck usually points at something later in the list. The
   * per-track sync asks anyway (a no-op when the source is missing), and this
   * second pass, run once every track exists, gives the follower the sources it
   * had to wait for.
   */
  const syncSidechainsToEngine = (list: TrackState[]) => {
    const engine = engineRef.current
    if (!engine) return
    for (const track of list) {
      if (track.isFolder || track.duckSourceIds.length === 0) continue
      void engine.setSidechainDuck(track.id, track.duckSourceIds, track.duckDepth).catch(() => {})
    }
  }

  const syncTrackToEngine = (track: TrackState) => {
    const engine = engineRef.current
    if (!engine) return
    if (track.isFolder) {
      // Folders are organization only: keep them out of the graph entirely.
      if (engine.hasTrack(track.id)) engine.removeTrack(track.id)
      return
    }
    // addTrack rebuilds the whole node graph and clears the buffer, so it is
    // only allowed for a track the engine does not have yet. Everything else
    // has a setter and can be re-applied on a live track without losing audio.
    if (engine.hasTrack(track.id)) {
      engine.setVolume(track.id, track.volume)
      engine.setPan(track.id, track.pan)
    } else {
      engine.addTrack(track.id, track.volume, track.pan)
    }
    // The sub-bus and the sidechain are part of the track's routing, so they are
    // re-applied on every sync: a rebuilt graph comes back with no group and no
    // duck otherwise.
    engine.setTrackGroup(track.id, track.groupId)
    void engine
      .setSidechainDuck(track.id, track.duckSourceIds, track.duckDepth)
      .catch(() => {
        /* the strip still shows the request; the toast comes from setSidechain */
      })
    engine.setTrim(track.id, dbToGain(track.trimDb))
    engine.setPhaseInvert(track.id, track.phaseInvert)
    engine.setMono(track.id, track.mono)
    engine.setTrackSend(track.id, 'rv', track.rvSend)
    engine.setTrackSend(track.id, 'dl', track.dlSend)
    engine.setClipStart(track.id, track.clipStart)
    engine.setClipDuration(track.id, track.clipDuration)
    engine.setClipFade(track.id, track.fadeIn, track.fadeOut)
    engine.setAutomation(track.id, track.automation)
    for (const fxId of BUILTIN_FX_IDS) engine.setBuiltinFx(track.id, fxId, track.fxRack[fxId])
    engine.setChainOrder(track.id, track.chain)
    engine.setFxEnabled(track.id, track.hasFx)
    if (track.hasFx) {
      engine.setDrive(track.id, track.drive)
      engine.setCabinet(track.id, track.cabinet)
    }
    engine.setInstrument(
      track.id,
      track.kind === 'instrument' ? track.instrument : null,
      track.kind === 'instrument' ? track.voice : '',
    )
    engine.setNotes(track.id, track.midiNotes, track.patternSteps)
  }

  const stopPlayback = () => {
    if (schedulerIdRef.current !== null) {
      window.clearInterval(schedulerIdRef.current)
      schedulerIdRef.current = null
    }
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    engineRef.current?.stopBuffers()
    isPlayingRef.current = false
    setIsPlaying(false)
    nextStepRef.current = 0
    pendingBufferStartRef.current = null
    // Stopping in the middle of a count-in cancels the take that was waiting for
    // the downbeat; leaving it armed would open a recorder over a stopped song.
    recordGateRef.current = null
    setCountBeat(0)
    // A punch pass that never reached its region is only cancelled; one that
    // is capturing right now is closed, so the take inside the region is kept.
    if (punchBoundsRef.current) {
      if (takeOpenRef.current) void finishTake()
      else {
        punchBoundsRef.current = null
        setIsRecording(false)
        notify('Punch cancelado — a área não chegou a começar')
      }
    }
  }

  // Rehydrate saved samples (IndexedDB) into engine buffers after a reload.
  const restoreSamples = (restored: TrackState[]) => {
    const engine = engineRef.current
    if (!engine) return
    for (const track of restored) {
      const bufferId = track.bufferId
      if (!bufferId) continue
      void (async () => {
        const blob = await loadSample(bufferId)
        if (!blob) throw new Error('sample missing')
        const data = await blob.arrayBuffer()
        const buffer = await engine.ctx.decodeAudioData(data)
        const alive = tracksRef.current.some(
          (item) => item.id === track.id && item.bufferId === bufferId,
        )
        if (!alive) return
        engine.setBuffer(track.id, buffer, bufferId)
        // A trimmed clip must keep its trim: setBuffer resets to the full
        // buffer, so re-apply the stored length right after.
        const stored = tracksRef.current.find((item) => item.id === track.id)
        const duration =
          stored && stored.clipDuration > 0
            ? Math.min(stored.clipDuration, buffer.duration)
            : buffer.duration
        engine.setClipDuration(track.id, duration)
        engine.setClipStart(track.id, track.clipStart)
        engine.setClipFade(track.id, track.fadeIn, track.fadeOut)
        const ratio = Math.min(1, duration / Math.max(buffer.duration, 0.0001))
        setPeaks((prev) => ({ ...prev, [track.id]: computePeaks(buffer).slice(0, Math.max(1, Math.round(260 * ratio))) }))
        commitTracks(
          tracksRef.current.map((item) =>
            item.id === track.id ? { ...item, clipDuration: duration } : item,
          ),
        )
      })().catch(() => {
        // The sample was pruned or cannot be decoded: drop the stale clip.
        commitTracks(
          tracksRef.current.map((item) =>
            item.id === track.id && item.bufferId === bufferId
              ? { ...item, clipStart: 0, clipDuration: 0, clipName: '', bufferId: '' }
              : item,
          ),
        )
      })
    }
  }

  /**
   * The plugin descriptor is only half of the plugin; its bytes live in
   * IndexedDB under `assetId`. This puts the other half back: the file is
   * rebuilt, handed to the engine with the id the saved chain already names, and
   * the chain is re-applied so an IR still sits behind the amp it was attached
   * to. A NAM that comes back with the project is the whole point — the
   * producer should never have to pick the same files again.
   */
  const restorePlugins = (restored: TrackState[]) => {
    const engine = engineRef.current
    if (!engine) return
    for (const track of restored) {
      if (track.isFolder || track.plugins.length === 0) continue
      const wanted = [...track.plugins]
      void (async () => {
        const gone: string[] = []
        for (const plugin of wanted) {
          // The project may have moved on while this loop was decoding: a track
          // that no longer lists this plugin, or lists it with other bytes, is a
          // restore nobody asked for anymore.
          const live = tracksRef.current
            .find((item) => item.id === track.id)
            ?.plugins.find((item) => item.id === plugin.id)
          if (!live || live.assetId !== plugin.assetId) continue
          if (engine.hasPlugin(track.id, plugin.id)) continue
          const restore: PluginRestoreInfo = {
            id: plugin.id,
            enabled: plugin.enabled,
            params: plugin.params,
          }
          try {
            if (!plugin.assetId) throw new Error('sem arquivo')
            const blob = await loadSample(plugin.assetId)
            if (!blob) throw new Error('arquivo ausente')
            if (plugin.kind === 'ir') {
              const buffer = await engine.ctx.decodeAudioData(await blob.arrayBuffer())
              engine.addIrPlugin(track.id, buffer, plugin.name, restore)
            } else if (plugin.kind === 'nam') {
              await engine.addNamPlugin(
                track.id,
                new File([blob], `${plugin.name}.nam`, { type: 'application/json' }),
                restore,
              )
            } else {
              await engine.addWorkletPlugin(
                track.id,
                new File([blob], `${plugin.name}.js`, { type: 'text/javascript' }),
                restore,
              )
            }
          } catch {
            // The bytes really are not here (cleared profile, project from
            // another machine). Keeping a card that no audio passes through
            // would be worse than admitting the file has to be picked again.
            gone.push(plugin.name)
            engine.removePlugin(track.id, plugin.id)
            commitPlugins(track.id, (prev) => prev.filter((item) => item.id !== plugin.id))
            commitChain(track.id, (prev) => prev.filter((entry) => entry !== plugin.id))
          }
        }
        // Restored plugins are inserted wherever the engine likes; the saved
        // chain is the producer's routing, so it wins on the way out.
        const track2 = tracksRef.current.find((item) => item.id === track.id)
        if (track2) engine.setChainOrder(track.id, track2.chain)
        if (gone.length > 0) {
          notify(`Sem arquivo salvo: ${gone.join(', ')} — carregue de novo`)
        }
      })().catch(() => {
        /* a broken track must not stop the others from returning */
      })
    }
  }

  const applyProject = (project: SavedProject) => {
    const engine = engineRef.current
    if (!engine) return
    // Whatever is on screen is about to be replaced - by a file, a saved
    // project, or a fresh session - so keep it before it is gone.
    recordVersionRef.current('antes de trocar de projeto', true)
    // The loudness window belongs to the mix that was just playing. Carrying its
    // three second memory into a new project would print an old number as if it
    // were a new one.
    engine.resetLoudnessMeter()
    setMasterLoudness(null)

    for (const track of tracksRef.current) engine.removeTrack(track.id)
    // Buses have to exist before their members are wired: the engine drops a
    // track that asks for a group it has never heard of.
    for (const id of engine.listGroups()) engine.removeGroup(id)
    const nextGroups = (project.groups ?? []).map((group) => ({ ...group }))
    commitGroups(nextGroups)
    for (const group of nextGroups) syncGroupToEngine(group)

    const nextTracks = project.tracks.map((track, index) => ({
      ...track,
      number: index + 1,
      // The patch comes back with the project; the stream does not, because the
      // browser only names its devices after a permission that has to be given
      // again. `reconnectSavedInputs` reopens what it can and reports the rest.
      inputMonitor: false,
    }))
    for (const track of nextTracks) syncTrackToEngine(track)
    syncSidechainsToEngine(nextTracks)

    commitTracks(nextTracks)
    applyMix(nextTracks)

    setBpm(project.bpm)
    setArrangementBars(project.arrangementBars)
    arrangementBarsRef.current = project.arrangementBars
    setMasterVolume(project.masterVolume)
    setMasterMuted(project.masterMuted)
    engine.setMasterVolume(project.masterVolume)
    engine.setMasterMuted(project.masterMuted)
    setMetronome(false)
    setLoop(project.loop)
    setCountIn(project.countIn)
    setMarkers(project.markers || [])
    setMasterFx(project.masterFx)
    setSendConfig(project.sends)
    engine.applyMasterFxPreset(project.masterFx)
    engine.setSendConfig(project.sends)
    setRecordLatencyMs(project.recordLatencyMs)
    setSnapEnabled(project.snapEnabled)
    setZoomBars(project.zoomBars)
    setPeaks({})
    setSelectedTrackId(nextTracks[0]?.id ?? null)
    stopPlayback()
    restoreSamples(nextTracks)
    restorePlugins(nextTracks)
    // Loading a project is a new starting point: the previous session's
    // undo steps no longer describe this arrangement.
    resetHistory(project)
  }

  const currentProject = (): SavedProject => ({
    version: 5,
    bpm,
    masterVolume,
    masterMuted,
    metronome: false,
    loop,
    countIn,
    arrangementBars,
    recordLatencyMs,
    snapEnabled,
    zoomBars,
    masterFx,
    sends: sendConfig,
    tracks,
    groups,
    markers,
  })

  // ---------------------------------------------------------------- versions

  /**
   * Write the project as it stands into the rolling history.
   *
   * A snapshot is only worth a slot when the arrangement actually changed and a
   * minute has passed since the last one: otherwise the eight places fill with
   * the same take, one keystroke at a time, and the work that mattered gets
   * pushed out. `force` is for the moments a person asked for - a manual save,
   * or the state just before a restore - and still cannot store a duplicate,
   * because the list drops any entry whose project is identical.
   */
  const recordVersion = (label: string, force = false) => {
    const json = JSON.stringify(currentProject())
    const now = Date.now()
    const history = versionsRef.current
    if (!force && !shouldRecord(history[0], json, now)) return
    // Forced means "do not wait a minute", not "store this twice": the newest
    // entry already is this project, so there is nothing new to keep.
    if (force && history[0]?.json === json) return
    const entry: StoredVersion = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      savedAt: now,
      label,
      json,
    }
    // Budgeted: the live project, the undo stack and the samples all need room
    // in localStorage, and a full store throws on every write.
    const { kept } = trimToFit(addVersion(history, entry), VERSIONS_BUDGET)
    versionsRef.current = kept
    setVersions(kept)
    try {
      window.localStorage.setItem(VERSIONS_KEY, JSON.stringify(kept))
    } catch {
      // No room even trimmed. Say so by keeping nothing rather than letting the
      // window list versions that are not on disk.
      versionsRef.current = []
      setVersions([])
      try {
        window.localStorage.removeItem(VERSIONS_KEY)
      } catch {
        /* there was nothing to remove */
      }
    }
  }

  // Called from effects whose dependency lists are deliberately about audio
  // state; a ref keeps this out of them.
  const recordVersionRef = useRef(recordVersion)
  recordVersionRef.current = recordVersion

  const forgetVersion = (id: string) => {
    const kept = removeVersion(versionsRef.current, id)
    versionsRef.current = kept
    setVersions(kept)
    try {
      if (kept.length === 0) window.localStorage.removeItem(VERSIONS_KEY)
      else window.localStorage.setItem(VERSIONS_KEY, JSON.stringify(kept))
    } catch {
      /* the list on screen is what this session will write next */
    }
  }

  /**
   * Put a snapshot back. What is on screen first becomes the newest version, so
   * restoring is never a one-way door. Audio samples live in IndexedDB apart
   * from the project: if one was reclaimed, that lane comes back without its
   * clip and says so in the inspector.
   */
  const restoreVersion = (id: string) => {
    const entry = findVersion(versionsRef.current, id)
    if (!entry) return
    let project: SavedProject
    try {
      project = sanitizeProject(JSON.parse(entry.json) as Partial<SavedProject>)
    } catch {
      notify('Essa versão não pôde ser lida')
      return
    }
    recordVersion('antes de restaurar', true)
    applyProject(project)
    setShowVersions(false)
    notify(`Projeto restaurado — versão das ${formatClock(entry.savedAt)} (${entry.label})`)
  }

  const openVersions = () => {
    // Read fresh: another tab may have written since this one opened.
    const history = parseVersions(window.localStorage.getItem(VERSIONS_KEY))
    versionsRef.current = history
    setVersions(history)
    setVersionsNow(Date.now())
    setShowVersions(true)
  }

  // Parsed once per list change, not per frame: a snapshot is the whole project
  // and the meters re-render the app many times a second.
  const versionRows = useMemo(
    () =>
      versions.map((entry) => {
        let trackCount = 0
        let content = 0
        try {
          const parsed = JSON.parse(entry.json) as {
            tracks?: Array<{ bufferId?: string; midiNotes?: unknown[]; takes?: unknown[] }>
          }
          const list = parsed.tracks ?? []
          trackCount = list.length
          content = list.filter(
            (track) =>
              Boolean(track.bufferId) ||
              (track.midiNotes?.length ?? 0) > 0 ||
              (track.takes?.length ?? 0) > 0,
          ).length
        } catch {
          // Unreadable: the row still shows when it was taken, and restoring it
          // is what reports the problem.
        }
        return { entry, trackCount, content }
      }),
    [versions],
  )

  // ------------------------------------------------------------ history stack
  const undoStackRef = useRef<SavedProject[]>([])
  const redoStackRef = useRef<SavedProject[]>([])
  const lastStateRef = useRef<SavedProject | null>(null)
  const lastPushRef = useRef<{ time: number; sig: string }>({ time: 0, sig: '' })
  // Undo/redo and project reload commit several states in a row; the stack
  // stays quiet for a moment so those follow-up writes do not become steps.
  const historyMuteUntilRef = useRef(0)
  const orphanSamplesRef = useRef<Set<string>>(new Set())
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 })

  /**
   * Samples are not deleted when a clip goes away: an undo step may still
   * point at them. They are only reclaimed once no snapshot references them.
   */
  const pruneSamples = () => {
    if (orphanSamplesRef.current.size === 0) return
    const stillUsed = new Set<string>()
    const remember = (track: {
      bufferId?: string
      takes?: AudioTake[]
      plugins?: Array<{ assetId?: string }>
    }) => {
      if (track.bufferId) stillUsed.add(track.bufferId)
      // A take on the shelf is a WAV the user can put back at any moment.
      for (const take of track.takes ?? []) if (take.id) stillUsed.add(take.id)
      // The same holds for an amp or cabinet the rack can bring back: the undo
      // step that dropped it still names its bytes.
      for (const plugin of track.plugins ?? []) if (plugin.assetId) stillUsed.add(plugin.assetId)
    }
    for (const project of [...undoStackRef.current, ...redoStackRef.current]) {
      for (const track of project.tracks) remember(track)
    }
    for (const track of tracksRef.current) remember(track)
    for (const id of [...orphanSamplesRef.current]) {
      if (stillUsed.has(id)) continue
      orphanSamplesRef.current.delete(id)
      void deleteSample(id)
    }
  }

  const reclaimSample = (id: string) => {
    if (!id) return
    orphanSamplesRef.current.add(id)
    pruneSamples()
  }

  const resetHistory = (baseline?: SavedProject) => {
    undoStackRef.current = []
    redoStackRef.current = []
    lastPushRef.current = { time: 0, sig: '' }
    lastStateRef.current = baseline ? cloneProject(baseline) : null
    historyMuteUntilRef.current = Date.now() + 1200
    setHistoryDepth({ undo: 0, redo: 0 })
  }

  // Every tracked change becomes one undo step, with continuous edits
  // (drags, knob turns) folded together.
  useEffect(() => {
    if (!initializedRef.current) return
    const now = currentProject()
    if (!lastStateRef.current) {
      lastStateRef.current = cloneProject(now)
      return
    }
    if (Date.now() < historyMuteUntilRef.current) {
      lastStateRef.current = cloneProject(now)
      return
    }
    const before = lastStateRef.current
    const sig = projectSignature(before, now)
    if (!sig) return
    const time = Date.now()
    if (sig === lastPushRef.current.sig && time - lastPushRef.current.time < 900) {
      lastPushRef.current = { time, sig }
      return
    }
    undoStackRef.current = [...undoStackRef.current.slice(-59), before]
    redoStackRef.current = []
    lastPushRef.current = { time, sig }
    lastStateRef.current = cloneProject(now)
    setHistoryDepth({ undo: undoStackRef.current.length, redo: 0 })
    pruneSamples()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tracks,
    bpm,
    masterVolume,
    masterMuted,
    loop,
    countIn,
    arrangementBars,
    markers,
    masterFx,
    sendConfig,
    // The last three never produce a step on their own (they are outside
    // projectSignature), but running the watcher keeps the baseline snapshot
    // fresh so a later step does not carry a stale view state.
    recordLatencyMs,
    snapEnabled,
    zoomBars,
  ])

  /**
   * Undo and redo restore the whole routing decision, plugins included: the
   * snapshot names the amps and cabinets the producer had at that moment, so a
   * step back can put a removed NAM in the rack again and a step forward can take
   * it out. Input devices are the one part history cannot restore — they are
   * hardware names of this session, not part of the mix.
   */
  const applySnapshot = (snapshot: SavedProject) => {
    const engine = engineRef.current
    if (!engine) return
    historyMuteUntilRef.current = Date.now() + 1200

    const live = tracksRef.current
    for (const track of live) {
      if (!snapshot.tracks.some((item) => item.id === track.id)) engine.removeTrack(track.id)
    }

    // Buses first, then the tracks that point at them, so a restored project
    // re-creates the routing in the order the engine accepts it.
    for (const group of groupsRef.current) {
      if (!snapshot.groups.some((item) => item.id === group.id)) engine.removeGroup(group.id)
    }
    commitGroups(snapshot.groups.map((group) => ({ ...group })))
    for (const group of snapshot.groups) syncGroupToEngine(group)

    const next = snapshot.tracks.map((track, index) => {
      const existing = live.find((item) => item.id === track.id)
      const base: TrackState = {
        ...track,
        number: index + 1,
        // Um undo nunca "religa" um retorno: a linha volta com o áudio que ela já
        // tem, mas a chave do canal fica de fora — quem patcheia o stream é o cabo,
        // e ele continua dono do que está ligado.
        callChannelKey: '',
        inputDeviceId: existing?.inputDeviceId ?? '',
        inputChannel: existing?.inputChannel ?? 0,
        inputWet: existing?.inputWet ?? false,
        inputMonitor: existing?.inputMonitor ?? false,
      }
      // A plugin the snapshot left out no longer belongs to the path. Its bytes
      // stay in the store until no undo step can name it (pruneSamples), so the
      // step that removes it can itself be undone.
      if (existing) {
        const wanted = new Set(track.plugins.map((plugin) => plugin.id))
        for (const plugin of existing.plugins) {
          if (wanted.has(plugin.id)) continue
          engine.removePlugin(existing.id, plugin.id)
          reclaimSample(plugin.assetId ?? '')
        }
      }
      syncTrackToEngine(base)
      return base
    })
    syncSidechainsToEngine(next)

    commitTracks(next)
    applyMix(next)

    setBpm(snapshot.bpm)
    setArrangementBars(snapshot.arrangementBars)
    arrangementBarsRef.current = snapshot.arrangementBars
    setMasterVolume(snapshot.masterVolume)
    setMasterMuted(snapshot.masterMuted)
    engine.setMasterVolume(snapshot.masterVolume)
    engine.setMasterMuted(snapshot.masterMuted)
    setLoop(snapshot.loop)
    setCountIn(snapshot.countIn)
    setMarkers(snapshot.markers)
    setMasterFx(snapshot.masterFx)
    setSendConfig(snapshot.sends)
    engine.applyMasterFxPreset(snapshot.masterFx)
    engine.setSendConfig(snapshot.sends)
    // Zoom, snap and latency are intentionally left alone — see projectSignature.
    if (!next.some((track) => track.id === selectedRef.current)) {
      setSelectedTrackId(next[0]?.id ?? null)
    }

    // Only rehydrate buffers the engine does not already hold.
    const needSamples: TrackState[] = []
    for (const track of next) {
      if (track.bufferId) {
        if (engine.getBufferLabel(track.id) !== track.bufferId) needSamples.push(track)
      } else if (engine.hasBuffer(track.id)) {
        engine.setBuffer(track.id, null)
        setPeaks((prev) => {
          const copy = { ...prev }
          delete copy[track.id]
          return copy
        })
      }
    }
    if (needSamples.length > 0) restoreSamples(needSamples)
    restorePlugins(next)
    pruneSamples()
  }

  const undo = () => {
    const previous = undoStackRef.current[undoStackRef.current.length - 1]
    if (!previous) {
      notify('Nada para desfazer')
      return
    }
    undoStackRef.current = undoStackRef.current.slice(0, -1)
    const current = lastStateRef.current ?? currentProject()
    redoStackRef.current = [...redoStackRef.current.slice(-59), current]
    lastStateRef.current = cloneProject(previous)
    applySnapshot(previous)
    setHistoryDepth({ undo: undoStackRef.current.length, redo: redoStackRef.current.length })
    notify('Desfeito')
  }

  const redo = () => {
    const upcoming = redoStackRef.current[redoStackRef.current.length - 1]
    if (!upcoming) {
      notify('Nada para refazer')
      return
    }
    redoStackRef.current = redoStackRef.current.slice(0, -1)
    const current = lastStateRef.current ?? currentProject()
    undoStackRef.current = [...undoStackRef.current.slice(-59), current]
    lastStateRef.current = cloneProject(upcoming)
    applySnapshot(upcoming)
    setHistoryDepth({ undo: undoStackRef.current.length, redo: redoStackRef.current.length })
    notify('Refeito')
  }

  // Bootstrap the audio engine once, restoring the last session if available.
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const engine = new AudioEngine()
    engineRef.current = engine
    setAutoLatencyMs(engine.latencyMs())
    // Populate the IN dropdown quietly so it isn't empty until the user presses
    // a button. Labels only exist once permission was granted, so unnamed
    // entries are expected here and are labelled honestly as such.
    void engine
      .listInputsQuietly()
      .then((devices) => {
        if (devices.length > 0) setInputs(devices)
      })
      .catch(() => {
        /* no enumeration support: Devices ▸ Detectar entradas still works */
      })
    // The capture tap reports peaks as the take runs; keep only the newest
    // frame so a fast machine doesn't re-render the lane 8 times a second.
    engine.onTakeProgress = (trackId, peaks, seconds) => {
      setTakeProgress((prev) => ({ ...prev, [trackId]: { peaks, seconds } }))
    }
    // The LUFS / true-peak meter lives on the audio thread and hands its
    // readings over here, ten times a second, instead of being polled by the
    // animation loop: a window that was closed properly is worth showing even in
    // a tab that stopped drawing. Attaching it is not urgent, and a browser that
    // refuses the worklet only loses the readout, so the failure stays quiet
    // rather than turning into a toast.
    engine.onLoudness = (reading) => setMasterLoudness(reading)
    void engine.enableLoudnessMeter().catch(() => {})

    const stored = loadStored()
    // The history is its own key, so a project write can never clobber it.
    const history = parseVersions(window.localStorage.getItem(VERSIONS_KEY))
    versionsRef.current = history
    setVersions(history)
    let initialTracks: TrackState[]
    if (stored) {
      initialTracks = stored.tracks.map((track, index) => ({ ...track, number: index + 1 }))
      const initialGroups = (stored.groups ?? []).map((group) => ({ ...group }))
      commitGroups(initialGroups)
      for (const group of initialGroups) syncGroupToEngine(group)
      for (const track of initialTracks) syncTrackToEngine(track)
      syncSidechainsToEngine(initialTracks)
      engine.setMasterVolume(stored.masterVolume)
      engine.setMasterMuted(stored.masterMuted)
      applyMix(initialTracks)
      setBpm(stored.bpm)
      setMasterVolume(stored.masterVolume)
      setMasterMuted(stored.masterMuted)
      setMetronome(false)
      setLoop(stored.loop)
      setCountIn(stored.countIn)
      setArrangementBars(stored.arrangementBars)
      arrangementBarsRef.current = stored.arrangementBars
      setMarkers(stored.markers || [])
      setMasterFx(stored.masterFx)
      setSendConfig(stored.sends)
      setRecordLatencyMs(stored.recordLatencyMs)
      setSnapEnabled(stored.snapEnabled)
      setZoomBars(stored.zoomBars)
      engine.applyMasterFxPreset(stored.masterFx)
      engine.setSendConfig(stored.sends)
    } else {
      initialTracks = [makeTrack(0, 'Audio 1 (GTR)'), makeTrack(1, 'Audio 2 (VOX)')]
      for (const track of initialTracks) syncTrackToEngine(track)
    }

    commitTracks(initialTracks)
    setSelectedTrackId(initialTracks[0]?.id ?? null)
    resetHistory(stored ?? undefined)
    if (stored) {
      restoreSamples(initialTracks)
      restorePlugins(initialTracks)
      // The saved patching only becomes real audio once the browser will name the
      // hardware again; the same moment is when this machine's stored output
      // device can be re-aimed at.
      void reconnectSavedInputs()
      void restoreStoredOutput()
      window.setTimeout(() => setToast('Sessão anterior restaurada automaticamente'), 400)
    }
  }, [])

  // The timeline context menu closes on click-away or Escape.
  useEffect(() => {
    if (!clipMenu && !selMenu && !trackMenu) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setClipMenu(null)
        setSelMenu(null)
        setTrackMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clipMenu, selMenu, trackMenu])

  // Escape closes whatever modal is on top, in the order they stack.
  const closeTopModalRef = useRef<() => void>(() => {})
  closeTopModalRef.current = () => {
    if (trackMenu) setTrackMenu(null)
    else if (selMenu) setSelMenu(null)
    else if (showPlugins) setShowPlugins(false)
    else if (showMarkerInput) setShowMarkerInput(null)
    else if (editingMarkerId) setEditingMarkerId(null)
    else if (fxTrackId) setFxTrackId(null)
    else if (showExport) setShowExport(false)
    else if (showVersions) setShowVersions(false)
    else if (showMasterFx) setShowMasterFx(false)
    // Fecha a janela, não o cabo: a chamada continua no ar com o ESC.
    else if (showSala) setShowSala(false)
    else if (midiEditorId && rollSel) setRollSel(null)
    else if (midiEditorId) setMidiEditorId(null)
    else if (showMidiPanel) setShowMidiPanel(false)
    else if (timeSel) setTimeSel(null)
  }

  // Keep the selection valid.
  useEffect(() => {
    if (selectedTrackId && tracks.some((track) => track.id === selectedTrackId)) return
    setSelectedTrackId(tracks[0]?.id ?? null)
  }, [tracks, selectedTrackId])

  // Autosave the project (audio clips live in IndexedDB; devices and external
  // plugin files stay session-only). The same write also drops a copy in the
  // rolling history, which is what makes an overwrite recoverable.
  useEffect(() => {
    if (!initializedRef.current) return
    const id = window.setTimeout(() => {
      try {
        const json = JSON.stringify(currentProject())
        window.localStorage.setItem(STORAGE_KEY, json)
        recordVersionRef.current('autosave')
      } catch {
        /* storage full or unavailable */
      }
    }, 700)
    return () => window.clearTimeout(id)
  }, [
    tracks,
    bpm,
    masterVolume,
    masterMuted,
    metronome,
    loop,
    countIn,
    arrangementBars,
    markers,
    masterFx,
    sendConfig,
    // SavedProject carries these too, so a change to any of them has to reach
    // localStorage even when nothing else moved.
    recordLatencyMs,
    snapEnabled,
    zoomBars,
  ])

  // VU meters.
  useEffect(() => {
    let frameId = 0
    let frame = 0
    const tick = () => {
      frame += 1
      if (frame % 3 === 0) {
        const engine = engineRef.current
        if (engine) {
          const next: Record<string, number> = {}
          for (const track of tracksRef.current) {
            next[track.id] = engine.getLevel(track.id)
          }
          // Group strips get a meter from the same place their audio goes.
          for (const group of groupsRef.current) {
            next[group.id] = engine.getGroupLevel(group.id)
          }
          next.master = engine.getMasterLevel()
          // Positive dB of gain reduction the master comp + limiter are doing.
          next.masterGr = Math.abs(engine.getMasterReduction())
          setLevels(next)
        }
      }
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [])

  // Lookahead scheduler: keeps the song running bar after bar with stable
  // timing, repeating the 16-step patterns across the arrangement.
  useEffect(() => {
    if (!isPlaying) return
    const engine = engineRef.current
    if (!engine) return
    const stepDuration = 60 / bpm / 4

    const schedule = () => {
      const totalSteps = Math.max(1, arrangementBarsRef.current * STEP_COUNT)
      while (nextTimeRef.current < engine.ctx.currentTime + 0.12) {
        const absoluteStep = nextStepRef.current
        const step = absoluteStep % STEP_COUNT
        const time = nextTimeRef.current
        const pending = pendingBufferStartRef.current
        // The count-in bar is the run of steps that ends on the step the song
        // restarts on, whether that step is negative (a count aimed at the top of
        // the arrangement) or in the middle of it. Held to the pending step rather
        // than to zero, a count that starts at bar 3 still counts four beats — and
        // still keeps the song's own instruments out of the pre-roll.
        const counting = isCountingIn(absoluteStep, pending)

        if (counting && pending !== null) {
          const click = countInClick(absoluteStep, pending)
          if (click) engine.playClick(click === 'accent', time)
        } else if (absoluteStep >= 0 || pending === null) {
          if (pending !== null) {
            pendingBufferStartRef.current = null
            engine.startBuffersAt(time, stepDuration, absoluteStep)
            // The count-in bar is over: a take that was waiting for the downbeat
            // opens now, on the same audio clock the clicks were played from, and
            // is anchored to this step rather than to the clock's reading a few
            // milliseconds later.
            const gate = recordGateRef.current
            if (gate) {
              recordGateRef.current = null
              gate(absoluteStep)
            }
          }
          if (metronomeRef.current && step % 4 === 0) {
            engine.playClick(step === 0, time)
          }

          // Instrument tracks turn each grid step into synth voices. The
          // voices flow through the track chain, so piano and drums can be
          // re-amped through NAMs and FX just like a guitar.
          for (const track of tracksRef.current) {
            if (track.kind !== 'instrument' || track.midiNotes.length === 0) continue
            for (const note of track.midiNotes) {
              // Inside a loop the pattern is locked to bar 1, so the groove
              // keeps its phase however the transport was started.
              if (hitAtStep(note.step, absoluteStep, track.patternSteps)) {
                engine.playNote(
                  track.id,
                  track.instrument,
                  note.pitch,
                  note.velocity,
                  time,
                  note.length * stepDuration,
                )
              }
            }
          }
        }

        nextStepRef.current = absoluteStep + 1
        nextTimeRef.current = time + stepDuration

        // While recording the arrangement grows instead of wrapping, so a take
        // is never cut or split by the loop.
        if (isRecordingRef.current) continue
        if (nextStepRef.current < totalSteps) continue

        if (loopRef.current) {
          nextStepRef.current = 0
          // Stop the previous pass first so a clip longer than the arrangement
          // cannot overlap the next loop iteration. The lanes keep their state:
          // this stop is only the other half of an immediate restart.
          engine.stopBuffers(true)
          engine.startBuffersAt(nextTimeRef.current, stepDuration, 0)
        } else {
          const stopDelay = (nextTimeRef.current - engine.ctx.currentTime) * 1000
          nextStepRef.current = 0
          if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
          stopTimerRef.current = window.setTimeout(() => {
            stopTimerRef.current = null
            setIsPlaying(false)
          }, Math.max(0, stopDelay))
          break
        }
      }

      // Punch-in is opened and closed here rather than in the playhead loop:
      // this scheduler runs on a timer, so the capture window follows the
      // audio clock even when the browser stops painting.
      punchGateRef.current()
    }

    if (schedulerIdRef.current !== null) window.clearInterval(schedulerIdRef.current)
    schedule()
    schedulerIdRef.current = window.setInterval(schedule, 25)
    return () => {
      if (schedulerIdRef.current !== null) {
        window.clearInterval(schedulerIdRef.current)
        schedulerIdRef.current = null
      }
    }
  }, [isPlaying, bpm])

  // Playhead follows the audio clock (not the UI timer) so it stays in sync.
  useEffect(() => {
    if (!isPlaying) return
    const engine = engineRef.current
    if (!engine) return
    const stepDuration = 60 / bpm / 4
    let frame = 0
    const tick = () => {
      const elapsed = (engine.ctx.currentTime - songStartRef.current) / stepDuration
      let position = elapsed

      if (pendingBufferStartRef.current !== null) {
        // Count-in bar: keep the clock parked at the start step so it does not
        // wrap around to the end of the arrangement while the clicks play. The
        // number shown is how many beats are left before the song — a producer
        // with headphones on and eyes on the instrument cannot read the ruler.
        setCountBeat(countInBeat(pendingBufferStartRef.current - elapsed))
        frame = window.requestAnimationFrame(tick)
        return
      }
      setCountBeat(0)
      if (isRecordingRef.current) {
        // Extend the arrangement live so the playhead never leaves the screen.
        const needed = Math.ceil((position + 1) / STEP_COUNT)
        if (needed > arrangementBarsRef.current && needed <= 128) {
          arrangementBarsRef.current = needed
          setArrangementBars(needed)
        }
      } else if (loopRef.current) {
        const totalSteps = Math.max(1, arrangementBarsRef.current * STEP_COUNT)
        position = ((position % totalSteps) + totalSteps) % totalSteps
      }

      const totalSteps = Math.max(1, arrangementBarsRef.current * STEP_COUNT)
      setPlayheadStep(Math.max(0, Math.min(totalSteps, position)))
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [isPlaying, bpm])

  const addTrack = () => {
    const track = makeTrack(tracksRef.current.length)
    syncTrackToEngine(track)
    const next = [...tracksRef.current, track]
    commitTracks(next.map((item, index) => ({ ...item, number: index + 1 })))
    setSelectedTrackId(track.id)
    notify(`Track "${track.name}" criada`)
  }

  const addInstrumentTrack = (instrument: InstrumentKind) => {
    const track = makeTrack(tracksRef.current.length, undefined, 'instrument', instrument)
    syncTrackToEngine(track)
    const next = [...tracksRef.current, track]
    commitTracks(next.map((item, index) => ({ ...item, number: index + 1 })))
    setSelectedTrackId(track.id)
    setMidiEditorId(track.id)
    notify(
      instrument === 'drums'
        ? 'Track de bateria criada — monte o pattern no sequencer'
        : instrument === 'bass'
          ? 'Track de baixo criada — desenhe as notas no piano roll ou toque no teclado'
          : 'Track de piano criada — desenhe notas no piano roll ou toque no teclado',
    )
  }

  const removeTrack = (id: string) => {
    const target = tracksRef.current.find((track) => track.id === id)
    if (target?.bufferId) reclaimSample(target.bufferId)
    if (target?.callChannelKey) {
      // Uma faixa de chamada é dona de dois plugs: o stream que ela imprime e o
      // retorno que ela escuta. Apagar a faixa sem soltar os dois deixaria a sala
      // falando com uma linha que não existe mais na tela.
      engineRef.current?.disconnectInput(id)
      engineRef.current?.disconnectCallReturn(target.callChannelKey)
    }
    engineRef.current?.removeTrack(id)
    // The engine drops the dead source from every duck that was listening to it
    // and keeps the remaining ones wired; the saved state has to say the same.
    const next = tracksRef.current
      .filter((track) => track.id !== id)
      .map((track, index) => ({
        ...track,
        number: index + 1,
        duckSourceIds: track.duckSourceIds.filter((sourceId) => sourceId !== id),
      }))
    commitTracks(next)
    setPeaks((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    if (fxTrackId === id) setFxTrackId(null)
    if (selectedRef.current === id) setSelectedTrackId(next[0]?.id ?? null)
    notify(target ? `Track "${target.name}" removida` : 'Track removida')
  }

  const duplicateTrack = (id: string) => {
    const source = tracksRef.current.find((track) => track.id === id)
    if (!source) return
    const copy: TrackState = {
      ...source,
      id: newId(),
      number: tracksRef.current.length + 1,
      name: `${source.name} copy`,
      isArmed: false,
      isMuted: false,
      isSoloed: false,
      inputDeviceId: '',
      // A copy of a call lane is an empty lane: the stream belongs to the one
      // channel the cable patched, and a duplicate cannot claim it twice.
      callChannelKey: '',
      inputChannel: 0,
      inputWet: false,
      inputMonitor: false,
      plugins: [],
      chain: source.chain.filter((entry) => entry.startsWith('fx:')),
      // The duplicated lane starts empty: its clone would share the sample id
      // and have no buffer in the engine until a reload.
      clipStart: 0,
      clipDuration: 0,
      clipName: '',
      bufferId: '',
    }
    syncTrackToEngine(copy)
    const next = [...tracksRef.current, copy]
    commitTracks(next.map((item, index) => ({ ...item, number: index + 1 })))
    setSelectedTrackId(copy.id)
    notify(`Track "${source.name}" duplicada`)
  }

  /**
   * A faixa de um participante da sala.
   *
   * Ela é uma faixa de áudio comum — fader, pan, FX, gravação — com uma diferença
   * de origem: o stream vem do WebRTC, não de um dispositivo, e por isso ela carrega
   * `callChannelKey` em vez de `inputDeviceId`. Isso é o que a impede de ser tratada
   * como hardware num reload (o `getUserMedia` nunca seria chamado com sucesso para
   * ela) e o que dá ao botão IN dela um caminho de escuta que não volta pelo cabo.
   */
  const createCallLane = (label: string, key: string): string => {
    const engine = engineRef.current
    if (!engine) throw new Error('a engine de áudio ainda não existe')
    // Um canal que reaparece (reconexão do mesmo peer) reusa a faixa que já existe,
    // senão cada queda de rede deixaria uma faixa órfã na lista.
    const existing = tracksRef.current.find((track) => track.callChannelKey === key)
    if (existing) return existing.id
    const track: TrackState = {
      ...makeTrack(tracksRef.current.length, label),
      callChannelKey: key,
      // inputMonitor em uma faixa de chamada significa "escuto este canal pelo
      // retorno", não "abro a entrada na mixagem" — por isso começa ligado.
      inputMonitor: true,
    }
    syncTrackToEngine(track)
    const next = [...tracksRef.current, track]
    commitTracks(next.map((item, index) => ({ ...item, number: index + 1 })))
    return track.id
  }

  /** Devolve a faixa que o cabo criou. Um id que já sumiu (undo, projeto trocado) não é erro. */
  const removeCallLane = (trackId: string) => {
    const exists = tracksRef.current.some((track) => track.id === trackId)
    if (!exists) return
    removeTrack(trackId)
  }

  const moveTrack = (id: string, direction: -1 | 1) => {
    const list = tracksRef.current
    const index = list.findIndex((track) => track.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= list.length) return
    const next = [...list]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    commitTracks(next.map((track, position) => ({ ...track, number: position + 1 })))
  }

  // Drag-and-drop reordering: move the dragged track to the target slot.
  // ------------------------------------------------------------- track folders

  const addFolder = () => {
    const list = tracksRef.current
    const name = `Pasta ${list.filter((track) => track.isFolder).length + 1}`
    const folder = makeFolder(list.length, name)
    const next = [...list, folder]
    commitTracks(next.map((item, index) => ({ ...item, number: index + 1 })))
    setSelectedTrackId(folder.id)
    notify(`"${name}" criada — agrupe tracks nela pelo menu de contexto (botão direito)`)
  }

  const toggleFolder = (id: string) => {
    const next = tracksRef.current.map((track) =>
      track.id === id ? { ...track, collapsed: !track.collapsed } : track,
    )
    commitTracks(next)
  }

  /**
   * Put a row inside `folderId` (null takes it back to the top level) and move
   * it next to the folder header so the list reads in the order it plays.
   */
  const assignFolder = (trackId: string, folderId: string | null) => {
    const list = tracksRef.current
    const from = list.findIndex((track) => track.id === trackId)
    if (from < 0) return
    const item = list[from]
    if (item.isFolder && folderId) {
      notify('Pasta dentro de pasta ainda não é suportada')
      return
    }
    if (item.folderId === folderId && !folderId) return
    const rest = list.filter((track) => track.id !== trackId)
    let next = rest
    if (folderId) {
      const fi = rest.findIndex((track) => track.id === folderId)
      if (fi < 0) return
      // Straight after the last child already in the folder, so a folder reads as
      // one block (newest at the bottom, like REAPER) instead of jumping to the top.
      const at = folderEnd(rest, fi)
      next = [...rest.slice(0, at), { ...item, folderId }, ...rest.slice(at)]
    } else {
      const fi = item.folderId ? rest.findIndex((track) => track.id === item.folderId) : -1
      // Leaving a folder drops the row just below the block it came from.
      const at = fi >= 0 ? folderEnd(rest, fi) : rest.length
      next = [...rest.slice(0, at), { ...item, folderId: null }, ...rest.slice(at)]
    }
    commitTracks(next.map((track, position) => ({ ...track, number: position + 1 })))
  }

  /** Delete a folder header; its children survive at the top level. */
  const removeFolder = (id: string) => {
    const list = tracksRef.current
    const target = list.find((track) => track.id === id)
    if (!target) return
    const next = list
      .filter((track) => track.id !== id)
      .map((track) => (track.folderId === id ? { ...track, folderId: null } : track))
      .map((track, position) => ({ ...track, number: position + 1 }))
    commitTracks(next)
    if (selectedRef.current === id) setSelectedTrackId(next[0]?.id ?? null)
    notify(`Pasta "${target.name}" removida — as tracks dela continuaram no projeto`)
  }

  const addTrackIntoFolder = (folderId: string, kind: 'audio' | InstrumentKind = 'audio') => {
    const list = tracksRef.current
    const fi = list.findIndex((track) => track.id === folderId && track.isFolder)
    if (fi < 0) return
    const track =
      kind === 'audio'
        ? makeTrack(list.length)
        : makeTrack(list.length, undefined, 'instrument', kind)
    track.folderId = folderId
    if (!track.isFolder) syncTrackToEngine(track)
    const at = folderEnd(list, fi)
    const next = [...list.slice(0, at), track, ...list.slice(at)].map(
      (item, position) => ({ ...item, number: position + 1 }),
    )
    commitTracks(next)
    setSelectedTrackId(track.id)
    // A folded folder would hide the very row we just made.
    if (list[fi].collapsed) toggleFolder(folderId)
    notify(`Track criada em "${list[fi].name}"`)
  }

  // ------------------------------------------------------------- sub-groups

  const commitGroups = (next: GroupState[]) => {
    groupsRef.current = next
    setGroups(next)
  }

  const makeGroup = (index: number, name?: string): GroupState => ({
    id: newId(),
    name: name ?? `Grupo ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 1,
    pan: 0,
    isMuted: false,
  })

  const syncGroupToEngine = (group: GroupState) => {
    const engine = engineRef.current
    if (!engine) return
    if (!engine.hasGroup(group.id)) engine.addGroup(group.id, group.volume, group.pan)
    else {
      engine.setGroupVolume(group.id, group.volume)
      engine.setGroupPan(group.id, group.pan)
    }
    engine.setGroupMuted(group.id, group.isMuted)
  }

  /**
   * Create a bus and, when `memberIds` are given, route those tracks into it.
   * The bus is created first: the engine only accepts a member for a group that
   * already exists, and a track sent to a name that does not exist would quietly
   * stay on the master.
   */
  const createGroup = (members: string[] | 'selected' = 'selected') => {
    const playable = tracksRef.current.filter((track) => !track.isFolder)
    const picked =
      members === 'selected'
        ? playable.filter((track) => track.id === selectedRef.current)
        : playable.filter((track) => members.includes(track.id))
    const group = makeGroup(groupsRef.current.length)
    const nextGroups = [...groupsRef.current, group]
    commitGroups(nextGroups)
    syncGroupToEngine(group)
    const nextTracks = tracksRef.current.map((track) =>
      picked.some((member) => member.id === track.id) ? { ...track, groupId: group.id } : track,
    )
    commitTracks(nextTracks)
    for (const track of nextTracks) {
      if (picked.some((member) => member.id === track.id)) {
        engineRef.current?.setTrackGroup(track.id, group.id)
      }
    }
    notify(
      picked.length > 0
        ? `Grupo "${group.name}" criado com ${picked.length} track(s) dentro`
        : `Grupo "${group.name}" criado — escolha-o no seletor GRUPO de cada track`,
    )
    return group.id
  }

  /** Every member falls back to the master; nothing is deleted with the bus. */
  const dropGroup = (id: string) => {
    const engine = engineRef.current
    const target = groupsRef.current.find((group) => group.id === id)
    if (!target) return
    engine?.removeGroup(id)
    commitGroups(groupsRef.current.filter((group) => group.id !== id))
    const next = tracksRef.current.map((track) => (track.groupId === id ? { ...track, groupId: '' } : track))
    commitTracks(next)
    notify(`Grupo "${target.name}" removido — as tracks voltaram para o master`)
  }

  const changeGroup = (id: string, patch: Partial<GroupState>) => {
    const next = groupsRef.current.map((group) => (group.id === id ? { ...group, ...patch } : group))
    commitGroups(next)
    const group = next.find((item) => item.id === id)
    if (group) syncGroupToEngine(group)
  }

  /** Send one track to a group ('' = master) and rewire the live graph. */
  const assignGroup = (trackId: string, groupId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track || track.groupId === groupId) return
    if (groupId !== '' && !groupsRef.current.some((group) => group.id === groupId)) return
    commitTracks(
      tracksRef.current.map((item) => (item.id === trackId ? { ...item, groupId } : item)),
    )
    engineRef.current?.setTrackGroup(trackId, groupId)
    const name = groupId === '' ? 'master' : (groupsRef.current.find((g) => g.id === groupId)?.name ?? '')
    notify(`${track.name} → ${name}`)
  }

  /**
   * Sidechain: this track ducks whenever any of `sourceIds` speaks. The engine
   * builds the follower asynchronously, so the call is fired and the state is
   * written immediately - the strip shows what was asked for.
   */
  const setSidechain = (trackId: string, sourceIds: string[], depth?: number) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const nextDepth = depth ?? track.duckDepth
    // The same rules the graph enforces - no self-ducking, no folder (it carries
    // no signal), no source twice - so the chips cannot show a wiring that the
    // engine refuses to make.
    const sources = normalizeDuckSources(
      sourceIds,
      trackId,
      tracksRef.current.filter((item) => !item.isFolder).map((item) => item.id),
    )
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, duckSourceIds: sources, duckDepth: nextDepth } : item,
      ),
    )
    void engineRef.current
      ?.setSidechainDuck(trackId, sources, nextDepth)
      .catch(() => notify('Sidechain indisponível neste navegador'))
  }

  /**
   * Add or drop one source of a duck. The others stay where they are: the
   * follower keeps its envelope, so the mix does not hiccup while the producer is
   * only changing who controls it.
   */
  const toggleDuckSource = (trackId: string, sourceId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const removing = track.duckSourceIds.includes(sourceId)
    const next = removing
      ? track.duckSourceIds.filter((id) => id !== sourceId)
      : [...track.duckSourceIds, sourceId]
    setSidechain(trackId, next)
    const name = tracksRef.current.find((item) => item.id === sourceId)?.name ?? 'a track'
    notify(
      removing
        ? next.length === 0
          ? `${track.name}: duck desligado`
          : `${track.name} deixa de seguir ${name}`
        : `${track.name} segue ${next.length} fonte${next.length > 1 ? 's' : ''} (soma)`,
    )
  }

  const setTrackColor = (id: string, color: string) => {
    const next = tracksRef.current.map((track) => (track.id === id ? { ...track, color } : track))
    commitTracks(next)
  }

  const reorderTracksTo = (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    const list = tracksRef.current
    const from = list.findIndex((track) => track.id === draggedId)
    const to = list.findIndex((track) => track.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    commitTracks(next.map((track, position) => ({ ...track, number: position + 1 })))
  }

  const toggleMute = (id: string) => {
    if (tracksRef.current.find((track) => track.id === id)?.isFolder) return
    const next = tracksRef.current.map((track) =>
      track.id === id ? { ...track, isMuted: !track.isMuted } : track,
    )
    applyMix(next)
    commitTracks(next)
  }

  const toggleSolo = (id: string) => {
    if (tracksRef.current.find((track) => track.id === id)?.isFolder) return
    const next = tracksRef.current.map((track) =>
      track.id === id ? { ...track, isSoloed: !track.isSoloed } : track,
    )
    applyMix(next)
    commitTracks(next)
  }

  const toggleArm = (id: string) => {
    const track = tracksRef.current.find((item) => item.id === id)
    if (track?.isFolder) {
      notify('Pasta não grava — arme uma track dentro dela')
      return
    }
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === id ? { ...item, isArmed: !item.isArmed } : item,
      ),
    )
    // Arming a lane that never chose a device should still let the producer
    // record: open the browser's default input instead of failing later.
    if (track && !track.isArmed && track.kind !== 'instrument' && !track.inputDeviceId) {
      void detectInput(id)
    }
  }

  const renameTrack = (id: string, name: string) => {
    commitTracks(
      tracksRef.current.map((track) => (track.id === id ? { ...track, name } : track)),
    )
  }

  const changeVolume = (id: string, value: number) => {
    engineRef.current?.setVolume(id, value)
    commitTracks(
      tracksRef.current.map((track) => (track.id === id ? { ...track, volume: value } : track)),
    )
  }

  const changePan = (id: string, value: number) => {
    engineRef.current?.setPan(id, value)
    commitTracks(
      tracksRef.current.map((track) => (track.id === id ? { ...track, pan: value } : track)),
    )
  }

  // Marker functions
  const addMarker = (position: number, name: string, isRegion = false, regionEnd?: number) => {
    const marker: Marker = {
      id: newId(),
      position,
      name,
      color: `hsl(${Math.random() * 360}, 70%, 50%)`,
      isRegion,
      regionEnd,
    }
    setMarkers((prev) => [...prev, marker].sort((a, b) => a.position - b.position))
    notify(`Marcador "${name}" adicionado`)
  }

  const removeMarker = (id: string) => {
    setMarkers((prev) => prev.filter((m) => m.id !== id))
    notify('Marcador removido')
  }

  const renameMarker = (id: string, name: string) => {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, name } : m)))
  }

  const toggleMarkerRegion = (id: string) => {
    setMarkers((prev) => prev.map((m) => {
      if (m.id !== id) return m
      return { ...m, isRegion: !m.isRegion, regionEnd: m.isRegion ? undefined : m.position + STEP_COUNT * 4 }
    }))
  }

  const openMarkerInputAt = (position: number) => {
    setShowMarkerInput({ position: Math.max(0, Math.floor(position)) })
  }

  const addMarkerFromRuler = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    const total = Math.max(1, arrangementBars * STEP_COUNT)
    const step = Math.floor(ratio * total)
    // Right-clicking inside a picked range is how you get at its actions: the
    // band itself never swallows clicks, so clips stay draggable.
    if (timeSel && step >= timeSel.from && step <= timeSel.to) {
      setSelMenu({ x: event.clientX, y: event.clientY })
      return
    }
    openMarkerInputAt(step)
  }

  const toggleFx = (id: string, enabled: boolean) => {
    const track = tracksRef.current.find((item) => item.id === id)
    if (!track) return
    const engine = engineRef.current
    engine?.setFxEnabled(id, enabled)
    if (enabled) {
      engine?.setDrive(id, track.drive)
      engine?.setCabinet(id, track.cabinet)
    }
    commitTracks(
      tracksRef.current.map((item) => (item.id === id ? { ...item, hasFx: enabled } : item)),
    )
  }

  const changeDrive = (id: string, value: number) => {
    engineRef.current?.setDrive(id, value)
    commitTracks(
      tracksRef.current.map((track) => (track.id === id ? { ...track, drive: value } : track)),
    )
  }

  const changeCabinet = (id: string, value: number) => {
    engineRef.current?.setCabinet(id, value)
    commitTracks(
      tracksRef.current.map((track) => (track.id === id ? { ...track, cabinet: value } : track)),
    )
  }

  // --------------------------------------------------- input device routing

  const refreshInputs = async () => {
    const engine = engineRef.current
    if (!engine) return
    try {
      const devices = await engine.listInputs()
      setInputs(devices)
      // The same call is what makes the browser name the playback devices: labels
      // for outputs are hidden until a microphone has been allowed, so detecting
      // entries is also what fills the saída list.
      setOutputs(await listOutputs())
      // Output latency is only meaningful once the context has actually run, so
      // re-read it whenever the user re-detects their devices.
      setAutoLatencyMs(engine.latencyMs())
      setInputLatencyMs(engine.inputLatencyMs())
      notify(
        devices.length > 0
          ? `${devices.length} entrada(s) de áudio detectada(s) · latência de saída ${engine.latencyMs()} ms`
          : 'Nenhuma entrada de áudio encontrada',
      )
    } catch (error) {
      notify(`Falha ao detectar entradas: ${(error as Error).message}`)
    }
  }

  /**
   * Every playback device this page can actually route to. A device without an id
   * is the browser's placeholder for a permission it has not granted: `setSinkId`
   * would refuse it, so it is not offered as a choice and the window says why.
   */
  const listOutputs = async (): Promise<MediaDeviceInfo[]> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter((device) => device.kind === 'audiooutput' && device.deviceId !== '')
    } catch {
      return []
    }
  }

  /**
   * Point the whole mix at one output device, and say honestly what happened.
   * The engine answers with the refusal of the device itself when it refuses, so
   * the producer reads that instead of wondering why the room is quiet.
   */
  const chooseOutput = async (deviceId: string) => {
    const engine = engineRef.current
    if (!engine) return
    const route = await engine.setOutputDevice(deviceId)
    setOutputRoute(route)
    setAutoLatencyMs(engine.latencyMs())
    setInputLatencyMs(engine.inputLatencyMs())
    // Only a device that actually accepted the mix is remembered; a refusal stays
    // unchosen so the next launch does not walk into the same closed port.
    if (!route.error) writeStoredOutput(route.deviceId)
    if (route.error) notify(`Saída: ${route.error} — o mix voltou ao dispositivo padrão`)
    else
      notify(
        route.routed
          ? `Saída: ${route.label} · ${engine.latencyMs()} ms de latência`
          : 'Saída: dispositivo padrão do sistema',
      )
  }

  /**
   * Re-aim the mix at the output this machine was left on. The choice is stored per
   * computer, not inside the project: a sound card does not travel with the file. A
   * device that has been unplugged refuses and is forgotten, so the room is never
   * left silent because hardware went away.
   */
  const restoreStoredOutput = async () => {
    const engine = engineRef.current
    if (!engine) return
    let wanted = ''
    try {
      wanted = window.localStorage.getItem(OUTPUT_KEY) ?? ''
    } catch {
      return
    }
    if (!wanted) return
    const route = await engine.setOutputDevice(wanted)
    setOutputRoute(route)
    setAutoLatencyMs(engine.latencyMs())
    setInputLatencyMs(engine.inputLatencyMs())
    if (route.error) writeStoredOutput('')
  }

  /**
   * Open the device window with the numbers the context actually reports, read at
   * the moment they are looked at instead of from whatever the last detection said.
   */
  const openDevices = async () => {
    const engine = engineRef.current
    setDevicesOpen(true)
    setOutputs(await listOutputs())
    if (!engine) return
    const seen = engine.describeOutput()
    setAutoLatencyMs(seen.latencyMs)
    setInputLatencyMs(seen.inputLatencyMs)
    if (!seen.routed) {
      setOutputRoute((prev) =>
        prev.deviceId === seen.deviceId ? prev : { ...prev, deviceId: seen.deviceId, routed: seen.routed },
      )
    }
  }

  /** Remember this machine's output device; an empty id means "system default". */
  const writeStoredOutput = (deviceId: string) => {
    try {
      window.localStorage.setItem(OUTPUT_KEY, deviceId)
    } catch {
      /* a full store must not break the audio */
    }
  }

  const selectInput = async (trackId: string, deviceId: string) => {
    const engine = engineRef.current
    if (!engine) return
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return

    if (track.callChannelKey) {
      // A entrada desta faixa é o stream da sala, e um dispositivo no lugar dele
      // deixaria o cabo imprimindo num canal que a faixa não usa mais. Melhor
      // recusar do que reencaminhar às escondidas.
      notify(`"${track.name}" é do cabo da sala — apague a faixa ou desconecte o cabo para usar um dispositivo`)
      return
    }

    if (!deviceId) {
      engine.disconnectInput(trackId)
      commitTracks(
        tracksRef.current.map((item) =>
          item.id === trackId
            ? { ...item, inputDeviceId: '', inputMonitor: false }
            : item,
        ),
      )
      setLiveInput((prev) => ({ ...prev, [trackId]: null }))
      notify('Entrada desconectada')
      return
    }

    try {
      await applyLaneInput(trackId, deviceId)
    } catch (error) {
      notify(`Falha ao abrir entrada: ${(error as Error).message}`)
    }
  }

  const toggleInputMonitor = (trackId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    if (track.callChannelKey) {
      // Em uma faixa de sala o IN abre a escuta pelo retorno do cabo, não pela
      // mixagem: pela mixagem o som subiria ao master e sairia de volta pelo
      // jack, e o músico do outro lado ouviria a própria bateria atrasada.
      const next = !track.inputMonitor
      engineRef.current?.setCallReturnGain(track.callChannelKey, next ? 1 : 0)
      commitTracks(
        tracksRef.current.map((item) =>
          item.id === trackId ? { ...item, inputMonitor: next } : item,
        ),
      )
      notify(next ? `${track.name}: escutando o participante` : `${track.name}: mudo na sua sala`)
      return
    }
    if (!track.inputDeviceId) {
      notify('Selecione um dispositivo de entrada primeiro')
      return
    }
    const next = !track.inputMonitor
    engineRef.current?.setInputMonitor(trackId, next)
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, inputMonitor: next } : item,
      ),
    )
    if (next) notify('Monitor ligado — use fones para evitar microfonia')
  }

  /**
   * Connect a device to a lane and store what the device really delivered.
   * The honest channel count comes from the engine (the track state only ever
   * holds the requested id), so a mono mic forced into a stereo ask is shown
   * as mono instead of pretending to be a stereo pair.
   */
  const applyLaneInput = async (trackId: string, deviceId: string) => {
    const engine = engineRef.current
    if (!engine) return
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const status = await engine.connectInput(
      trackId,
      deviceId,
      track.inputMonitor,
      track.inputChannel,
    )
    // The saved project knows whether this lane prints its effects; the engine
    // only learns it now, one patch later.
    engine.setRecordMode(trackId, track.inputWet ? 'wet' : 'dry')
    setLiveInput((prev) => ({ ...prev, [trackId]: status }))
    // Remember how many inputs the device really handed over: that number is only
    // readable while a stream is open, and it is what lets the channel picker offer
    // "Entrada 5" the next time this interface is patched.
    setDeviceChannels((prev) =>
      prev[status.deviceId] === status.sourceChannels
        ? prev
        : { ...prev, [status.deviceId]: status.sourceChannels },
    )
    // Permission now exists, so re-read the list quietly: this is the moment
    // the dropdown can show real device names instead of unnamed entries.
    let devices: MediaDeviceInfo[] = inputs
    try {
      const fresh = await engine.listInputsQuietly()
      if (fresh.length > 0) {
        devices = fresh
        setInputs(fresh)
      }
    } catch {
      /* keep the list we already had */
    }
    // Prefer the id the dropdown actually holds, so the selection stays visible.
    const known = devices.some((device) => device.deviceId === status.deviceId)
    const chosen = known ? status.deviceId : deviceId || status.deviceId
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, inputDeviceId: chosen } : item,
      ),
    )
    notify(`${describeLiveInput(status)} conectada nesta track`)
  }

  /** Pick the first input the browser can see and wire it into the lane. */
  const detectInput = async (trackId: string) => {
    const engine = engineRef.current
    if (!engine) return
    try {
      const deviceId = await engine.detectInput()
      await applyLaneInput(trackId, deviceId)
    } catch (error) {
      notify(`Não foi possível detectar a entrada: ${(error as Error).message}`)
    }
  }

  /** Pick which part of the device this lane owns, then re-patch the audio. */
  const selectInputChannel = async (trackId: string, mode: InputChannel) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track || track.inputChannel === mode) return
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, inputChannel: mode } : item,
      ),
    )
    if (!track.inputDeviceId) return
    try {
      await applyLaneInput(trackId, track.inputDeviceId)
    } catch (error) {
      notify(`Falha ao remapear o canal: ${(error as Error).message}`)
    }
  }

  /**
   * Choose what this lane prints: the raw input ("seco") or the sound at the end of
   * its own effects chain ("FX"). A wet take is the input alone through the chain —
   * the engine closes the lane's clip while the pass runs, the way a desk mutes its
   * own tape during an over-dub — so what the headphones said is what the file
   * holds. A dry take keeps the raw sound and lets the chain stay editable.
   */
  const toggleInputWet = (trackId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    if (!track.inputDeviceId) {
      notify('Selecione um dispositivo de entrada primeiro')
      return
    }
    const next = !track.inputWet
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, inputWet: next } : item,
      ),
    )
    engineRef.current?.setRecordMode(trackId, next ? 'wet' : 'dry')
    notify(
      next
        ? 'Grava com os efeitos: a take já sai processada, igual ao que você ouve'
        : 'Grava seco: a entrada bruta fica na take e os efeitos continuam no play',
    )
  }

  /**
   * The channels this lane can be patched to, and whether they are the real ones.
   * The count is what the hardware actually delivered — live while a stream is
   * open, otherwise the count its first connection taught us — so the picker never
   * offers "Entrada 6" on a two-channel interface. Before a device has been opened
   * the count is unknown: the list then holds a stereo pair plus the channel the
   * lane remembers, so a reload does not silently drop the patch, and the title
   * says the real list arrives when the input opens.
   */
  const channelSpan = (track: TrackState): { channels: number; known: boolean } => {
    const seen = liveInput[track.id]?.sourceChannels ?? deviceChannels[track.inputDeviceId] ?? 0
    const real = Math.round(seen)
    if (real > 0) return { channels: Math.min(MAX_INPUT_CHANNELS, real), known: true }
    return {
      channels: Math.min(MAX_INPUT_CHANNELS, Math.max(2, Math.round(track.inputChannel))),
      known: false,
    }
  }

  /** The options of the CH picker, built from the span above in one place. */
  const channelOptions = (track: TrackState): { value: number; label: string }[] => {
    const span = channelSpan(track)
    if (span.channels === 1 && span.known) return [{ value: 0, label: 'Mono (entrada 1)' }]
    return [
      { value: 0, label: 'Par estéreo 1+2' },
      ...Array.from({ length: span.channels }, (_, index) => ({
        value: index + 1,
        label: `Entrada ${index + 1}`,
      })),
    ]
  }

  /**
   * The saved project keeps `inputDeviceId` per lane, but the browser only
   * exposes device ids once permission has been granted — so on load those
   * ids sit in state with no live stream behind them, and the DAW shows
   * "entrada ativa" while a take would record silence. Reopen the saved
   * inputs quietly; lanes whose device disappeared are listed for the user.
   */
  const reconnectSavedInputs = async () => {
    const engine = engineRef.current
    if (!engine) return
    // Chamadas não são hardware: `sanitizeProject` já devolve um projeto sem
    // faixas de sala, e esta lista ignora qualquer uma que apareça por outro
    // caminho — pedir o microfone do navegador para um canal de WebRTC seria
    // chamar getUserMedia('call') e falhar na cara do usuário.
    const armed = tracksRef.current.filter(
      (item) => item.inputDeviceId && !item.callChannelKey,
    )
    if (armed.length === 0) return
    let devices: MediaDeviceInfo[]
    try {
      devices = await engine.listInputsQuietly()
    } catch {
      return
    }
    if (devices.length === 0) return
    const missing: string[] = []
    const printing: string[] = []
    for (const track of armed) {
      const wanted = track.inputDeviceId
      const found = devices.some((device) => device.deviceId === wanted)
      if (!found) {
        // Keep the saved id (so the lane reconnects when the interface comes
        // back) but mark the lane dead and drop the monitor.
        engine.setInputMonitor(track.id, false)
        setLiveInput((prev) => ({ ...prev, [track.id]: null }))
        missing.push(track.name)
        commitTracks(
          tracksRef.current.map((item) =>
            item.id === track.id ? { ...item, inputMonitor: false } : item,
          ),
        )
        continue
      }
      try {
        const status = await engine.connectInput(
          track.id,
          wanted,
          track.inputMonitor,
          track.inputChannel,
        )
        engine.setRecordMode(track.id, track.inputWet ? 'wet' : 'dry')
        if (track.inputWet) printing.push(track.name)
        setLiveInput((prev) => ({ ...prev, [track.id]: status }))
        setDeviceChannels((prev) =>
          prev[status.deviceId] === status.sourceChannels
            ? prev
            : { ...prev, [status.deviceId]: status.sourceChannels },
        )
      } catch {
        missing.push(track.name)
      }
    }
    setInputs(devices)
    if (missing.length > 0) {
      notify(
        `Entrada salva não encontrada em: ${missing.join(', ')} — use Devices ▸ Detectar entradas`,
      )
    } else if (printing.length > 0) {
      // Printing wet carries the input to the chain by itself, so a saved project
      // that was set to record with effects arrives live. Say it, because a room
      // with speakers and an open microphone feeds back.
      notify(
        `Monitor aberto em ${printing.join(', ')} — gravação com FX está ligada, use fones`,
      )
    }
  }

  // --------------------------------------------------------- external plugins

  const addPluginFile = (trackId: string, kind: PluginKind, attachToNam?: string) => {
    pluginTarget.current = attachToNam ? { trackId, kind, attachToNam } : { trackId, kind }
    const input = pluginInputRef.current
    if (!input) return
    input.accept =
      kind === 'ir'
        ? 'audio/*,.wav,.ogg,.mp3,.flac'
        : kind === 'nam'
          ? '.nam,application/json'
          : '.js,text/javascript'
    input.value = ''
    input.click()
  }

  const onPluginFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const target = pluginTarget.current
    event.target.value = ''
    if (!file || !target) return
    const engine = engineRef.current
    if (!engine) return

    try {
      await engine.resume()
      const assetId = newId()
      const addPluginState = async (info: PluginInfo) => {
        // The descriptor is useful only with its bytes. Save first, then let the
        // project reference the asset id; a failed IndexedDB write is still a
        // usable session plugin, but it honestly says it cannot return later.
        await saveSample(assetId, file).catch(() => {})
        commitPlugins(target.trackId, (prev) => [
          ...prev,
          { ...info, enabled: true, assetId },
        ])
        const track = tracksRef.current.find((item) => item.id === target.trackId)
        if (!track) return
        // Attaching to a specific NAM: place the IR immediately after it so the
        // engine routes the convolution only through that amp's parallel branch.
        if (target.attachToNam) {
          const at = track.chain.indexOf(target.attachToNam)
          const next = [...track.chain]
          next.splice(at < 0 ? next.length : at + 1, 0, info.id)
          engineRef.current?.setChainOrder(target.trackId, next)
          commitChain(target.trackId, () => next)
          return
        }
        commitChain(target.trackId, () => chainWithPlugin(track, info.id))
      }

      if (target.kind === 'ir') {
        const data = await file.arrayBuffer()
        const buffer = await engine.ctx.decodeAudioData(data)
        await addPluginState(engine.addIrPlugin(target.trackId, buffer, file.name))
        if (target.attachToNam) {
          const host = tracksRef.current
            .find((item) => item.id === target.trackId)
            ?.plugins.find((item) => item.id === target.attachToNam)
          notify(`Cabinet "${file.name}" anexado a ${host?.name ?? 'este amp'} — ele volta com o projeto`)
        } else {
          notify(`IR "${file.name}" carregado — ele volta com o projeto`)
        }
      } else if (target.kind === 'nam') {
        await addPluginState(await engine.addNamPlugin(target.trackId, file))
        notify(`Modelo NAM "${file.name}" carregado — ele volta com o projeto`)
      } else {
        await addPluginState(await engine.addWorkletPlugin(target.trackId, file))
        notify(`Plugin "${file.name}" carregado — ele volta com o projeto`)
      }
    } catch (error) {
      notify(`Falha ao carregar plugin: ${(error as Error).message}`)
    }
  }

  const togglePlugin = (trackId: string, pluginId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    const plugin = track?.plugins.find((item) => item.id === pluginId)
    if (!track || !plugin) return
    const next = !plugin.enabled
    engineRef.current?.setPluginEnabled(trackId, pluginId, next)
    commitPlugins(trackId, (prev) =>
      prev.map((item) => (item.id === pluginId ? { ...item, enabled: next } : item)),
    )
  }

  const removePlugin = (trackId: string, pluginId: string) => {
    const assetId = tracksRef.current
      .find((item) => item.id === trackId)
      ?.plugins.find((item) => item.id === pluginId)?.assetId
    engineRef.current?.removePlugin(trackId, pluginId)
    commitChain(trackId, (prev) => prev.filter((entry) => entry !== pluginId))
    commitPlugins(trackId, (prev) => prev.filter((item) => item.id !== pluginId))
    // The bytes go only when no undo step can still ask for them, so Ctrl+Z
    // puts the amp back with its file attached.
    if (assetId) reclaimSample(assetId)
    notify('Plugin removido')
  }

  // ------------------------------------------------- native VST2 (desktop)

  /** Point this lane at a .dll on the machine. The file itself is never copied. */
  const setNativeVstSlot = (trackId: string, next: NativeVstSlot | null) => {
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === trackId ? { ...track, nativeVst2: next } : track,
      ),
    )
  }

  // -------------------------------------------- the native plugin, heard live
  /**
   * Which lanes are currently running their .dll in the live signal.
   *
   * A reconciler rather than a call inside each button handler, because the lane
   * can change underneath: re-patching the device rebuilds the input nodes and
   * drops whatever was wired into them, a plugin can stop answering mid-take, and
   * a monitor lamp goes on with the mouse rather than with a lifecycle hook. Each
   * pass asks the same question — does this lane have a VST2, want to be heard,
   * and not already have a session? — and fixes only what differs.
   */
  const [liveVst, setLiveVst] = useState<Record<string, LiveVstState>>({})
  const liveLinksRef = useRef(new Map<string, NativeLiveLink>())
  const liveSignaturesRef = useRef(new Map<string, string>())
  const liveOpeningRef = useRef(new Set<string>())
  /** Paths that refused a session, and when to ask them again. */
  const liveFailedRef = useRef(new Map<string, number>())

  useEffect(() => {
    const api = pluginApi()
    if (!api?.liveOpen || !api.liveBlock) return
    const engine = engineRef.current
    if (!engine) return

    const publish = (trackId: string, next: LiveVstState | null) => {
      setLiveVst((prev) => {
        const before = prev[trackId]
        if (!next && !before) return prev
        if (next && before && sameLiveState(before, next)) return prev
        const copy = { ...prev }
        if (next) copy[trackId] = next
        else delete copy[trackId]
        return copy
      })
    }

    const close = async (trackId: string, link: NativeLiveLink) => {
      liveLinksRef.current.delete(trackId)
      liveSignaturesRef.current.delete(trackId)
      engine.setLiveInsert(trackId, null)
      await link.close().catch(() => undefined)
      publish(trackId, null)
    }

    const sync = async () => {
      const wanted = new Map<string, NativeVstSlot>()
      for (const track of tracksRef.current) {
        const slot = track.nativeVst2
        if (!slot || track.kind !== 'audio' || slot.bypass) continue
        // A .vst3 bundle has no live session in this host yet: the slot still
        // bounces the clip, and the panel says which of the two is happening.
        const kind = /\.vst3([\\/]|$)/i.test(slot.path) ? 'vst3' : 'vst2'
        if (!canRunLive({ path: slot.path, kind })) continue
        if (!engine.hasInput(track.id) || !engine.isInputLive(track.id)) continue
        wanted.set(track.id, slot)
      }

      for (const [trackId, link] of [...liveLinksRef.current]) {
        const slot = wanted.get(trackId)
        if (slot && slot.path === link.path) continue
        void close(trackId, link)
      }

      for (const [trackId, slot] of wanted) {
        const running = liveLinksRef.current.get(trackId)
        if (running) {
          const signature = liveParamSignature(slot)
          if (liveSignaturesRef.current.get(trackId) !== signature) {
            liveSignaturesRef.current.set(trackId, signature)
            await running.setParams(slot.params).catch(() => undefined)
          }
          const report = running.report
          publish(trackId, {
            name: slot.name,
            latencyMs: liveLatencyMs(engine.ctx.sampleRate, running.batch),
            batches: report.batches,
            answered: report.answered,
            underruns: report.underruns,
            error: running.error,
          })
          if (!running.live) void close(trackId, running)
          continue
        }
        if (liveOpeningRef.current.has(trackId)) continue
        const cooldown = liveFailedRef.current.get(slot.path) ?? 0
        if (Date.now() < cooldown) continue
        liveOpeningRef.current.add(trackId)
        try {
          const link = await NativeLiveLink.open(engine.ctx, api, {
            path: slot.path,
            sampleRate: engine.ctx.sampleRate,
            params: slot.params,
          })
          if (!link) {
            // No live path in this page at all — the browser build, or an engine
            // without an AudioWorklet. Nothing to say: the offline pass still runs.
            continue
          }
          liveLinksRef.current.set(trackId, link)
          liveSignaturesRef.current.set(trackId, liveParamSignature(slot))
          engine.setLiveInsert(trackId, link.node)
          publish(trackId, {
            name: slot.name,
            latencyMs: liveLatencyMs(engine.ctx.sampleRate, link.batch),
            batches: 0,
            answered: 0,
            underruns: 0,
            error: '',
          })
        } catch (error) {
          // The plugin's own refusal, remembered for a while so a .dll that cannot
          // hold a session is not asked again four times a minute.
          liveFailedRef.current.set(slot.path, Date.now() + 15000)
          publish(trackId, {
            name: slot.name,
            latencyMs: 0,
            batches: 0,
            answered: 0,
            underruns: 0,
            error: (error as Error).message || 'o plugin não abriu sessão ao vivo',
          })
        } finally {
          liveOpeningRef.current.delete(trackId)
        }
      }
    }

    const timer = window.setInterval(() => {
      void sync().catch(() => undefined)
    }, 400)
    void sync().catch(() => undefined)
    return () => {
      window.clearInterval(timer)
      for (const [trackId, link] of [...liveLinksRef.current]) void close(trackId, link)
    }
  }, [tracks])

  /**
   * Bounce the lane's clip through the native plugin. The clip's WAV crosses to
   * the process that owns the .dll, comes back as a new sample, and the dry pass
   * goes to the take shelf instead of disappearing — so the effect is committed
   * without losing the performance, and Ctrl+Z still puts the dry clip back.
   */
  const applyNativeVstToClip = async (trackId: string) => {
    const api = pluginApi()
    const engine = engineRef.current
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!api || !engine || !track) return
    const slot = track.nativeVst2
    if (!slot) {
      notify('Escolha um plugin nativo primeiro')
      return
    }
    // A bypassed slot is a slot the producer wants to keep but not pay for: the
    // clip stays as it is rather than being pushed through a plugin that has
    // been switched off.
    if (slot.bypass) {
      notify(`${slot.name} está com o bypass ligado — desligue o bypass para processar o clipe`)
      return
    }
    if (!track.bufferId || track.clipDuration <= 0) {
      notify('Esta lane ainda não tem clipe para processar')
      return
    }
    setBouncingVst((prev) => ({ ...prev, [trackId]: true }))
    try {
      const dry = await loadSample(track.bufferId)
      if (!dry) throw new Error('o áudio do clipe não está no armazenamento')
      const bytes = new Uint8Array(await dry.arrayBuffer())
      const result = await api.render({
        path: slot.path,
        params: slot.params,
        sampleRate: engine.ctx.sampleRate,
        inputWav: bytes,
      })
      if (!result.ok || !result.outputWav) {
        throw new Error(result.error ?? 'o plugin não devolveu áudio')
      }
      const wetId = newId()
      // Copied into a plain ArrayBuffer the Blob can own: what comes back over
      // the bridge is a view, and a view of someone else's buffer must not be
      // handed to the sample store.
      const wetBytes = new Uint8Array(result.outputWav.byteLength)
      wetBytes.set(result.outputWav)
      const wet = new Blob([wetBytes], { type: 'audio/wav' })
      await saveSample(wetId, wet)
      const buffer = await engine.ctx.decodeAudioData(await wet.arrayBuffer())
      const shelf: AudioTake[] = [...track.takes]
      shelf.push({
        id: track.bufferId,
        name: `${track.clipName || 'Take'} (seco)`.slice(0, 40),
        start: track.clipStart,
        duration: track.clipDuration,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
      })
      engine.setBuffer(trackId, buffer, wetId)
      // The clip now *is* the processed pass, so its preview is the clip itself:
      // installing it under the new key is what stops playback and export from
      // running the plugin over a file that already went through it.
      engine.setMonitorBuffer(
        trackId,
        buffer,
        nativePreviewKey({ ...track, bufferId: wetId, clipDuration: buffer.duration }, engine.ctx.sampleRate),
      )
      engine.setClipDuration(trackId, buffer.duration)
      engine.setClipFade(trackId, track.fadeIn, track.fadeOut)
      // The preview row is about the pass the engine holds, and the bounce just
      // made that pass the clip: the row reports the file that is now playing,
      // with the peak the plugin reported for it.
      setNativePreview((prev) => ({
        ...prev,
        [trackId]: { state: 'on', name: slot.name, peak: result.peak ?? 0, error: '' },
      }))
      setPeaks((prev) => ({ ...prev, [trackId]: computePeaks(buffer).slice(0, 260) }))
      commitTracks(
        tracksRef.current.map((item) =>
          item.id === trackId
            ? {
                ...item,
                takes: shelf,
                bufferId: wetId,
                clipDuration: buffer.duration,
                clipName: `${track.clipName || 'clipe'} · ${slot.name}`.slice(0, 40),
              }
            : item,
        ),
      )
      notify(
        `${slot.name} aplicado: pico ${(result.peak ?? 0).toFixed(3)}, ` +
          `${(result.nonSilent ?? 0).toLocaleString('pt-BR')} amostras. O seco está nos takes.`,
      )
    } catch (error) {
      notify(`Não deu para aplicar o plugin: ${(error as Error).message}`)
    } finally {
      setBouncingVst((prev) => {
        const copy = { ...prev }
        delete copy[trackId]
        return copy
      })
    }
  }

  /**
   * The native preview — what makes a plugin audible at all.
   *
   * A .dll or .vst3 answers to the plugin process, not to Web Audio, so it can
   * never sit in the live graph. What a host can do instead is render the lane's
   * clip through that process as soon as the settings settle, and let the engine
   * play and export the result. The recorded take stays exactly where it was:
   * the preview is a pass in front of the speakers, held in the engine, never
   * written to the project. What it does not do is process a live input — the
   * microphone still goes to the speakers unprocessed, because that path has no
   * offline render to fall back on.
   */
  const previewTimers = useRef(new Map<string, { key: string; id: number }>())
  /** Renders in flight, by lane and by the settings they were made for. */
  const previewJobs = useRef(new Map<string, { key: string; job: Promise<void> }>())
  /**
   * Keys that already failed. A plugin that faults its own process would
   * otherwise be retried on every project change, and each try costs the
   * supervisor a new process; the panel keeps the reason and offers a retry.
   */
  const failedPreviewKeys = useRef(new Set<string>())
  /** Lanes that had no pass yet when the transport started; see below. */
  const pendingAtPlay = useRef(new Set<string>())

  const renderNativePreview = (trackId: string, key: string): Promise<void> => {
    // One pass per lane, and only for the settings that are in place: a render of
    // an older key is not a reason to skip the one the lane now wants.
    const inFlight = previewJobs.current.get(trackId)
    if (inFlight?.key === key) return inFlight.job
    const job = (async () => {
      const api = pluginApi()
      const engine = engineRef.current
      const track = tracksRef.current.find((item) => item.id === trackId)
      const slot = track?.nativeVst2
      if (!api || !engine || !slot || !track?.bufferId) return
      setNativePreview((prev) => ({
        ...prev,
        [trackId]: { state: 'busy', name: slot.name, peak: 0, error: '' },
      }))
      try {
        const dry = await loadSample(track.bufferId)
        if (!dry) throw new Error('o áudio do clipe não está no armazenamento')
        const bytes = new Uint8Array(await dry.arrayBuffer())
        const result = await api.render({
          path: slot.path,
          params: slot.params,
          sampleRate: engine.ctx.sampleRate,
          inputWav: bytes,
        })
        if (!result.ok || !result.outputWav) {
          throw new Error(result.error ?? 'o plugin não devolveu áudio')
        }
        // The producer may have moved on while the plugin was working: a pass
        // rendered from a clip or a knob that is no longer there must not be
        // installed over what the lane is doing now.
        const live = tracksRef.current.find((item) => item.id === trackId)
        const liveKey = live ? nativePreviewKey(live, engine.ctx.sampleRate) : ''
        if (!live || liveKey !== key) {
          // A bounce that committed its own pass while this render was in flight
          // already put the truth in the row — leave it. Only a lane that holds
          // nothing now loses its line, so no "processando" hangs forever.
          if (live && liveKey && engine.monitorKey(trackId) === liveKey) return
          setNativePreview((prev) => {
            if (!prev[trackId]) return prev
            const copy = { ...prev }
            delete copy[trackId]
            return copy
          })
          return
        }
        const wetBytes = new Uint8Array(result.outputWav.byteLength)
        wetBytes.set(result.outputWav)
        const wet = new Blob([wetBytes], { type: 'audio/wav' })
        const buffer = await engine.ctx.decodeAudioData(await wet.arrayBuffer())
        engine.setMonitorBuffer(trackId, buffer, key)
        // `on` is a claim about the engine, not about the render: the pass only
        // counts once the lane actually holds it, which is what puts the plugin's
        // audio in front of the speakers and in the exported file.
        const installed = engine.monitorKey(trackId) === key
        setNativePreview((prev) => ({
          ...prev,
          [trackId]: installed
            ? { state: 'on', name: slot.name, peak: result.peak ?? 0, error: '' }
            : {
                state: 'error',
                name: slot.name,
                peak: 0,
                error: 'a lane não segurou o passe — ela deixou de existir no meio do caminho',
              },
        }))
        // A pass that lands while the song is running, for a lane that had none
        // when play was pressed, is worth hearing now instead of on the next
        // press. Only that case restarts the transport — a knob tweaked in the
        // middle of playback waits for the next play rather than cutting the bar.
        if (installed && pendingAtPlay.current.delete(trackId)) restartBuffersForPreview()
      } catch (error) {
        failedPreviewKeys.current.add(key)
        setNativePreview((prev) => ({
          ...prev,
          [trackId]: {
            state: 'error',
            name: slot.name,
            peak: 0,
            error: (error as Error).message,
          },
        }))
      }
    })().finally(() => {
      // Only this pass owns the lane's slot: a newer key may have taken it while
      // this one was crossing the plugin process.
      if (previewJobs.current.get(trackId)?.job === job) previewJobs.current.delete(trackId)
    })
    previewJobs.current.set(trackId, { key, job })
    return job
  }

  /**
   * Restarts the clip pass at the playhead so a freshly rendered preview is
   * audible from the bar it was already in. Nothing here re-derives the clock:
   * `startPlayback` is the one place that knows how a pass is armed at a position,
   * and count-in and recording already have their own answers inside it — so the
   * restart cannot leave the transport half-armed.
   */
  function restartBuffersForPreview() {
    if (!isPlayingRef.current || isRecordingRef.current) return
    if (pendingBufferStartRef.current !== null) return
    startPlayback(Math.floor(songStepNow()), false)
  }

  /** How long the app waits for a gesture to settle before rendering it. */
  const PREVIEW_DEBOUNCE_MS = 420

  /**
   * Bring every lane's preview in line with the project: drop passes that are no
   * longer wanted, and schedule a render for the lanes whose plugin, knobs or
   * clip changed. The debounce is what makes dragging a knob affordable — the
   * plugin process gets one request per gesture instead of one per frame.
   */
  const syncNativePreviews = () => {
    const engine = engineRef.current
    if (!engine) return
    const sampleRate = engine.ctx.sampleRate
    for (const track of tracksRef.current) {
      const key = nativePreviewKey(track, sampleRate)
      const installed = engine.monitorKey(track.id)
      if (!key) {
        if (installed) engine.setMonitorBuffer(track.id, null)
        const timer = previewTimers.current.get(track.id)
        if (timer) {
          window.clearTimeout(timer.id)
          previewTimers.current.delete(track.id)
        }
        setNativePreview((prev) => {
          if (!prev[track.id]) return prev
          const copy = { ...prev }
          delete copy[track.id]
          return copy
        })
        continue
      }
      if (installed === key || previewJobs.current.get(track.id)?.key === key) continue
      if (failedPreviewKeys.current.has(key)) continue
      const pending = previewTimers.current.get(track.id)
      if (pending?.key === key) continue
      if (pending) window.clearTimeout(pending.id)
      previewTimers.current.set(track.id, {
        key,
        id: window.setTimeout(() => {
          const entry = previewTimers.current.get(track.id)
          if (entry?.key === key) previewTimers.current.delete(track.id)
          void renderNativePreview(track.id, key)
        }, PREVIEW_DEBOUNCE_MS),
      })
    }
  }

  /**
   * An export must not quietly come out drier than what the producer heard: any
   * lane still waiting on its pass is rendered now, and the render waits for it.
   * Answers how many lanes could not be processed, so the file says so out loud.
   */
  const ensureNativePreviews = async (): Promise<number> => {
    const engine = engineRef.current
    if (!engine) return 0
    const sampleRate = engine.ctx.sampleRate
    let unresolved = 0
    for (const track of tracksRef.current) {
      const key = nativePreviewKey(track, sampleRate)
      if (!key) continue
      const timer = previewTimers.current.get(track.id)
      if (timer) {
        window.clearTimeout(timer.id)
        previewTimers.current.delete(track.id)
      }
      if (engine.monitorKey(track.id) === key) continue
      // The producer explicitly asked for a file: a key that failed once gets a
      // fresh attempt instead of being silently skipped.
      failedPreviewKeys.current.delete(key)
      await renderNativePreview(track.id, key)
      if (engine.monitorKey(track.id) !== key) unresolved += 1
    }
    return unresolved
  }

  /** Retry a preview that failed, for the FX panel's own button. */
  const retryNativePreview = (trackId: string) => {
    const engine = engineRef.current
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!engine || !track) return
    const key = nativePreviewKey(track, engine.ctx.sampleRate)
    if (!key) {
      notify('Esta lane não tem plugin ativo com clipe para pré-escutar')
      return
    }
    failedPreviewKeys.current.delete(key)
    void renderNativePreview(trackId, key)
  }

  // Native previews follow the project: picking a plugin, moving a knob,
  // replacing a clip or bypassing a lane re-renders that lane's pass.
  useEffect(() => {
    if (!isNativeApp()) return
    syncNativePreviews()
  }, [tracks])

  useEffect(
    () => () => {
      for (const entry of previewTimers.current.values()) window.clearTimeout(entry.id)
      previewTimers.current.clear()
    },
    [],
  )


  const moveChainStage = (trackId: string, entryId: string, direction: -1 | 1) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const index = track.chain.indexOf(entryId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= track.chain.length) return
    const next = [...track.chain]
    const [entry] = next.splice(index, 1)
    next.splice(target, 0, entry)
    engineRef.current?.setChainOrder(trackId, next)
    commitChain(trackId, () => next)
  }

  // Drag-and-drop reordering: rebuild from the normalized entry order so the
  // engine and the state always agree on what the chain looks like.
  const reorderChainTo = (trackId: string, fromKey: string, toKey: string) => {
    if (!fromKey || !toKey || fromKey === toKey) return
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const keys = chainEntriesFor(track).map((entry) => entry.key)
    const from = keys.indexOf(fromKey)
    const to = keys.indexOf(toKey)
    if (from < 0 || to < 0) return
    const next = [...keys]
    const [entry] = next.splice(from, 1)
    next.splice(to, 0, entry)
    engineRef.current?.setChainOrder(trackId, next)
    commitChain(trackId, () => next)
  }

  /**
   * Built-in effects are put on the chain by hand, and leaving the chain is what
   * takes one out of the audio path — like pulling a pedal off a pedalboard
   * instead of only stepping on its switch. The unit keeps its knobs and its
   * enabled state, so putting it back is a one-click undo of the whole thing.
   * Both directions go through the same two calls the reorder uses, so the live
   * graph, the offline render and the export always agree with what is drawn.
   */
  const addBuiltinToChain = (trackId: string, fxId: BuiltinFxId) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const key = builtinChainId(fxId)
    if (track.chain.includes(key)) return
    const next = [...track.chain, key]
    engineRef.current?.setChainOrder(trackId, next)
    commitChain(trackId, () => next)
    notify(`${BUILTIN_FX_META[fxId].label} entrou no fim da cadeia — ◀▶ ou arraste para mudar a ordem.`)
  }

  const removeBuiltinFromChain = (trackId: string, fxId: BuiltinFxId) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const key = builtinChainId(fxId)
    const next = track.chain.filter((entry) => entry !== key)
    if (next.length === track.chain.length) return
    engineRef.current?.setChainOrder(trackId, next)
    commitChain(trackId, () => next)
    notify(
      `${BUILTIN_FX_META[fxId].label} saiu da cadeia — o sinal passa sem ele; os knobs ficam guardados.`,
    )
  }

  const changePluginParam = (trackId: string, pluginId: string, name: string, value: number) => {    engineRef.current?.setPluginParam(trackId, pluginId, name, value)
    commitPlugins(trackId, (prev) =>
      prev.map((item) =>
        item.id === pluginId
          ? { ...item, params: item.params.map((param) => (param.name === name ? { ...param, value } : param)) }
          : item,
      ),
    )
  }

  // ---------------------------------------------------------- built-in fx rack

  const applyFxPreset = (trackId: string, presetKey: string) => {
    const preset = BUILTIN_FX_PRESETS[presetKey]
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!preset || !track) return
    const rack = preset.rack()
    // A preset that switches a unit on must also put it on the chain: the chain
    // is what the audio walks, so an enabled unit outside it would be a knob
    // that does nothing.
    const order = chainWithEnabledRack(track.chain, rack)
    const engine = engineRef.current
    if (engine) {
      for (const fxId of BUILTIN_FX_IDS) {
        engine.setBuiltinFx(trackId, fxId, rack[fxId])
      }
      engine.setChainOrder(trackId, order)
    }
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, fxRack: rack, chain: order } : item,
      ),
    )
    notify(`Preset "${preset.name}" aplicado`)
  }

  const setBuiltinFx = (trackId: string, fxId: BuiltinFxId, unit: BuiltinFxUnit) => {
    engineRef.current?.setBuiltinFx(trackId, fxId, unit)
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === trackId
          ? { ...track, fxRack: { ...track.fxRack, [fxId]: unit } as BuiltinFxRack }
          : track,
      ),
    )
  }

  const toggleBuiltinFx = (trackId: string, fxId: BuiltinFxId) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const unit = track.fxRack[fxId]
    const nextUnit = { ...unit, enabled: !unit.enabled }
    const rack = { ...track.fxRack, [fxId]: nextUnit } as BuiltinFxRack
    // Switching a unit on is a promise that the sound changes, and only units
    // on the chain are wired — so turning one on also puts it back on the chain
    // when it had been taken off, in the same undo step as the switch.
    const order = chainWithEnabledRack(track.chain, rack)
    if (order.length !== track.chain.length) engineRef.current?.setChainOrder(trackId, order)
    engineRef.current?.setBuiltinFx(trackId, fxId, nextUnit)
    commitTracks(
      tracksRef.current.map((item) => (item.id === trackId ? { ...item, fxRack: rack, chain: order } : item)),
    )
    notify(`${BUILTIN_FX_META[fxId].label} ${unit.enabled ? 'desligado' : 'ligado'}`)
  }

  const changeBuiltinMix = (trackId: string, fxId: BuiltinFxId, value: number) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const unit = track.fxRack[fxId]
    setBuiltinFx(trackId, fxId, { ...unit, mix: Math.max(0, Math.min(1, value)) })
  }

  const changeBuiltinParam = (
    trackId: string,
    fxId: BuiltinFxId,
    key: keyof BuiltinFxParams,
    value: number,
  ) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const unit = track.fxRack[fxId]
    setBuiltinFx(trackId, fxId, { ...unit, params: { ...unit.params, [key]: value } })
  }

  // ---------------------------------------------------------- mixing console

  const patchTrack = (id: string, patch: Partial<TrackState>) => {
    commitTracks(
      tracksRef.current.map((track) => (track.id === id ? { ...track, ...patch } : track)),
    )
  }

  const changeTrim = (id: string, db: number) => {
    const value = clampNumber(db, -24, 24, 0)
    engineRef.current?.setTrim(id, dbToGain(value))
    patchTrack(id, { trimDb: value })
  }

  const togglePhaseInvert = (id: string) => {
    const track = tracksRef.current.find((item) => item.id === id)
    if (!track) return
    const next = !track.phaseInvert
    engineRef.current?.setPhaseInvert(id, next)
    patchTrack(id, { phaseInvert: next })
    notify(next ? 'Polaridade invertida (Ø)' : 'Polaridade normal')
  }

  const toggleMono = (id: string) => {
    const track = tracksRef.current.find((item) => item.id === id)
    if (!track) return
    const next = !track.mono
    engineRef.current?.setMono(id, next)
    patchTrack(id, { mono: next })
    notify(next ? 'Track reduzida para mono' : 'Track em estéreo')
  }

  const changeSend = (id: string, kind: 'rv' | 'dl', value: number) => {
    const next = clampNumber(value, 0, 1, 0)
    engineRef.current?.setTrackSend(id, kind, next)
    patchTrack(id, kind === 'rv' ? { rvSend: next } : { dlSend: next })
  }

  /** Channel-strip preset: FX rack + sends + trim in one click. */
  const applyMixPreset = (trackId: string, presetKey: string) => {
    const preset = MIX_PRESETS[presetKey]
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!preset || !track) return
    const patch = preset.patch()
    const order = chainWithEnabledRack(track.chain, patch.rack)
    const engine = engineRef.current
    if (engine) {
      for (const fxId of BUILTIN_FX_IDS) engine.setBuiltinFx(trackId, fxId, patch.rack[fxId])
      engine.setTrackSend(trackId, 'rv', patch.rvSend)
      engine.setTrackSend(trackId, 'dl', patch.dlSend)
      engine.setTrim(trackId, dbToGain(patch.trimDb))
      if (order.length !== track.chain.length) engine.setChainOrder(trackId, order)
    }
    patchTrack(trackId, {
      fxRack: patch.rack,
      chain: order,
      rvSend: patch.rvSend,
      dlSend: patch.dlSend,
      trimDb: patch.trimDb,
    })
    notify(`Mixagem "${preset.name}" aplicada`)
  }

  /** Back to a flat mix: no trim, no polarity flip, no mono, no sends. */
  const resetStaging = () => {
    const engine = engineRef.current
    commitTracks(
      tracksRef.current.map((track) => {
        if (engine) {
          engine.setTrim(track.id, 1)
          engine.setPhaseInvert(track.id, false)
          engine.setMono(track.id, false)
          engine.setTrackSend(track.id, 'rv', 0)
          engine.setTrackSend(track.id, 'dl', 0)
        }
        return { ...track, trimDb: 0, phaseInvert: false, mono: false, rvSend: 0, dlSend: 0 }
      }),
    )
    notify('Trim, fase, mono e envios zerados')
  }

  const setMasterFxUnit = (fxId: BuiltinFxId, unit: BuiltinFxUnit) => {
    engineRef.current?.setMasterFx(fxId, unit)
    setMasterFx((prev) => ({ ...prev, [fxId]: unit }) as BuiltinFxRack)
  }

  const toggleMasterFx = (fxId: BuiltinFxId) => {
    const unit = masterFx[fxId]
    setMasterFxUnit(fxId, { ...unit, enabled: !unit.enabled })
    notify(`${BUILTIN_FX_META[fxId].label} do master ${unit.enabled ? 'desligado' : 'ligado'}`)
  }

  const changeMasterFxMix = (fxId: BuiltinFxId, value: number) => {
    const unit = masterFx[fxId]
    setMasterFxUnit(fxId, { ...unit, mix: clampNumber(value, 0, 1, unit.mix) })
  }

  const changeMasterFxParam = (
    fxId: BuiltinFxId,
    key: keyof BuiltinFxParams,
    value: number,
  ) => {
    const unit = masterFx[fxId]
    setMasterFxUnit(fxId, { ...unit, params: { ...unit.params, [key]: value } })
  }

  const applyMasterPreset = (presetKey: string) => {
    const preset = MASTER_PRESETS[presetKey]
    if (!preset) return
    const rack = preset.rack()
    engineRef.current?.applyMasterFxPreset(rack)
    setMasterFx(rack)
    notify(`Master: "${preset.name}"`)
  }

  const changeSendConfig = (key: keyof SendConfig, value: number) => {
    const next = { ...sendConfig, [key]: value }
    engineRef.current?.setSendConfig(next)
    setSendConfig(next)
  }

  // ---------------------------------------------------------- audio import

  const importAudioFile = async (file: File, trackId: string) => {
    const engine = engineRef.current
    if (!engine) return
    try {
      const data = await file.arrayBuffer()
      const buffer = await engine.ctx.decodeAudioData(data)
      const previousId = tracksRef.current.find((track) => track.id === trackId)?.bufferId
      if (previousId) reclaimSample(previousId)
      const bufferId = newId()
      engine.setBuffer(trackId, buffer, bufferId)
      engine.setClipStart(trackId, 0)
      void saveSample(bufferId, encodeWav(buffer))
      const waveform = computePeaks(buffer)
      setPeaks((prev) => ({ ...prev, [trackId]: waveform }))
      commitTracks(
        tracksRef.current.map((track) =>
          track.id === trackId
            ? {
                ...track,
                clipStart: 0,
                clipDuration: buffer.duration,
                clipName: file.name,
                bufferId,
              }
            : track,
        ),
      )
      const stepDuration = 60 / bpm / 4
      const neededBars = Math.min(
        128,
        Math.ceil(Math.ceil(buffer.duration / stepDuration) / STEP_COUNT),
      )
      if (neededBars > arrangementBarsRef.current) {
        arrangementBarsRef.current = neededBars
        setArrangementBars(neededBars)
      }
      setSelectedTrackId(trackId)
      notify(`"${file.name}" importado (${buffer.duration.toFixed(1)}s)`)
    } catch (error) {
      notify(`Falha ao importar áudio: ${(error as Error).message}`)
    }
  }

  const openAudioImport = (trackId?: string) => {
    const target = trackId ?? selectedTrackId ?? tracksRef.current[0]?.id ?? null
    if (!target) {
      notify('Crie uma track primeiro')
      return
    }
    if (tracksRef.current.find((track) => track.id === target)?.kind === 'instrument') {
      notify('Track de instrumento grava notas MIDI, não áudio — use o editor')
      return
    }
    audioTargetRef.current = target
    // In the executable the operating system picks the file, so there is no
    // hidden <input> to click. The bytes come back and are imported the same way.
    if (isNativeApp()) {
      void nativeOpenAudio()
        .then((picked) => {
          if (!picked) return
          const name = /\.(wav|mp3|ogg|flac|m4a|aif|aiff|aac)$/i.test(picked.name)
            ? picked.name
            : `${picked.name}.wav`
          return importAudioFile(new File([new Uint8Array(picked.bytes)], name), target)
        })
        .catch((error: unknown) => notify(`Falha ao importar áudio: ${(error as Error).message}`))
      return
    }
    const input = audioInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const onAudioFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Fall back to the selection when the change did not come through
    // openAudioImport (e.g. assistive tools setting input.files directly).
    const target =
      audioTargetRef.current ?? selectedTrackId ?? tracksRef.current[0]?.id ?? null
    event.target.value = ''
    if (!file) return
    if (!target) {
      notify('Crie uma track primeiro')
      return
    }
    await importAudioFile(file, target)
  }

  const onLaneDrop = async (trackId: string, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const laneTrack = tracksRef.current.find((track) => track.id === trackId)
    if (laneTrack?.kind === 'instrument') {
      notify('Track de instrumento usa notas MIDI — desenhe no editor')
      return
    }
    const file = Array.from(event.dataTransfer.files).find(
      (item) => item.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aif|aiff|aac)$/i.test(item.name),
    )
    if (!file) {
      notify('Solte um arquivo de áudio (WAV, MP3, OGG, FLAC…)')
      return
    }
    await importAudioFile(file, trackId)
  }


  const startPlayback = (fromStep = Math.floor(playheadRef.current), useCountIn = true) => {
    const engine = engineRef.current
    if (!engine) return
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (schedulerIdRef.current !== null) {
      window.clearInterval(schedulerIdRef.current)
      schedulerIdRef.current = null
    }
    const stepDuration = 60 / bpm / 4
    const totalSteps = Math.max(1, arrangementBarsRef.current * STEP_COUNT)
    const start = Math.max(0, Math.min(totalSteps - 1, Math.round(fromStep)))
    void engine.resume()
    const when = engine.ctx.currentTime + 0.08
    playheadRef.current = start
    isPlayingRef.current = true
    engine.stopBuffers()
    // A lane whose plugin pass has not been rendered yet would play dry: start
    // those passes now, and remember which lanes were waiting so the pass that
    // lands first is heard from this same position instead of on the next play.
    const nativeSampleRate = engine.ctx.sampleRate
    const waitingForPlugin: string[] = []
    for (const track of tracksRef.current) {
      const key = nativePreviewKey(track, nativeSampleRate)
      if (!key || engine.monitorKey(track.id) === key) continue
      waitingForPlugin.push(track.id)
      const timer = previewTimers.current.get(track.id)
      if (timer) {
        window.clearTimeout(timer.id)
        previewTimers.current.delete(track.id)
      }
      if (!failedPreviewKeys.current.has(key)) void renderNativePreview(track.id, key)
    }
    pendingAtPlay.current = new Set(waitingForPlugin)
    if (useCountIn && countInRef.current && !isRecordingRef.current) {
      // One bar of count-in: the scheduler resumes the song at `start`.
      pendingBufferStartRef.current = start
      songStartRef.current = when + STEP_COUNT * stepDuration - start * stepDuration
      nextStepRef.current = countInStart(start, STEP_COUNT)
      nextTimeRef.current = when
      setPlayheadStep(start)
      setIsPlaying(true)
      notify('Count-in — 1 compasso')
      return
    }
    pendingBufferStartRef.current = null
    songStartRef.current = when - start * stepDuration
    nextStepRef.current = start
    nextTimeRef.current = when
    engine.startBuffersAt(when, stepDuration, start)
    setPlayheadStep(start)
    setIsPlaying(true)
  }

  const togglePlay = () => {
    if (isPlaying) stopPlayback()
    else startPlayback()
  }

  const seek = (step: number) => {
    const total = Math.max(1, arrangementBars * STEP_COUNT)
    const clamped = Math.max(0, Math.min(total - 1, step))
    if (isPlaying) {
      stopPlayback()
      window.setTimeout(() => startPlayback(clamped, false), 60)
    } else {
      setPlayheadStep(clamped)
    }
  }

  /**
   * Song position from the audio clock rather than from the painted playhead.
   * The playhead state only moves on requestAnimationFrame, and a browser stops
   * serving frames for a window that is hidden or fully covered, so everything
   * that stamps a step for the arrangement (a take's start, a recorded note)
   * reads the clock instead. Same number while you can see the app, still the
   * right number when you cannot.
   */
  const songStepNow = () => {
    const engine = engineRef.current
    // Stopped: the painted playhead is the only honest position there is.
    if (!engine || !isPlayingRef.current) return playheadRef.current
    const stepDuration = 60 / bpmRef.current / 4
    const raw = (engine.ctx.currentTime - songStartRef.current) / stepDuration
    if (!Number.isFinite(raw) || raw < 0) return playheadRef.current
    // A running take never wraps: the arrangement grows around it.
    if (isRecordingRef.current) return raw
    const total = Math.max(1, arrangementBarsRef.current * STEP_COUNT)
    return ((raw % total) + total) % total
  }

  // -------------------------------------------------------------- recording

  /** Armed tracks that can capture, split by the kind of thing they capture. */
  const recordableTracks = () => {
    const armed = tracksRef.current.filter((track) => track.isArmed)
    return {
      armed,
      // Uma faixa de sala tem o mesmo direito de gravar que uma de hardware: o
      // que ela imprime é o stream do participante, só que vem do cabo em vez de
      // vir de uma placa — por isso a chave dela é `callChannelKey`.
      audio: armed.filter(
        (track) => track.kind !== 'instrument' && (track.inputDeviceId || track.callChannelKey),
      ),
      midi: armed.filter((track) => track.kind === 'instrument'),
    }
  }

  /**
   * Open the capture window. The playhead is read only after the recorder is
   * actually running: arming the mic takes real time, and stamping the position
   * before that would place every take early by exactly that delay.
   */
  /**
   * Open the capture window. `anchorStep` is the step the take starts on when the
   * caller already knows it — the downbeat a count-in just landed on — because the
   * transport's own position is a few milliseconds late by the time the recorder
   * answers, and a take anchored late would sit off the grid against every other
   * lane recorded with it.
   */
  const openTake = async (anchorStep?: number): Promise<{ audio: number; midi: number } | null> => {
    const engine = engineRef.current
    if (!engine) return null
    const { audio, midi } = recordableTracks()
    if (audio.length === 0 && midi.length === 0) return null
    const started =
      audio.length > 0 ? await engine.startRecording(audio.map((track) => track.id)) : []
    recordStartRef.current =
      anchorStep ?? punchStartStep(punchBoundsRef.current, songStepNow())
    if (started.length === 0 && midi.length === 0) return null
    midiPendingRef.current.clear()
    midiTakeCountRef.current = 0
    takeOpenRef.current = true
    return { audio: started.length, midi: midi.length }
  }

  /** Close the capture window and put the take on the lane (and on the shelf). */
  const finishTake = async () => {
    const engine = engineRef.current
    const punched = punchBoundsRef.current !== null
    takeOpenRef.current = false
    punchBoundsRef.current = null
    setIsRecording(false)
    setTakeProgress({})
    if (!engine) return
    // Finish notes that were still held when the take stopped.
    for (const [key, pending] of [...midiPendingRef.current]) {
      midiPendingRef.current.delete(key)
      const track = tracksRef.current.find((item) => item.id === pending.trackId)
      if (!track || track.kind !== 'instrument') continue
      const end = Math.max(pending.step + 1, Math.round(songStepNow()))
      midiTakeCountRef.current += 1
      setMidiNotes(
        track.id,
        sortNotes([
          ...track.midiNotes,
          {
            step: pending.step,
            pitch: pending.pitch,
            length: Math.min(64, end - pending.step),
            velocity: Math.max(0.1, pending.velocity),
          },
        ]),
      )
    }
    const hadMidi = midiTakeCountRef.current > 0
    const buffers = await engine.stopRecording()
    if (buffers.size === 0 && !hadMidi) {
      notify('Gravação vazia')
      return
    }
    if (buffers.size === 0) {
      notify(`MIDI gravado — ${midiTakeCountRef.current} nota(s) capturadas`)
      return
    }
    const stepDuration = 60 / bpm / 4
    // What you hear through the monitors arrives `recordLatencyMs` late, so a
    // take sung exactly on the beat lands behind the grid by the same amount.
    // Placing the clip earlier puts it back where the performance belongs.
    const startedAt = Math.max(
      0,
      recordStartRef.current - (recordLatencyMs >= 0 ? recordLatencyMs : autoLatencyMs) / 1000 / stepDuration,
    )
    const durations = new Map<string, number>()
    const bufferIds = new Map<string, string>()
    const shelfByTrack = new Map<string, AudioTake[]>()
    const clipNames = new Map<string, string>()
    buffers.forEach((buffer, trackId) => {
      const previous = tracksRef.current.find((track) => track.id === trackId)
      const bufferId = newId()
      engine.setBuffer(trackId, buffer, bufferId)
      engine.setClipStart(trackId, startedAt)
      durations.set(trackId, buffer.duration)
      // The pass that was sitting on this lane goes on the shelf, not in the
      // bin: a singer rarely wants the good take thrown away by the next one.
      const shelf = [...(previous?.takes ?? [])]
      if (previous && previous.bufferId && previous.clipDuration > 0) {
        shelf.push({
          id: previous.bufferId,
          name: previous.clipName || `Take ${shelf.length + 1}`,
          start: previous.clipStart,
          duration: previous.clipDuration,
          fadeIn: previous.fadeIn,
          fadeOut: previous.fadeOut,
        })
      }
      while (shelf.length > MAX_TAKES) {
        const dropped = shelf.shift()
        if (dropped) reclaimSample(dropped.id)
      }
      shelfByTrack.set(trackId, shelf)
      clipNames.set(trackId, `Take ${shelf.length + 1}`)
      bufferIds.set(trackId, bufferId)
      void saveSample(bufferId, encodeWav(buffer))
      const waveform = computePeaks(buffer)
      setPeaks((prev) => ({ ...prev, [trackId]: waveform }))
    })

    // Make sure the arrangement covers the whole take.
    let longest = 0
    durations.forEach((duration) => {
      if (duration > longest) longest = duration
    })
    const endStep = startedAt + Math.ceil(longest / stepDuration)
    const neededBars = Math.min(128, Math.ceil(endStep / STEP_COUNT))
    if (neededBars > arrangementBarsRef.current) {
      arrangementBarsRef.current = neededBars
      setArrangementBars(neededBars)
    }
    commitTracks(
      tracksRef.current.map((track) => {
        const duration = durations.get(track.id)
        return duration === undefined
          ? track
          : {
              ...track,
              clipStart: startedAt,
              clipDuration: duration,
              clipName: clipNames.get(track.id) ?? 'Take gravado',
              bufferId: bufferIds.get(track.id) ?? '',
              takes: shelfByTrack.get(track.id) ?? track.takes,
            }
      }),
    )
    const shelfSize = Math.max(0, ...[...shelfByTrack.values()].map((shelf) => shelf.length))
    const shelfNote = shelfSize > 1 ? ` — ${shelfSize} takes nesta track` : ''
    notify(
      punched
        ? `Punch encerrado${shelfNote}, o take ficou na área`
        : shelfSize > 1
          ? `Gravação concluída${shelfNote}, escolha no seletor "takes"`
          : 'Gravação concluída — o clipe ficou no compasso em que você começou',
    )
  }

  const toggleRecord = async () => {
    const engine = engineRef.current
    if (!engine) return

    if (!isRecording) {
      const { armed, audio, midi } = recordableTracks()
      if (armed.length === 0) {
        notify('Arme uma track (botão "ar") antes de gravar')
        return
      }
      if (audio.length === 0 && midi.length === 0) {
        notify('Selecione a entrada da track (IN) — ou arme uma track de instrumento p/ MIDI')
        return
      }

      if (punchInRef.current) {
        // Punch-in records only inside the selected area, so it needs one.
        const total = Math.max(1, arrangementBarsRef.current * STEP_COUNT)
        const bounds = punchBoundsOf(timeSelRef.current, total)
        if (!bounds) {
          notify('Punch-in precisa de uma área selecionada — arraste com Shift na régua ou na lane')
          return
        }
        punchBoundsRef.current = bounds
        midiPendingRef.current.clear()
        midiTakeCountRef.current = 0
        setIsRecording(true)
        // Roll from wherever the playhead already is when that is before the
        // region, otherwise from a bar ahead of it, so there is always context
        // to play into. The recorder itself only opens at `from`.
        const here = Math.floor(songStepNow())
        const lead = punchLeadStep(here, bounds.from, STEP_COUNT)
        if (!isPlaying || here > bounds.from) startPlayback(lead, false)
        notify(
          `Punch armado de ${barBeatOf(bounds.from)} até ${barBeatOf(bounds.to)} — o gravador abre sozinho`,
        )
        return
      }

      try {
        // A recording program counts before it rolls: with count-in on, the
        // transport plays one bar of clicks and the capture window opens itself on
        // the downbeat — the way a tape machine drops into record after the count.
        const countFirst = countInRef.current && !isPlaying
        if (!isPlaying) startPlayback(Math.floor(playheadRef.current), countFirst)
        if (countFirst) {
          recordGateRef.current = (downbeat) => {
            void openTake(downbeat)
              .then((taken) => {
                if (!taken) {
                  notify('Nenhuma entrada ativa para gravar')
                  return
                }
                setIsRecording(true)
                notify(
                  taken.audio === 0
                    ? 'Girando — MIDI sendo capturado'
                    : `Gravando em ${taken.audio} track(s) desde o 1º tempo`,
                )
              })
              .catch((error) => notify(`Falha ao gravar: ${(error as Error).message}`))
          }
          notify('Count-in — o gravador abre no 1º tempo')
          return
        }
        const taken = await openTake()
        if (!taken) {
          notify('Nenhuma entrada ativa para gravar')
          return
        }
        setIsRecording(true)
        notify(
          taken.audio === 0
            ? `Gravando MIDI em ${taken.midi} track(s) de instrumento`
            : `Gravando em ${taken.audio} track(s) — gravação contínua`,
        )
      } catch (error) {
        notify(`Falha ao gravar: ${(error as Error).message}`)
      }
      return
    }

    await finishTake()
  }

  /**
   * Scheduler hook for a punch pass: open the capture window when the audio
   * clock enters the region, close it when the clock leaves. It lives here
   * because the scheduler runs on a timer, so a punch still lands correctly
   * even if the tab stops painting.
   */
  const runPunchGate = () => {
    const bounds = punchBoundsRef.current
    if (!bounds || !engineRef.current || punchBusyRef.current) return
    const action = punchAction(bounds, songStepNow(), takeOpenRef.current)
    if (action === 'close') {
      punchBusyRef.current = true
      void finishTake().finally(() => {
        punchBusyRef.current = false
      })
      return
    }
    if (action === 'missed') {
      // The playhead reached the end of the region while the input was still
      // arming: nothing inside the region was captured, so say so rather than
      // keeping a take that belongs to the wrong bars.
      takeOpenRef.current = false
      punchBoundsRef.current = null
      setIsRecording(false)
      notify('Punch cancelado — a entrada não abriu a tempo')
      return
    }
    if (action !== 'open') return
    punchBusyRef.current = true
    void (async () => {
      try {
        const taken = await openTake()
        if (taken) {
          notify(
            taken.audio > 0
              ? `Punch gravando ${taken.audio} entrada(s)`
              : `Punch gravando MIDI em ${taken.midi} track(s)`,
          )
        } else {
          punchBoundsRef.current = null
          setIsRecording(false)
          notify('Punch cancelado — nenhuma entrada pôde abrir')
        }
      } catch (error) {
        punchBoundsRef.current = null
        setIsRecording(false)
        notify(`Falha no punch: ${(error as Error).message}`)
      } finally {
        punchBusyRef.current = false
      }
    })()
  }

  useEffect(() => {
    punchGateRef.current = runPunchGate
  })

  /** Put a stored take back on the lane; the clip it replaces goes on the shelf. */
  const activateTake = async (trackId: string, takeId: string) => {
    const engine = engineRef.current
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!engine || !track) return
    const take = track.takes.find((item) => item.id === takeId)
    if (!take) return
    if (take.id === track.bufferId) return
    const blob = await loadSample(take.id)
    if (!blob) {
      notify('O áudio desse take não está mais no armazenamento')
      return
    }
    const buffer = await engine.ctx.decodeAudioData(await blob.arrayBuffer())
    // The take being put to work leaves the shelf, the clip being pushed out
    // joins it, so the lane always holds exactly one performance.
    const shelf = track.takes.filter((item) => item.id !== take.id)
    if (track.bufferId && track.clipDuration > 0) {
      shelf.push({
        id: track.bufferId,
        name: track.clipName || 'Take',
        start: track.clipStart,
        duration: track.clipDuration,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
      })
    }
    const duration = Math.min(take.duration > 0 ? take.duration : buffer.duration, buffer.duration)
    engine.setBuffer(trackId, buffer, take.id)
    engine.setClipDuration(trackId, duration)
    engine.setClipStart(trackId, take.start)
    engine.setClipFade(trackId, take.fadeIn, take.fadeOut)
    const ratio = Math.min(1, duration / Math.max(buffer.duration, 0.0001))
    setPeaks((prev) => ({
      ...prev,
      [trackId]: computePeaks(buffer).slice(0, Math.max(1, Math.round(260 * ratio))),
    }))
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId
          ? {
              ...item,
              takes: shelf,
              bufferId: take.id,
              clipStart: take.start,
              clipDuration: duration,
              clipName: take.name,
              fadeIn: take.fadeIn,
              fadeOut: take.fadeOut,
            }
          : item,
      ),
    )
    notify(`Take "${take.name}" em uso em ${track.name}`)
  }

  /** Throw the shelf away and keep only what is on the lane right now. */
  const dropTakes = (trackId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track || track.takes.length === 0) return
    for (const take of track.takes) reclaimSample(take.id)
    commitTracks(
      tracksRef.current.map((item) => (item.id === trackId ? { ...item, takes: [] } : item)),
    )
    notify(`Caiu a ficha: ${track.takes.length} take(s) descartados de ${track.name}`)
  }

  const clearClip = (id: string) => {
    const target = tracksRef.current.find((track) => track.id === id)
    if (target?.bufferId) reclaimSample(target.bufferId)
    // Deleting the clip means deleting the performance, shelf included.
    for (const take of target?.takes ?? []) reclaimSample(take.id)
    engineRef.current?.setBuffer(id, null)
    engineRef.current?.setClipStart(id, 0)
    setPeaks((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === id
          ? { ...track, clipStart: 0, clipDuration: 0, clipName: '', bufferId: '', takes: [] }
          : track,
      ),
    )
    notify('Clipe removido')
  }

  // --------------------------------------------------- audio clip clipboard

  const selectedAudioTrack = (): TrackState | null => {
    const id = selectedRef.current
    if (!id) return null
    const track = tracksRef.current.find((item) => item.id === id) ?? null
    return track && track.kind === 'audio' ? track : null
  }

  const resolveAudioTrack = (trackId?: string): TrackState | null => {
    if (trackId) {
      const track = tracksRef.current.find((item) => item.id === trackId) ?? null
      return track && track.kind === 'audio' ? track : null
    }
    return selectedAudioTrack()
  }

  const copyAudioClip = async (trackId?: string) => {
    const track = resolveAudioTrack(trackId)
    if (!track) {
      notify('Selecione uma track de áudio com gravação para copiar')
      return
    }
    if (!track.bufferId || track.clipDuration <= 0) {
      notify('Essa track ainda não tem áudio gravado')
      return
    }
    const blob = await loadSample(track.bufferId)
    if (!blob) {
      notify('Amostra não encontrada — recarregue o projeto')
      return
    }
    audioClipboardRef.current = {
      blob,
      name: track.clipName || track.name,
      duration: track.clipDuration,
    }
    notify(`Áudio de "${track.name}" copiado (${track.clipDuration.toFixed(1)}s)`)
  }

  const cutAudioClip = async (trackId?: string) => {
    const track = resolveAudioTrack(trackId)
    if (!track || !track.bufferId || track.clipDuration <= 0) {
      await copyAudioClip(trackId)
      return
    }
    const blob = await loadSample(track.bufferId)
    if (!blob) {
      notify('Amostra não encontrada — nada foi cortado')
      return
    }
    audioClipboardRef.current = {
      blob,
      name: track.clipName || track.name,
      duration: track.clipDuration,
    }
    clearClip(track.id)
    notify(`Áudio de "${track.name}" cortado`)
  }

  // Applies a decoded buffer to a track and persists it under a fresh id.
  const applyClipBuffer = (trackId: string, buffer: AudioBuffer, name: string, startStep: number) => {
    const engine = engineRef.current
    if (!engine) return
    const previousId = tracksRef.current.find((track) => track.id === trackId)?.bufferId
    if (previousId) reclaimSample(previousId)
    const bufferId = newId()
    void saveSample(bufferId, encodeWav(buffer))
    engine.setBuffer(trackId, buffer, bufferId)
    engine.setClipStart(trackId, startStep)
    setPeaks((prev) => ({ ...prev, [trackId]: computePeaks(buffer) }))
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === trackId
          ? { ...track, clipStart: startStep, clipDuration: buffer.duration, clipName: name, bufferId }
          : track,
      ),
    )
  }

  const pasteAudioClip = async (preferredTrackId?: string, atStep?: number) => {
    const clip = audioClipboardRef.current
    const engine = engineRef.current
    if (!clip || !engine) {
      notify('Nada para colar — copie um áudio primeiro (Ctrl+C)')
      return
    }
    await engine.resume()
    let buffer: AudioBuffer
    try {
      const data = await clip.blob.arrayBuffer()
      buffer = await engine.ctx.decodeAudioData(data)
    } catch {
      notify('Não foi possível decodificar o áudio copiado')
      return
    }
    const startStep = Math.floor(atStep ?? playheadRef.current)
    const explicit = preferredTrackId
      ? tracksRef.current.find(
          (item) => item.id === preferredTrackId && item.kind === 'audio',
        ) ?? null
      : null
    const target = explicit ?? selectedAudioTrack()
    // Explicit target always receives the clip; otherwise prefer an empty
    // selected audio track and fall back to creating a fresh one.
    if (target && (explicit || !target.bufferId || target.clipDuration <= 0)) {
      applyClipBuffer(target.id, buffer, clip.name, startStep)
      notify(`Colado em "${target.name}"`)
      return
    }
    const copy: TrackState = {
      ...makeTrack(tracksRef.current.length, undefined, 'audio'),
      name: `${clip.name || 'Áudio'} (colar)`,
    }
    syncTrackToEngine(copy)
    const next = [...tracksRef.current, copy]
    commitTracks(next.map((track, index) => ({ ...track, number: index + 1 })))
    setSelectedTrackId(copy.id)
    applyClipBuffer(copy.id, buffer, clip.name, startStep)
    const stepDuration = 60 / bpm / 4
    const endStep = startStep + Math.ceil(buffer.duration / stepDuration)
    const neededBars = Math.min(128, Math.ceil(endStep / STEP_COUNT))
    if (neededBars > arrangementBarsRef.current) {
      changeBars(neededBars)
    }
    notify(`Colado em nova track "${copy.name}"`)
  }

  // Routes the clipboard actions to whatever the selected track holds:
  // recorded audio on an audio track, a pattern on an instrument track.
  const copySelection = (trackId?: string): void => {
    const id = trackId ?? selectedRef.current ?? undefined
    const track = id ? tracksRef.current.find((item) => item.id === id) ?? null : null
    // A box open in the editor edits notes, not whole clips.
    if (!trackId && midiEditorId && rollSel && copyRollSelection()) return
    if (track && track.kind === 'instrument') {
      copyMidiPattern(track.id)
      return
    }
    void copyAudioClip(track?.id)
  }

  const cutSelection = (trackId?: string): void => {
    const id = trackId ?? selectedRef.current ?? undefined
    const track = id ? tracksRef.current.find((item) => item.id === id) ?? null : null
    if (!trackId && midiEditorId && rollSel && cutRollSelection()) return
    if (track && track.kind === 'instrument') {
      cutMidiPattern(track.id)
      return
    }
    void cutAudioClip(track?.id)
  }

  const pasteSelection = (trackId?: string, atStep?: number): void => {
    const id = trackId ?? selectedRef.current ?? undefined
    const track = id ? tracksRef.current.find((item) => item.id === id) ?? null : null
    if (!trackId && midiEditorId && pasteRollSelection()) return
    if (track && track.kind === 'instrument') {
      pasteMidiPattern(track.id, atStep)
      return
    }
    void pasteAudioClip(track?.id, atStep)
  }

  // ------------------------------------------------------------- midi clips

  const setMidiNotes = (trackId: string, notes: InstrumentNote[]) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    engineRef.current?.setNotes(trackId, notes, track?.patternSteps ?? 0)
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === trackId ? { ...track, midiNotes: notes } : track,
      ),
    )
  }

  const clearNotes = (trackId: string) => {
    setMidiNotes(trackId, [])
    notify('Pattern MIDI limpo')
  }

  /**
   * Change the loop length of an instrument track. The notes fold into the new
   * bar (two hits on the same cell keep the stronger one) so a groove you
   * played across four bars survives being cut down to one.
   */
  const setPatternSteps = (trackId: string, steps: number) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const next = normalizePatternSteps(steps)
    const notes = next > 0 ? foldIntoPattern(track.midiNotes, next) : track.midiNotes
    engineRef.current?.setNotes(trackId, notes, next)
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, patternSteps: next, midiNotes: notes } : item,
      ),
    )
    notify(
      next > 0
        ? `Loop de ${Math.max(1, Math.round(next / STEP_COUNT))} compasso(s) — o pattern se repete`
        : 'Loop desligado — as notas ficam onde foram postas',
    )
  }

  /** Load a one-bar groove, cycled to fill the track's current loop. */
  const applyGroove = (trackId: string, presetId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    const preset = GROOVE_PRESETS.find((item) => item.id === presetId)
    if (!track || !preset) return
    const steps = track.patternSteps > 0 ? track.patternSteps : 16
    const notes = grooveNotes(preset, steps)
    engineRef.current?.setNotes(trackId, notes, steps)
    commitTracks(
      tracksRef.current.map((item) =>
        item.id === trackId ? { ...item, patternSteps: steps, midiNotes: notes } : item,
      ),
    )
    notify(`Padrão "${preset.label}" carregado em "${track.name}"`)
  }

  // ------------------------------------------------------ step sequencer grid

  // Column width follows the loop length so a 16 step bar stays comfortable
  // and a 4 bar pattern still fits the window without horizontal scrolling.
  // It is measured rather than fixed: a hard 28 px column leaves a dead band on
  // the right of a one-bar pattern on any wide screen, and the hit-testing has
  // to use the same number the drawing uses.
  const seqScrollRef = useRef<HTMLDivElement | null>(null)
  const [seqAvail, setSeqAvail] = useState(0)
  useEffect(() => {
    const node = seqScrollRef.current
    if (!node) return
    const measure = () => setSeqAvail(Math.max(0, node.clientWidth - SEQ_KEYS_W))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [midiEditorId])

  const seqColumnWidth = (patternSteps: number) => {
    if (!seqAvail) return patternSteps <= 16 ? 28 : patternSteps <= 32 ? 22 : 16
    return Math.min(44, Math.max(16, Math.floor(seqAvail / Math.max(1, patternSteps))))
  }

  const seqRowHeight = 26

  const seqCellAt = (
    event: ReactPointerEvent<HTMLDivElement>,
    patternSteps: number,
  ): { step: number; pitch: number } | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    const colW = seqColumnWidth(patternSteps)
    const step = Math.floor((event.clientX - rect.left) / colW)
    const lane = Math.floor((event.clientY - rect.top) / seqRowHeight)
    if (step < 0 || step >= patternSteps) return null
    if (lane < 0 || lane >= DRUM_PIECES.length) return null
    return { step, pitch: DRUM_PIECES[lane].pitch }
  }

  /**
   * Painting the grid. Pressing an empty cell and dragging adds; pressing a hit
   * and dragging removes — the same lock hardware boxes use, so a hi-hat line
   * is one drag instead of sixteen clicks. Shift accents what you add.
   */
  const seqPaintRef = useRef<{
    trackId: string
    action: 'add' | 'remove'
    cell: string
  } | null>(null)

  const paintSeqCell = (
    trackId: string,
    cell: { step: number; pitch: number },
    add: boolean,
    accent: boolean,
  ) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const exists = track.midiNotes.some(
      (note) => note.pitch === cell.pitch && note.step === cell.step,
    )
    if (add) {
      // Shift on a cell that is already on re-arms it as an accent, which is how
      // a hardware box gives a hit two strengths without a second page of edits.
      const velocity = accent ? 1 : 0.85
      if (exists) {
        setMidiNotes(
          trackId,
          track.midiNotes.map((note) =>
            note.pitch === cell.pitch && note.step === cell.step ? { ...note, velocity } : note,
          ),
        )
        return
      }
      const note: InstrumentNote = { step: cell.step, pitch: cell.pitch, length: 1, velocity }
      setMidiNotes(trackId, sortNotes([...track.midiNotes, note]))
      previewNote(track, cell.pitch, 1)
      return
    }
    if (!exists) return
    setMidiNotes(
      trackId,
      track.midiNotes.filter((note) => !(note.pitch === cell.pitch && note.step === cell.step)),
    )
  }

  const onSeqPointerDown = (event: ReactPointerEvent<HTMLDivElement>, track: TrackState) => {
    if (event.button !== 0 || !isPatterned(track.patternSteps)) return
    const cell = seqCellAt(event, track.patternSteps)
    if (!cell) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
    const hit = track.midiNotes.some((note) => note.pitch === cell.pitch && note.step === cell.step)
    const action = hit && !event.shiftKey ? 'remove' : 'add'
    seqPaintRef.current = { trackId: track.id, action, cell: `${cell.step}:${cell.pitch}` }
    paintSeqCell(track.id, cell, action === 'add', event.shiftKey)
  }

  const onSeqPointerMove = (event: ReactPointerEvent<HTMLDivElement>, track: TrackState) => {
    const paint = seqPaintRef.current
    if (!paint || paint.trackId !== track.id) return
    const cell = seqCellAt(event, track.patternSteps)
    if (!cell) return
    const key = `${cell.step}:${cell.pitch}`
    if (key === paint.cell) return
    paint.cell = key
    paintSeqCell(track.id, cell, paint.action === 'add', event.shiftKey)
  }

  const endSeqPaint = (event: ReactPointerEvent<HTMLDivElement>) => {
    seqPaintRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* capture was never taken */
    }
  }

  /**
   * The drum machine view: one column per step of the loop, one row per piece.
   * The grid lines come from CSS gradients instead of cells — a 64 × 17 board
   * would be a thousand divs repainted on every playhead tick — so the only
   * real elements are the hits, one per note.
   */
  const renderStepSequencer = (track: TrackState) => {
    const colW = seqColumnWidth(track.patternSteps)
    const rowH = seqRowHeight
    const steps = track.patternSteps
    const width = steps * colW
    // Narrow columns cannot fit every number; label the beat group instead.
    const every = colW >= 24 ? 1 : colW >= 18 ? 2 : 4
    return (
      <div className="seq-scroll" ref={seqScrollRef}>
        <div
          className="seq-layout"
          style={{ gridTemplateColumns: `${SEQ_KEYS_W}px ${width}px` }}
        >
          <div className="seq-corner">
            <span className="seq-corner-label">
              {Math.max(1, Math.round(steps / STEP_COUNT))} comp.
            </span>
          </div>
          <div className="seq-ruler" style={{ width }}>
            {Array.from({ length: steps }, (_, step) => (
              <span
                key={step}
                className={`seq-step-label ${(step + 1) % 4 === 0 ? 'beat' : ''}`}
                style={{ left: step * colW, width: colW }}
              >
                {(step + 1) % every === 0 ? step + 1 : ''}
              </span>
            ))}
          </div>
          <div className="seq-keys">
            {DRUM_PIECES.map((piece, pieceIndex) => {
              const count = track.midiNotes.filter((note) => note.pitch === piece.pitch).length
              const key = DRUM_PIECE_KEYS[pieceIndex]
              const held = pcHeldPieces.includes(pieceIndex)
              return (
                <button
                  type="button"
                  key={piece.pitch}
                  className={`seq-lane ${count > 0 ? 'on' : ''} ${held ? 'held' : ''}`}
                  style={{ height: rowH }}
                  title={`Tocar ${piece.label} · ${count} toque(s) no loop${key ? ` · tecla ${key}` : ''}`}
                  onClick={() => previewNote(track, piece.pitch, 1)}
                >
                  {key ? <span className="seq-lane-key">{key}</span> : null}
                  <span className="seq-lane-name">{piece.label}</span>
                  <span className="seq-lane-count">{count > 0 ? count : ''}</span>
                </button>
              )
            })}
          </div>
          <div
            className="seq-grid"
            style={{
              width,
              height: DRUM_PIECES.length * rowH,
              backgroundSize: `${colW * STEP_COUNT}px 100%, ${colW * 4}px 100%, 100% ${rowH}px`,
            }}
            title="Clique para acender · arraste para pintar · Shift = acento · clique no toque para apagar"
            onPointerDown={(event) => onSeqPointerDown(event, track)}
            onPointerMove={(event) => onSeqPointerMove(event, track)}
            onPointerUp={endSeqPaint}
            onPointerCancel={endSeqPaint}
          >
            <div className="seq-column" style={{ left: seqPlayStep * colW, width: colW }} />
            {track.midiNotes.map((note, index) => {
              const lane = DRUM_PIECES.findIndex((piece) => piece.pitch === note.pitch)
              if (lane < 0) return null
              return (
                <div
                  key={`${note.pitch}-${note.step}-${index}`}
                  className={`seq-hit ${note.velocity >= 1 ? 'accent' : ''}`}
                  style={{
                    left: note.step * colW + 2,
                    top: lane * rowH + 2,
                    // A hit recorded as a sustained note (from a MIDI keyboard)
                    // is drawn as long as it actually sounds.
                    width: Math.max(1, note.length) * colW - 4,
                    height: rowH - 4,
                    opacity: 0.42 + note.velocity * 0.58,
                    background: track.color,
                  }}
                  title={`${DRUM_PIECES[lane].label} · passo ${note.step + 1}${
                    note.length > 1 ? ` · ${note.length} passo(s)` : ''
                  } · vel ${Math.round(note.velocity * 127)}`}
                />
              )
            })}
            <div className="seq-playhead" style={{ left: seqPlayStep * colW }} />
          </div>
          <div className="seq-vel-label" title="Intensidade de todos os toques do passo">
            Vel
          </div>
          <div
            className="seq-vel"
            style={{
              width,
              height: SEQ_VEL_H,
              backgroundSize: `${colW * 4}px 100%`,
            }}
            title="Arraste na vertical para mudar a força de todos os toques daquela coluna"
            onPointerDown={(event) => onSeqVelPointerDown(event, track, colW, steps)}
            onPointerMove={(event) => onSeqVelPointerMove(event, colW, steps)}
            onPointerUp={onSeqVelPointerUp}
            onPointerCancel={onSeqVelPointerUp}
          >
            {Array.from({ length: steps }, (_, step) => {
              const heldValue = seqVelDrag && seqVelDrag.step === step ? seqVelDrag.velocity : 0
              const value = heldValue || seqVelocityAt(track, step)
              return (
                <span
                  key={step}
                  className={`seq-vel-bar ${value > 0 ? 'on' : ''} ${
                    seqVelDrag && seqVelDrag.step === step ? 'active' : ''
                  }`}
                  style={{
                    left: step * colW + 1,
                    width: Math.max(2, colW - 3),
                    height: `${Math.round(value * 100)}%`,
                  }}
                  title={`Passo ${step + 1} · ${Math.round(value * 100)}%`}
                />
              )
            })}
          </div>
        </div>
      </div>
    )
  }


  // ------------------------------------------------- midi pattern clipboard

  const resolveMidiTrack = (trackId?: string): TrackState | null => {
    const id = trackId ?? selectedRef.current
    if (!id) return null
    const track = tracksRef.current.find((item) => item.id === id) ?? null
    return track && track.kind === 'instrument' ? track : null
  }

  const copyMidiPattern = (trackId?: string): boolean => {
    const track = resolveMidiTrack(trackId)
    if (!track) {
      notify('Selecione uma track de instrumento para copiar o pattern')
      return false
    }
    if (track.midiNotes.length === 0) {
      notify('Essa track ainda não tem pattern')
      return false
    }
    let start = Infinity
    for (const note of track.midiNotes) start = Math.min(start, note.step)
    midiClipboardRef.current = {
      // Relative to the pattern start so a paste can reposition it freely.
      notes: track.midiNotes.map((note) => ({ ...note, step: note.step - start })),
      instrument: track.instrument,
      name: track.name,
    }
    notify(`Pattern de "${track.name}" copiado (${track.midiNotes.length} nota(s))`)
    return true
  }

  const cutMidiPattern = (trackId?: string): void => {
    const track = resolveMidiTrack(trackId)
    if (!copyMidiPattern(trackId) || !track) return
    clearNotes(track.id)
    notify(`Pattern de "${track.name}" cortado`)
  }

  const pasteMidiPattern = (preferredTrackId?: string, atStep?: number): void => {
    const clip = midiClipboardRef.current
    if (!clip) {
      notify('Nada para colar — copie um pattern primeiro (Ctrl+C)')
      return
    }
    const base = Math.max(0, Math.floor(atStep ?? playheadRef.current))
    const notes = clip.notes.map((note) => ({ ...note, step: note.step + base }))
    const explicit = preferredTrackId
      ? tracksRef.current.find((item) => item.id === preferredTrackId) ?? null
      : null
    const target = explicit ?? resolveMidiTrack()
    if (target && target.kind === 'instrument' && (explicit || target.midiNotes.length === 0)) {
      setMidiNotes(target.id, notes)
      notify(`Pattern colado em "${target.name}"`)
      return
    }
    const copy: TrackState = {
      ...makeTrack(tracksRef.current.length, undefined, 'instrument', clip.instrument),
      name: `${clip.name || 'MIDI'} (colar)`,
      voice: defaultVoice(clip.instrument),
    }
    syncTrackToEngine(copy)
    commitTracks(
      [...tracksRef.current, copy].map((track, index) => ({ ...track, number: index + 1 })),
    )
    setSelectedTrackId(copy.id)
    setMidiNotes(copy.id, notes)
    let endStep = 1
    for (const note of notes) endStep = Math.max(endStep, note.step + note.length)
    const neededBars = Math.min(128, Math.ceil(endStep / STEP_COUNT))
    if (neededBars > arrangementBarsRef.current) changeBars(neededBars)
    notify(`Pattern colado em nova track "${copy.name}"`)
  }

  // ------------------------------------------------------- clip trim (edge)

  const trimClipEnd = (trackId: string, seconds: number): void => {
    const engine = engineRef.current
    if (!engine) return
    const max = engine.getBufferDuration(trackId)
    if (max <= 0) return
    const value = Math.max(0.05, Math.min(max, seconds))
    engine.setClipDuration(trackId, value)
    patchTrack(trackId, { clipDuration: value })
  }

  /**
   * Razor. A lane carries one take, so the cut keeps the head where it is and
   * puts the tail on a fresh lane right below — same folder, same colour, and
   * both pieces stay exactly on the grid where the audio already was. Returns
   * the new lane's id, or null when the cut point misses the clip.
   */
  const splitTakeAt = (trackId: string, atStep: number): string | null => {
    const engine = engineRef.current
    const list = tracksRef.current
    const index = list.findIndex((track) => track.id === trackId)
    const track = index >= 0 ? list[index] : null
    if (!engine || !track || track.kind !== 'audio' || !track.bufferId) return null
    const stepDuration = 60 / bpm / 4
    const cut = (atStep - track.clipStart) * stepDuration
    if (cut < 0.02 || cut > track.clipDuration - 0.02) return null
    const tail = engine.sliceBuffer(track.id, cut, track.clipDuration)
    if (!tail) return null
    // Head first: shrinking is what makes room for the tail to sit next to it.
    engine.setClipDuration(track.id, cut)
    const copy: TrackState = {
      ...makeTrack(list.length, undefined, 'audio'),
      name: `${track.clipName || track.name} (parte 2)`,
      color: track.color,
      folderId: track.folderId,
    }
    syncTrackToEngine(copy)
    commitTracks(
      [...list.slice(0, index + 1), copy, ...list.slice(index + 1)].map((item, position) => ({
        ...item,
        number: position + 1,
      })),
    )
    patchTrack(track.id, { clipDuration: cut })
    applyClipBuffer(copy.id, tail, copy.name, track.clipStart + cut / stepDuration)
    return copy.id
  }

  const splitClipAt = (trackId: string, atStep: number) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    if (track.kind !== 'audio' || !track.bufferId || track.clipDuration <= 0) {
      notify('Só dá para dividir uma track com áudio gravado')
      return
    }
    const tailId = splitTakeAt(trackId, atStep)
    if (!tailId) {
      notify('Posicione o ponto dentro do clipe para dividir')
      return
    }
    const tail = tracksRef.current.find((item) => item.id === tailId)
    setSelectedTrackId(tailId)
    notify(`Clipe dividido em "${track.name}" e "${tail?.name ?? 'parte 2'}"`)
  }

  /** Notes of the selected instrument lane that fall inside the picked range. */
  const copyTimeSelection = () => {
    if (!timeSel) {
      notify('Nada selecionado — Shift+arraste na régua para marcar um trecho')
      return
    }
    const track = tracksRef.current.find((item) => item.id === selectedRef.current)
    if (!track || track.kind !== 'instrument') {
      notify('Selecione uma track de piano, baixo ou bateria para copiar o trecho')
      return
    }
    const hits = track.midiNotes.filter((note) => note.step >= timeSel.from && note.step < timeSel.to)
    if (hits.length === 0) {
      notify('Não há notas dentro do trecho selecionado')
      return
    }
    // Rebased to zero so pasting lands wherever the playhead is.
    midiClipboardRef.current = {
      notes: hits.map((note) => ({ ...note, step: note.step - timeSel.from })),
      instrument: track.instrument,
      name: `${track.name} · trecho ${((timeSel.to - timeSel.from) / STEP_COUNT).toFixed(2)} comp.`,
    }
    notify(`${hits.length} nota(s) copiadas do trecho`)
  }

  /**
   * Empties the picked range: MIDI notes inside are dropped, and an audio take
   * that straddles it is cut at both edges so the middle lane can be cleared.
   */
  const deleteTimeSelection = () => {
    if (!timeSel) {
      notify('Nada selecionado — Shift+arraste na régua primeiro')
      return
    }
    const { from, to } = timeSel
    const list = tracksRef.current
    let removedNotes = 0
    let clearedClips = 0
    for (const track of list) {
      if (track.kind === 'instrument') {
        const kept = track.midiNotes.filter(
          (note) => note.step < from || note.step >= to,
        )
        if (kept.length !== track.midiNotes.length) {
          removedNotes += track.midiNotes.length - kept.length
          patchTrack(track.id, { midiNotes: kept })
        }
        continue
      }
      if (track.kind !== 'audio' || !track.bufferId || track.clipDuration <= 0) continue
      const start = track.clipStart
      const end = start + track.clipDuration / (60 / bpm / 4)
      if (start >= from && end <= to) {
        clearClip(track.id)
        clearedClips += 1
        continue
      }
      if (start < from && end > to) {
        // Cut the far edge first, then the near edge: the second cut frees the
        // middle lane, and that is the one the selection asked to empty.
        splitTakeAt(track.id, to)
        const middle = splitTakeAt(track.id, from)
        if (middle) {
          clearClip(middle)
          clearedClips += 1
        }
        continue
      }
      if (start < from && end > from) trimClipEnd(track.id, (from - start) * (60 / bpm / 4))
      else if (start < to && end > to) {
        const tail = splitTakeAt(track.id, to)
        if (tail) {
          clearClip(tail)
          clearedClips += 1
        }
      }
    }
    notify(
      removedNotes || clearedClips
        ? `Trecho limpo: ${removedNotes} nota(s) e ${clearedClips} clipe(s) removidos`
        : 'Não havia conteúdo nesse trecho',
    )
  }

  const trimDragRef = useRef<{
    trackId: string
    startX: number
    startDuration: number
    pxPerStep: number
    stepDuration: number
  } | null>(null)

  const onTrimPointerDown = (event: ReactPointerEvent<HTMLDivElement>, track: TrackState) => {
    if (event.button !== 0) return
    const lane = event.currentTarget.closest('.arrangement-lane')
    if (!lane) return
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    setSelectedTrackId(track.id)
    trimDragRef.current = {
      trackId: track.id,
      startX: event.clientX,
      startDuration: track.clipDuration,
      pxPerStep: Math.max(1, lane.clientWidth / totalSteps),
      stepDuration: 60 / bpm / 4,
    }
  }

  const onTrimPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = trimDragRef.current
    if (!drag) return
    const raw = (event.clientX - drag.startX) / drag.pxPerStep
    const steps = snapStep(raw, event.altKey)
    trimClipEnd(drag.trackId, Math.max(0.05, (drag.startDuration / drag.stepDuration + steps) * drag.stepDuration))
  }

  const onTrimPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    trimDragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
  }

  // Drag a MIDI pattern left/right on the timeline (notes keep their shape).
  const midiDragRef = useRef<{
    trackId: string
    startX: number
    pxPerStep: number
    origin: InstrumentNote[]
    minStep: number
  } | null>(null)
  const midiClickSuppressRef = useRef(false)

  const onMidiClipPointerDown = (event: ReactPointerEvent<HTMLDivElement>, track: TrackState) => {
    if (event.button !== 0) return
    if (event.shiftKey) return
    if ((event.target as HTMLElement).closest('.clip-close')) return
    const lane = event.currentTarget.closest('.arrangement-lane')
    if (!lane) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    setSelectedTrackId(track.id)
    let min = Infinity
    for (const note of track.midiNotes) min = Math.min(min, note.step)
    midiClickSuppressRef.current = false
    midiDragRef.current = {
      trackId: track.id,
      startX: event.clientX,
      pxPerStep: Math.max(1, lane.clientWidth / totalSteps),
      origin: track.midiNotes,
      minStep: Number.isFinite(min) ? min : 0,
    }
  }

  const onMidiClipPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = midiDragRef.current
    if (!drag) return
    const delta = snapStep((event.clientX - drag.startX) / drag.pxPerStep, event.altKey)
    const target = Math.max(0, Math.min(totalSteps - 1, drag.minStep + delta))
    const shift = target - drag.minStep
    if (shift === 0) return
    midiClickSuppressRef.current = true
    const notes = drag.origin.map((note) => ({ ...note, step: note.step + shift }))
    engineRef.current?.setNotes(drag.trackId, notes)
    patchTrack(drag.trackId, { midiNotes: notes })
  }

  const onMidiClipPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    midiDragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
  }

  // --------------------------------------------------- clip edge fades
  const fadeDragRef = useRef<{
    edge: 'fadeIn' | 'fadeOut'
    trackId: string
    clipLeft: number
    clipRight: number
    pxPerSecond: number
  } | null>(null)

  /** Length of the clip as shown on the timeline, in seconds. */
  const clipSecondsOf = (track: TrackState): number => {
    if (track.clipDuration > 0) return track.clipDuration
    return engineRef.current?.getBufferDuration(track.id) ?? 0
  }

  /** How wide a fade handle looks, as a percentage of the clip. */
  const fadePct = (track: TrackState, edge: 'fadeIn' | 'fadeOut'): number => {
    const seconds = clipSecondsOf(track)
    if (seconds <= 0) return 0
    return Math.min(50, (track[edge] / seconds) * 100)
  }

  const setFade = (trackId: string, edge: 'fadeIn' | 'fadeOut', seconds: number): void => {
    const current = tracksRef.current.find((track) => track.id === trackId)
    if (!current) return
    const max = engineRef.current?.getBufferDuration(trackId) ?? 0
    const limit = Math.max(0.005, Math.min(10, max > 0 ? max / 2 : 10))
    const value = Math.max(0, Math.min(limit, seconds))
    const fadeIn = edge === 'fadeIn' ? value : current.fadeIn
    const fadeOut = edge === 'fadeOut' ? value : current.fadeOut
    engineRef.current?.setClipFade(trackId, fadeIn, fadeOut)
    patchTrack(trackId, { fadeIn, fadeOut })
  }

  const onFadePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    track: TrackState,
    edge: 'fadeIn' | 'fadeOut',
  ) => {
    if (event.button !== 0) return
    const clip = event.currentTarget.parentElement
    if (!clip) return
    event.stopPropagation()
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    const rect = clip.getBoundingClientRect()
    const seconds = Math.max(0.05, clipSecondsOf(track))
    setSelectedTrackId(track.id)
    fadeDragRef.current = {
      trackId: track.id,
      edge,
      clipLeft: rect.left,
      clipRight: rect.right,
      pxPerSecond: Math.max(1, rect.width) / seconds,
    }
  }

  const onFadePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = fadeDragRef.current
    if (!drag) return
    const raw =
      drag.edge === 'fadeIn'
        ? (event.clientX - drag.clipLeft) / drag.pxPerSecond
        : (drag.clipRight - event.clientX) / drag.pxPerSecond
    // A fade is a musical length too, so it lands on the same grid as clips.
    const stepDuration = 60 / bpmRef.current / 4
    const steps = snapStep(raw / stepDuration, event.altKey)
    setFade(drag.trackId, drag.edge, steps * stepDuration)
  }

  const onFadePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    fadeDragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
  }

  // ---------------------------------------------- volume automation lanes
  /**
   * Which lanes are visible. Like zoom and snap this is how you are looking at
   * the project, not the project, so opening a lane costs no undo step and is
   * not saved with the file.
   */
  const [lanesOpen, setLanesOpen] = useState<Record<string, boolean>>({})
  const autoDragRef = useRef<{
    trackId: string
    index: number
    left: number
    width: number
    top: number
    height: number
  } | null>(null)

  /** Writes a lane to the state and the graph, so a drawn move is heard now. */
  const setLanePoints = (trackId: string, points: AutomationBreakpoint[]) => {
    const clean = sortedAutomation(points)
    engineRef.current?.setAutomation(trackId, clean)
    patchTrack(trackId, { automation: clean })
  }

  const toggleLane = (trackId: string, clear = false) => {
    if (clear) {
      setLanePoints(trackId, [])
      setLanesOpen((prev) => ({ ...prev, [trackId]: true }))
      notify('Automação limpa')
      return
    }
    setLanesOpen((prev) => ({ ...prev, [trackId]: !prev[trackId] }))
  }

  const stepInLane = (clientX: number, left: number, width: number, free: boolean): number =>
    Math.max(
      0,
      Math.min(totalSteps - 1, snapStep(((clientX - left) / Math.max(1, width)) * totalSteps, free)),
    )

  const onAutoPointPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    track: TrackState,
    index: number,
  ) => {
    if (event.button !== 0) return
    const lane = event.currentTarget.parentElement
    if (!lane) return
    event.stopPropagation()
    event.preventDefault()
    setSelectedTrackId(track.id)
    // Alt (or Shift) on a point erases it; the rest of the lane is unchanged.
    if (event.altKey || event.shiftKey) {
      setLanePoints(track.id, track.automation.filter((_, i) => i !== index))
      return
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    const rect = lane.getBoundingClientRect()
    autoDragRef.current = {
      trackId: track.id,
      index,
      left: rect.left,
      width: rect.width,
      top: rect.top,
      height: rect.height,
    }
  }

  const onAutoPointPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = autoDragRef.current
    if (!drag) return
    const track = tracksRef.current.find((item) => item.id === drag.trackId)
    if (!track) return
    if (!track.automation[drag.index]) return
    const step = stepInLane(event.clientX, drag.left, drag.width, event.altKey)
    const value = autoYToDb(event.clientY - drag.top, drag.height)
    // The dragged point is re-appended last, so landing on a neighbour's step
    // keeps this one under the cursor instead of being swallowed by it.
    const others = track.automation.filter((_, i) => i !== drag.index)
    const next = sortedAutomation([...others, { step, value }])
    const at = next.findIndex((point) => point.step === step && point.value === value)
    autoDragRef.current = { ...drag, index: Math.max(0, at) }
    setLanePoints(drag.trackId, next)
  }

  const onAutoPointPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    autoDragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
  }

  /** Double-click on the lane drops a point exactly under the cursor. */
  const onLaneDoubleClick = (event: ReactMouseEvent<HTMLDivElement>, track: TrackState) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const step = stepInLane(event.clientX, rect.left, rect.width, event.altKey)
    const value = autoYToDb(event.clientY - rect.top, rect.height)
    event.stopPropagation()
    setLanePoints(track.id, [...track.automation, { step, value }])
  }

  /**
   * The lane as an SVG path. X is a share of the arrangement so the drawing
   * scales with zoom; Y is pixels, because dB must stay legible at any width.
   *
   * The envelope holds outside its outer points - that is what the engine does
   * - so the drawing runs to both edges of the song instead of stopping in
   * mid-air at the first breakpoint.
   */
  const lanePath = (track: TrackState): { line: string; fill: string } => {
    const points = track.automation
    if (points.length === 0) return { line: '', fill: '' }
    const x = (step: number) => (step / Math.max(1, totalSteps)) * 100
    const first = points[0]
    const last = points[points.length - 1]
    const vertices: AutomationBreakpoint[] = [
      first.step > 0 ? { ...first, step: 0 } : first,
      ...points.filter((point) => point !== first && point !== last),
      last.step < totalSteps ? { ...last, step: totalSteps } : last,
    ]
    const line = vertices
      .map(
        (point, i) =>
          `${i === 0 ? 'M' : 'L'}${x(point.step).toFixed(3)} ${autoDbToY(point.value, AUTO_LANE_H).toFixed(2)}`,
      )
      .join(' ')
    const fill = `${line} L${x(vertices[vertices.length - 1].step).toFixed(3)} ${AUTO_LANE_H} L${x(vertices[0].step).toFixed(3)} ${AUTO_LANE_H} Z`
    return { line, fill }
  }

  // --------------------------------------------------- timeline context menu

  const stepFromLane = (clientX: number, target: HTMLElement, free = false): number => {
    const rect = target.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.max(0, Math.min(totalSteps - 1, snapStep(ratio * totalSteps, free)))
  }

  const openClipMenu = (event: ReactMouseEvent<HTMLDivElement>, trackId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedTrackId(trackId)
    setClipMenu({
      x: event.clientX,
      y: event.clientY,
      trackId,
      step: stepFromLane(event.clientX, event.currentTarget),
    })
  }

  const clipMenuTrack = clipMenu
    ? tracks.find((track) => track.id === clipMenu.trackId) ?? null
    : null

  /**
   * Right-click on a track panel. The panel keeps only what a mixer strip really
   * needs - name, record, mute, solo, FX, input, faders, routing - and the housekeeping
   * (reorder, duplicate, remove, clip cut/copy/paste) is one right-click away, still
   * on the keyboard for anyone who prefers it (Ctrl+D, Del, Ctrl+C/X/V).
   */
  const openTrackMenu = (event: ReactMouseEvent<HTMLElement>, trackId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedTrackId(trackId)
    setTrackMenu({ x: event.clientX, y: event.clientY, trackId })
  }

  const trackMenuTrack = trackMenu
    ? tracks.find((track) => track.id === trackMenu.trackId) ?? null
    : null

  const previewNote = (track: TrackState, pitch: number, lengthSteps: number, velocity = 0.85) => {
    const engine = engineRef.current
    if (!engine || track.kind !== 'instrument') return
    void engine.resume()
    const stepDuration = 60 / bpm / 4
    engine.playNote(
      track.id,
      track.instrument,
      pitch,
      Math.min(1, Math.max(0.05, velocity)),
      engine.ctx.currentTime + 0.01,
      Math.min(0.6, lengthSteps * stepDuration),
    )
  }

  const setTrackVoice = (trackId: string, voice: string) => {
    const next = tracksRef.current.map((track) =>
      track.id === trackId ? { ...track, voice } : track,
    )
    const updated = next.find((track) => track.id === trackId)
    if (updated) syncTrackToEngine(updated)
    commitTracks(next)
  }

  // ------------------------------------------------------------- web midi

  const resolveMidiTarget = (): TrackState | null => {
    const list = tracksRef.current
    if (isRecordingRef.current) {
      const armed = list.find(
        (track) => track.kind === 'instrument' && track.isArmed && !track.isMuted,
      )
      if (armed) return armed
    }
    const selected = list.find((track) => track.id === selectedRef.current)
    if (selected?.kind === 'instrument') return selected
    return list.find((track) => track.kind === 'instrument' && track.isArmed) ?? null
  }

  const pulseMidiLed = () => {
    setMidiLed(true)
    if (midiLedTimerRef.current !== null) window.clearTimeout(midiLedTimerRef.current)
    midiLedTimerRef.current = window.setTimeout(() => setMidiLed(false), 110)
  }

  const handleMidiNoteOn = (pitch: number, velocity: number, forcedTarget?: TrackState) => {
    const engine = engineRef.current
    if (!engine) return
    // The computer keyboard resolves its own target (a folder jams its first
    // playable child), so it hands it over instead of relying on the MIDI pick.
    const target = forcedTarget ?? resolveMidiTarget()
    if (!target) return
    void engine.resume()
    engine.playNote(target.id, target.instrument, pitch, velocity, engine.ctx.currentTime + 0.004, 0.4)
    pulseMidiLed()
    if (takeOpenRef.current && target.isArmed) {
      const start = Math.max(0, Math.round(songStepNow()))
      midiPendingRef.current.set(`${target.id}:${pitch}`, {
        trackId: target.id,
        pitch,
        step: start,
        velocity,
      })
    }
  }

  const handleMidiNoteOff = (pitch: number) => {
    pulseMidiLed()
    if (!isRecordingRef.current) return
    for (const [key, pending] of [...midiPendingRef.current]) {
      if (!key.endsWith(`:${pitch}`)) continue
      midiPendingRef.current.delete(key)
      const track = tracksRef.current.find((item) => item.id === pending.trackId)
      if (!track || track.kind !== 'instrument') continue
      const end = Math.max(pending.step + 1, Math.round(songStepNow()))
      midiTakeCountRef.current += 1
      const played: InstrumentNote = {
        step: pending.step,
        pitch,
        length: Math.min(64, end - pending.step),
        velocity: Math.max(0.1, pending.velocity),
      }
      // On a looped track the take folds into the bar it was played in, so
      // recording over a pattern edits that pattern instead of stacking copies.
      setMidiNotes(
        track.id,
        sortNotes(foldIntoPattern([...track.midiNotes, played], track.patternSteps)),
      )
    }
  }

  // ------------------------------------------------- computer-keyboard playing

  /** The melodic instrument track the computer keys play, if there is one. */
  const resolvePcTarget = (): TrackState | null => {
    const list = tracksRef.current
    // Any playable instrument counts now: a kit is played with the same keys,
    // just with a different map (see DRUM_KEY_PIECES).
    const playable = (track: TrackState | null | undefined): boolean =>
      track != null && track.kind === 'instrument' && !track.isMuted
    // A folder is a container, not an instrument: jamming it means its first
    // melodic child, preferring one that is armed or already selected.
    const insideFolder = (folderId: string): TrackState | null => {
      const children = list.filter((track) => track.folderId === folderId && playable(track))
      return children.find((track) => track.isArmed) ?? children[0] ?? null
    }
    const target = resolveMidiTarget()
    if (playable(target)) return target
    if (target?.isFolder) {
      const child = insideFolder(target.id)
      if (child) return child
    }
    const fallback = list.find(
      (track) =>
        playable(track) &&
        (track.id === selectedRef.current || track.isArmed || (track.folderId ?? '') === selectedRef.current),
    )
    return fallback ?? null
  }

  const pcBasePitch = (track: TrackState): number =>
    (PC_BASE_BY_INSTRUMENT[track.instrument as 'piano' | 'bass'] ?? 60) + pcOctaveRef.current * 12

  /** Which computer key sounds this note, for the caption beside the roll keys. */
  const pcCaptionAt = (track: TrackState, pitch: number): string => {
    if (!isMelodic(track.instrument)) return ''
    const caption = PC_KEY_CAPTIONS[pitch - pcBasePitch(track)]
    return typeof caption === 'string' ? caption : ''
  }

  /**
   * A kit lane hit from the computer keyboard. Drums are one-shots, so there is
   * no note-off to wait for: the lane flashes for a beat and the hit goes
   * through the same MIDI path a pad would use, recording if the lane is armed.
   */
  const pcHitDrumPiece = (track: TrackState, pieceIndex: number) => {
    const piece = DRUM_PIECES[pieceIndex]
    if (!piece) return
    handleMidiNoteOn(piece.pitch, 0.92, track)
    setPcHeldPieces((current) => (current.includes(pieceIndex) ? current : [...current, pieceIndex]))
    const previous = pcPieceTimersRef.current.get(pieceIndex)
    if (previous !== undefined) window.clearTimeout(previous)
    pcPieceTimersRef.current.set(
      pieceIndex,
      window.setTimeout(() => {
        pcPieceTimersRef.current.delete(pieceIndex)
        setPcHeldPieces((current) => current.filter((index) => index !== pieceIndex))
      }, 130),
    )
  }

  const pcNoteOn = (rawKey: string) => {
    const engine = engineRef.current
    if (!engine) return
    const track = resolvePcTarget()
    if (!track) {
      const now = Date.now()
      if (now - pcHintRef.current > 2500) {
        pcHintRef.current = now
        notify('Selecione (ou arme) uma track de piano, baixo ou bateria para tocar no teclado')
      }
      return
    }
    if (track.instrument === 'drums') {
      const piece = DRUM_KEY_PIECES[rawKey]
      if (piece === undefined) return
      pcHitDrumPiece(track, piece)
      return
    }
    const semitone = PC_KEY_SEMITONES[rawKey]
    if (semitone === undefined) return
    if (pcHeldRef.current.has(rawKey)) return
    const pitch = pcBasePitch(track) + semitone
    pcHeldRef.current.set(rawKey, pitch)
    setPcHeld([...pcHeldRef.current.values()])
    handleMidiNoteOn(pitch, 0.85)
  }

  const pcNoteOff = (rawKey: string) => {
    if (!pcHeldRef.current.has(rawKey)) return
    const pitch = pcHeldRef.current.get(rawKey) ?? 0
    pcHeldRef.current.delete(rawKey)
    setPcHeld([...pcHeldRef.current.values()])
    handleMidiNoteOff(pitch)
  }

  /** Everything the keys were holding, released at once. */
  const pcAllNotesOff = () => {
    for (const timer of pcPieceTimersRef.current.values()) window.clearTimeout(timer)
    pcPieceTimersRef.current.clear()
    setPcHeldPieces([])
    if (pcHeldRef.current.size === 0) return
    const pitches = [...pcHeldRef.current.values()]
    pcHeldRef.current.clear()
    setPcHeld([])
    for (const pitch of pitches) handleMidiNoteOff(pitch)
  }

  const togglePcKeys = () => {
    const next = !pcKeysRef.current
    pcKeysRef.current = next
    setPcKeys(next)
    if (!next) {
      pcAllNotesOff()
      notify('Teclado do computador desligado — os atalhos voltaram')
      return
    }
    const track = resolvePcTarget()
    notify(
      track?.instrument === 'drums'
        ? `Teclado do computador ligado em ${track.name} — A ; são kick, caixa e pratos graves, Q U os pratos e ruídos`
        : track
          ? `Teclado do computador ligado em ${track.name} — A a ; tocam a escala, Z e X mudam de oitava`
          : 'Teclado do computador ligado — crie ou selecione uma track de piano, baixo ou bateria',
    )
  }

  const shiftPcOctave = (delta: number) => {
    const next = Math.max(-4, Math.min(4, pcOctaveRef.current + delta))
    if (next === pcOctaveRef.current) return
    pcAllNotesOff()
    pcOctaveRef.current = next
    setPcOctave(next)
  }

  pcNoteOnRef.current = pcNoteOn
  pcNoteOffRef.current = pcNoteOff
  pcAllNotesOffRef.current = pcAllNotesOff
  shiftPcOctaveRef.current = shiftPcOctave

  const connectMidiDevice = (deviceId: string) => {
    midiUnbindRef.current?.()
    midiUnbindRef.current = bindMidiInput(deviceId, {
      noteOn: (pitch, velocity) => handleMidiNoteOn(pitch, velocity),
      noteOff: (pitch) => handleMidiNoteOff(pitch),
    })
    setMidiInputId(deviceId)
    notify('Controlador MIDI conectado — toque para testar')
  }

  const disconnectMidi = () => {
    midiUnbindRef.current?.()
    midiUnbindRef.current = null
    setMidiInputId(null)
    notify('Controlador MIDI desconectado')
  }

  const enableMidi = async () => {
    try {
      const devices = await openMidiAccess()
      setMidiDevices(devices)
      setMidiError(null)
      watchMidiConnections(() => setMidiDevices(listMidiInputs()))
      if (midiInputId && !devices.some((device) => device.id === midiInputId)) {
        disconnectMidi()
      }
    } catch (error) {
      setMidiError((error as Error).message)
    }
    setShowMidiPanel(true)
  }

  useEffect(
    () => () => {
      midiUnbindRef.current?.()
      midiUnbindRef.current = null
      if (midiLedTimerRef.current !== null) window.clearTimeout(midiLedTimerRef.current)
    },
    [],
  )

  // --------------------------------------------------------- piano roll grid

  const rollCellAt = (clientX: number, clientY: number, instrument: InstrumentKind) => {
    const inner = rollInnerRef.current
    if (!inner) return null
    const rect = inner.getBoundingClientRect()
    const step = Math.floor((clientX - rect.left) / ROLL_COL_W)
    // A looped piano track only draws its bar, so clicks stop at the loop edge.
    const bounds = midiEditorTrack ? rollSteps(midiEditorTrack) : totalSteps
    if (step < 0 || step >= bounds) return null
    if (instrument === 'drums') {
      const lane = Math.floor((clientY - rect.top) / DRUM_ROW_H)
      if (lane < 0 || lane >= DRUM_PIECES.length) return null
      return { step, pitch: DRUM_PIECES[lane].pitch }
    }
    const { top, bottom } = rollRange(instrument)
    const row = Math.floor((clientY - rect.top) / ROLL_ROW_H)
    const pitch = top - row
    if (pitch < bottom || pitch > top) return null
    return { step, pitch }
  }

  const sortNotes = (notes: InstrumentNote[]) =>
    [...notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch)

  const onRollGridClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressRollClickRef.current) {
      suppressRollClickRef.current = false
      return
    }
    const track = midiEditorTrack
    if (!track) return
    const cell = rollCellAt(event.clientX, event.clientY, track.instrument)
    if (!cell) return
    const existing = track.midiNotes.findIndex((note) =>
      track.instrument === 'drums'
        ? note.pitch === cell.pitch && note.step === cell.step
        : note.pitch === cell.pitch &&
          cell.step >= note.step &&
          cell.step < note.step + note.length,
    )
    if (existing >= 0) {
      setMidiNotes(
        track.id,
        track.midiNotes.filter((_, index) => index !== existing),
      )
      return
    }
    const length = track.instrument === 'drums' ? 1 : midiNoteLen
    const note: InstrumentNote = {
      step: Math.min(cell.step, Math.max(0, rollSteps(track) - length)),
      pitch: cell.pitch,
      length,
      velocity: 0.85,
    }
    setMidiNotes(track.id, sortNotes([...track.midiNotes, note]))
    previewNote(track, note.pitch, length)
  }

  // ------------------------------------------------- editor box selection

  const noteInSel = (note: InstrumentNote, sel: NonNullable<typeof rollSel>): boolean =>
    note.step < sel.right &&
    note.step + Math.max(1, note.length) > sel.left &&
    note.pitch <= sel.high &&
    note.pitch >= sel.low

  const onRollMarqueeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0) return
    const track = midiEditorTrack
    if (!track) return
    const cell = rollCellAt(event.clientX, event.clientY, track.instrument)
    if (!cell) return
    event.stopPropagation()
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic pointer without capture support */
    }
    rollSelAnchorRef.current = cell
    setRollSel({ left: cell.step, right: cell.step + 1, high: cell.pitch, low: cell.pitch })
  }

  const onRollMarqueeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const anchor = rollSelAnchorRef.current
    const track = midiEditorTrack
    if (!anchor || !track) return
    const cell = rollCellAt(event.clientX, event.clientY, track.instrument)
    if (!cell) return
    setRollSel({
      left: Math.min(anchor.step, cell.step),
      right: Math.max(anchor.step, cell.step) + 1,
      high: Math.max(anchor.pitch, cell.pitch),
      low: Math.min(anchor.pitch, cell.pitch),
    })
  }

  const onRollMarqueeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rollSelAnchorRef.current) return
    rollSelAnchorRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
  }

  /** Notes inside the box, rebased so step 0 is the left edge of the selection. */
  const selectionNotes = (): InstrumentNote[] => {
    if (!midiEditorTrack || !rollSel) return []
    return midiEditorTrack.midiNotes
      .filter((note) => noteInSel(note, rollSel))
      .map((note) => ({ ...note, step: note.step - rollSel.left }))
  }

  /** Returns false when no box is open, so the caller can fall back to clips. */
  const copyRollSelection = (): boolean => {
    const track = midiEditorTrack
    if (!track || !rollSel) return false
    const notes = selectionNotes()
    if (notes.length === 0) {
      notify('A seleção não tem notas')
      return true
    }
    midiClipboardRef.current = {
      notes,
      instrument: track.instrument,
      name: `${track.name} · ${notes.length} nota(s)`,
    }
    notify(`${notes.length} nota(s) copiadas da seleção`)
    return true
  }

  const cutRollSelection = (): boolean => {
    const track = midiEditorTrack
    if (!track || !rollSel) return false
    const notes = selectionNotes()
    if (notes.length > 0) {
      midiClipboardRef.current = {
        notes,
        instrument: track.instrument,
        name: `${track.name} · ${notes.length} nota(s)`,
      }
      setMidiNotes(
        track.id,
        sortNotes(track.midiNotes.filter((note) => !noteInSel(note, rollSel))),
      )
      notify(`${notes.length} nota(s) recortadas da seleção`)
      return true
    }
    notify('A seleção não tem notas')
    return true
  }

  const pasteRollSelection = (): boolean => {
    const track = midiEditorTrack
    const clip = midiClipboardRef.current
    if (!track || !clip) return false
    if (clip.instrument !== track.instrument) {
      notify(
        `A área de transferência tem ${instrumentLabel(clip.instrument).toLowerCase()} — cole em uma track igual`,
      )
      return true
    }
    const limit = Math.max(1, rollSteps(track))
    // A box means "repeat the phrase right after it"; without one the clip
    // lands on the cursor, which is where the user is listening from.
    const at = rollSel ? rollSel.right : Math.floor(playheadStep % limit)
    const pasted = clip.notes.map((note) => ({
      ...note,
      step: Math.max(0, Math.min(limit - Math.max(1, note.length), at + note.step)),
    }))
    setMidiNotes(track.id, sortNotes([...track.midiNotes, ...pasted]))
    notify(`${pasted.length} nota(s) coladas em ${barBeatOf(at)}`)
    return true
  }

  // ------------------------------------------------------------- groove tools

  /** The box as a predicate, so a tool can fix the selection and ignore the rest. */
  const rollSelectionFilter = (): NoteFilter | undefined => {
    const sel = rollSel
    if (!sel) return undefined
    return (note) => noteInSel(note, sel)
  }

  const rollScaleOf = (trackId: string) => rollScales[trackId] ?? { root: 0, mode: '' }

  const setRollScale = (trackId: string, next: { root: number; mode: string }) =>
    setRollScales((current) => ({ ...current, [trackId]: next }))

  /** Run one note tool over the editor track and write a single undo step. */
  const applyRollTool = (
    label: string,
    quiet: string,
    tool: (notes: RollNote[], include?: NoteFilter) => RollNote[],
  ) => {
    const track = midiEditorTrack
    if (!track) return
    const include = rollSelectionFilter()
    const original = track.midiNotes
    const next = tool(original, include)
    if (!next.some((note, index) => note !== original[index])) {
      notify(quiet)
      return
    }
    setMidiNotes(track.id, sortNotes(next))
    notify(`${label} · ${include ? 'seleção' : 'todas as notas'} · ${track.name}`)
  }

  const quantizeRoll = () => {
    const grid = QUANTIZE_GRIDS.find((item) => item.steps === rollQuantum) ?? QUANTIZE_GRIDS[1]
    applyRollTool(`Quantizado em ${grid.label}`, 'As notas já estão na grade', (notes, include) =>
      quantizeNotes(notes, grid.steps, 1, include),
    )
  }

  const humanizeRoll = () =>
    applyRollTool('Humanizado', 'Não há notas para deslocar', (notes, include) =>
      humanizeNotes(notes, 0.45, Math.random, include),
    )

  const snapRollToScale = () => {
    const track = midiEditorTrack
    if (!track) return
    const { root, mode } = rollScaleOf(track.id)
    const named = SCALE_MODES.find((item) => item.id === mode)
    if (!named || !named.intervals.length) {
      notify('Escolha uma escala antes de confinar as notas')
      return
    }
    applyRollTool(
      `Notas presas em ${SCALE_ROOTS[root]} ${named.label.toLowerCase()}`,
      'Todas as notas já pertencem à escala',
      (notes, include) => snapNotesToScale(notes, root, mode, include),
    )
  }

  /** Arrows move the box and its notes together; returns false if there is no box. */
  const nudgeRoll = (deltaSteps: number, deltaPitch: number): boolean => {
    const track = midiEditorTrack
    const sel = rollSel
    if (!track || !sel) return false
    const include = rollSelectionFilter()
    const original = track.midiNotes
    const next = nudgeNotes(original, deltaSteps, deltaPitch, include)
    if (next.some((note, index) => note !== original[index])) {
      setMidiNotes(track.id, sortNotes(next))
      setRollSel(shiftSelectionBox(sel, deltaSteps, deltaPitch))
    }
    return true
  }
  nudgeRollRef.current = nudgeRoll

  // ------------------------------------------------------------ velocity lane

  const onVelocityPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = midiEditorTrack
    if (!track || track.midiNotes.length === 0) return
    const lane = event.currentTarget
    const rect = lane.getBoundingClientRect()
    const columnWidth = rect.width / Math.max(1, rollSteps(track))
    if (!Number.isFinite(columnWidth) || columnWidth <= 0) return
    const x = event.clientX - rect.left
    let index = -1
    let best = Infinity
    track.midiNotes.forEach((note, i) => {
      const centre = (note.step + Math.max(1, note.length) / 2) * columnWidth
      const distance = Math.abs(centre - x)
      if (distance < best) {
        best = distance
        index = i
      }
    })
    if (index < 0) return
    event.stopPropagation()
    try {
      lane.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic pointer without capture support */
    }
    const value = Math.min(1, Math.max(0.05, 1 - (event.clientY - rect.top) / rect.height))
    setRollVelDrag({ index, velocity: Math.round(value * 1000) / 1000 })
    previewNote(
      track,
      track.midiNotes[index].pitch,
      Math.max(1, track.midiNotes[index].length),
      value,
    )
  }

  const onVelocityPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = rollVelDrag
    if (!drag) return
    const rect = event.currentTarget.getBoundingClientRect()
    const value = Math.min(1, Math.max(0.05, 1 - (event.clientY - rect.top) / rect.height))
    setRollVelDrag({ index: drag.index, velocity: Math.round(value * 1000) / 1000 })
  }

  const onVelocityPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = rollVelDrag
    setRollVelDrag(null)
    if (!drag) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    const track = midiEditorTrack
    if (!track || !track.midiNotes[drag.index]) return
    setMidiNotes(track.id, withVelocity(track.midiNotes, drag.index, drag.velocity))
  }

  // ------------------------------------------------- drum velocity by column

  /** Loudest hit in a drum column, which is what that column's bar shows. */
  const seqVelocityAt = (track: TrackState, step: number): number => {
    let value = 0
    for (const note of track.midiNotes) if (note.step === step) value = Math.max(value, note.velocity)
    return value
  }

  const seqStepAt = (event: ReactPointerEvent<HTMLDivElement>, colW: number, steps: number) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.min(steps - 1, Math.max(0, Math.floor((event.clientX - rect.left) / colW)))
  }

  const seqVelocityFromY = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0.05, 1 - (event.clientY - rect.top) / rect.height))
  }

  const onSeqVelPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    track: TrackState,
    colW: number,
    steps: number,
  ) => {
    if (steps <= 0 || track.midiNotes.length === 0) return
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic pointer without capture support */
    }
    setSeqVelDrag({ step: seqStepAt(event, colW, steps), velocity: seqVelocityFromY(event) })
  }

  const onSeqVelPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
    colW: number,
    steps: number,
  ) => {
    const drag = seqVelDrag
    if (!drag) return
    setSeqVelDrag({ step: seqStepAt(event, colW, steps), velocity: seqVelocityFromY(event) })
  }

  const onSeqVelPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = seqVelDrag
    setSeqVelDrag(null)
    if (!drag) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    const track = midiEditorTrack
    if (!track) return
    let changed = false
    const next = track.midiNotes.map((note) => {
      if (note.step !== drag.step || Math.abs(note.velocity - drag.velocity) < 0.0005) return note
      changed = true
      return { ...note, velocity: Math.round(drag.velocity * 1000) / 1000 }
    })
    if (changed) setMidiNotes(track.id, next)
  }

  const onNotePointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    const track = midiEditorTrack
    const inner = rollInnerRef.current
    if (!track || !inner) return
    event.stopPropagation()
    const note = track.midiNotes[index]
    if (!note) return
    const rect = inner.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const mode: 'move' | 'resize' =
      isMelodic(track.instrument) &&
      note.length > 1 &&
      localX - note.step * ROLL_COL_W > note.length * ROLL_COL_W - 5
        ? 'resize'
        : 'move'
    rollDragRef.current = {
      index,
      mode,
      grabPx: localX - note.step * ROLL_COL_W,
      x0: event.clientX,
      y0: event.clientY,
      moved: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic pointer without capture support */
    }
  }

  const onNotePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = rollDragRef.current
    const track = midiEditorTrack
    const inner = rollInnerRef.current
    if (!drag || !track || !inner) return
    if (!drag.moved && Math.abs(event.clientX - drag.x0) + Math.abs(event.clientY - drag.y0) < 4)
      return
    drag.moved = true
    const note = track.midiNotes[drag.index]
    if (!note) return
    const rect = inner.getBoundingClientRect()
    if (drag.mode === 'resize') {
      const length = Math.max(
        1,
        Math.min(
          totalSteps - note.step,
          Math.ceil((event.clientX - rect.left - note.step * ROLL_COL_W) / ROLL_COL_W),
        ),
      )
      setRollDrag({
        index: drag.index,
        step: note.step,
        pitch: note.pitch,
        length,
        velocity: note.velocity,
      })
    } else {
      const step = Math.max(
        0,
        Math.min(
          totalSteps - note.length,
          Math.floor((event.clientX - rect.left - drag.grabPx) / ROLL_COL_W),
        ),
      )
      let pitch = note.pitch
      if (isMelodic(track.instrument)) {
        const { top, bottom } = rollRange(track.instrument)
        const row = Math.floor((event.clientY - rect.top) / ROLL_ROW_H)
        pitch = Math.max(bottom, Math.min(top, top - row))
      }
      setRollDrag({ index: drag.index, step, pitch, length: note.length, velocity: note.velocity })
    }
  }

  const onNotePointerUp = () => {
    const drag = rollDragRef.current
    const track = midiEditorTrack
    rollDragRef.current = null
    suppressRollClickRef.current = true
    window.setTimeout(() => {
      suppressRollClickRef.current = false
    }, 150)
    if (!drag || !track) {
      setRollDrag(null)
      return
    }
    if (!drag.moved) {
      // Plain click on a note deletes it.
      setMidiNotes(
        track.id,
        track.midiNotes.filter((_, index) => index !== drag.index),
      )
      setRollDrag(null)
      return
    }
    const current = rollDrag
    if (current && current.index === drag.index) {
      setMidiNotes(
        track.id,
        sortNotes(
          track.midiNotes.map((note, index) =>
            index === drag.index
              ? { ...note, step: current.step, pitch: current.pitch, length: current.length }
              : note,
          ),
        ),
      )
    }
    setRollDrag(null)
  }

  // ------------------------------------------------------------- transport

  const changeMasterVolume = (value: number) => {
    setMasterVolume(value)
    engineRef.current?.setMasterVolume(value)
  }

  const toggleMasterMute = () => {
    const next = !masterMuted
    setMasterMuted(next)
    engineRef.current?.setMasterMuted(next)
  }

  const toggleMetronome = () => {
    setMetronome((prev) => {
      const next = !prev
      notify(next ? 'Metrônomo ligado' : 'Metrônomo desligado')
      return next
    })
  }

  const toggleLoop = () => {
    setLoop((prev) => {
      const next = !prev
      notify(next ? 'Loop ligado' : 'Loop desligado')
      return next
    })
  }

  /**
   * Punch-in mode. The ref is written here rather than only in the sync effect
   * because record and the toggle can be pressed in the same breath, and the
   * record path has to see the mode that is already on screen.
   */
  const togglePunch = () => {
    const next = !punchInRef.current
    punchInRef.current = next
    setPunchIn(next)
    notify(
      next
        ? 'Punch-in ligado — ● grava só dentro da área selecionada'
        : 'Punch-in desligado — ● grava de novo continuamente',
    )
  }

  // ---------------------------------------------------------------- project

  const saveProject = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentProject()))
      // A named save: the producer asked for this moment to be kept.
      recordVersion('salvo manualmente', true)
      notify('Projeto salvo neste navegador')
    } catch {
      notify('Não foi possível salvar o projeto')
    }
  }

  const loadProject = () => {
    const stored = loadStored()
    if (!stored) {
      notify('Nenhum projeto salvo encontrado')
      return
    }
    applyProject(stored)
    notify('Projeto carregado')
  }

  const newProject = () => {
    const fresh = sanitizeProject({
      tracks: [makeTrack(0, 'Audio 1 (GTR)'), makeTrack(1, 'Audio 2 (VOX)')],
    })
    applyProject(fresh)
    window.localStorage.removeItem(STORAGE_KEY)
    // IndexedDB is wiped, so any sample the history still pointed at is gone.
    orphanSamplesRef.current.clear()
    void clearSamples()
    notify('Novo projeto criado — amostras antigas apagadas')
  }

  /**
   * `.opdaw` = the project JSON plus every clip's WAV, base64'd. The file is
   * the session: opening it on another machine must not give a silent timeline.
   */
  const exportProjectFile = async () => {
    if (exportingProjectRef.current) return
    exportingProjectRef.current = true
    setExportingProject(true)
    try {
      const project = currentProject()
      const stored = await listSamples()
      const file = await buildProjectFile(project, stored)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const missing = sampleIdsUsedBy(project).filter((id) => !file.samples.some((s) => s.id === id))
      downloadBlob(
        new Blob([projectFileToText(file)], { type: 'application/octet-stream' }),
        `projeto-${stamp}.opdaw`,
      )
      const sizeKb = Math.round(JSON.stringify(file).length / 1024)
      notify(
        missing.length > 0
          ? `Projeto salvo sem ${missing.length} clipe(s) — o áudio deles não estava no navegador`
          : `Projeto salvo (${file.samples.length} clipe(s), ${sizeKb} kB)`,
      )
    } catch (error) {
      notify(`Falha ao salvar o projeto: ${(error as Error).message}`)
    } finally {
      exportingProjectRef.current = false
      setExportingProject(false)
    }
  }

  /**
   * Take the text of a `.opdaw` file and make it the session. Shared by the
   * browser's file input and the executable's open dialog, because both hand
   * back the same bytes and must restore the clips the same way.
   */
  const applyProjectText = async (text: string) => {
    const parsed = parseProjectFile(text)
    // Samples go in before the project is applied, because applying a project
    // immediately asks the sample store for every clip it references.
    for (const sample of parsed.samples) {
      await saveSample(sample.id, new Blob([sample.bytes], { type: 'audio/wav' }))
    }
    applyProject(sanitizeProject(parsed.project as Partial<SavedProject>))
    notify(
      parsed.missing.length > 0
        ? `Projeto aberto — faltam ${parsed.missing.length} clipe(s) de áudio`
        : `Projeto aberto (${parsed.samples.length} clipe(s))`,
    )
  }

  const openProjectFile = () => {
    if (isNativeApp()) {
      void nativeOpenText('project')
        .then((text) => {
          if (text !== null) return applyProjectText(text)
          return undefined
        })
        .catch((error: unknown) => notify(`Falha ao abrir o projeto: ${(error as Error).message}`))
      return
    }
    const input = projectInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const onProjectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      await applyProjectText(await file.text())
    } catch (error) {
      notify(`Falha ao abrir o projeto: ${(error as Error).message}`)
    }
  }

  /** FX rack + signal order of one track, as a shareable `.opdawchain`. */
  const exportChainPreset = (trackId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    const file = buildChainFile(track.name, track.fxRack, track.chain)
    downloadBlob(
      new Blob([JSON.stringify(file)], { type: 'application/octet-stream' }),
      `${slugify(track.name) || 'cadeia'}.opdawchain`,
    )
    notify(`Cadeia de "${track.name}" salva — plugins NAM/IR não vão no arquivo`)
  }

  const openChainPreset = (trackId: string) => {
    chainTargetRef.current = trackId
    const input = chainInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const onChainFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const trackId = chainTargetRef.current
    event.target.value = ''
    chainTargetRef.current = null
    if (!file || !trackId) return
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
    try {
      const parsed = parseChainFile(await file.text())
      const rack = sanitizeFxRack(parsed.rack)
      const base = parsed.order.length > 0 ? reorderBuiltinChain(track.chain, parsed.order.map((entry) => entry.slice(3) as BuiltinFxId)) : track.chain
      const order = chainWithEnabledRack(base, rack)
      const engine = engineRef.current
      if (engine) {
        for (const fxId of BUILTIN_FX_IDS) engine.setBuiltinFx(trackId, fxId, rack[fxId])
        engine.setChainOrder(trackId, order)
      }
      commitTracks(
        tracksRef.current.map((item) =>
          item.id === trackId ? { ...item, fxRack: rack, chain: order } : item,
        ),
      )
      notify(`Cadeia "${parsed.name}" aplicada em ${track.name}`)
    } catch (error) {
      notify(`Falha ao aplicar a cadeia: ${(error as Error).message}`)
    }
  }

  // ------------------------------------------------------- desktop menus
  // The menu bar the page draws is also the source of the executable's native
  // bar, so it needs a handle of its own.
  const menuBarRef = useRef<HTMLElement | null>(null)
  // The executable's own bar mirrors this one: the rows arrive back as a
  // position and are pressed here, and the handful of commands that only make
  // sense for a native engine (undo stack, plugin scan) come by name.
  const menuActionRef = useRef<Record<NativeMenuAction, () => void>>({
    'new-project': () => {},
    'open-project': () => {},
    'save-project': () => {},
    'import-audio': () => {},
    'export-mix': () => {},
    undo: () => {},
    redo: () => {},
    'refresh-inputs': () => {},
    'midi-devices': () => {},
    'scan-plugins': () => {},
    'plugin-panel': () => {},
  })
  menuActionRef.current = {
    'new-project': () => newProject(),
    'open-project': () => openProjectFile(),
    'save-project': () => void exportProjectFile(),
    'import-audio': () => openAudioImport(),
    'export-mix': () => setShowExport(true),
    undo: () => undo(),
    redo: () => redo(),
    'refresh-inputs': () => void refreshInputs(),
    'midi-devices': () => void enableMidi(),
    'scan-plugins': () => {
      setPluginScan((token) => token + 1)
      setShowPlugins(true)
    },
    'plugin-panel': () => setShowPlugins(true),
  }

  useEffect(
    () =>
      onNativeMenu((click) => {
        if ('action' in click) {
          // The bridge drops whatever a handler throws, so a command that broke
          // would look exactly like a command that did nothing at all. Say which.
          try {
            menuActionRef.current[click.action]?.()
          } catch (error) {
            notify(`Não deu para executar ${(error as Error).message}`)
          }
          return
        }
        const bar = menuBarRef.current
        if (bar && !clickNativeMenuItem(bar, click.menu, click.item)) {
          notify('Esse item do menu não estava disponível agora')
        }
      }),
    [],
  )

  // In the executable the operating system's own bar carries every command, so
  // the browser menu bar steps out of the way — but it stays in the document,
  // because that is what the native bar is built from and what it clicks.
  useEffect(() => {
    const bar = menuBarRef.current
    if (!bar || !isNativeApp()) return
    return mirrorMenuBar(bar)
  }, [])

  const applyChainOrder = (trackId: string, orderKey: string) => {
    const preset = CHAIN_ORDERS[orderKey]
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!preset || !track) return
    const order = reorderBuiltinChain(track.chain, preset.order)
    engineRef.current?.setChainOrder(trackId, order)
    commitTracks(
      tracksRef.current.map((item) => (item.id === trackId ? { ...item, chain: order } : item)),
    )
    notify(`Ordem da cadeia: ${preset.name}`)
  }

  const openExport = () => {
    // A folder is an organizing row, not a signal: it never has a clip to bounce.
    const selected = tracks.find((track) => track.id === selectedTrackId)
    setExportScope(selected && !selected.isFolder ? 'track' : 'mix')
    setExportBars(arrangementBars)
    setExportReports([])
    setShowExport(true)
  }

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null
  const selectedIsFolder = selectedTrack?.isFolder === true

  /**
   * Lanes the engine can actually render: recorded audio it already holds, or
   * notes on an instrument. An empty lane is not a stem, and downloading twelve
   * silent files would be a strange way to find out.
   */
  const renderableTracks = (): TrackState[] => {
    const engine = engineRef.current
    return tracksRef.current.filter(
      (track) =>
        !track.isFolder &&
        (engine?.hasBuffer(track.id) === true ||
          (track.kind === 'instrument' && track.midiNotes.length > 0)),
    )
  }

  /** Chrome only allows several programmatic downloads if they are spaced out. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })

  // Label only: the state says which lanes look full, the engine says which are.
  const stemCount = tracks.filter(
    (track) =>
      !track.isFolder &&
      (Boolean(track.bufferId) || (track.kind === 'instrument' && track.midiNotes.length > 0)),
  ).length

  const runExport = async () => {
    const engine = engineRef.current
    if (!engine) return
    if (exportScope === 'track') {
      if (!selectedTrack || selectedIsFolder) {
        notify('Escolha uma track (a pasta serve só para organizar)')
        return
      }
      if (!engine.hasBuffer(selectedTrack.id)) {
        notify('Esta track não tem áudio gravado para exportar')
        return
      }
    }
    const stems = exportScope === 'stems' ? renderableTracks() : []
    if (exportScope === 'stems' && stems.length === 0) {
      notify('Nada para exportar: grave áudio ou escreva notas em uma track')
      return
    }

    setExporting(true)
    setExportReports([])
    // A native plugin works in its own process, so a pass that has not landed
    // yet is rendered here and the file waits for it: an export can come out with
    // the plugin's sound or say out loud that it could not.
    const unresolvedPlugins = await ensureNativePreviews()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    try {
      const reports: ExportReport[] = []

      if (exportScope === 'stems') {
        // Each stem is rendered alone, at the full arrangement length, so the
        // files line up when they are dropped into another session.
        for (const track of stems) {
          const result = await engine.render({
            bpm,
            bars: exportBars,
            trackId: track.id,
            aligned: true,
            masterVolume,
            masterMuted,
          })
          const file = `stem-${slugify(track.name) || track.id}-${stamp}.wav`
          downloadBlob(encodeWav(result.buffer), file)
          reports.push({
            label: track.name,
            file,
            loudness: result.loudness,
            warnings: result.warnings,
          })
          setExportReports([...reports])
          await pause(260)
        }
        for (const group of groupsRef.current) {
          if (!stems.some((track) => track.groupId === group.id)) continue
          const result = await engine.render({
            bpm,
            bars: exportBars,
            groupId: group.id,
            aligned: true,
            masterVolume,
            masterMuted,
          })
          const file = `grupo-${slugify(group.name) || group.id}-${stamp}.wav`
          downloadBlob(encodeWav(result.buffer), file)
          reports.push({
            label: `Grupo · ${group.name}`,
            file,
            loudness: result.loudness,
            warnings: result.warnings,
          })
          setExportReports([...reports])
          await pause(260)
        }
        notify(
          `${reports.length} stem(s) exportado(s) · alinhados em ${exportBars} compasso(s)`,
        )
      } else {
        const result = await engine.render({
          bpm,
          bars: exportBars,
          trackId: exportScope === 'track' ? selectedTrack?.id : undefined,
          masterVolume,
          masterMuted,
        })
        const file =
          exportScope === 'track' && selectedTrack
            ? `${slugify(selectedTrack.name) || 'track'}-${stamp}.wav`
            : `mix-${stamp}.wav`
        downloadBlob(encodeWav(result.buffer), file)
        reports.push({
          label: exportScope === 'track' ? selectedTrack?.name ?? 'Track' : 'Mix completo',
          file,
          loudness: result.loudness,
          warnings: result.warnings,
        })
        setExportReports(reports)
        const { integratedLufs, peakDb } = result.loudness
        notify(
          `WAV exportado (${result.buffer.duration.toFixed(1)}s) · ${formatLufs(
            integratedLufs,
          )} LUFS · pico ${formatLufs(peakDb)} dBFS`,
        )
      }
      const flagged = reports.filter((report) => report.warnings.length > 0)
      if (flagged.length > 0) {
        notify(`Avisos: ${flagged.map((report) => report.warnings.join(' · ')).join(' | ')}`)
      }
      if (unresolvedPlugins > 0) {
        notify(
          `Atenção: ${unresolvedPlugins} lane(s) saíram secas — o plugin nativo delas não devolveu áudio. A janela de FX diz qual foi.`,
        )
      }
    } catch (error) {
      notify(`Falha ao exportar: ${(error as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  // --------------------------------------------------------------- shortcuts

  const removeSelected = () => {
    const id = selectedRef.current
    if (!id) return
    // Del on a folder must not delete the tracks it holds.
    if (tracksRef.current.find((track) => track.id === id)?.isFolder) removeFolder(id)
    else removeTrack(id)
  }

  const duplicateSelected = () => {
    const id = selectedRef.current
    if (!id) return
    if (tracksRef.current.find((track) => track.id === id)?.isFolder) {
      notify('Pasta não é duplicável — duplique as tracks que estão dentro dela')
      return
    }
    duplicateTrack(id)
  }

  const toggleMuteSelected = () => {
    const id = selectedRef.current
    if (id) toggleMute(id)
  }

  const toggleSoloSelected = () => {
    const id = selectedRef.current
    if (id) toggleSolo(id)
  }

  const actionsRef = useRef({
    togglePlay: () => {},
    goStart: () => {},
    removeSelected: () => {},
    duplicateSelected: () => {},
    muteSelected: () => {},
    soloSelected: () => {},
    record: () => {},
    metronome: () => {},
    loop: () => {},
    save: () => {},
    exportAudio: () => {},
    copyClip: () => {},
    cutClip: () => {},
    pasteClip: () => {},
    undo: () => {},
    redo: () => {},
    toggleSnap: () => {},
    zoomIn: () => {},
    zoomOut: () => {},
  })
  actionsRef.current = {
    togglePlay,
    goStart: () => seek(0),
    removeSelected,
    duplicateSelected,
    muteSelected: toggleMuteSelected,
    soloSelected: toggleSoloSelected,
    record: () => void toggleRecord(),
    metronome: toggleMetronome,
    loop: toggleLoop,
    save: saveProject,
    exportAudio: openExport,
    copyClip: () => copySelection(),
    cutClip: () => cutSelection(),
    pasteClip: () => pasteSelection(),
    undo,
    redo,
    toggleSnap: () => toggleSnap(),
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        // First Escape leaves the field, the next one closes the panel behind it.
        if (event.key === 'Escape') target?.blur?.()
        return
      }
      const actions = actionsRef.current
      // Jamming on the computer keyboard wins over the letter shortcuts, and
      // swallows auto-repeat so a held key does not machine-gun the take.
      if (pcKeysRef.current) {
        const rawKey = pcRawKeyOf(event)
        if (rawKey !== undefined) {
          event.preventDefault()
          if (!event.repeat) pcNoteOnRef.current(rawKey)
          return
        }
        if (event.key === 'z' || event.key === 'Z') {
          if (event.ctrlKey || event.metaKey || event.altKey) {
            // leave Ctrl+Z to undo
          } else {
            event.preventDefault()
            shiftPcOctaveRef.current(-1)
            return
          }
        } else if (event.key === 'x' || event.key === 'X') {
          if (event.ctrlKey || event.metaKey || event.altKey) {
            // leave Ctrl+X to cut
          } else {
            event.preventDefault()
            shiftPcOctaveRef.current(1)
            return
          }
        } else if (event.key === 'Escape') {
          pcAllNotesOffRef.current()
          // Fall through: Escape still has to close the panel it was pressed in.
        }
      }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 's') {
          event.preventDefault()
          actions.save()
        }
        if (event.key.toLowerCase() === 'd') {
          event.preventDefault()
          actions.duplicateSelected()
        }
        if (event.key.toLowerCase() === 'e') {
          event.preventDefault()
          actions.exportAudio()
        }
        if (event.key.toLowerCase() === 'c') {
          event.preventDefault()
          actions.copyClip()
        }
        if (event.key.toLowerCase() === 'x') {
          event.preventDefault()
          actions.cutClip()
        }
        if (event.key.toLowerCase() === 'v') {
          event.preventDefault()
          actions.pasteClip()
        }
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault()
          if (event.shiftKey) actions.redo()
          else actions.undo()
        }
        if (event.key.toLowerCase() === 'y') {
          event.preventDefault()
          actions.redo()
        }
        return
      }
      switch (event.key) {
        case 'Escape':
          closeTopModalRef.current()
          break
        case ' ':
          event.preventDefault()
          actions.togglePlay()
          break
        case 'Delete':
        case 'Backspace':
          event.preventDefault()
          actions.removeSelected()
          break
        case 'm':
        case 'M':
          actions.muteSelected()
          break
        case 's':
        case 'S':
          actions.soloSelected()
          break
        case 'r':
        case 'R':
          actions.record()
          break
        case 'k':
        case 'K':
          actions.metronome()
          break
        case 'l':
        case 'L':
          actions.loop()
          break
        case 'b':
        case 'B':
          actions.toggleSnap()
          break
        case '+':
        case '=':
          event.preventDefault()
          actions.zoomIn()
          break
        case '-':
        case '_':
          event.preventDefault()
          actions.zoomOut()
          break
        case 'Home':
          event.preventDefault()
          actions.goStart()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const across = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
          const up = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
          const span = event.shiftKey ? 4 : 1
          // Only claimed when a piano-roll box is open; otherwise the browser
          // keeps scrolling the arrange view.
          if (nudgeRollRef.current(across * span, up * span)) event.preventDefault()
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const onKeyUp = (event: KeyboardEvent) => {
      if (!pcKeysRef.current) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return
      }
      const rawKey = event.key.toLowerCase()
      if (!(rawKey in PC_KEY_SEMITONES)) return
      event.preventDefault()
      pcNoteOffRef.current(rawKey)
    }
    // Focus can leave the window with a key still down; release it rather than
    // leave a note ringing (and a pending take open) forever.
    const releaseAll = () => pcAllNotesOffRef.current()
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseAll)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', releaseAll)
    }
  }, [])

  const changeBars = (value: number) => {
    const bars = Math.max(1, Math.min(128, Math.round(value) || 1))
    setArrangementBars(bars)
    arrangementBarsRef.current = bars
    const total = bars * STEP_COUNT
    if (playheadRef.current >= total) {
      setPlayheadStep(total - 1)
      playheadRef.current = total - 1
    }
  }

  // ------------------------------------------------------- snap / zoom / fades
  const snapRef = useRef(true)
  snapRef.current = snapEnabled
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)

  /** Grid snapping for timeline edits; `free` (Alt held) overrides it. */
  const snapStep = (value: number, free = false): number =>
    free || !snapRef.current ? value : Math.round(value)

  const toggleSnap = () => {
    const next = !snapRef.current
    snapRef.current = next
    setSnapEnabled(next)
    notify(next ? 'Snap ligado: edições encaixam no 16º' : 'Snap desligado: edição livre')
  }

  // Halve / double the visible span. Written as a functional update so that
  // repeated clicks in the same batch stack instead of all computing from the
  // same stale value.
  const zoomStep = (direction: 1 | -1) => {
    setZoomBars((prev) => {
      const total = Math.max(1, arrangementBarsRef.current)
      const current = prev > 0 ? prev : total
      const next = direction > 0 ? Math.max(1, Math.floor(current / 2)) : current * 2
      return next >= total ? 0 : next
    })
  }

  // Ctrl + roda do mouse sobre a timeline = zoom.
  useEffect(() => {
    const node = timelineScrollRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomStep(event.deltaY < 0 ? 1 : -1)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
    // zoomStep only reads a ref and a functional updater, so it never needs to
    // be re-attached: the listener stays valid for the life of the scroll node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fxTrack = fxTrackId ? tracks.find((track) => track.id === fxTrackId) ?? null : null
  const fxChainEntries = fxTrack ? chainEntriesFor(fxTrack) : []
  const availableBuiltinFx = fxTrack
    ? BUILTIN_FX_IDS.filter((fxId) => !fxTrack.chain.includes(builtinChainId(fxId)))
    : []
  /**
   * The track's FX window is a window, not a card: the producer puts it where
   * they want it and puts it away when they need the arrangement back. A plugin
   * interface that cannot move is a plugin interface with no room to be read,
   * and one that cannot be hidden is a rack the mix cannot see past.
   *
   * The offset is a translate on the window itself, so the overlay keeps laying
   * out the space it centres in and the drag only moves what is drawn. The clamp
   * is measured from where the window actually sits: a window smaller than the
   * screen never leaves it, and one that is bigger can be walked across it — but
   * never so far that there is nothing left on screen to grab.
   */
  const [fxOffset, setFxOffset] = useState({ x: 0, y: 0 })
  /** A size the producer pulled the window to; null keeps the sheet's own. */
  const [fxSize, setFxSize] = useState<{ width: number; height: number } | null>(null)
  const [fxMinimized, setFxMinimized] = useState(false)
  const fxWindowRef = useRef<HTMLDivElement | null>(null)
  const fxDrag = useRef<{
    startX: number
    startY: number
    fromX: number
    fromY: number
    /** Where the window sits with no offset on it — the base the clamp uses. */
    baseLeft: number
    baseTop: number
    width: number
    height: number
  } | null>(null)
  const fxResize = useRef<{
    startX: number
    startY: number
    fromWidth: number
    fromHeight: number
    /** Where the sheet puts the window with no offset on it, for the size it has now. */
    centerLeft: number
    centerTop: number
    /** The size and offset actually on screen, so the next step can correct them. */
    curWidth: number
    curHeight: number
    fromX: number
    fromY: number
  } | null>(null)

  // Each window that opens comes up centred, sized by the sheet, and open: the
  // last place a previous rack was dragged to is not where this one belongs.
  useEffect(() => {
    setFxOffset({ x: 0, y: 0 })
    setFxSize(null)
    setFxMinimized(false)
  }, [fxTrackId])

  const startFxDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // A press on a button or a field inside the header is a press, not a handle.
    if ((event.target as HTMLElement).closest('button, input, select')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const node = fxWindowRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    fxDrag.current = {
      startX: event.clientX,
      startY: event.clientY,
      fromX: fxOffset.x,
      fromY: fxOffset.y,
      baseLeft: rect.left - fxOffset.x,
      baseTop: rect.top - fxOffset.y,
      width: rect.width,
      height: rect.height,
    }
    // The window keeps answering while the cursor is anywhere: a rack dragged
    // across the screen is routinely released over something else, and a header
    // that only listens to itself would leave the window half-moved with no more
    // moves coming.
    window.addEventListener('pointermove', moveFxDrag)
    window.addEventListener('pointerup', endFxDrag)
    window.addEventListener('pointercancel', endFxDrag)
  }

  const moveFxDrag = useCallback((event: PointerEvent): void => {
    const drag = fxDrag.current
    if (!drag) return
    setFxOffset(
      offsetIntoViewport(
        drag.fromX + (event.clientX - drag.startX),
        drag.fromY + (event.clientY - drag.startY),
        drag.baseLeft,
        drag.baseTop,
        drag.width,
        drag.height,
        window.innerWidth,
        window.innerHeight,
      ),
    )
  }, [])

  const endFxDrag = useCallback((): void => {
    if (!fxDrag.current) return
    fxDrag.current = null
    window.removeEventListener('pointermove', moveFxDrag)
    window.removeEventListener('pointerup', endFxDrag)
    window.removeEventListener('pointercancel', endFxDrag)
  }, [moveFxDrag])

  /**
   * The corner grip. A rack that is always 96vw wide has nowhere to be dragged
   * to, and a plugin face that is too big for its pane has nowhere to grow: the
   * size is the other half of "movable with the mouse", and it is what makes the
   * room the plugin's own interface asks for a thing the producer can give it.
   */
  const startFxResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const node = fxWindowRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    fxResize.current = {
      startX: event.clientX,
      startY: event.clientY,
      fromWidth: rect.width,
      fromHeight: rect.height,
      centerLeft: rect.left - fxOffset.x,
      centerTop: rect.top - fxOffset.y,
      curWidth: rect.width,
      curHeight: rect.height,
      fromX: fxOffset.x,
      fromY: fxOffset.y,
    }
    window.addEventListener('pointermove', sizeFxDrag)
    window.addEventListener('pointerup', endFxResize)
    window.addEventListener('pointercancel', endFxResize)
  }

  const sizeFxDrag = useCallback((event: PointerEvent): void => {
    const grip = fxResize.current
    if (!grip) return
    // Never smaller than a chain column and a pedal row: below that the rack
    // reads as a broken window rather than a small one.
    const width = Math.round(
      Math.min(Math.max(360, grip.fromWidth + (event.clientX - grip.startX)), window.innerWidth - 8),
    )
    const height = Math.round(
      Math.min(
        Math.max(180, grip.fromHeight + (event.clientY - grip.startY)),
        window.innerHeight - 8,
      ),
    )
    // The overlay centres what it holds, so growing the window walks its top-left
    // corner outward on its own. That movement is tracked here rather than
    // measured, because the step the producer is pulling is the one that has to
    // stay under the cursor — and the window still has to end up inside the
    // screen, however it grew.
    grip.centerLeft += (grip.curWidth - width) / 2
    grip.centerTop += (grip.curHeight - height) / 2
    grip.curWidth = width
    grip.curHeight = height
    setFxSize({ width, height })
    setFxOffset(
      offsetIntoViewport(
        grip.fromX,
        grip.fromY,
        grip.centerLeft,
        grip.centerTop,
        width,
        height,
        window.innerWidth,
        window.innerHeight,
      ),
    )
  }, [])

  const endFxResize = useCallback((): void => {
    if (!fxResize.current) return
    fxResize.current = null
    window.removeEventListener('pointermove', sizeFxDrag)
    window.removeEventListener('pointerup', endFxResize)
    window.removeEventListener('pointercancel', endFxResize)
  }, [sizeFxDrag])

  // A rack that goes away mid-gesture takes the gesture with it: the listeners
  // belong to the press, not to the page outliving it.
  useEffect(
    () => () => {
      fxDrag.current = null
      fxResize.current = null
      window.removeEventListener('pointermove', moveFxDrag)
      window.removeEventListener('pointerup', endFxDrag)
      window.removeEventListener('pointercancel', endFxDrag)
      window.removeEventListener('pointermove', sizeFxDrag)
      window.removeEventListener('pointerup', endFxResize)
      window.removeEventListener('pointercancel', endFxResize)
    },
    [moveFxDrag, endFxDrag, sizeFxDrag, endFxResize],
  )

  const midiEditorTrack = midiEditorId
    ? (tracks.find((track) => track.id === midiEditorId && track.kind === 'instrument') ?? null)
    : null
  // The drum editor becomes a hardware-style step grid as soon as the track
  // loops: the columns are the loop, not the whole song.
  const seqTrack =
    midiEditorTrack && midiEditorTrack.instrument === 'drums' && midiEditorTrack.patternSteps > 0
      ? midiEditorTrack
      : null
  const seqSteps = seqTrack ? seqTrack.patternSteps : 16
  const seqPlayStep = seqTrack ? Math.floor(playheadStep % seqSteps) : 0
  /** Columns the piano roll draws: the loop when there is one, the song otherwise. */
  const rollSteps = (track: TrackState) =>
    track.patternSteps > 0 ? Math.min(track.patternSteps, totalSteps) : totalSteps
  const masterLevel = levels.master ?? 0
  const masterReduction = levels.masterGr ?? 0
  /**
   * How a loudness number is written on the strip: the meter's own formatting,
   * plus a dash for the case where there is no measurement yet. Under the gate
   * the standard says the passage is silent and the meter shows -inf; before the
   * first window has closed there is no number at all, so it shows a dash rather
   * than inventing one.
   */
  const meterText = (value: number | undefined): string =>
    value === undefined ? '—' : formatLufs(value)

  const totalSteps = Math.max(1, arrangementBars * STEP_COUNT)
  const currentStep = Math.floor(playheadStep) % STEP_COUNT
  const currentBar = Math.min(arrangementBars, Math.floor(playheadStep / STEP_COUNT) + 1)
  const currentBeat = Math.floor((playheadStep % STEP_COUNT) / 4) + 1
  // Secondary, discreet readout: BAR.BEAT.16th (the main clock is elapsed time).
  const barBeatText = `${String(currentBar).padStart(3, '0')}.${currentBeat}.${String(
    Math.floor(playheadStep % 4) + 1,
  ).padStart(2, '0')}`
  const playheadLeft = (playheadStep / totalSteps) * 100
  const barWidthPct = 100 / arrangementBars
  // Zoom: how many bars are visible. 0 means the whole arrangement fits.
  const visibleBars = Math.max(1, Math.min(zoomBars > 0 ? zoomBars : arrangementBars, arrangementBars))
  const contentWidthPct = (arrangementBars / visibleBars) * 100

  // When zoomed in, keep the playhead inside the visible part of the ruler.
  useEffect(() => {
    const node = timelineScrollRef.current
    if (!node || zoomBars <= 0) return
    const viewWidth = node.clientWidth
    if (viewWidth <= 0) return
    const contentWidth = (viewWidth * contentWidthPct) / 100
    const x = (playheadStep / totalSteps) * contentWidth
    if (x < node.scrollLeft + 24 || x > node.scrollLeft + viewWidth - 48) {
      node.scrollLeft = Math.max(0, x - viewWidth * 0.25)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadStep, zoomBars, contentWidthPct, totalSteps])

  const clipStyle = (track: TrackState) => {
    const stepDuration = 60 / bpm / 4
    const left = Math.min(100, Math.max(0, (track.clipStart / totalSteps) * 100))
    const width = (track.clipDuration / stepDuration / totalSteps) * 100
    return {
      left: `${left}%`,
      width: `${Math.max(2, Math.min(width, 100 - left))}%`,
    }
  }

  const midiClipStyle = (track: TrackState) => {
    // A looping pattern is one item that repeats, so the arrangement shows the
    // whole song width with the loop divisions striped across it - not a box
    // whose size depends on how the hits happen to be spread.
    if (track.patternSteps > 0) return { left: '0%', width: '100%' }
    let min = Infinity
    let max = -Infinity
    for (const note of track.midiNotes) {
      if (note.step < min) min = note.step
      if (note.step + note.length > max) max = note.step + note.length
    }
    if (!Number.isFinite(min)) return { left: '0%', width: '0%' }
    const left = Math.min(100, Math.max(0, (min / totalSteps) * 100))
    const width = (max / totalSteps) * 100 - left
    return { left: `${left}%`, width: `${Math.max(3, Math.min(width, 100 - left))}%` }
  }

  /** How the loop is described on the arrangement: "2 comp. ×8". */
  const patternLabel = (track: TrackState): string => {
    const bars = Math.max(1, Math.round(track.patternSteps / STEP_COUNT))
    const repeats = Math.max(1, Math.floor(arrangementBars / bars))
    return `${bars} comp. ×${repeats}`
  }

  // Drag a recorded clip left/right to move its start step on the timeline.
  const onClipPointerDown = (event: ReactPointerEvent<HTMLDivElement>, track: TrackState) => {
    if (event.button !== 0) return
    // Shift belongs to the lane: it picks a range instead of moving the take.
    if (event.shiftKey) return
    if ((event.target as HTMLElement).closest('.clip-close')) return
    const lane = event.currentTarget.parentElement
    if (!lane) return
    clipDragRef.current = {
      trackId: track.id,
      startX: event.clientX,
      startStep: track.clipStart,
      pxPerStep: lane.clientWidth / Math.max(1, totalSteps),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedTrackId(track.id)
  }

  const onClipPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = clipDragRef.current
    if (!drag) return
    const delta = (event.clientX - drag.startX) / drag.pxPerStep
    const clamped = Math.max(0, Math.min(totalSteps - 1, snapStep(drag.startStep + delta, event.altKey)))
    const current = tracksRef.current.find((track) => track.id === drag.trackId)
    if (!current || current.clipStart === clamped) return
    engineRef.current?.setClipStart(drag.trackId, clamped)
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === drag.trackId ? { ...track, clipStart: clamped } : track,
      ),
    )
  }

  const onClipPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    clipDragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // Main transport clock: elapsed time in minutes and seconds.
  const stepSeconds = 60 / bpm / 4
  const positionSeconds = playheadStep * stepSeconds
  const timeText = `${String(Math.floor(positionSeconds / 60)).padStart(2, '0')}:${(
    positionSeconds % 60
  )
    .toFixed(1)
    .padStart(4, '0')}`

  const scrubStepFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    return Math.max(0, Math.min(totalSteps - 0.001, ratio * totalSteps))
  }

  const rulerScrubMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const step = scrubStepFromEvent(event)
    // Shift held on the ruler means "pick a range", not "move the cursor".
    const sel = selDragRef.current
    if (sel) {
      const to = snapStep(step)
      setTimeSel(to >= sel.anchor ? { from: sel.anchor, to } : { from: to, to: sel.anchor })
      return
    }
    if (!scrubActiveRef.current) return
    // While stopped the playhead follows the pointer live; while playing we
    // only show a ghost line and commit on release (avoids restarting the
    // transport on every pointermove).
    if (isPlaying) setScrubGhost(step)
    else setPlayheadStep(step)
  }

  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    if (event.shiftKey) {
      const anchor = snapStep(scrubStepFromEvent(event))
      selDragRef.current = { anchor }
      setTimeSel({ from: anchor, to: anchor })
      return
    }
    scrubActiveRef.current = true
    rulerScrubMove(event)
  }

  const onRulerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (selDragRef.current) {
      const sel = selDragRef.current
      selDragRef.current = null
      const to = snapStep(scrubStepFromEvent(event))
      const range = { from: Math.min(sel.anchor, to), to: Math.max(sel.anchor, to) }
      // A click without a real drag means the user wanted the cursor after all.
      setTimeSel(range.to - range.from >= 1 ? range : null)
      if (range.to - range.from < 1) seek(Math.floor(range.from))
      return
    }
    if (!scrubActiveRef.current) return
    scrubActiveRef.current = false
    const step = scrubStepFromEvent(event)
    setScrubGhost(null)
    if (isPlaying) seek(Math.floor(step))
  }

  /**
   * Shift+drag on a lane picks the very same time range as on the ruler — the
   * lane spans the full arrangement width, so the ratio math is shared. Having
   * it on the lane is what turns "select this part of this take" into one
   * gesture instead of hunting for the thin ruler strip above, and the drag
   * also focuses the track it started on.
   */
  const onLaneSelPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    trackId: string,
  ) => {
    if (event.button !== 0 || !event.shiftKey) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
    const anchor = snapStep(scrubStepFromEvent(event))
    selDragRef.current = { anchor }
    setTimeSel({ from: anchor, to: anchor })
    setSelectedTrackId(trackId)
  }

  const onLaneSelPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const sel = selDragRef.current
    if (!sel) return
    const to = snapStep(scrubStepFromEvent(event))
    setTimeSel(to >= sel.anchor ? { from: sel.anchor, to } : { from: to, to: sel.anchor })
  }

  const onLaneSelPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selDragRef.current) return
    onRulerPointerUp(event)
  }

  // Lanes with a tap really running, for the live spectrum panel.
  const recordingLanes = tracks
    .filter((track) => liveInput[track.id] && takeProgress[track.id])
    .map((track) => ({ id: track.id, name: track.name, color: track.color }))

  return (
    <div className="reaper-shell">
      <header className={`menu-bar ${isNativeApp() ? 'native' : ''}`}>
        <div className="logo">
          OpenDAW <span>STUDIO v1.5</span>
        </div>
        <nav className="menu-items" ref={menuBarRef}>
          <div className="menu-item">
            <span>Arquivo</span>
            <div className="dropdown">
              <button type="button" onClick={newProject}>
                Novo Projeto
              </button>
              <button type="button" onClick={saveProject}>
                Salvar Projeto (Ctrl+S)
              </button>
              <button type="button" onClick={loadProject}>
                Carregar Projeto
              </button>
              <button type="button" onClick={openVersions}>
                Versões do Autosave…
              </button>
              <button
                type="button"
                disabled={exportingProject}
                onClick={() => void exportProjectFile()}
              >
                {exportingProject ? 'Salvando projeto…' : 'Exportar Projeto (.opdaw)'}
              </button>
              <button type="button" onClick={openProjectFile}>
                Abrir Projeto (.opdaw)…
              </button>
              <button type="button" onClick={() => openAudioImport()}>
                Importar Áudio (WAV/MP3/OGG/FLAC)…
              </button>
              <button type="button" onClick={openExport}>
                Exportar Áudio (WAV)…
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Editar</span>
            <div className="dropdown">
              <button type="button" disabled={historyDepth.undo === 0} onClick={undo}>
                Desfazer ({historyDepth.undo}) — Ctrl+Z
              </button>
              <button type="button" disabled={historyDepth.redo === 0} onClick={redo}>
                Refazer ({historyDepth.redo}) — Ctrl+Shift+Z
              </button>
              <button type="button" onClick={() => copySelection()}>
                Copiar seleção — Ctrl+C
              </button>
              <button type="button" onClick={() => cutSelection()}>
                Recortar seleção — Ctrl+X
              </button>
              <button type="button" onClick={() => pasteSelection()}>
                Colar na posição do playhead — Ctrl+V
              </button>
              <button type="button" onClick={duplicateSelected}>
                Duplicar track (Ctrl+D)
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Ver</span>
            <div className="dropdown">
              <button type="button" onClick={() => setShowMixer((value) => !value)}>
                Alternar Mixer
              </button>
              <button type="button" onClick={toggleSnap}>
                Snap {snapEnabled ? '(on)' : '(off)'} — tecla B
              </button>
              <button type="button" onClick={() => zoomStep(1)}>
                Aproximar timeline — Ctrl+roda
              </button>
              <button type="button" onClick={() => zoomStep(-1)}>
                Afastar timeline
              </button>
              <button type="button" onClick={() => setZoomBars(0)}>
                Encaixar todos os compassos
              </button>
              <button type="button" onClick={toggleMetronome}>
                Metrônomo {metronome ? '(on)' : '(off)'}
              </button>
              <button type="button" onClick={toggleLoop}>
                Loop {loop ? '(on)' : '(off)'}
              </button>
              <button type="button" onClick={() => setCountIn((prev) => !prev)}>
                Count-in {countIn ? '(on)' : '(off)'}
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Mix</span>
            <div className="dropdown">
              <button type="button" onClick={() => setShowMasterFx(true)}>
                FX do Master / Buses de envio…
              </button>
              <button
                type="button"
                onClick={() => {
                  setSalaMounted(true)
                  setShowSala(true)
                }}
              >
                Cabo virtual com a sala SALA… {salaLive ? '(ligado)' : '(desligado)'}
              </button>
              <button type="button" onClick={() => setShowMixer(true)}>
                Abrir Mixer
              </button>
              <button type="button" onClick={resetStaging}>
                Zerar trim / fase / mono / envios
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Track</span>
            <div className="dropdown">
              <button type="button" onClick={addTrack}>
                Inserir Track
              </button>
              {INSTRUMENT_KINDS.map((kind) => (
                <button type="button" key={kind} onClick={() => addInstrumentTrack(kind)}>
                  {instrumentIcon(kind)} Nova Track de {instrumentLabel(kind)}
                </button>
              ))}
              <button type="button" className={pcKeys ? 'on' : ''} onClick={togglePcKeys}>
                {pcKeys ? 'Desligar' : 'Ligar'} teclado do computador (tocar piano/baixo)
              </button>
              <button type="button" onClick={addFolder}>
                Nova pasta de tracks
              </button>
              <button type="button" onClick={() => createGroup()}>
                Novo sub-grupo com a selecionada
              </button>
              <button type="button" onClick={() => createGroup([])}>
                Novo sub-grupo vazio
              </button>
              <button type="button" onClick={duplicateSelected}>
                Duplicar Selecionada (Ctrl+D)
              </button>
              <button type="button" onClick={removeSelected}>
                Remover Selecionada (Del)
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Devices</span>
            <div className="dropdown">
              {/* One window for the whole signal path in and out: entries, outputs,
                  latency and what each lane is patched to. */}
              <button type="button" onClick={() => void openDevices()}>
                ⚙ Dispositivos de áudio…
              </button>
              {/* Device detection lives here, and only here: one call that asks
                  for permission, lists every input and refreshes the latency. */}
              <button type="button" onClick={() => void refreshInputs()}>
                Detectar entradas de áudio
              </button>
              <button type="button" onClick={() => void enableMidi()}>
                🎹 Controladores MIDI…
              </button>
            </div>
          </div>
        </nav>
        <div className="device-status">
          <button
            type="button"
            className="reaper-btn"
            title="Entradas, saídas e latência — o painel de dispositivos"
            onClick={() => void openDevices()}
          >
            ⚙ DISPOSITIVOS
          </button>
          <span className="mic-label">
            {inputs.length > 0 ? `${inputs.length} entrada(s)` : 'Nenhuma entrada — use Devices'}
          </span>
          <span className={`midi-status ${midiInputId ? 'linked' : ''}`}>
            <span className={`midi-led ${midiLed ? 'on' : ''}`} />
            {midiInputId
              ? midiDevices.find((device) => device.id === midiInputId)?.name ?? 'MIDI ativo'
              : 'MIDI off'}
          </span>
          <button type="button" className="reaper-btn" onClick={() => void enableMidi()}>
            🎹 MIDI
          </button>
        </div>
      </header>

      <section className="transport-bar">
        <div className="transport-buttons">
          <button
            type="button"
            className="transport-btn"
            title="Ir para o início (Home)"
            onClick={() => seek(0)}
          >
            ⏮
          </button>
          <button
            type="button"
            className={`transport-btn btn-rec ${isRecording ? 'recording' : ''}`}
            title="Gravar (R)"
            onClick={() => void toggleRecord()}
          >
            ●
          </button>
          <button
            type="button"
            className={`transport-btn btn-play ${isPlaying ? 'active' : ''}`}
            title="Play / Stop (Espaço)"
            onClick={togglePlay}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button type="button" className="transport-btn" title="Parar" onClick={stopPlayback}>
            ◼
          </button>
          <button
            type="button"
            className={`transport-btn toggle ${metronome ? 'on' : ''}`}
            title="Metrônomo (K)"
            onClick={toggleMetronome}
          >
            ♪
          </button>
          <button
            type="button"
            className={`transport-btn toggle count-in-btn ${countIn ? 'on' : ''}`}
            title="Count-in: um compasso de cliques antes do play"
            onClick={() => setCountIn((prev) => !prev)}
          >
            1234
          </button>
          <button
            type="button"
            className={`transport-btn toggle punch-btn ${punchIn ? 'on' : ''}`}
            title={
              punchIn
                ? 'Punch-in LIGADO: ● só grava dentro da área selecionada — arraste com Shift na régua ou na lane para marcar a área'
                : 'Punch-in: grava só dentro da área selecionada, o resto continua tocando'
            }
            onClick={togglePunch}
          >
            PUN
          </button>
          <button
            type="button"
            className={`transport-btn toggle ${loop ? 'on' : ''}`}
            title="Loop (L)"
            onClick={toggleLoop}
          >
            ⟲
          </button>
        </div>

        <div className="transport-display">
          <div className="display-time" title="Tempo decorrido (mm:ss.d) · compasso . batida . 16ª">
            <span className="clock-main">{timeText}</span>
            <span className="clock-sub">{barBeatText}</span>
          </div>
          <div className="display-bpm">
            <label htmlFor="bpm-input">BPM</label>
            <input
              id="bpm-input"
              type="number"
              min={40}
              max={280}
              value={bpm}
              onChange={(event) => setBpm(Number(event.target.value) || 120)}
            />
          </div>
          <div className="display-bars">
            <label htmlFor="bars-input">BARS</label>
            <input
              id="bars-input"
              type="number"
              min={1}
              max={128}
              value={arrangementBars}
              onChange={(event) => changeBars(Number(event.target.value))}
            />
          </div>
          <div className="display-step">
            BAR{' '}
            <span>
              {String(currentBar).padStart(3, '0')}/{String(arrangementBars).padStart(2, '0')}
            </span>{' '}
            · 16ª <span>{currentStep + 1}/16</span>
          </div>
        </div>

        <div className="transport-options">
          <div className="quick-actions" role="group" aria-label="Ações rápidas">
            <button
              type="button"
              className="qa-btn"
              onClick={undo}
              disabled={historyDepth.undo === 0}
              title={
                historyDepth.undo === 0
                  ? 'Nada para desfazer'
                  : `Desfazer (Ctrl+Z) — ${historyDepth.undo} passo(s)`
              }
            >
              ↶
            </button>
            <button
              type="button"
              className="qa-btn"
              onClick={redo}
              disabled={historyDepth.redo === 0}
              title={
                historyDepth.redo === 0
                  ? 'Nada para refazer'
                  : `Refazer (Ctrl+Shift+Z) — ${historyDepth.redo} passo(s)`
              }
            >
              ↷
            </button>
            <span className="qa-sep" aria-hidden="true" />
            <button
              type="button"
              className="qa-btn"
              onClick={addTrack}
              title="Nova track de áudio · Track ▸ Inserir Track"
            >
              ＋
            </button>
            {INSTRUMENT_KINDS.map((kind) => (
              <button
                type="button"
                className="qa-btn"
                key={kind}
                onClick={() => addInstrumentTrack(kind)}
                title={`Nova track de ${instrumentLabel(kind).toLowerCase()} · Track ▸ Nova Track de ${instrumentLabel(kind)}`}
              >
                {instrumentIcon(kind)}
              </button>
            ))}
            <button
              type="button"
              className={`qa-btn key-toggle ${pcKeys ? 'on' : ''}`}
              onClick={togglePcKeys}
              title={
                pcKeys
                  ? 'Teclado ligado: em piano/baixo A a ; tocam a escala (Z e X mudam de oitava); na bateria A ; são kick, caixa e pratos, Q U os agudos · Esc solta tudo'
                  : 'Ligar o teclado do computador para tocar piano, baixo e bateria sem interface MIDI'
              }
            >
              ⌨
            </button>
            <span className="qa-sep" aria-hidden="true" />
            <button
              type="button"
              className="qa-btn"
              onClick={() => openAudioImport()}
              title="Importar áudio para a track selecionada · File ▸ Importar Áudio"
            >
              ⬆
            </button>
            <button
              type="button"
              className="qa-btn danger"
              onClick={removeSelected}
              disabled={!selectedTrackId}
              title="Remover a track selecionada (Del) · Track ▸ Remover Selecionada"
            >
              ✕
            </button>
            <button
              type="button"
              className="qa-btn"
              onClick={openExport}
              title="Exportar a mixagem em WAV (Ctrl+E) · File ▸ Exportar Áudio"
            >
              ⬇
            </button>
            <span className="qa-sep" aria-hidden="true" />
            <button
              type="button"
              className={`qa-btn ${showMixer ? 'active' : ''}`}
              onClick={() => setShowMixer((value) => !value)}
              title={showMixer ? 'Ocultar o mixer' : 'Mostrar o mixer'}
              aria-pressed={showMixer}
            >
              🎚
            </button>
          </div>
        </div>
      </section>

      <main className="daw-workspace">
        <aside className="tcp-panel">
          {laneRows.map((row) => {
            const track = row.track
            if (track.isFolder) {
              const kids = tracks.filter((item) => item.folderId === track.id).length
              return (
                <div
                  key={track.id}
                  className={`tcp-folder ${selectedTrackId === track.id ? 'selected' : ''} ${
                    dragOverTrackId === track.id ? 'drag-over' : ''
                  }`}
                  style={{ borderLeftColor: track.color }}
                  onClick={() => setSelectedTrackId(track.id)}
                  onContextMenu={(event) => openClipMenu(event, track.id)}
                  onDragOver={(event) => {
                    if (!dragTrackIdRef.current || dragTrackIdRef.current === track.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (dragOverTrackId !== track.id) setDragOverTrackId(track.id)
                  }}
                  onDragLeave={() => {
                    if (dragOverTrackId === track.id) setDragOverTrackId(null)
                  }}
                  onDrop={(event) => {
                    const dragged = dragTrackIdRef.current
                    if (!dragged) return
                    event.preventDefault()
                    dragTrackIdRef.current = null
                    setDragOverTrackId(null)
                    // Dropping on a folder header means "put it in this folder".
                    assignFolder(dragged, track.id)
                  }}
                >
                  <button
                    type="button"
                    className="folder-fold"
                    title={track.collapsed ? 'Expandir a pasta' : 'Recolher a pasta'}
                    onClick={toggleFolder.bind(null, track.id)}
                  >
                    {track.collapsed ? '▶' : '▼'}
                  </button>
                  <input
                    className="track-title folder-title"
                    value={track.name}
                    onChange={(event) => renameTrack(track.id, event.target.value)}
                    aria-label={`Nome da pasta ${track.name}`}
                  />
                  <span className="folder-count">
                    {track.collapsed ? `${kids} oculta(s)` : `${kids} track(s)`}
                  </span>
                  <input
                    type="color"
                    className="track-color"
                    value={toHexColor(track.color)}
                    onChange={(event) => setTrackColor(track.id, event.target.value)}
                    title="Cor da pasta"
                    aria-label={`Cor da pasta ${track.name}`}
                  />
                  <button
                    type="button"
                    className="folder-add"
                    title="Nova track dentro desta pasta"
                    onClick={() => addTrackIntoFolder(track.id)}
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    className="folder-remove"
                    title="Excluir a pasta (as tracks dela continuam)"
                    onClick={() => removeFolder(track.id)}
                  >
                    ×
                  </button>
                </div>
              )
            }
            if (row.hidden) return null
            // Tracks that could still be added to this duck: real signal (no
            // folder), not this track, not already listening.
            const duckAvailable = tracks.filter(
              (other) =>
                !other.isFolder &&
                other.id !== track.id &&
                !track.duckSourceIds.includes(other.id),
            )
            return (
            <div
              key={track.id}
              className={`tcp-track ${row.indent ? 'in-folder' : ''} ${
                track.isArmed ? 'armed' : ''
              } ${selectedTrackId === track.id ? 'selected' : ''} ${
                dragOverTrackId === track.id ? 'drag-over' : ''
              }`}
              style={{ borderLeftColor: track.color }}
              onClick={() => setSelectedTrackId(track.id)}
              onContextMenu={(event) => openTrackMenu(event, track.id)}
              title="Botão direito: duplicar, remover, recortar/copiar/colar a track"
              onDragOver={(event) => {
                if (!dragTrackIdRef.current || dragTrackIdRef.current === track.id) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (dragOverTrackId !== track.id) setDragOverTrackId(track.id)
              }}
              onDragLeave={() => {
                if (dragOverTrackId === track.id) setDragOverTrackId(null)
              }}
              onDrop={(event) => {
                const dragged = dragTrackIdRef.current
                if (!dragged) return
                event.preventDefault()
                dragTrackIdRef.current = null
                setDragOverTrackId(null)
                reorderTracksTo(dragged, track.id)
              }}
            >
              <div className="tcp-header">
                <span
                  className="track-grip"
                  draggable
                  title="Arraste para reordenar as tracks"
                  onDragStart={(event) => {
                    dragTrackIdRef.current = track.id
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', track.id)
                  }}
                  onDragEnd={() => {
                    dragTrackIdRef.current = null
                    setDragOverTrackId(null)
                  }}
                >
                  ⠿
                </span>
                <span className="track-number">{track.number}</span>
                <input
                  type="color"
                  className="track-color"
                  value={toHexColor(track.color)}
                  onChange={(event) => setTrackColor(track.id, event.target.value)}
                  title="Cor da track (também no cabeçalho e na grade)"
                  aria-label={`Cor da track ${track.name}`}
                />
                <input
                  className="track-title"
                  value={track.name}
                  onChange={(event) => renameTrack(track.id, event.target.value)}
                  aria-label={`Nome da track ${track.number}`}
                />
                <div className="tcp-buttons">
                  <button
                    type="button"
                    className={`tcp-btn btn-arm ${track.isArmed ? 'armed' : ''}`}
                    title="Armar gravação"
                    onClick={() => toggleArm(track.id)}
                  >
                    ar
                  </button>
                  <button
                    type="button"
                    className={`tcp-btn btn-mute ${track.isMuted ? 'muted' : ''}`}
                    title="Mute (M)"
                    onClick={() => toggleMute(track.id)}
                  >
                    m
                  </button>
                  <button
                    type="button"
                    className={`tcp-btn btn-solo ${track.isSoloed ? 'soloed' : ''}`}
                    title="Solo (S)"
                    onClick={() => toggleSolo(track.id)}
                  >
                    s
                  </button>
                  <button
                    type="button"
                    className="tcp-btn btn-fx"
                    title="Cadeia de plugins"
                    onClick={() => setFxTrackId(track.id)}
                  >
                    FX{track.plugins.length > 0 ? ` ${track.plugins.length}` : ''}
                  </button>
                </div>
              </div>

              {track.kind === 'instrument' ? (
                <div className="tcp-controls-row input-row">
                  <button
                    type="button"
                    className="midi-edit-btn"
                    title={
                      isMelodic(track.instrument)
                        ? `Abrir piano roll de ${instrumentLabel(track.instrument).toLowerCase()}`
                        : 'Abrir step sequencer de bateria'
                    }
                    onClick={() => setMidiEditorId(track.id)}
                  >
                    {instrumentIcon(track.instrument)} Editor MIDI
                    {track.midiNotes.length > 0 ? ` · ${track.midiNotes.length}` : ''}
                  </button>
                </div>
              ) : (
              <>
              <div className="tcp-controls-row input-row">
                <span className="tcp-label">IN</span>
                <select
                  className="input-select"
                  value={track.inputDeviceId}
                  onChange={(event) => void selectInput(track.id, event.target.value)}
                  title="Dispositivo de entrada de áudio"
                >
                  <option value="">— Nenhuma —</option>
                  {/* A lane keeps its cable even when the machine is not offering
                      it — an interface that is unplugged, or a browser that has not
                      been shown the microphone yet. Said here rather than hidden by
                      a select that falls back to "— Nenhuma —" over a saved patch. */}
                  {track.inputDeviceId &&
                  !inputs.some((device) => device.deviceId === track.inputDeviceId) ? (
                    <option value={track.inputDeviceId}>
                      {liveInput[track.id]
                        ? 'Entrada aberta — o navegador não a nomeia'
                        : 'Lembrada — não está disponível agora'}
                    </option>
                  ) : null}
                  {inputs.map((device, index) => (
                    // The browser hides device ids until microphone permission
                    // is granted; an id-less entry cannot be opened, so it is
                    // shown but disabled rather than offered as a fake choice.
                    <option
                      key={device.deviceId || `unnamed-${index}`}
                      value={device.deviceId}
                      disabled={!device.deviceId}
                    >
                      {device.label || 'Entrada sem nome — permita o microfone'}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`mon-btn ${
                    track.inputMonitor || track.inputWet ? 'on' : ''
                  } ${track.inputDeviceId ? '' : 'idle'}`}
                  title={
                    !track.inputDeviceId
                      ? 'Selecione um dispositivo de entrada'
                      : track.inputWet
                        ? 'Monitorando a cadeia de efeitos (gravação com FX)'
                        : 'Monitorar entrada (use fones)'
                  }
                  onClick={() => toggleInputMonitor(track.id)}
                >
                  <span className="mon-led" />
                  <span className="mon-icon" aria-hidden="true">
                    🎧
                  </span>
                </button>
              </div>
              {/* Patching, second row: which part of the interface this lane owns
                  and what it prints. It only appears once a device is chosen, so a
                  lane without a cable stays one line tall. */}
              {track.inputDeviceId ? (
                <div className="tcp-controls-row input-row ch-row">
                  <span className="tcp-label">CH</span>
                  <select
                    className="ch-select"
                    value={track.inputChannel}
                    onChange={(event) =>
                      void selectInputChannel(track.id, Number(event.target.value))
                    }
                    title={
                      liveInput[track.id]
                        ? `O dispositivo entrega ${liveInput[track.id]?.sourceChannels} canal(is) — agora: ${describeLiveInput(liveInput[track.id])}`
                        : 'Canal desta track — a lista certa aparece quando a entrada abrir'
                    }
                  >
                    {channelOptions(track).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="ch-seg" role="group" title="O que esta track grava">
                    <button
                      type="button"
                      className={`ch-seg-btn ch-seg-wide ${!track.inputWet ? 'on' : ''}`}
                      title="Grava a entrada bruta; os efeitos continuam aplicados no play e podem ser mudados depois"
                      onClick={() => toggleInputWet(track.id)}
                    >
                      SECO
                    </button>
                    <button
                      type="button"
                      className={`ch-seg-btn ch-seg-wide ${track.inputWet ? 'live' : ''}`}
                      title="Grava a saída da cadeia de efeitos: a take sai igual ao que você ouve"
                      onClick={() => toggleInputWet(track.id)}
                    >
                      FX
                    </button>
                  </div>
                </div>
              ) : null}
              </>
              )}

              <div className="tcp-controls-row">
                <span className="tcp-label">PAN</span>
                <input
                  type="range"
                  className="tcp-slider"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={track.pan}
                  onChange={(event) => changePan(track.id, Number(event.target.value))}
                  title={`Pan: ${track.pan.toFixed(2)}`}
                />
              </div>
              <div className="tcp-controls-row">
                <span className="tcp-label">VOL</span>
                <input
                  type="range"
                  className="tcp-slider"
                  min={0}
                  max={1.5}
                  step={0.02}
                  value={track.volume}
                  onChange={(event) => changeVolume(track.id, Number(event.target.value))}
                  title={`Volume: ${Math.round(track.volume * 100)}%`}
                />
                <span className="value-badge">{Math.round(track.volume * 100)}</span>
              </div>
              {/* Routing lives on the row itself: who the track is sent to, and
                  who is allowed to push its fader down. */}
              <div className="tcp-controls-row route-row">
                <span
                  className="tcp-label"
                  title="Sub-grupo: o fader, o pan e o mute deste grupo valem para todas as tracks dentro dele — no navegador e no arquivo exportado"
                >
                  GRUPO
                </span>
                <select
                  className="route-select"
                  value={track.groupId}
                  onChange={(event) => assignGroup(track.id, event.target.value)}
                  title={
                    groups.length === 0
                      ? 'Nenhum grupo ainda — Track ▸ Novo sub-grupo'
                      : 'Para qual sub-grupo esta track toca'
                  }
                >
                  <option value="">Master</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </div>
              {/* Sidechain gets its own row: chips, the "+ fonte" picker and the
                  depth slider together need more than a fader's width, and a row
                  that squeezes them clips the last chip in half. */}
              <div className="tcp-controls-row route-row side-row">
                <span
                  className="tcp-label"
                  title="Sidechain (duck): esta track abaixa sempre que alguma das fontes tocar. Com mais de uma, o duck segue a soma - como um compressor externo com duas entradas no sidechain."
                >
                  SIDE
                </span>
                <div className="duck-sources">
                  {track.duckSourceIds.map((sourceId) => {
                    const source = tracks.find((other) => other.id === sourceId)
                    return (
                      <button
                        key={sourceId}
                        type="button"
                        className="duck-chip"
                        style={{ borderColor: source?.color }}
                        onClick={() => toggleDuckSource(track.id, sourceId)}
                        title={`"${source?.name ?? sourceId}" abre a gate desta track — clique para tirá-la do sidechain`}
                      >
                        {source ? `#${source.number}` : '?'}
                        <em>×</em>
                      </button>
                    )
                  })}
                  <select
                    className="route-select duck-add"
                    value=""
                    onChange={(event) => {
                      if (event.target.value !== '') toggleDuckSource(track.id, event.target.value)
                    }}
                    title="Acrescenta uma fonte ao sidechain; com várias, o duck segue a soma delas"
                    disabled={duckAvailable.length === 0}
                  >
                    <option value="">+ fonte</option>
                    {duckAvailable.map((other) => (
                      <option key={other.id} value={other.id}>
                        #{other.number} {other.name}
                      </option>
                    ))}
                  </select>
                </div>
                {track.duckSourceIds.length > 0 ? (
                  <>
                    <input
                      type="range"
                      className="tcp-slider duck-slider"
                      min={0}
                      max={1}
                      step={0.05}
                      value={track.duckDepth}
                      onChange={(event) =>
                        setSidechain(track.id, track.duckSourceIds, Number(event.target.value))
                      }
                      title="Profundidade do duck: quanto o volume desce quando as fontes tocam"
                    />
                    <span className="value-badge">{Math.round(track.duckDepth * 100)}</span>
                  </>
                ) : null}
              </div>
              {track.kind === 'audio' && track.takes.length > 0 ? (
                <div className="track-actions take-actions">
                  <select
                    className="mini-select"
                    value=""
                    title={`Takes gravados em ${track.name} — escolha qual fica na lane`}
                    onChange={(event) => {
                      if (event.target.value) void activateTake(track.id, event.target.value)
                    }}
                  >
                    <option value="">🎤 takes: {track.takes.length}</option>
                    {track.takes.map((take) => (
                      <option key={take.id} value={take.id}>
                        {take.name} · {take.duration.toFixed(1)}s ·{' '}
                        {barBeatOf(take.start)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="mini-btn"
                    title="Jogar os takes guardados fora (o clipe em uso fica)"
                    onClick={() => dropTakes(track.id)}
                  >
                    ✕
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}

          <button type="button" className="tcp-add" onClick={addTrack}>
            + Track
          </button>
        </aside>

        <section className="timeline-panel">
          <div className="workspace-tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'arrangement' ? 'active' : ''}`}
              onClick={() => setActiveTab('arrangement')}
            >
              Arrangement
            </button>
            <div className="view-tools" role="group" aria-label="Zoom e snap">
              <button
                type="button"
                className={`tab-btn ${snapEnabled ? 'active' : ''}`}
                onClick={toggleSnap}
                aria-pressed={snapEnabled}
                title="Snap ao 16º (tecla B) · Alt durante um arraste ignora o snap"
              >
                Snap {snapEnabled ? 'on' : 'off'}
              </button>
              <button
                type="button"
                className="tab-btn"
                onClick={() => zoomStep(-1)}
                title="Afastar (menos zoom) · Ctrl+roda para trás"
              >
                −
              </button>
              <span className="zoom-readout">
                {visibleBars} / {arrangementBars} comp.
              </span>
              <button
                type="button"
                className="tab-btn"
                onClick={() => zoomStep(1)}
                title="Aproximar (mais zoom) · Ctrl+roda"
              >
                +
              </button>
              <button
                type="button"
                className={`tab-btn ${zoomBars === 0 ? 'active' : ''}`}
                onClick={() => setZoomBars(0)}
                title="Encaixar todos os compassos na janela"
              >
                Fit
              </button>
            </div>
          </div>

          <div className="timeline-scroll" ref={timelineScrollRef}>
            <div className="timeline-content" style={{ width: `${contentWidthPct}%` }}>
          <div
            className="ruler-bar"
            onPointerDown={onRulerPointerDown}
            onPointerMove={rulerScrubMove}
            onPointerUp={onRulerPointerUp}
            onPointerCancel={onRulerPointerUp}
            onContextMenu={addMarkerFromRuler}
            title="Arraste para mover o playhead · Shift+arraste seleciona um trecho · Botão direito: marcador, ou ações dentro da seleção"
          >
            {Array.from({ length: arrangementBars }, (_, index) => (
              <div key={index} className="ruler-mark" style={{ width: `${barWidthPct}%` }}>
                <span className="ruler-num">
                  {arrangementBars <= 32 || index % 4 === 0 ? index + 1 : ''}
                </span>
                <span className="ruler-ticks" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ))}
            {markers.map((marker) => {
              const markerLeft = (marker.position / totalSteps) * 100
              const isRegion = marker.isRegion && marker.regionEnd != null
              const regionEnd = marker.regionEnd ?? marker.position + STEP_COUNT * 4
              const regionWidth = isRegion ? ((regionEnd - marker.position) / totalSteps) * 100 : 0
              return (
                <div
                  key={marker.id}
                  className={`timeline-marker ${isRegion ? 'region' : ''}`}
                  style={{
                    left: `${markerLeft}%`,
                    borderColor: marker.color,
                    ...(isRegion ? { width: `${regionWidth}%` } : {}),
                    zIndex: isRegion ? 1 : 5,
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (e.shiftKey) removeMarker(marker.id)
                    else if (e.altKey) toggleMarkerRegion(marker.id)
                    else setEditingMarkerId(marker.id)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    openMarkerInputAt(marker.position)
                  }}
                  title="Clique para editar · Shift+clique para remover · Alt+clique para virar região · Botão direito para criar novo marcador"
                >
                  <div className="marker-flag" style={{ background: marker.color }}>
                    {marker.name}
                  </div>
                  {isRegion && (
                    <div className="region-body" style={{ background: `${marker.color}33` }} />
                  )}
                </div>
              )
            })}
          </div>

          <div className="playhead" style={{ left: `${playheadLeft}%` }}>
            <span className="playhead-knob" />
          </div>
          {scrubGhost !== null ? (
            <div
              className="playhead scrub-ghost"
              style={{ left: `${(scrubGhost / totalSteps) * 100}%` }}
            />
          ) : null}
          {timeSel ? (
            <div
              className={`time-selection${punchIn ? ' punch' : ''}${
                punchIn && isRecording ? ' armed' : ''
              }`}
              style={{
                left: `${(timeSel.from / totalSteps) * 100}%`,
                width: `${Math.max(0.15, ((timeSel.to - timeSel.from) / totalSteps) * 100)}%`,
              }}
              title={
                punchIn
                  ? 'Área de punch-in · ● grava só dentro dela e o transporte continua'
                  : 'Seleção de tempo · botão direito na régua, dentro dela, abre as ações · Esc limpa'
              }
            >
              <span className="time-selection-tag">
                {((timeSel.to - timeSel.from) / STEP_COUNT).toFixed(2)} comp.
              </span>
            </div>
          ) : null}

          <div className={`tab-content ${activeTab === 'arrangement' ? 'active' : ''}`}>
            {laneRows.map((row) => {
              const track = row.track
              if (track.isFolder) {
                return (
                  <div
                    key={track.id}
                    className={`arrangement-folder ${selectedTrackId === track.id ? 'selected' : ''}`}
                    style={{
                      borderLeftColor: track.color,
                      background: `linear-gradient(to right, ${track.color}2b, transparent 55%)`,
                    }}
                    onClick={() => setSelectedTrackId(track.id)}
                    onContextMenu={(event) => openClipMenu(event, track.id)}
                    title={track.collapsed ? 'Pasta recolhida — clique no ▶ do TCP para expandir' : undefined}
                  >
                    <span className="folder-band-fold">{track.collapsed ? '▶' : '▼'}</span>
                    <span className="folder-band-name">{track.name}</span>
                  </div>
                )
              }
              if (row.hidden) return null
              const lane = lanePath(track)
              const laneVisible = Boolean(lanesOpen[track.id])
              return (
              <div
                key={track.id}
                className={`arrangement-lane ${row.indent ? 'in-folder' : ''} ${selectedTrackId === track.id ? 'selected' : ''} ${laneVisible ? 'auto-open' : ''}`}
                style={{
                  borderLeftColor: track.color,
                  backgroundSize: `${barWidthPct}% 100%, ${barWidthPct / 4}% 100%`,
                }}
                onClick={() => setSelectedTrackId(track.id)}
                onContextMenu={(event) => openClipMenu(event, track.id)}
                onPointerDown={(event) => onLaneSelPointerDown(event, track.id)}
                onPointerMove={onLaneSelPointerMove}
                onPointerUp={onLaneSelPointerUp}
                onPointerCancel={onLaneSelPointerUp}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void onLaneDrop(track.id, event)}
              >
                <div className="lane-label">
                  {track.name}
                  {/* Only say the input is live when a stream really is open, and
                      name it from what the device actually handed over. */}
                  {liveInput[track.id]
                    ? ` · ${describeLiveInput(liveInput[track.id]).toLowerCase()}`
                    : track.inputDeviceId
                      ? ' · entrada salva (não reaberta)'
                      : ''}
                </div>
                {isRecording && takeProgress[track.id] && liveInput[track.id] ? (
                  <LiveTake
                    peaks={takeProgress[track.id].peaks}
                    seconds={takeProgress[track.id].seconds}
                    startStep={recordStartRef.current}
                    stepDuration={60 / bpm / 4}
                    totalSteps={totalSteps}
                    color={track.color}
                  />
                ) : null}
                <button
                  type="button"
                  className={`lane-auto ${laneVisible ? 'on' : ''} ${track.automation.length ? 'drawn' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleLane(track.id)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    toggleLane(track.id, true)
                  }}
                  title="Automação de volume · botão direito limpa a lane"
                >
                  AUTO
                </button>
                {track.kind === 'instrument' ? (
                  track.midiNotes.length > 0 ? (
                    track.patternSteps > 0 ? (
                      <div
                        className="audio-item pattern-item"
                        style={{
                          borderColor: track.color,
                          backgroundSize: `${(track.patternSteps / totalSteps) * 100}% 100%`,
                          ...midiClipStyle(track),
                        }}
                        title="Pattern em loop — se repete até o fim da música · clique para editar"
                        onClick={(event) => {
                          event.stopPropagation()
                          setMidiEditorId(track.id)
                        }}
                      >
                        <button
                          type="button"
                          className="clip-close"
                          title="Limpar pattern MIDI"
                          onClick={(event) => {
                            event.stopPropagation()
                            clearNotes(track.id)
                          }}
                        >
                          ×
                        </button>
                        <span className="midi-item-label">
                          {instrumentIcon(track.instrument)} {patternLabel(track)} ·{' '}
                          {track.midiNotes.length} nota(s)
                        </span>
                      </div>
                    ) : (
                      <div
                        className="audio-item midi-item clip-draggable"
                        style={{ borderColor: track.color, ...midiClipStyle(track) }}
                        title="Arraste para mover o pattern · clique para abrir o editor"
                        onPointerDown={(event) => onMidiClipPointerDown(event, track)}
                        onPointerMove={onMidiClipPointerMove}
                        onPointerUp={onMidiClipPointerUp}
                        onPointerCancel={onMidiClipPointerUp}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (midiClickSuppressRef.current) {
                            midiClickSuppressRef.current = false
                            return
                          }
                          setMidiEditorId(track.id)
                        }}
                      >
                        <button
                          type="button"
                          className="clip-close"
                          title="Limpar pattern MIDI"
                          onClick={(event) => {
                            event.stopPropagation()
                            clearNotes(track.id)
                          }}
                        >
                          ×
                        </button>
                        <span className="midi-item-label">
                          {instrumentIcon(track.instrument)} {track.midiNotes.length} nota(s)
                        </span>
                      </div>
                    )
                  ) : (
                    <button
                      type="button"
                      className="lane-import"
                      title="Criar um pattern MIDI nesta track"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMidiEditorId(track.id)
                      }}
                    >
                      {isMelodic(track.instrument)
                        ? `${instrumentIcon(track.instrument)} Criar piano roll de ${instrumentLabel(track.instrument).toLowerCase()}`
                        : '🥁 Criar pattern de bateria'}
                    </button>
                  )
                ) : peaks[track.id] ? (
                  <div
                    className="audio-item clip-draggable"
                    style={{ borderColor: track.color, ...clipStyle(track) }}
                    title="Arraste para mover o clipe no tempo"
                    onPointerDown={(event) => onClipPointerDown(event, track)}
                    onPointerMove={onClipPointerMove}
                    onPointerUp={onClipPointerUp}
                    onPointerCancel={onClipPointerUp}
                  >
                    <button
                      type="button"
                      className="clip-close"
                      title="Remover clipe gravado"
                      onClick={(event) => {
                        event.stopPropagation()
                        clearClip(track.id)
                      }}
                    >
                      ×
                    </button>
                    <Waveform peaks={peaks[track.id]} color={track.color} />
                    <div
                      className="clip-trim"
                      title="Arraste para aparar o fim do clipe"
                      onPointerDown={(event) => onTrimPointerDown(event, track)}
                      onPointerMove={onTrimPointerMove}
                      onPointerUp={onTrimPointerUp}
                      onPointerCancel={onTrimPointerUp}
                      onClick={(event) => event.stopPropagation()}
                    />
                    <div
                      className="clip-fade clip-fade-in"
                      style={{ width: `${Math.max(1.5, fadePct(track, 'fadeIn'))}%` }}
                      title="Fade de entrada — arraste para ajustar · Alt = livre"
                      onPointerDown={(event) => onFadePointerDown(event, track, 'fadeIn')}
                      onPointerMove={onFadePointerMove}
                      onPointerUp={onFadePointerUp}
                      onPointerCancel={onFadePointerUp}
                      onClick={(event) => event.stopPropagation()}
                    />
                    <div
                      className="clip-fade clip-fade-out"
                      style={{ width: `${Math.max(1.5, fadePct(track, 'fadeOut'))}%` }}
                      title="Fade de saída — arraste para ajustar · Alt = livre"
                      onPointerDown={(event) => onFadePointerDown(event, track, 'fadeOut')}
                      onPointerMove={onFadePointerMove}
                      onPointerUp={onFadePointerUp}
                      onPointerCancel={onFadePointerUp}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="lane-import"
                    title="Importar áudio ou arraste um arquivo sobre esta faixa"
                    onClick={(event) => {
                      event.stopPropagation()
                      openAudioImport(track.id)
                    }}
                  >
                    ⬆ Importar · ou arraste um áudio aqui
                  </button>
                )}
                {laneVisible ? (
                  <div
                    className="automation-lane"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => onLaneDoubleClick(event, track)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      openClipMenu(event, track.id)
                    }}
                    title="Volume relativo ao fader · duplo clique cria ponto · arraste para mover · Alt+clique remove"
                  >
                    <svg
                      className="auto-svg"
                      viewBox={`0 0 100 ${AUTO_LANE_H}`}
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {lane.fill ? <path d={lane.fill} className="auto-fill" fill={track.color} /> : null}
                      {lane.line ? (
                        <path
                          d={lane.line}
                          className="auto-line"
                          stroke={track.color}
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : null}
                    </svg>
                    <div className="auto-zero" />
                    {track.automation.map((point, index) => (
                      <div
                        key={`${index}-${point.step}`}
                        className="auto-point"
                        style={{
                          left: `${(point.step / Math.max(1, totalSteps)) * 100}%`,
                          top: `${autoDbToY(point.value, AUTO_LANE_H)}px`,
                          background: track.color,
                        }}
                        title={`${formatDb(point.value)} · step ${point.step.toFixed(0)} · arraste · Alt+clique remove`}
                        onPointerDown={(event) => onAutoPointPointerDown(event, track, index)}
                        onPointerMove={onAutoPointPointerMove}
                        onPointerUp={onAutoPointPointerUp}
                        onPointerCancel={onAutoPointPointerUp}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setLanePoints(track.id, track.automation.filter((_, i) => i !== index))
                        }}
                      />
                    ))}
                    {track.automation.length === 0 ? (
                      <span className="auto-hint">duplo clique para desenhar</span>
                    ) : (
                      // Where the lane crosses the playhead, next to the fader
                      // it adds to: the number you would read on a console.
                      <span className="auto-readout">
                        {formatDb(gainToDb(automationGainAt(track.automation, playheadStep)))}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            );
        })}
            {tracks.length === 0 ? (
              <div className="empty-hint">Nenhuma track. Clique em "+ Track".</div>
            ) : null}
          </div>
            </div>{/* /timeline-content */}
          </div>{/* /timeline-scroll */}

          {isRecording && recordingLanes.length > 0 ? (
            <RecordHud engine={engineRef.current} items={recordingLanes} />
          ) : null}

          {/* Compact reminder line. Everything here is also reachable by menu or
              mouse; collapsed it is one line, and the full map only appears when
              asked for, so the arrangement keeps the height. */}
          <div className={`status-strip ${hintsOpen ? 'expanded' : ''}`}>
            <span className="status-stats">
              {tracks.length} track(s) · {arrangementBars} comp. · {bpm} BPM
            </span>
            {hintsOpen ? (
              <>
                <span>
                  Espaço play/stop · Del remover · Ctrl+D duplicar · Ctrl+E exportar
                </span>
                <span>
                  Ctrl+C/X/V copiar-recortar-colar · Ctrl+Z / Ctrl+Shift+Z desfazer-refazer
                </span>
                <span>B snap · +/− ou Ctrl+roda = zoom · Fit encaixa tudo</span>
                <span>
                  M mute · S solo · R gravar · K clique · L loop · 1234 count-in
                </span>
                <span>
                  Botão direito: menus (ruler cria marcador) · arraste os cantos do clipe
                  para fades e a borda direita para aparar · Alt ignora o snap
                </span>
                <span>
                  Shift+arraste na ruler = seleção de área · ✂ Dividir aqui corta o áudio
                  na track · Esc limpa a seleção
                </span>
                <span>
                  PUN punch-in: ● grava só dentro da área selecionada e o transporte continua ·
                  o seletor "takes" devolve qualquer versão gravada para a lane
                </span>
                <span>
                  No editor MIDI: Grade + Quantizar/Humanizar, Escala + Confinar, barra de
                  velocity · setas movem a seleção (Shift = 4 semínimas)
                </span>
                <span>
                  🎹 Piano · 🎸 Baixo · 🥁 Bateria: desenhe notas, toque no teclado do PC (⌨)
                  ou grave por MIDI · áudio fica salvo neste navegador
                </span>
              </>
            ) : (
              <span className="status-brief">
                Espaço play · Ctrl+C/X/V · Ctrl+Z · B snap · Shift+arraste na ruler seleciona
                um trecho · botão direito abre os menus
              </span>
            )}
            <button
              type="button"
              className="status-toggle"
              title={hintsOpen ? 'Ocultar a lista de atalhos' : 'Mostrar todos os atalhos'}
              onClick={() => setHintsOpen((open) => !open)}
            >
              {hintsOpen ? '▴ menos' : '▾ atalhos'}
            </button>
          </div>
        </section>
      </main>

      {showMixer ? (
        <footer className="mixer-dock">
          <div className="dock-header">
            <span>MIXER (MCP)</span>
            <button
              type="button"
              className="dock-btn"
              title="Criar um sub-grupo: uma mesa menor onde várias tracks passam a tocar juntas"
              onClick={() => createGroup()}
            >
              + GRUPO
            </button>
            {/* Delay compensation is a property of the room, not of one channel,
                so it sits on the console's own rail instead of eating the master
                strip's width. */}
            <div
              className="latency-row"
              title={`Compensação de latência: quanto a gravação é adiantada para casar com o que você ouviu no monitor. Digite -1 para usar a latência medida (${autoLatencyMs} ms).`}
            >
              <span>LAT</span>
              <input
                type="number"
                min={-1}
                max={200}
                step={1}
                value={recordLatencyMs < 0 ? autoLatencyMs : recordLatencyMs}
                onChange={(event) => {
                  const raw = Number(event.target.value)
                  if (!Number.isFinite(raw)) return
                  setRecordLatencyMs(Math.max(-1, Math.min(200, Math.round(raw))))
                }}
              />
              <span>ms</span>
              <button
                type="button"
                className="mini-btn latency-auto"
                onClick={() => {
                  const engine = engineRef.current
                  const measured = engine?.latencyMs() ?? 0
                  setAutoLatencyMs(measured)
                  setRecordLatencyMs(-1)
                  notify(`Latência medida: ${measured} ms (auto)`)
                }}
                title="Voltar a usar a latência medida pelo navegador"
              >
                auto {autoLatencyMs}
              </button>
            </div>
          </div>
          <div className="mixer-channels">
            {groups.map((group) => (
              <div
                key={group.id}
                className="mcp-channel group"
                style={{ borderColor: group.color }}
                title={`Sub-grupo — ${
                  tracks.filter((track) => track.groupId === group.id).length
                } track(s) dentro`}
              >
                <input
                  className="mcp-name mcp-group-name"
                  value={group.name}
                  onChange={(event) => changeGroup(group.id, { name: event.target.value })}
                  aria-label={`Nome do grupo ${group.name}`}
                  title="Renomear o grupo"
                />
                <div className="mcp-input on">
                  {tracks.filter((track) => track.groupId === group.id).length} IN
                </div>
                <div className="mcp-buttons">
                  <button
                    type="button"
                    className={`tcp-btn btn-mute ${group.isMuted ? 'muted' : ''}`}
                    title="Mutar o grupo inteiro"
                    onClick={() => changeGroup(group.id, { isMuted: !group.isMuted })}
                  >
                    m
                  </button>
                </div>
                <input
                  type="range"
                  className="mcp-pan"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={group.pan}
                  onChange={(event) => changeGroup(group.id, { pan: Number(event.target.value) })}
                  title="PAN do grupo"
                />
                <div className="mcp-meter-container">
                  <div className="mcp-meter">
                    <div
                      className="mcp-meter-fill"
                      style={{
                        height: `${Math.min(100, Math.round((levels[group.id] ?? 0) * 140))}%`,
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    className="mcp-fader"
                    min={0}
                    max={1.5}
                    step={0.02}
                    value={group.volume}
                    onChange={(event) =>
                      changeGroup(group.id, { volume: Number(event.target.value) })
                    }
                    title="Volume do grupo"
                  />
                </div>
                <span className="mcp-db" title="Pico do barramento em dBFS">
                  {formatDb(gainToDb(levels[group.id] ?? 0))}
                </span>
                <button
                  type="button"
                  className="mini-btn danger mcp-remove"
                  title="Apagar o barramento — as tracks voltam para o master"
                  onClick={() => dropGroup(group.id)}
                >
                  Remover
                </button>
              </div>
            ))}
            {tracks.filter((track) => !track.isFolder).map((track) => (
              <div
                key={track.id}
                className={`mcp-channel ${selectedTrackId === track.id ? 'selected' : ''}`}
                style={{ borderColor: track.color }}
                onClick={() => setSelectedTrackId(track.id)}
              >
                <div className="mcp-name">{track.name}</div>
                <div className={`mcp-input ${track.inputDeviceId ? 'on' : ''}`}>
                  {track.inputDeviceId ? 'IN ●' : 'IN —'}
                </div>
                <div className="mcp-buttons">
                  <button
                    type="button"
                    className={`tcp-btn btn-mute ${track.isMuted ? 'muted' : ''}`}
                    title="Mute"
                    onClick={() => toggleMute(track.id)}
                  >
                    m
                  </button>
                  <button
                    type="button"
                    className={`tcp-btn btn-solo ${track.isSoloed ? 'soloed' : ''}`}
                    title="Solo"
                    onClick={() => toggleSolo(track.id)}
                  >
                    s
                  </button>
                  <button
                    type="button"
                    className={`tcp-btn btn-mon ${track.inputMonitor ? 'on' : ''}`}
                    title={track.inputDeviceId ? 'Monitorar entrada (fone)' : 'Sem entrada selecionada'}
                    onClick={() => toggleInputMonitor(track.id)}
                  >
                    🎧
                  </button>
                  <button
                    type="button"
                    className="tcp-btn btn-fx"
                    title="Plugins"
                    onClick={() => setFxTrackId(track.id)}
                  >
                    FX
                  </button>
                </div>
                <input
                  type="range"
                  className="mcp-pan"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={track.pan}
                  onChange={(event) => changePan(track.id, Number(event.target.value))}
                  title="PAN"
                />
                <div className="mcp-meter-container">
                  <div className="mcp-meter">
                    <div
                      className="mcp-meter-fill"
                      style={{ height: `${Math.min(100, Math.round((levels[track.id] ?? 0) * 140))}%` }}
                    />
                  </div>
                  <input
                    type="range"
                    className="mcp-fader"
                    min={0}
                    max={1.5}
                    step={0.02}
                    value={track.volume}
                    onChange={(event) => changeVolume(track.id, Number(event.target.value))}
                    title="Volume"
                  />
                </div>
                <div className="mcp-stage">
                  <Knob
                    label="TRIM"
                    size={30}
                    value={track.trimDb}
                    min={-24}
                    max={24}
                    step={0.5}
                    display={`${formatDb(track.trimDb)}`}
                    accent="#e0a24a"
                    onInput={(next) => changeTrim(track.id, next)}
                  />
                  <Knob
                    label="RV"
                    size={30}
                    value={track.rvSend}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(track.rvSend * 100)}`}
                    accent="#8ab4f8"
                    onInput={(next) => changeSend(track.id, 'rv', next)}
                  />
                  <Knob
                    label="DL"
                    size={30}
                    value={track.dlSend}
                    min={0}
                    max={1}
                    step={0.01}
                    display={`${Math.round(track.dlSend * 100)}`}
                    accent="#c586f8"
                    onInput={(next) => changeSend(track.id, 'dl', next)}
                  />
                  <div className="mcp-stage-btns">
                    <button
                      type="button"
                      className={`tcp-btn btn-stage ${track.phaseInvert ? 'on' : ''}`}
                      title="Inverter a polaridade (Ø)"
                      onClick={() => togglePhaseInvert(track.id)}
                    >
                      Ø
                    </button>
                    <button
                      type="button"
                      className={`tcp-btn btn-stage ${track.mono ? 'on' : ''}`}
                      title="Reduzir para mono"
                      onClick={() => toggleMono(track.id)}
                    >
                      M
                    </button>
                  </div>
                </div>
                <div className="mcp-foot">
                  <select
                    className="mcp-preset"
                    value=""
                    title="Preset de mixagem para este canal"
                    onChange={(event) => {
                      if (event.target.value) applyMixPreset(track.id, event.target.value)
                    }}
                  >
                    <option value="">Mix…</option>
                    {Object.entries(MIX_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                  <span
                    className="mcp-db"
                    title="Pico do canal em dBFS (após trim/fase/mono)"
                  >
                    {formatDb(gainToDb(levels[track.id] ?? 0))}
                  </span>
                </div>
                <button
                  type="button"
                  className="mini-btn danger mcp-remove"
                  title="Remover track"
                  onClick={() => removeTrack(track.id)}
                >
                  Remover
                </button>
              </div>
            ))}
            <div className="mcp-channel master">
              <div className="mcp-name">MASTER</div>
              <div className="mcp-buttons">
                <button
                  type="button"
                  className={`tcp-btn btn-mute ${masterMuted ? 'muted' : ''}`}
                  title="Mutar saída master"
                  onClick={toggleMasterMute}
                >
                  m
                </button>
                <button
                  type="button"
                  className="tcp-btn btn-fx"
                  title="FX do barramento master (mixagem final)"
                  onClick={() => setShowMasterFx(true)}
                >
                  MIX
                </button>
                <button
                  type="button"
                  className={`tcp-btn btn-sala ${salaLive ? 'lit' : ''}`}
                  title={
                    salaLive
                      ? 'Cabo ligado: a master está saindo para a sala — clique para ver quem está do outro lado'
                      : 'Cabo virtual: manda a master para uma sala SALA e traz os participantes de volta como faixas'
                  }
                  onClick={() => {
                    setSalaMounted(true)
                    setShowSala(true)
                  }}
                >
                  {salaLive ? 'SALA' : 'CABO'}
                </button>
              </div>
              <div className="mcp-meter-container">
                <div className="mcp-meter">
                  <div
                    className="mcp-meter-fill"
                    style={{ height: `${Math.min(100, Math.round(masterLevel * 140))}%` }}
                  />
                </div>
                <input
                  type="range"
                  className="mcp-fader"
                  min={0}
                  max={1.5}
                  step={0.02}
                  value={masterVolume}
                  onChange={(event) => changeMasterVolume(Number(event.target.value))}
                  title="Volume master"
                />
              </div>
              <div className="mcp-stage">
                <Knob
                  label="RV RTN"
                  size={30}
                  value={sendConfig.rvReturn}
                  min={0}
                  max={2}
                  step={0.01}
                  display={`${Math.round(sendConfig.rvReturn * 100)}`}
                  accent="#8ab4f8"
                  onInput={(next) => changeSendConfig('rvReturn', next)}
                />
                <Knob
                  label="DL RTN"
                  size={30}
                  value={sendConfig.dlReturn}
                  min={0}
                  max={2}
                  step={0.01}
                  display={`${Math.round(sendConfig.dlReturn * 100)}`}
                  accent="#c586f8"
                  onInput={(next) => changeSendConfig('dlReturn', next)}
                />
                <div className="master-readouts">
                  <span className="ro master-db" title="Pico do master em dBFS">
                    <em>PK</em>
                    <b>{formatDb(gainToDb(masterLevel))}</b>
                  </span>
                  <span
                    className="ro"
                    title="Loudness medida na thread de áudio, exatamente como no arquivo exportado: M = últimos 400 ms, S = média dos últimos 3 s, em LUFS (padrão R128). Alvo de streaming costuma ficar entre -14 e -9."
                  >
                    <em>M</em>
                    <b>{meterText(masterLoudness?.momentaryLufs)}</b>
                  </span>
                  <span className="ro" title="Loudness de curto prazo, média dos últimos 3 s (R128 S).">
                    <em>S</em>
                    <b>{meterText(masterLoudness?.shortTermLufs)}</b>
                  </span>
                  <span
                    className={`ro ${masterLoudness && masterLoudness.truePeakDb > -1 ? 'hot' : ''}`}
                    title="True peak em dBTP: o nível real entre duas amostras, que é o que distorce no celular. Mantenha abaixo de -1 dBTP para não ter surpresas depois da codificação."
                  >
                    <em>TP</em>
                    <b>{meterText(masterLoudness?.truePeakDb)}</b>
                  </span>
                  <span
                    className={`ro gr ${masterReduction > 0.5 ? 'on' : ''}`}
                    title="Quanto o compressor e o limitador do master estão segurando (dB)"
                  >
                    <em>GR</em>
                    <b>{masterReduction > 0.05 ? `-${masterReduction.toFixed(1)}` : '0.0'}</b>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </footer>
      ) : null}

      {selMenu && timeSel ? (
        <div
          className="clip-menu-backdrop"
          onClick={() => setSelMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setSelMenu(null)
          }}
        >
          <div
            className="clip-menu"
            style={{
              left: Math.min(selMenu.x, window.innerWidth - 250),
              top: Math.min(selMenu.y, window.innerHeight - 220),
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="clip-menu-heading">
              Trecho {barBeatOf(timeSel.from)} → {barBeatOf(timeSel.to)}
            </div>
            <button
              type="button"
              title="Move o cursor para o início da seleção"
              onClick={() => {
                seek(Math.floor(timeSel.from))
                setSelMenu(null)
              }}
            >
              ▶ Ir para o início
            </button>
            <button
              type="button"
              title="Divide cada clipe de áudio que cruza as bordas da seleção"
              onClick={() => {
                for (const track of tracksRef.current) {
                  if (track.kind !== 'audio' || !track.bufferId) continue
                  const start = track.clipStart
                  const end = start + track.clipDuration / (60 / bpm / 4)
                  if (start < timeSel.to && end > timeSel.from) {
                    if (timeSel.from > start && timeSel.from < end) splitTakeAt(track.id, timeSel.from)
                    const after = tracksRef.current.find((item) => item.id === track.id)
                    const tailStart = after ? after.clipStart : start
                    const tailEnd = after ? tailStart + after.clipDuration / (60 / bpm / 4) : end
                    if (timeSel.to > tailStart && timeSel.to < tailEnd) splitTakeAt(track.id, timeSel.to)
                  }
                }
                notify('Clipes divididos nas bordas da seleção')
                setSelMenu(null)
              }}
            >
              ✂ Dividir nas bordas
            </button>
            <button
              type="button"
              title="Copia as notas da track selecionada que estão dentro da seleção"
              onClick={() => {
                copyTimeSelection()
                setSelMenu(null)
              }}
            >
              ⧉ Copiar notas do trecho
            </button>
            <button
              type="button"
              className="danger"
              title="Apaga notas e clipes que estão dentro da seleção"
              onClick={() => {
                deleteTimeSelection()
                setSelMenu(null)
              }}
            >
              ✕ Limpar conteúdo do trecho
            </button>
            <div className="clip-menu-sep" />
            <button
              type="button"
              onClick={() => {
                setTimeSel(null)
                setSelMenu(null)
              }}
            >
              ▭ Descartar seleção
            </button>
          </div>
        </div>
      ) : null}

      {clipMenu && clipMenuTrack ? (
        <div
          className="clip-menu-backdrop"
          onClick={() => setClipMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setClipMenu(null)
          }}
        >
          <div
            className="clip-menu"
            style={{
              left: Math.min(clipMenu.x, window.innerWidth - 230),
              top: Math.min(clipMenu.y, window.innerHeight - 260),
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="clip-menu-title">
              {clipMenuTrack.name} · {Math.floor(clipMenu.step / STEP_COUNT) + 1}.
              {(clipMenu.step % STEP_COUNT) + 1}
            </div>
            <button type="button" onClick={() => { copySelection(clipMenuTrack.id); setClipMenu(null) }}>
              ⧉ Copiar {clipMenuTrack.kind === 'instrument' ? 'pattern' : 'clipe'}
              <span>Ctrl+C</span>
            </button>
            <button type="button" onClick={() => { cutSelection(clipMenuTrack.id); setClipMenu(null) }}>
              ✂ Recortar
              <span>Ctrl+X</span>
            </button>
            <button
              type="button"
              onClick={() => {
                pasteSelection(clipMenuTrack.id, clipMenu.step)
                setClipMenu(null)
              }}
            >
              ⎘ Colar aqui
              <span>Ctrl+V</span>
            </button>
            {clipMenuTrack.kind === 'audio' && clipMenuTrack.bufferId ? (
              <>
                <div className="clip-menu-sep" />
                <button
                  type="button"
                  title="Corta o áudio aqui: a segunda metade ganha uma lane logo abaixo"
                  onClick={() => {
                    splitClipAt(clipMenuTrack.id, clipMenu.step)
                    setClipMenu(null)
                  }}
                >
                  ✂ Dividir aqui
                </button>
                <button
                  type="button"
                  disabled={clipMenu.step <= clipMenuTrack.clipStart}
                  title="Apara o fim do clipe no ponto clicado"
                  onClick={() => {
                    trimClipEnd(
                      clipMenuTrack.id,
                      (clipMenu.step - clipMenuTrack.clipStart) * (60 / bpm / 4),
                    )
                    setClipMenu(null)
                  }}
                >
                  ▭ Aparar fim aqui
                </button>
                <button
                  type="button"
                  title="Restaura o clipe com a duração gravada"
                  onClick={() => {
                    trimClipEnd(clipMenuTrack.id, Number.MAX_SAFE_INTEGER)
                    setClipMenu(null)
                  }}
                >
                  ↺ Clipe inteiro
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    clearClip(clipMenuTrack.id)
                    setClipMenu(null)
                  }}
                >
                  ✕ Remover clipe
                </button>
              </>
            ) : null}
            {clipMenuTrack.kind === 'instrument' ? (
              <>
                <div className="clip-menu-sep" />
                <button
                  type="button"
                  onClick={() => {
                    setMidiEditorId(clipMenuTrack.id)
                    setClipMenu(null)
                  }}
                >
                  ✎ Abrir editor
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    clearNotes(clipMenuTrack.id)
                    setClipMenu(null)
                  }}
                >
                  ✕ Limpar pattern
                </button>
              </>
            ) : null}
            {clipMenuTrack.isFolder ? (
              <>
                <div className="clip-menu-sep" />
                <button
                  type="button"
                  onClick={() => {
                    addTrackIntoFolder(clipMenuTrack.id)
                    setClipMenu(null)
                  }}
                >
                  ＋ Nova track nesta pasta
                </button>
                <button
                  type="button"
                  onClick={() => {
                    toggleFolder(clipMenuTrack.id)
                    setClipMenu(null)
                  }}
                >
                  {clipMenuTrack.collapsed ? '▶ Expandir' : '▼ Recolher'}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    removeFolder(clipMenuTrack.id)
                    setClipMenu(null)
                  }}
                >
                  ✕ Excluir pasta (mantém as tracks)
                </button>
              </>
            ) : (
              <>
                <div className="clip-menu-sep" />
                <div className="clip-menu-heading">Pasta</div>
                <button
                  type="button"
                  disabled={!clipMenuTrack.folderId}
                  onClick={() => {
                    assignFolder(clipMenuTrack.id, null)
                    setClipMenu(null)
                  }}
                >
                  ▭ Soltar no topo da lista
                </button>
                {visibleFolders.slice(0, 6).map((folder) => (
                  <button
                    type="button"
                    key={folder.id}
                    className={clipMenuTrack.folderId === folder.id ? 'current' : ''}
                    onClick={() => {
                      assignFolder(clipMenuTrack.id, folder.id)
                      setClipMenu(null)
                    }}
                  >
                    📁 {folder.name}
                    {clipMenuTrack.folderId === folder.id ? ' ✓' : ''}
                  </button>
                ))}
                {visibleFolders.length === 0 ? (
                  <button type="button" onClick={() => { addFolder(); setClipMenu(null) }}>
                    ＋ Criar primeira pasta
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* The track panel's own right-click: the housekeeping that used to be four
          rows of buttons under every fader. */}
      {trackMenu && trackMenuTrack ? (
        <div
          className="clip-menu-backdrop"
          onClick={() => setTrackMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setTrackMenu(null)
          }}
        >
          <div
            className="clip-menu"
            style={{
              left: Math.min(trackMenu.x, window.innerWidth - 230),
              top: Math.min(trackMenu.y, window.innerHeight - 240),
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="clip-menu-title">
              #{trackMenuTrack.number} {trackMenuTrack.name}
            </div>
            <button
              type="button"
              disabled={tracks[0]?.id === trackMenuTrack.id}
              onClick={() => {
                moveTrack(trackMenuTrack.id, -1)
                setTrackMenu(null)
              }}
            >
              ▲ Mover para cima
            </button>
            <button
              type="button"
              disabled={tracks[tracks.length - 1]?.id === trackMenuTrack.id}
              onClick={() => {
                moveTrack(trackMenuTrack.id, 1)
                setTrackMenu(null)
              }}
            >
              ▼ Mover para baixo
            </button>
            <button
              type="button"
              onClick={() => {
                duplicateTrack(trackMenuTrack.id)
                setTrackMenu(null)
              }}
            >
              ⧉ Duplicar track
              <span>Ctrl+D</span>
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                removeTrack(trackMenuTrack.id)
                setTrackMenu(null)
              }}
            >
              ✕ Remover track
              <span>Del</span>
            </button>
            {trackMenuTrack.kind === 'audio' ? (
              <>
                <div className="clip-menu-sep" />
                <div className="clip-menu-heading">Clipe gravado</div>
                <button
                  type="button"
                  disabled={!trackMenuTrack.bufferId || trackMenuTrack.clipDuration <= 0}
                  onClick={() => {
                    void cutAudioClip(trackMenuTrack.id)
                    setTrackMenu(null)
                  }}
                >
                  ✂ Recortar áudio
                  <span>Ctrl+X</span>
                </button>
                <button
                  type="button"
                  disabled={!trackMenuTrack.bufferId || trackMenuTrack.clipDuration <= 0}
                  onClick={() => {
                    void copyAudioClip(trackMenuTrack.id)
                    setTrackMenu(null)
                  }}
                >
                  ⧉ Copiar áudio
                  <span>Ctrl+C</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void pasteAudioClip(trackMenuTrack.id)
                    setTrackMenu(null)
                  }}
                >
                  ⎘ Colar na track
                  <span>Ctrl+V</span>
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {showExport ? (
        <div className="modal-overlay" onClick={() => (exporting ? null : setShowExport(false))}>
          <div className="fx-window export-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>Exportar Áudio (WAV)</span>
              <button
                type="button"
                className="reaper-btn"
                onClick={() => setShowExport(false)}
                disabled={exporting}
              >
                X
              </button>
            </div>
            <div className="fx-body">
              <div className="fx-section-title">O que exportar</div>
              <div className="export-scope">
                <label className={`export-option ${exportScope === 'mix' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === 'mix'}
                    onChange={() => setExportScope('mix')}
                  />
                  <span>
                    <strong>Mix completo</strong>
                    <em>todas as tracks</em>
                  </span>
                </label>
                <label
                  className={`export-option ${exportScope === 'track' ? 'active' : ''} ${
                    selectedIsFolder ? 'disabled' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === 'track'}
                    disabled={selectedIsFolder}
                    onChange={() => setExportScope('track')}
                  />
                  <span>
                    <strong>Track selecionada</strong>
                    <em>
                      {selectedTrack ? selectedTrack.name : 'nenhuma track'}
                      {selectedIsFolder
                        ? ' · pasta: escolha uma track'
                        : ' · clipe + plugins'}
                    </em>
                  </span>
                </label>
                <label className={`export-option ${exportScope === 'stems' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === 'stems'}
                    onChange={() => setExportScope('stems')}
                  />
                  <span>
                    <strong>Stems</strong>
                    <em>
                      uma WAV por track com conteúdo (e por grupo) · sem o master bus
                    </em>
                  </span>
                </label>
              </div>

              {exportScope !== 'track' ? (
                <div className="fx-param">
                  <label htmlFor="export-bars">Compassos:</label>
                  <input
                    id="export-bars"
                    type="number"
                    min={1}
                    max={128}
                    className="reaper-input"
                    value={exportBars}
                    onChange={(event) =>
                      setExportBars(Math.max(1, Math.min(128, Number(event.target.value) || 1)))
                    }
                  />
                  <span className="value-badge">≈ {((exportBars * 4 * 60) / bpm).toFixed(1)}s</span>
                </div>
              ) : null}

              <div className="plugin-note">
                A renderização acontece fora do tempo real (mais rápida que tocar) e já inclui
                plugins, volume, pan e mute. Modelos NAM são renderizados quando o motor responde
                no contexto offline; caso contrário o export avisa e segue sem eles. Stems saem
                pós-fader da track, sem EQ/limitador do master, para que a soma deles seja o mix
                antes do master.
              </div>

              {exportReports.length > 0 ? (
                <div className="export-report" role="status">
                  <div className="fx-section-title">Medição dos arquivos</div>
                  {exportReports.map((report) => (
                    <div className="report-row" key={report.file}>
                      <div className="report-name" title={report.file}>
                        {report.label}
                      </div>
                      <div className="report-values">
                        <span>
                          <em>Integrado</em>
                          <strong>{formatLufs(report.loudness.integratedLufs)} LUFS</strong>
                        </span>
                        <span>
                          <em>Pico</em>
                          <strong>{formatLufs(report.loudness.peakDb)} dBFS</strong>
                        </span>
                        <span>
                          <em>True peak</em>
                          <strong>{formatLufs(report.loudness.truePeakDb)} dBTP</strong>
                        </span>
                        <span>
                          <em>Máx moment.</em>
                          <strong>{formatLufs(report.loudness.momentaryMaxLufs)} LUFS</strong>
                        </span>
                        <span>
                          <em>Faixa (LRA)</em>
                          <strong>{report.loudness.loudnessRangeLu.toFixed(1)} LU</strong>
                        </span>
                      </div>
                      {report.warnings.length > 0 ? (
                        <div className="report-warning">{report.warnings.join(' · ')}</div>
                      ) : null}
                    </div>
                  ))}
                  <div className="report-target">
                    -14 LUFS integrados é a meta das plataformas; sobrar 1 dB de pico deixa espaço
                    para a conversão delas. LRA é o quanto o nível se mexe.
                  </div>
                </div>
              ) : null}
            </div>
            <div className="fx-footer">
              <button
                type="button"
                className="reaper-btn"
                onClick={() => setShowExport(false)}
                disabled={exporting}
              >
                {exportReports.length > 0 ? 'Fechar' : 'Cancelar'}
              </button>
              <button
                type="button"
                className="reaper-btn highlight"
                onClick={() => void runExport()}
                disabled={exporting}
              >
                {exporting
                  ? 'Renderizando…'
                  : exportScope === 'stems'
                    ? `Renderizar ${stemCount} stem(s)`
                    : exportReports.length > 0
                      ? 'Renderizar de novo'
                      : 'Renderizar e baixar WAV'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showVersions ? (
        <div className="modal-overlay" onClick={() => setShowVersions(false)}>
          <div className="fx-window versions-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>Versões do Autosave</span>
              <button
                type="button"
                className="reaper-btn"
                onClick={() => setShowVersions(false)}
                title="Fechar"
              >
                X
              </button>
            </div>
            <div className="fx-body">
              {versionRows.length === 0 ? (
                <div className="plugin-note">
                  Nenhuma versão guardada ainda. O histórico se forma sozinho: quando o projeto
                  muda e já passou um minuto da última captura, o estado inteiro vira uma versão, e
                  as oito mais recentes ficam neste navegador.
                </div>
              ) : (
                <div className="version-list">
                  {versionRows.map(({ entry, trackCount, content }) => (
                    <div className="version-row" key={entry.id}>
                      <div className="version-when">
                        <strong>{formatClock(entry.savedAt)}</strong>
                        <em>{describeAge(entry.savedAt, versionsNow)}</em>
                      </div>
                      <div className="version-meta">
                        <span className="version-label">{entry.label}</span>
                        <span className="version-count">
                          {trackCount} track{trackCount === 1 ? '' : 's'}
                          {content > 0 ? ` · ${content} com conteúdo` : ' · vazio'}
                        </span>
                      </div>
                      <div className="version-actions">
                        <button
                          type="button"
                          className="reaper-btn highlight"
                          onClick={() => restoreVersion(entry.id)}
                        >
                          Restaurar
                        </button>
                        <button
                          type="button"
                          className="reaper-btn"
                          onClick={() => forgetVersion(entry.id)}
                          title="Esquecer esta versão"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="report-target">
                Restaurar troca o projeto inteiro pelo estado daquela versão. O que estava na tela
                antes vira a versão mais nova, então sempre dá para voltar. As amostras de áudio
                ficam guardadas à parte: se uma tiver sido apagada do navegador, a track volta sem o
                clipe.
              </div>
            </div>
            <div className="fx-footer">
              <button type="button" className="reaper-btn" onClick={saveProject}>
                Guardar agora
              </button>
              <button type="button" className="reaper-btn" onClick={() => setShowVersions(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {midiEditorTrack ? (
        <div className="modal-overlay" onClick={() => setMidiEditorId(null)}>
          <div className="fx-window midi-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>
                {midiEditorTrack.instrument === 'drums'
                  ? '🥁 Step Sequencer'
                  : `${instrumentIcon(midiEditorTrack.instrument)} Piano Roll · ${instrumentLabel(midiEditorTrack.instrument)}`}{' '}
                — {midiEditorTrack.name}
              </span>
              <div className="midi-tools">
                <div className="editor-transport">
                  <button
                    type="button"
                    className={`reaper-btn editor-play ${isPlaying ? 'on' : ''}`}
                    title={isPlaying ? 'Pausar' : 'Tocar deste pattern'}
                    onClick={() => {
                      if (isPlaying) {
                        stopPlayback()
                      } else {
                        const start = midiEditorTrack.midiNotes.length
                          ? midiEditorTrack.midiNotes.reduce(
                              (m, n) => Math.min(m, n.step),
                              Infinity,
                            )
                          : 0
                        startPlayback(Math.max(0, start), false)
                      }
                    }}
                  >
                    {isPlaying ? '⏸' : '▶'}
                  </button>
                  <button
                    type="button"
                    className="reaper-btn"
                    title="Parar e voltar ao início do pattern"
                    onClick={() => {
                      stopPlayback()
                      const start = midiEditorTrack.midiNotes.length
                        ? midiEditorTrack.midiNotes.reduce((m, n) => Math.min(m, n.step), Infinity)
                        : 0
                      seek(Math.max(0, start))
                    }}
                  >
                    ⏹
                  </button>
                </div>
                <label htmlFor="midi-voice">Som</label>
                <select
                  id="midi-voice"
                  className="reaper-input voice-select"
                  value={midiEditorTrack.voice}
                  onChange={(event) => setTrackVoice(midiEditorTrack.id, event.target.value)}
                  title={
                    midiEditorTrack.instrument === 'drums'
                      ? 'Kit da bateria'
                      : `Timbre de ${instrumentLabel(midiEditorTrack.instrument).toLowerCase()}`
                  }
                >
                  {voicesFor(midiEditorTrack.instrument).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <label htmlFor="midi-note-len">Duração</label>
                <select
                  id="midi-note-len"
                  className="reaper-input"
                  value={String(midiNoteLen)}
                  onChange={(event) => setMidiNoteLen(Number(event.target.value) || 1)}
                  disabled={midiEditorTrack.instrument === 'drums'}
                >
                  <option value="1">1/16</option>
                  <option value="2">1/8</option>
                  <option value="4">1/4</option>
                  <option value="8">1/2</option>
                  <option value="16">1 compasso</option>
                </select>
                <label htmlFor="midi-pattern-len">Loop</label>
                <select
                  id="midi-pattern-len"
                  className="reaper-input pattern-select"
                  value={String(midiEditorTrack.patternSteps)}
                  onChange={(event) =>
                    setPatternSteps(midiEditorTrack.id, Number(event.target.value))
                  }
                  title="Tamanho do pattern em loop · o transporte repete até o fim da arrangement"
                >
                  {PATTERN_LENGTHS.map((length) => (
                    <option key={length} value={String(length)}>
                      {length === 0
                        ? 'sem loop (uma vez)'
                        : `${Math.round(length / STEP_COUNT)} comp. (${length} passos)`}
                    </option>
                  ))}
                </select>
                {midiEditorTrack.instrument === 'drums' ? (
                  <>
                    <label htmlFor="midi-groove">Padrão</label>
                    <select
                      id="midi-groove"
                      className="reaper-input groove-select"
                      value=""
                      onChange={(event) => {
                        if (!event.target.value) return
                        applyGroove(midiEditorTrack.id, event.target.value)
                      }}
                      title="Carrega um groove de um compasso, repetido no tamanho do loop"
                    >
                      <option value="">carregar…</option>
                      {GROOVE_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                <span className="roll-sel-tools">
                  <span className="roll-sel-count">
                    {rollSel ? `${selectionNotes().length} nota(s) na seleção` : 'Shift+arraste = seleção'}
                  </span>
                  <button
                    type="button"
                    className="reaper-btn mini"
                    disabled={!rollSel}
                    title="Copiar as notas da seleção (Ctrl+C)"
                    onClick={() => copyRollSelection()}
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    className="reaper-btn mini"
                    disabled={!rollSel}
                    title="Recortar as notas da seleção (Ctrl+X)"
                    onClick={() => cutRollSelection()}
                  >
                    ✂
                  </button>
                  <button
                    type="button"
                    className="reaper-btn mini"
                    disabled={!midiClipboardRef.current}
                    title="Colar logo depois da seleção (Ctrl+V) · sem seleção, cola no cursor"
                    onClick={() => pasteRollSelection()}
                  >
                    ⎘
                  </button>
                  <button
                    type="button"
                    className="reaper-btn mini"
                    disabled={!rollSel}
                    title="Descartar a seleção (Esc)"
                    onClick={() => setRollSel(null)}
                  >
                    ▭
                  </button>
                </span>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => clearNotes(midiEditorTrack.id)}
                >
                  Limpar
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => setMidiEditorId(null)}
                >
                  X
                </button>
              </div>
            </div>
            <div className="fx-body midi-body">
              <div className="roll-tools">
                <label htmlFor="roll-quantum">Grade</label>
                <select
                  id="roll-quantum"
                  className="reaper-input"
                  value={String(rollQuantum)}
                  onChange={(event) => setRollQuantum(Number(event.target.value) || 1)}
                  title="Resolução do quantizar — 1/16 é a grade mais fina"
                >
                  {QUANTIZE_GRIDS.map((grid) => (
                    <option key={grid.steps} value={String(grid.steps)}>
                      {grid.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={quantizeRoll}
                  title="Colocar as notas na grade · com Shift+arraste, só a seleção"
                >
                  Quantizar
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={humanizeRoll}
                  title="Tirar as notas da grade um pouco e variar a intensidade, para soar humano"
                >
                  Humanizar
                </button>
                <span className="roll-tools-sep" aria-hidden="true" />
                <label htmlFor="roll-scale-root">Escala</label>
                <select
                  id="roll-scale-root"
                  className="reaper-input"
                  value={String(rollScaleOf(midiEditorTrack.id).root)}
                  onChange={(event) =>
                    setRollScale(midiEditorTrack.id, {
                      root: Number(event.target.value) || 0,
                      mode: rollScaleOf(midiEditorTrack.id).mode,
                    })
                  }
                  title="Nota raiz da escala usada para pintar as linhas e confinar as notas"
                >
                  {SCALE_ROOTS.map((name, index) => (
                    <option key={name} value={String(index)}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  id="roll-scale-mode"
                  className="reaper-input scale-mode"
                  value={rollScaleOf(midiEditorTrack.id).mode}
                  onChange={(event) =>
                    setRollScale(midiEditorTrack.id, {
                      root: rollScaleOf(midiEditorTrack.id).root,
                      mode: event.target.value,
                    })
                  }
                  title="O modo pinta as linhas que pertencem à escala; 'sem escala' apaga a pintura"
                >
                  {SCALE_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={snapRollToScale}
                  title="Mover cada nota para a linha da escala mais perto — a correção de dedo errado"
                >
                  Confinar
                </button>
                <span className="roll-tools-hint">
                  setas movem a seleção · Shift+setas = 4 passos · arraste a barra Vel para mudar a
                  intensidade de cada nota
                </span>
              </div>
              {isMelodic(midiEditorTrack.instrument) ? (
                <div className={`pc-strip ${pcKeys ? 'on' : ''}`}>
                  <button
                    type="button"
                    className={`reaper-btn pc-toggle ${pcKeys ? 'on' : ''}`}
                    onClick={togglePcKeys}
                    title={
                      pcKeys
                        ? 'Desligar: devolve as letras A S D… aos atalhos da DAW'
                        : 'Ligar: as teclas do computador tocam esta track (e gravam, se ela estiver armada)'
                    }
                  >
                    {pcKeys ? '⌨ teclado do PC: ligado' : '⌨ teclado do PC: desligado'}
                  </button>
                  <div className="pc-octave">
                    <button type="button" onClick={() => shiftPcOctave(-1)} title="Oitava abaixo (Z)">
                      −
                    </button>
                    <span>
                      {NOTE_NAMES[pcBasePitch(midiEditorTrack) % 12]}
                      {Math.floor(pcBasePitch(midiEditorTrack) / 12) - 1}
                      {pcOctave !== 0 ? ` (${pcOctave > 0 ? '+' : ''}${pcOctave} oit.)` : ''}
                    </span>
                    <button type="button" onClick={() => shiftPcOctave(1)} title="Oitava acima (X)">
                      +
                    </button>
                  </div>
                  <div className="pc-keys">
                    {PC_KEY_LIST.map((item) => {
                      const pitch = pcBasePitch(midiEditorTrack) + item.semitone
                      const black = NOTE_NAMES[pitch % 12].includes('#')
                      return (
                        <button
                          type="button"
                          key={item.semitone}
                          className={`pc-key ${black ? 'black' : ''} ${pcHeld.includes(pitch) ? 'held' : ''}`}
                          title={`${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`}
                          onPointerDown={() => pcNoteOn(item.key)}
                          onPointerUp={() => pcNoteOff(item.key)}
                          onPointerLeave={() => pcNoteOff(item.key)}
                        >
                          <b>{item.key.toUpperCase()}</b>
                          <i>
                            {NOTE_NAMES[pitch % 12]}
                            {Math.floor(pitch / 12) - 1}
                          </i>
                        </button>
                      )
                    })}
                  </div>
                  <span className="pc-hint">
                    {pcKeys
                      ? 'Z / X mudam de oitava · Esc solta todas as notas · as teclas A S D F… deixam de ser atalho enquanto estiver ligado'
                      : 'Clique nas teclas para ouvir · ligue o teclado para tocar com as teclas do computador'}
                  </span>
                </div>
              ) : null}
              {seqTrack ? (
                renderStepSequencer(seqTrack)
              ) : (
              <div className="roll-scroll">
                <div className="roll-layout">
                  <div className="roll-corner" />
                  <div
                    className="roll-ruler"
                    style={{ width: rollSteps(midiEditorTrack) * ROLL_COL_W }}
                  >
                    {Array.from(
                      { length: Math.max(1, Math.ceil(rollSteps(midiEditorTrack) / STEP_COUNT)) },
                      (_, bar) => (
                        <span
                          key={bar}
                          className="roll-bar-label"
                          style={{ left: bar * STEP_COUNT * ROLL_COL_W }}
                        >
                          {bar + 1}
                        </span>
                      ),
                    )}
                  </div>
                  <div className="roll-keys">
                    {midiEditorTrack.instrument === 'drums'
                      ? DRUM_PIECES.map((piece) => (
                          <button
                            type="button"
                            key={piece.pitch}
                            className="roll-lane-label"
                            style={{ height: DRUM_ROW_H }}
                            title={`Tocar ${piece.label}`}
                            onClick={() => previewNote(midiEditorTrack, piece.pitch, 1)}
                          >
                            {piece.label}
                          </button>
                        ))
                      : Array.from(
                          {
                            length:
                              rollRange(midiEditorTrack.instrument).top -
                              rollRange(midiEditorTrack.instrument).bottom +
                              1,
                          },
                          (_, i) => {
                            const pitch = rollRange(midiEditorTrack.instrument).top - i
                            const name = NOTE_NAMES[pitch % 12]
                            const octave = Math.floor(pitch / 12) - 1
                            const caption = pcCaptionAt(midiEditorTrack, pitch)
                            const held = pcHeld.includes(pitch)
                            return (
                              <div
                                key={pitch}
                                className={`roll-key ${name.includes('#') ? 'black' : ''} ${held ? 'held' : ''}`}
                                style={{ height: ROLL_ROW_H }}
                              >
                                {caption ? <span className="roll-key-cap">{caption}</span> : null}
                                {name === 'C' ? `C${octave}` : ''}
                              </div>
                            )
                          },
                        )}
                  </div>
                  <div
                    ref={rollInnerRef}
                    className={`roll-grid ${midiEditorTrack.instrument}`}
                    style={{
                      width: rollSteps(midiEditorTrack) * ROLL_COL_W,
                      height:
                        midiEditorTrack.instrument === 'drums'
                          ? DRUM_PIECES.length * DRUM_ROW_H
                          : (rollRange(midiEditorTrack.instrument).top -
                              rollRange(midiEditorTrack.instrument).bottom +
                              1) *
                            ROLL_ROW_H,
                    }}
                    onClick={onRollGridClick}
                    onPointerDown={onRollMarqueeDown}
                    onPointerMove={onRollMarqueeMove}
                    onPointerUp={onRollMarqueeUp}
                    onPointerCancel={onRollMarqueeUp}
                  >
                    <div
                      className="roll-playhead"
                      style={{
                        left:
                          (midiEditorTrack.patternSteps > 0
                            ? Math.floor(playheadStep) % midiEditorTrack.patternSteps
                            : playheadStep) * ROLL_COL_W,
                      }}
                    />
                    {rollSel ? (
                      <div
                        className="roll-marquee"
                        style={{
                          left: rollSel.left * ROLL_COL_W,
                          width: Math.max(1, rollSel.right - rollSel.left) * ROLL_COL_W,
                          top:
                            (midiEditorTrack.instrument === 'drums'
                              ? DRUM_PIECES.findIndex((piece) => piece.pitch === rollSel.high)
                              : rollRange(midiEditorTrack.instrument).top - rollSel.high) *
                            (midiEditorTrack.instrument === 'drums' ? DRUM_ROW_H : ROLL_ROW_H),
                          height:
                            (midiEditorTrack.instrument === 'drums'
                              ? DRUM_PIECES.findIndex((piece) => piece.pitch === rollSel.low) -
                                DRUM_PIECES.findIndex((piece) => piece.pitch === rollSel.high)
                              : rollSel.high - rollSel.low) *
                              (midiEditorTrack.instrument === 'drums' ? DRUM_ROW_H : ROLL_ROW_H) +
                            (midiEditorTrack.instrument === 'drums' ? DRUM_ROW_H : ROLL_ROW_H),
                        }}
                      />
                    ) : null}
                    {isMelodic(midiEditorTrack.instrument)
                      ? Array.from(
                          { length: rollRange(midiEditorTrack.instrument).top - rollRange(midiEditorTrack.instrument).bottom + 1 },
                          (_, i) => {
                            const pitch = rollRange(midiEditorTrack.instrument).top - i
                            const scale = rollScaleOf(midiEditorTrack.id)
                            const inScale =
                              scale.mode !== '' && isScalePitch(pitch, scale.root, scale.mode)
                            return (
                              <div
                                key={pitch}
                                className={`roll-rowline ${NOTE_NAMES[pitch % 12].includes('#') ? 'dark' : ''} ${inScale ? 'in-scale' : ''}`}
                                style={{ top: i * ROLL_ROW_H, height: ROLL_ROW_H }}
                              />
                            )
                          },
                        )
                      : null}
                    {midiEditorTrack.midiNotes.map((note, index) => {
                      const d = rollDrag && rollDrag.index === index ? rollDrag : note
                      const drums = midiEditorTrack.instrument === 'drums'
                      const row = drums
                        ? DRUM_PIECES.findIndex((piece) => piece.pitch === d.pitch)
                        : rollRange(midiEditorTrack.instrument).top - d.pitch
                      if (row < 0) return null
                      const rowH = drums ? DRUM_ROW_H : ROLL_ROW_H
                      return (
                        <div
                          key={index}
                          className={`roll-note ${rollSel && noteInSel(note, rollSel) ? 'selected' : ''}`}
                          style={{
                            left: d.step * ROLL_COL_W,
                            top: row * rowH,
                            width: Math.max(4, d.length * ROLL_COL_W - 2),
                            height: rowH - 1,
                            opacity: 0.45 + d.velocity * 0.55,
                          }}
                          title="Arraste para mover · borda direita estica · clique apaga"
                          onPointerDown={(event) => onNotePointerDown(event, index)}
                          onPointerMove={onNotePointerMove}
                          onPointerUp={onNotePointerUp}
                        />
                      )
                    })}
                  </div>
                  <div className="roll-vel-label" title="Altura de cada barra é a intensidade da nota">
                    Vel
                  </div>
                  <div
                    className="roll-vel"
                    style={{
                      width: rollSteps(midiEditorTrack) * ROLL_COL_W,
                      height: VEL_LANE_H,
                    }}
                    onPointerDown={onVelocityPointerDown}
                    onPointerMove={onVelocityPointerMove}
                    onPointerUp={onVelocityPointerUp}
                    onPointerCancel={onVelocityPointerUp}
                  >
                    {midiEditorTrack.midiNotes.map((note, index) => {
                      const velocity =
                        rollVelDrag && rollVelDrag.index === index
                          ? rollVelDrag.velocity
                          : note.velocity
                      return (
                        <span
                          key={index}
                          className={`roll-vel-bar ${
                            rollVelDrag && rollVelDrag.index === index ? 'active' : ''
                          } ${rollSel && noteInSel(note, rollSel) ? 'selected' : ''}`}
                          style={{
                            left: note.step * ROLL_COL_W,
                            width: Math.max(4, note.length * ROLL_COL_W - 2),
                            height: `${Math.round(velocity * 100)}%`,
                          }}
                          title={`${Math.round(velocity * 100)}% · ${barBeatOf(note.step)}`}
                        />
                      )
                    })}
                  </div>
                </div>
              </div>
              )}
              <div className="plugin-note">
                {seqTrack ? (
                  <>
                    Clique ou arraste na grade para acender passos — o pattern se repete enquanto a
                    música tocar. Shift faz acento, clicar num toque aceso apaga. O seletor
                    <strong> Loop</strong> escolhe 1, 2 ou 4 compassos e dobrar as notas que já
                    existem; <strong>Padrão</strong> carrega um groove pronto. Com o teclado do PC
                    ligado (⌨), <strong>A S D F</strong> … são kick, caixa e tons e{' '}
                    <strong>Q W E R T Y U</strong> são pratos e ruídos — a letra aparece em cada
                    linha e, com a track armada e gravando, o toque entra no pattern. Em{' '}
                    <strong>Humanizar</strong> as notas saem um pouco da grade e em{' '}
                    <strong>Quantizar</strong> voltam para ela; a barra <strong>Vel</strong> abaixo
                    da grade define a força de todos os toques daquele passo.
                  </>
                ) : (
                  <>
                    Clique na grade para adicionar notas, clique numa nota para apagá-la, arraste
                    para mover e puxe a borda direita para esticar.{' '}
                    <strong>Shift+arraste</strong> marca uma área; Ctrl+C / X copiam ou recortam
                    só as notas dela e Ctrl+V repete o fraseado logo em seguida.{' '}
                    <strong>Quantizar</strong> põe as notas na grade,<strong> Humanizar</strong>{' '}
                    as solta um pouco e <strong>Confinar</strong> prende cada uma à escala escolhida
                    — com uma área marcada, as três só mexem nela. As linhas claras da grade são as
                    notas da escala e a barra <strong>Vel</strong> abaixo do roll muda a força de
                    cada nota.{' '}
                    {isMelodic(midiEditorTrack.instrument)
                      ? 'A duração do clique vem do seletor acima.'
                      : 'Cada célula é um toque de 16º — acione as baquetas clicando.'}{' '}
                    {midiEditorTrack.patternSteps > 0
                      ? 'A track está em loop: o que está na grade se repete.'
                      : 'As notas passam pela cadeia de plugins da track (NAM, cab, FX).'}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showMidiPanel ? (
        <div className="modal-overlay" onClick={() => setShowMidiPanel(false)}>
          <div className="fx-window midi-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>🎹 Controladores MIDI</span>
              <button
                type="button"
                className="reaper-btn"
                onClick={() => setShowMidiPanel(false)}
              >
                X
              </button>
            </div>
            <div className="fx-body">
              {midiError ? <div className="plugin-note error">{midiError}</div> : null}
              {!midiError && midiDevices.length === 0 ? (
                <div className="plugin-note">
                  Nenhum controlador visível. Conecte o cabo/USB, aceite a permissão de MIDI do
                  navegador e reabra este painel (ou use Devices → Controladores MIDI).
                </div>
              ) : null}
              {midiDevices.map((device) => (
                <button
                  type="button"
                  key={device.id}
                  className={`midi-device ${midiInputId === device.id ? 'active' : ''}`}
                  onClick={() => connectMidiDevice(device.id)}
                >
                  <span className="midi-dev-name">{device.name}</span>
                  <span className="midi-dev-meta">
                    {device.manufacturer ? `${device.manufacturer} · ` : ''}
                    {midiInputId === device.id ? 'conectado ✓' : 'clique para conectar'}
                  </span>
                </button>
              ))}
              {midiInputId ? (
                <div className="fx-footer">
                  <button type="button" className="reaper-btn" onClick={disconnectMidi}>
                    Desconectar
                  </button>
                </div>
              ) : null}
              <div className="plugin-note">
                Com um controlador conectado: as notas tocam na track de instrumento{' '}
                <strong>armada</strong> (ou na selecionada). Com a <strong>gravação</strong> ligada
                e uma track de instrumento armada, cada nota é capturada quantizada na grade de
                16º e editável no piano roll / sequencer. Piano e bateria passam pela cadeia de
                plugins (NAM, cab, FX) daquela track.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* The count-in bar, big enough to read from across the room: a producer
          with headphones on is looking at the instrument, not at the ruler. */}
      {countBeat > 0 ? (
        <div className="count-overlay" aria-live="polite">
          <span className="count-num">{countBeat}</span>
          <span className="count-cap">
            {recordGateRef.current ? 'GRAVA NO 1º TEMPO' : 'COUNT-IN · 1 COMPASSO'}
          </span>
        </div>
      ) : null}

      {devicesOpen ? (
        <div className="modal-overlay" onClick={() => setDevicesOpen(false)}>
          <div className="fx-window devices-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>⚙ Dispositivos de áudio</span>
              <div className="midi-tools">
                <button type="button" className="reaper-btn" onClick={() => void refreshInputs()}>
                  Redetectar
                </button>
                <button type="button" className="reaper-btn" onClick={() => setDevicesOpen(false)}>
                  X
                </button>
              </div>
            </div>
            <div className="fx-body">
              <div className="plugin-note">
                <strong>Driver:</strong> o OpenDAW fala com a placa pelo mixer do sistema — em
                Windows isso é <strong>WASAPI compartilhado</strong>. Nem o navegador nem o Electron
                expõem <strong>ASIO</strong>, então o driver exclusivo da interface e os buffer de
                128 amostras de um DAW nativo não existem aqui. O que existe de verdade: escolher a
                entrada por canal, escolher a saída, e ver a latência que a máquina está dando.
              </div>

              <div className="dev-section">
                <div className="dev-title">Saída — onde o mix toca</div>
                <select
                  className="dev-select"
                  value={outputRoute.deviceId}
                  onChange={(event) => void chooseOutput(event.target.value)}
                >
                  <option value="">Dispositivo padrão do sistema</option>
                  {outputs.map((device, index) => (
                    <option
                      key={device.deviceId || `out-${index}`}
                      value={device.deviceId}
                      disabled={!device.deviceId}
                    >
                      {device.label || `Saída sem nome ${index + 1}`}
                    </option>
                  ))}
                </select>
                <div className="dev-latency">
                  <span className={outputRoute.routed ? 'dev-ok' : 'dev-idle'}>
                    {outputRoute.routed
                      ? `saindo por ${outputRoute.label}`
                      : 'saindo pelo dispositivo padrão'}
                  </span>
                  <span className="dev-ms" title="Buffer de saída que o contexto informa (baseLatency + outputLatency)">
                    saída {autoLatencyMs} ms
                  </span>
                  <span className="dev-ms" title="Atraso da captura informada pelo navegador; 0 ms significa que o navegador não contou">
                    entrada {inputLatencyMs} ms
                  </span>
                  <span
                    className="dev-ms"
                    title={`A gravação é adiantada deste valor para casar com o monitor: -1 segue a latência medida (${autoLatencyMs} ms)`}
                  >
                    compensação {recordLatencyMs < 0 ? `auto ${autoLatencyMs}` : recordLatencyMs} ms
                  </span>
                </div>
                {outputRoute.error ? (
                  <div className="plugin-note error">
                    A saída foi recusada: {outputRoute.error}. O mix voltou ao dispositivo padrão e
                    continua audível.
                  </div>
                ) : null}
                {outputs.length === 0 ? (
                  <div className="plugin-note">
                    Nenhuma saída nomeada ainda: o navegador só entrega os nomes depois de permitir o
                    microfone. Use <strong>Redetectar</strong> e aceite a permissão.
                  </div>
                ) : null}
              </div>

              <div className="dev-section">
                <div className="dev-title">Entradas — o que a máquina oferece</div>
                {inputs.length === 0 ? (
                  <div className="plugin-note">
                    Nenhuma entrada visível. Clique em <strong>Redetectar</strong> e permita o
                    microfone; interfaces USB aparecem pelo nome quando o navegador tem permissão.
                  </div>
                ) : (
                  inputs.map((device, index) => {
                    // Only a device with an id can be patched: a lane that never
                    // chose one carries '' and would otherwise "belong" to every
                    // placeholder the browser lists before permission is granted.
                    const users =
                      device.deviceId === ''
                        ? []
                        : tracks.filter(
                            (track) => track.kind === 'audio' && track.inputDeviceId === device.deviceId,
                          )
                    const seen = deviceChannels[device.deviceId] ?? 0
                    const live = users.some((track) => Boolean(liveInput[track.id]))
                    return (
                      <div className="dev-row" key={device.deviceId || `in-${index}`}>
                        <span className="dev-name">
                          {device.label || 'Entrada sem nome — permita o microfone'}
                        </span>
                        <span className="dev-meta">
                          {device.deviceId
                            ? seen > 0
                              ? `${seen} canal(is)${live ? ' · aberta' : ' · ainda não aberta'}`
                              : 'canais só aparecem quando a entrada é aberta'
                            : 'sem id — não pode ser aberta'}
                        </span>
                        <span className="dev-users">
                          {users.length > 0
                            ? users
                                .map((track) => {
                                  const status = liveInput[track.id]
                                  const ch = status
                                    ? describeLiveInput(status)
                                    : track.inputChannel >= 1
                                      ? `Entrada ${track.inputChannel}`
                                      : 'Par estéreo'
                                  // A lane remembers its cable; whether the cable is
                                  // plugged in right now is a different fact.
                                  const state = status
                                    ? track.inputWet
                                      ? 'FX'
                                      : 'seco'
                                    : 'desligada'
                                  return `${track.name} (${ch}, ${state})`
                                })
                                .join(' · ')
                            : 'livre'}
                        </span>
                      </div>
                    )
                  })
                )}
                <div className="plugin-note">
                  Cada track escolhe o seu dispositivo e o seu canal na própria linha (IN / CH). Uma
                  interface de vários canais pode ser dividida: voz na Entrada 1, guitarra na
                  Entrada 2, e as duas gravam juntas.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {fxTrack ? (
        <div className="modal-overlay" onClick={() => setFxTrackId(null)}>
          <div
            ref={fxWindowRef}
            className={`fx-window track-fx-window${fxMinimized ? ' minimized' : ''}`}
            // The drag offset and the pulled size, applied to the window itself:
            // the overlay keeps its centred layout, so a rack moved aside or
            // grown never nudges the rest of the page.
            style={{
              transform: `translate(${fxOffset.x}px, ${fxOffset.y}px)`,
              ...(fxSize && !fxMinimized
                ? {
                    width: fxSize.width,
                    height: fxSize.height,
                    // The sheet's own caps are for a window nobody sized; the
                    // producer's number is the one that stands. Minimised, the
                    // bar takes the height of the bar, not of the rack under it.
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }
                : null),
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="fx-header fx-header-drag"
              title="Arraste esta barra para mover a janela — duplo clique minimiza"
              onPointerDown={startFxDrag}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest('button')) return
                setFxMinimized((value) => !value)
              }}
            >
              <span>Cadeia de Plugins — {fxTrack.name}</span>
              <div className="fx-header-tools">
                {/* Minimised, the rack keeps its bar and puts its body — and the
                    plugin window sitting in it — away, the way a native window
                    does. The plugin itself stays loaded, so the knobs are exactly
                    where they were left. */}
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => setFxMinimized((value) => !value)}
                  title={fxMinimized ? 'Mostrar a cadeia de novo' : 'Minimizar a janela de FX'}
                  aria-label={fxMinimized ? 'Restaurar janela de FX' : 'Minimizar janela de FX'}
                >
                  {fxMinimized ? '▢' : '–'}
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => setFxTrackId(null)}
                  title="Fechar a janela de FX"
                >
                  X
                </button>
              </div>
            </div>
            <div className="fx-body fx-body-scroll">
              <div className="fx-section-title">Amp Sim integrado</div>
              <div className="fx-param">
                <label htmlFor="plugin-amp">Modelo:</label>
                <select
                  id="plugin-amp"
                  className="reaper-input"
                  value={fxTrack.hasFx ? 'on' : 'off'}
                  onChange={(event) => toggleFx(fxTrack.id, event.target.value === 'on')}
                >
                  <option value="off">Bypass (clean)</option>
                  <option value="on">High Gain (waveshaper)</option>
                </select>
              </div>
              <div className="fx-param">
                <label htmlFor="fx-drive">Preamp Gain / Drive:</label>
                <input
                  id="fx-drive"
                  type="range"
                  min={1}
                  max={100}
                  value={fxTrack.drive}
                  onChange={(event) => changeDrive(fxTrack.id, Number(event.target.value))}
                />
                <span className="value-badge">{fxTrack.drive}</span>
              </div>
              <div className="fx-param">
                <label htmlFor="fx-cab">Cabinet Lowpass (Hz):</label>
                <input
                  id="fx-cab"
                  type="range"
                  min={1000}
                  max={8000}
                  value={fxTrack.cabinet}
                  disabled={!fxTrack.hasFx}
                  onChange={(event) => changeCabinet(fxTrack.id, Number(event.target.value))}
                />
                <span className="value-badge">{fxTrack.cabinet}</span>
              </div>

              <div className="fx-section-title">
                <span>
                  Signal Chain <span className="fx-section-hint">(ordem real do áudio)</span>
                </span>
                <select
                  className="preset-select"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      applyFxPreset(fxTrack.id, e.target.value)
                      e.target.value = ''
                    }
                  }}
                >
                  <option value="" disabled>
                    Presets FX...
                  </option>
                  {Object.entries(BUILTIN_FX_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="plugin-actions">
                <button
                  type="button"
                  className="reaper-btn nam-btn"
                  onClick={() => addPluginFile(fxTrack.id, 'nam')}
                >
                  + NAM (.nam)
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => addPluginFile(fxTrack.id, 'ir')}
                >
                  + IR / Cabinet (.wav)
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  onClick={() => addPluginFile(fxTrack.id, 'worklet')}
                >
                  + AudioWorklet (.js)
                </button>
                <select
                  className="preset-select"
                  defaultValue=""
                  title="Ordem dos efeitos — mudam o som, não só a lista"
                  onChange={(event) => {
                    if (event.target.value) {
                      applyChainOrder(fxTrack.id, event.target.value)
                      event.target.value = ''
                    }
                  }}
                >
                  <option value="" disabled>
                    Ordem da cadeia…
                  </option>
                  {Object.entries(CHAIN_ORDERS).map(([key, preset]) => (
                    <option key={key} value={key}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="reaper-btn"
                  title="Salvar esta cadeia de efeitos em arquivo (.opdawchain). Plugins NAM/IR ficam de fora."
                  onClick={() => exportChainPreset(fxTrack.id)}
                >
                  ⬇ Cadeia
                </button>
                <button
                  type="button"
                  className="reaper-btn"
                  title="Aplicar uma cadeia de efeitos salva (.opdawchain)"
                  onClick={() => openChainPreset(fxTrack.id)}
                >
                  ⬆ Cadeia
                </button>
              </div>

              <div className="signal-chain">
                <div className="chain-endpoint">IN</div>
                {fxChainEntries.map((item, index) =>
                  item.kind === 'builtin' ? (
                    (() => {
                      const meta = BUILTIN_FX_META[item.id]
                      const unit = fxTrack.fxRack[item.id]
                      return (
                        <div
                          key={item.key}
                          data-fx-id={item.id}
                          className={`chain-card card-fx ${unit.enabled ? '' : 'bypassed'} ${
                            dragOverKey === item.key && dragChainKeyRef.current !== item.key
                              ? 'drop-target'
                              : ''
                          }`}
                          onDragOver={(event) => {
                            event.preventDefault()
                            if (dragChainKeyRef.current && dragChainKeyRef.current !== item.key) {
                              setDragOverKey(item.key)
                            }
                          }}
                          onDragLeave={() =>
                            setDragOverKey((key) => (key === item.key ? null : key))
                          }
                          onDrop={(event) => {
                            event.preventDefault()
                            const from = dragChainKeyRef.current
                            setDragOverKey(null)
                            dragChainKeyRef.current = null
                            if (from) reorderChainTo(fxTrack.id, from, item.key)
                          }}
                        >
                          <div
                            className="card-head"
                            draggable
                            onDragStart={() => {
                              dragChainKeyRef.current = item.key
                            }}
                            onDragEnd={() => {
                              dragChainKeyRef.current = null
                              setDragOverKey(null)
                            }}
                            title="Arraste o cartão para reordenar a cadeia"
                          >
                            <button
                              type="button"
                              className={`led ${unit.enabled ? 'on' : ''}`}
                              title={
                                unit.enabled
                                  ? 'Ativo — clique para bypass'
                                  : 'Bypass — clique para ativar'
                              }
                              onClick={() => toggleBuiltinFx(fxTrack.id, item.id)}
                            />
                            <span className="card-idx">{index + 1}</span>
                            <span className="card-kind kind-fx">FX</span>
                            <span className="card-name" title={meta.hint}>
                              {meta.label}
                            </span>
                            <span className="card-move">
                              <button
                                type="button"
                                className="mini-btn"
                                title="Mover para antes na cadeia"
                                disabled={index === 0}
                                onClick={() => moveChainStage(fxTrack.id, item.key, -1)}
                              >
                                ◀
                              </button>
                              <button
                                type="button"
                                className="mini-btn"
                                title="Mover para depois na cadeia"
                                disabled={index === fxChainEntries.length - 1}
                                onClick={() => moveChainStage(fxTrack.id, item.key, 1)}
                              >
                                ▶
                              </button>
                            </span>
                            <button
                              type="button"
                              className="mini-btn danger chain-remove"
                              title={`Remover ${meta.label} da cadeia — os ajustes ficam guardados`}
                              aria-label={`Remover ${meta.label} da cadeia`}
                              onClick={() => removeBuiltinFromChain(fxTrack.id, item.id)}
                            >
                              ✕
                            </button>
                          </div>
                          <div className="card-knobs">
                            <Knob
                              label="MIX"
                              value={unit.mix}
                              min={0}
                              max={1}
                              step={0.01}
                              display={`${Math.round(unit.mix * 100)}%`}
                              accent="#8ab4f8"
                              size={48}
                              onInput={(next) => changeBuiltinMix(fxTrack.id, item.id, next)}
                            />
                            {meta.params.map((param) => (
                              <Knob
                                key={param.key}
                                label={param.label}
                                value={unit.params[param.key]}
                                min={param.min}
                                max={param.max}
                                step={param.step}
                                display={formatFxParam(param.key, unit.params[param.key])}
                                size={48}
                                onInput={(next) =>
                                  changeBuiltinParam(fxTrack.id, item.id, param.key, next)
                                }
                              />
                            ))}
                          </div>
                        </div>
                      )
                    })()
                  ) : (
                    <div
                      key={item.key}
                      className={`chain-card card-${item.plugin.kind} ${
                        item.plugin.enabled ? '' : 'bypassed'
                      } ${
                        dragOverKey === item.key && dragChainKeyRef.current !== item.key
                          ? 'drop-target'
                          : ''
                      }`}
                      onDragOver={(event) => {
                        event.preventDefault()
                        if (dragChainKeyRef.current && dragChainKeyRef.current !== item.key) {
                          setDragOverKey(item.key)
                        }
                      }}
                      onDragLeave={() =>
                        setDragOverKey((key) => (key === item.key ? null : key))
                      }
                      onDrop={(event) => {
                        event.preventDefault()
                        const from = dragChainKeyRef.current
                        setDragOverKey(null)
                        dragChainKeyRef.current = null
                        if (from) reorderChainTo(fxTrack.id, from, item.key)
                      }}
                    >
                      <div
                        className="card-head"
                        draggable
                        onDragStart={() => {
                          dragChainKeyRef.current = item.key
                        }}
                        onDragEnd={() => {
                          dragChainKeyRef.current = null
                          setDragOverKey(null)
                        }}
                        title="Arraste o cartão para reordenar a cadeia"
                      >
                        <button
                          type="button"
                          className={`led ${item.plugin.enabled ? 'on' : ''}`}
                          title={
                            item.plugin.enabled
                              ? 'Ativo — clique para bypass'
                              : 'Bypass — clique para ativar'
                          }
                          onClick={() => togglePlugin(fxTrack.id, item.plugin.id)}
                        />
                        <span className="card-idx">{index + 1}</span>
                        <span className={`card-kind kind-${item.plugin.kind}`}>
                          {item.plugin.kind === 'ir'
                            ? 'IR'
                            : item.plugin.kind === 'nam'
                              ? 'NAM'
                              : 'WORKLET'}
                        </span>
                        {item.plugin.kind === 'nam' ? (
                          <span
                            className="card-kind kind-par"
                            title="Todos os NAMs tocam em paralelo"
                          >
                            PAR
                          </span>
                        ) : null}
                        <span className="card-name" title={item.plugin.name}>
                          {item.plugin.name}
                        </span>
                        {item.plugin.kind === 'nam'
                          ? (() => {
                              const entries = fxChainEntries
                              const next = entries[index + 1]
                              const attached =
                                next?.kind === 'plugin' && next.plugin.kind === 'ir'
                              return (
                                <button
                                  type="button"
                                  className={`mini-btn cab-btn ${attached ? 'attached' : ''}`}
                                  title={
                                    attached
                                      ? `Cabinet anexado: ${next.plugin.name} — clique para trocar`
                                      : 'Anexar um cabinet (IR) somente a este amp — o IR processa apenas o ramo paralelo deste amplificador'
                                  }
                                  onClick={() => addPluginFile(fxTrack.id, 'ir', item.plugin.id)}
                                >
                                  🎛 CAB
                                </button>
                              )
                            })()
                          : null}
                        {item.plugin.kind === 'ir'
                          ? (() => {
                              const prev = fxChainEntries[index - 1]
                              return prev?.kind === 'plugin' && prev.plugin.kind === 'nam' ? (
                                <span className="card-hint">↳ cabinet de {prev.plugin.name}</span>
                              ) : null
                            })()
                          : null}
                        <span className="card-move">
                          <button
                            type="button"
                            className="mini-btn"
                            title="Mover para antes na cadeia"
                            disabled={index === 0}
                            onClick={() => moveChainStage(fxTrack.id, item.key, -1)}
                          >
                            ◀
                          </button>
                          <button
                            type="button"
                            className="mini-btn"
                            title="Mover para depois na cadeia"
                            disabled={index === fxChainEntries.length - 1}
                            onClick={() => moveChainStage(fxTrack.id, item.key, 1)}
                          >
                            ▶
                          </button>
                        </span>
                        <button
                          type="button"
                          className="mini-btn danger"
                          title="Remover plugin"
                          onClick={() => removePlugin(fxTrack.id, item.plugin.id)}
                        >
                          ✕
                        </button>
                      </div>
                      {item.plugin.detail ? (
                        <div className="plugin-detail">{item.plugin.detail}</div>
                      ) : null}
                      <div className="card-knobs">
                        {item.plugin.params.map((param) => (
                          <Knob
                            key={param.name}
                            label={param.name}
                            value={param.value}
                            min={param.min}
                            max={param.max}
                            step={param.step ?? ((param.max - param.min) / 100 || 0.01)}
                            display={formatPluginParam(param)}
                            accent={
                              item.plugin.kind === 'nam'
                                ? '#e0a24a'
                                : item.plugin.kind === 'ir'
                                  ? '#6fa8dc'
                                  : '#c084fc'
                            }
                            size={48}
                            onInput={(next) =>
                              changePluginParam(fxTrack.id, item.plugin.id, param.name, next)
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ),
                )}
                <div className={`chain-add ${availableBuiltinFx.length === 0 ? 'complete' : ''}`}>
                  <span className="chain-add-plus" aria-hidden="true">
                    +
                  </span>
                  <select
                    className="chain-add-select"
                    value=""
                    disabled={availableBuiltinFx.length === 0}
                    aria-label="Adicionar efeito à cadeia"
                    title="Adicionar um efeito embutido ao fim da cadeia"
                    onChange={(event) => {
                      const fxId = event.target.value as BuiltinFxId
                      if (availableBuiltinFx.includes(fxId)) addBuiltinToChain(fxTrack.id, fxId)
                    }}
                  >
                    <option value="">
                      {availableBuiltinFx.length === 0 ? 'Todos adicionados' : 'Efeito…'}
                    </option>
                    {availableBuiltinFx.map((fxId) => (
                      <option key={fxId} value={fxId}>
                        {BUILTIN_FX_META[fxId].label} — {BUILTIN_FX_META[fxId].hint}
                      </option>
                    ))}
                  </select>
                  <span className="chain-add-hint">
                    {availableBuiltinFx.length === 0 ? 'cadeia completa' : 'adicionar'}
                  </span>
                </div>
                <div className="chain-endpoint">OUT</div>
              </div>

              {isNativeApp() && fxTrack.kind === 'audio' ? (
                <NativeVstInsert
                  trackName={fxTrack.name}
                  slot={fxTrack.nativeVst2}
                  sampleRate={engineRef.current?.ctx.sampleRate ?? 48000}
                  hasClip={Boolean(fxTrack.bufferId) && fxTrack.clipDuration > 0}
                  busy={Boolean(bouncingVst[fxTrack.id])}
                  preview={nativePreview[fxTrack.id] ?? null}
                  onChange={(next) => setNativeVstSlot(fxTrack.id, next)}
                  onBounce={() => void applyNativeVstToClip(fxTrack.id)}
                  onPreviewRetry={() => retryNativePreview(fxTrack.id)}
                  liveState={liveVst[fxTrack.id] ?? null}
                />
              ) : null}

              <div className="plugin-note">
                Arraste os cartões (ou use ◀/▶) para reordenar. Em <strong>+ Efeito</strong> você
                adiciona um embutido; no <strong>✕</strong> ele sai do caminho do áudio sem perder
                os ajustes. O amp sim integrado fica antes da cadeia.
                Todos os NAMs rodam em paralelo e são somados na saída — use o{' '}
                <strong>Pan</strong> de cada NAM para deixar um amp à esquerda e outro à direita.
                Toque <strong>🎛 CAB</strong> num NAM para anexar um cabinet (IR) só àquele amp: o
                IR é inserido logo após ele e processa apenas esse ramo — cada amplificador pode
                ter o seu próprio speaker.
                Os demais estágios processam a soma. Os plugins externos ficam salvos com o
                projeto: o arquivo é guardado no navegador e volta carregado, com os mesmos
                ajustes, quando o projeto reabrir.
                {!isNativeApp() ? (
                  <>
                    {' '}
                    Plugin nativo — o <strong>.dll</strong> ou o <strong>.vst3</strong> com a
                    interface própria de cada um — só roda no executável do OpenDAW: um navegador
                    não consegue carregar código de terceiros nem abrir a janela dele. Aqui ficam os
                    efeitos que o próprio navegador processa.
                  </>
                ) : null}
              </div>
            </div>
            <div className="fx-footer">
              <button
                type="button"
                className="reaper-btn danger"
                onClick={() => removeTrack(fxTrack.id)}
              >
                Remover Track
              </button>
              <button type="button" className="reaper-btn" onClick={() => setFxTrackId(null)}>
                Fechar
              </button>
            </div>
            {/* The corner the window is pulled from. It is a child of the window
                and sits absolutely, so the sheet's own layout — including the
                split that hands the plugin its pane — is untouched by it. */}
            <div
              className="fx-resize-grip"
              title="Arraste para mudar o tamanho da janela"
              onPointerDown={startFxResize}
            />
          </div>
        </div>
      ) : null}

      {/* Master bus mixing window */}
      {salaMounted ? (
        <SalaCableWindow
          engine={engineRef.current}
          hidden={!showSala}
          onLiveChange={setSalaLive}
          onClose={() => setShowSala(false)}
          createLane={createCallLane}
          removeLane={removeCallLane}
          notify={notify}
        />
      ) : null}

      {showMasterFx ? (
        <div className="modal-overlay" onClick={() => setShowMasterFx(false)}>
          <div
            className="fx-window master-fx-window"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="fx-header">
              <span>MIXAGEM · BARRAMENTO MASTER</span>
              <select
                className="reaper-btn preset-select"
                value=""
                onChange={(event) => {
                  if (event.target.value) applyMasterPreset(event.target.value)
                }}
              >
                <option value="">Preset master…</option>
                {Object.entries(MASTER_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>
                    {preset.name}
                  </option>
                ))}
              </select>
              <button type="button" className="reaper-btn" onClick={() => setShowMasterFx(false)}>
                X
              </button>
            </div>

            <div className="master-fx-note">
              Processa a mixagem final — voz e instrumentos — antes da exportação e do playback.
            </div>

            <div className="master-fx-grid">
              {BUILTIN_FX_IDS.map((fxId) => {
                const meta = BUILTIN_FX_META[fxId]
                const unit = masterFx[fxId]
                return (
                  <div key={fxId} className={`mfx-card ${unit.enabled ? '' : 'bypassed'}`}>
                    <div className="mfx-head">
                      <button
                        type="button"
                        className={`led ${unit.enabled ? 'on' : ''}`}
                        title={unit.enabled ? 'Ativo — clique para bypass' : 'Bypass — clique para ativar'}
                        onClick={() => toggleMasterFx(fxId)}
                      />
                      <span className="mfx-name">{meta.label}</span>
                      <span className="mfx-hint">{meta.hint}</span>
                    </div>
                    <div className="card-knobs">
                      <Knob
                        label="MIX"
                        size={40}
                        value={unit.mix}
                        min={0}
                        max={1}
                        step={0.01}
                        display={`${Math.round(unit.mix * 100)}%`}
                        accent="#8ab4f8"
                        onInput={(next) => changeMasterFxMix(fxId, next)}
                      />
                      {meta.params.map((param) => (
                        <Knob
                          key={param.key}
                          label={param.label}
                          size={40}
                          value={unit.params[param.key]}
                          min={param.min}
                          max={param.max}
                          step={param.step}
                          display={formatFxParam(param.key, unit.params[param.key])}
                          onInput={(next) => changeMasterFxParam(fxId, param.key, next)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="send-bus-section">
              <div className="send-bus-title">BUSES DE ENVIO COMPARTILHADOS</div>
              <div className="card-knobs">
                <Knob
                  label="RV DECAY"
                  size={40}
                  value={sendConfig.rvDecay}
                  min={0.3}
                  max={8}
                  step={0.1}
                  display={`${sendConfig.rvDecay.toFixed(1)} s`}
                  accent="#8ab4f8"
                  onInput={(next) => changeSendConfig('rvDecay', next)}
                />
                <Knob
                  label="RV RTN"
                  size={40}
                  value={sendConfig.rvReturn}
                  min={0}
                  max={2}
                  step={0.01}
                  display={`${Math.round(sendConfig.rvReturn * 100)}%`}
                  accent="#8ab4f8"
                  onInput={(next) => changeSendConfig('rvReturn', next)}
                />
                <Knob
                  label="DL TIME"
                  size={40}
                  value={sendConfig.dlTime}
                  min={20}
                  max={1000}
                  step={5}
                  display={`${Math.round(sendConfig.dlTime)} ms`}
                  accent="#c586f8"
                  onInput={(next) => changeSendConfig('dlTime', next)}
                />
                <Knob
                  label="DL FB"
                  size={40}
                  value={sendConfig.dlFeedback}
                  min={0}
                  max={0.9}
                  step={0.01}
                  display={`${Math.round(sendConfig.dlFeedback * 100)}%`}
                  accent="#c586f8"
                  onInput={(next) => changeSendConfig('dlFeedback', next)}
                />
                <Knob
                  label="DL RTN"
                  size={40}
                  value={sendConfig.dlReturn}
                  min={0}
                  max={2}
                  step={0.01}
                  display={`${Math.round(sendConfig.dlReturn * 100)}%`}
                  accent="#c586f8"
                  onInput={(next) => changeSendConfig('dlReturn', next)}
                />
              </div>
              <div className="send-bus-note">
                Cada canal tem os knobs RV / DL no mixer; o retorno entra no barramento master.
              </div>
            </div>

            <div className="fx-footer">
              <button type="button" className="reaper-btn" onClick={() => setShowMasterFx(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Marker Editing Modal */}
      {editingMarkerId ? (
        <div className="modal-overlay" onClick={() => setEditingMarkerId(null)}>
          <div className="fx-window marker-edit-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>Editar Marcador</span>
              <button type="button" className="reaper-btn" onClick={() => setEditingMarkerId(null)}>
                X
              </button>
            </div>
            <div className="fx-body">
              {(() => {
                const marker = markers.find((m) => m.id === editingMarkerId)
                if (!marker) return null
                return (
                  <div>
                    <div className="fx-param">
                      <label htmlFor="marker-name">Nome:</label>
                      <input
                        id="marker-name"
                        type="text"
                        className="reaper-input"
                        value={marker.name}
                        onChange={(event) => renameMarker(editingMarkerId, event.target.value)}
                        placeholder="Nome do marcador"
                      />
                    </div>
                    <div className="fx-param">
                      <label htmlFor="marker-position">Posição (passos):</label>
                      <input
                        id="marker-position"
                        type="number"
                        className="reaper-input"
                        value={marker.position}
                        min={0}
                        max={totalSteps - 1}
                        onChange={(event) => {
                          const newPos = Math.max(0, Math.min(totalSteps - 1, Number(event.target.value) || 0))
                          setMarkers((prev) => prev.map((m) => (m.id === editingMarkerId ? { ...m, position: newPos } : m)))
                        }}
                      />
                    </div>
                    <div className="fx-param">
                      <label>
                        <input
                          type="checkbox"
                          checked={marker.isRegion}
                          onChange={() => toggleMarkerRegion(editingMarkerId)}
                        />
                        Região
                      </label>
                    </div>
                    {marker.isRegion && marker.regionEnd && (
                      <div className="fx-param">
                        <label htmlFor="marker-region-end">Fim da região (passos):</label>
                        <input
                          id="marker-region-end"
                          type="number"
                          className="reaper-input"
                          value={marker.regionEnd}
                          min={marker.position + 1}
                          max={totalSteps}
                          onChange={(event) => {
                            const newEnd = Math.max(marker.position + 1, Math.min(totalSteps, Number(event.target.value) || marker.position + 1))
                            setMarkers((prev) => prev.map((m) => (m.id === editingMarkerId ? { ...m, regionEnd: newEnd } : m)))
                          }}
                        />
                      </div>
                    )}
                    <div className="fx-param">
                      <label htmlFor="marker-color">Cor:</label>
                      <input
                        id="marker-color"
                        type="color"
                        className="reaper-input"
                        value={marker.color}
                        onChange={(event) => setMarkers((prev) => prev.map((m) => (m.id === editingMarkerId ? { ...m, color: event.target.value } : m)))}
                      />
                    </div>
                  </div>
                )
              })()}
            </div>
            <div className="fx-footer">
              <button type="button" className="reaper-btn danger" onClick={() => { removeMarker(editingMarkerId); setEditingMarkerId(null) }}>
                Remover
              </button>
              <button type="button" className="reaper-btn" onClick={() => setEditingMarkerId(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Marker Creation Modal (from right-click on ruler) */}
      {showMarkerInput ? (
        <div className="modal-overlay" onClick={() => setShowMarkerInput(null)}>
          <div className="fx-window marker-create-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>Novo Marcador</span>
              <button type="button" className="reaper-btn" onClick={() => setShowMarkerInput(null)}>
                X
              </button>
            </div>
            <div className="fx-body">
              <div className="fx-param">
                <label htmlFor="new-marker-name">Nome:</label>
                <input
                  id="new-marker-name"
                  type="text"
                  className="reaper-input"
                  ref={markerNameInputRef}
                  placeholder="Digite o nome do marcador"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && showMarkerInput) {
                      addMarker(showMarkerInput.position, event.currentTarget.value)
                      setShowMarkerInput(null)
                    }
                    if (event.key === 'Escape') setShowMarkerInput(null)
                  }}
                  autoFocus
                />
              </div>
              <div className="fx-param">
                <label>
                  <input type="checkbox" defaultChecked={false} ref={markerIsRegionRef} /> Criar como região
                </label>
              </div>
            </div>
            <div className="fx-footer">
              <button type="button" className="reaper-btn" onClick={() => setShowMarkerInput(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="reaper-btn highlight"
                onClick={() => {
                  if (showMarkerInput) {
                    const nameInput = markerNameInputRef.current as HTMLInputElement
                    const isRegion = markerIsRegionRef.current?.checked || false
                    addMarker(showMarkerInput.position, nameInput.value || `Marcador ${markers.length + 1}`, isRegion)
                    setShowMarkerInput(null)
                  }
                }}
              >
                Criar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPlugins && isNativeApp() ? (
        <PluginPanel
          key={pluginScan}
          sampleRate={engineRef.current?.ctx.sampleRate ?? 48000}
          notify={notify}
          onClose={() => setShowPlugins(false)}
        />
      ) : null}

      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff"
        style={{ display: 'none' }}
        onChange={(event) => void onAudioFile(event)}
      />
      <input
        ref={pluginInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(event) => void onPluginFile(event)}
      />
      <input
        ref={projectInputRef}
        type="file"
        accept=".opdaw,.webdaw,application/json"
        style={{ display: 'none' }}
        onChange={(event) => void onProjectFile(event)}
      />
      <input
        ref={chainInputRef}
        type="file"
        accept=".opdawchain,.webdawchain,.json"
        style={{ display: 'none' }}
        onChange={(event) => void onChainFile(event)}
      />

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
