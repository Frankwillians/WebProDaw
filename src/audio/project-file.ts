/**
 * The `.opdaw` project file.
 *
 * localStorage autosave is a convenience for one browser on one machine; a file
 * is what lets the producer hand a session over, back it up, or open it on the
 * laptop at the studio. The audio travels inside it - a project JSON that opens
 * with silent clips is not the project - so every WAV the clips reference is
 * carried as base64 next to the metadata.
 *
 * Pure data in, data out: no engine, no DOM, so the round trip is testable with
 * `npm test`.
 *
 * The app used to be called WebDAW, and sessions saved back then say
 * `webdaw-project` inside them. Those files are read exactly as they are - a
 * rename of the product is not a reason to lose somebody's takes - but nothing
 * written from here on uses the old identity.
 */

export const PROJECT_FILE_KIND = 'opdaw-project'
/** Kinds accepted on read, from before the OpenDAW name. */
export const LEGACY_PROJECT_FILE_KINDS = ['webdaw-project'] as const
export const PROJECT_FILE_VERSION = 1
export const PROJECT_FILE_EXTENSION = 'opdaw'

export interface ProjectFileSample {
  /** The bufferId the tracks reference. */
  id: string
  /** 16-bit WAV, base64 without line breaks. */
  wav: string
}

export interface ProjectFile {
  kind: typeof PROJECT_FILE_KIND
  version: number
  savedAt: string
  /** The same shape localStorage keeps; the app owns validating it. */
  project: unknown
  samples: ProjectFileSample[]
}

export interface ParsedProjectFile {
  project: unknown
  samples: Array<{ id: string; bytes: Uint8Array<ArrayBuffer> }>
  /** The sample ids the tracks asked for that the file did not carry. */
  missing: string[]
}

const BASE64_CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Ids the project references, in track order, without duplicates. */
export function sampleIdsUsedBy(project: unknown): string[] {
  const tracks = (project as { tracks?: unknown })?.tracks
  if (!Array.isArray(tracks)) return []
  const ids: string[] = []
  const remember = (id: unknown) => {
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id)
  }
  for (const track of tracks) {
    const item = track as {
      bufferId?: unknown
      takes?: unknown
      plugins?: unknown
    }
    remember(item.bufferId)
    // An unused take still has to travel with the project, or the singer
    // opens the file and the good pass is gone.
    if (Array.isArray(item.takes)) {
      for (const take of item.takes) remember((take as { id?: unknown })?.id)
    }
    // NAM, IR and worklet sources are audio-adjacent assets: without their
    // bytes, the plugin metadata would reopen as an empty slot.
    if (Array.isArray(item.plugins)) {
      for (const plugin of item.plugins) {
        remember((plugin as { assetId?: unknown })?.assetId)
      }
    }
  }
  return ids
}

export async function buildProjectFile(
  project: unknown,
  samples: Array<{ id: string; blob: Blob }>,
): Promise<ProjectFile> {
  const wanted = new Set(sampleIdsUsedBy(project))
  const carried: ProjectFileSample[] = []
  for (const sample of samples) {
    if (!wanted.has(sample.id)) continue
    const bytes = new Uint8Array(await sample.blob.arrayBuffer())
    carried.push({ id: sample.id, wav: bytesToBase64(bytes) })
  }
  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    savedAt: new Date().toISOString(),
    project,
    samples: carried,
  }
}

export function projectFileToText(file: ProjectFile): string {
  return JSON.stringify(file)
}

export function parseProjectFile(text: string): ParsedProjectFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('não é um arquivo .opdaw válido')
  }
  const file = data as Partial<ProjectFile>
  const kind = file?.kind as string | undefined
  if (kind !== PROJECT_FILE_KIND && !LEGACY_PROJECT_FILE_KINDS.includes(kind as never)) {
    throw new Error('não é um arquivo .opdaw')
  }
  if (typeof file.version !== 'number' || file.version > PROJECT_FILE_VERSION) {
    throw new Error(`arquivo salvo por uma versão mais nova (v${file.version})`)
  }
  if (!file.project || typeof file.project !== 'object') {
    throw new Error('o arquivo não traz nenhum projeto')
  }
  const raw = Array.isArray(file.samples) ? file.samples : []
  const samples: Array<{ id: string; bytes: Uint8Array<ArrayBuffer> }> = []
  for (const entry of raw) {
    const id = (entry as ProjectFileSample)?.id
    const wav = (entry as ProjectFileSample)?.wav
    if (typeof id !== 'string' || !id || typeof wav !== 'string') continue
    try {
      samples.push({ id, bytes: base64ToBytes(wav) })
    } catch {
      /* one broken clip must not lose the whole session */
    }
  }
  const carried = new Set(samples.map((sample) => sample.id))
  return {
    project: file.project,
    samples,
    missing: sampleIdsUsedBy(file.project).filter((id) => !carried.has(id)),
  }
}

// --------------------------------------------------------------- chain presets

export const CHAIN_FILE_KIND = 'opdaw-chain'
/** Chain presets saved under the old name still load. */
export const LEGACY_CHAIN_FILE_KINDS = ['webdaw-chain'] as const
export const CHAIN_FILE_EXTENSION = 'opdawchain'

export interface ChainFile {
  kind: typeof CHAIN_FILE_KIND
  version: number
  savedAt: string
  name: string
  /** The FX rack (params, enable flags and mixes) as plain JSON. */
  rack: unknown
  /** Built-in unit ids in signal order. Plugins are never carried. */
  order: string[]
}

export interface ParsedChainFile {
  name: string
  rack: unknown
  order: string[]
}

export function buildChainFile(
  name: string,
  rack: unknown,
  order: string[],
): ChainFile {
  return {
    kind: CHAIN_FILE_KIND,
    version: 1,
    savedAt: new Date().toISOString(),
    name,
    rack,
    order: order.filter((entry) => typeof entry === 'string' && entry.startsWith('fx:')),
  }
}

export function parseChainFile(text: string): ParsedChainFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('não é um arquivo de cadeia válido')
  }
  const file = data as Partial<ChainFile>
  const chainKind = file?.kind as string | undefined
  if (chainKind !== CHAIN_FILE_KIND && !LEGACY_CHAIN_FILE_KINDS.includes(chainKind as never)) {
    throw new Error('não é um preset de cadeia')
  }
  if (!file.rack || typeof file.rack !== 'object') throw new Error('a cadeia não traz efeitos')
  const order = Array.isArray(file.order)
    ? file.order.filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('fx:'))
    : []
  return { name: typeof file.name === 'string' ? file.name : 'Cadeia importada', rack: file.rack, order }
}
