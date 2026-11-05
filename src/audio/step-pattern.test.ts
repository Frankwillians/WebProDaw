/**
 * Tests for the step-pattern math - run with `npm test`.
 *
 * The live scheduler, the offline export and the grid all answer "does this hit
 * sound on this step" from the same three functions, so a loop that plays right
 * is also a loop that exports right. These tests pin the answers down.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GROOVE_PRESETS,
  PATTERN_LENGTHS,
  cycleGroove,
  foldIntoPattern,
  grooveNotes,
  hitAtStep,
  isPatterned,
  lastPatternStart,
  normalizePatternSteps,
  patternContentEnd,
} from './step-pattern.ts'

const hit = (step: number, pitch = 36, velocity = 0.85, length = 1) => ({
  step,
  pitch,
  length,
  velocity,
})

test('only the offered loop lengths survive sanitizing', () => {
  assert.equal(normalizePatternSteps(16), 16)
  assert.equal(normalizePatternSteps(32), 32)
  assert.equal(normalizePatternSteps(64), 64)
  assert.equal(normalizePatternSteps(0), 0)
  // Anything else (a saved file from an older build, a hand-edited JSON) is
  // treated as "no loop" rather than becoming a weird repeat.
  assert.equal(normalizePatternSteps(24), 0)
  assert.equal(normalizePatternSteps(-16), 0)
  assert.equal(normalizePatternSteps(undefined), 0)
  assert.equal(normalizePatternSteps('16'), 0)
  assert.deepEqual([...PATTERN_LENGTHS], [0, 16, 32, 64])
})

test('a loop needs at least two steps to mean anything', () => {
  assert.equal(isPatterned(0), false)
  assert.equal(isPatterned(1), false)
  assert.equal(isPatterned(16), true)
  assert.equal(isPatterned(Number.NaN), false)
})

test('without a loop a note only sounds on the step it was drawn on', () => {
  assert.equal(hitAtStep(4, 4, 0), true)
  assert.equal(hitAtStep(4, 20, 0), false)
  assert.equal(hitAtStep(4, 36, 0), false)
})

test('a loop repeats from its own bar so the groove never shifts with the song', () => {
  // A hit drawn at step 4 of a 16 step loop sounds at 4, 20, 36, ...
  for (const repeat of [0, 1, 2, 3, 7]) {
    assert.equal(hitAtStep(4, 4 + repeat * 16, 16), true, `repeat ${repeat}`)
  }
  assert.equal(hitAtStep(4, 5, 16), false)
  assert.equal(hitAtStep(4, 3, 16), false)
  assert.equal(hitAtStep(4, -12, 16), false)
})

test('a hit inside a bar that starts later keeps its own offset', () => {
  // Step 20 in a 32 step loop belongs to the second bar: it sounds at 20, 52, 84
  // and never at 4 or 36 (which are the first bar's cells).
  assert.equal(hitAtStep(20, 20, 32), true)
  assert.equal(hitAtStep(20, 52, 32), true)
  assert.equal(hitAtStep(20, 4, 32), false)
  assert.equal(hitAtStep(20, 36, 32), false)
})

test('the last repeat is the one the export has to reach', () => {
  assert.equal(lastPatternStart(4, 16, 64), 52)
  assert.equal(lastPatternStart(4, 16, 53), 52)
  assert.equal(lastPatternStart(4, 16, 52), 36)
  // A hit drawn past the end of the song never plays at all.
  assert.equal(lastPatternStart(70, 16, 64), -1)
  assert.equal(lastPatternStart(4, 0, 64), 4)
})

test('a looped track needs the tail of its longest hit after the last repeat', () => {
  const notes = [hit(0, 36, 0.9, 1), hit(4, 38, 0.9, 4)]
  // 16 step loop in a 64 step song: the last snare starts at 52 and runs 4 steps.
  assert.equal(patternContentEnd(notes, 16, 64), 56)
  // With no loop the content ends where the notes end, regardless of the song.
  assert.equal(patternContentEnd(notes, 0, 64), 8)
  assert.equal(patternContentEnd([], 16, 64), 0)
})

test('drawing across several bars folds into one bar instead of being thrown away', () => {
  const played = [hit(0, 36), hit(4, 38), hit(16, 36), hit(20, 38), hit(30, 42)]
  const folded = foldIntoPattern(played, 16)
  // Four bars of hits collapse onto the first bar; the kick on 16 lands on 0.
  assert.deepEqual(
    folded.map((note) => [note.step, note.pitch]),
    [
      [0, 36],
      [4, 38],
      [14, 42],
    ],
  )
  for (const note of folded) assert.ok(note.step < 16)
})

test('folding keeps the stronger hit when two land on the same cell', () => {
  const folded = foldIntoPattern([hit(0, 36, 0.4), hit(16, 36, 0.95)], 16)
  assert.equal(folded.length, 1)
  assert.equal(folded[0].velocity, 0.95)
})

test('folding clamps a note that is longer than the loop', () => {
  const folded = foldIntoPattern([hit(2, 60, 0.8, 48)], 16)
  assert.equal(folded[0].length, 16)
})

test('folding with no loop leaves the notes exactly as drawn', () => {
  const drawn = [hit(20, 36), hit(4, 38)]
  assert.deepEqual(foldIntoPattern(drawn, 0), drawn)
})

test('a one bar groove cycles through the whole slot', () => {
  const cells = [
    { step: 0, pitch: 36 },
    { step: 4, pitch: 38 },
    { step: 15, pitch: 42, velocity: 0.5 },
  ]
  const notes = cycleGroove(cells, 32)
  assert.equal(notes.length, 6)
  assert.deepEqual(
    notes.map((note) => [note.step, note.pitch]),
    [
      [0, 36],
      [4, 38],
      [15, 42],
      [16, 36],
      [20, 38],
      [31, 42],
    ],
  )
  assert.equal(notes[2].velocity, 0.5)
  assert.equal(notes.every((note) => note.length === 1), true)
})

test('cells drawn outside the bar are ignored when cycling', () => {
  const notes = cycleGroove(
    [
      { step: 2, pitch: 36 },
      { step: 16, pitch: 38 },
      { step: 40, pitch: 42 },
    ],
    32,
  )
  assert.equal(notes.length, 2)
  assert.equal(notes.every((note) => note.pitch === 36), true)
})

test('every preset groove is one bar of real drum pitches', () => {
  const pitches = new Set([36, 37, 38, 39, 42, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 56, 70])
  assert.ok(GROOVE_PRESETS.length >= 6)
  for (const preset of GROOVE_PRESETS) {
    assert.ok(preset.cells.length > 0, `${preset.id} is empty`)
    for (const cell of preset.cells) {
      assert.ok(cell.step >= 0 && cell.step < 16, `${preset.id} step ${cell.step} is outside bar 1`)
      assert.ok(pitches.has(cell.pitch), `${preset.id} pitch ${cell.pitch} is not a drum piece`)
      if (cell.velocity !== undefined) {
        assert.ok(cell.velocity > 0 && cell.velocity <= 1, `${preset.id} velocity is out of range`)
      }
    }
  }
})

test('loading a preset fills the slot and stays inside the loop', () => {
  const preset = GROOVE_PRESETS[0]
  for (const steps of [16, 32, 64]) {
    const notes = grooveNotes(preset, steps)
    assert.equal(notes.length, preset.cells.length * (steps / 16))
    assert.equal(notes.every((note) => note.step >= 0 && note.step < steps), true)
  }
  // A track with no loop still gets a bar of hits rather than nothing.
  assert.equal(grooveNotes(preset, 0).length, preset.cells.length)
})

test('the grid, the scheduler and the export share one answer per step', () => {
  // This is the "the export cannot lie" check for the sequencer: walking the
  // song and asking hitAtStep must produce exactly the list the offline render
  // builds by repeating a note every patternSteps.
  const patternSteps = 16
  const totalSteps = 64
  const notes = [hit(0, 36), hit(4, 38), hit(10, 42, 0.6)]

  const fromPredicate: number[] = []
  for (const note of notes) {
    for (let step = 0; step < totalSteps; step += 1) {
      if (hitAtStep(note.step, step, patternSteps)) fromPredicate.push(step)
    }
  }

  const fromRepeat: number[] = []
  for (const note of notes) {
    for (let step = note.step; step < totalSteps; step += patternSteps) fromRepeat.push(step)
  }

  assert.deepEqual(fromPredicate.sort((a, b) => a - b), fromRepeat.sort((a, b) => a - b))
  assert.equal(fromPredicate.length, notes.length * (totalSteps / patternSteps))
})
