import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  countInBeat,
  countInClick,
  countInStart,
  isCountingIn,
} from './count-in.ts'

// The bar belongs to the downbeat it lands on, not to step zero.
test('a count-in bar is the sixteen steps before the downbeat', () => {
  assert.equal(countInStart(0), -16)
  assert.equal(countInStart(64), 48)
  assert.ok(isCountingIn(-16, 0))
  assert.ok(isCountingIn(-1, 0))
  assert.ok(!isCountingIn(0, 0), 'the downbeat itself is the song, not the count')
  assert.ok(!isCountingIn(-17, 0))
})

test('a count aimed at mid-arrangement still covers a whole bar', () => {
  assert.ok(isCountingIn(24, 40))
  assert.ok(isCountingIn(39, 40))
  assert.ok(!isCountingIn(23, 40))
  assert.ok(!isCountingIn(40, 40))
})

test('no pending downbeat means no count-in', () => {
  assert.ok(!isCountingIn(-4, null))
  assert.ok(!isCountingIn(0, null))
})

// Four ticks, the first one louder, whatever the bar is aiming at.
test('the count plays four clicks with the accent on the first', () => {
  const downbeat = 0
  const clicks: [number, string | null][] = []
  for (let step = -16; step <= 0; step += 1) clicks.push([step, countInClick(step, downbeat)])
  assert.deepEqual(
    clicks.filter(([, kind]) => kind !== null),
    [
      [-16, 'accent'],
      [-12, 'beat'],
      [-8, 'beat'],
      [-4, 'beat'],
    ],
  )
})

test('a count starting at bar 3 gets the same four clicks', () => {
  const kinds: (string | null)[] = []
  for (let step = 24; step < 40; step += 1) kinds.push(countInClick(step, 40))
  assert.equal(kinds.filter((kind) => kind === 'accent').length, 1)
  assert.equal(kinds.filter((kind) => kind === 'beat').length, 3)
  assert.equal(kinds[0], 'accent', 'the bar opens on the accented beat')
  assert.equal(kinds[15], null, 'the step before the downbeat is silent')
})

test('a click only ever lands on a beat', () => {
  assert.equal(countInClick(-1, 0), null)
  assert.equal(countInClick(-2, 0), null)
  assert.equal(countInClick(-3, 0), null)
  assert.equal(countInClick(-5, 0), null)
  assert.equal(countInClick(0, 0), null, 'the song downbeat is not part of the count')
  assert.equal(countInClick(4, 0), null, 'steps past the downbeat are the song')
})

// The number is what a producer with headphones reads across the room.
test('the beat number counts four three two one down to the downbeat', () => {
  assert.equal(countInBeat(16), 4)
  assert.equal(countInBeat(13), 4)
  assert.equal(countInBeat(12), 3)
  assert.equal(countInBeat(8), 2)
  assert.equal(countInBeat(4), 1)
  assert.equal(countInBeat(0.25), 1, 'a fraction of a beat still reads one, not zero')
})

test('the beat number never invents beats or shows an empty screen', () => {
  assert.equal(countInBeat(0), 0, 'not counting: nothing to show')
  assert.equal(countInBeat(-3), 0)
  assert.equal(countInBeat(Number.NaN), 0)
  assert.equal(countInBeat(64), 4, 'a long pre-roll caps at one bar of beats')
})
