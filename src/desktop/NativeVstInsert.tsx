/**
 * The native plugin slot of one track.
 *
 * A Windows .dll or .vst3 answers to the native engine, not to Web Audio, so
 * this slot says which of the two paths the plugin is on rather than pretending.
 * A .dll is also bridged into the live lane (see native-live.ts): with the
 * monitor lit, the input crosses to the plugin's process a batch at a time and
 * comes back for the headphones. The clip path is the other one: the lane's
 * audio is worked on in the plugin's own process and the result is what the lane
 * plays and what the export writes — a preview pass held in the engine, so the
 * recorded file, its waveform, its trim and its undo stay exactly as they were.
 * Committing the pass for good is the bounce: the processed audio becomes the
 * clip and the dry take goes to the shelf. That is honest work, and it is the
 * same thing a hardware re-amp does.
 *
 * Both plugin generations are listed here. A VST2 is a .dll; a VST3 is a folder
 * whose real name is written inside it, so the picker reads that first and the
 * engine's own description corrects it as soon as the slot is opened.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { pluginApi, type NativeParameter, type NativePluginEntry } from './native'

export interface NativeVstSlot {
  /** Full path of the .dll or of the .vst3 bundle on this machine. */
  path: string
  /** Name read from the plugin, for the clip label and the header. */
  name: string
  /** 0..1 values. `index` is a VST2 slot number or a VST3 parameter id. */
  params: { index: number; value: number }[]
  /** Switched off: the slot stays with its values but does not touch the clip. */
  bypass?: boolean
}

/**
 * What the app reports about one lane's preview — the pass the plugin process
 * rendered from the clip, which is what plays and what the export writes while it
 * stands in the lane. `error` is the plugin's own answer, kept so the producer
 * can read it and try again instead of wondering why the lane is dry.
 */
export interface NativePreviewStatus {
  state: 'busy' | 'on' | 'error'
  name: string
  peak: number
  error: string
}

interface Props {
  trackName: string
  slot: NativeVstSlot | null
  /** The project rate: a plugin is asked to describe itself at the rate it will run at. */
  sampleRate: number
  /** Whether the lane has a clip at all — without one there is nothing to process. */
  hasClip: boolean
  busy: boolean
  /** The lane's preview, or null when the lane has nothing to preview. */
  preview: NativePreviewStatus | null
  onChange: (next: NativeVstSlot | null) => void
  onBounce: () => void
  /** Ask for the pass again, after the plugin refused or faulted. */
  onPreviewRetry: () => void
  /**
   * What the lane's live session is doing, or null when the plugin is not in the
   * live signal at all — no clip lane, the monitor off, a bypassed slot, or a
   * .vst3, which this host has no session for yet.
   */
  liveState?: {
    name: string
    latencyMs: number
    batches: number
    answered: number
    underruns: number
    error: string
  } | null
}

const isUsable = (entry: NativePluginEntry): boolean =>
  !entry.error && (entry.kind === 'vst2' || entry.kind === 'vst3')

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** One empty list for every render that has no plugin open. */
const NO_PARAMS: NativeParameter[] = []

/** The stage box, closed: no plugin window is up and nothing went wrong. */
const GUI_CLOSED = { phase: 'closed', error: '', width: 0, height: 0 } as const

/**
 * What the strip says when the process that owned the window is gone: the plugin
 * took itself down, the window went with it, and the app is still running. A
 * producer needs to know which of the two died.
 */
const LOST_WINDOW =
  'o processo do plugin caiu e a janela dele foi junto — os plugins foram recarregados e o projeto está intacto'

/**
 * Where the plugin's own window lives. `pending` is the frame between the press
 * and the answer — opening a GUI is the plugin's heaviest call, and a producer
 * needs to see the app is working on it, not that it froze.
 */
type GuiState = { phase: 'closed' | 'pending' | 'open'; error: string; width: number; height: number }

/** The name a producer recognises, not the file name and not the export symbol. */
function entryName(entry: NativePluginEntry): string {
  // The scan already resolved the name the way a host would — the bundle's own
  // description, its first class, or the file — so that answer comes first and
  // this only fills the gap for a list built before the naming existed.
  if (entry.label) return entry.label.slice(0, 48)
  const klass =
    entry.meta?.classes?.find((item) => /^Audio/i.test(item.category ?? '')) ?? entry.meta?.classes?.[0]
  const fromMeta = String(klass?.name ?? entry.meta?.module ?? '').trim()
  if (fromMeta) return fromMeta.slice(0, 48)
  return fileName(entry.path).replace(/\.(vst3|dll|vst)$/i, '').slice(0, 48)
}

function entryVendor(entry: NativePluginEntry): string {
  const info = entry.meta?.info as { vendor?: string } | undefined
  return String(entry.meta?.vendor ?? info?.vendor ?? '').trim().slice(0, 24)
}

export default function NativeVstInsert({
  trackName,
  slot,
  sampleRate,
  hasClip,
  busy,
  preview,
  onChange,
  onBounce,
  onPreviewRetry,
  liveState = null,
}: Props): React.JSX.Element {
  // Pinned once: the bridge object is stable, but reading it every render would
  // put a new value in the effect's dependency list and restart the disk scan.
  const [api] = useState(() => pluginApi())
  const [entries, setEntries] = useState<NativePluginEntry[] | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /**
   * The engine's answer, kept with the path it belongs to. Reading it back means
   * one state update when the description arrives — no reset in the effect body,
   * and a stale answer about a plugin that is no longer in the slot simply does
   * not match `slot.path` and is ignored.
   */
  const [described, setDescribed] = useState<{
    path: string
    /** The plugin's own name, or '' when it did not answer at all. */
    name: string
    params: NativeParameter[]
    /** Whether the engine saw an editor to open (effFlagsHasEditor / IEditController). */
    hasEditor: boolean
    kind: string
  } | null>(null)
  // Which plugin the current correction belongs to: the rename below re-runs the
  // describe effect through `slot`, so the fix is applied once per path.
  const namedFor = useRef('')

  useEffect(() => {
    if (!api) return
    let live = true
    void api
      .scan()
      .then((result) => {
        if (!live) return
        if (!result.ok) setScanError(result.error ?? 'a varridura falhou')
        else setEntries((result.plugins ?? []).filter(isUsable))
      })
      .catch((error: Error) => {
        if (live) setScanError(error.message)
      })
    return () => {
      live = false
    }
  }, [api])

  const path = slot?.path ?? ''

  // The parameter names come from the plugin itself, so opening the slot means
  // asking it — at the project's rate, because a plugin fixes its block size and
  // its latency when it is configured and would report something else cold. The
  // dependency is the path, not the slot object: moving a knob rewrites the slot
  // and must not make the engine load the plugin all over again.
  useEffect(() => {
    if (!api || !path) return
    let live = true
    void api
      .describe(path, sampleRate)
      .then((result) => {
        if (!live) return
        const name = String(result.info?.name ?? '').trim().slice(0, 48)
        setDescribed({
          path,
          name: result.ok ? name : '',
          params: result.info?.params ?? [],
          hasEditor: result.info?.hasEditor === true,
          kind: String(result.info?.kind ?? ''),
        })
      })
      .catch(() => {
        if (live) setDescribed({ path, name: '', params: [], hasEditor: false, kind: '' })
      })
    return () => {
      live = false
    }
  }, [api, path, sampleRate])

  const answer = described?.path === path ? described : null
  // The shared empty list, so `params` keeps one identity while nothing is open
  // and the memo below does not re-run on every render.
  const params = answer ? answer.params : NO_PARAMS

  // The name in the dropdown is a guess from the bundle; the engine's answer is
  // the truth, and it is what the clip label should carry.
  useEffect(() => {
    const name = answer?.name ?? ''
    if (!slot || !name || name === slot.name) return
    if (namedFor.current === slot.path) return
    namedFor.current = slot.path
    onChange({ ...slot, name })
  }, [slot, answer, onChange])

  const listed = useMemo(() => {
    const all = entries ?? []
    const needle = search.trim().toLowerCase()
    if (!needle) return all
    return all.filter((entry) =>
      `${entryName(entry)} ${entryVendor(entry)} ${fileName(entry.path)} ${entry.kind}`
        .toLowerCase()
        .includes(needle),
    )
  }, [entries, search])

  const groups = useMemo(() => {
    const vst3 = listed.filter((entry) => entry.kind === 'vst3')
    const vst2 = listed.filter((entry) => entry.kind === 'vst2')
    return [
      { kind: 'VST3', entries: vst3 },
      { kind: 'VST2', entries: vst2 },
    ].filter((group) => group.entries.length > 0)
  }, [listed])

  // A plugin with two thousand knobs is not served by a wall of sliders: the
  // producer names the one they want. Without a search the first pages are shown.
  const [paramNeedle, setParamNeedle] = useState('')
  const visibleParams = useMemo(() => {
    const needle = paramNeedle.trim().toLowerCase()
    const filtered = needle
      ? params.filter((parameter) =>
          `${parameter.name} ${parameter.label} ${parameter.display} ${parameter.index}`
            .toLowerCase()
            .includes(needle),
        )
      : params
    return filtered.slice(0, needle ? 40 : 24)
  }, [params, paramNeedle])

  // ------------------------------------------------------- the plugin's window
  /**
   * A plugin's interface is its own code: the .dll draws the knobs, not us. The
   * native side opens a real window and this panel only says where — so the box
   * below is measured, sent, and measured again whenever the page moves, which
   * is what keeps the plugin's GUI glued to the slot it belongs to.
   */
  const [gui, setGui] = useState<GuiState>(GUI_CLOSED)
  /** Values the plugin moved itself, read back while its window is open. */
  const [live, setLive] = useState<{ id: number; value: number }[]>([])
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** This block, so the code can find the FX window it is standing inside. */
  const blockRef = useRef<HTMLDivElement | null>(null)
  /**
   * The FX window element that will host the plugin's pane. REAPER does not
   * drop a plugin's interface between knobs: the chain stays in a narrow
   * column and the plugin takes the rest of the window. That is a layout the
   * FX window owns, not one this block owns, so the pane is built here and
   * rendered there — and the native window is placed by the rectangle the page
   * reports, wherever the page puts it.
   */
  const [stageHost, setStageHost] = useState<HTMLElement | null>(null)
  const placed = useRef({ x: 0, y: 0, width: 0, height: 0 })
  /** The path whose window is up, so a close can reach it from an unmount. */
  const openFor = useRef('')
  /**
   * Whether the native window is on the screen right now. `gui-show` is a call
   * across processes, so it goes out once when the pane appears and once when it
   * disappears, not every fifth of a second while the pane sits there.
   */
  const shown = useRef(false)

  useEffect(() => {
    setStageHost(blockRef.current?.closest('.fx-window') ?? null)
  }, [])

  const stageRect = (): { x: number; y: number; width: number; height: number } => {
    const box = stageRef.current?.getBoundingClientRect()
    if (!box || box.width < 8 || box.height < 8) return { x: 120, y: 120, width: 640, height: 360 }
    return {
      x: Math.round(box.left),
      y: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  }

  /**
   * Is the pane the plugin draws in actually on the screen? A minimised panel,
   * a closed window or a hidden tab all measure zero, and a plugin window left
   * where it was is an interface floating with nothing under it. The native
   * window is therefore put away with its pane and brought back with it — the
   * plugin itself stays open, so the knobs are exactly where they were left.
   */
  const paneVisible = (): boolean => {
    const box = stageRef.current?.getBoundingClientRect()
    return Boolean(box && box.width >= 8 && box.height >= 8)
  }

  const openInterface = (): void => {
    // Everything that can be known without asking the native side is answered
    // here, in the click: an effect that set state to say "no" would render the
    // panel twice for nothing.
    if (!api?.guiOpen) {
      setGui({ ...GUI_CLOSED, error: 'o executável não expõe janelas de plugin nesta máquina' })
      return
    }
    if (!slot?.path) {
      setGui({ ...GUI_CLOSED, error: 'escolha um plugin primeiro' })
      return
    }
    setGui({ ...GUI_CLOSED, phase: 'pending' })
  }

  const closeInterface = (): void => {
    const target = openFor.current || slot?.path || ''
    openFor.current = ''
    shown.current = false
    setGui(GUI_CLOSED)
    if (target) void api?.guiClose?.({ path: target }).catch(() => {})
  }

  // The press and the window: gui-open is the call that loads the toolkit, so it
  // runs once per press and the answer decides what the strip says.
  useEffect(() => {
    if (gui.phase !== 'pending') return
    const target = slot?.path ?? ''
    // The path and the bridge were both checked when the press set `pending`,
    // and a slot that goes away on its way closes the window through its own
    // handler — so by here there is always something to open.
    if (!target || !api?.guiOpen) return
    let alive = true
    const rect = stageRect()
    void api
      .guiOpen({ path: target, sampleRate, rect })
      .then((result) => {
        if (!alive) return
        if (!result.ok || result.state?.open !== true) {
          setGui({ ...GUI_CLOSED, error: result.error ?? 'o plugin recusou abrir a interface dele' })
          return
        }
        placed.current = rect
        openFor.current = target
        // The window came up on the screen, so the poll starts from there; the
        // next tick is the one that notices a pane that went away meanwhile.
        shown.current = true
        setGui({
          phase: 'open',
          error: '',
          width: result.state.clientWidth ?? rect.width,
          height: result.state.clientHeight ?? rect.height,
        })
        setLive(result.reported ?? [])
      })
      .catch((error: Error) => {
        if (alive) setGui({ ...GUI_CLOSED, error: error.message })
      })
    return () => {
      alive = false
    }
  }, [gui.phase, api, slot, sampleRate])

  // Keeping it there: the FX chain scrolls, the window resizes, the producer
  // drags the app across a second monitor. One cheap check per fifth of a second
  // is enough to notice, and the native window is only moved when it really
  // needs moving. Every fifth poll also asks the plugin what it is holding, so a
  // knob turned inside the plugin's own GUI shows up here.
  useEffect(() => {
    if (gui.phase !== 'open') return
    const target = openFor.current || slot?.path || ''
    if (!target) return
    let alive = true
    let ticks = 0
    const timer = window.setInterval(() => {
      if (!alive) return
      ticks += 1
      // First question: is the pane on the screen at all? While it is not, the
      // plugin's window is put away and nothing else is attempted — placing a
      // hidden window by a rectangle that is not its own would move it somewhere
      // the producer never asked for.
      const visible = paneVisible()
      if (visible !== shown.current) {
        shown.current = visible
        void api
          ?.guiShow?.({ path: target, visible })
          .then((result) => {
            if (!alive) return
            if (result.noEditor === true) {
              openFor.current = ''
              setGui({ ...GUI_CLOSED, error: LOST_WINDOW })
            } else if (result.ok && !visible) setLive(result.reported ?? [])
          })
          .catch(() => {})
        return
      }
      if (!visible) return
      const rect = stageRect()
      const last = placed.current
      // Where the pane is and how big it is: the FX window can be dragged and
      // now pulled to a size, and an interface left at the old rectangle would
      // either hang over the edge of its pane or sit in a pane it outgrew.
      const moved =
        Math.abs(rect.x - last.x) > 1 ||
        Math.abs(rect.y - last.y) > 1 ||
        Math.abs(rect.width - last.width) > 1 ||
        Math.abs(rect.height - last.height) > 1
      if (moved && api?.guiPlace) {
        placed.current = rect
        void api
          .guiPlace({ path: target, rect })
          .then((result) => {
            if (!alive) return
            if (result.noEditor === true) {
              openFor.current = ''
              setGui({ ...GUI_CLOSED, error: LOST_WINDOW })
            } else if (!result.ok || result.state?.open === false) {
              setGui({ ...GUI_CLOSED, error: 'a janela do plugin foi fechada' })
            } else setLive(result.reported ?? [])
          })
          .catch(() => {})
        return
      }
      if (ticks % 5 === 0 && api?.guiState) {
        void api
          .guiState({ path: target })
          .then((result) => {
            if (!alive) return
            if (result.noEditor === true) {
              openFor.current = ''
              setGui({ ...GUI_CLOSED, error: LOST_WINDOW })
            } else if (result.ok && result.state?.open === false) {
              openFor.current = ''
              setGui(GUI_CLOSED)
            } else if (result.ok) setLive(result.reported ?? [])
          })
          .catch(() => {})
      }
    }, 200)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [gui.phase, gui.width, gui.height, slot, api])

  // Panel → plugin: a value set here has to be the value the plugin works with,
  // not only the value written on the slot. A bounce sends them anyway, but the
  // plugin's own window does not bounce — it shows what it is holding — so it is
  // told. Debounced, because a drag is sixty moves a second and the plugin only
  // cares about the one the slider lands on, and sent only after the engine has
  // described the plugin, since a value pushed before the plugin is configured
  // is a value the plugin overwrites when it configures itself.
  const pushed = useRef('')
  const pushTimer = useRef(0)
  useEffect(() => {
    if (!api?.setParams || !slot || answer === null || slot.params.length === 0) return
    const signature = `${slot.path}|${slot.params.map((item) => `${item.index}:${item.value}`).join(',')}`
    if (pushed.current === signature) return
    window.clearTimeout(pushTimer.current)
    pushTimer.current = window.setTimeout(() => {
      pushed.current = signature
      void api
        .setParams?.({ path: slot.path, params: slot.params, sampleRate })
        .then((result) => {
          if (result.ok) setLive(result.reported ?? [])
        })
        .catch(() => {})
    }, 150)
    return () => {
      window.clearTimeout(pushTimer.current)
    }
  }, [api, slot, answer, sampleRate])

  // A window belongs to the plugin that opened it: change the slot and the old
  // interface goes away with it, and so does it when the panel closes.
  useEffect(() => {
    if (gui.phase !== 'open') return
    const target = slot?.path ?? ''
    if (openFor.current && openFor.current !== target) {
      void api?.guiClose?.({ path: openFor.current }).catch(() => {})
      openFor.current = target
    }
  }, [gui.phase, slot, api])

  useEffect(
    () => () => {
      const target = openFor.current
      openFor.current = ''
      if (target) void pluginApi()?.guiClose?.({ path: target }).catch(() => {})
    },
    [],
  )

  const pick = (path: string): void => {
    if (!path) {
      closeInterface()
      onChange(null)
      return
    }
    if (path !== slot?.path) closeInterface()
    const entry = (entries ?? []).find((item) => item.path === path)
    onChange({ path, name: entry ? entryName(entry) : fileName(path), params: [] })
  }

  const setParam = (index: number, value: number): void => {
    if (!slot) return
    const rest = slot.params.filter((item) => item.index !== index)
    onChange({ ...slot, params: [...rest, { index, value }] })
  }

  /**
   * Read the folders again — after an install, or after a folder was added. The
   * plugin already in the slot is not touched: the list changes, the sound does
   * not.
   */
  const rescan = (): void => {
    if (!api) return
    setScanError(null)
    void api
      .scan()
      .then((result) => {
        if (!result.ok) setScanError(result.error ?? 'a varridura falhou')
        else setEntries((result.plugins ?? []).filter(isUsable))
      })
      .catch((error: Error) => setScanError(error.message))
  }

  const addFolder = (): void => {
    if (!api?.addDir) return
    void api
      .addDir()
      .then((result) => {
        if (!result.canceled && !result.error) rescan()
      })
      .catch(() => {})
  }

  if (api === null) return <></>

  const total = (entries ?? []).length

  /**
   * The plugin's own window is up, or one frame from being up. While it is, the
   * producer is looking at the interface the manufacturer drew — every knob it
   * needs is in there — so OpenDAW's own copies of those knobs step out of the
   * way. This is the shape REAPER's FX window has: the chain column keeps the
   * identity and the actions, the plugin takes the rest.
   */
  const ownUi = gui.phase !== 'closed'

  /**
   * Where the plugin's own window lives. Closed, it is a slim strip with the
   * button, inside this block. Open — or one frame away from open, while the
   * plugin is still building its toolkit — it is a pane of the FX window: the
   * chain narrows to its column and the plugin gets the rest of the window,
   * which is the shape a producer reads an amp face in.
   */
  const inPane = gui.phase !== 'closed' && stageHost !== null
  const stage = (
    <div
      className={`native-vst-stage${gui.phase === 'open' ? ' open' : ''}${inPane ? ' pane' : ''}`}
    >
      {gui.phase === 'closed' ? (
        <>
          <span>
            {gui.error
              ? gui.error
              : 'Cada plugin traz a interface da própria .dll; o OpenDAW abre a janela dela ao lado da cadeia.'}
          </span>
          <button
            type="button"
            className="reaper-btn"
            onClick={openInterface}
            // Pressing "open" on a plugin the engine has not answered about
            // yet is how a slot ends up showing a window it never asked for:
            // the describe call is still travelling, and `hasEditor` is the
            // only fact that says whether this plugin even has a GUI. So the
            // button waits for that answer, and says what it is waiting for.
            disabled={busy || answer === null || answer.hasEditor === false}
            title={
              answer === null
                ? 'Lendo o plugin: ele ainda não respondeu se tem interface'
                : answer.hasEditor === false
                  ? 'Este plugin não expõe interface própria'
                  : 'Abrir a janela da interface do plugin'
            }
          >
            {answer === null ? 'Lendo o plugin…' : 'Abrir interface do plugin'}
          </button>
        </>
      ) : (
        <>
          <div className="native-vst-stage-bar">
            {gui.phase === 'pending' ? (
              <span>Abrindo a interface do plugin…</span>
            ) : (
              <>
                <strong className="native-vst-stage-name">
                  {(slot?.name || fileName(slot?.path ?? '')).slice(0, 40)}
                </strong>
                {gui.width > 0 ? (
                  <span className="native-vst-stage-size">
                    {gui.width}×{gui.height}
                  </span>
                ) : null}
                {live.length > 0 ? (
                  <span className="plugin-live">{live.length} valores lidos do plugin</span>
                ) : null}
                <span className="native-vst-stage-hint">
                  a interface está sobre esta área — role a cadeia ou mova o OpenDAW que a janela
                  acompanha
                </span>
              </>
            )}
            <button
              type="button"
              className="mini-btn"
              title="Fechar a interface do plugin"
              onClick={closeInterface}
            >
              ✕
            </button>
          </div>
          {/* The rectangle the native window is placed by: the canvas, not the
              bar, so the plugin never paints over its own name. */}
          <div className="native-vst-stage-canvas" ref={stageRef} />
        </>
      )}
    </div>
  )

  return (
    <div className={`native-vst${slot?.bypass ? ' bypassed' : ''}`} ref={blockRef}>
      <div className="fx-section-title">
        <span>
          Plugin nativo{' '}
          <span className="fx-section-hint">
            (motor próprio, processa o clipe)
            {total > 0 ? ` — ${total} encontrado${total > 1 ? 's' : ''}` : ''}
          </span>
        </span>
        {slot ? (
          <button
            type="button"
            className={`mini-btn${slot.bypass ? '' : ' active'}`}
            title={slot.bypass ? 'Ligar o plugin de novo' : 'Bypass: o clipe passa sem o plugin'}
            onClick={() => onChange({ ...slot, bypass: !slot.bypass })}
          >
            ⏻
          </button>
        ) : null}
      </div>

      {/* While the plugin's own window is up, OpenDAW's picker, its search, its
          folder buttons and its copies of the plugin's knobs are put away: the
          producer is looking at the real interface, and a second set of sliders
          for the same parameters is how two answers get shown for one knob. */}
      {ownUi ? null : (
        <div className="fx-param">
          <label htmlFor={`native-plugin-${trackName}`}>Plugin:</label>
          <select
            id={`native-plugin-${trackName}`}
            className="reaper-input"
            value={slot?.path ?? ''}
            onChange={(event) => pick(event.target.value)}
          >
            <option value="">{entries === null ? 'lendo as pastas de plugin…' : '— nenhum —'}</option>
            {groups.map((group) => (
              <optgroup key={group.kind} label={`${group.kind} (${group.entries.length})`}>
                {group.entries.map((entry) => {
                  const vendor = entryVendor(entry)
                  return (
                    <option value={entry.path} key={entry.path}>
                      {entryName(entry)}
                      {vendor ? ` — ${vendor}` : ''}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </select>
          {slot ? (
            <button
              type="button"
              className="mini-btn danger"
              title="Tirar o plugin da lane"
              onClick={() => {
                closeInterface()
                onChange(null)
              }}
            >
              ✕
            </button>
          ) : null}
        </div>
      )}

      {!ownUi && total > 8 ? (
        <div className="fx-param">
          <label htmlFor={`native-search-${trackName}`}>Buscar:</label>
          <input
            id={`native-search-${trackName}`}
            className="reaper-input"
            type="search"
            placeholder="nome, fabricante ou tipo"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      ) : null}

      {ownUi ? null : (
        <>
          {/* Discovery lives next to the list it fills: a plugin installed after
              this window opened, or one that sits outside the usual folders, is a
              click away — not a restart away. */}
          <div className="native-vst-scan">
            <button type="button" className="mini-btn" onClick={rescan}>
              Procurar de novo
            </button>
            {api.addDir ? (
              <button
                type="button"
                className="mini-btn"
                onClick={addFolder}
                title="Uma pasta de plugins que não está nos lugares de costume; vale para as próximas varriduras"
              >
                Adicionar pasta…
              </button>
            ) : null}
            <span className="native-vst-scan-hint">
              {entries === null
                ? 'lendo as pastas de plugin…'
                : total === 0
                  ? 'nada nas pastas procuradas — aponte uma pasta se o plugin estiver fora delas'
                  : `${total} plugin(s) abríve${total === 1 ? 'l' : 'is'} nas pastas do computador`}
            </span>
          </div>

          {scanError ? <div className="plugin-note error">{scanError}</div> : null}
        </>
      )}

      {!ownUi && slot && params.length > 0 ? (
        <>
          {params.length > 12 ? (
            <div className="fx-param">
              <label htmlFor={`native-knob-${trackName}`}>Parâmetro:</label>
              <input
                id={`native-knob-${trackName}`}
                className="reaper-input"
                type="search"
                placeholder={`buscar entre ${params.length} parâmetros`}
                value={paramNeedle}
                onChange={(event) => setParamNeedle(event.target.value)}
              />
            </div>
          ) : null}
          <div className="native-vst-params">
            {visibleParams.map((parameter) => {
              const current = slot.params.find((item) => item.index === parameter.index)?.value
              // A plugin that moved its own knob (a preset, a morph, a GUI drag)
              // says so; the slider follows so the two never disagree.
              const reported = live.find((item) => item.id === parameter.index)?.value
              const value = current ?? reported ?? parameter.value
              return (
                <div className="fx-param" key={parameter.index}>
                  <label htmlFor={`native-p-${parameter.index}`}>
                    {(parameter.name || `#${parameter.index}`).slice(0, 22)}
                  </label>
                  <input
                    id={`native-p-${parameter.index}`}
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={value}
                    onChange={(event) => setParam(parameter.index, Number(event.target.value))}
                  />
                  <span className="value-badge">
                    {parameter.display
                      ? `${parameter.display}${parameter.label ? ` ${parameter.label}` : ''}`
                      : value.toFixed(2)}
                  </span>
                </div>
              )
            })}
            {visibleParams.length === 0 ? (
              <div className="plugin-note">Nenhum parâmetro com esse nome — a busca usa o nome que o plugin escreveu.</div>
            ) : null}
          </div>
        </>
      ) : null}

      {!ownUi && slot && answer && answer.params.length === 0 ? (
        <div className="plugin-note">
          {answer.name
            ? 'Este plugin não expõe parâmetros ao motor: ele processa com o preset que estiver carregado no próprio arquivo.'
            : `O motor abriu o arquivo mas ele não respondeu — ${slot.name} precisa da instalação da fabricante (licença, runtimes ou o restante do pacote) para funcionar.`}
        </div>
      ) : null}

      {slot && !slot.bypass ? (
        // The one line that says whether the plugin's sound is actually in the
        // lane: not a claim about the graph, but the peak of the pass the engine
        // is playing and writing to the export.
        <div className={`native-vst-preview ${preview?.state ?? 'idle'}`}>
          <span className="preview-state">
            {preview?.state === 'busy'
              ? 'Pré-escuta: processando o clipe…'
              : preview?.state === 'on'
                ? `Pré-escuta ativa · pico ${(preview.peak ?? 0).toFixed(3)} — é este áudio que toca e que vai para o WAV`
                : preview?.state === 'error'
                  ? `A pré-escuta não veio: ${preview.error}`
                  : hasClip
                    ? 'Pré-escuta: preparando o passe do plugin…'
                    : 'Pré-escuta: a lane ainda não tem clipe para o plugin atravessar'}
          </span>
          {preview?.state === 'error' ? (
            <button
              type="button"
              className="mini-btn"
              onClick={onPreviewRetry}
              title="Passa o clipe pelo plugin de novo"
            >
              ↻ tentar de novo
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="native-vst-actions">
        <button
          type="button"
          className="reaper-btn highlight"
          onClick={onBounce}
          disabled={!slot || busy || !hasClip || slot.bypass === true}
          title={
            !hasClip
              ? 'A lane precisa de um clipe'
              : slot?.bypass
                ? 'O plugin está em bypass — desligue o bypass para processar'
                : 'Passa o clipe pelo plugin e cria um novo take'
          }
        >
          {busy ? 'Processando…' : 'Aplicar ao clipe (bounce)'}
        </button>
      </div>

      {slot ? (
        // One line, three honest states: the plugin in the ear, the plugin that
        // refused and why, and the plugin waiting for the lane to be listened to.
        // The two counts are written on the row as data, not as text: the block
        // that came back from the plugin process is what tells "the amp is in the
        // monitor" from "the lane fell back to dry", and the desktop selftest has
        // to be able to read that without the producer's line filling with numbers.
        <div
          className={`native-vst-live${liveState && !liveState.error ? ' on' : liveState?.error ? ' off' : ''}`}
          data-live-batches={liveState?.batches ?? 0}
          data-live-answered={liveState?.answered ?? 0}
          data-live-underruns={liveState?.underruns ?? 0}
        >
          {liveState?.error ? (
            <span>
              <strong>seco</strong> · {liveState.error}
            </span>
          ) : liveState ? (
            <span>
              <strong>ao vivo</strong> · {liveState.latencyMs} ms de ida e volta
              {liveState.underruns > 0 ? ` · ${liveState.underruns} bloco(s) sem resposta a tempo` : ''}
            </span>
          ) : (
            <span>
              <strong>seco</strong> · ligue <strong>MON</strong> ou <strong>FX</strong> nesta lane
              para ouvir o plugin na hora
            </span>
          )}
        </div>
      ) : null}

      {slot ? (
        inPane ? (
          // The interface itself lives in the FX window's right pane; this is the
          // chain's own reminder of it, so the slot never looks empty.
          <div className="native-vst-open-here">
            <span>
              Interface aberta ao lado — {(slot.name || fileName(slot.path)).slice(0, 28)}. Os
              controles estão na janela do plugin; feche-a para ver os do OpenDAW.
            </span>
            <button
              type="button"
              className="mini-btn"
              title="Fechar a interface do plugin"
              onClick={closeInterface}
            >
              ✕
            </button>
          </div>
        ) : (
          stage
        )
      ) : null}

      {/* The same element, rendered where the FX window keeps its plugin pane. */}
      {inPane && stageHost ? createPortal(stage, stageHost) : null}

      <div className="plugin-note">
        O plugin roda no processo nativo do OpenDAW, não no gráfico do navegador. Na entrada ao
        vivo ele está no caminho do microfone: com <strong>MON</strong> ligado — ou com a lane em{' '}
        <strong>FX</strong> — o som passa pela <strong>.dll</strong> a cada bloco e volta para o
        fone, e é esse som que um take molhado grava. O arquivo seco no armazenamento continua
        seco: a forma de onda, o trim e o <strong>Ctrl+Z</strong> são os do take original. No
        playback e no WAV exportado o plugin entra pelo passe renderizado, e{' '}
        <strong>Aplicar ao clipe</strong> grava esse passe de vez, guardando o seco na prateleira
        de takes. Um ajuste feito com a música tocando vale a partir do próximo play. Um{' '}
        <strong>.vst3</strong> ainda só entra no passe do clipe — a sessão em tempo real deste
        host é de <strong>.dll</strong>.
      </div>
    </div>
  )
}
