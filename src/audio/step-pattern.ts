/**
 * Step-pattern math for looping instrument tracks.
 *
 * A pattern track stores its hits once, inside a loop of `patternSteps` steps,
 * and the transport repeats that loop for the whole arrangement. Only a few
 * questions are interesting: does this hit sound on this song step, where does
 * a note belong when the loop gets shorter, and where does the last repeat end.
 * They live here - pure and tested - because the live scheduler, the offline
 * export and the grid all have to agree on the same answers.
 */

export interface PatternNote {
  step: number
  length: number
}

/** A note as the sequencer grid knows it: a pitch, a step, a strength. */
export interface PatternHit extends PatternNote {
  pitch: number
  velocity: number
}

/** Loop lengths the grid offers. 0 means "no loop": notes stay where drawn. */
export const PATTERN_LENGTHS = [0, 16, 32, 64] as const

export function normalizePatternSteps(value: unknown): number {
  for (const length of PATTERN_LENGTHS) {
    if (value === length) return length
  }
  return 0
}

export function isPatterned(patternSteps: number): boolean {
  return Number.isFinite(patternSteps) && patternSteps >= 2
}

/**
 * Whether the hit of `noteStep` sounds on the absolute song step. Outside a
 * loop this is plain equality; inside one, the loop is locked to bar 1, so
 * moving the playhead never shifts the groove.
 */
export function hitAtStep(
  noteStep: number,
  absoluteStep: number,
  patternSteps: number,
): boolean {
  if (!isPatterned(patternSteps)) return noteStep === absoluteStep
  if (absoluteStep < noteStep) return false
  return (absoluteStep - noteStep) % patternSteps === 0
}

/** The last step the pattern still plays on - one before the arrangement ends. */
export function lastPatternStart(
  noteStep: number,
  patternSteps: number,
  totalSteps: number,
): number {
  if (!isPatterned(patternSteps)) return noteStep
  if (noteStep >= totalSteps) return -1
  const repeats = Math.floor((totalSteps - 1 - noteStep) / patternSteps)
  return noteStep + repeats * patternSteps
}

/**
 * Where the track's audio actually stops. A looped pattern keeps firing until
 * the last repeat, whose tail runs past the end of the arrangement by the
 * longest note - the export needs that much room or the final hit is cut off.
 */
export function patternContentEnd(
  notes: PatternNote[],
  patternSteps: number,
  totalSteps: number,
): number {
  if (!isPatterned(patternSteps)) {
    let end = 0
    for (const note of notes) end = Math.max(end, note.step + note.length)
    return end
  }
  let end = 0
  for (const note of notes) {
    const start = lastPatternStart(note.step, patternSteps, totalSteps)
    if (start < 0) continue
    end = Math.max(end, start + note.length)
  }
  return end
}

/**
 * Re-homes notes onto a loop of the given length. Drawing across several bars
 * and then choosing "1 compasso" is the usual way into a step sequencer, so the
 * notes fold by bar position and the groove you played survives. Two hits that
 * land on the same cell keep the stronger one.
 */
export function foldIntoPattern<T extends PatternHit>(
  notes: T[],
  patternSteps: number,
): T[] {
  if (!isPatterned(patternSteps)) return notes
  const best = new Map<string, T>()
  for (const note of notes) {
    const step = ((note.step % patternSteps) + patternSteps) % patternSteps
    const key = `${step}:${note.pitch}`
    const existing = best.get(key)
    const candidate: T = { ...note, step, length: Math.min(note.length, patternSteps) }
    if (!existing || candidate.velocity > existing.velocity) best.set(key, candidate)
  }
  return [...best.values()].sort(
    (a, b) => a.step - b.step || a.pitch - b.pitch,
  )
}

/**
 * A one-bar groove cycled across the whole pattern, which is how hardware
 * sequencers load a preset into a 2 or 4 bar slot: the bar repeats, and you
 * vary the last one afterwards.
 */
export function cycleGroove(
  cells: Array<{ step: number; pitch: number; velocity?: number }>,
  patternSteps: number,
): PatternHit[] {
  const bar = PATTERN_LENGTHS[1]
  const notes: PatternHit[] = []
  for (let offset = 0; offset < patternSteps; offset += bar) {
    for (const cell of cells) {
      if (cell.step >= bar) continue
      notes.push({
        step: cell.step + offset,
        pitch: cell.pitch,
        length: 1,
        velocity: cell.velocity ?? 0.85,
      })
    }
  }
  return notes
}

/** One hit of a preset groove, placed inside the first bar of 16 steps. */
export interface GrooveCell {
  step: number
  pitch: number
  velocity?: number
}

export interface GroovePreset {
  id: string
  label: string
  cells: GrooveCell[]
}

/**
 * Starting grooves, written one bar each so `cycleGroove` can fill a 2 or 4 bar
 * slot with them. Pitches are the GM drum notes DRUM_PIECES plays, and the
 * velocities are what makes a groove sit right before the user touches it -
 * hats under, snares on top.
 */
export const GROOVE_PRESETS: GroovePreset[] = [
  {
    id: 'rock',
    label: 'Rock básico',
    cells: [
      { step: 0, pitch: 36 },
      { step: 10, pitch: 36, velocity: 0.75 },
      { step: 4, pitch: 38 },
      { step: 12, pitch: 38 },
      { step: 2, pitch: 42, velocity: 0.5 },
      { step: 6, pitch: 42, velocity: 0.5 },
      { step: 14, pitch: 42, velocity: 0.5 },
    ],
  },
  {
    id: 'four',
    label: 'Four on the floor',
    cells: [
      { step: 0, pitch: 36 },
      { step: 4, pitch: 36 },
      { step: 8, pitch: 36 },
      { step: 12, pitch: 36 },
      { step: 2, pitch: 46, velocity: 0.6 },
      { step: 6, pitch: 46, velocity: 0.6 },
      { step: 10, pitch: 46, velocity: 0.6 },
      { step: 14, pitch: 46, velocity: 0.6 },
      { step: 4, pitch: 39, velocity: 0.8 },
      { step: 12, pitch: 39, velocity: 0.8 },
    ],
  },
  {
    id: 'boombap',
    label: 'Boom bap',
    cells: [
      { step: 0, pitch: 36 },
      { step: 3, pitch: 36, velocity: 0.7 },
      { step: 10, pitch: 36, velocity: 0.8 },
      { step: 4, pitch: 38 },
      { step: 12, pitch: 38 },
      { step: 0, pitch: 42, velocity: 0.45 },
      { step: 2, pitch: 42, velocity: 0.45 },
      { step: 4, pitch: 42, velocity: 0.45 },
      { step: 6, pitch: 42, velocity: 0.45 },
      { step: 8, pitch: 42, velocity: 0.45 },
      { step: 11, pitch: 42, velocity: 0.6 },
      { step: 14, pitch: 42, velocity: 0.45 },
    ],
  },
  {
    id: 'trap',
    label: 'Trap',
    cells: [
      { step: 0, pitch: 36 },
      { step: 6, pitch: 36, velocity: 0.8 },
      { step: 10, pitch: 36 },
      { step: 8, pitch: 37, velocity: 0.9 },
      { step: 0, pitch: 42, velocity: 0.4 },
      { step: 2, pitch: 42, velocity: 0.4 },
      { step: 4, pitch: 42, velocity: 0.4 },
      { step: 7, pitch: 42, velocity: 0.5 },
      { step: 12, pitch: 42, velocity: 0.55 },
      { step: 13, pitch: 42, velocity: 0.45 },
      { step: 14, pitch: 42, velocity: 0.55 },
      { step: 15, pitch: 42, velocity: 0.45 },
    ],
  },
  {
    id: 'breaks',
    label: 'Breakbeat',
    cells: [
      { step: 0, pitch: 36 },
      { step: 10, pitch: 36, velocity: 0.7 },
      { step: 4, pitch: 38 },
      { step: 7, pitch: 38, velocity: 0.55 },
      { step: 12, pitch: 38 },
      { step: 2, pitch: 42, velocity: 0.5 },
      { step: 6, pitch: 42, velocity: 0.5 },
      { step: 9, pitch: 42, velocity: 0.6 },
      { step: 14, pitch: 42, velocity: 0.5 },
    ],
  },
  {
    id: 'dnb',
    label: 'Drum and bass',
    cells: [
      { step: 0, pitch: 36 },
      { step: 10, pitch: 36, velocity: 0.9 },
      { step: 4, pitch: 38 },
      { step: 12, pitch: 38 },
      { step: 2, pitch: 42, velocity: 0.4 },
      { step: 6, pitch: 42, velocity: 0.4 },
      { step: 8, pitch: 42, velocity: 0.4 },
      { step: 14, pitch: 42, velocity: 0.4 },
      { step: 15, pitch: 54, velocity: 0.5 },
    ],
  },
  {
    id: 'bossa',
    label: 'Bossa',
    cells: [
      { step: 0, pitch: 36, velocity: 0.7 },
      { step: 6, pitch: 36, velocity: 0.7 },
      { step: 8, pitch: 36, velocity: 0.55 },
      { step: 2, pitch: 37, velocity: 0.6 },
      { step: 5, pitch: 37, velocity: 0.6 },
      { step: 7, pitch: 37, velocity: 0.6 },
      { step: 10, pitch: 37, velocity: 0.6 },
      { step: 13, pitch: 37, velocity: 0.6 },
      { step: 0, pitch: 42, velocity: 0.45 },
      { step: 4, pitch: 42, velocity: 0.45 },
      { step: 8, pitch: 42, velocity: 0.45 },
      { step: 12, pitch: 42, velocity: 0.45 },
    ],
  },
  {
    id: 'funk',
    label: 'Funk 16th',
    cells: [
      { step: 0, pitch: 36, velocity: 0.9 },
      { step: 7, pitch: 36, velocity: 0.7 },
      { step: 12, pitch: 36, velocity: 0.8 },
      { step: 4, pitch: 38, velocity: 0.75 },
      { step: 11, pitch: 38, velocity: 0.5 },
      { step: 14, pitch: 38, velocity: 0.9 },
      { step: 0, pitch: 42, velocity: 0.35 },
      { step: 1, pitch: 42, velocity: 0.25 },
      { step: 2, pitch: 42, velocity: 0.35 },
      { step: 3, pitch: 42, velocity: 0.5 },
      { step: 4, pitch: 42, velocity: 0.35 },
      { step: 5, pitch: 42, velocity: 0.25 },
      { step: 6, pitch: 42, velocity: 0.35 },
      { step: 7, pitch: 42, velocity: 0.5 },
      { step: 8, pitch: 42, velocity: 0.35 },
      { step: 9, pitch: 42, velocity: 0.25 },
      { step: 10, pitch: 42, velocity: 0.35 },
      { step: 11, pitch: 42, velocity: 0.5 },
      { step: 12, pitch: 42, velocity: 0.35 },
      { step: 13, pitch: 42, velocity: 0.25 },
      { step: 14, pitch: 42, velocity: 0.35 },
      { step: 15, pitch: 42, velocity: 0.5 },
    ],
  },
]

/**
 * A preset laid out for a pattern length. Loading a groove goes through here so
 * a 2 bar slot never ends up with a one bar loop the user has to notice.
 */
export function grooveNotes(preset: GroovePreset, patternSteps: number): PatternHit[] {
  return cycleGroove(preset.cells, isPatterned(patternSteps) ? patternSteps : 16)
}
