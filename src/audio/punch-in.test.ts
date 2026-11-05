/**
 * Tests for the punch-in state machine - run with `npm test`.
 *
 * The transport only ever asks these four functions where the capture window
 * should be, so a region that behaves correctly here behaves correctly while
 * recording, even though the real thing cannot be measured from a test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  punchAction,
  punchBoundsOf,
  punchLeadStep,
  punchStartStep,
} from './punch-in.ts'

test('a selection becomes a whole-step region', () => {
  assert.deepEqual(punchBoundsOf({ from: 12.4, to: 27.1 }, 256), { from: 12, to: 28 })
})

test('the region is clamped to the arrangement', () => {
  assert.deepEqual(punchBoundsOf({ from: 250, to: 400 }, 256), { from: 250, to: 256 })
  // Clamped away to nothing: there is no region left to record.
  assert.equal(punchBoundsOf({ from: 300, to: 400 }, 256), null)
})

test('an empty selection is no region, and a sliver widens to the step it touches', () => {
  assert.equal(punchBoundsOf(null, 256), null)
  assert.equal(punchBoundsOf({ from: 8, to: 8 }, 256), null)
  // A sliver still gets the step it touches: the region always holds a hit.
  assert.deepEqual(punchBoundsOf({ from: 8.2, to: 8.6 }, 256), { from: 8, to: 9 })
})

test('the transport starts with a bar of context before the region', () => {
  // Parked at the top: one bar (16 steps) of lead, never negative.
  assert.equal(punchLeadStep(0, 64, 16), 0)
  // Already partway in: keep the playhead, do not jump backwards past it.
  assert.equal(punchLeadStep(40, 64, 16), 40)
  // Past the region: fall back to a bar before it so the pass still makes sense.
  assert.equal(punchLeadStep(200, 64, 16), 48)
  // A region at the very start cannot have a lead-in.
  assert.equal(punchLeadStep(0, 4, 16), 0)
})

test('nothing happens outside the region', () => {
  const bounds = punchBoundsOf({ from: 64, to: 96 }, 256)
  assert.equal(punchAction(bounds, 0, false), 'idle')
  assert.equal(punchAction(bounds, 63.5, false), 'idle')
  assert.equal(punchAction(bounds, 80, true), 'idle')
})

test('the window opens on entry and closes on exit', () => {
  const bounds = punchBoundsOf({ from: 64, to: 96 }, 256)
  assert.equal(punchAction(bounds, 64, false), 'open')
  assert.equal(punchAction(bounds, 95.9, false), 'open')
  assert.equal(punchAction(bounds, 96, true), 'close')
  assert.equal(punchAction(bounds, 200, true), 'close')
})

test('a region that ran out before the input opened is missed, not recorded', () => {
  const bounds = punchBoundsOf({ from: 64, to: 96 }, 256)
  assert.equal(punchAction(bounds, 96, false), 'missed')
  assert.equal(punchAction(null, 96, false), 'idle')
})

test('a punched take never starts before its region', () => {
  const bounds = punchBoundsOf({ from: 64, to: 96 }, 256)
  // The mic armed late: the clip starts where the audio really begins.
  assert.equal(punchStartStep(bounds, 66.3), 66.3)
  // The clock asked for earlier than the region: the region wins.
  assert.equal(punchStartStep(bounds, 61), 64)
  // Outside a punch pass the take simply starts where the capture opened.
  assert.equal(punchStartStep(null, 12.5), 12.5)
  assert.equal(punchStartStep(null, Number.NaN), 0)
})
