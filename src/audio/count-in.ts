/**
 * Count-in maths, kept apart from the transport so the beats can be tested
 * without an audio clock or a tab that paints.
 *
 * A count-in is one bar of clicks that ends exactly on the step the song
 * restarts on — the downbeat the producer pressed play or record aiming at. The
 * scheduler walks a step counter toward it, so everything that decision needs is
 * arithmetic: does this step get a click, is it the accented one, and what
 * number should be big enough to read across the room.
 *
 * The bar is held to the downbeat rather than to step zero. A count that aims at
 * bar 3 has to count four beats just like one that aims at the top of the
 * arrangement, and it has to keep the song's own instruments out of the pre-roll
 * while it does.
 */

export const STEPS_PER_BEAT = 4
export const STEPS_PER_BAR = STEPS_PER_BEAT * 4

/** The step a count-in bar holds before the song starts: one bar, no more. */
export function countInStart(downbeat: number, stepsPerBar = STEPS_PER_BAR): number {
  return Math.floor(downbeat) - Math.max(1, Math.floor(stepsPerBar))
}

/**
 * Is this scheduler step still inside the count-in bar? The bar is the run of
 * steps that ends at the downbeat, so the answer holds for negative steps (a
 * count aimed at the top) and for steps in the middle of the arrangement alike.
 */
export function isCountingIn(
  step: number,
  downbeat: number | null,
  stepsPerBar = STEPS_PER_BAR,
): boolean {
  if (downbeat === null) return false
  return step >= countInStart(downbeat, stepsPerBar) && step < downbeat
}

/**
 * Which click, if any, this step of the count-in plays: 'accent' on the first
 * beat of the bar and 'beat' on the rest, so the producer hears where the bar
 * begins. Steps between beats stay silent — a count is four ticks, not sixteen.
 */
export function countInClick(
  step: number,
  downbeat: number,
  stepsPerBeat = STEPS_PER_BEAT,
): 'accent' | 'beat' | null {
  const until = downbeat - step
  if (until <= 0) return null
  const beat = Math.max(1, Math.floor(stepsPerBeat))
  if (until % beat !== 0) return null
  return until === beat * 4 ? 'accent' : 'beat'
}

/**
 * The number to show: whole beats still to wait, clamped to the four a bar
 * holds. A fraction of a beat left still reads 1 — the last tick of the count is
 * the one a singer is waiting for, and showing 0 would read as "missed it".
 */
export function countInBeat(
  stepsRemaining: number,
  stepsPerBeat = STEPS_PER_BEAT,
): number {
  if (!Number.isFinite(stepsRemaining) || stepsRemaining <= 0) return 0
  const beat = Math.max(1, Math.floor(stepsPerBeat))
  return Math.max(1, Math.min(4, Math.ceil(stepsRemaining / beat)))
}
