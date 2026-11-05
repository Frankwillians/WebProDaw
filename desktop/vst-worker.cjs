/**
 * The process that actually touches plugins.
 *
 * A bad .dll can fault, and a fault inside the app's own process would take the
 * session down with it. So every plugin call happens here, in a child process:
 * if it dies, the parent notices, answers the pending request with an error and
 * starts a fresh worker. The DAW never loses the take because a plugin crashed.
 *
 * Runs under Electron's utilityProcess (process.parentPort) and, for tests,
 * under plain Node fork (process.send).
 */
const { Vst2Plugin } = require('./vst2.cjs')
const { Vst3Plugin, isVst3Bundle } = require('./vst3.cjs')
const { scan, addExtraDir } = require('./scan.cjs')
const gui = require('./plugin-gui.cjs')
const wav = require('./wav.cjs')

const out = typeof process.parentPort?.postMessage === 'function'
  ? { send: (message) => process.parentPort.postMessage(message) }
  : { send: (message) => { process.send?.(message) } }

if (process.parentPort?.on) {
  process.parentPort.on('message', (event) => { handle(event.data) })
} else {
  process.on('message', handle)
}

function reply(request, payload) {
  out.send({ id: request?.id, ...payload })
}

/**
 * Which engine reads a path. A .vst3 is a folder on Windows and the panel hands
 * us the bundle path, so the test covers the directory and the dll inside it.
 */
function kindOf(target) {
  if (typeof target !== 'string') return 'vst2'
  if (isVst3Bundle(target)) return 'vst3'
  return /\.vst3([/\\]|$)/i.test(target) ? 'vst3' : 'vst2'
}

/**
 * Plugins stay open between requests. Opening a VST3 means creating the
 * component, wiring its controller and running setupProcessing; paying for that
 * on every bounce is a delay the producer feels each time a knob moves, and a
 * plugin torn down and rebuilt can come back in another state. The cache is
 * keyed by path and dies with the worker, so nothing outlives a fault.
 */
const instances = new Map()

/**
 * Live sessions by plugin path. A session holds the plugin's mains open and its
 * block size small, which is exactly what a bounce is about to change: the render
 * path reconfigures the block size and reopens the mains. So a render on a path
 * that is being monitored puts the session down, does its work, and picks the
 * session back up with its own block size and its own knobs — see the render
 * command. The map is what tells the two apart.
 */
const liveSessions = new Map()

function acquire(target, sampleRate) {
  const kind = kindOf(target)
  const existing = instances.get(target)
  if (existing) return existing
  const plugin = kind === 'vst3' ? new Vst3Plugin(target) : new Vst2Plugin(target)
  // Both engines are told the project rate before they describe themselves: a
  // VST3 fixes its block size in setupProcessing, and a VST2 only answers with
  // its real parameter list after it has been opened and configured.
  const info = plugin.describe(sampleRate)
  const entry = { plugin, kind, info }
  instances.set(target, entry)
  return entry
}

function dispose(target) {
  const entry = instances.get(target)
  if (!entry) return false
  instances.delete(target)
  // The session map is keyed by the same path; a stale handle to a closed plugin
  // would look alive to whoever asked for it next.
  liveSessions.delete(target)
  try {
    entry.plugin.close()
  } catch {
    // A plugin that faults on close still must not wedge the worker.
  }
  return true
}

// ------------------------------------------------------------------ editor pump
/**
 * A plugin's interface is a Win32 window, and a Win32 window only lives while
 * somebody takes its messages. That somebody is this timer: it runs only while
 * at least one editor is open, and each window's own `onIdle` gets the plugin's
 * redraw call (effEditIdle, or the VST3 view's own turn) from plugin-gui.
 */
let pumpTimer = null

function pumpEditors() {
  if (gui.windows.size === 0) {
    if (pumpTimer) {
      clearInterval(pumpTimer)
      pumpTimer = null
    }
    return
  }
  try {
    gui.pump()
  } catch (error) {
    process.stderr.write(`[worker] pump: ${error.message}\n`)
  }
}

function startPump() {
  if (pumpTimer || gui.windows.size === 0) return
  pumpTimer = setInterval(pumpEditors, 16)
  // Never the reason a shutting-down worker waits: the IPC channel already
  // keeps it alive while the app is running.
  pumpTimer.unref?.()
}

/** The engine behind a cached instance, or null when the path is unknown. */
function editorOf(path) {
  const entry = instances.get(path)
  return entry && typeof entry.plugin.openEditor === 'function' ? entry : null
}

/** The channel pair the plugin asked for; a mono pin hears the summed clip. */
function feed(entry, left, right) {
  const channels = Number(entry.info.numInputs) || 1
  if (channels >= 2) return [left, right]
  return [sum(left, right)]
}

function sum(left, right) {
  const mono = new Float32Array(left.length)
  for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + (right[i] ?? 0)) * 0.5
  return mono
}

// ------------------------------------------------------------------ live audio
/**
 * IPC moves Buffers, not Float32Arrays: a bare ArrayBuffer arrives as an empty
 * object, and over a plain Node fork a Buffer arrives as {type:'Buffer', data}.
 * So a block crossing this boundary is packed as raw little-endian float32 and
 * unpacked by copy — never as a view over someone else's pool, whose byte offset
 * is not guaranteed to be a multiple of four.
 */
function toBuffer(channel) {
  return Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength)
}

function asFloats(payload) {
  if (!payload) return null
  if (payload instanceof Float32Array) return payload
  const bytes = payload instanceof ArrayBuffer
    ? new Uint8Array(payload)
    : ArrayBuffer.isView(payload)
      ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      : new Uint8Array(Buffer.from(payload))
  const values = new Float32Array(Math.floor(bytes.byteLength / 4))
  new Uint8Array(values.buffer).set(bytes.subarray(0, values.byteLength))
  return values
}

function applyParameters(plugin, params) {
  for (const item of params ?? []) {
    const index = Number(item?.index)
    const value = Number(item?.value)
    if (!Number.isFinite(index) || index < 0 || !Number.isFinite(value)) continue
    try {
      plugin.setParameter(index, Math.min(1, Math.max(0, value)))
    } catch (error) {
      process.stderr.write(`[worker] parâmetro ${index}: ${error.message}\n`)
    }
  }
}

async function handle(request) {
  if (!request || typeof request.cmd !== 'string') return
  try {
    if (request.cmd === 'scan') {
      const walked = []
      const plugins = scan(request.dirs ?? [], walked)
      // The folders are reported with the answer, each with how many plugin-shaped
      // files it gave up — the question behind the request is always "did the host
      // look where my plugin is", and a folder that is empty is part of that
      // answer. Ones that are not on this machine at all are left out.
      const dirs = walked.filter((item) => item.exists)
      reply(request, { ok: true, plugins, dirs })
      return
    }

    if (request.cmd === 'add-dir') {
      const result = addExtraDir(request.dir)
      reply(request, result.error ? { ok: false, error: result.error } : { ok: true, ...result })
      return
    }

    if (request.cmd === 'rt-probe') {
      // The spike's other half: how long a message takes to come in and out of
      // the process that holds the plugins, answered by this process alone. A
      // live block will pay this trip for every block of audio, so the number is
      // the whole question, and it is measured before any audio is promised.
      reply(request, { ok: true, probed: true, clock: request.clock ?? 0 })
      return
    }

    if (request.cmd === 'close') {
      reply(request, { ok: true, closed: dispose(request.path) })
      return
    }

    if (request.cmd === 'describe') {
      const rate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const entry = acquire(request.path, rate)
      reply(request, { ok: true, kind: entry.kind, info: entry.info })
      return
    }

    if (request.cmd === 'params') {
      const rate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const entry = acquire(request.path, rate)
      if (entry.info.error) throw new Error(entry.info.error)
      // Both engines take a 0..1 value at the same index the panel listed, and
      // both keep whatever the plugin's own window set: this is the handover from
      // panel to plugin, so a producer who moves a slider in the OpenDAW strip
      // sees the same number inside the plugin's GUI.
      const applied = []
      for (const item of request.params ?? []) {
        const index = Number(item.index)
        const value = Number(item.value)
        if (!Number.isFinite(index) || index < 0 || !Number.isFinite(value)) continue
        try {
          entry.plugin.setParameter(index, Math.min(1, Math.max(0, value)))
          // Read it back from the plugin: a value it refuses, steps, or clamps is
          // the plugin's answer, and the panel should show that rather than the
          // number that was typed.
          const held = typeof entry.plugin.parameterValue === 'function'
            ? Number(entry.plugin.parameterValue(index))
            : Number.NaN
          applied.push({ index, value: Number.isFinite(held) ? held : Math.min(1, Math.max(0, value)) })
        } catch (error) {
          process.stderr.write(`[worker] parâmetro ${index}: ${error.message}\n`)
        }
      }
      reply(request, {
        ok: true,
        kind: entry.kind,
        applied,
        reported: entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    if (request.cmd === 'render') {
      const sampleRate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      let left
      let right
      if (request.inputWav) {
        const decoded = wav.decode(Buffer.from(request.inputWav))
        left = decoded.left
        right = decoded.right
      } else {
        // No audio supplied: a decaying sine proves the signal really went
        // through the plugin rather than being copied around.
        const frames = Math.floor(sampleRate * (Number(request.seconds) || 2))
        left = new Float32Array(frames)
        right = new Float32Array(frames)
        for (let i = 0; i < frames; i += 1) {
          const t = i / sampleRate
          const value = Math.sin(2 * Math.PI * 220 * t) * Math.min(1, t * 8) * Math.exp(-t * 0.8)
          left[i] = value
          right[i] = value * 0.9
        }
      }

      const entry = acquire(request.path, sampleRate)
      const { plugin, info } = entry
      // A VST3 that could not be opened still describes itself: the reason it
      // failed is more useful to the producer than a bare error dialog. Checked
      // before anything is put down, so a refusal leaves the live ear alone.
      if (info.error) throw new Error(info.error)
      // A bounce reconfigures the block size and reopens the mains. Done to a
      // plugin that is being heard live, that would leave the monitor holding
      // buffers of the wrong size — so the session is put down for the length of
      // the pass and picked up again with its own block size and its own knobs.
      // Nothing here awaits while the plugin works, so no live block can squeeze
      // between the two: the monitor simply falls back to dry until the clip is
      // through, and the live counters report that stretch as underruns.
      const held = liveSessions.get(request.path) ?? null
      if (held && typeof plugin.stopLive === 'function') {
        try {
          plugin.stopLive()
        } catch (error) {
          process.stderr.write(`[worker] live pause: ${error.message}\n`)
        }
      }
      for (const parameter of request.params ?? []) {
        const position = Number(parameter?.index)
        // VST2 indexes and VST3 parameter ids both come through here; the
        // engines map a position onto the id themselves.
        if (Number.isFinite(position) && position >= 0) plugin.setParameter(position, Number(parameter.value))
      }
      // Both channels cross as they are; a plugin with a single input pin is
      // handed the summed pair so it hears the whole clip.
      let outputs
      try {
        outputs = plugin.render(feed(entry, left, right), sampleRate)
      } finally {
        if (held && typeof plugin.startLive === 'function') {
          try {
            held.geometry = plugin.startLive(sampleRate, held.geometry.block)
            applyParameters(plugin, held.params)
          } catch (error) {
            // The live ear cannot be re-opened. Say so to whoever is pumping
            // rather than leave a session that answers with the wrong buffers.
            liveSessions.delete(request.path)
            process.stderr.write(`[worker] live resume: ${error.message}\n`)
          }
        }
      }

      let peak = 0
      let nonSilent = 0
      let bad = 0
      const wet = outputs[0]
      // A plugin with one output feeds both sides of the clip, so the bounce
      // never silently turns a stereo lane into a mono one.
      const second = outputs[1] ?? wet
      for (let i = 0; i < wet.length; i += 1) {
        const a = wet[i]
        const b = second[i]
        if (!Number.isFinite(a) || !Number.isFinite(b)) bad += 1
        const magnitude = Math.max(Math.abs(a), Math.abs(b))
        if (magnitude > peak) peak = magnitude
        if (magnitude > 1e-6) nonSilent += 1
      }

      reply(request, {
        ok: true,
        kind: entry.kind,
        info: entry.info,
        // What the plugin reported on the way out — its meters, and any knob its
        // own interface moved. The FX window reads these so the panel and the
        // plugin cannot drift apart.
        reported: typeof plugin.reportedValues === 'function' ? plugin.reportedValues() : [],
        // A Buffer, not an ArrayBuffer: IPC (and the mobile-style clone in
        // utilityProcess) turns a bare ArrayBuffer into an empty object.
        outputWav: wav.encodeStereoFloat32(wet, second, sampleRate),
        peak,
        nonSilent,
        total: wet.length,
        bad,
      })
      return
    }

    if (request.cmd === 'live-open') {
      const sampleRate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const entry = acquire(request.path, sampleRate)
      if (entry.info.error) throw new Error(entry.info.error)
      if (entry.kind !== 'vst2' || typeof entry.plugin.startLive !== 'function') {
        // Honest, not a silent fallback: a VST3 in this host is opened, described
        // and rendered, but has no block-by-block session yet, so a producer
        // putting one on a live lane hears it on the bounce and not in the monitor.
        throw new Error('só VST2 processa ao vivo neste host; um .vst3 continua valendo no passe do clipe')
      }
      const existing = liveSessions.get(request.path)
      if (existing) {
        applyParameters(entry.plugin, request.params)
        existing.params = request.params ?? existing.params
        reply(request, { ok: true, kind: entry.kind, reused: true, geometry: existing.geometry, block: existing.geometry.block })
        return
      }
      const geometry = entry.plugin.startLive(sampleRate, Number(request.block) || 128)
      applyParameters(entry.plugin, request.params)
      // The knobs the panel is showing are kept with the session: a bounce on this
      // same plugin runs its own parameter list, and when the live ear is picked
      // back up it has to come back on the values the producer can see.
      liveSessions.set(request.path, { entry, geometry, blocks: 0, peak: 0, params: request.params ?? [] })
      reply(request, { ok: true, kind: entry.kind, geometry, info: entry.info, block: geometry.block })
      return
    }

    if (request.cmd === 'live-block') {
      const session = liveSessions.get(request.path)
      if (!session) throw new Error('esse plugin não tem sessão ao vivo aberta')
      const left = asFloats(request.left)
      if (!left || left.length === 0) throw new Error('o bloco de entrada veio vazio')
      const right = asFloats(request.right) ?? left
      // The same pin rule as the bounce: a plugin with one input hears the summed
      // pair rather than whichever channel happened to be asked for first.
      const input = session.geometry.channels >= 2 ? [left, right] : [sum(left, right)]
      const outputs = session.entry.plugin.processLive(input)
      const wet = outputs[0] ?? new Float32Array(0)
      const second = outputs[1] ?? wet
      let peak = 0
      let bad = 0
      for (let i = 0; i < wet.length; i += 1) {
        const a = wet[i]
        const b = second[i] ?? a
        if (!Number.isFinite(a) || !Number.isFinite(b)) bad += 1
        const magnitude = Math.max(Math.abs(a), Math.abs(b))
        if (magnitude > peak) peak = magnitude
      }
      session.blocks += 1
      if (peak > session.peak) session.peak = peak
      reply(request, {
        ok: true,
        left: toBuffer(wet),
        right: toBuffer(second),
        peak,
        bad,
        blocks: session.blocks,
      })
      return
    }

    if (request.cmd === 'live-params') {
      const session = liveSessions.get(request.path)
      if (!session) throw new Error('esse plugin não tem sessão ao vivo aberta')
      applyParameters(session.entry.plugin, request.params)
      if (Array.isArray(request.params)) session.params = request.params
      reply(request, {
        ok: true,
        blocks: session.blocks,
        peak: session.peak,
        reported: session.entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    if (request.cmd === 'live-close') {
      const session = liveSessions.get(request.path)
      if (!session) {
        reply(request, { ok: true, closed: false, blocks: 0, peak: 0 })
        return
      }
      liveSessions.delete(request.path)
      // The engine counts its own calls since the buffers were made, and a clip
      // pass in the middle of a session rebuilds those buffers — so what the
      // producer is owed is the length of the session, which this record kept,
      // with the engine's count beside it as the cross-check.
      const calls = Number(session.entry.plugin.stopLive?.()) ?? 0
      reply(request, {
        ok: true,
        closed: true,
        blocks: session.blocks,
        pluginCalls: Number.isFinite(calls) ? calls : 0,
        peak: session.peak,
      })
      return
    }

    if (request.cmd === 'gui-open') {
      const rate = Number(request.sampleRate) > 0 ? Number(request.sampleRate) : 48000
      const entry = acquire(request.path, rate)
      if (entry.info.error) throw new Error(entry.info.error)
      if (typeof entry.plugin.openEditor !== 'function') {
        throw new Error('este motor ainda não mostra interface própria')
      }
      const state = entry.plugin.openEditor(request.rect ?? {}, { owner: request.owner })
      // The plugin picks its own canvas size, and a pane sitting near a screen
      // edge can be smaller than that. The app's own area travels inside the
      // rectangle, so the window that comes up is already inside it: an
      // interface the producer has to hunt for on the desktop is not an
      // interface that lives in the program.
      if (request.rect?.inside && typeof entry.plugin.placeEditor === 'function') {
        entry.plugin.placeEditor(request.rect)
      }
      startPump()
      reply(request, {
        ok: true,
        kind: entry.kind,
        state,
        info: entry.info,
        reported: entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    if (
      request.cmd === 'gui-place' ||
      request.cmd === 'gui-state' ||
      request.cmd === 'gui-close' ||
      request.cmd === 'gui-show'
    ) {
      const entry = editorOf(request.path)
      if (!entry) {
        // `noEditor` is the answer that means "this process has never opened that
        // plugin", which is a different fact from "the plugin closed its window":
        // after a fault, the fresh process knows nothing, and the panel has to be
        // able to tell the producer its window went down with the plugins instead
        // of going on saying it is still on the screen.
        reply(request, { ok: false, noEditor: true, error: 'não há plugin aberto nesse endereço' })
        return
      }
      if (request.cmd === 'gui-place') {
        // The panel says where, the plugin says how big: a window stretched to a
        // div would give a fixed-size GUI a canvas it never asked for.
        const rect = request.rect ?? {}
        if (typeof entry.plugin.placeEditor === 'function') entry.plugin.placeEditor(rect)
        else if (entry.plugin.editor) gui.placeClient(entry.plugin.editor.window, rect)
      } else if (request.cmd === 'gui-show') {
        // The pane the plugin draws in can be hidden (the FX panel was minimised,
        // the lane was closed) without the plugin itself going away. Hiding the
        // window is what keeps an interface from floating over the desktop with
        // nowhere to be, and the pump keeps running so the plugin stays alive.
        const window = entry.plugin.editor?.window
        if (window) gui.shown(window, request.visible !== false)
      } else if (request.cmd === 'gui-close') {
        entry.plugin.closeEditor()
        // The last window closed takes the pump with it: an idle worker that
        // holds no editor holds no messages either.
        pumpEditors()
      }
      reply(request, {
        ok: true,
        kind: entry.kind,
        // Whether the interface is on the screen — the answer a hide is checked
        // against, so "put away" and "gone" are never the same report.
        visible: gui.isVisible(entry.plugin.editor?.window),
        state: entry.plugin.editorState?.() ?? { open: false },
        // The plugin may have moved its own knobs since the last look; the panel
        // reads them from here instead of guessing.
        reported: entry.plugin.reportedValues?.() ?? [],
      })
      return
    }

    reply(request, { ok: false, error: `comando desconhecido: ${request.cmd}` })
  } catch (error) {
    reply(request, { ok: false, error: (error && error.message) || String(error) })
  }
}

out.send({ ready: true })
