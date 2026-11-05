/**
 * The native plugin panel — only ever mounted inside the executable.
 *
 * It lists what the disk scan found, opens a VST2 for real to read its name,
 * parameters and channel count, and can push a short reference tone through the
 * plugin and write the result to disk. That last button is the proof that the
 * audio actually went through the .dll, which is the whole reason this version
 * exists next to the browser one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  nativeSaveBlob,
  pluginApi,
  type NativePluginEntry,
  type NativePluginInfo,
  type NativeScanResult,
  type NativeScannedDir,
} from './native'

interface Props {
  sampleRate: number
  notify: (message: string) => void
  onClose: () => void
}

const isUsable = (entry: NativePluginEntry): boolean => !entry.error && entry.kind !== 'estranho'

function describeEntry(entry: NativePluginEntry): string {
  if (entry.error) return entry.error
  if (entry.kind === 'vst2') return `VST2 · ${entry.arch ?? '?'}`
  if (entry.kind === 'vst3') return `VST3 · ${entry.arch ?? '?'}`
  return entry.kind
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The name the producer reads: the plugin's own description, never an export symbol. */
const displayName = (entry: NativePluginEntry): string =>
  (entry.label ?? entry.meta?.module ?? fileName(entry.path)).slice(0, 48)

/**
 * What the engine answered about one file. The path travels with the answer, so
 * a slow reply about a plugin the producer has since un-picked can never be
 * shown as if it belonged to the current selection.
 */
interface Detail {
  path: string
  info: NativePluginInfo | null
  error: string | null
}

export default function PluginPanel({ sampleRate, notify, onClose }: Props): React.JSX.Element {
  // The bridge and the notifier are pinned when the window opens. `notify` is a
  // new closure on every render of the app, and if it sat in an effect's
  // dependency list the disk scan would restart on every keystroke.
  const [api] = useState(() => pluginApi())
  const notifyRef = useRef(notify)
  useEffect(() => {
    notifyRef.current = notify
  }, [notify])

  const [entries, setEntries] = useState<NativePluginEntry[] | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  /** The folders the last scan actually walked, as the native side reported them. */
  const [dirs, setDirs] = useState<NativeScannedDir[]>([])
  const [busy, setBusy] = useState<'scan' | 'render' | 'dir' | null>(null)
  const [selected, setSelected] = useState<NativePluginEntry | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)

  /**
   * A finished scan, applied the same way whether it came from the mount or from
   * a button: list the files, keep the current pick when its file is still on
   * disk, remember the folders that were walked, and say how many of them
   * actually open.
   */
  const applyScan = useCallback((result: NativeScanResult) => {
    const found = result.plugins ?? []
    setEntries(found)
    setDirs(result.dirs ?? [])
    setSelected((current) =>
      current && found.some((entry) => entry.path === current.path)
        ? current
        : (found.find((entry) => isUsable(entry)) ?? null),
    )
    notifyRef.current(
      `Varridura: ${found.filter(isUsable).length} plugin(s) utilizável(is) de ${found.length} arquivo(s)`,
    )
  }, [])

  // The plugin folders are read as the window opens, and it reports only through
  // the promise, so the panel paints once instead of twice.
  useEffect(() => {
    if (!api) return
    let live = true
    void api
      .scan()
      .then((result) => {
        if (!live) return
        if (!result.ok) {
          setScanError(result.error ?? 'a varridura falhou')
          setEntries([])
          return
        }
        applyScan(result)
      })
      .catch((error: Error) => {
        if (live) setScanError(error.message)
      })
    return () => {
      live = false
    }
  }, [api, applyScan])

  const rescan = (): void => {
    if (!api) return
    setBusy('scan')
    void api
      .scan()
      .then((result) => {
        if (!result.ok) {
          setScanError(result.error ?? 'a varridura falhou')
          setEntries([])
          return
        }
        setScanError(null)
        applyScan(result)
      })
      .catch((error: Error) => setScanError(error.message))
      .finally(() => setBusy(null))
  }

  /**
   * One folder the producer chooses is looked in from now on: an installed
   * plugin is found by the registry, a .dll that was unpacked somewhere else is
   * found only when the host is told where it went.
   */
  const addFolder = (): void => {
    if (!api?.addDir) return
    setBusy('dir')
    void api
      .addDir()
      .then((result) => {
        if (result.canceled) return
        if (result.error) {
          notifyRef.current(`A pasta não entrou: ${result.error}`)
          return
        }
        notifyRef.current(`Procurando também em ${result.added ?? 'pasta nova'}`)
        rescan()
      })
      .catch((error: Error) => notifyRef.current(`A pasta não entrou: ${error.message}`))
      .finally(() => setBusy(null))
  }

  useEffect(() => {
    if (!api || !selected) return
    let live = true
    const path = selected.path
    void api
      .describe(path)
      .then((result) => {
        if (!live) return
        setDetail({
          path,
          info: result.info ?? null,
          error: result.ok && result.info ? null : (result.error ?? 'o plugin não abriu'),
        })
      })
      .catch((error: Error) => {
        if (live) setDetail({ path, info: null, error: error.message })
      })
    return () => {
      live = false
    }
  }, [api, selected])

  const renderTest = (): void => {
    if (!api || !selected) return
    setBusy('render')
    void api
      .render({ path: selected.path, sampleRate, seconds: 2 })
      .then(async (result) => {
        if (!result.ok || !result.outputWav) {
          notifyRef.current(`O plugin não respondeu: ${result.error ?? 'sem áudio'}`)
          return
        }
        const bytes = new Uint8Array(result.outputWav)
        const label = (result.info?.name ?? fileName(selected.path))
          .replace(/[\\/:*?"<>|]/g, '')
          .slice(0, 28)
        const saved = await nativeSaveBlob(
          new Blob([bytes], { type: 'audio/wav' }),
          `${label} — teste.wav`,
        )
        if (saved) {
          notifyRef.current(
            `Passou pelo plugin: pico ${(result.peak ?? 0).toFixed(3)}, ` +
              `${result.nonSilent ?? 0}/${result.total ?? 0} amostras — salvo em ${saved}`,
          )
        }
      })
      .catch((error: Error) => notifyRef.current(`Falha no teste: ${error.message}`))
      .finally(() => setBusy(null))
  }

  const usable = (entries ?? []).filter(isUsable)
  const rejected = (entries ?? []).filter((entry) => !isUsable(entry))
  const shown = detail && selected && detail.path === selected.path ? detail : null
  const info = shown?.info ?? null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="fx-window plugin-window" onClick={(event) => event.stopPropagation()}>
        <div className="fx-header">
          <span>Plugins nativos</span>
          <button type="button" className="reaper-btn" onClick={onClose} title="Fechar">
            X
          </button>
        </div>
        <div className="fx-body">
          <div className="plugin-toolbar">
            <button
              type="button"
              className="reaper-btn"
              onClick={rescan}
              disabled={busy !== null || api === null}
            >
              {busy === 'scan' ? 'Procurando…' : 'Procurar de novo'}
            </button>
            {/* A folder of the producer's own, remembered by the app between runs. */}
            <button
              type="button"
              className="reaper-btn"
              onClick={addFolder}
              disabled={busy !== null || api?.addDir === undefined}
              title="Escolher uma pasta de plugins que não está nos lugares de costume"
            >
              {busy === 'dir' ? 'Escolhendo…' : 'Adicionar pasta…'}
            </button>
            <span className="plugin-count">
              {api === null
                ? 'fora do executável não há plugins nativos'
                : entries === null
                  ? 'lendo as pastas de plugin…'
                  : `${usable.length} utilizável(is) · ${rejected.length} descartado(s)`}
            </span>
          </div>

          {scanError ? <div className="plugin-note error">{scanError}</div> : null}

          {dirs.length > 0 ? (
            // Which folders were really on this machine, and what each one gave
            // up: the answer to "por que meu plugin não aparece" without opening
            // Explorer. It is a detail, so it never takes the list's space.
            <details className="plugin-dirs">
              <summary>{`Procurou em ${dirs.length} pasta(s) que existem neste PC`}</summary>
              <ul>
                {dirs.map((dir) => (
                  <li key={dir.path} className={dir.files > 0 ? 'hit' : ''}>
                    <span className="plugin-dir-path">{dir.path}</span>
                    <span className="plugin-dir-count">
                      {dir.files > 0 ? `${dir.files} arquivo(s)` : 'nada'}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="plugin-columns">
            <div className="plugin-list">
              {usable.length === 0 && entries !== null ? (
                <div className="plugin-note">
                  Nada abrível nas pastas procuradas — o registro do Windows, Common Files/VST e
                  VST3, as pastas da Steinberg, da Avid e as do seu usuário. Se o plugin estiver em
                  outra pasta, use <strong>Adicionar pasta…</strong> e procure de novo.
                </div>
              ) : null}
              {usable.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className={`plugin-row${selected?.path === entry.path ? ' on' : ''}`}
                  onClick={() => setSelected(entry)}
                >
                  <span className="plugin-kind">{entry.kind.toUpperCase()}</span>
                  <span className="plugin-name">{displayName(entry)}</span>
                  <span className="plugin-desc">{describeEntry(entry)}</span>
                </button>
              ))}
              {rejected.map((entry) => (
                <div className="plugin-row dead" key={entry.path}>
                  <span className="plugin-kind">—</span>
                  <span className="plugin-name">{displayName(entry)}</span>
                  <span className="plugin-desc">{entry.error}</span>
                </div>
              ))}
            </div>

            <div className="plugin-detail">
              {selected === null ? (
                <div className="plugin-note">Escolha um plugin à esquerda.</div>
              ) : shown?.error ? (
                <div className="plugin-note error">{shown.error}</div>
              ) : info === null ? (
                <div className="plugin-note">Abrindo o plugin…</div>
              ) : (
                <>
                  <h4>
                    {info.name} <em>{info.vendor}</em>
                  </h4>
                  <dl className="plugin-specs">
                    <div>
                      <dt>Canais</dt>
                      <dd>
                        {info.numInputs} in · {info.numOutputs} out
                      </dd>
                    </div>
                    <div>
                      <dt>Parâmetros</dt>
                      <dd>{info.numParams}</dd>
                    </div>
                    <div>
                      <dt>Programas</dt>
                      <dd>
                        {info.numPrograms}
                        {info.programName ? ` · atual: ${info.programName}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Atraso</dt>
                      <dd>
                        {info.initialDelay} amostras
                        {info.tail > 1 ? ` · cauda ${info.tail}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Tipo</dt>
                      <dd>
                        {info.isSynth ? 'instrumento (VSTi)' : 'efeito'}
                        {info.hasEditor ? ' · tem editor' : ' · sem editor'}
                        {info.wantsChunks ? ' · presets em bloco' : ''}
                      </dd>
                    </div>
                  </dl>
                  {/* A VST3 file is a factory of classes — the module, its
                      controller, sometimes a compatibility shell — and the
                      bundle's own description says which ones it carries. */}
                  {(selected.meta?.classes ?? []).length > 0 ? (
                    <ul className="plugin-classes">
                      {(selected.meta?.classes ?? []).map((klass, at) => (
                        <li key={`${klass.name}-${klass.category}-${at}`}>
                          <strong>{klass.name}</strong>
                          <em>
                            {klass.category}
                            {klass.subCategories?.length ? ` · ${klass.subCategories.join(', ')}` : ''}
                          </em>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {info.params.length > 0 ? (
                    <div className="plugin-params">
                      {info.params.slice(0, 16).map((parameter) => (
                        <div className="param-line" key={parameter.index}>
                          <span className="param-name">{parameter.name || `#${parameter.index}`}</span>
                          <span className="param-value">
                            {parameter.display || parameter.value.toFixed(2)}
                            {parameter.label ? ` ${parameter.label}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="plugin-note">
                      Este plugin não devolveu parâmetros — os controles dele vêm do editor interno,
                      e só o editor dele sabe o que cada um faz.
                    </div>
                  )}
                  <div className="plugin-actions">
                    <button type="button" className="reaper-btn highlight" onClick={renderTest} disabled={busy !== null}>
                      {busy === 'render' ? 'Renderizando…' : 'Tocar 2 s de referência e salvar .wav'}
                    </button>
                  </div>
                  <p className="plugin-note">
                    O teste manda uma senoide de 220 Hz com ataque e decaimento pelo plugin e salva o
                    resultado no disco. Se o arquivo sair diferente da entrada, o áudio passou de
                    fato pelo motor nativo.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
