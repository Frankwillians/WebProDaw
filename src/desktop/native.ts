/**
 * The renderer's view of the desktop executable.
 *
 * Everything here is optional: in the browser `window.OpenDAW` is undefined and
 * the DAW behaves exactly as it always has. In the executable the same calls go
 * through the operating system instead — real save and open dialogs, and the
 * native plugin process that hosts VST files.
 */

import type { LiveBlockReply, LiveOpenReply, LiveOpenRequest } from '../audio/native-live'

export interface NativeInfo {
  native: true
  platform: string
  version: string
  electron: string
  chrome: string
  node: string
  documents: string
  dist: string
  servedFrom: string | null
}

export interface NativeSaveResult {
  canceled: boolean
  path?: string
  error?: string
}

export interface NativeOpenResult {
  canceled: boolean
  path?: string
  name?: string
  text?: string | null
  data?: Uint8Array
  error?: string
}

export interface NativeParameter {
  index: number
  name: string
  label: string
  display: string
  value: number
}

export interface NativePluginInfo {
  /** 'vst2' or 'vst3' — which engine opened the file. */
  kind: string
  path: string
  file: string
  name: string
  vendor: string
  product: string
  pluginVersion: number
  vstVersion: number
  uniqueId: number
  numParams: number
  numPrograms: number
  numInputs: number
  numOutputs: number
  program: number
  programName: string
  initialDelay: number
  tail: number
  hasEditor: boolean
  canReplace: boolean
  wantsChunks: boolean
  isSynth: boolean
  /** VST3 only: the parameter flagged kIsBypass, so the panel can bypass inside the plugin. */
  bypassId?: number | null
  /** VST3 only: how the two halves of the plugin answered the host. */
  connection?: string
  /** VST3 only: the audio busses the plugin declares. */
  buses?: { direction: string; name: string; channels: number; type: number }[]
  params: NativeParameter[]
  hostCalls: string[]
  canDo: string[]
}

/** What the disk scan found. `error` is set for anything that cannot be used. */
export interface NativePluginEntry {
  path: string
  /** The name the producer reads: the bundle's own description, or the file name. */
  label?: string
  binary?: string
  kind: 'vst2' | 'vst3' | 'estranho'
  entry?: string
  arch?: string
  exports?: number
  error?: string
  meta?: {
    module?: string
    vendor?: string
    info?: Record<string, unknown>
    classes?: { name: string; vendor?: string; category: string; subCategories: string[] }[]
  } | null
}

/** One folder the scan walked, and what it gave up. */
export interface NativeScannedDir {
  path: string
  exists: boolean
  /** Plugin-shaped files found under it — bundles and DLLs, before any loading. */
  files: number
}

/** Answer to a scan: the files plus the folders that were actually walked. */
export interface NativeScanResult {
  ok: boolean
  plugins?: NativePluginEntry[]
  dirs?: NativeScannedDir[]
  error?: string
}

/** Answer to the "add a folder" dialog. */
export interface NativeAddDirResult {
  ok?: boolean
  canceled?: boolean
  added?: string
  dirs?: string[]
  error?: string
}

export interface NativeRenderResult {
  ok: boolean
  error?: string
  info?: NativePluginInfo
  /** What the plugin sent back on the way out: its meters, and knobs it moved itself. */
  reported?: { id: number; value: number; name: string }[]
  outputWav?: Uint8Array
  peak?: number
  nonSilent?: number
  total?: number
  bad?: number
}

/** Answer to a plugin-interface call. */
export interface NativeGuiResult {
  ok: boolean
  error?: string
  /**
   * The process answering has never opened this plugin — after a fault, the
   * fresh child knows nothing, and an open window on the old one is gone with it.
   * Different from `state.open === false`: that is the plugin closing its own GUI.
   */
  noEditor?: boolean
  /** 'vst2' or 'vst3', from the engine that owns the window. */
  kind?: string
  /**
   * Whether the plugin's window is on the screen. A minimised panel puts the
   * interface away without closing the plugin, so the panel needs to know which
   * of the two happened rather than reading "still open" off both.
   */
  visible?: boolean
  state?: {
    open: boolean
    kind?: string
    /** Native window handle, as a number: valid across processes. */
    hwnd?: number
    clientWidth?: number
    clientHeight?: number
    x?: number
    y?: number
    /** The plugin asked for this size itself (audioMasterSizeWindow / resizeView). */
    pluginAskedForSize?: boolean
    childrenFitted?: number
    openCode?: number
    attachCode?: number
    platformType?: string
  }
  /** Values the plugin holds right now, for a panel that mirrors its GUI. */
  reported?: { id: number; value: number; name: string }[]
  info?: NativePluginInfo
}

export type NativeMenuAction =
  | 'new-project'
  | 'open-project'
  | 'save-project'
  | 'import-audio'
  | 'export-mix'
  | 'undo'
  | 'redo'
  | 'refresh-inputs'
  | 'midi-devices'
  | 'scan-plugins'
  | 'plugin-panel'

/** One row of a menu, exactly as the page draws it. */
export interface NativeMenuItem {
  label: string
  disabled?: boolean
  separator?: boolean
}

export interface NativeMenuGroup {
  label: string
  items: NativeMenuItem[]
}

/**
 * What the OS menu bar reports when the producer picks something: either one of
 * the items the executable adds to itself, or the position of a mirrored row.
 */
export type NativeMenuClick = { action: NativeMenuAction } | { menu: number; item: number }

interface OpenDAWApi {
  native: true
  platform: string
  versions: { electron: string; chrome: string; node: string }
  info: () => Promise<NativeInfo>
  saveFile: (options: {
    kind: 'project' | 'chain' | 'audio' | 'image' | 'any'
    defaultName: string
    data: ArrayBuffer | Uint8Array
  }) => Promise<NativeSaveResult>
  openFile: (options: {
    kind: 'project' | 'chain' | 'audio' | 'any'
  }) => Promise<NativeOpenResult>
  plugins: {
    scan: (dirs?: string[]) => Promise<NativeScanResult>
    /**
     * Choose one more folder to scan, with the operating system's own picker.
     * Optional because a browser has no folder to point at; the answer is kept by
     * the native side, so a folder added once is looked in forever after.
     */
    addDir?: () => Promise<NativeAddDirResult>
    describe: (path: string, sampleRate?: number) => Promise<{ ok: boolean; info?: NativePluginInfo; error?: string }>
    render: (request: {
      path: string
      params?: { index: number; value: number }[]
      sampleRate?: number
      seconds?: number
      inputWav?: ArrayBuffer | Uint8Array
    }) => Promise<NativeRenderResult>
    /**
     * Hand the panel's values to the plugin itself. Optional because a browser
     * has no plugin process to talk to, and because a plugin that exposes no
     * parameters simply has nothing to send.
     */
    setParams?: (request: {
      path: string
      params: { index: number; value: number }[]
      sampleRate?: number
    }) => Promise<NativeGuiResult>
    /**
     * The plugin's own interface, as a native window. `rect` is the FX panel's
     * box in CSS pixels of this viewport; the native side converts it to the
     * screen and puts the plugin's drawing area there.
     */
    guiOpen?: (request: {
      path: string
      sampleRate?: number
      rect?: { x: number; y: number; width: number; height: number }
    }) => Promise<NativeGuiResult>
    guiPlace?: (request: {
      path: string
      rect?: { x: number; y: number; width: number; height: number }
    }) => Promise<NativeGuiResult>
    guiState?: (request: { path: string }) => Promise<NativeGuiResult>
    /**
     * Show or hide the plugin's window without closing the plugin. The FX panel
     * can be minimised, and an interface left on the desktop with no pane under
     * it is a window the producer did not ask to keep.
     */
    guiShow?: (request: { path: string; visible?: boolean }) => Promise<NativeGuiResult>
    guiClose?: (request: { path: string }) => Promise<NativeGuiResult>
    /**
     * The live session: the plugin is opened at a real-time block size, fed one
     * batch of samples at a time, and closed when the lane stops listening. These
     * are optional for the same reason the rest of this object is — a browser has
     * no plugin process — and a lane without them simply hears the dry input.
     */
    liveOpen?: (request: LiveOpenRequest) => Promise<LiveOpenReply>
    liveBlock?: (request: {
      path: string
      left: Float32Array
      right: Float32Array
    }) => Promise<LiveBlockReply>
    liveParams?: (request: {
      path: string
      params: { index: number; value: number }[]
    }) => Promise<{ ok: boolean; error?: string }>
    liveClose?: (request: { path: string }) => Promise<{ ok: boolean; blocks?: number; error?: string }>
  }
  onMenu: (handler: (click: NativeMenuClick) => void) => () => void
  /** Hand the page's own menu structure over, so the OS bar can mirror it. */
  setMenu?: (groups: NativeMenuGroup[]) => void
}

declare global {
  interface Window {
    OpenDAW?: OpenDAWApi
  }
}

export function nativeApi(): OpenDAWApi | null {
  return typeof window !== 'undefined' && window.OpenDAW?.native ? window.OpenDAW : null
}

export function isNativeApp(): boolean {
  return nativeApi() !== null
}

/** The app's own toast, so a native dialog can report where the file went. */
let toastHandler: ((message: string) => void) | null = null

export function setNativeToastHandler(handler: ((message: string) => void) | null): void {
  toastHandler = handler
}

/** Say something through the app's own toast, for callers outside the component. */
export function nativeNotify(message: string): void {
  toastHandler?.(message)
}

function kindForFile(filename: string): 'project' | 'chain' | 'audio' | 'image' | 'any' {
  if (/\.opdaw(chain)?$/i.test(filename)) return filename.endsWith('chain') ? 'chain' : 'project'
  if (/\.wav$/i.test(filename)) return 'audio'
  if (/\.png$/i.test(filename)) return 'image'
  return 'any'
}

/**
 * Write through the OS dialog. Resolves with the chosen path, or null when the
 * producer cancels. The browser path (an <a download> click) is kept in
 * `downloadBlob` for the web version.
 */
export async function nativeSaveBlob(blob: Blob, filename: string): Promise<string | null> {
  const api = nativeApi()
  if (!api) return null
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const result = await api.saveFile({ kind: kindForFile(filename), defaultName: filename, data: bytes })
  if (result.error) throw new Error(result.error)
  if (result.canceled || !result.path) return null
  toastHandler?.(`Salvo em ${result.path}`)
  return result.path
}

/** Ask the OS for a file and hand back its text (projects and chain presets). */
export async function nativeOpenText(kind: 'project' | 'chain'): Promise<string | null> {
  const api = nativeApi()
  if (!api) return null
  const result = await api.openFile({ kind })
  if (result.canceled) return null
  if (typeof result.text !== 'string') throw new Error('o arquivo não veio como texto')
  return result.text
}

/** Ask the OS for an audio file and hand back the bytes for decodeAudioData. */
export async function nativeOpenAudio(): Promise<{ bytes: Uint8Array; name: string } | null> {
  const api = nativeApi()
  if (!api) return null
  const result = await api.openFile({ kind: 'audio' })
  if (result.canceled) return null
  if (!result.data) throw new Error('o arquivo de áudio veio vazio')
  return { bytes: result.data, name: result.name ?? 'audio.wav' }
}

export function onNativeMenu(handler: (click: NativeMenuClick) => void): () => void {
  return nativeApi()?.onMenu(handler) ?? (() => {})
}

const menuText = (node: Element | null): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim()

/**
 * Read the menu bar the page just drew.
 *
 * The executable and the browser must not drift apart, so the native bar is not
 * a second list of commands somebody has to remember to update: it is the page's
 * own DOM, serialized. Labels that change with state ("Desfazer (3)", "Snap
 * (on)") and rows that are disabled come along for free.
 */
export function serializeMenuBar(nav: HTMLElement): NativeMenuGroup[] {
  return Array.from(nav.querySelectorAll<HTMLElement>('.menu-item')).map((item) => ({
    label: menuText(item.querySelector(':scope > span')) || '—',
    items: Array.from(item.querySelectorAll(':scope > .dropdown > *')).map((node) => {
      const button = node as HTMLButtonElement
      const isButton = node.tagName === 'BUTTON'
      return isButton
        ? { label: menuText(node), disabled: button.disabled === true }
        : { label: menuText(node) || '', separator: true }
    }),
  }))
}

/** Press the page's own button that the mirrored row belongs to. */
export function clickNativeMenuItem(nav: HTMLElement, menu: number, item: number): boolean {
  const group = nav.querySelectorAll<HTMLElement>('.menu-item')[menu]
  const node = group?.querySelectorAll(':scope > .dropdown > *')[item] as
    | HTMLButtonElement
    | undefined
  if (!node || node.tagName !== 'BUTTON' || node.disabled) return false
  node.click()
  return true
}

/**
 * Keep the OS menu bar in step with the page's menu bar.
 *
 * React rewrites the labels as the project changes, so a MutationObserver on the
 * nav re-sends the structure (debounced: one project edit touches many nodes).
 * Returns the stop function.
 */
export function mirrorMenuBar(nav: HTMLElement): () => void {
  const api = nativeApi()
  if (!api?.setMenu) return () => {}
  let timer: number | null = null
  const publish = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      try {
        api.setMenu?.(serializeMenuBar(nav))
      } catch {
        // A menu that failed to sync stays as it was; the page still works.
      }
    }, 120)
  }
  const observer = new MutationObserver(publish)
  observer.observe(nav, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'class'],
  })
  publish()
  return () => {
    observer.disconnect()
    if (timer !== null) window.clearTimeout(timer)
  }
}

export const pluginApi = () => nativeApi()?.plugins ?? null
