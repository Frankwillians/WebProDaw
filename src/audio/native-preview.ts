/**
 * The rule behind the native plugin preview: what a rendered pass depends on, and
 * which pass a lane actually plays.
 *
 * A native .dll or .vst3 answers to its own process, not to Web Audio. What a
 * host can put in the live graph is a bridge that carries batches of samples
 * across that boundary (see native-live.ts), and what it can put in a clip is a
 * rendered pass: the lane's clip goes through the plugin process and the result
 * becomes the lane's `monitor`, which is what the transport plays and what an
 * export writes, while the recorded file underneath stays exactly as it was.
 * These two helpers are the offline half of that contract — one says when a pass
 * has to be rendered again, the other says which audio the speakers and the WAV
 * get — and they are the parts that can be proven without a browser, a plugin,
 * or a sound card.
 */

/** The part of one plugin slot that a preview depends on. */
export interface PreviewSlot {
  /** Full path of the .dll or .vst3 on this machine. */
  path: string
  /** 0..1 values; `index` is a VST2 slot number or a VST3 parameter id. */
  params: { index: number; value: number }[]
  /** Switched off: the slot keeps its values but touches nothing. */
  bypass?: boolean
}

/** The part of a lane a preview depends on. */
export interface PreviewSource {
  kind: 'audio' | 'instrument'
  bufferId: string
  clipDuration: number
  /** The native plugin this lane runs, or null when the lane has none. */
  nativeVst2: PreviewSlot | null
}

/**
 * Everything a native plugin's preview depends on, in one string: the file, the
 * knobs as the panel holds them, the rate the plugin runs at, and the clip that
 * goes through it. A preview is only trusted while its key still matches the
 * lane, which is what keeps an old pass from playing under new settings — and
 * what tells the app that nothing has to be rendered at all when the key is the
 * same.
 *
 * An empty key means this lane has nothing to preview: no plugin, the plugin
 * bypassed, or no clip to put through it.
 */
export function nativePreviewKey(track: PreviewSource, sampleRate: number): string {
  if (track.kind !== 'audio' || !track.bufferId || track.clipDuration <= 0) return ''
  const slot = track.nativeVst2
  if (!slot || slot.bypass) return ''
  // A slot rebuilt from a saved project can list its parameters in another
  // order, and that must not cost a fresh render of a pass already in the lane.
  const params = slot.params
    .map((item) => `${item.index}:${item.value.toFixed(4)}`)
    .sort()
    .join(',')
  return `${slot.path}|${params}|${sampleRate}|${track.bufferId}`
}

/**
 * The pass a lane hands over: the plugin's rendered pass while the engine holds
 * one, and the recorded take underneath it. The live transport and the offline
 * export both ask this same question, which is what makes it impossible for a
 * plugin to be audible in the room and missing from the file — or the other way
 * round.
 */
export function takeToPlay<T>(track: {
  monitor: { buffer: T } | null
  buffer: T | null
}): T | null {
  return track.monitor?.buffer ?? track.buffer
}
