/**
 * Tests for the MIDI note tools - run with `npm test`.
 *
 * Quantize, humanize and scale snapping all rewrite a groove the user can hear,
 * so the numbers they produce are pinned here: the same notes in must give the
 * same notes out, and notes outside the selection must never move.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUANTIZE_GRIDS,
  SCALE_MODES,
  humanizeNotes,
  isScalePitch,
  mulberry32,
  nearestScalePitch,
  nudgeNotes,
  quantizeNotes,
  scalePitchClasses,
  scaleVelocities,
  shiftSelectionBox,
  snapNotesToScale,
  withVelocity,
} from './midi-edit.ts'

const note = (step: number, pitch = 60, velocity = 0.8, length = 2) => ({
  step,
  pitch,
  length,
  velocity,
})

const selectedFirst = (target: number) => (_n: unknown, index: number) => index === target

test('quantize moves a late hit onto the grid and keeps its length', () => {
  const out = quantizeNotes([note(7, 60, 0.8, 3)], 4)
  assert.equal(out[0].step, 8)
  assert.equal(out[0].length, 3)
})

test('quantize rounds to the closest grid line, not the previous one', () => {
  assert.equal(quantizeNotes([note(5)], 4)[0].step, 4)
  assert.equal(quantizeNotes([note(6)], 4)[0].step, 8)
})

test('strength slides a note only part of the way to the grid', () => {
  assert.equal(quantizeNotes([note(7)], 4, 0.5)[0].step, 8)
  assert.equal(quantizeNotes([note(6)], 4, 0.5)[0].step, 7)
  assert.equal(quantizeNotes([note(7)], 4, 0)[0].step, 7)
})

test('quantize never pushes a note before the start of the pattern', () => {
  assert.equal(quantizeNotes([note(1)], 16)[0].step, 0)
})

test('quantize only touches the notes inside the box', () => {
  const out = quantizeNotes([note(7), note(7)], 4, 1, selectedFirst(1))
  assert.equal(out[0].step, 7)
  assert.equal(out[1].step, 8)
})

test('a grid of 1 means sixteenths and leaves every step alone', () => {
  const out = quantizeNotes([note(3), note(11)], 1)
  assert.deepEqual(
    out.map((n) => n.step),
    [3, 11],
  )
})

test('every offered grid is a whole number of steps', () => {
  for (const grid of QUANTIZE_GRIDS) {
    assert.ok(Number.isInteger(grid.steps) && grid.steps >= 1, grid.label)
    assert.equal(quantizeNotes([note(0)], grid.steps)[0].step, 0)
  }
})

test('humanize is reproducible with a seeded generator', () => {
  const notes = [note(0), note(4), note(8), note(12)]
  const a = humanizeNotes(notes, 0.6, mulberry32(7))
  const b = humanizeNotes(notes, 0.6, mulberry32(7))
  assert.deepEqual(a, b)
})

test('humanize keeps hits near the grid and velocity audible', () => {
  const out = humanizeNotes([note(8, 60, 0.5)], 1, mulberry32(3))
  assert.ok(Math.abs(out[0].step - 8) <= 2, `step drifted to ${out[0].step}`)
  assert.ok(out[0].velocity >= 0.12 && out[0].velocity <= 1)
})

test('humanize of 0 returns the notes untouched', () => {
  const notes = [note(4, 62, 0.4)]
  assert.deepEqual(humanizeNotes(notes, 0, mulberry32(1)), notes)
})

test('humanize leaves notes outside the selection alone', () => {
  const out = humanizeNotes([note(4), note(4)], 1, mulberry32(9), selectedFirst(1))
  assert.deepEqual(out[0], note(4))
  assert.ok(out[1].step >= 0)
  assert.ok(out[1].velocity > 0 && out[1].velocity <= 1)
})

test('nudge moves steps and pitches without dropping the velocity', () => {
  const out = nudgeNotes([note(4, 60, 0.66, 2)], 2, -3)
  assert.deepEqual(out[0], { step: 6, pitch: 57, length: 2, velocity: 0.66 })
})

test('nudge keeps notes inside the MIDI range', () => {
  assert.equal(nudgeNotes([note(0, 127)], 0, 5)[0].pitch, 127)
  assert.equal(nudgeNotes([note(0, 2)], -10)[0].step, 0)
  assert.equal(nudgeNotes([note(0, 2)], 0, -10)[0].pitch, 0)
})

test('the selection box travels with its notes', () => {
  const box = { left: 4, right: 8, high: 64, low: 60 }
  assert.deepEqual(shiftSelectionBox(box, 2, -1), { left: 6, right: 10, high: 63, low: 59 })
})

test('velocity edits clamp and only hit one note', () => {
  const out = withVelocity([note(0, 60, 0.5), note(4, 60, 0.5)], 1, 1.6)
  assert.equal(out[0].velocity, 0.5)
  assert.equal(out[1].velocity, 1)
  assert.equal(withVelocity([note(0, 60, 0.5)], 0, -3)[0].velocity, 0.05)
})

test('scaling velocity softens everything but never mutes it', () => {
  const out = scaleVelocities([note(0, 60, 1), note(4, 60, 0.08)], 0.5)
  assert.equal(out[0].velocity, 0.5)
  assert.equal(out[1].velocity, 0.05)
})

test('a scale is the root plus its intervals, wrapped to one octave', () => {
  assert.deepEqual(scalePitchClasses(0, 'major'), [0, 2, 4, 5, 7, 9, 11])
  assert.deepEqual(scalePitchClasses(9, 'minorPent'), [9, 0, 2, 4, 7])
  assert.deepEqual(scalePitchClasses(2, ''), [])
})

test('no scale means every note is in tune', () => {
  assert.equal(isScalePitch(61, 0, ''), true)
  assert.equal(isScalePitch(61, 0, 'major'), false)
  assert.equal(isScalePitch(60, 0, 'major'), true)
})

test('the nearest scale note prefers staying put, then the shorter move', () => {
  assert.equal(nearestScalePitch(60, 0, 'major'), 60)
  assert.equal(nearestScalePitch(61, 0, 'major'), 60)
  assert.equal(nearestScalePitch(65, 0, 'major'), 65)
  assert.equal(nearestScalePitch(66, 0, 'major'), 65)
  assert.equal(nearestScalePitch(69, 0, 'major'), 69)
})

test('snapping to a scale fixes wrong notes without moving right ones', () => {
  const out = snapNotesToScale([note(0, 61), note(4, 64), note(8, 67)], 0, 'major')
  assert.deepEqual(
    out.map((n) => n.pitch),
    [60, 64, 67],
  )
  assert.deepEqual(snapNotesToScale([note(0, 61)], 0, ''), [note(0, 61)])
})

test('snapping to a scale respects the selection', () => {
  const out = snapNotesToScale([note(0, 61), note(4, 61)], 0, 'major', selectedFirst(0))
  assert.equal(out[0].pitch, 60)
  assert.equal(out[1].pitch, 61)
})

test('every scale mode has sane intervals', () => {
  for (const mode of SCALE_MODES) {
    assert.ok(mode.label.length > 0)
    for (const interval of mode.intervals) {
      assert.ok(interval >= 0 && interval < 12, `${mode.id} has ${interval}`)
    }
  }
})
