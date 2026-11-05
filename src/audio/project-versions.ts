/**
 * Autosave versions: the last few states the project was in, so a bad morning
 * is recoverable.
 *
 * The live autosave overwrites one key on every edit, which is right for a
 * session but means "I recorded over the good take and only noticed ten minutes
 * later" has no way back. These helpers keep a short rolling history of whole
 * projects, newest first, and give the menu something honest to show.
 *
 * Pure on purpose: `node --test` checks the ordering, the de-duplication and the
 * quota trimming without a browser, and the App decides when to write.
 */

export interface StoredVersion {
  id: string
  /** When it was written, as a ms epoch. */
  savedAt: number
  /** What wrote it: the autosave, or the producer naming a moment. */
  label: string
  /** The project exactly as it was saved. */
  json: string
}

/** How many snapshots are kept. Eight is a morning of work, and stays small. */
export const MAX_VERSIONS = 8

/** Snapshots older than this are not worth a slot: the project was the same. */
const MIN_SPACING_MS = 60_000

function isVersion(value: unknown): value is StoredVersion {
  const entry = value as StoredVersion | null
  return Boolean(
    entry &&
      typeof entry.id === 'string' &&
      entry.id !== '' &&
      typeof entry.savedAt === 'number' &&
      Number.isFinite(entry.savedAt) &&
      typeof entry.json === 'string' &&
      entry.json !== '',
  )
}

/** Read a stored list back: anything malformed is dropped, newest comes first. */
export function parseVersions(raw: string | null, limit = MAX_VERSIONS): StoredVersion[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return sortVersions(parsed.filter(isVersion)).slice(0, Math.max(0, limit))
}

function sortVersions(list: StoredVersion[]): StoredVersion[] {
  return [...list].sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Decide whether an autosave deserves its own snapshot.
 *
 * Two consecutive writes of the same project are one moment, and a write every
 * keystroke would push real work out of the eight slots within minutes.
 */
export function shouldRecord(newest: StoredVersion | undefined, json: string, now: number): boolean {
  if (!newest) return true
  if (newest.json === json) return false
  return now - newest.savedAt >= MIN_SPACING_MS
}

/**
 * Add a snapshot and keep the list inside its budget.
 *
 * Identical projects are not stored twice; the list stays newest-first, capped
 * at `limit`, and never holds two entries with the same id.
 */
export function addVersion(
  list: StoredVersion[],
  version: StoredVersion,
  limit = MAX_VERSIONS,
): StoredVersion[] {
  const withoutDuplicate = list.filter(
    (entry) => entry.id !== version.id && entry.json !== version.json,
  )
  return sortVersions([version, ...withoutDuplicate]).slice(0, Math.max(1, limit))
}

/** Drop one snapshot (the menu's "esquecer esta versão"). */
export function removeVersion(list: StoredVersion[], id: string): StoredVersion[] {
  return list.filter((entry) => entry.id !== id)
}

export function findVersion(list: StoredVersion[], id: string): StoredVersion | null {
  return list.find((entry) => entry.id === id) ?? null
}

/**
 * Remove the oldest snapshots until the payload fits `budget` characters, and
 * say whether there is anything left to write. localStorage throws when it is
 * full, which is not a reason to lose the current project.
 */
export function trimToFit(
  list: StoredVersion[],
  budget: number,
): { kept: StoredVersion[]; fits: boolean } {
  // The list itself is JSON, so each entry costs its payload plus a few
  // characters of punctuation and metadata.
  const overhead = 96
  let kept = list.slice()
  while (kept.length > 0) {
    const size = kept.reduce((total, entry) => total + entry.json.length + overhead, 0)
    if (size <= budget) return { kept, fits: true }
    kept = kept.slice(0, -1)
  }
  return { kept, fits: false }
}

/**
 * How long ago, in the words a producer reads: "agora", "há 4 min", "há 2 h",
 * "ontem", "há 3 dias". Kept explicit rather than through Intl so the menu and
 * the tests say the same thing on every machine.
 */
export function describeAge(savedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000))
  if (seconds < 45) return 'agora'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  const days = Math.round(hours / 24)
  if (days === 1) return 'ontem'
  if (days < 30) return `há ${days} dias`
  const months = Math.round(days / 30)
  return months <= 1 ? 'há 1 mês' : `há ${months} meses`
}

/** A clock for the menu: local time, so a snapshot matches the session. */
export function formatClock(savedAt: number): string {
  const date = new Date(savedAt)
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${hour}:${minute}`
}
