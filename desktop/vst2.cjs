/**
 * OpenDAW native VST2 engine — the "motor próprio".
 *
 * Hosts real VST2 .dll files through FFI only (koffi ships prebuilt binaries,
 * so there is no compiler step and no dependency on REAPER or any other
 * sequencer). The plugin is given the audioMaster callback it asks for, the
 * AEffect struct it fills in is read back, and audio is pushed through
 * processReplacing one block at a time.
 *
 * Opcode numbers and struct layout come from the official VST 2.4 SDK headers
 * (aeffect.h / aeffectx.h).
 */
const koffi = require('koffi')
const path = require('node:path')
const gui = require('./plugin-gui.cjs')

const MAX_BLOCK = 1024

// ------------------------------------------------------------------ opcodes
// effect.h AEffectOpcodes (effOpen = 0, then sequential).
const eff = {
  Open: 0,
  Close: 1,
  SetProgram: 2,
  GetProgram: 3,
  GetProgramName: 5,
  GetParamLabel: 6,
  GetParamDisplay: 7,
  GetParamName: 8,
  SetSampleRate: 10,
  SetBlockSize: 11,
  MainsChanged: 12,
  EditGetRect: 13,
  EditOpen: 14,
  EditClose: 15,
  EditIdle: 19,
  // aeffectx.h AEffectXOpcodes, continuing from effSetChunk = 24.
  SetBypass: 44,
  GetEffectName: 45,
  GetVendorString: 47,
  GetProductString: 48,
  GetVendorVersion: 49,
  CanDo: 51,
  GetTailSize: 52,
  GetVstVersion: 58,
  StartProcess: 71,
  StopProcess: 72,
  SetProcessPrecision: 77,
}

// aeffect.h AudioMasterOpcodes + aeffectx.h AudioMasterOpcodesX.
const host = {
  Automate: 0,
  Version: 1,
  CurrentId: 2,
  Idle: 3,
  PinConnected: 4,
  WantMidi: 6,
  GetTime: 7,
  ProcessEvents: 8,
  IOChanged: 13,
  SizeWindow: 15,
  GetSampleRate: 16,
  GetBlockSize: 17,
  GetInputLatency: 18,
  GetOutputLatency: 19,
  GetCurrentProcessLevel: 23,
  GetAutomationState: 24,
  GetVendorString: 32,
  GetProductString: 33,
  GetVendorVersion: 34,
  CanDo: 37,
  GetLanguage: 38,
  GetDirectory: 41,
  UpdateDisplay: 42,
  BeginEdit: 43,
  EndEdit: 44,
  OpenFileSelector: 45,
}

const HOST_NAMES = new Map(Object.entries(host).map(([key, value]) => [value, key]))

// ------------------------------------------------------------------ types
const AEffect = koffi.struct('AEffect', {
  magic: 'int32_t',
  dispatcher: 'void *',
  process: 'void *',
  setParameter: 'void *',
  getParameter: 'void *',
  numPrograms: 'int32_t',
  numParams: 'int32_t',
  numInputs: 'int32_t',
  numOutputs: 'int32_t',
  flags: 'int32_t',
  resvd1: 'intptr_t',
  resvd2: 'intptr_t',
  initialDelay: 'int32_t',
  realQualities: 'int32_t',
  offQualities: 'int32_t',
  ioRatio: 'float',
  object: 'void *',
  user: 'void *',
  uniqueID: 'int32_t',
  version: 'int32_t',
  processReplacing: 'void *',
  processDoubleReplacing: 'void *',
  future: koffi.array('char', 56),
})

// aeffect.h ERect: four VstInt16, and in that order — top, left, bottom, right.
// It is the size a plugin's editor asks to be drawn in.
const ERect = koffi.struct('ODErect', {
  top: 'int16_t',
  left: 'int16_t',
  bottom: 'int16_t',
  right: 'int16_t',
})

const AudioMasterCallback = koffi.proto(
  'intptr_t AudioMasterCallback(AEffect *effect, int32_t opcode, int32_t index, intptr_t value, void *ptr, float opt)',
)
const DispatcherProc = koffi.proto(
  'intptr_t AEffectDispatcher(AEffect *effect, int32_t opcode, int32_t index, intptr_t value, void *ptr, float opt)',
)
const ProcessProc = koffi.proto(
  'void AEffectProcess(AEffect *effect, float **inputs, float **outputs, int32_t sampleFrames)',
)
const SetParameterProc = koffi.proto(
  'void AEffectSetParameter(AEffect *effect, int32_t index, float parameter)',
)
const GetParameterProc = koffi.proto(
  'float AEffectGetParameter(AEffect *effect, int32_t index)',
)

// ------------------------------------------------------------------ host glue
const EFFECT_MAGIC = 0x56737450 // 'VstP'

/** Directory the .dll lives in, handed back for audioMasterGetDirectory. */
function makeDirectoryPointer(dir) {
  const ptr = koffi.alloc('char', 2048)
  const bytes = Buffer.from(dir, 'latin1').subarray(0, 2047)
  for (let i = 0; i < bytes.length; i += 1) koffi.encode(ptr, i, 'int8', bytes[i])
  koffi.encode(ptr, bytes.length, 'int8', 0)
  return { ptr, length: bytes.length + 1 }
}

function writeHostString(ptr, text, max) {
  if (!ptr) return
  const bytes = Buffer.from(text, 'latin1').subarray(0, Math.max(0, max - 1))
  for (let i = 0; i < bytes.length; i += 1) koffi.encode(ptr, i, 'int8', bytes[i])
  koffi.encode(ptr, bytes.length, 'int8', 0)
}

/**
 * The single master callback shared by every instance in this process. The
 * plugin always tells us which AEffect is calling, so one trampoline is enough.
 */
function createMaster(context) {
  return function audioMaster(effect, opcode, index, value, ptr, opt) {
    void effect; void opt
    const name = HOST_NAMES.get(opcode) ?? String(opcode)
    context.hostCalls.set(name, (context.hostCalls.get(name) ?? 0) + 1)
    switch (opcode) {
      case host.Version:
        return 2400 // VST 2.4
      case host.GetSampleRate:
        return context.sampleRate
      case host.GetBlockSize:
        return context.blockSize
      case host.IOChanged:
      case host.PinConnected:
      case host.CurrentId:
        return 0
      case host.GetTime:
        // No transport clock is offered yet; plugins must accept null.
        return 0
      case host.SizeWindow:
        // [index]: width, [value]: height. The plugin draws the numbers; the
        // frame around them is ours to add, and resizeEditor knows that.
        return context.owner?.resizeEditor?.(index, Number(value)) ? 1 : 0
      case host.GetInputLatency:
      case host.GetOutputLatency:
      case host.WantMidi:
      case host.UpdateDisplay:
      case host.BeginEdit:
      case host.EndEdit:
      case host.OpenFileSelector:
      case host.ProcessEvents:
        return 0
      case host.GetCurrentProcessLevel:
        return 1 // kVstProcessLevelRealtime
      case host.GetAutomationState:
        return 4 // read
      case host.GetVendorString:
        writeHostString(ptr, 'OpenDAW', 64)
        return 1
      case host.GetProductString:
        writeHostString(ptr, 'OpenDAW Studio', 128)
        return 1
      case host.GetVendorVersion:
        return 2400
      case host.CanDo: {
        const want = ptr ? koffi.decode(ptr, 'char *') : ''
        context.canDo.add(String(want))
        return ['receiveTimeInfo', 'wantTimeInfo'].includes(String(want)) ? 1 : 0
      }
      case host.GetLanguage:
        return 1 // English
      case host.GetDirectory:
        return Number(koffi.address(context.directory.ptr))
      default:
        return 0
    }
  }
}

// ------------------------------------------------------------------ plugin
class Vst2Plugin {
  constructor(filePath) {
    this.path = filePath
    this.closed = false
    this.opened = false
    this.context = {
      sampleRate: 48000,
      blockSize: MAX_BLOCK,
      hostCalls: new Map(),
      canDo: new Set(),
      directory: makeDirectoryPointer(path.dirname(filePath)),
    }
    this.master = koffi.register(createMaster(this.context), koffi.pointer(AudioMasterCallback))

    const lib = koffi.load(filePath)
    let entry
    try {
      entry = lib.func('AEffect * VSTPluginMain(AudioMasterCallback *master)')
    } catch {
      entry = lib.func('AEffect * main(AudioMasterCallback *master)')
    }
    this.lib = lib
    const effectPtr = entry(this.master)
    if (!effectPtr) throw new Error('o plugin recusou-se a abrir (VSTPluginMain devolveu nulo)')
    this.effectPtr = effectPtr
    this.fx = koffi.decode(effectPtr, AEffect)
    if ((this.fx.magic >>> 0) !== EFFECT_MAGIC) {
      throw new Error(`magic 0x${(this.fx.magic >>> 0).toString(16)} não é um VST2 ('VstP')`)
    }
    this.dispatcher = koffi.decode(this.fx.dispatcher, DispatcherProc)
    this.processReplacing = this.fx.processReplacing
      ? koffi.decode(this.fx.processReplacing, ProcessProc)
      : null
    // Named `…Proc` on purpose. A property called `setParameter` would hide the
    // class method of the same name — an instance field always wins over the
    // prototype — and the bounce would end up handing the plugin's own proc the
    // parameter number where the effect pointer belongs.
    this.setParamProc = this.fx.setParameter ? koffi.decode(this.fx.setParameter, SetParameterProc) : null
    this.getParamProc = this.fx.getParameter ? koffi.decode(this.fx.getParameter, GetParameterProc) : null
    if (!this.processReplacing) throw new Error('o plugin não expõe processReplacing')
    // The master callback is shared and only knows the context; the context now
    // knows the instance, so an audioMasterSizeWindow reaches the right window.
    this.context.owner = this
    this.editor = null
  }

  call(opcode, index = 0, value = 0, ptr = null, opt = 0) {
    return this.dispatcher(this.effectPtr, opcode, index, value, ptr, opt)
  }

  /** A fixed-size char buffer the plugin writes into. */
  readStringOpcode(opcode, index, max) {
    // The plugin is handed `max` bytes and is free to fill every one of them —
    // including the zero padding — so the buffer has to be at least as wide as
    // the field in the SDK (kVstMaxParamStrLen 8, kVstMaxProgNameLen 24,
    // kVstMaxEffectNameLen 32, kVstMaxVendorStrLen and kVstMaxProductStrLen 64).
    // It is deliberately never smaller than 256 bytes: a chatty plugin that
    // ignores the limit then writes into slack, not into whatever else the
    // process happens to own.
    const buffer = Buffer.alloc(Math.max(max, 256))
    this.call(opcode, index, 0, buffer, 0)
    return buffer.toString('latin1').split('\0')[0]
  }

  /**
   * The handshake every host does right after loading: open, then the rate and
   * the block size. A plugin is allowed to build its parameter list, its program
   * names and even its pin count here, so a host that describes before opening
   * reads zeros — Ratatouille is one of them: a VST2 wrapper that only knows its
   * eleven knobs once the VST3 inside it has been opened.
   */
  configure(sampleRate = 48000, block = MAX_BLOCK) {
    this.context.sampleRate = sampleRate
    this.context.blockSize = block
    if (!this.opened) {
      this.call(eff.Open)
      this.opened = true
    }
    this.call(eff.SetSampleRate, 0, sampleRate, null, sampleRate)
    this.call(eff.SetBlockSize, 0, block)
    this.call(eff.SetProcessPrecision, 0, 0)
    // Read the record again: the fields the plugin filled while opening become
    // visible, and describe/render both work from this snapshot.
    this.fx = koffi.decode(this.effectPtr, AEffect)
  }

  /**
   * Everything the mixer needs to know before the plugin is put on a track.
   * Cheap enough to call right after opening; block size/sample rate are set
   * first because some plugins only answer once they are configured.
   */
  describe(sampleRate = 48000) {
    this.configure(sampleRate)
    const flags = this.fx.flags >>> 0
    const params = []
    for (let index = 0; index < this.fx.numParams; index += 1) {
      params.push({
        index,
        name: this.readStringOpcode(eff.GetParamName, index, 8),
        label: this.readStringOpcode(eff.GetParamLabel, index, 8),
        display: this.readStringOpcode(eff.GetParamDisplay, index, 8),
        value: this.getParamProc ? Number(this.getParamProc(this.effectPtr, index)) : 0,
      })
    }
    return {
      kind: 'vst2',
      path: this.path,
      file: path.basename(this.path),
      name: this.readStringOpcode(eff.GetEffectName, 0, 64) || path.basename(this.path),
      vendor: this.readStringOpcode(eff.GetVendorString, 0, 64),
      product: this.readStringOpcode(eff.GetProductString, 0, 128),
      pluginVersion: this.call(eff.GetVendorVersion),
      vstVersion: this.call(eff.GetVstVersion),
      uniqueId: this.fx.uniqueID,
      numParams: this.fx.numParams,
      numPrograms: this.fx.numPrograms,
      numInputs: Math.max(0, this.fx.numInputs),
      numOutputs: Math.max(0, this.fx.numOutputs),
      program: this.call(eff.GetProgram),
      programName: this.readStringOpcode(eff.GetProgramName, 0, 24),
      initialDelay: this.fx.initialDelay,
      tail: this.call(eff.GetTailSize),
      hasEditor: (flags & 1) !== 0,
      canReplace: (flags & 16) !== 0,
      wantsChunks: (flags & 32) !== 0,
      isSynth: (flags & 256) !== 0,
      flags,
      params,
      hostCalls: [...this.context.hostCalls.entries()].map(([k, v]) => `${k}×${v}`),
      canDo: [...this.context.canDo],
    }
  }

  setParameter(index, value) {
    if (!this.setParamProc) return
    this.setParamProc(this.effectPtr, index, Math.min(1, Math.max(0, value)))
  }

  parameterValue(index) {
    if (!this.getParamProc) return 0
    return Number(this.getParamProc(this.effectPtr, index))
  }

  /** effFlagsHasEditor (bit 0): the plugin claims an interface of its own. */
  hasEditor() {
    return ((this.fx.flags >>> 0) & 1) !== 0
  }

  /** The name in the title bar, read once and kept for later calls. */
  title() {
    if (!this.cachedTitle) {
      this.cachedTitle = this.readStringOpcode(eff.GetEffectName, 0, 64) || path.basename(this.path)
    }
    return this.cachedTitle
  }

  // ------------------------------------------------------------------ editor
  /**
   * The canvas size the plugin's editor asks for. effEditGetRect receives the
   * address of an ERect * that the plugin fills in, and returns the same pointer
   * — either one is good, and a plugin that has no editor answers with null.
   */
  editRect() {
    const slot = Buffer.alloc(8)
    const returned = Number(this.call(eff.EditGetRect, 0, 0, slot, 0))
    const address = Number(slot.readBigUInt64LE(0)) || returned
    if (!address) return null
    const rect = koffi.decode(address, ERect)
    return {
      width: Math.max(0, rect.right - rect.left),
      height: Math.max(0, rect.bottom - rect.top),
      left: rect.left,
      top: rect.top,
    }
  }

  /**
   * Show the plugin's own interface. The host creates a real Win32 window in
   * this process and hands its HWND to effEditOpen; the plugin parents its
   * canvas inside and draws there. `rect` is where the app wants the window on
   * screen; the size comes from the plugin when it has one, because a fixed
   * canvas is not something a host can talk a plugin out of.
   */
  openEditor(rect = {}, options = {}) {
    this.configure(this.context.sampleRate)
    if (!this.hasEditor()) {
      throw new Error('este plugin não oferece interface própria (sem flag effFlagsHasEditor)')
    }
    if (this.editor && gui.alive(this.editor.window)) return this.editorState()
    const wanted = this.editRect()
    const width = Math.min(4000, Math.max(120, wanted?.width || rect.width || 640))
    const height = Math.min(4000, Math.max(80, wanted?.height || rect.height || 360))
    const window = gui.create(this.title() || path.basename(this.path), {
      x: Math.round(rect.x ?? 120),
      y: Math.round(rect.y ?? 120),
      width,
      height,
    }, {
      owner: options.owner,
      onIdle: () => this.idleEditor(),
      onResize: () => {
        // A drag of our title bar is a resize the plugin has to hear about: the
        // canvas is a child window and Windows sends it WM_SIZE itself, but a
        // VST2 that draws directly in the parent repainted only after an idle.
        this.idleEditor()
      },
      onClose: () => this.closeEditor(),
    })
    this.editor = { window, openedAt: Date.now(), openCode: 0, fitted: 0, resizedByPlugin: false }
    // effEditOpen is answered 0 on success by the SDK's own editor wrapper; the
    // number is kept for the log, but the real proof is that the window is still
    // standing after the call — a plugin that faults takes it with it.
    this.editor.openCode = Number(this.call(eff.EditOpen, 0, 0, gui.handleOf(window), 0))
    if (!gui.alive(window)) {
      this.editor = null
      gui.forget(window.key)
      throw new Error('o plugin fechou a janela dele mesmo ao abri-la (effEditOpen)')
    }
    // Many plugins only know their true canvas size once the editor exists, so
    // the window is fitted a second time from what the plugin reports now.
    const after = this.editRect()
    if (after?.width && after?.height) gui.resizeClient(window, after.width, after.height)
    // The canvas the plugin just created is a window of its own; some toolkits
    // give it a title bar and a size of their own choosing. Both are corrected
    // here, once, before the producer sees the first frame.
    this.editor.fitted = gui.fitChildren(window)
    return this.editorState()
  }

  /** effEditIdle: the plugin redraws and animates when the host says so. */
  idleEditor() {
    if (this.closed || !this.editor || !gui.alive(this.editor.window)) return
    this.call(eff.EditIdle)
  }

  /** The producer closed the window, or the app asked it back. */
  closeEditor() {
    const entry = this.editor
    this.editor = null
    if (!entry) return false
    if (!this.closed) {
      try {
        this.call(eff.EditClose)
      } catch {
        // A plugin that faults on editor close is the plugin's fault, not ours.
      }
    }
    gui.close(entry.window)
    gui.forget(entry.window.key)
    return true
  }

  /**
   * Move the window to where the app's FX panel is. The panel addresses the
   * client area — the caption belongs to the host — and the size is whatever the
   * plugin last asked for, because a VST2 canvas is built for one rectangle.
   * `rect.inside` travels with it: the app's own area is the limit the window is
   * kept inside, so a panel that gets dragged to a screen edge never leaves the
   * plugin sitting on the desktop.
   */
  placeEditor(rect = {}) {
    if (!this.editor || !gui.alive(this.editor.window)) return false
    const moved = gui.placeClient(this.editor.window, {
      x: Number.isFinite(Number(rect.x)) ? Number(rect.x) : undefined,
      y: Number.isFinite(Number(rect.y)) ? Number(rect.y) : undefined,
      inside: rect.inside,
    })
    gui.fitChildren(this.editor.window)
    this.idleEditor()
    return moved
  }

  /** audioMasterSizeWindow: the plugin asked to be this size; the frame is ours. */
  resizeEditor(width, height) {
    if (!this.editor || !gui.alive(this.editor.window)) return false
    if (width < 20 || height < 20 || width > 6000 || height > 6000) return false
    this.editor.resizedByPlugin = true
    if (!gui.resizeClient(this.editor.window, width, height)) return false
    gui.fitChildren(this.editor.window)
    return true
  }

  /** What the app needs to position and label the native window. */
  editorState() {
    if (!this.editor || !gui.alive(this.editor.window)) return { open: false }
    const inner = gui.clientSize(this.editor.window) ?? { width: 0, height: 0 }
    const outer = gui.windowRect(this.editor.window) ?? { x: 0, y: 0 }
    return {
      open: true,
      kind: 'vst2',
      // The HWND, as a plain number: it is the only form that survives IPC, and
      // a window handle means the same thing in every process, so the app can
      // check on the window (or capture it) without going through the worker.
      hwnd: Number(koffi.address(this.editor.window.hwnd)),
      clientWidth: inner.width,
      clientHeight: inner.height,
      x: outer.x,
      y: outer.y,
      pluginAskedForSize: this.editor.resizedByPlugin,
      childrenFitted: this.editor.fitted,
      openCode: this.editor.openCode,
    }
  }

  /**
   * Offline render: the whole buffer is fed to the plugin BLOCK samples at a
   * time, exactly like a real audio thread, so the result is what the plugin
   * will do in the session. `input` is one Float32Array (mono) or a list of
   * them (stereo); the plugin's own channel count decides how many it receives,
   * so a stereo effect gets its left and right and a mono effect gets summed
   * into one. Silence is padded at the head and tail so latency and reverb
   * tails are kept, not cut.
   */
  render(input, sampleRate) {
    const block = MAX_BLOCK
    this.configure(sampleRate, block)
    this.call(eff.MainsChanged, 0, 1)
    this.call(eff.StartProcess)

    const source = Array.isArray(input) ? input : [input]
    const channels = Math.max(1, this.fx.numInputs)
    const length = Math.max(...source.map((channel) => channel.length))
    const outputs = Array.from({ length: Math.max(1, this.fx.numOutputs) }, () => new Float32Array(length))
    const inViews = Array.from({ length: channels }, (_, index) => source[index] ?? source[0])
    const inBlocks = Array.from({ length: channels }, () => new Float32Array(block))
    const outViews = outputs.map(() => new Float32Array(block))

    for (let offset = 0; offset < length; offset += block) {
      const size = Math.min(block, length - offset)
      inBlocks.forEach((view) => view.fill(0))
      outViews.forEach((view) => view.fill(0))
      for (let c = 0; c < channels; c += 1) {
        const from = inViews[c]
        const to = inBlocks[c]
        if (!from) continue
        for (let i = 0; i < size; i += 1) to[i] = from[offset + i] ?? 0
      }
      this.processReplacing(
        this.effectPtr,
        inBlocks,
        outViews.length >= 2 ? outViews : [outViews[0]],
        size,
      )
      outputs.forEach((channel, index) => {
        channel.set(outViews[index].subarray(0, size), offset)
      })
    }

    this.call(eff.StopProcess)
    this.call(eff.MainsChanged, 0, 0)
    return outputs
  }

  /**
   * A live pass, as opposed to the render above: the plugin is fed real-time-sized
   * blocks one after another and left running between them, because that is what an
   * audio thread does. The offline render opens the mains, walks the whole file and
   * closes; a live session opens once, keeps its buffers and its state, and answers
   * block by block while the producer listens.
   */
  startLive(sampleRate = 48000, block = 128) {
    const size = Math.max(1, Math.min(MAX_BLOCK, Math.floor(block)))
    this.configure(sampleRate, size)
    this.call(eff.MainsChanged, 0, 1)
    this.call(eff.StartProcess)
    const channels = Math.max(1, this.fx.numInputs)
    const outputs = Math.max(1, this.fx.numOutputs)
    this.live = {
      block: size,
      sampleRate,
      channels,
      blocks: Array.from({ length: channels }, () => new Float32Array(size)),
      outBlocks: Array.from({ length: outputs }, () => new Float32Array(size)),
      calls: 0,
    }
    return { block: size, channels, outputs, sampleRate }
  }

  /**
   * One block through the running plugin. `input` is one Float32Array or a list of
   * them; what comes back is a copy, because the host reuses the buffers the next
   * block and the caller may still be holding this one.
   */
  processLive(input) {
    const live = this.live
    if (!live) throw new Error('a sessão ao vivo não foi aberta')
    const source = Array.isArray(input) ? input : [input]
    const size = Math.min(live.block, Math.max(...source.map((channel) => channel.length)))
    live.blocks.forEach((view) => view.fill(0))
    live.outBlocks.forEach((view) => view.fill(0))
    for (let channel = 0; channel < live.channels; channel += 1) {
      const from = source[channel] ?? source[0]
      if (!from) continue
      live.blocks[channel].set(from.subarray(0, size), 0)
    }
    this.processReplacing(
      this.effectPtr,
      live.blocks,
      live.outBlocks.length >= 2 ? live.outBlocks : [live.outBlocks[0]],
      size,
    )
    live.calls += 1
    return live.outBlocks.map((view) => Float32Array.from(view.subarray(0, size)))
  }

  /** The mains go the way they came: the SDK's order, and only once. */
  stopLive() {
    if (!this.live) return
    const calls = this.live.calls
    this.live = null
    try {
      this.call(eff.StopProcess)
      this.call(eff.MainsChanged, 0, 0)
    } catch {
      /* a plugin that faults on the way out still must not wedge the host */
    }
    return calls
  }

  /**
   * What the plugin's knobs read right now. A producer who drags a fader inside
   * the plugin's own window moves the plugin, not our slot, and the FX panel has
   * to show the number the window shows rather than the one it last sent.
   */
  reportedValues() {
    if (!this.getParamProc) return []
    const values = []
    for (let index = 0; index < Math.min(this.fx.numParams, 256); index += 1) {
      const value = Number(this.getParamProc(this.effectPtr, index))
      if (Number.isFinite(value)) values.push({ id: index, value })
    }
    return values
  }

  close() {
    if (this.closed) return
    // A live session holds the mains open; closing the effect underneath it
    // leaves the plugin processing into memory the host has already given back.
    this.stopLive()
    // The SDK's own order: the editor goes away before the effect does, or the
    // plugin is left holding a window that no longer exists.
    this.closeEditor()
    this.closed = true
    try {
      this.call(eff.Close)
    } catch {
      // A plugin that faults on close still must not wedge the app.
    }
    koffi.unregister(this.master)
  }
}

module.exports = { Vst2Plugin, MAX_BLOCK }
