/**
 * OpenDAW native VST3 engine.
 *
 * VST3 is not a C API: it is COM. A plugin hands out one object — a pointer to a
 * table of function pointers — and every call is `this` plus a slot in that
 * table, so hosting one means reading vtables through FFI and answering the
 * queryInterface calls the plugin makes back at us. That is what this file does,
 * with koffi and no compiler, exactly like the VST2 engine next to it.
 *
 * Interface IDs, vtable order and struct layouts are taken from the official
 * Steinberg headers (ipluginbase.h, ivstcomponent.h, ivstaudioprocessor.h,
 * ivsteditcontroller.h, funknown.h), not from memory.
 */
const koffi = require('koffi')
const fs = require('node:fs')
const path = require('node:path')

const { vst3Binary } = require('./scan.cjs')
const gui = require('./plugin-gui.cjs')

const MAX_BLOCK = 512

// ------------------------------------------------------------------ iids
// DECLARE_CLASS_IID hands four 32-bit words to INLINE_UID, and on Windows
// (COM_COMPATIBLE) that macro is neither big nor little endian all the way
// through: word 1 is reversed per byte, word 2 has its two halves swapped, and
// words 3 and 4 keep the order they were written in. The plugin compares these
// 16 bytes with memcmp, so the exact scramble is what decides whether a
// queryInterface succeeds — a plain writeUInt32BE per word does not.
const IID = {
  FUnknown: [0x00000000, 0x00000000, 0xc0000000, 0x00000046],
  IPluginBase: [0x22888ddb, 0x156e45ae, 0x8358b348, 0x08190625],
  IPluginFactory: [0x7a4d811c, 0x52114a1f, 0xaed9d2ee, 0x0b43bf9f],
  IPluginFactory2: [0x0007b650, 0xf24b4c0b, 0xa464edb9, 0xf00b2abb],
  IPluginFactory3: [0x4555a2ab, 0xc1234e57, 0x9b122910, 0x36878931],
  IComponent: [0xe831ff31, 0xf2d54301, 0x928ebbee, 0x25697802],
  IAudioProcessor: [0x42043f99, 0xb7da453c, 0xa569e79d, 0x9aaec33d],
  IEditController: [0xdcd7bbe3, 0x7742448d, 0xa874aacc, 0x979c759e],
  IHostApplication: [0x58e595cc, 0xdb2d4969, 0x8b6aaf8c, 0x36a664e5],
  IComponentHandler: [0x93a0bea3, 0x0bd045db, 0x8e890b0c, 0xc1e46ac6],
  IParameterChanges: [0xa4779663, 0x0bb64a56, 0xb44384a8, 0x466feb9d],
  IParamValueQueue: [0x01263a18, 0xed074f6f, 0x98c9d356, 0x4686f9ba],
  IConnectionPoint: [0x70a4156f, 0x6e6e4026, 0x989148bf, 0xaa60d8d1],
  IBStream: [0xc3bf6ea2, 0x30994752, 0x9b6bf990, 0x1ee33e9b],
  IEventList: [0x3a2c4214, 0x346349fe, 0xb2c4f397, 0xb9695a44],
  IPlugView: [0x5bc32507, 0xd06049ea, 0xa6151b52, 0x2b755b29],
  IPlugFrame: [0x367faf01, 0xafa94693, 0x8d4da2a0, 0xed0882a3],
}

const byte = (word, shift) => (word >>> shift) & 0xff

function iidBytes(words) {
  const [l1, l2, l3, l4] = words.map((word) => word >>> 0)
  const buffer = Buffer.alloc(16)
  buffer[0] = byte(l1, 0)
  buffer[1] = byte(l1, 8)
  buffer[2] = byte(l1, 16)
  buffer[3] = byte(l1, 24)
  buffer[4] = byte(l2, 16)
  buffer[5] = byte(l2, 24)
  buffer[6] = byte(l2, 0)
  buffer[7] = byte(l2, 8)
  buffer[8] = byte(l3, 24)
  buffer[9] = byte(l3, 16)
  buffer[10] = byte(l3, 8)
  buffer[11] = byte(l3, 0)
  buffer[12] = byte(l4, 24)
  buffer[13] = byte(l4, 16)
  buffer[14] = byte(l4, 8)
  buffer[15] = byte(l4, 0)
  return buffer
}

const IID_BUFFER = Object.fromEntries(
  Object.entries(IID).map(([name, words]) => [name, iidBytes(words)]),
)

// ------------------------------------------------------------------ enums
const kAudio = 0
const kInput = 0
const kOutput = 1
const kSimple = 0
const kSample32 = 0
const kRealtime = 0
const kResultOk = 0
const kResultFalse = 1
// E_NOINTERFACE / E_INVALIDARG as the SDK spells them on Windows: tresult is an
// int32 HRESULT, and a plugin that compares the failure code against anything
// but zero (the host-error dialogs some vendors ship do) wants the real value.
const kNoInterface = -2147467262
const kInvalidArgument = -2147024809

// ------------------------------------------------------------------ protos
// One koffi proto per call shape. `self` is always the COM object pointer.
const PROTO = {
  query: koffi.proto('int32 odQuery(void *self, void *iid, void **object)'),
  count: koffi.proto('uint32 odCount(void *self)'),
  factoryInfo: koffi.proto('int32 odFactoryInfo(void *self, void *out)'),
  none: koffi.proto('int32 odNone(void *self)'),
  init: koffi.proto('int32 odInit(void *self, void *context)'),
  oneInt: koffi.proto('int32 odOneInt(void *self, int32 value)'),
  twoInt: koffi.proto('int32 odTwoInt(void *self, int32 a, int32 b)'),
  threeIntBool: koffi.proto('int32 odThreeIntBool(void *self, int32 a, int32 b, int32 c, int8_t state)'),
  busInfo: koffi.proto('int32 odBusInfo(void *self, int32 mediaType, int32 direction, int32 index, void *out)'),
  indexOut: koffi.proto('int32 odIndexOut(void *self, int32 index, void *out)'),
  cidOut: koffi.proto('int32 odCidOut(void *self, void *out)'),
  create: koffi.proto('int32 odCreate(void *self, void *cid, void *iid, void **object)'),
  object: koffi.proto('int32 odObject(void *self, void *other)'),
  setup: koffi.proto('int32 odSetup(void *self, void *setup)'),
  process: koffi.proto('int32 odProcess(void *self, void *data)'),
  arrangements: koffi.proto('int32 odArrangements(void *self, void *ins, int32 numIns, void *outs, int32 numOuts)'),
  setParam: koffi.proto('int32 odSetParam(void *self, uint32_t id, double value)'),
  paramString: koffi.proto('int32 odParamString(void *self, uint32_t id, double value, void *out)'),
  getParam: koffi.proto('double odGetParam(void *self, uint32_t id)'),
  paramToPlain: koffi.proto('double odParamToPlain(void *self, uint32_t id, double value)'),
  plainValue: koffi.proto('uint32 odPlainValue(void *self)'),
  // koffi registers a proto by name, so every shape has to be built once here:
  // a second `koffi.proto('int32 odName…')` inside a constructor throws.
  hostName: koffi.proto('int32 odHostName(void *self, void *out)'),
  beginEdit: koffi.proto('int32 odBeginEdit(void *self, uint32_t id)'),
  restart: koffi.proto('int32 odRestart(void *self, int32 flags)'),
  endEdit: koffi.proto('int32 odEndEdit(void *self, uint32_t id)'),
  connect: koffi.proto('int32 odConnect(void *self, void *other)'),
  streamIo: koffi.proto('int32 odStreamIo(void *self, void *buffer, int32 numBytes, void *countOut)'),
  streamSeek: koffi.proto('int32 odStreamSeek(void *self, int64_t pos, int32 mode, void *resultOut)'),
  streamTell: koffi.proto('int32 odStreamTell(void *self, void *posOut)'),
  queuePoint: koffi.proto('int32 odQueuePoint(void *self, int32 index, void *offsetOut, void *valueOut)'),
  queueAddPoint: koffi.proto('int32 odQueueAddPoint(void *self, int32 offset, double value, void *indexOut)'),
  queueId: koffi.proto('uint32 odQueueId(void *self)'),
  queueAt: koffi.proto('void * odQueueAt(void *self, int32 index)'),
  queueAdd: koffi.proto('void * odQueueAdd(void *self, void *idRef, void *indexOut)'),
  // Editor: IEditController::createView(FIDString name) hands back the IPlugView
  // pointer itself — it is not the queryInterface-shaped call some hosts assume,
  // and passing three arguments to a one-argument method is how a plugin ends up
  // reading the host's stack as an interface id. The platform-type strings are
  // plain narrow C strings, so koffi is told char * and takes a JS string.
  createView: koffi.proto('void * odCreateView(void *self, char *name)'),
  typeName: koffi.proto('int32 odTypeName(void *self, char *type)'),
  attach: koffi.proto('int32 odAttach(void *self, void *parent, char *type)'),
  rect: koffi.proto('int32 odRect(void *self, void *rect)'),
  oneFlag: koffi.proto('int32 odOneFlag(void *self, int8_t state)'),
  resizeView: koffi.proto('int32 odResizeView(void *self, void *view, void *rect)'),
}

/** Read one slot of an object's vtable and make it callable. */
function method(object, slot, proto) {
  const vtable = koffi.decode(object, 'void *')
  if (!vtable) throw new Error('objeto COM inválido (vtable nula)')
  const slots = koffi.decode(vtable, koffi.array('void *', slot + 1))
  const address = slots[slot]
  if (!address) throw new Error(`slot ${slot} da vtable é nulo`)
  return koffi.decode(address, proto)
}

function queryInterface(object, iidName) {
  const out = koffi.alloc('void *', 1)
  const call = method(object, 0, PROTO.query)
  const result = call(object, IID_BUFFER[iidName], out)
  const pointer = koffi.decode(out, 'void *')
  return result === kResultOk && pointer ? pointer : null
}

function release(object) {
  if (!object) return
  try {
    method(object, 2, PROTO.count)(object)
  } catch {
    // A plugin that faults on release still must not wedge the session.
  }
}

/**
 * A COM object handed to the plugin, built out of koffi callbacks.
 * `slots` is the vtable: [queryInterface, addRef, release, ...methods].
 */
function comObject(slots) {
  const fns = slots.map((entry, index) => {
    const proto = entry.proto ?? PROTO.none
    const handler = entry.handler
    return koffi.register((self, ...args) => handler(self, args, index), koffi.pointer(proto))
  })
  const vtable = keep('void *', fns.length)
  fns.forEach((fn, index) => koffi.encode(vtable, index * 8, 'void *', fn))
  const object = keep('void *', 1)
  koffi.encode(object, 0, 'void *', vtable)
  // The trampolines and both blocks have to outlive every call the plugin makes,
  // so the vtable and the object handle are stored native memory (see keep).
  return { ptr: object, keep: { vtable, object, fns } }
}

/**
 * The two host interfaces a VST3 plugin is allowed to call back on.
 *
 * `queryInterface` on a host object used to answer "no such interface" to
 * everything, which is a lie: the plugin handed us its IHostApplication and
 * needs to read the host name back, and plugins that cannot get it either
 * refuse to load or crash trying. So each object answers for the interfaces it
 * really implements (plus FUnknown) and nothing else, and every slot of those
 * interfaces exists — a vtable short of a method means the plugin reads the
 * next heap pointer as code.
 */
function makeHost() {
  const objects = { calls: [] }

  const hostApplication = comObject([
    { proto: PROTO.query, handler: (_s, args) => hostQuery(objects.hostApplication, args, ['FUnknown', 'IHostApplication']) },
    { proto: PROTO.count, handler: () => 1 },
    { proto: PROTO.count, handler: () => 1 },
    { proto: PROTO.hostName, handler: (_self, [out]) => { writeUtf16(out, 'OpenDAW', 128); return kResultOk } },
    // getBaseUrl: the plugin passes an IURL** and we have no URL to offer, so
    // the honest answer is "not supported" and the plugin uses its own path.
    { proto: PROTO.object, handler: (_self, [out]) => { koffi.encode(out, 0, 'void *', 0); return kNoInterface } },
  ])

  const componentHandler = comObject([
    { proto: PROTO.query, handler: (_s, args) => hostQuery(objects.componentHandler, args, ['FUnknown', 'IComponentHandler']) },
    { proto: PROTO.count, handler: () => 1 },
    { proto: PROTO.count, handler: () => 1 },
    // beginEdit / performEdit / endEdit / restartComponent. The parameter
    // changes already live in the controller, so acknowledging is all a bounce
    // needs; recording the call is what lets the panel prove the GUI talked.
    { proto: PROTO.beginEdit, handler: (_s, args) => noteCall(objects, 'beginEdit', args) },
    { proto: PROTO.setParam, handler: (_s, args) => noteCall(objects, 'performEdit', args) },
    { proto: PROTO.endEdit, handler: (_s, args) => noteCall(objects, 'endEdit', args) },
    { proto: PROTO.restart, handler: (_s, args) => noteCall(objects, 'restartComponent', args) },
  ])

  objects.hostApplication = hostApplication
  objects.componentHandler = componentHandler
  return { hostApplication, componentHandler, objects }
}

/** Answer a plugin's queryInterface against the interfaces this object has. */
function hostQuery(object, args, names) {
  const [iid, out] = args
  if (!object || !out) return kNoInterface
  const wanted = Buffer.from(koffi.decode(iid, koffi.array('uint8_t', 16)))
  const hit = names.find((name) => wanted.equals(IID_BUFFER[name]))
  if (!hit) return kNoInterface
  koffi.encode(out, 0, 'void *', object.ptr)
  return kResultOk
}

function noteCall(objects, name, args) {
  objects.calls = objects.calls ?? []
  if (objects.calls.length < 64) objects.calls.push(name)
  return kResultOk
}

/** Step-by-step log for the wiring, on when OD_VST3_TRACE is set. A plugin that
 *  faults inside a host call takes the worker down with it, and the last line
 *  printed is then the only way to know which call did it. */
function trace(...parts) {
  if (process.env.OD_VST3_TRACE) {
    // A file descriptor, not console.error: a plugin that faults can lose an
    // async write, and the last line printed is the whole diagnosis.
    try {
      fs.appendFileSync(process.env.OD_VST3_TRACE === '1' ? 2 : process.env.OD_VST3_TRACE, `[vst3] ${parts.join(' ')}\n`)
    } catch {
      console.error('[vst3]', ...parts)
    }
  }
}

/**
 * Memory the plugin is allowed to hold a pointer to.
 *
 * Two things can make that pointer die under the plugin. `koffi.alloc` memory is
 * released when the garbage collector loses sight of the handle it returns, so
 * every block is kept in `pinned` for the life of the process. And a Node
 * `Buffer` is not stable native memory at all: a small allocation lives in a
 * pool whose backing store V8 is free to move, so the address encoded into
 * ProcessData on the first block points at whatever Node put in its place by the
 * tenth. That is how a VST3 host ends up faulting at a different call every
 * run. Anything the plugin may keep — the audio buffers, the bus records, the
 * process struct, a COM vtable — has to come from here, never from Buffer.alloc.
 */
const pinned = new Set()

function keep(type, count = 1) {
  const pointer = koffi.alloc(type, count)
  pinned.add(pointer)
  return pointer
}

/**
 * Memory handed to a plugin as an out-parameter, with room to spare. The SDK
 * records end in fixed-size char arrays and a plugin that writes its NUL
 * terminator one past the declared size would otherwise scribble on whatever
 * sits next to it. Backed by `keep`, so the answer stays readable after the call
 * returns and cannot move underneath a plugin that decided to cache it.
 */
function hostBuffer(size) {
  return keep('uint8_t', size + 64)
}

/**
 * A host-implemented IBStream over a JS byte array. VST3 pushes presets and the
 * whole plugin state through this interface, so the host has to be able to
 * supply one just to connect the two halves of a plugin (see #connectParts).
 * Slots: 0 qi, 1 addRef, 2 release, 3 read, 4 write, 5 seek, 6 tell.
 */
function makeStream() {
  const state = { bytes: new Uint8Array(0), pos: 0 }
  /**
   * Copying to and from a pointer the plugin owns.
   *
   * koffi.view is not on the table: in the build of Node that Electron ships, it
   * aborts the process instead of wrapping the memory — the very same call works
   * in plain node, which is how this sat hidden for as long as the VST3 engine
   * was only exercised from a test script. encode and decode take a numeric
   * address and move a whole block in one call, and the address and the size are
   * both checked in JS first, because a plugin that loses its own byte count
   * would otherwise ask for a gigabyte of memory in a single read.
   */
  const BLOCK = 1 << 20
  const MAX_STREAM_BYTES = 64 * 1024 * 1024
  // A plain number: the Electron build reads a BigInt address as null and ends
  // the process over it. Windows keeps user-mode addresses far inside 2^53, so
  // the conversion is exact — `Number(p) === p` holds for every pointer here.
  const addressOf = (pointer) => {
    const value = Number(BigInt(pointer ?? 0))
    if (!Number.isFinite(value) || value <= 0) throw new Error('ponteiro nulo')
    return value
  }
  const peek = (pointer, count) => {
    const base = addressOf(pointer)
    if (count > MAX_STREAM_BYTES) throw new Error(`escrita demais de uma vez (${count} bytes)`)
    const copy = new Uint8Array(count)
    for (let done = 0; done < count; done += BLOCK) {
      const size = Math.min(BLOCK, count - done)
      copy.set(koffi.decode(base + done, 'uint8_t', size), done)
    }
    return copy
  }
  const poke = (pointer, data) => {
    const base = addressOf(pointer)
    for (let done = 0; done < data.length; done += BLOCK) {
      const size = Math.min(BLOCK, data.length - done)
      koffi.encode(base + done, 'uint8_t', data.subarray(done, done + size), size)
    }
  }
  const self = {}
  // A handler that throws would cross the FFI boundary into plugin code with a
  // garbage return value, which is how a host takes down a worker. Every stream
  // call answers with a number, whatever happens, and says what happened when
  // the host is being watched: a plugin that hands the host a bad pointer is
  // worth naming, because that is the call that used to end the process.
  const safe = (name, handler) => (selfArg, args, index) => {
    try {
      return handler(selfArg, args, index)
    } catch (error) {
      if (process.env.OD_VST3_TRACE) trace(`${name} recusado:`, error.message)
      return kResultFalse
    }
  }
  const slots = [
    { proto: PROTO.query, handler: safe('consulta', (_s, args) => hostQuery(self, args, ['FUnknown', 'IBStream'])) },
    { proto: PROTO.count, handler: () => 1 },
    { proto: PROTO.count, handler: () => 1 },
    {
      proto: PROTO.streamIo,
      handler: safe('leitura', (_s, [buffer, numBytes, countOut]) => {
        const wanted = Math.max(0, Math.min(Number(numBytes) | 0, state.bytes.length - state.pos))
        if (wanted > 0 && !buffer) return kResultFalse
        if (wanted > 0) poke(buffer, state.bytes.subarray(state.pos, state.pos + wanted))
        state.pos += wanted
        if (countOut) koffi.encode(countOut, 0, 'int32_t', wanted)
        return kResultOk
      }),
    },
    {
      proto: PROTO.streamIo,
      handler: safe('escrita', (_s, [buffer, numBytes, countOut]) => {
        const amount = Math.max(0, Number(numBytes) | 0)
        if (amount === 0) {
          if (countOut) koffi.encode(countOut, 0, 'int32_t', 0)
          return kResultOk
        }
        const chunk = peek(buffer, amount)
        const end = state.pos + chunk.length
        if (end > MAX_STREAM_BYTES) throw new Error(`o estado passou de ${MAX_STREAM_BYTES} bytes`)
        if (end > state.bytes.length) {
          const grown = new Uint8Array(Math.max(end, state.bytes.length * 2, 4096))
          grown.set(state.bytes)
          state.bytes = grown
        }
        state.bytes.set(chunk, state.pos)
        state.pos = end
        if (countOut) koffi.encode(countOut, 0, 'int32_t', chunk.length)
        return kResultOk
      }),
    },
    {
      proto: PROTO.streamSeek,
      handler: safe('busca', (_s, [pos, mode, resultOut]) => {
        const target = Number(BigInt(pos ?? 0))
        const base = Number(mode) === 1 ? state.pos : Number(mode) === 2 ? state.bytes.length : 0
        const next = Math.max(0, base + target)
        if (next > MAX_STREAM_BYTES) throw new Error(`posição demais (${next})`)
        if (next > state.bytes.length) {
          const grown = new Uint8Array(next)
          grown.set(state.bytes)
          state.bytes = grown
        }
        state.pos = next
        if (resultOut) koffi.encode(resultOut, 0, 'int64_t', BigInt(next))
        return kResultOk
      }),
    },
    {
      proto: PROTO.streamTell,
      handler: safe((_s, [posOut]) => {
        if (posOut) koffi.encode(posOut, 0, 'int64_t', BigInt(state.pos))
        return kResultOk
      }),
    },
  ]
  const object = comObject(slots)
  Object.defineProperty(self, 'ptr', { value: object.ptr })
  return {
    ptr: object.ptr,
    root: object,
    get length() {
      return state.bytes.length
    },
    rewind() {
      state.pos = 0
    },
    bytes() {
      return state.bytes.slice(0, state.pos)
    },
  }
}

/**
 * A host IEventList with nothing in it. ProcessData.inputEvents and
 * .outputEvents are "optional" in the header, which a great many plugins read as
 * "the host always sends me a list": an instrument or a note-routing effect
 * calls outputEvents->addEvent() without checking the pointer first, and the
 * null the host left there takes down the worker mid-bounce. Passing a real,
 * empty list costs nothing and answers both halves honestly — the input side has
 * no events (this host sends MIDI through the VST2-style path, not VST3 events),
 * and the output side accepts what the plugin writes and drops it, because a
 * bounce has no place to route a note-off to.
 *
 * Slots: 0 qi, 1 addRef, 2 release, 3 getEventCount, 4 getEvent(index, Event&),
 * 5 addEvent(Event&).
 */
function makeEventList(label) {
  const self = {}
  let written = 0
  const slots = [
    { proto: PROTO.query, handler: (_s, args) => hostQuery(self, args, ['FUnknown', 'IEventList']) },
    { proto: PROTO.count, handler: () => 1 },
    { proto: PROTO.count, handler: () => 1 },
    { proto: PROTO.count, handler: () => 0 }, // getEventCount: always empty
    {
      proto: PROTO.indexOut,
      handler: () => kInvalidArgument, // getEvent: nothing to hand back
    },
    {
      // addEvent: the plugin's Event& is only valid for the duration of the
      // call, and a bounce has no consumer for it, so it is acknowledged and
      // counted (the count is what tells the panel a synth really is writing
      // notes we cannot hear).
      proto: PROTO.object,
      handler: () => {
        written += 1
        return kResultOk
      },
    },
  ]
  const object = comObject(slots)
  Object.defineProperty(self, 'ptr', { value: object.ptr })
  return { ptr: object.ptr, root: object, label, get written() { return written }, reset() { written = 0 } }
}

/**
 * A fixed C string buffer. koffi hands char/char16 arrays back as JS strings,
 * padding and all, so the value is whatever comes before the first NUL. The
 * array branches stay: an int8 buffer would arrive as numbers, not text.
 */
function fromChars(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.split('\0')[0].trim()
  if (Buffer.isBuffer(value)) return value.toString('latin1').split('\0')[0].trim()
  let text = ''
  for (const code of Array.from(value)) {
    const character = Number(code) & 0xffff
    if (!character) break
    text += String.fromCharCode(character)
  }
  return text.trim()
}

function writeUtf16(pointer, text, max) {
  if (!pointer) return
  const buffer = Buffer.from(`${text}\0`, 'utf16le').subarray(0, Math.max(0, max * 2 - 2))
  for (let i = 0; i < buffer.length; i += 1) koffi.encode(pointer, i, 'uint8_t', buffer[i])
}

// ------------------------------------------------------------------ structs
const PClassInfo = koffi.struct('ODPClassInfo', {
  cid: koffi.array('int8_t', 16),
  cardinality: 'int32_t',
  category: koffi.array('char', 32),
  name: koffi.array('char', 64),
})

const PClassInfoW = koffi.struct('ODPClassInfoW', {
  cid: koffi.array('int8_t', 16),
  cardinality: 'int32_t',
  category: koffi.array('char', 32),
  name: koffi.array('char16_t', 64),
  classFlags: 'uint32_t',
  subCategories: koffi.array('char', 128),
  vendor: koffi.array('char16_t', 64),
  version: koffi.array('char16_t', 64),
  sdkVersion: koffi.array('char16_t', 64),
})

/** PFactoryInfo: five fixed C strings and a flag word, from getFactoryInfo. */
const PFactoryInfo = koffi.struct('ODPFactoryInfo', {
  name: koffi.array('char', 64),
  vendor: koffi.array('char', 64),
  email: koffi.array('char', 64),
  webAddress: koffi.array('char', 64),
  licence: koffi.array('char', 64),
  flags: 'int32_t',
})

const BusInfo = koffi.struct('ODPBusInfo', {
  mediaType: 'int32_t',
  direction: 'int32_t',
  channelCount: 'int32_t',
  name: koffi.array('char16_t', 128),
  busType: 'int32_t',
  flags: 'uint32_t',
})

/** String128 — a UTF-16 C string on the wire, used for parameter readouts. */
const String128 = koffi.array('char16_t', 128)
const ParameterInfo = koffi.struct('ODPParameterInfo', {
  id: 'uint32_t',
  title: koffi.array('char16_t', 128),
  shortTitle: koffi.array('char16_t', 128),
  units: koffi.array('char16_t', 128),
  stepCount: 'int32_t',
  defaultNormalizedValue: 'double',
  unitId: 'int32_t',
  flags: 'int32_t',
})

const ProcessSetup = koffi.struct('ODPProcessSetup', {
  processMode: 'int32_t',
  symbolicSampleSize: 'int32_t',
  maxSamplesPerBlock: 'int32_t',
  sampleRate: 'double',
})

const AudioBusBuffers = koffi.struct('ODPAudioBusBuffers', {
  numChannels: 'int32_t',
  silenceFlags: 'uint64_t',
  channelBuffers: 'void *',
})

const ProcessData = koffi.struct('ODPProcessData', {
  processMode: 'int32_t',
  symbolicSampleSize: 'int32_t',
  numSamples: 'int32_t',
  numInputs: 'int32_t',
  numOutputs: 'int32_t',
  inputs: 'void *',
  outputs: 'void *',
  inputParameterChanges: 'void *',
  outputParameterChanges: 'void *',
  inputEvents: 'void *',
  outputEvents: 'void *',
  processContext: 'void *',
})

/** base::ViewRect: four int32, right and bottom are exclusive edges. */
const ViewRect = koffi.struct('ODViewRect', {
  left: 'int32_t',
  top: 'int32_t',
  right: 'int32_t',
  bottom: 'int32_t',
})

/** Write a {width, height} into a ViewRect the plugin will read. */
function encodeRect(pointer, width, height) {
  koffi.encode(pointer, 0, 'int32', 0)
  koffi.encode(pointer, 4, 'int32', 0)
  koffi.encode(pointer, 8, 'int32', Math.max(1, Math.round(width)))
  koffi.encode(pointer, 12, 'int32', Math.max(1, Math.round(height)))
}

function decodeRect(pointer) {
  const left = koffi.decode(pointer, 0, 'int32_t')
  const top = koffi.decode(pointer, 4, 'int32_t')
  const right = koffi.decode(pointer, 8, 'int32_t')
  const bottom = koffi.decode(pointer, 12, 'int32_t')
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

// ------------------------------------------------------------------ plugin
class Vst3Plugin {
  constructor(bundlePath) {
    this.path = bundlePath
    this.binary = vst3Binary(bundlePath)
    if (!this.binary) throw new Error('o pacote .vst3 não tem binário de 64 bits para Windows')
    this.closed = false
    this.host = makeHost()
    this.calls = []
    // Parameter values the producer set for the next pass, as {id, value}.
    this.pending = []
    // Parameter values the plugin reported back on the last pass, by id.
    this.reported = new Map()
    // Parameter names by id, filled by describe() and read back by the panel
    // when the plugin reports a value of its own.
    this.names = new Map()
    // The plugin's own window, once opened: {view, window, frame, …}. A VST3
    // builds it as a child of the HWND we hand it, so the host owns the frame
    // and the plugin owns everything inside it.
    this.editor = null

    this.lib = koffi.load(this.binary)
    trace('passo 1 binário carregado', this.binary)
    let entry
    try {
      entry = this.lib.func('void * GetPluginFactory()')
    } catch {
      throw new Error('o .vst3 não exporta GetPluginFactory')
    }
    const raw = entry()
    trace('passo 2 fábrica obtida')
    if (!raw) throw new Error('GetPluginFactory devolveu nulo')
    // The factory is a singleton the module keeps; the reference we get is ours
    // to drop, and QI up to version 3 for the unicode class names.
    this.factory = raw
    // Null, not the version 1 pointer. Every slot past 6 belongs to a later
    // interface, and calling slot 8 on a factory that never answered for
    // IPluginFactory3 is calling whatever the singleton's heap happens to have
    // next — which is a crash, not a "no".
    this.factory3 = queryInterface(raw, 'IPluginFactory3')
    trace('passo 3 fábrica v3:', this.factory3 ? 'sim' : 'não')

    this.classes = this.#enumerateClasses()
    this.cid = pickAudioModule(this.classes)
    trace('passo 4 classes lidas:', this.classes.length)
    if (!this.cid) {
      const seen = this.classes.map((entry) => `${entry.category}/${entry.name}`).join(', ') || 'nenhuma classe'
      throw new Error(`nenhuma classe Áudio neste VST3 (${seen})`)
    }
  }

  #enumerateClasses() {
    // IPluginFactory: 3 getFactoryInfo, 4 countClasses, 5 getClassInfo,
    // 6 createInstance. IPluginFactory2 adds 7 getClassInfo2; IPluginFactory3
    // adds 8 getClassInfoUnicode and 9 setHostContext — only two slots, so a
    // host that guesses "9 = unicode" ends up calling setHostContext with an
    // integer and lets the plugin read a pointer out of the argument register.
    const total = Number(method(this.factory, 4, PROTO.count)(this.factory))
    const plainCall = method(this.factory, 5, PROTO.indexOut) // getClassInfo
    const unicodeCall = this.factory3 ? method(this.factory3, 8, PROTO.indexOut) : null // getClassInfoUnicode
    const out = []
    for (let index = 0; index < Math.max(0, Math.min(64, total)); index += 1) {
      const narrow = hostBuffer(koffi.sizeof(PClassInfo))
      if (plainCall(this.factory, index, narrow) !== kResultOk) continue
      const info = koffi.decode(narrow, PClassInfo)
      const cid = Buffer.from(Array.from(info.cid, (byte) => byte & 0xff))
      const entry = {
        cid,
        category: fromChars(info.category),
        name: fromChars(info.name),
        vendor: '',
        version: '',
        subCategories: '',
        unicode: false,
      }
      // The unicode record is the one carrying vendor, version and the
      // sub-categories the FX list sorts by. Slot 8 is only reached when the
      // factory actually answered for IPluginFactory3 — on a version 1 factory
      // that slot is past the end of its vtable. And a factory that does not
      // really implement version 3 answers with an error or with something
      // else's class id, so the id has to agree before any of it is trusted.
      const wide = hostBuffer(koffi.sizeof(PClassInfoW))
      if (this.factory3 && unicodeCall(this.factory3, index, wide) === kResultOk) {
        const w = koffi.decode(wide, PClassInfoW)
        const wideCid = Buffer.from(Array.from(w.cid, (byte) => byte & 0xff))
        if (wideCid.equals(cid)) {
          entry.name = fromChars(w.name) || entry.name
          entry.vendor = fromChars(w.vendor)
          entry.version = fromChars(w.version)
          entry.subCategories = fromChars(w.subCategories)
          entry.unicode = true
        }
      }
      out.push(entry)
    }
    if (out.some((entry) => entry.unicode)) {
      try {
        method(this.factory3, 9, PROTO.object)(this.factory3, this.host.hostApplication.ptr)
      } catch {
        // A factory that faults on its own version 3 method is not worth
        // fighting: the class list is already in hand.
      }
    }
    return out
  }

  // ---------------------------------------------------------- open/close
  /**
   * Everything after the factory is lazy: a plugin that cannot initialise does
   * not stop the class list from being read, so the panel can still say what is
   * sitting in the folder.
   */
  #ensureComponent() {
    if (this.component) return
    const out = koffi.alloc('void *', 1)
    this.createTarget = this.factory3 ?? this.factory
    const create = method(this.createTarget, 6, PROTO.create)
    const result = create(this.createTarget, this.cid, IID_BUFFER.IComponent, out)
    const component = koffi.decode(out, 'void *')
    if (result !== kResultOk || !component) throw new Error(`não deu para instanciar o componente (código ${result})`)
    this.component = component
    trace('passo 5 componente criado')

    // IoMode and the controller class id are both asked for before initialize.
    const controllerCid = hostBuffer(16)
    const controllerIdCall = method(component, 5, PROTO.cidOut) // getControllerClassId(TUID& out)
    this.controllerCid = controllerIdCall(component, controllerCid) === kResultOk ? controllerCid : null
    try {
      method(component, 6, PROTO.oneInt)(component, kSimple)
    } catch {
      // Older builds without setIoMode are fine: simple mode is the default.
    }
    const init = method(component, 3, PROTO.init)
    const started = init(component, this.host.hostApplication.ptr)
    trace('passo 6 initialize ->', started)
    if (started !== kResultOk) throw new Error(`initialize do componente falhou (código ${started})`)

    this.processor = queryInterface(component, 'IAudioProcessor')
    this.controller = queryInterface(component, 'IEditController')
    trace('passo 7 processador e controller:', this.processor ? 'sim' : 'não', this.controller ? 'sim' : 'não')
    if (!this.controller && this.controllerCid) {
      // A controller living in its own class (the usual VST3 layout for plugins
      // with a GUI): create it, initialize it, and hand it the component's
      // state, which is the only way its knobs start where the audio part is.
      const ctrlOut = koffi.alloc('void *', 1)
      const created = create(this.createTarget, this.controllerCid, IID_BUFFER.IEditController, ctrlOut)
      const controller = koffi.decode(ctrlOut, 'void *')
      if (created === kResultOk && controller) {
        method(controller, 3, PROTO.init)(controller, this.host.hostApplication.ptr)
        this.controller = controller
      }
    }
    if (this.controller) {
      try {
        // setComponentHandler is slot 16 on the controller: 0 qi, 1 addRef,
        // 2 release, 3 initialize, 4 terminate, 5 setComponentState, 6 setState,
        // 7 getState, 8 getParameterCount, 9 getParameterInfo, 10 getString,
        // 11 getValueByString, 12 normalizedToPlain, 13 plainToNormalized,
        // 14 getParamNormalized, 15 setParamNormalized, 16 setComponentHandler.
        method(this.controller, 16, PROTO.object)(this.controller, this.host.componentHandler.ptr)
      } catch {
        // A controller without a handler still processes; it just cannot talk.
      }
      this.#connectParts()
      trace('passo 9 controller conectado:', this.connected ? 'sim' : 'não')
    }
    trace('passo 10 componente pronto')
  }

  /**
   * A VST3 is two objects: the component (audio) and the controller (names,
   * values, GUI). Setting the component handler only lets the controller talk to
   * the host — the plugin's own halves are joined through IConnectionPoint, in
   * both directions, and then the controller is handed the component's state
   * with setComponentState. Steinberg spells this out in the API documentation
   * for exactly this reason: a host that skips it gets a plugin that loads,
   * makes noise and reports nothing. AmpliTube 5 is the proof — its controller
   * answers getParameterCount with 0 until it has been connected and given the
   * state, so the FX window would show an empty rack on a plugin with hundreds
   * of parameters.
   */
  #connectParts() {
    if (this.connected || !this.controller || !this.component) return
    const componentPoint = queryInterface(this.component, 'IConnectionPoint')
    const controllerPoint = queryInterface(this.controller, 'IConnectionPoint')
    if (componentPoint && controllerPoint) {
      const fromComponent = method(componentPoint, 3, PROTO.connect) // connect(other)
      const fromController = method(controllerPoint, 3, PROTO.connect)
      try {
        fromComponent(componentPoint, controllerPoint)
        this.connected = Number(fromController(controllerPoint, componentPoint)) === kResultOk
      } catch (error) {
        trace('connect falhou:', error.message)
        this.connected = false
      }
    }
    if (!this.connected) return
    const stream = makeStream()
    this.stream = stream
    try {
      const getState = method(this.component, 13, PROTO.object) // IComponent::getState
      const grabbed = Number(getState(this.component, stream.ptr))
      trace('componente devolveu', grabbed, 'para getState,', stream.length, 'bytes')
      if (grabbed === kResultOk) {
        stream.rewind()
        const setComponentState = method(this.controller, 5, PROTO.object) // IEditController::
        Number(setComponentState(this.controller, stream.ptr))
      }
    } catch (error) {
      // A plugin that faults on its own state is still usable for a bounce.
      trace('estado falhou:', error.message)
    }
  }

  #ensureProcessor() {
    this.#ensureComponent()
    if (!this.processor) throw new Error('este VST3 não expõe IAudioProcessor — pode ser um instrumento sem áudio')
    if (this.setup) return
    const setup = hostBuffer(koffi.sizeof(ProcessSetup))
    koffi.encode(setup, 0, 'int32', kRealtime)
    koffi.encode(setup, 4, 'int32', kSample32)
    koffi.encode(setup, 8, 'int32', MAX_BLOCK)
    koffi.encode(setup, 16, 'double', this.sampleRate)
    const result = method(this.processor, 7, PROTO.setup)(this.processor, setup)
    if (result !== kResultOk) throw new Error(`setupProcessing falhou (código ${result})`)
    this.#activateBuses()
    this.setup = true
  }

  #busCount(direction) {
    const call = method(this.component, 7, PROTO.twoInt) // getBusCount(mediaType, dir)
    return Math.max(0, Number(call(this.component, kAudio, direction)))
  }

  #busInfo(direction, index) {
    const buffer = hostBuffer(koffi.sizeof(BusInfo))
    const call = method(this.component, 8, PROTO.busInfo) // getBusInfo(type, dir, index, BusInfo&)
    if (Number(call(this.component, kAudio, direction, index, buffer)) !== kResultOk) return null
    return koffi.decode(buffer, BusInfo)
  }

  /**
   * The parameter changes a plugin reads on every block: IParameterChanges, a
   * list of IParamValueQueue, each queue one parameter's (sampleOffset, value)
   * points. Both are host interfaces, so the plugin calls into koffi callbacks
   * and the queues are JS arrays — no struct layout to guess, and a plugin that
   * asks for a queue it never got is answered with null, which is the documented
   * behaviour.
   *
   * Without this, `process` would run on whatever default the plugin woke up
   * with: the sliders in the FX window would move and the bounce would ignore
   * them.
   *
   * A queue is built once per parameter id and then reused. Plugins are allowed
   * to hold on to the IParamValueQueue pointer they were handed, so a host that
   * rebuilds the objects per block hands back a pointer to memory koffi has
   * already collected — which is a crash that only shows up on the third bounce.
   */
  #makeChanges() {
    const pool = new Map()
    const active = []
    const roots = []

    const entryFor = (id) => {
      let entry = pool.get(id)
      if (entry) return entry
      const points = []
      const object = comObject([
        { proto: PROTO.query, handler: (_s, args) => hostQuery(object, args, ['FUnknown', 'IParamValueQueue']) },
        { proto: PROTO.count, handler: () => 1 },
        { proto: PROTO.count, handler: () => 1 },
        { proto: PROTO.queueId, handler: () => id },
        { proto: PROTO.count, handler: () => points.length },
        {
          proto: PROTO.queuePoint,
          handler: (_s, [index, offsetOut, valueOut]) => {
            const wanted = Number(index)
            if (!offsetOut || !valueOut || wanted < 0 || wanted >= points.length) return kNoInterface
            koffi.encode(offsetOut, 0, 'int32', points[wanted][0])
            koffi.encode(valueOut, 0, 'double', points[wanted][1])
            return kResultOk
          },
        },
        {
          proto: PROTO.queueAddPoint,
          handler: (_s, [offset, value, indexOut]) => {
            points.push([Number(offset) | 0, Number(value) || 0])
            if (indexOut) koffi.encode(indexOut, 0, 'int32', points.length - 1)
            return kResultOk
          },
        },
      ])
      roots.push(object)
      entry = { id, points, object }
      pool.set(id, entry)
      return entry
    }

    const changes = comObject([
      { proto: PROTO.query, handler: (_s, args) => hostQuery(changes, args, ['FUnknown', 'IParameterChanges']) },
      { proto: PROTO.count, handler: () => 1 },
      { proto: PROTO.count, handler: () => 1 },
      { proto: PROTO.count, handler: () => active.length }, // getParameterCount
      {
        // getParameterData returns the queue pointer, not a result code.
        proto: PROTO.queueAt,
        handler: (_s, [index]) => active[Number(index)]?.object.ptr ?? 0,
      },
      {
        // addParameterData(const ParamID&, int32& index) -> IParamValueQueue*
        proto: PROTO.queueAdd,
        handler: (_s, [idRef, indexOut]) => {
          const wanted = Number(koffi.decode(idRef, 'uint32')) >>> 0
          const entry = entryFor(wanted)
          if (!active.includes(entry)) active.push(entry)
          if (indexOut) koffi.encode(indexOut, 0, 'int32', active.indexOf(entry))
          return entry.object.ptr
        },
      },
    ])
    roots.push(changes)

    return {
      pointer: changes.ptr,
      roots,
      // One point at sample 0 carries the whole block: a bounce sets each
      // parameter once, before the first sample, which is what a static FX
      // setting means. The points are refilled in place, so the pointer the
      // plugin was given stays valid.
      fill(entries) {
        active.length = 0
        for (const entry of entries) {
          const id = Number(entry.id) >>> 0
          const pooled = entryFor(id)
          pooled.points.length = 0
          pooled.points.push([0, Math.min(1, Math.max(0, Number(entry.value) || 0))])
          active.push(pooled)
        }
      },
      /** Empty list for the next block, without throwing away the queues. */
      reset() {
        active.length = 0
        for (const entry of pool.values()) entry.points.length = 0
      },
      /**
       * What the plugin wrote this block. An effect reports its meters and a
       * controller-driven GUI moves knobs on its own through this same
       * interface, so reading it back is what lets the panel follow the plugin
       * instead of only telling it what to do.
       */
      harvest() {
        const values = []
        for (const entry of active) {
          const last = entry.points[entry.points.length - 1]
          if (last) values.push({ id: entry.id, value: last[1] })
        }
        return values
      },
      release() {
        for (const root of roots) {
          for (const fn of root.keep.fns) {
            try {
              koffi.unregister(fn)
            } catch {
              // a callback the plugin already dropped cannot be unregistered twice
            }
          }
        }
        roots.length = 0
        active.length = 0
        pool.clear()
      },
    }
  }

  /**
   * The audio buffers of the offline pass, kept on the instance and rebuilt only
   * when a longer clip or a different channel count comes along. Same reason as
   * the parameter queues: the plugin may still be reading the block it was last
   * handed, and koffi frees an `alloc` result as soon as JS loses track of it.
   *
   * There is no JavaScript view of this memory, and that is deliberate: the only
   * way koffi gives one (`koffi.view`) aborts the Electron build of Node instead
   * of wrapping the address. Each block is written and read with one encode or
   * decode call, which is the same copy a view would have made, just once per
   * 512 samples instead of once per sample.
   */
  #ioBuffers(length, inChannels, outChannels) {
    const shared = inChannels === outChannels
    const buffers = (this.buffers ??= { capacity: 0, ins: [], outs: [], structs: null, scratch: null })
    if (buffers.capacity < length) {
      // One block per channel, however long the clip is: every pass writes the
      // block at the head of the buffer and tells the plugin how many samples it
      // holds, so a five-minute take costs the same memory as a five-second one.
      const allocate = (count) =>
        Array.from({ length: count }, () => {
          const pointer = keep('float', MAX_BLOCK)
          return { pointer, address: Number(pointer) }
        })
      buffers.ins = allocate(inChannels)
      buffers.outs = shared ? buffers.ins : allocate(outChannels)
      buffers.capacity = length
      buffers.structs = null
      buffers.scratch ??= new Float32Array(MAX_BLOCK)
    }
    if (buffers.ins.length !== inChannels || buffers.outs.length !== outChannels) {
      // A plugin asked for a different channel count than last time: rebuild.
      buffers.structs = null
      buffers.capacity = 0
      return this.#ioBuffers(length, inChannels, outChannels)
    }
    if (!buffers.structs) {
      // Two extra AudioBusBuffers of slack: a plugin that owns a sidechain or a
      // link bus sometimes walks past the bus count it was told about, and a
      // zeroed record (numChannels 0) is a harmless answer while a stray pointer
      // is a crash.
      const encodeBus = (list) => {
        const stride = koffi.sizeof(AudioBusBuffers)
        const buffer = hostBuffer(stride * (list.length + 2))
        koffi.encode(buffer, 0, 'int32', list.length)
        koffi.encode(buffer, 8, 'uint64', BigInt(0))
        const array = keep('void *', list.length)
        list.forEach((entry, index) => koffi.encode(array, index * 8, 'void *', entry.pointer))
        koffi.encode(buffer, 16, 'void *', array)
        return { buffer, array }
      }
      const inputs = encodeBus(buffers.ins)
      const outputs = encodeBus(buffers.outs)
      // ProcessData, field by field at the offsets koffi computed: the two bus
      // pointers sit at 24 and 32, and the four int32s before them are at 0, 4,
      // 8, 12 — writing numInputs at 16 leaves the plugin with no bus at all.
      const data = hostBuffer(koffi.sizeof(ProcessData))
      koffi.encode(data, 0, 'int32', kRealtime)
      koffi.encode(data, 4, 'int32', kSample32)
      koffi.encode(data, 12, 'int32', 1) // numInputs
      koffi.encode(data, 16, 'int32', 1) // numOutputs
      koffi.encode(data, 24, 'void *', inputs.buffer)
      koffi.encode(data, 32, 'void *', outputs.buffer)
      buffers.structs = { data, inputs, outputs }
    }
    return { ...buffers.structs, ins: buffers.ins, outs: buffers.outs, shared, scratch: buffers.scratch }
  }

  /** Main audio busses on both sides, the same ones REAPER hands to the plugin. */

  #activateBuses() {
    const activate = method(this.component, 10, PROTO.threeIntBool) // activateBus
    this.inputs = Math.max(0, this.#busCount(kInput))
    this.outputs = Math.max(0, this.#busCount(kOutput))
    this.inputChannels = Math.max(1, Number(this.#busInfo(kInput, 0)?.channelCount ?? 2))
    this.outputChannels = Math.max(1, Number(this.#busInfo(kOutput, 0)?.channelCount ?? 2))
    // Only the main bus of each direction gets activated. A plugin can expose a
    // sidechain or a "link" bus on top, and feeding one nothing while calling it
    // active is how a gate-style plugin ends up printing silence.
    activate(this.component, kAudio, kInput, 0, 1)
    activate(this.component, kAudio, kOutput, 0, 1)
    this.buses = [
      ...Array.from({ length: this.inputs }, (_, index) => ({ side: 'in', index, info: this.#busInfo(kInput, index) })),
      ...Array.from({ length: this.outputs }, (_, index) => ({ side: 'out', index, info: this.#busInfo(kOutput, index) })),
    ].map((entry) => ({
      direction: entry.side,
      name: fromChars(entry.info?.name ?? ''),
      channels: Number(entry.info?.channelCount ?? 0),
      type: Number(entry.info?.busType ?? 0), // 0 Main, 1 Auxiliary (sidechain), 2 Link…
    }))
    try {
      method(this.component, 11, PROTO.oneInt)(this.component, 1) // setActive(true)
    } catch {
      // setActive is bookkeeping; processing works without it on every plugin tested.
    }
  }

  // ---------------------------------------------------------- parameters
  parameterCount() {
    if (!this.controller) return 0
    try {
      return Math.max(0, Number(method(this.controller, 8, PROTO.count)(this.controller)))
    } catch {
      return 0
    }
  }

  parameterAt(index) {
    const buffer = hostBuffer(koffi.sizeof(ParameterInfo))
    const call = method(this.controller, 9, PROTO.indexOut)
    if (Number(call(this.controller, index, buffer)) !== kResultOk) return null
    const info = koffi.decode(buffer, ParameterInfo)
    let plain = info.defaultNormalizedValue
    try {
      plain = Number(method(this.controller, 12, PROTO.paramToPlain)(this.controller, info.id, info.defaultNormalizedValue))
    } catch {
      // no conversion available: the normalized value is the best number to show
    }
    // The plugin's own rendering of the value ("-80.0 dB", "Plate A"), which is
    // what a producer expects to read next to a knob instead of 0.000.
    let text = ''
    try {
      const holder = hostBuffer(128 * 2)
      const call = method(this.controller, 10, PROTO.paramString)
      if (Number(call(this.controller, info.id, info.defaultNormalizedValue, holder)) === kResultOk) {
        text = fromChars(koffi.decode(holder, String128))
      }
    } catch {
      // optional method: the plain number is still a usable readout
    }
    return {
      id: info.id,
      title: fromChars(info.title),
      shortTitle: fromChars(info.shortTitle),
      units: fromChars(info.units),
      stepCount: info.stepCount,
      value: info.defaultNormalizedValue,
      plain,
      text,
      flags: info.flags,
    }
  }

  setParameterId(id, value) {
    const clamped = Math.min(1, Math.max(0, Number(value) || 0))
    // The controller holds the value the panel shows, and the same value is
    // queued as a change for every block of the next pass: a plugin is allowed
    // to read parameters only from ProcessData.inputParameterChanges.
    const wanted = Number(id) >>> 0
    const existing = this.pending.find((entry) => entry.id === wanted)
    if (existing) existing.value = clamped
    else this.pending.push({ id: wanted, value: clamped })
    if (!this.controller) return
    method(this.controller, 15, PROTO.setParam)(this.controller, wanted, clamped)
  }

  parameterValueId(id) {
    if (!this.controller) return 0
    return Number(method(this.controller, 14, PROTO.getParam)(this.controller, id))
  }

  /**
   * The parameter values the plugin sent back on the last pass, as
   * {id, value, name}. An effect's meters and a GUI that moved a knob on its own
   * both arrive here, so the FX window can follow the plugin instead of only
   * telling it what to do.
   */
  reportedValues() {
    const listed = []
    for (const [id, value] of this.reported) {
      listed.push({ id, value: clamp01(value), name: this.names.get(id) ?? `#${id}` })
    }
    return listed
  }

  /**
   * The VST2-shaped entry point, so the worker can drive either kind of plugin
   * with the index the panel showed. A VST3 has no parameter indexes: this maps
   * the index onto the id that was listed for it.
   */
  setParameter(index, value) {
    const total = this.parameterCount()
    const wanted = Number(index)
    if (Number.isInteger(wanted) && wanted >= 0 && wanted < total) {
      const info = this.parameterAt(wanted)
      if (info) {
        this.setParameterId(info.id, value)
        return
      }
    }
    // A VST3 has no parameter indexes: the panel lists them by id (Bypass is
    // 65536 by spec), so anything that is not a position is taken as the id.
    if (Number.isInteger(wanted) && wanted >= 0) this.setParameterId(wanted, value)
  }

  /**
   * The same mapping read backwards: what the controller holds at this index
   * right now. The panel needs it to show the number the plugin actually took,
   * rather than the one it typed, and the desktop test uses it to prove a value
   * sent from OpenDAW arrived inside the plugin.
   */
  parameterValue(index) {
    const total = this.parameterCount()
    const wanted = Number(index)
    if (Number.isInteger(wanted) && wanted >= 0 && wanted < total) {
      const info = this.parameterAt(wanted)
      if (info) return this.parameterValueId(info.id)
    }
    if (Number.isInteger(wanted) && wanted >= 0) return this.parameterValueId(wanted)
    return 0
  }

  // ---------------------------------------------------------- describe
  /** The manufacturer string off the factory record, for classes too old to
   *  carry a vendor of their own (Gateway is one of them). */
  #factoryVendor() {
    if (this.vendorText !== undefined) return this.vendorText
    this.vendorText = ''
    try {
      const buffer = hostBuffer(koffi.sizeof(PFactoryInfo))
      if (Number(method(this.factory, 3, PROTO.factoryInfo)(this.factory, buffer)) === kResultOk) {
        this.vendorText = fromChars(koffi.decode(buffer, PFactoryInfo).vendor)
      }
    } catch {
      // A factory that faults on its own info is still able to hand out plugins.
    }
    return this.vendorText
  }

  describe(sampleRate = 48000) {
    this.sampleRate = sampleRate
    const klass = this.classes.find((entry) => sameCid(entry.cid, this.cid)) ?? this.classes[0] ?? {}
    const out = {
      kind: 'vst3',
      path: this.path,
      file: path.basename(this.path),
      binary: this.binary,
      name: klass.name || path.basename(this.path),
      vendor: klass.vendor || this.#factoryVendor(),
      product: klass.name || '',
      version: klass.version || '',
      subCategories: klass.subCategories || '',
      classes: this.classes.map((entry) => `${entry.category}: ${entry.name}`),
      numParams: 0,
      numPrograms: 0,
      numInputs: 0,
      numOutputs: 0,
      initialDelay: 0,
      tail: 0,
      hasEditor: false,
      isSynth: /Instrument/i.test(String(klass.subCategories ?? '')),
      connection: this.controller ? 'controller sem conexão' : 'sem controller',
      bypassId: null,
      buses: [],
      params: [],
      hostCalls: [],
      canDo: [],
    }
    try {
      this.#ensureComponent()
    } catch (error) {
      out.error = error.message
      return out
    }
    const total = this.parameterCount()
    // A controller is what an editor is made from, so the FX list can say it has
    // an interface of its own before anyone tries to open one.
    out.hasEditor = Boolean(this.controller)
    trace('passo 11 contagem de parâmetros:', total)
    const shown = []
    for (let index = 0; index < Math.min(total, 256); index += 1) {
      try {
      const parameter = this.parameterAt(index)
        if (parameter) {
          if (parameter.flags & (1 << 16)) out.bypassId = parameter.id // kIsBypass
          this.names.set(parameter.id, parameter.title || parameter.shortTitle || `#${parameter.id}`)
          shown.push({
            index: parameter.id,
            name: parameter.title || parameter.shortTitle || `#${parameter.id}`,
            label: parameter.units || '',
            display: parameter.text || (Number.isFinite(parameter.plain) ? parameter.plain.toFixed(3) : ''),
            value: clamp01(parameter.value),
            steps: Number(parameter.stepCount ?? 0),
            automation: Boolean(parameter.flags & 1) || !(parameter.flags & 2),
          })
        }
      } catch {
        // One unreadable parameter must not lose the rest of the list.
      }
    }
    out.numParams = total
    out.params = shown
    out.connection = this.controller
      ? this.connected
        ? 'componente + controller conectados'
        : 'controller sem IConnectionPoint (nomes e valores ainda chegam)'
      : 'sem controller (não tem parâmetros nem GUI)'
    if (this.processor) {
      try {
        this.#ensureProcessor()
        out.numInputs = this.inputChannels
        out.numOutputs = this.outputChannels
        out.initialDelay = Number(method(this.processor, 6, PROTO.plainValue)(this.processor))
        out.tail = Number(method(this.processor, 10, PROTO.plainValue)(this.processor))
        // A VST3 has no canDo; what it can say is which sample sizes it
        // processes, and that is exactly what decides a 64-bit bounce.
        const canSize = method(this.processor, 5, PROTO.oneInt)
        out.canDo = [
          canSize(this.processor, 0) === kResultOk ? '32-bit float' : '',
          canSize(this.processor, 1) === kResultOk ? '64-bit float' : '',
        ].filter(Boolean)
        out.buses = this.buses ?? []
        trace('passo 12 processador pronto, barramentos:', this.buses?.length ?? 0)
      } catch (error) {
        out.processError = error.message
      }
    } else {
      out.error = 'sem IAudioProcessor: este VST3 não processa áudio'
    }
    out.hostCalls = this.host.objects.calls.map(String)
    return out
  }

  // ---------------------------------------------------------- render
  /**
   * Offline pass, block by block, in place: the same memory is handed over as
   * input and output, which is what kSimpleMode means and what the plugin
   * expects when it copies the input across first.
   */
  render(input, sampleRate) {
    this.sampleRate = sampleRate
    this.#ensureProcessor()

    const source = Array.isArray(input) ? input : [input]
    const length = Math.max(...source.map((channel) => channel.length))
    const inChannels = Math.max(1, this.inputChannels)
    const outChannels = Math.max(1, this.outputChannels)
    const { data, ins, outs, shared, scratch } = this.#ioBuffers(length, inChannels, outChannels)

    this.changes ??= this.#makeChanges()
    // The four pointer fields after the bus arrays. All of them are filled: a
    // null here is a crash waiting for the plugin that dereferences it, and the
    // outgoing parameter list is also how the plugin talks back to us.
    this.outgoing ??= this.#makeChanges()
    this.eventLists ??= { in: makeEventList('entrada'), out: makeEventList('saída') }
    koffi.encode(data, 40, 'void *', this.changes.pointer) // inputParameterChanges
    koffi.encode(data, 48, 'void *', this.outgoing.pointer) // outputParameterChanges
    koffi.encode(data, 56, 'void *', this.eventLists.in.ptr) // inputEvents
    koffi.encode(data, 64, 'void *', this.eventLists.out.ptr) // outputEvents

    const outputs = outs.map(() => new Float32Array(length))
    const process = method(this.processor, 9, PROTO.process)
    method(this.processor, 8, PROTO.oneInt)(this.processor, 1) // setProcessing(true)

    // One block of samples into and out of host memory, with the same short
    // helper for both directions so nothing here ever wraps an address the way
    // koffi.view does (see #ioBuffers). The block always starts at the buffer the
    // plugin was handed: `numSamples` says how many of them to read, so an
    // offset here would be the plugin hearing silence from the second block on.
    const putBlock = (entry, values, size) =>
      koffi.encode(entry.address, 'float', values.subarray(0, size), size)
    const readBlock = (entry, size) => koffi.decode(entry.address, 'float', size)

    for (let offset = 0; offset < length; offset += MAX_BLOCK) {
      const size = Math.min(MAX_BLOCK, length - offset)
      koffi.encode(data, 8, 'int32', size)
      for (let channel = 0; channel < inChannels; channel += 1) {
        const from = source[channel] ?? source[0]
        scratch.fill(0, 0, size)
        scratch.set(from.subarray(offset, Math.min(from.length, offset + size)), 0)
        putBlock(ins[channel], scratch, size)
      }
      if (!shared) {
        scratch.fill(0, 0, size)
        for (const entry of outs) putBlock(entry, scratch, size)
      }
      // The producer's values travel as a change queue per block: a plugin reads
      // them, not the controller's memory, and a queue left empty means defaults.
      this.changes.fill(this.pending)
      this.outgoing.reset()
      const result = Number(process(this.processor, data))
      if (result !== kResultOk) {
        throw new Error(`process falhou no bloco ${offset / MAX_BLOCK} (código ${result})`)
      }
      // Whatever the plugin queued on the way out is remembered, last value
      // wins, so a meter or a GUI-driven knob ends up where the panel can read
      // it after the pass instead of being thrown away.
      for (const change of this.outgoing.harvest()) this.reported.set(change.id, change.value)
      this.outgoing.reset()
      outs.forEach((entry, channel) => {
        outputs[channel].set(readBlock(entry, size), offset)
      })
    }
    // Nothing may stay queued for the next pass, or a bounce would inherit it.
    this.changes.reset()
    this.outgoing.reset()
    this.pending = []

    try {
      method(this.processor, 8, PROTO.oneInt)(this.processor, 0) // setProcessing(false)
    } catch {
      // already finished; the plugin will be torn down anyway
    }
    return outputs
  }

  // ---------------------------------------------------------- editor (GUI)
  /**
   * The plugin's own window, in four calls: createView("editor") hands out an
   * IPlugView, setFrame gives that view a way to ask for a different size,
   * attached gives it the HWND it builds its child window inside, and onSize
   * tells it when the host changed the window under it. Everything Win32 — the
   * frame, the message pump, laying the canvas out — is the same plugin-gui.cjs
   * layer the VST2 editor uses, so the producer sees one kind of window no
   * matter which API the plugin speaks.
   */
  hasEditor() {
    try {
      this.#ensureComponent()
    } catch {
      return false
    }
    return Boolean(this.controller)
  }

  #title() {
    if (this.editorTitle === undefined) {
      const klass = this.classes.find((entry) => sameCid(entry.cid, this.cid)) ?? this.classes[0]
      this.editorTitle = klass?.name ?? ''
    }
    return this.editorTitle
  }

  /**
   * One reusable ViewRect-sized block. Every rect that crosses to the plugin is
   * read or written inside the same synchronous call, and a fresh keep() per
   * resize would pin memory the process never gives back.
   */
  #scratch() {
    this.rectScratch ??= keep('uint8_t', koffi.sizeof(ViewRect))
    return this.rectScratch
  }

  /** IPlugView::isPlatformTypeSupported, for the type the window is asked in. */
  #platformAccepted(view, type) {
    try {
      return Number(method(view, 3, PROTO.typeName)(view, type)) === kResultOk
    } catch {
      return false
    }
  }

  /** IPlugView::getSize — the canvas size the plugin wants, or null. */
  #viewSize(view) {
    const rect = this.#scratch()
    encodeRect(rect, 0, 0)
    try {
      if (Number(method(view, 9, PROTO.rect)(view, rect)) !== kResultOk) return null
    } catch {
      return null
    }
    return decodeRect(rect)
  }

  /**
   * IPlugView::checkSizeConstraint — the size the plugin will actually accept.
   * A view that refuses to answer keeps the size we asked for, which is what
   * the SDK means by "if not, adjust the rect": the host may not insist.
   */
  #constrain(view, width, height) {
    const asked = {
      width: Math.max(40, Math.min(6000, Math.round(width))),
      height: Math.max(30, Math.min(6000, Math.round(height))),
    }
    const rect = this.#scratch()
    encodeRect(rect, asked.width, asked.height)
    try {
      if (Number(method(view, 14, PROTO.rect)(view, rect)) !== kResultOk) return asked
    } catch {
      return asked
    }
    const out = decodeRect(rect)
    if (out.width < 20 || out.height < 20) return asked
    return {
      width: Math.min(6000, out.width),
      height: Math.min(6000, out.height),
    }
  }

  /**
   * The host side of resizing: IPlugFrame, one method (slot 3, resizeView).
   * A plugin calls it when its own layout changed, and the host is required to
   * resize the platform window and then tell the view through onSize. The
   * request is only noted here, never acted on in place: it can arrive inside
   * attached(), while the window is still being built, and a Win32 resize from
   * under the plugin's own stack is how a re-entrant paint wedges a worker. The
   * pump picks the note up.
   */
  #makePlugFrame() {
    const self = {}
    const object = comObject([
      { proto: PROTO.query, handler: (_s, args) => hostQuery(self, args, ['FUnknown', 'IPlugFrame']) },
      { proto: PROTO.count, handler: () => 1 },
      { proto: PROTO.count, handler: () => 1 },
      {
        proto: PROTO.resizeView,
        handler: (_s, [view, rectPointer]) => {
          try {
            if (!rectPointer) return kInvalidArgument
            const size = decodeRect(rectPointer)
            noteCall(this.host.objects, 'resizeView', [view])
            if (size.width > 0 && size.height > 0) {
              this.resizeRequested = { width: size.width, height: size.height, view }
            }
          } catch {
            // A bad pointer is a bad request: the window simply keeps its size.
            return kResultFalse
          }
          return kResultOk
        },
      },
    ])
    Object.defineProperty(self, 'ptr', { value: object.ptr })
    return { self, object }
  }

  /** Resize the window to what the plugin asked for, then tell the view. */
  #applyResize() {
    const want = this.resizeRequested
    if (!want) return
    this.resizeRequested = null
    const editor = this.editor
    if (!editor || !gui.alive(editor.window)) return
    const inner = gui.clientSize(editor.window)
    if (!inner) return
    if (Math.abs(inner.width - want.width) <= 1 && Math.abs(inner.height - want.height) <= 1) return
    editor.resizedByPlugin = true
    gui.resizeClient(editor.window, want.width, want.height)
    gui.fitChildren(editor.window)
    // The SDK is explicit about the order: after resizeView the host has to call
    // onSize with the new rect, or the view keeps drawing at the old one.
    try {
      const rect = this.#scratch()
      encodeRect(rect, want.width, want.height)
      Number(method(want.view ?? editor.view, 10, PROTO.rect)(want.view ?? editor.view, rect))
    } catch {
      // A view that faults on its own resize still has a window on screen.
    }
  }

  /**
   * The client area changed under us — the producer dragged the frame or the app
   * re-placed the panel. In the order the SDK asks: check the constraint, then
   * onSize with the size that survived it.
   */
  #hostResized(size) {
    const editor = this.editor
    if (!editor || this.notifyingSize || !gui.alive(editor.window)) return
    this.notifyingSize = true
    try {
      const allowed = this.#constrain(editor.view, size.width, size.height)
      const rect = this.#scratch()
      encodeRect(rect, allowed.width, allowed.height)
      Number(method(editor.view, 10, PROTO.rect)(editor.view, rect))
    } catch {
      // The next pump retries; a missed onSize is a stale layout, not a crash.
    } finally {
      this.notifyingSize = false
    }
  }

  /**
   * Open the plugin's window. `rect` is where the app wants it, in physical
   * screen pixels; the size in it is only a fallback, because the plugin's own
   * getSize/checkSizeConstraint answers decide the canvas.
   */
  openEditor(rect = {}, options = {}) {
    this.#ensureComponent()
    if (!this.controller) throw new Error('este VST3 não expõe IEditController — não há interface própria para mostrar')
    if (this.editor && gui.alive(this.editor.window)) {
      if (rect.x !== undefined || rect.y !== undefined) this.placeEditor(rect)
      return this.editorState()
    }
    // Slot 17 on the controller: 0-2 FUnknown, 3 initialize, 4 terminate
    // (IPluginBase), 5 setComponentState … 16 setComponentHandler, 17 createView.
    // It returns the IPlugView pointer itself — not the three-argument
    // queryInterface shape some hosts assume.
    let view = null
    try {
      view = method(this.controller, 17, PROTO.createView)(this.controller, 'editor')
    } catch (error) {
      throw new Error(`createView falhou (${error.message})`)
    }
    if (!view) throw new Error('createView("editor") não devolveu uma visão — este VST3 não tem GUI para hospedar')
    // "HWND" is the documented Windows type; a few old builds only know the
    // retired "Win32" spelling.
    let type = 'HWND'
    if (!this.#platformAccepted(view, type)) {
      type = 'Win32'
      if (!this.#platformAccepted(view, type)) {
        release(view)
        throw new Error('a interface do plugin não aceita janelas deste sistema (pediu HWND ou Win32 e recusou as duas)')
      }
    }
    const asked = this.#viewSize(view)
    const size = this.#constrain(view, asked?.width || Math.max(120, rect.width || 720), asked?.height || Math.max(80, rect.height || 420))
    const window = gui.create(
      this.#title() || path.basename(this.path),
      { x: Math.round(rect.x ?? 120), y: Math.round(rect.y ?? 120), width: size.width, height: size.height },
      {
        owner: options.owner,
        onIdle: () => this.#applyResize(),
        onResize: (area) => this.#hostResized(area),
        onClose: () => this.closeEditor(),
      },
    )
    const frame = this.#makePlugFrame()
    this.editor = { view, window, frame, type, openedAt: Date.now(), attachCode: 0, fitted: 0, resizedByPlugin: false }
    this.resizeRequested = null
    // setFrame before attached: the header warns that attached() itself may call
    // resizeView, and a view with no frame has nowhere to send the request.
    try {
      Number(method(view, 12, PROTO.object)(view, frame.self.ptr))
    } catch {
      // A view that will not take a frame still draws; it just cannot resize us.
    }
    let attached = -1
    try {
      attached = Number(method(view, 4, PROTO.attach)(view, gui.handleOf(window), type))
    } catch (error) {
      gui.close(window)
      gui.forget(window.key)
      this.editor = null
      release(view)
      throw new Error(`attached falhou (${error.message})`)
    }
    this.editor.attachCode = attached
    if (!gui.alive(window)) {
      this.editor = null
      gui.forget(window.key)
      release(view)
      throw new Error('o plugin fechou a própria janela ao abri-la (attached)')
    }
    if (attached !== kResultOk) {
      this.closeEditor()
      throw new Error(`a interface do plugin recusou a janela (attached devolveu o código ${attached})`)
    }
    // The plugin may have asked for a different size from inside attached().
    this.#applyResize()
    const after = this.#viewSize(view)
    const final = this.#constrain(view, after?.width || size.width, after?.height || size.height)
    const inner = gui.clientSize(window)
    if (inner && (Math.abs(inner.width - final.width) > 1 || Math.abs(inner.height - final.height) > 1)) {
      gui.resizeClient(window, final.width, final.height)
    }
    this.editor.fitted = gui.fitChildren(window)
    try {
      Number(method(view, 11, PROTO.oneFlag)(view, 1)) // onFocus(true)
    } catch {
      // focus is a nicety; the view does not need it to paint
    }
    return this.editorState()
  }

  /**
   * Move the window to where the app's FX panel is. The panel's box addresses
   * the client area — the caption belongs to the host — and the client keeps the
   * size the plugin signed up for: a fixed-size GUI is not stretched to fill a
   * div, it is placed in one.
   */
  placeEditor(rect = {}) {
    const editor = this.editor
    if (!editor || !gui.alive(editor.window)) return false
    const inner = gui.clientSize(editor.window)
    if (!inner) return false
    const size = this.#constrain(editor.view, inner.width, inner.height)
    const moved = gui.placeClient(editor.window, {
      x: Number.isFinite(Number(rect.x)) ? Number(rect.x) : undefined,
      y: Number.isFinite(Number(rect.y)) ? Number(rect.y) : undefined,
      width: size.width,
      height: size.height,
      inside: rect.inside,
    })
    if (moved && (size.width !== inner.width || size.height !== inner.height)) {
      gui.fitChildren(editor.window, size)
      this.#hostResized(size)
    }
    return moved
  }

  /** Tell the plugin its window is going, then take the window away. */
  closeEditor() {
    const editor = this.editor
    if (!editor) return
    this.editor = null
    this.resizeRequested = null
    // removed() is the plugin's cue to detach its child window; it has to reach
    // the view before the parent disappears, and the view before we let go of it.
    try {
      Number(method(editor.view, 5, PROTO.none)(editor.view))
    } catch {
      // A view that faults on removal is gone with the window anyway.
    }
    release(editor.view)
    gui.close(editor.window)
    gui.forget(editor.window.key)
    // The frame is host memory the plugin held a pointer to: it is only safe to
    // unregister once the view has been told to let go.
    for (const fn of editor.frame.object.keep.fns) {
      try {
        koffi.unregister(fn)
      } catch {
        // A callback the plugin already dropped cannot be unregistered twice.
      }
    }
  }

  /** What the app needs to position and label the native window. */
  editorState() {
    if (!this.editor || !gui.alive(this.editor.window)) return { open: false, kind: 'vst3' }
    const inner = gui.clientSize(this.editor.window) ?? { width: 0, height: 0 }
    const outer = gui.windowRect(this.editor.window) ?? { x: 0, y: 0 }
    return {
      open: true,
      kind: 'vst3',
      // A plain number, not a koffi pointer: the app reads it across the process
      // boundary, and an HWND is valid process-wide.
      hwnd: Number(koffi.address(this.editor.window.hwnd)),
      clientWidth: inner.width,
      clientHeight: inner.height,
      x: outer.x,
      y: outer.y,
      pluginAskedForSize: this.editor.resizedByPlugin,
      childrenFitted: this.editor.fitted,
      attachCode: this.editor.attachCode,
      platformType: this.editor.type,
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.closeEditor()
    } catch {
      // an editor already torn down by the producer is not an error
    }
    try {
      if (this.component) method(this.component, 4, PROTO.none)(this.component) // terminate
    } catch {
      // terminate faults are common when a plugin was never fully connected
    }
    // The host objects are only unregistered after the plugin is done with them:
    // a callback still in flight through a freed trampoline is a crash at exit.
    try {
      this.changes?.release()
      this.outgoing?.release()
      for (const list of Object.values(this.eventLists ?? {})) {
        for (const fn of list.root.keep.fns) {
          try {
            koffi.unregister(fn)
          } catch {
            // a callback the plugin already dropped cannot be unregistered twice
          }
        }
      }
      this.eventLists = null
    } catch {
      // teardown of the change queue is best effort
    }
    release(this.controller)
    release(this.processor)
    release(this.component)
    release(this.factory3)
    release(this.factory)
    for (const handle of [this.host.hostApplication, this.host.componentHandler]) {
      for (const fn of handle.keep.fns) {
        try {
          koffi.unregister(fn)
        } catch {
          // a callback the plugin already dropped cannot be unregistered twice
        }
      }
    }
    // The module is deliberately left loaded. FreeLibrary on a plugin that keeps
    // a static thread or an atexit hook is a crash on the next open, and a
    // bounce chain re-opens the same plugin over and over — so the worker owns
    // one handle per .vst3 for its whole life and the OS reclaims it at exit.
  }
}

function sameCid(a, b) {
  if (!a || !b) return false
  return Buffer.from(a).equals(Buffer.from(b))
}

/**
 * The class the host is told to instantiate. VST3 labels it with the category
 * "Audio" (kVSTAudioModule), not the word "AudioModule", and one bundle can
 * carry a second "Audio" class for its controller — the one that answers for
 * IAudioProcessor is the one that makes sound, so prefer the class whose
 * subCategories say it is an instrument or an effect.
 */
function pickAudioModule(classes) {
  const audio = classes.filter((entry) => /^Audio/i.test(String(entry.category ?? '')))
  const withRole = audio.find((entry) => /(Instrument|AudioFX|Fx)/i.test(String(entry.subCategories ?? '')))
  return (withRole ?? audio[0] ?? classes.find((entry) => /AudioModule/i.test(String(entry.category ?? ''))))?.cid ?? null
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/** VST3 modules are bundles: the .vst3 folder is the plugin, the dll is inside. */
function isVst3Bundle(target) {
  try {
    return fs.statSync(target).isDirectory() && /\.vst3$/i.test(target)
  } catch {
    return false
  }
}

module.exports = { Vst3Plugin, MAX_BLOCK, isVst3Bundle, IID, IID_BUFFER }
