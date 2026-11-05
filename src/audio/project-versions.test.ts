/**
 * Tests for the autosave version store - run with `npm test`.
 *
 * The point of these is that a producer can go back: the list has to stay
 * newest-first, refuse to waste slots on the same project twice, and shrink
 * instead of throwing when localStorage runs out of room.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_VERSIONS,
  addVersion,
  describeAge,
  findVersion,
  formatClock,
  parseVersions,
  removeVersion,
  shouldRecord,
  trimToFit,
} from './project-versions.ts'
import type { StoredVersion } from './project-versions.ts'

const MINUTE = 60_000

function version(id: string, savedAt: number, json = `{"n":${id}}`): StoredVersion {
  return { id, savedAt, json, label: 'autosave' }
}

test('a broken or absent store reads as no versions', () => {
  assert.deepEqual(parseVersions(null), [])
  assert.deepEqual(parseVersions('not json'), [])
  assert.deepEqual(parseVersions('{"id":1}'), [])
  assert.deepEqual(parseVersions('[null, 3, {"id":"a"}]'), [])
})

test('stored versions come back newest first and capped', () => {
  const raw = JSON.stringify([
    version('old', 1000),
    version('new', 5000),
    version('mid', 3000),
  ])
  const list = parseVersions(raw)
  assert.deepEqual(list.map((entry) => entry.id), ['new', 'mid', 'old'])
  assert.deepEqual(parseVersions(raw, 2).map((entry) => entry.id), ['new', 'mid'])
})

test('the first write always records, a repeated one never does', () => {
  const first = version('a', 0)
  assert.equal(shouldRecord(undefined, '{"n":1}', 0), true)
  assert.equal(shouldRecord(first, first.json, 10 * MINUTE), false)
})

test('edits are folded together, real work gets its own slot', () => {
  const last = version('a', 0)
  // Typing along five seconds later is the same moment: no new snapshot.
  assert.equal(shouldRecord(last, '{"n":2}', 5_000), false)
  // A minute on with a different project is a different state of the session.
  assert.equal(shouldRecord(last, '{"n":2}', MINUTE), true)
})

test('adding keeps one entry per project, ordered and inside the budget', () => {
  const start = [version('b', 2 * MINUTE), version('c', 3 * MINUTE)]
  const added = addVersion(start, version('a', 5 * MINUTE))
  assert.deepEqual(added.map((entry) => entry.id), ['a', 'c', 'b'])
  // The same project, re-added: no duplicate, no new slot.
  const again = addVersion(added, version('d', 6 * MINUTE, added[0].json))
  assert.equal(again.length, added.length)
  assert.equal(again[0].id, 'd')
})

test('the list never grows past MAX_VERSIONS', () => {
  let list: StoredVersion[] = []
  for (let i = 0; i < MAX_VERSIONS + 6; i += 1) {
    list = addVersion(list, version(`v${i}`, i * MINUTE, `{"n":${i}}`))
  }
  assert.equal(list.length, MAX_VERSIONS)
  assert.equal(list[0].id, `v${MAX_VERSIONS + 5}`)
  assert.deepEqual(
    list.map((entry) => entry.savedAt),
    [...list].sort((a, b) => b.savedAt - a.savedAt).map((entry) => entry.savedAt),
  )
})

test('rewriting an id replaces that snapshot instead of doubling it', () => {
  const list = addVersion([version('a', MINUTE)], version('a', 2 * MINUTE, '{"renamed":true}'))
  assert.equal(list.length, 1)
  assert.equal(list[0].json, '{"renamed":true}')
})

test('find and remove work on the id the menu shows', () => {
  const list = [version('a', MINUTE), version('b', 2 * MINUTE)]
  assert.equal(findVersion(list, 'a')?.savedAt, MINUTE)
  assert.equal(findVersion(list, 'missing'), null)
  assert.deepEqual(removeVersion(list, 'a').map((entry) => entry.id), ['b'])
})

test('a full localStorage trims the oldest instead of throwing', () => {
  // Newest first, as the store keeps them: the tail is the oldest work.
  const list = [
    version('new', 5 * MINUTE, 'y'.repeat(100)),
    version('mid', 4 * MINUTE, 'x'.repeat(1000)),
    version('old', 3 * MINUTE, 'z'.repeat(100)),
  ]
  // Room for the newest snapshot plus the mid one, so only 'old' is dropped.
  const some = trimToFit(list, 1300)
  assert.deepEqual(some.kept.map((entry) => entry.id), ['new', 'mid'])
  assert.equal(some.fits, true)
  // Room for one: the two oldest go, the newest stays.
  const one = trimToFit(list, 300)
  assert.deepEqual(one.kept.map((entry) => entry.id), ['new'])
  assert.equal(one.fits, true)
  // Not even the newest one fits: say so, and the current project still saves.
  const none = trimToFit(list, 10)
  assert.deepEqual(none.kept, [])
  assert.equal(none.fits, false)
})

test('ages read the way a person says them', () => {
  const now = 100 * MINUTE
  assert.equal(describeAge(now - 10_000, now), 'agora')
  assert.equal(describeAge(now - 40_000, now), 'agora')
  assert.equal(describeAge(now - 4 * MINUTE, now), 'há 4 min')
  assert.equal(describeAge(now - 3 * 60 * MINUTE, now), 'há 3 h')
  assert.equal(describeAge(now - 25 * 60 * MINUTE, now), 'ontem')
  assert.equal(describeAge(now - 72 * 60 * MINUTE, now), 'há 3 dias')
  assert.equal(describeAge(now - 31 * 24 * 60 * MINUTE, now), 'há 1 mês')
  // A timestamp in the future (clock change) is "agora", never "-5 min".
  assert.equal(describeAge(now + 60 * MINUTE, now), 'agora')
})

test('the clock is local and fixed-width', () => {
  assert.equal(formatClock(new Date(2026, 10, 4, 9, 5).getTime()), '09:05')
  assert.equal(formatClock(new Date(2026, 10, 4, 23, 59).getTime()), '23:59')
})
