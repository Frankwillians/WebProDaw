/**
 * A real Win32 window for a plugin's own interface.
 *
 * A VST draws inside a window the host gives it. That is the whole of the
 * contract, and it is the reason this module exists: the producer asked to see
 * the plugin's own GUI, and the only way to show it is to hand the plugin an
 * HWND and keep answering the messages that come with it.
 *
 * The window belongs to the process that holds the plugin — the OpenDAW plugin
 * worker — so nothing crosses a process boundary: the plugin parents its own
 * child window here, and the pump below dispatches its mouse and keyboard. The
 * window is a normal top-level window (title bar, close box) that the app keeps
 * lined up over the FX panel by sending rectangles in.
 *
 * Every call here is a documented user32/shell32 one and every layout is the
 * x64 one, taken from the Windows SDK headers.
 */
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const shell32 = koffi.load('shell32.dll')

// ------------------------------------------------------------------ messages
const WM_SIZE = 0x0005
const WM_CREATE = 0x0001
const WM_PARENTNOTIFY = 0x0210
const WM_CLOSE = 0x0010
const WM_DESTROY = 0x0002
const WM_SETFOCUS = 0x0007
const WM_ENTERMENULOOP = 0x0211
const WM_EXITMENULOOP = 0x0212
const WM_ENTERSIZEMOVE = 0x0231
const WM_EXITSIZEMOVE = 0x0232
const WM_DROPFILES = 0x046a

// ------------------------------------------------------------------ styles
const WS_CAPTION = 0x00c00000
const WS_SYSMENU = 0x00080000
const WS_MINIMIZEBOX = 0x00020000
const WS_VISIBLE = 0x10000000
const WS_CLIPCHILDREN = 0x02000000
// A frameless top-level window. The editor is not a window the producer moves or
// closes: the FX panel is, and the plugin's drawing simply occupies the pane it
// is given. `WS_POPUP` plus no caption is what makes it read as part of the
// program instead of an external window parked on top of it.
const WS_POPUP = 0x80000000
const CS_DBLCLKS = 0x0008
const SW_HIDE = 0
const SW_SHOW = 5
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const PM_REMOVE = 1
const WS_EX_ACCEPTFILES = 0x00000010 // lets a producer drop a file on the editor
// COLOR_WINDOWFRAME is a solid dark brush: before the plugin paints, the producer
// sees the app's own colour instead of a white flash.
const DARK_BRUSH = 0x11

// ------------------------------------------------------------------ structs
const WNDCLASSEXW = koffi.struct('ODWndClassexW', {
  cbSize: 'uint32_t',
  style: 'uint32_t',
  lpfnWndProc: 'void *',
  cbClsExtra: 'int32_t',
  cbWndExtra: 'int32_t',
  hInstance: 'void *',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'void *',
  lpszClassName: 'void *',
  hIconSm: 'void *',
})

const MSG = koffi.struct('ODMsg', {
  hwnd: 'void *',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  ptX: 'int32_t',
  ptY: 'int32_t',
})

// LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM)
const WndProcProto = koffi.proto(
  'intptr_t ODWndProc(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)',
)

// ------------------------------------------------------------------ imports
const RegisterClassExW = user32.func('uint16_t __stdcall RegisterClassExW(ODWndClassexW *record)')
const CreateWindowExW = user32.func(
  'void * __stdcall CreateWindowExW(uint32_t exStyle, uint16_t *className, uint16_t *title, ' +
    'uint32_t style, int32_t x, int32_t y, int32_t width, int32_t height, void *parent, ' +
    'void *menu, void *instance, void *parameter)',
)
const DefWindowProcW = user32.func(
  'intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)',
)
const DestroyWindow = user32.func('int32_t __stdcall DestroyWindow(void *hwnd)')
const IsWindow = user32.func('int32_t __stdcall IsWindow(void *hwnd)')
const ShowWindow = user32.func('int32_t __stdcall ShowWindow(void *hwnd, int32_t command)')
const IsWindowVisible = user32.func('int32_t __stdcall IsWindowVisible(void *hwnd)')
const SetWindowPos = user32.func(
  'int32_t __stdcall SetWindowPos(void *hwnd, void *after, int32_t x, int32_t y, int32_t width, ' +
    'int32_t height, uint32_t flags)',
)
const GetClientRect = user32.func('int32_t __stdcall GetClientRect(void *hwnd, uint8_t *rect)')
const GetWindowRect = user32.func('int32_t __stdcall GetWindowRect(void *hwnd, uint8_t *rect)')
const SetWindowTextW = user32.func('int32_t __stdcall SetWindowTextW(void *hwnd, uint16_t *text)')
const SetForegroundWindow = user32.func('int32_t __stdcall SetForegroundWindow(void *hwnd)')
const PeekMessageW = user32.func(
  'int32_t __stdcall PeekMessageW(ODMsg *message, void *hwnd, uint32_t first, uint32_t last, uint32_t remove)',
)
const ClientToScreen = user32.func('int32_t __stdcall ClientToScreen(void *hwnd, int32_t *point)')
const GetWindow = user32.func('void * __stdcall GetWindow(void *hwnd, uint32_t command)')
const SetParent = user32.func('void * __stdcall SetParent(void *hwnd, void *parent)')
const MoveWindow = user32.func(
  'int32_t __stdcall MoveWindow(void *hwnd, int32_t x, int32_t y, int32_t width, int32_t height, ' +
    'int32_t repaint)',
)
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int32_t index)')
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int32_t index, intptr_t value)')
const EnumChildWindows = user32.func(
  'int32_t __stdcall EnumChildWindows(void *hwnd, void *callback, intptr_t parameter)',
)
const TranslateMessage = user32.func('int32_t __stdcall TranslateMessage(ODMsg *message)')
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(ODMsg *message)')
const LoadCursorW = user32.func('void * __stdcall LoadCursorW(void *instance, uint16_t *name)')
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(uint16_t *name)')
const DragQueryFileW = shell32.func(
  'uint32_t __stdcall DragQueryFileW(void *drop, uint32_t index, uint16_t *file, uint32_t count)',
)
const DragFinish = shell32.func('void __stdcall DragFinish(void *drop)')

const CLASS_NAME = 'OpenDAWPluginEditor'
const INSTANCE = GetModuleHandleW(null)

// ------------------------------------------------------------------ children
const GWL_STYLE = -16
const GWL_HWNDPARENT = -8
const GW_PARENT = 2
const WS_CHILD = 0x40000000
// A caption, a border, a dialog frame, a system menu and a resize frame. Some
// toolkits (xputty, behind a good part of the free effects) build the plugin's
// canvas as a small titled frame of its own; inside our window that second
// title bar steals the space the knobs need.
const UNWANTED_STYLES = 0x00c00000 | 0x00800000 | 0x00400000 | 0x00080000 | 0x00040000
const SWP_FRAMECHANGED = 0x0020

const ChildProc = koffi.proto('int32_t ODEnumChild(void *hwnd, intptr_t extra)')

// One callback for every enumeration: Win32 calls it synchronously, from this
// thread, so a module-level sink is enough and stays alive for the whole run.
let collecting = null
const childProc = koffi.register((hwnd, extra) => {
  void extra
  if (collecting) collecting.push(hwnd)
  return 1
}, koffi.pointer(ChildProc))

/** Every window the plugin put under ours, in Win32's own enumeration order. */
function descendantsOf(window) {
  if (!window || !IsWindow(window.hwnd)) return []
  const found = []
  collecting = found
  try {
    EnumChildWindows(window.hwnd, koffi.address(childProc), 0)
  } finally {
    collecting = null
  }
  return found
}

/**
 * The window above this one. Win32 keeps two different links: a real child
 * carries GW_PARENT, and a popup that was created with a parent handle is
 * stored as an owned window, whose GW_PARENT is empty and whose owner is kept
 * in GWL_HWNDPARENT. xputty builds its canvas the second way, so a host that
 * only reads GW_PARENT sees nothing and leaves the plugin's own title bar on.
 */
function parentOf(hwnd) {
  const link = GetWindow(hwnd, GW_PARENT)
  if (link) return Number(koffi.address(link))
  const owner = Number(GetWindowLongPtrW(hwnd, GWL_HWNDPARENT))
  return Number.isFinite(owner) ? Math.max(0, owner) : 0
}

/** Direct children of a window — the canvases the host has to lay out. */
function childrenOf(window) {
  const parent = Number(koffi.address(window.hwnd))
  return descendantsOf(window).filter((hwnd) => parentOf(hwnd) === parent)
}

/**
 * A toolkit that hands back a popup instead of a child — xputty does exactly
 * that, and its window comes with a title bar of its own — has to be adopted
 * before it can be laid out. WS_CHILD plus SetParent is what makes the canvas
 * live inside our client area, follow our window and stop owning a frame.
 */
function adoptPopups(window, list) {
  const parent = Number(koffi.address(window.hwnd))
  let adopted = 0
  for (const hwnd of list) {
    if (parentOf(hwnd) !== parent) continue
    const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) >>> 0
    if ((style & WS_CHILD) !== 0) continue
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style | WS_CHILD | WS_VISIBLE) >>> 0)
    SetParent(hwnd, window.hwnd)
    adopted += 1
  }
  return adopted
}

/**
 * One canvas, laid over the client area with the frame taken off. Returns the
 * style bits it removed, so a caller can tell what the plugin asked for.
 */
function fitChild(hwnd, area) {
  if (!hwnd || !area) return false
  const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) >>> 0
  const cleaned = (style & ~UNWANTED_STYLES) >>> 0
  if (cleaned !== style) SetWindowLongPtrW(hwnd, GWL_STYLE, cleaned)
  SetWindowPos(
    hwnd,
    null,
    0,
    0,
    Math.max(1, area.width),
    Math.max(1, area.height),
    SWP_NOZORDER | (cleaned !== style ? SWP_FRAMECHANGED : 0),
  )
  return cleaned !== style
}

/**
 * Lay the plugin's canvas over the whole client area, without the frame some
 * toolkits give it. Called after the editor opens and again on every resize:
 * the plugin sizes its controls to the window it is told it has.
 */
function fitChildren(window, size) {
  const area = size ?? clientSize(window)
  if (!window || !area || !IsWindow(window.hwnd)) return 0
  const all = descendantsOf(window)
  adoptPopups(window, all)
  let fitted = 0
  for (const hwnd of childrenOf(window)) {
    fitChild(hwnd, area)
    fitted += 1
  }
  return fitted
}

/** UTF-16, NUL-terminated, for a Win32 wide-string argument. */
function wide(text) {
  const buffer = Buffer.alloc((text.length + 1) * 2)
  for (let index = 0; index < text.length; index += 1) buffer.writeUInt16LE(text.charCodeAt(index), index * 2)
  return buffer
}

/**
 * The windows this process holds, keyed by HWND. Each entry is the host's own
 * bookkeeping: what the plugin's window is, what it asked for, and the two
 * callbacks the owner (vst2.cjs / vst3.cjs) registered so a close or a resize
 * reaches the plugin object that opened it.
 */
const windows = new Map()

let registered = null

/** Register the shared window class once, with the host's window procedure. */
function ensureClass() {
  if (registered) return registered
  // One procedure for every editor window: it looks the window up in `windows`,
  // notes what the host has to react to, and hands everything else to Windows.
  // koffi callbacks run on the thread that dispatches them — the Node thread of
  // this process — so a plugin calling back into the host from here is safe.
  const proc = koffi.register((hwnd, message, wParam, lParam) => {
    const entry = windows.get(koffi.address(hwnd))
    if (entry) {
      if (message === WM_CLOSE) entry.wantClose = true
      else if (message === WM_DESTROY) entry.destroyed = true
      else if (message === WM_SIZE) entry.resized = true
      else if (message === WM_SETFOCUS) entry.focused = true
      // A modal loop (a plugin's own popup menu, a drag of our title bar) runs
      // inside Win32 and does not come back to Node: while one is running the
      // pump must not try to talk to the plugin.
      else if (message === WM_ENTERMENULOOP || message === WM_ENTERSIZEMOVE) entry.blocked = true
      else if (message === WM_EXITMENULOOP || message === WM_EXITSIZEMOVE) entry.blocked = false
      else if (message === WM_DROPFILES && entry.onFiles) {
        const files = readDrop(wParam)
        if (files.length) entry.onFiles(files)
        DragFinish(wParam)
        return 1
      } else if (message === WM_PARENTNOTIFY && (Number(wParam) & 0xffff) === WM_CREATE) {
        // The plugin made a window inside ours. Win32 puts the new handle in
        // the low 32 bits of lParam, even on x64; the fit itself waits for the
        // next pump tick, because a child that has not finished its own
        // WM_CREATE is not finished choosing the size it wants.
        const handle = Number(BigInt.asUintN(32, BigInt(lParam)))
        if (handle) entry.newChild = koffi.as(handle, 'void *')
      }
    }
    return DefWindowProcW(hwnd, message, wParam, lParam)
  }, koffi.pointer(WndProcProto))

  const record = koffi.alloc(WNDCLASSEXW, 1)
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'cbSize'), 'uint32_t', koffi.sizeof(WNDCLASSEXW))
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'style'), 'uint32_t', CS_DBLCLKS)
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'lpfnWndProc'), 'void *', koffi.address(proc))
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'hInstance'), 'void *', INSTANCE)
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'hCursor'), 'void *', LoadCursorW(null, wide('')))
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'hbrBackground'), 'void *', DARK_BRUSH)
  // Windows keeps the pointer to this name for the life of the class, so the
  // buffer is held by `registered` — and referenced until RegisterClassExW has
  // returned, which is what keeps the garbage collector from taking it first.
  const name = wide(CLASS_NAME)
  koffi.encode(record, koffi.offsetof(WNDCLASSEXW, 'lpszClassName'), 'void *', koffi.address(name))
  if (!RegisterClassExW(record)) {
    throw new Error('não deu para registrar a janela do editor (RegisterClassExW falhou)')
  }
  registered = { proc, name }
  return registered
}

/** File names of a WM_DROPFILES, for a plugin that accepts drag and drop. */
function readDrop(drop) {
  const out = []
  const buffer = Buffer.alloc(1024)
  const total = DragQueryFileW(drop, 0xffffffff, null, 0)
  for (let index = 0; index < Math.min(total, 16); index += 1) {
    const length = DragQueryFileW(drop, index, buffer, 512)
    if (length > 0) out.push(buffer.toString('utf16le', 0, length * 2))
  }
  return out
}

/**
 * The window a plugin draws in. `rect` is in physical screen pixels; the plugin
 * child window is placed inside it by the plugin itself, so the client area is
 * what the editor gets.
 *
 * It is created frameless and owned by the app's window: the pane in the FX
 * panel is the frame the producer sees, the panel is what gets dragged, and the
 * plugin's interface never appears as a second window with a second title bar.
 */
function create(title, rect, hooks = {}) {
  ensureClass()
  const hwnd = CreateWindowExW(
    WS_EX_ACCEPTFILES,
    registered.name,
    wide(title || 'Plugin'),
    WS_POPUP | WS_CLIPCHILDREN | WS_VISIBLE,
    Math.round(rect.x ?? 100),
    Math.round(rect.y ?? 100),
    Math.max(80, Math.round(rect.width ?? 640)),
    Math.max(40, Math.round(rect.height ?? 480)),
    null,
    null,
    INSTANCE,
    null,
  )
  if (!hwnd) throw new Error('o Windows recusou a janela do plugin (CreateWindowExW devolveu nulo)')
  // Owned by the app's window when the host passes a handle: the plugin's
  // interface then stays with the program, floats above it and disappears when
  // the program is minimised, instead of being an orphan on the desktop. An
  // HWND is valid in every process of the session, so the app's handle works
  // here even though the window lives in the plugin worker.
  const owner = Number(hooks.owner ?? 0)
  if (owner > 0) SetWindowLongPtrW(hwnd, GWL_HWNDPARENT, owner)
  const key = koffi.address(hwnd)
  windows.set(key, {
    hwnd,
    title: title || 'Plugin',
    wantClose: false,
    destroyed: false,
    resized: false,
    focused: false,
    blocked: false,
    fitted: 0,
    newChild: null,
    // The app's area, kept from the rectangle the window was born with so a
    // plugin that resizes itself before the panel ever moves still stays inside.
    inside:
      rect.inside && Number(rect.inside.width) > 0 && Number(rect.inside.height) > 0
        ? {
            x: Math.round(Number(rect.inside.x)),
            y: Math.round(Number(rect.inside.y)),
            width: Math.round(Number(rect.inside.width)),
            height: Math.round(Number(rect.inside.height)),
          }
        : null,
    onFiles: hooks.onFiles ?? null,
    onClose: hooks.onClose ?? null,
    onResize: hooks.onResize ?? null,
    onIdle: hooks.onIdle ?? null,
  })
  ShowWindow(hwnd, SW_SHOW)
  SetForegroundWindow(hwnd)
  return { hwnd, key, entry: windows.get(key) }
}

/** HWND of the window, for the plugin call (`effEditOpen` / `attached`). */
const handleOf = (window) => window.hwnd

/** Move and resize the editor to the rectangle the app asked for. */
function place(window, rect) {
  if (!window || !IsWindow(window.hwnd)) return false
  return SetWindowPos(
    window.hwnd,
    null,
    Math.round(rect.x),
    Math.round(rect.y),
    Math.max(40, Math.round(rect.width)),
    Math.max(30, Math.round(rect.height)),
    SWP_NOZORDER | SWP_NOACTIVATE,
  )
}

/** The window's own title, for the caption the producer sees. */
function title(window, text) {
  if (!window || !IsWindow(window.hwnd)) return
  SetWindowTextW(window.hwnd, wide(text))
  window.entry.title = text
}

/** Client area, in physical pixels — what a resized plugin asks to be fitted to. */
function clientSize(window) {
  if (!window || !IsWindow(window.hwnd)) return null
  const rect = koffi.alloc('uint8_t', 16)
  if (!GetClientRect(window.hwnd, rect)) return null
  const left = koffi.decode(rect, 0, 'int32_t')
  const top = koffi.decode(rect, 4, 'int32_t')
  const right = koffi.decode(rect, 8, 'int32_t')
  const bottom = koffi.decode(rect, 12, 'int32_t')
  return { left, top, width: right - left, height: bottom - top }
}

/** Outer frame of the window, in screen pixels — used to trade frame for client. */
function windowRect(window) {
  if (!window || !IsWindow(window.hwnd)) return null
  const rect = koffi.alloc('uint8_t', 16)
  if (!GetWindowRect(window.hwnd, rect)) return null
  const left = koffi.decode(rect, 0, 'int32_t')
  const top = koffi.decode(rect, 4, 'int32_t')
  const right = koffi.decode(rect, 8, 'int32_t')
  const bottom = koffi.decode(rect, 12, 'int32_t')
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The app's drawable area as this window last knew it, in physical screen pixels.
 *
 * A plugin resizes its own window from inside its own call stack —
 * `audioMasterSizeWindow` for a VST2, `resizeView` for a VST3 — and that request
 * knows nothing about the pane. The limit therefore has to be remembered here,
 * from the last placement the app sent, so a plugin that decides to grow grows
 * inside OpenDAW and not past it.
 */
function insideOf(window) {
  return window?.entry?.inside ?? null
}

/**
 * Resize the window so its CLIENT area is exactly width x height, keeping the
 * top-left corner of the client where it is. A plugin asks for a canvas size
 * (audioMasterSizeWindow, or the rect it publishes before opening) and the
 * title bar and borders belong to us, not to it.
 *
 * It goes through the same placement as a pane move, so the same clamp applies:
 * an interface that answers a preset by becoming bigger than the app's window is
 * still an interface the producer can reach.
 */
function resizeClient(window, width, height) {
  const origin = clientOrigin(window)
  if (!origin) return false
  return placeClient(window, {
    x: origin.x,
    y: origin.y,
    width,
    height,
    inside: insideOf(window),
  })
}

/**
 * Slide a window of `size` into the span [`from`, `to`] with the least possible
 * move. A window bigger than the span cannot be inside it, and the answer there
 * is the near edge: an interface pushed off the left or the top is one the
 * producer has no handle on any more, while one that runs past the far edge is
 * still reachable and still tells them to make the pane bigger.
 */
function keepInside(preferred, size, from, to) {
  const low = from
  const high = Math.max(from, to - size)
  return Math.min(Math.max(preferred, low), high)
}

/**
 * Put the CLIENT area at a screen rectangle, the way an app panel addresses it.
 * `rect` is where the plugin should draw, in physical screen pixels; the caption
 * and the borders belong to the host, so the window goes a frame larger than the
 * box it is fitted to. Omitted fields keep what the window already has.
 *
 * `rect.inside` is the app's own drawable area, in the same pixels. The producer
 * asked for the plugin's interface to be part of OpenDAW, and a window that ends
 * up on the desktop — because the app moved out from under it, because the pane
 * was dragged to a screen edge, because the plugin insisted on a canvas bigger
 * than the box it was given — is an external window again. So the placement is
 * the pane's, and the clamp is what keeps the promise.
 */
function placeClient(window, rect = {}) {
  if (!window || !IsWindow(window.hwnd)) return false
  const outer = windowRect(window)
  const inner = clientSize(window)
  const origin = clientOrigin(window)
  if (!outer || !inner || !origin) return false
  const inside = rect.inside
  const room =
    inside && Number(inside.width) > 0 && Number(inside.height) > 0
      ? {
          x: Math.round(Number(inside.x)),
          y: Math.round(Number(inside.y)),
          width: Math.round(Number(inside.width)),
          height: Math.round(Number(inside.height)),
        }
      : null
  // The limit is remembered for the calls that come without it — a plugin
  // resizing itself from inside its own stack has no idea where the pane is.
  const entry = windows.get(koffi.address(window.hwnd))
  if (entry && room) entry.inside = room
  let width = Math.max(40, Math.round(rect.width ?? inner.width)) + (outer.width - inner.width)
  let height = Math.max(30, Math.round(rect.height ?? inner.height)) + (outer.height - inner.height)
  let x = Math.round((rect.x ?? origin.x) - (origin.x - outer.x))
  let y = Math.round((rect.y ?? origin.y) - (origin.y - outer.y))
  if (room) {
    // A canvas bigger than the whole app is not a plugin interface, it is a
    // second program: the app's own area is the ceiling, and a plugin that
    // insists on more gets the pane it was given instead.
    width = Math.min(width, room.width)
    height = Math.min(height, room.height)
    x = keepInside(x, width, room.x, room.x + room.width)
    y = keepInside(y, height, room.y, room.y + room.height)
  }
  return place(window, { x, y, width, height })
}

/** Screen position of the client area's top-left, for placing a plugin's child. */
function clientOrigin(window) {
  const size = clientSize(window)
  if (!size) return null
  const point = koffi.alloc('int32_t', 2)
  koffi.encode(point, 0, 'int32_t', 0)
  koffi.encode(point, 4, 'int32_t', 0)
  ClientToScreen(window.hwnd, point)
  return {
    x: koffi.decode(point, 0, 'int32_t'),
    y: koffi.decode(point, 4, 'int32_t'),
    width: size.width,
    height: size.height,
  }
}

/** Is the window still there at all (the producer may have closed it by hand)? */
function alive(window) {
  return Boolean(window) && IsWindow(window.hwnd) !== 0 && !window.entry.destroyed
}

/**
 * Put the editor away without closing it.
 *
 * The FX panel can be minimised and the page can be scrolled out of sight; the
 * plugin's interface has to follow, but its state must not go with it — a
 * producer who hides an amp and brings it back expects the same knobs. The
 * message pump keeps running either way, which is what keeps the plugin alive
 * and its meters moving while the window is not on screen.
 */
function shown(window, visible) {
  if (!window || !IsWindow(window.hwnd)) return false
  ShowWindow(window.hwnd, visible ? SW_SHOW : SW_HIDE)
  return true
}

/**
 * Whether the window is on the screen at this moment. `shown` says the request
 * was made; this says it took — which is the difference the panel needs when it
 * reports a plugin interface that is put away rather than lost.
 */
function isVisible(window) {
  return Boolean(window) && IsWindow(window.hwnd) !== 0 && IsWindowVisible(window.hwnd) !== 0
}

/**
 * One turn of the message pump, then every bookkeeping flag the window
 * procedure set. Each window gets its own `onIdle` (VST2's effEditIdle, VST3's
 * own timer) and it is skipped while a modal loop is running, because during
 * one Win32 is already pumping for the plugin.
 */
function pump() {
  const message = koffi.alloc(MSG, 1)
  let handled = 0
  // A finite budget per tick: a plugin that keeps posting itself messages must
  // not be able to starve the Node event loop.
  while (handled < 200 && PeekMessageW(message, null, 0, 0, PM_REMOVE)) {
    const decoded = koffi.decode(message, MSG)
    const entry = windows.get(koffi.address(decoded.hwnd))
    if (entry) entry.lastMessage = decoded.message
    TranslateMessage(message)
    DispatchMessageW(message)
    handled += 1
  }
  for (const [key, entry] of windows) {
    // A canvas the plugin created since the last tick is laid out before it is
    // told to draw, so the first frame the producer sees is the final one.
    if (entry.newChild) {
      const child = entry.newChild
      entry.newChild = null
      fitChild(child, clientSize({ hwnd: entry.hwnd }))
    }
    // A plugin that only builds its window after the first idle never shows up
    // through WM_PARENTNOTIFY, so the layout is retried until there is one.
    if (!entry.fitted) entry.fitted = fitChildren({ hwnd: entry.hwnd })
    if (!entry.blocked && !entry.destroyed) entry.onIdle?.()
    if (entry.resized) {
      entry.resized = false
      const size = clientSize({ hwnd: entry.hwnd })
      // The producer dragged the frame: the canvas follows, whatever the
      // plugin's own idea of a fixed size was.
      entry.fitted = fitChildren({ hwnd: entry.hwnd }, size)
      entry.onResize?.(size)
    }
    if (entry.wantClose) {
      // The producer pressed the close box (or Alt+F4). Tell the plugin first,
      // then take the window away: a plugin left holding a destroyed parent is a
      // crash the next time it paints.
      entry.wantClose = false
      entry.onClose?.()
      close({ hwnd: entry.hwnd, entry })
      windows.delete(key)
    }
  }
  return handled
}

/** Close a window the host owns: called by the plugin's own close, or by the app. */
function close(window) {
  if (!window || !IsWindow(window.hwnd)) return false
  DestroyWindow(window.hwnd)
  return true
}

/** Forget a window whose plugin is gone (worker shutting down). */
function forget(key) {
  windows.delete(key)
}


module.exports = {
  windows,
  create,
  place,
  title,
  clientSize,
  clientOrigin,
  windowRect,
  resizeClient,
  placeClient,
  childrenOf,
  fitChildren,
  fitChild,
  alive,
  shown,
  isVisible,
  pump,
  close,
  forget,
  handleOf,
  WM_DROPFILES,
  SW_SHOW,
}
