/**
 * Pure MIDI note editing - the maths behind quantize, humanize, nudge, scale
 * snapping and velocity. Run with `npm test`.
 *
 * Nothing here touches the audio graph or React: each function takes the whole
 * note list and returns a new one, so the caller can hand the result straight
 * to the undo stack. The optional `include` predicate is how a tool is limited
 * to the box selection while leaving the rest of the pattern untouched.
 *
 * Notes are the same shape as InstrumentNote in the engine; the type is written
 * out here so this module can be imported by bare Node with no resolution of
 * browser-only files.
 */

export interface RollNote {
  /** Absolute 16th-note position in the arrangement. */
  step: number
  /** MIDI note number. */
  pitch: number
  /** Length in 16th-note steps, at least 1. */
  length: number
  /** 0..1. */
  velocity: number
}

/** Anything that returns 0..1; pass a seeded one for a reproducible humanize. */
export type NoteRng = () => number

/** Which notes a tool should touch. Omit it to touch every note. */
export type NoteFilter = (note: RollNote, index: number) => boolean

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Deterministic 32-bit generator, so a humanize pass can be tested. */
export function mulberry32(seed: number): NoteRng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------------ quantize

/** Grid choices in 16th-note steps; the value the select submits. */
export const QUANTIZE_GRIDS: ReadonlyArray<{ steps: number; label: string }> = [
  { steps: 1, label: '1/16' },
  { steps: 2, label: '1/8' },
  { steps: 3, label: 'tresrito 1/8' },
  { steps: 4, label: '1/4' },
  { steps: 6, label: 'tresrito 1/4' },
  { steps: 8, label: '1/2' },
  { steps: 12, label: 'tresrito 1/2' },
  { steps: 16, label: '1 compasso' },
]

/**
 * Snap note starts to a grid. `strength` 0..1 blends between the original
 * position and the grid, which is the difference between a machine groove and a
 * player who is mostly on time. Length is deliberately left alone: quantizing
 * the tail is what turns a phrase into a brick.
 */
export function quantizeNotes(
  notes: readonly RollNote[],
  gridSteps: number,
  strength = 1,
  include?: NoteFilter,
): RollNote[] {
  const grid = Math.max(1, Math.round(gridSteps))
  const amount = clamp(strength, 0, 1)
  if (amount === 0) return [...notes]
  return notes.map((note, index) => {
    if (include && !include(note, index)) return note
    const target = Math.round(note.step / grid) * grid
    const step = Math.max(0, note.step + Math.round((target - note.step) * amount))
    return step === note.step ? note : { ...note, step }
  })
}

// ----------------------------------------------------------------- humanize

/**
 * Push notes slightly off the grid and vary their velocity. `amount` 0..1 sets
 * how far a hit may drift (at 1 it can land two 16ths away) and how much the
 * loudness wiggles. Timing jitter is always a whole step, because a fraction of
 * a step cannot be represented here.
 */
export function humanizeNotes(
  notes: readonly RollNote[],
  amount = 0.45,
  rng: NoteRng = Math.random,
  include?: NoteFilter,
): RollNote[] {
  const swing = clamp(amount, 0, 1)
  if (swing === 0) return [...notes]
  const jitter = Math.max(1, Math.round(swing * 2))
  return notes.map((note, index) => {
    if (include && !include(note, index)) return note
    const step = Math.max(0, note.step + Math.round((rng() * 2 - 1) * jitter))
    const velocity = clamp(note.velocity + (rng() * 2 - 1) * 0.18 * swing, 0.12, 1)
    if (step === note.step && Math.abs(velocity - note.velocity) < 0.0005) return note
    return { ...note, step, velocity: Math.round(velocity * 1000) / 1000 }
  })
}

// --------------------------------------------------------------- nudge/place

/** Move notes by whole steps and semitones - what the arrow keys do. */
export function nudgeNotes(
  notes: readonly RollNote[],
  deltaSteps: number,
  deltaPitch = 0,
  include?: NoteFilter,
): RollNote[] {
  if (deltaSteps === 0 && deltaPitch === 0) return [...notes]
  return notes.map((note, index) => {
    if (include && !include(note, index)) return note
    return {
      ...note,
      step: Math.max(0, note.step + deltaSteps),
      pitch: clamp(note.pitch + deltaPitch, 0, 127),
    }
  })
}

/** Slide the box itself along with its notes, so the selection stays put. */
export function shiftSelectionBox<T extends { left: number; right: number; high: number; low: number }>(
  box: T,
  deltaSteps: number,
  deltaPitch: number,
): T {
  return {
    ...box,
    left: Math.max(0, box.left + deltaSteps),
    right: Math.max(1, box.right + deltaSteps),
    high: clamp(box.high + deltaPitch, 0, 127),
    low: clamp(box.low + deltaPitch, 0, 127),
  }
}

// ------------------------------------------------------------------ velocity

/** One note's loudness, clamped to the range the engine expects. */
export function withVelocity(
  notes: readonly RollNote[],
  index: number,
  velocity: number,
): RollNote[] {
  return notes.map((note, i) =>
    i === index ? { ...note, velocity: clamp(Math.round(velocity * 1000) / 1000, 0.05, 1) } : note,
  )
}

/** Scale every note at once, keeping the quietest ones audible. */
export function scaleVelocities(
  notes: readonly RollNote[],
  factor: number,
  include?: NoteFilter,
): RollNote[] {
  return notes.map((note, index) => {
    if (include && !include(note, index)) return note
    return { ...note, velocity: clamp(Math.round(note.velocity * factor * 1000) / 1000, 0.05, 1) }
  })
}

// --------------------------------------------------------------------- scale

export const SCALE_ROOTS: ReadonlyArray<string> = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
]

/** Semitone offsets from the root. `intervals` empty means "no scale". */
export const SCALE_MODES: ReadonlyArray<{ id: string; label: string; intervals: readonly number[] }> =
  [
    { id: '', label: 'sem escala', intervals: [] },
    { id: 'major', label: 'Maior', intervals: [0, 2, 4, 5, 7, 9, 11] },
    { id: 'minor', label: 'Menor natural', intervals: [0, 2, 3, 5, 7, 8, 10] },
    { id: 'harmonic', label: 'Menor harmônica', intervals: [0, 2, 3, 5, 7, 8, 11] },
    { id: 'dorian', label: 'Dórica', intervals: [0, 2, 3, 5, 7, 9, 10] },
    { id: 'phrygian', label: 'Frígia', intervals: [0, 1, 3, 5, 7, 8, 10] },
    { id: 'lydian', label: 'Lídia', intervals: [0, 2, 4, 6, 7, 9, 11] },
    { id: 'mixolydian', label: 'Mixolídia', intervals: [0, 2, 4, 5, 7, 9, 10] },
    { id: 'minorPent', label: 'Pentatônica menor', intervals: [0, 3, 5, 7, 10] },
    { id: 'majorPent', label: 'Pentatônica maior', intervals: [0, 2, 4, 7, 9] },
    { id: 'blues', label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
    { id: 'chromatic', label: 'Cromática', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ]

/** Pitch classes (0..11) that belong to a scale; empty id gives every note. */
export function scalePitchClasses(root: number, modeId: string): number[] {
  const mode = SCALE_MODES.find((item) => item.id === modeId)
  if (!mode || mode.intervals.length === 0) return []
  return mode.intervals.map((offset) => ((root + offset) % 12 + 12) % 12)
}

/** True when the scale is off (no notes to tint) or the pitch is a member. */
export function isScalePitch(pitch: number, root: number, modeId: string): boolean {
  const classes = scalePitchClasses(root, modeId)
  if (classes.length === 0) return true
  return classes.includes(((pitch % 12) + 12) % 12)
}

/** Nearest pitch class inside the scale, preferring the note already there. */
export function nearestScalePitch(pitch: number, root: number, modeId: string): number {
  if (!modeId) return pitch
  for (let distance = 0; distance <= 6; distance += 1) {
    const below = pitch - distance
    if (isScalePitch(below, root, modeId)) return below
    const above = pitch + distance
    if (isScalePitch(above, root, modeId)) return above
  }
  return pitch
}

/** Pull every note into the scale, the shortest move wins. */
export function snapNotesToScale(
  notes: readonly RollNote[],
  root: number,
  modeId: string,
  include?: NoteFilter,
): RollNote[] {
  if (!modeId) return [...notes]
  return notes.map((note, index) => {
    if (include && !include(note, index)) return note
    const pitch = nearestScalePitch(note.pitch, root, modeId)
    return pitch === note.pitch ? note : { ...note, pitch }
  })
}
