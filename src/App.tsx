import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent as ReactMouseEvent } from 'react'
import { AudioEngine, BUILTIN_FX_IDS, defaultBuiltinFx, encodeWav } from './audio/audio-engine'
import type {
  BuiltinFxId,
  BuiltinFxParams,
  BuiltinFxRack,
  BuiltinFxUnit,
  DrumInstrument,
  DrumStepData,
  PluginInfo,
  PluginKind,
} from './audio/audio-engine'
import './App.css'

type Tab = 'arrangement' | 'sequencer' | 'piano'
type PluginState = PluginInfo & { enabled: boolean }
type DrumStep = DrumStepData

interface TrackState {
  id: string
  number: number
  name: string
  color: string
  volume: number
  pan: number
  isArmed: boolean
  isMuted: boolean
  isSoloed: boolean
  hasFx: boolean
  drive: number
  cabinet: number
  inputDeviceId: string
  inputMonitor: boolean
  plugins: PluginState[]
  fxRack: BuiltinFxRack
  clipStart: number
  clipDuration: number
  clipName: string
}

interface SavedProject {
  version: number
  bpm: number
  masterVolume: number
  masterMuted: boolean
  metronome: boolean
  loop: boolean
  arrangementBars: number
  drumSeq: DrumStep[]
  drumMute: Record<DrumInstrument, boolean>
  synthGrid: boolean[][]
  tracks: TrackState[]
}

interface LegacyProject extends Partial<SavedProject> {
  synthSeq?: (number | null)[]
}

const STORAGE_KEY = 'web-daw-project-v1'
const STEP_COUNT = 16
const TRACK_COLORS = ['#79a8d6', '#e07b53', '#6fcf97', '#c084fc', '#eab308', '#ef4444', '#38bdf8', '#f472b6']

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const NOTE_START_MIDI = 48 // C3
const NOTE_COUNT = 25 // C3 .. C5

interface NoteDef {
  midi: number
  name: string
  freq: number
  isBlack: boolean
}

const NOTES: NoteDef[] = Array.from({ length: NOTE_COUNT }, (_, index) => {
  const midi = NOTE_START_MIDI + index
  const pitch = NOTE_NAMES[midi % 12]
  return {
    midi,
    name: `${pitch}${Math.floor(midi / 12) - 1}`,
    freq: 440 * 2 ** ((midi - 69) / 12),
    isBlack: pitch.includes('#'),
  }
})
// Piano rolls show the highest note at the top.
const DISPLAY_NOTES = [...NOTES].reverse()
const SYNTH_FREQS = DISPLAY_NOTES.map((note) => note.freq)

const DRUM_LABELS: Record<DrumInstrument, string> = {
  kick: 'KICK',
  snare: 'SNARE',
  hihat: 'HI-HAT',
}

const DRUM_COLORS: Record<DrumInstrument, string> = {
  kick: '#e07b53',
  snare: '#79a8d6',
  hihat: '#eab308',
}

const DRUM_INSTRUMENTS: DrumInstrument[] = ['kick', 'snare', 'hihat']

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function emptyDrums(): DrumStep[] {
  return Array.from({ length: STEP_COUNT }, () => ({ kick: 0, snare: 0, hihat: 0 }))
}

function emptyGrid(): boolean[][] {
  return Array.from({ length: NOTE_COUNT }, () => Array.from({ length: STEP_COUNT }, () => false))
}

function emptyMutes(): Record<DrumInstrument, boolean> {
  return { kick: false, snare: false, hihat: false }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

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
}

function formatFxParam(key: keyof BuiltinFxParams, value: number): string {
  if (key === 'time') return `${Math.round(value)} ms`
  if (key === 'tone') return `${Math.round(value)} Hz`
  if (key === 'rate') return `${value.toFixed(1)} Hz`
  if (key === 'depth') return `${value.toFixed(1)} ms`
  if (key === 'decay') return `${value.toFixed(1)} s`
  return `${Math.round(value * 100)}%`
}

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
    out[id] = {
      enabled: Boolean(unit.enabled),
      mix: clampNumber(unit.mix, 0, 1, defaults[id].mix),
      params: {
        drive: clampNumber(params.drive, 0, 1, defaults[id].params.drive),
        tone: clampNumber(params.tone, 400, 9000, defaults[id].params.tone),
        rate: clampNumber(params.rate, 0.1, 6, defaults[id].params.rate),
        depth: clampNumber(params.depth, 0.2, 8, defaults[id].params.depth),
        decay: clampNumber(params.decay, 0.3, 6, defaults[id].params.decay),
        time: clampNumber(params.time, 40, 1000, defaults[id].params.time),
        feedback: clampNumber(params.feedback, 0, 0.85, defaults[id].params.feedback),
      },
    }
  }
  return out
}

function sanitizeDrumValue(value: unknown): number {
  if (value === true) return 1
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(2, Math.round(value)))
  }
  return 0
}

function sanitizeDrums(value: unknown): DrumStep[] {
  if (!Array.isArray(value) || value.length !== STEP_COUNT) return emptyDrums()
  return value.map((step) => {
    const entry = (step ?? {}) as Partial<Record<DrumInstrument, unknown>>
    return {
      kick: sanitizeDrumValue(entry.kick),
      snare: sanitizeDrumValue(entry.snare),
      hihat: sanitizeDrumValue(entry.hihat),
    }
  })
}

function migrateLegacySeq(seq: (number | null)[] | undefined): boolean[][] {
  const grid = emptyGrid()
  if (!Array.isArray(seq)) return grid
  seq.forEach((freq, step) => {
    if (typeof freq !== 'number' || step >= STEP_COUNT) return
    let bestRow = -1
    let bestDistance = Number.POSITIVE_INFINITY
    DISPLAY_NOTES.forEach((note, row) => {
      const distance = Math.abs(note.freq - freq)
      if (distance < bestDistance) {
        bestDistance = distance
        bestRow = row
      }
    })
    if (bestRow >= 0) grid[bestRow][step] = true
  })
  return grid
}

function sanitizeGrid(value: unknown, legacy?: (number | null)[]): boolean[][] {
  if (!Array.isArray(value) || value.length !== NOTE_COUNT) {
    return migrateLegacySeq(legacy)
  }
  return DISPLAY_NOTES.map((_, row) => {
    const line = value[row]
    return Array.from({ length: STEP_COUNT }, (_, step) =>
      Array.isArray(line) ? Boolean(line[step]) : false,
    )
  })
}

function sanitizeTrack(track: Partial<TrackState>, index: number): TrackState {
  return {
    id: typeof track.id === 'string' && track.id ? track.id : newId(),
    number: index + 1,
    name: typeof track.name === 'string' ? track.name : `Track ${index + 1}`,
    color: typeof track.color === 'string' ? track.color : TRACK_COLORS[index % TRACK_COLORS.length],
    volume: clampNumber(track.volume, 0, 1.5, 1),
    pan: clampNumber(track.pan, -1, 1, 0),
    isArmed: Boolean(track.isArmed),
    isMuted: Boolean(track.isMuted),
    isSoloed: Boolean(track.isSoloed),
    hasFx: Boolean(track.hasFx),
    drive: clampNumber(track.drive, 1, 100, 35),
    cabinet: clampNumber(track.cabinet, 1000, 8000, 4500),
    // Devices are bound to the current session only: ids change between sessions.
    inputDeviceId: '',
    inputMonitor: false,
    // External plugin files cannot be restored from JSON.
    plugins: [],
    fxRack: sanitizeFxRack(track.fxRack),
    clipStart: clampNumber(track.clipStart, 0, 100000, 0),
    clipDuration: clampNumber(track.clipDuration, 0, 100000, 0),
    clipName: typeof track.clipName === 'string' ? track.clipName : '',
  }
}

function sanitizeProject(data: LegacyProject): SavedProject {
  const tracks = Array.isArray(data.tracks) ? data.tracks.map(sanitizeTrack) : []
  return {
    version: 2,
    bpm: clampNumber(data.bpm, 40, 280, 120),
    masterVolume: clampNumber(data.masterVolume, 0, 1.5, 0.9),
    masterMuted: Boolean(data.masterMuted),
    metronome: false,
    loop: data.loop !== false,
    arrangementBars: clampNumber(data.arrangementBars, 1, 128, 16),
    drumSeq: sanitizeDrums(data.drumSeq),
    drumMute: {
      kick: Boolean(data.drumMute?.kick),
      snare: Boolean(data.drumMute?.snare),
      hihat: Boolean(data.drumMute?.hihat),
    },
    synthGrid: sanitizeGrid(data.synthGrid, data.synthSeq),
    tracks,
  }
}

function loadStored(): SavedProject | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LegacyProject
    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) return null
    return sanitizeProject(parsed)
  } catch {
    return null
  }
}

function computePeaks(buffer: AudioBuffer, count = 260): number[] {
  const data = buffer.getChannelData(0)
  const block = Math.max(1, Math.floor(data.length / count))
  const peaks: number[] = []
  for (let i = 0; i < count; i += 1) {
    let min = 1
    let max = -1
    for (let j = 0; j < block; j += 1) {
      const value = data[i * block + j] ?? 0
      if (value < min) min = value
      if (value > max) max = value
    }
    peaks.push(Math.max(Math.abs(min), Math.abs(max)))
  }
  return peaks
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function detectBinaryFormat(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    if (bytes.length >= 0x40) {
      const peOffset =
        bytes[0x3c] | (bytes[0x3d] << 8) | (bytes[0x3e] << 16) | (bytes[0x3f] << 24)
      if (
        peOffset > 0 &&
        peOffset + 6 < bytes.length &&
        bytes[peOffset] === 0x50 &&
        bytes[peOffset + 1] === 0x45
      ) {
        const machine = bytes[peOffset + 4] | (bytes[peOffset + 5] << 8)
        if (machine === 0x8664) return 'Windows PE · 64-bit (x64)'
        if (machine === 0x14c) return 'Windows PE · 32-bit (x86)'
        return 'Windows PE'
      }
    }
    return 'Windows (PE)'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return bytes[4] === 2 ? 'Linux ELF · 64-bit' : 'Linux ELF'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xcf &&
    bytes[1] === 0xfa &&
    bytes[2] === 0xed &&
    bytes[3] === 0xfe
  ) {
    return 'macOS Mach-O · 64-bit'
  }
  return 'formato desconhecido'
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

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null)
  const initializedRef = useRef(false)
  const tracksRef = useRef<TrackState[]>([])
  const arrangementBarsRef = useRef(16)
  const songStartRef = useRef(0)
  const nextStepRef = useRef(0)
  const nextTimeRef = useRef(0)
  const playheadRef = useRef(0)
  const recordStartRef = useRef(0)
  const drumSeqRef = useRef<DrumStep[]>(emptyDrums())
  const drumMuteRef = useRef<Record<DrumInstrument, boolean>>(emptyMutes())
  const synthGridRef = useRef<boolean[][]>(emptyGrid())
  const metronomeRef = useRef(false)
  const loopRef = useRef(true)
  const schedulerIdRef = useRef<number | null>(null)
  const stopTimerRef = useRef<number | null>(null)
  const isRecordingRef = useRef(false)
  const selectedRef = useRef<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const pluginInputRef = useRef<HTMLInputElement | null>(null)
  const vstInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const audioTargetRef = useRef<string | null>(null)
  const pluginTarget = useRef<{ trackId: string; kind: PluginKind } | null>(null)

  const [tracks, setTracks] = useState<TrackState[]>([])
  const [drumSeq, setDrumSeq] = useState<DrumStep[]>(emptyDrums)
  const [drumMute, setDrumMute] = useState<Record<DrumInstrument, boolean>>(emptyMutes)
  const [synthGrid, setSynthGrid] = useState<boolean[][]>(emptyGrid)
  const [bpm, setBpm] = useState(120)
  const [arrangementBars, setArrangementBars] = useState(16)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [playheadStep, setPlayheadStep] = useState(0)
  const [activeTab, setActiveTab] = useState<Tab>('arrangement')
  const [showMixer, setShowMixer] = useState(true)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [peaks, setPeaks] = useState<Record<string, number[]>>({})
  const [fxTrackId, setFxTrackId] = useState<string | null>(null)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [masterVolume, setMasterVolume] = useState(0.9)
  const [masterMuted, setMasterMuted] = useState(false)
  const [metronome, setMetronome] = useState(false)
  const [loop, setLoop] = useState(true)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [exportScope, setExportScope] = useState<'mix' | 'track'>('mix')
  const [exportBars, setExportBars] = useState(4)
  const [exporting, setExporting] = useState(false)
  const [vstInfo, setVstInfo] = useState<{ name: string; size: number; format: string } | null>(null)

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
    drumSeqRef.current = drumSeq
  }, [drumSeq])

  useEffect(() => {
    drumMuteRef.current = drumMute
  }, [drumMute])

  useEffect(() => {
    synthGridRef.current = synthGrid
  }, [synthGrid])

  useEffect(() => {
    metronomeRef.current = metronome
  }, [metronome])

  useEffect(() => {
    loopRef.current = loop
  }, [loop])

  useEffect(() => {
    isRecordingRef.current = isRecording
  }, [isRecording])

  useEffect(() => {
    selectedRef.current = selectedTrackId
  }, [selectedTrackId])

  const notify = (message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3400)
  }

  const makeTrack = (index: number, name?: string): TrackState => ({
    id: newId(),
    number: index + 1,
    name: name ?? `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 1,
    pan: 0,
    isArmed: false,
    isMuted: false,
    isSoloed: false,
    hasFx: false,
    drive: 35,
    cabinet: 4500,
    inputDeviceId: '',
    inputMonitor: false,
    plugins: [],
    fxRack: defaultBuiltinFx(),
    clipStart: 0,
    clipDuration: 0,
    clipName: '',
  })

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

  const applyMix = (list: TrackState[]) => {
    const anySoloed = list.some((track) => track.isSoloed)
    for (const track of list) {
      const audible = anySoloed ? track.isSoloed && !track.isMuted : !track.isMuted
      engineRef.current?.setMuted(track.id, !audible)
    }
  }

  const syncTrackToEngine = (track: TrackState) => {
    const engine = engineRef.current
    if (!engine) return
    engine.addTrack(track.id, track.volume, track.pan)
    for (const fxId of BUILTIN_FX_IDS) engine.setBuiltinFx(track.id, fxId, track.fxRack[fxId])
    engine.setFxEnabled(track.id, track.hasFx)
    if (track.hasFx) {
      engine.setDrive(track.id, track.drive)
      engine.setCabinet(track.id, track.cabinet)
    }
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
    setIsPlaying(false)
    nextStepRef.current = 0
  }

  const applyProject = (project: SavedProject) => {
    const engine = engineRef.current
    if (!engine) return

    for (const track of tracksRef.current) engine.removeTrack(track.id)

    const nextTracks = project.tracks.map((track, index) => ({
      ...track,
      number: index + 1,
      plugins: [] as PluginState[],
      inputDeviceId: '',
      inputMonitor: false,
      clipStart: 0,
      clipDuration: 0,
      clipName: '',
    }))
    for (const track of nextTracks) syncTrackToEngine(track)

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
    setDrumSeq(project.drumSeq)
    setDrumMute(project.drumMute)
    setSynthGrid(project.synthGrid)
    setPeaks({})
    setSelectedTrackId(nextTracks[0]?.id ?? null)
    stopPlayback()
  }

  const currentProject = (): SavedProject => ({
    version: 2,
    bpm,
    masterVolume,
    masterMuted,
    metronome: false,
    loop,
    arrangementBars,
    drumSeq,
    drumMute,
    synthGrid,
    tracks,
  })

  // Bootstrap the audio engine once, restoring the last session if available.
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const engine = new AudioEngine()
    engineRef.current = engine

    const stored = loadStored()
    let initialTracks: TrackState[]
    if (stored) {
      initialTracks = stored.tracks.map((track, index) => ({ ...track, number: index + 1 }))
      for (const track of initialTracks) syncTrackToEngine(track)
      engine.setMasterVolume(stored.masterVolume)
      engine.setMasterMuted(stored.masterMuted)
      applyMix(initialTracks)
      setBpm(stored.bpm)
      setMasterVolume(stored.masterVolume)
      setMasterMuted(stored.masterMuted)
      setMetronome(false)
      setLoop(stored.loop)
      setArrangementBars(stored.arrangementBars)
      arrangementBarsRef.current = stored.arrangementBars
      setDrumSeq(stored.drumSeq)
      setDrumMute(stored.drumMute)
      setSynthGrid(stored.synthGrid)
    } else {
      initialTracks = [makeTrack(0, 'Audio 1 (GTR)'), makeTrack(1, 'Audio 2 (VOX)')]
      for (const track of initialTracks) syncTrackToEngine(track)
    }

    commitTracks(initialTracks)
    setSelectedTrackId(initialTracks[0]?.id ?? null)
    if (stored) {
      window.setTimeout(() => setToast('Sessão anterior restaurada automaticamente'), 400)
    }
  }, [])

  // Keep the selection valid.
  useEffect(() => {
    if (selectedTrackId && tracks.some((track) => track.id === selectedTrackId)) return
    setSelectedTrackId(tracks[0]?.id ?? null)
  }, [tracks, selectedTrackId])

  // Autosave the project (audio clips and plugin files are not persisted).
  useEffect(() => {
    if (!initializedRef.current) return
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentProject()))
      } catch {
        /* storage full or unavailable */
      }
    }, 700)
    return () => window.clearTimeout(id)
  }, [tracks, drumSeq, drumMute, synthGrid, bpm, masterVolume, masterMuted, metronome, loop, arrangementBars])

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
          next.master = engine.getMasterLevel()
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

        const drums = drumSeqRef.current[step]
        const mutes = drumMuteRef.current
        if (drums) {
          if (!mutes.kick) engine.playKick(drums.kick, time)
          if (!mutes.snare) engine.playSnare(drums.snare, time)
          if (!mutes.hihat) engine.playHiHat(drums.hihat, time)
        }

        const grid = synthGridRef.current
        for (let row = 0; row < DISPLAY_NOTES.length; row += 1) {
          if (grid[row]?.[step]) {
            engine.playNote(DISPLAY_NOTES[row].freq, 'sawtooth', stepDuration * 0.9, time)
          }
        }

        if (metronomeRef.current && step % 4 === 0) {
          engine.playClick(step === 0, time)
        }

        nextStepRef.current = absoluteStep + 1
        nextTimeRef.current = time + stepDuration

        // While recording the arrangement grows instead of wrapping, so a take
        // is never cut or split by the loop.
        if (isRecordingRef.current) continue
        if (nextStepRef.current < totalSteps) continue

        if (loopRef.current) {
          nextStepRef.current = 0
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

  const removeTrack = (id: string) => {
    const target = tracksRef.current.find((track) => track.id === id)
    engineRef.current?.removeTrack(id)
    const next = tracksRef.current
      .filter((track) => track.id !== id)
      .map((track, index) => ({ ...track, number: index + 1 }))
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
      inputMonitor: false,
      plugins: [],
    }
    syncTrackToEngine(copy)
    const next = [...tracksRef.current, copy]
    commitTracks(next.map((item, index) => ({ ...item, number: index + 1 })))
    setSelectedTrackId(copy.id)
    notify(`Track "${source.name}" duplicada`)
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

  const toggleMute = (id: string) => {
    const next = tracksRef.current.map((track) =>
      track.id === id ? { ...track, isMuted: !track.isMuted } : track,
    )
    applyMix(next)
    commitTracks(next)
  }

  const toggleSolo = (id: string) => {
    const next = tracksRef.current.map((track) =>
      track.id === id ? { ...track, isSoloed: !track.isSoloed } : track,
    )
    applyMix(next)
    commitTracks(next)
  }

  const toggleArm = (id: string) => {
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === id ? { ...track, isArmed: !track.isArmed } : track,
      ),
    )
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
      notify(
        devices.length > 0
          ? `${devices.length} entrada(s) de áudio detectada(s)`
          : 'Nenhuma entrada de áudio encontrada',
      )
    } catch (error) {
      notify(`Falha ao detectar entradas: ${(error as Error).message}`)
    }
  }

  const selectInput = async (trackId: string, deviceId: string) => {
    const engine = engineRef.current
    if (!engine) return
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return

    if (!deviceId) {
      engine.disconnectInput(trackId)
      commitTracks(
        tracksRef.current.map((item) =>
          item.id === trackId
            ? { ...item, inputDeviceId: '', inputMonitor: false }
            : item,
        ),
      )
      notify('Entrada desconectada')
      return
    }

    try {
      await engine.connectInput(trackId, deviceId, track.inputMonitor)
      commitTracks(
        tracksRef.current.map((item) =>
          item.id === trackId ? { ...item, inputDeviceId: deviceId } : item,
        ),
      )
      notify('Entrada conectada — use 🎧 para monitorar')
    } catch (error) {
      notify(`Falha ao abrir entrada: ${(error as Error).message}`)
    }
  }

  const toggleInputMonitor = (trackId: string) => {
    const track = tracksRef.current.find((item) => item.id === trackId)
    if (!track) return
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

  // --------------------------------------------------------- external plugins

  const addPluginFile = (trackId: string, kind: PluginKind) => {
    pluginTarget.current = { trackId, kind }
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
      if (target.kind === 'ir') {
        const data = await file.arrayBuffer()
        const buffer = await engine.ctx.decodeAudioData(data)
        const info = engine.addIrPlugin(target.trackId, buffer, file.name)
        commitPlugins(target.trackId, (prev) => [...prev, { ...info, enabled: true }])
        notify(`IR "${file.name}" carregado`)
      } else if (target.kind === 'nam') {
        const info = await engine.addNamPlugin(target.trackId, file)
        commitPlugins(target.trackId, (prev) => [...prev, { ...info, enabled: true }])
        notify(`Modelo NAM "${file.name}" carregado`)
      } else {
        const info = await engine.addWorkletPlugin(target.trackId, file)
        commitPlugins(target.trackId, (prev) => [...prev, { ...info, enabled: true }])
        notify(`Plugin "${file.name}" carregado`)
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
    engineRef.current?.removePlugin(trackId, pluginId)
    commitPlugins(trackId, (prev) => prev.filter((item) => item.id !== pluginId))
    notify('Plugin removido')
  }

  const movePlugin = (trackId: string, pluginId: string, direction: -1 | 1) => {
    engineRef.current?.movePlugin(trackId, pluginId, direction)
    commitPlugins(trackId, (prev) => {
      const index = prev.findIndex((item) => item.id === pluginId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [plugin] = next.splice(index, 1)
      next.splice(target, 0, plugin)
      return next
    })
  }

  const onVstFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
    setVstInfo({
      name: file.name,
      size: file.size,
      format: detectBinaryFormat(head),
    })
  }

  const changePluginParam = (trackId: string, pluginId: string, name: string, value: number) => {
    engineRef.current?.setPluginParam(trackId, pluginId, name, value)
    commitPlugins(trackId, (prev) =>
      prev.map((item) =>
        item.id === pluginId
          ? { ...item, params: item.params.map((param) => (param.name === name ? { ...param, value } : param)) }
          : item,
      ),
    )
  }

  // ---------------------------------------------------------- built-in fx rack

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
    setBuiltinFx(trackId, fxId, { ...unit, enabled: !unit.enabled })
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

  // ---------------------------------------------------------- audio import

  const importAudioFile = async (file: File, trackId: string) => {
    const engine = engineRef.current
    if (!engine) return
    try {
      const data = await file.arrayBuffer()
      const buffer = await engine.ctx.decodeAudioData(data)
      engine.setBuffer(trackId, buffer)
      engine.setClipStart(trackId, 0)
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
    audioTargetRef.current = target
    const input = audioInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  const onAudioFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const target = audioTargetRef.current
    event.target.value = ''
    if (!file || !target) return
    await importAudioFile(file, target)
  }


  // ------------------------------------------------------------- sequencer

  const cycleDrum = (index: number, instrument: DrumInstrument, mode: 'toggle' | 'accent' | 'clear') => {
    setDrumSeq((prev) =>
      prev.map((step, position) => {
        if (position !== index) return step
        const current = step[instrument]
        const next =
          mode === 'clear'
            ? 0
            : mode === 'accent'
              ? current === 2
                ? 1
                : 2
              : current === 0
                ? 1
                : 0
        return { ...step, [instrument]: next }
      }),
    )
  }

  const toggleDrumMute = (instrument: DrumInstrument) => {
    setDrumMute((prev) => ({ ...prev, [instrument]: !prev[instrument] }))
  }

  const clearDrums = () => {
    setDrumSeq(emptyDrums())
    notify('Bateria limpa')
  }

  const randomDrums = () => {
    setDrumSeq(
      Array.from({ length: STEP_COUNT }, (_, index) => ({
        kick: index % 4 === 0 || Math.random() < 0.1 ? 1 : 0,
        snare: index % 8 === 4 || Math.random() < 0.08 ? 2 : 0,
        hihat: Math.random() < 0.55 ? (index % 4 === 2 ? 2 : 1) : 0,
      })),
    )
    notify('Padrão aleatório gerado')
  }

  const shiftDrums = (direction: -1 | 1) => {
    setDrumSeq((prev) =>
      prev.map((_, index) => prev[(index - direction + STEP_COUNT) % STEP_COUNT]),
    )
  }

  const toggleSynthCell = (row: number, step: number) => {
    setSynthGrid((prev) =>
      prev.map((line, lineIndex) =>
        lineIndex === row
          ? line.map((value, stepIndex) => (stepIndex === step ? !value : value))
          : line,
      ),
    )
  }

  const clearSynth = () => {
    setSynthGrid(emptyGrid())
    notify('Piano roll limpo')
  }

  const randomSynth = () => {
    setSynthGrid(() => {
      const grid = emptyGrid()
      const scale = [0, 2, 4, 5, 7, 9, 11]
      for (let step = 0; step < STEP_COUNT; step += 1) {
        if (Math.random() < 0.45) {
          const octave = Math.random() < 0.5 ? 0 : 12
          const degree = scale[Math.floor(Math.random() * scale.length)]
          const midi = 48 + octave + degree
          const row = DISPLAY_NOTES.findIndex((note) => note.midi === midi)
          if (row >= 0) grid[row][step] = true
        }
      }
      return grid
    })
    notify('Melodia aleatória gerada')
  }

  const startPlayback = (fromStep = Math.floor(playheadRef.current)) => {
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
    songStartRef.current = when - start * stepDuration
    nextStepRef.current = start
    nextTimeRef.current = when
    playheadRef.current = start
    engine.stopBuffers()
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
      window.setTimeout(() => startPlayback(clamped), 60)
    } else {
      setPlayheadStep(clamped)
    }
  }

  const seekFromRuler = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    const total = Math.max(1, arrangementBars * STEP_COUNT)
    seek(Math.floor(ratio * total))
  }

  // -------------------------------------------------------------- recording

  const toggleRecord = async () => {
    const engine = engineRef.current
    if (!engine) return

    if (!isRecording) {
      const armed = tracksRef.current.filter((track) => track.isArmed)
      if (armed.length === 0) {
        notify('Arme uma track (botão "ar") antes de gravar')
        return
      }
      const withInput = armed.filter((track) => track.inputDeviceId)
      if (withInput.length === 0) {
        notify('Selecione o dispositivo de entrada da track (campo IN)')
        return
      }
      try {
        if (!isPlaying) startPlayback(Math.floor(playheadRef.current))
        recordStartRef.current = Math.floor(playheadRef.current)
        const started = await engine.startRecording(withInput.map((track) => track.id))
        if (started.length === 0) {
          notify('Nenhuma entrada ativa para gravar')
          return
        }
        setIsRecording(true)
        notify(`Gravando em ${started.length} track(s) — gravação contínua`)
      } catch (error) {
        notify(`Falha ao gravar: ${(error as Error).message}`)
      }
      return
    }

    const buffers = await engine.stopRecording()
    setIsRecording(false)
    if (buffers.size === 0) {
      notify('Gravação vazia')
      return
    }
    const startedAt = recordStartRef.current
    const durations = new Map<string, number>()
    buffers.forEach((buffer, trackId) => {
      engine.setBuffer(trackId, buffer)
      engine.setClipStart(trackId, startedAt)
      durations.set(trackId, buffer.duration)
      const waveform = computePeaks(buffer)
      setPeaks((prev) => ({ ...prev, [trackId]: waveform }))
    })

    // Make sure the arrangement covers the whole take.
    const stepDuration = 60 / bpm / 4
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
          : { ...track, clipStart: startedAt, clipDuration: duration, clipName: 'Take gravado' }
      }),
    )
    notify('Gravação concluída — o clipe ficou no compasso em que você começou')
  }

  const clearClip = (id: string) => {
    engineRef.current?.setBuffer(id, null)
    engineRef.current?.setClipStart(id, 0)
    setPeaks((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
    commitTracks(
      tracksRef.current.map((track) =>
        track.id === id ? { ...track, clipStart: 0, clipDuration: 0, clipName: '' } : track,
      ),
    )
    notify('Clipe removido')
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

  // ---------------------------------------------------------------- project

  const saveProject = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentProject()))
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
    notify('Novo projeto criado')
  }

  const openExport = () => {
    setExportScope(selectedTrackId ? 'track' : 'mix')
    setExportBars(arrangementBars)
    setShowExport(true)
  }

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null

  const runExport = async () => {
    const engine = engineRef.current
    if (!engine) return
    if (exportScope === 'track') {
      if (!selectedTrack) {
        notify('Selecione uma track para exportar')
        return
      }
      if (!engine.hasBuffer(selectedTrack.id)) {
        notify('Esta track não tem áudio gravado para exportar')
        return
      }
    }

    setExporting(true)
    try {
      const result = await engine.render({
        bpm,
        bars: exportBars,
        drumSteps: drumSeq,
        synthNotes: SYNTH_FREQS,
        synthGrid,
        trackId: exportScope === 'track' ? selectedTrack?.id : undefined,
        masterVolume,
        masterMuted,
      })
      const blob = encodeWav(result.buffer)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const name =
        exportScope === 'track' && selectedTrack
          ? `${slugify(selectedTrack.name) || 'track'}-${stamp}.wav`
          : `mix-${stamp}.wav`
      downloadBlob(blob, name)
      setShowExport(false)
      if (result.warnings.length > 0) {
        notify(`WAV exportado com avisos: ${result.warnings.join(' · ')}`)
      } else {
        notify(`WAV exportado (${(result.buffer.duration).toFixed(1)}s)`)
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
    if (id) removeTrack(id)
  }

  const duplicateSelected = () => {
    const id = selectedRef.current
    if (id) duplicateTrack(id)
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
    removeSelected: () => {},
    duplicateSelected: () => {},
    muteSelected: () => {},
    soloSelected: () => {},
    record: () => {},
    metronome: () => {},
    loop: () => {},
    save: () => {},
    exportAudio: () => {},
  })
  actionsRef.current = {
    togglePlay,
    removeSelected,
    duplicateSelected,
    muteSelected: toggleMuteSelected,
    soloSelected: toggleSoloSelected,
    record: () => void toggleRecord(),
    metronome: toggleMetronome,
    loop: toggleLoop,
    save: saveProject,
    exportAudio: openExport,
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return
      }
      const actions = actionsRef.current
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
        return
      }
      switch (event.key) {
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
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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

  const fxTrack = fxTrackId ? tracks.find((track) => track.id === fxTrackId) ?? null : null
  const masterLevel = levels.master ?? 0
  const totalSteps = Math.max(1, arrangementBars * STEP_COUNT)
  const currentStep = Math.floor(playheadStep) % STEP_COUNT
  const currentBar = Math.min(arrangementBars, Math.floor(playheadStep / STEP_COUNT) + 1)
  const currentBeat = Math.floor((playheadStep % STEP_COUNT) / 4) + 1
  const timeText = `${String(currentBar).padStart(3, '0')}.${currentBeat}.${String(
    Math.floor(playheadStep % 4) + 1,
  ).padStart(2, '0')}`
  const playheadLeft = (playheadStep / totalSteps) * 100
  const barWidthPct = 100 / arrangementBars

  const clipStyle = (track: TrackState) => {
    const stepDuration = 60 / bpm / 4
    const left = Math.min(100, Math.max(0, (track.clipStart / totalSteps) * 100))
    const width = (track.clipDuration / stepDuration / totalSteps) * 100
    return {
      left: `${left}%`,
      width: `${Math.max(2, Math.min(width, 100 - left))}%`,
    }
  }

  return (
    <div className="reaper-shell">
      <header className="menu-bar">
        <div className="logo">
          REAPER <span>WEB v1.3</span>
        </div>
        <nav className="menu-items">
          <div className="menu-item">
            <span>File</span>
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
              <button type="button" onClick={openExport}>
                Exportar Áudio (WAV)…
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>View</span>
            <div className="dropdown">
              <button type="button" onClick={() => setShowMixer((value) => !value)}>
                Alternar Mixer
              </button>
              <button type="button" onClick={toggleMetronome}>
                Metrônomo {metronome ? '(on)' : '(off)'}
              </button>
              <button type="button" onClick={toggleLoop}>
                Loop {loop ? '(on)' : '(off)'}
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Track</span>
            <div className="dropdown">
              <button type="button" onClick={addTrack}>
                Inserir Track
              </button>
              <button type="button" onClick={duplicateSelected}>
                Duplicar Selecionada (Ctrl+D)
              </button>
              <button type="button" onClick={removeSelected}>
                Remover Selecionada (Del)
              </button>
              <button type="button" onClick={() => setActiveTab('sequencer')}>
                Bateria Virtual
              </button>
              <button type="button" onClick={() => setActiveTab('piano')}>
                Instrumento Virtual
              </button>
            </div>
          </div>
          <div className="menu-item">
            <span>Devices</span>
            <div className="dropdown">
              <button type="button" onClick={() => void refreshInputs()}>
                Detectar Entradas de Áudio
              </button>
              <button type="button" onClick={() => void refreshInputs()}>
                Atualizar Dispositivos
              </button>
            </div>
          </div>
        </nav>
        <div className="device-status">
          <span className="mic-label">
            {inputs.length > 0 ? `${inputs.length} entrada(s)` : 'Nenhuma entrada detectada'}
          </span>
          <button type="button" className="reaper-btn highlight" onClick={() => void refreshInputs()}>
            🎧 Detectar Entradas
          </button>
        </div>
      </header>

      <section className="transport-bar">
        <div className="transport-buttons">
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
            className={`transport-btn toggle ${loop ? 'on' : ''}`}
            title="Loop (L)"
            onClick={toggleLoop}
          >
            ⟲
          </button>
        </div>

        <div className="transport-display">
          <div className="display-time">{timeText}</div>
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
            STEP <span>{currentStep + 1}</span> · BAR{' '}
            <span>
              {currentBar}/{arrangementBars}
            </span>
          </div>
        </div>

        <div className="transport-options">
          <button type="button" className="reaper-btn" onClick={addTrack} title="Adicionar track">
            + Track
          </button>
          <button
            type="button"
            className="reaper-btn danger"
            onClick={removeSelected}
            disabled={!selectedTrackId}
            title="Remover a track selecionada (Delete)"
          >
            🗑 Remover Track
          </button>
          <button type="button" className="reaper-btn highlight" onClick={openExport} title="Exportar áudio (Ctrl+E)">
            ⬇ Exportar WAV
          </button>
          <button type="button" className="reaper-btn" onClick={() => setShowMixer((value) => !value)}>
            {showMixer ? 'Ocultar Mixer' : 'Mostrar Mixer'}
          </button>
        </div>
      </section>

      <main className="daw-workspace">
        <aside className="tcp-panel">
          {tracks.map((track) => (
            <div
              key={track.id}
              className={`tcp-track ${track.isArmed ? 'armed' : ''} ${
                selectedTrackId === track.id ? 'selected' : ''
              }`}
              style={{ borderLeftColor: track.color }}
              onClick={() => setSelectedTrackId(track.id)}
            >
              <div className="tcp-header">
                <span className="track-number">{track.number}</span>
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

              <div className="tcp-controls-row input-row">
                <span className="tcp-label">IN</span>
                <select
                  className="input-select"
                  value={track.inputDeviceId}
                  onChange={(event) => void selectInput(track.id, event.target.value)}
                  title="Dispositivo de entrada de áudio"
                >
                  <option value="">— Nenhuma —</option>
                  {inputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || 'Entrada de áudio'}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`mon-btn ${track.inputMonitor ? 'on' : ''} ${
                    track.inputDeviceId ? '' : 'idle'
                  }`}
                  title={
                    track.inputDeviceId
                      ? 'Monitorar entrada (use fones)'
                      : 'Selecione um dispositivo de entrada'
                  }
                  onClick={() => toggleInputMonitor(track.id)}
                >
                  <span className="mon-led" />
                  MON
                </button>
              </div>

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
              <div className="track-actions">
                <button
                  type="button"
                  className="mini-btn"
                  title="Mover para cima"
                  onClick={() => moveTrack(track.id, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="Mover para baixo"
                  onClick={() => moveTrack(track.id, 1)}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="Duplicar track (Ctrl+D)"
                  onClick={() => duplicateTrack(track.id)}
                >
                  Duplicar
                </button>
                <button
                  type="button"
                  className="mini-btn danger"
                  title="Remover track (Delete)"
                  onClick={() => removeTrack(track.id)}
                >
                  Remover
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="tcp-add" onClick={addTrack}>
            + Track
          </button>
        </aside>

        <section className="timeline-panel">
          <div className="ruler-bar" onClick={seekFromRuler} title="Clique para posicionar o playhead">
            {Array.from({ length: arrangementBars }, (_, index) => (
              <div key={index} className="ruler-mark" style={{ width: `${barWidthPct}%` }}>
                {arrangementBars <= 32 || index % 4 === 0 ? index + 1 : ''}
              </div>
            ))}
          </div>

          <div className="playhead" style={{ left: `${playheadLeft}%` }} />

          <div className="workspace-tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'arrangement' ? 'active' : ''}`}
              onClick={() => setActiveTab('arrangement')}
            >
              Arrangement
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'sequencer' ? 'active' : ''}`}
              onClick={() => setActiveTab('sequencer')}
            >
              Step Sequencer
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'piano' ? 'active' : ''}`}
              onClick={() => setActiveTab('piano')}
            >
              Piano Roll
            </button>
          </div>

          <div className={`tab-content ${activeTab === 'arrangement' ? 'active' : ''}`}>
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`arrangement-lane ${selectedTrackId === track.id ? 'selected' : ''}`}
                style={{ borderLeftColor: track.color, backgroundSize: `${barWidthPct}% 100%` }}
                onClick={() => setSelectedTrackId(track.id)}
              >
                <div className="lane-label">
                  {track.name}
                  {track.inputDeviceId ? ' · entrada ativa' : ''}
                </div>
                {peaks[track.id] ? (
                  <div
                    className="audio-item"
                    style={{ borderColor: track.color, ...clipStyle(track) }}
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
                  </div>
                ) : null}
              </div>
            ))}
            {tracks.length === 0 ? (
              <div className="empty-hint">Nenhuma track. Clique em "+ Track".</div>
            ) : null}
          </div>

          <div className={`tab-content ${activeTab === 'sequencer' ? 'active' : ''}`}>
            <div className="drum-machine">
              <div className="dm-toolbar">
                <span className="dm-title">Drum Machine</span>
                <span className="dm-bar">
                  BAR {currentBar}/{arrangementBars}
                </span>
                <span className="dm-hint">
                  clique liga · shift+clique acento · botão direito apaga
                </span>
                <div className="dm-tools">
                  <button type="button" className="mini-btn" onClick={() => shiftDrums(-1)} title="Deslocar à esquerda">
                    ◀
                  </button>
                  <button type="button" className="mini-btn" onClick={() => shiftDrums(1)} title="Deslocar à direita">
                    ▶
                  </button>
                  <button type="button" className="mini-btn" onClick={randomDrums}>
                    Aleatório
                  </button>
                  <button type="button" className="mini-btn danger" onClick={clearDrums}>
                    Limpar
                  </button>
                </div>
              </div>

              <div className="dm-row dm-header">
                <div className="dm-label">INST</div>
                {Array.from({ length: STEP_COUNT }, (_, index) => (
                  <div
                    key={index}
                    className={`dm-stepnum ${index % 4 === 0 ? 'beat' : ''} ${
                      currentStep === index ? 'playing' : ''
                    }`}
                  >
                    {index + 1}
                  </div>
                ))}
                <div className="dm-lane-tools">M</div>
              </div>

              {DRUM_INSTRUMENTS.map((instrument) => (
                <div key={instrument} className="dm-row">
                  <div className="dm-label" style={{ color: DRUM_COLORS[instrument] }}>
                    {DRUM_LABELS[instrument]}
                  </div>
                  {drumSeq.map((step, index) => {
                    const value = step[instrument]
                    return (
                      <button
                        type="button"
                        key={index}
                        className={`dm-pad ${value === 1 ? 'on' : ''} ${
                          value === 2 ? 'accent' : ''
                        } ${currentStep === index ? 'playing' : ''} ${
                          index % 4 === 0 ? 'beat' : ''
                        }`}
                        style={value > 0 ? { backgroundColor: DRUM_COLORS[instrument] } : undefined}
                        onClick={(event) =>
                          cycleDrum(index, instrument, event.shiftKey ? 'accent' : 'toggle')
                        }
                        onContextMenu={(event) => {
                          event.preventDefault()
                          cycleDrum(index, instrument, 'clear')
                        }}
                        aria-label={`${instrument} passo ${index + 1}`}
                      />
                    )
                  })}
                  <button
                    type="button"
                    className={`dm-mute ${drumMute[instrument] ? 'off' : ''}`}
                    onClick={() => toggleDrumMute(instrument)}
                    title={drumMute[instrument] ? 'Reativar' : 'Silenciar'}
                  >
                    M
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className={`tab-content ${activeTab === 'piano' ? 'active' : ''}`}>
            <div className="piano-roll">
              <div className="dm-toolbar">
                <span className="dm-title">Piano Roll</span>
                <span className="dm-bar">
                  BAR {currentBar}/{arrangementBars}
                </span>
                <span className="dm-hint">C3 – C5 · clique para desenhar ou remover notas</span>
                <div className="dm-tools">
                  <button type="button" className="mini-btn" onClick={randomSynth}>
                    Aleatório
                  </button>
                  <button type="button" className="mini-btn danger" onClick={clearSynth}>
                    Limpar
                  </button>
                </div>
              </div>

              <div className="pr-head">
                <div className="pr-key-spacer" />
                {Array.from({ length: STEP_COUNT }, (_, index) => (
                  <div
                    key={index}
                    className={`dm-stepnum ${index % 4 === 0 ? 'beat' : ''} ${
                      currentStep === index ? 'playing' : ''
                    }`}
                  >
                    {index + 1}
                  </div>
                ))}
              </div>

              <div className="pr-body">
                <div className="pr-keys">
                  {DISPLAY_NOTES.map((note) => (
                    <div
                      key={note.midi}
                      className={`pr-key ${note.isBlack ? 'black' : 'white'}`}
                      title={note.name}
                    >
                      {note.isBlack ? '' : note.name}
                    </div>
                  ))}
                </div>
                <div className="pr-grid">
                  {DISPLAY_NOTES.map((note, row) => (
                    <div key={note.midi} className={`pr-row ${note.isBlack ? 'black' : ''}`}>
                      {Array.from({ length: STEP_COUNT }, (_, step) => (
                        <button
                          type="button"
                          key={step}
                          className={`pr-cell ${synthGrid[row]?.[step] ? 'on' : ''} ${
                            currentStep === step ? 'playing' : ''
                          } ${step % 4 === 0 ? 'beat' : ''}`}
                          onClick={() => toggleSynthCell(row, step)}
                          aria-label={`${note.name} passo ${step + 1}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="status-strip">
            <span>
              {tracks.length} track(s) · {arrangementBars} compasso(s)
            </span>
            <span>Espaço: play/stop</span>
            <span>Del: remover track</span>
            <span>Ctrl+D: duplicar</span>
            <span>Ctrl+E: exportar WAV</span>
            <span>M: mute · S: solo · R: gravar</span>
            <span>K: metrônomo · L: loop</span>
          </div>
        </section>
      </main>

      {showMixer ? (
        <footer className="mixer-dock">
          <div className="dock-header">
            <span>MIXER (MCP)</span>
          </div>
          <div className="mixer-channels">
            {tracks.map((track) => (
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
                    title={track.inputDeviceId ? 'Monitorar entrada' : 'Sem entrada selecionada'}
                    onClick={() => toggleInputMonitor(track.id)}
                  >
                    MON
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
              <button
                type="button"
                className={`tcp-btn btn-mute ${masterMuted ? 'muted' : ''}`}
                title="Mutar saída master"
                onClick={toggleMasterMute}
              >
                m
              </button>
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
              <span className="value-badge">{Math.round(masterVolume * 100)}</span>
            </div>
          </div>
        </footer>
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
                    <em>todas as tracks + bateria + synth</em>
                  </span>
                </label>
                <label className={`export-option ${exportScope === 'track' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === 'track'}
                    onChange={() => setExportScope('track')}
                  />
                  <span>
                    <strong>Track selecionada</strong>
                    <em>{selectedTrack ? selectedTrack.name : 'nenhuma track'} · clipe + plugins</em>
                  </span>
                </label>
              </div>

              {exportScope === 'mix' ? (
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
                no contexto offline; caso contrário o export avisa e segue sem eles.
              </div>
            </div>
            <div className="fx-footer">
              <button
                type="button"
                className="reaper-btn"
                onClick={() => setShowExport(false)}
                disabled={exporting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="reaper-btn highlight"
                onClick={() => void runExport()}
                disabled={exporting}
              >
                {exporting ? 'Renderizando…' : 'Renderizar e baixar WAV'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {vstInfo ? (
        <div className="modal-overlay" onClick={() => setVstInfo(null)}>
          <div className="fx-window vst-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>VST nativo detectado</span>
              <button type="button" className="reaper-btn" onClick={() => setVstInfo(null)}>
                X
              </button>
            </div>
            <div className="fx-body">
              <div className="vst-file">
                <span className="plugin-badge vst">VST</span>
                <span className="vst-name" title={vstInfo.name}>
                  {vstInfo.name}
                </span>
                <span className="vst-meta">
                  {vstInfo.format} · {formatBytes(vstInfo.size)}
                </span>
              </div>

              <div className="plugin-note">
                O arquivo foi <strong>lido com sucesso</strong>, mas navegadores não executam
                binários nativos (<code>.dll</code>, <code>.vst3</code>, <code>.so</code>,{' '}
                <code>.dylib</code>). VSTs dependem do sistema operacional e de um host nativo —
                não existe sandbox web capaz de carregá-los diretamente.
              </div>

              <div className="fx-section-title">Equivalentes que funcionam aqui</div>
              <ul className="vst-alternatives">
                <li>
                  <strong>NAM (.nam)</strong> — inferência neural real em WASM. Cobre amps, pedais,
                  pré-amps e qualquer modelo treinado no Neural Amp Modeler. Dá para empilhar
                  vários: pedal → amp → cab.
                </li>
                <li>
                  <strong>IR (.wav)</strong> — convolução real para cabinets, reverbs e respostas
                  de sala.
                </li>
                <li>
                  <strong>AudioWorklet (.js)</strong> — DSP próprio em tempo real no navegador, com
                  parâmetros automáticos.
                </li>
              </ul>

              <div className="plugin-note">
                Para usar VST de verdade é necessário um host nativo (bridge local). O protocolo
                pode ser preparado, mas depende de um executável fora do navegador.
              </div>
            </div>
            <div className="fx-footer">
              <button type="button" className="reaper-btn" onClick={() => setVstInfo(null)}>
                Entendi
              </button>
              {fxTrack ? (
                <button
                  type="button"
                  className="reaper-btn highlight"
                  onClick={() => {
                    const trackId = fxTrack.id
                    setVstInfo(null)
                    addPluginFile(trackId, 'nam')
                  }}
                >
                  Carregar um NAM
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {fxTrack ? (
        <div className="modal-overlay" onClick={() => setFxTrackId(null)}>
          <div className="fx-window" onClick={(event) => event.stopPropagation()}>
            <div className="fx-header">
              <span>Cadeia de Plugins — {fxTrack.name}</span>
              <button type="button" className="reaper-btn" onClick={() => setFxTrackId(null)}>
                X
              </button>
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
                <label htmlFor="fx-cab">IR Cabinet Res. (Hz):</label>
                <input
                  id="fx-cab"
                  type="range"
                  min={1000}
                  max={8000}
                  value={fxTrack.cabinet}
                  onChange={(event) => changeCabinet(fxTrack.id, Number(event.target.value))}
                />
                <span className="value-badge">{fxTrack.cabinet}</span>
              </div>

              <div className="fx-section-title">Plugins externos</div>
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
                <button
                  type="button"
                  className="reaper-btn vst-btn"
                  onClick={() => vstInputRef.current?.click()}
                  title="Inspecionar um VST nativo"
                >
                  + VST (.dll/.vst3)
                </button>
              </div>

              {fxTrack.plugins.length === 0 ? (
                <div className="plugin-note">
                  Nenhum plugin externo nesta track. NAM usa inferência neural real em WASM
                  (modelos A1/A2 do Neural Amp Modeler) e pode ser empilhado: pedal → amp → cab.
                  Um IR aplica convolução real (cabinet/reverb) e um AudioWorklet executa um DSP
                  em JavaScript.
                </div>
              ) : null}

              {fxTrack.plugins.map((plugin) => (
                <div key={plugin.id} className="plugin-slot">
                  <div className="plugin-slot-head">
                    <span className={`plugin-badge ${plugin.kind}`}>
                      {plugin.kind === 'ir' ? 'IR' : plugin.kind === 'nam' ? 'NAM' : 'WORKLET'}
                    </span>
                    <span className="plugin-name" title={plugin.name}>
                      {plugin.name}
                    </span>
                    <button
                      type="button"
                      className="mini-btn plugin-move"
                      title="Subir na cadeia"
                      onClick={() => movePlugin(fxTrack.id, plugin.id, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="mini-btn plugin-move"
                      title="Descer na cadeia"
                      onClick={() => movePlugin(fxTrack.id, plugin.id, 1)}
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className={`mini-btn ${plugin.enabled ? '' : 'off'}`}
                      onClick={() => togglePlugin(fxTrack.id, plugin.id)}
                    >
                      {plugin.enabled ? 'Ativo' : 'Bypass'}
                    </button>
                    <button
                      type="button"
                      className="mini-btn danger"
                      onClick={() => removePlugin(fxTrack.id, plugin.id)}
                    >
                      remover
                    </button>
                  </div>
                  {plugin.detail ? <div className="plugin-detail">{plugin.detail}</div> : null}
                  {plugin.params.map((param) => (
                    <div className="plugin-param" key={param.name}>
                      <label>{param.name}</label>
                      <input
                        type="range"
                        min={param.min}
                        max={param.max}
                        step={(param.max - param.min) / 100 || 0.01}
                        value={param.value}
                        onChange={(event) =>
                          changePluginParam(
                            fxTrack.id,
                            plugin.id,
                            param.name,
                            Number(event.target.value),
                          )
                        }
                      />
                      <span className="value-badge">{param.value.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              ))}

              <div className="plugin-note">
                Plugins externos valem para esta sessão — os arquivos não são salvos no projeto.
                Após reabrir, carregue-os novamente.
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
          </div>
        </div>
      ) : null}

      <input
        ref={pluginInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(event) => void onPluginFile(event)}
      />
      <input
        ref={vstInputRef}
        type="file"
        accept=".dll,.vst3,.vst,.so,.dylib"
        style={{ display: 'none' }}
        onChange={(event) => void onVstFile(event)}
      />

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
