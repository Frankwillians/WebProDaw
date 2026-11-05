/**
 * The only door between the DAW and the operating system.
 *
 * The renderer keeps its context isolation: it sees `window.OpenDAW` and nothing
 * else of Node. Everything in the browser version still works when this object
 * is absent — the native bridge only adds dialogs, disk access and plugins.
 */
const { contextBridge, ipcRenderer } = require('electron')

const menuListeners = new Set()
ipcRenderer.on('opdaw:menu', (_event, payload) => {
  // A bare string is an old-style action name; an object is either an action or
  // the position of a row mirrored from the page's own menu bar.
  const click = typeof payload === 'string' ? { action: payload } : payload
  for (const listener of menuListeners) {
    try {
      listener(click)
    } catch {
      // One handler throwing must not mute the others.
    }
  }
})

// ------------------------------------------------------- realtime bridge
/**
 * The audio thread of the page lives in the page's own world, and a port sent
 * down from the app's process arrives here as a proxy: it cannot be transferred
 * into an AudioWorklet from outside. Measured, and it fails with "does not have
 * a transferable type". So the channel is built the other way round, which is
 * the direction the browser lets the page own — the page makes the channel,
 * keeps one end in its audio thread, and passes the far end out through the
 * window. This listener is that far end's first stop on the way to the process
 * that holds the plugins.
 *
 * Nothing about the app is visible to the page here: the answer is a message on
 * the window, the same one the page posted, so the page never has to trust a
 * bridge object it cannot use anyway.
 */
const rtSay = (line, extra) => {
  window.postMessage({ opdawRt: 'status', line, ...extra }, '*')
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.opdawRt !== 'handoff') return
  const port = event.ports?.[0]
  if (!port) {
    rtSay('nenhuma porta chegou ao preload', { ok: false })
    return
  }
  try {
    // The port leaves the renderer here. From this moment the app's process owns
    // the far end of the audio thread's channel.
    ipcRenderer.postMessage('opdaw:plugin:rt-handoff', { from: 'preload' }, [port])
    rtSay('porta entregue ao processo do app', { ok: true })
  } catch (error) {
    rtSay(`a entrega ao processo do app falhou: ${error.message}`, { ok: false })
  }
})

contextBridge.exposeInMainWorld('OpenDAW', {
  native: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  info: () => ipcRenderer.invoke('opdaw:info'),

  saveFile: (options) => ipcRenderer.invoke('opdaw:save-file', options),
  openFile: (options) => ipcRenderer.invoke('opdaw:open-file', options),

  plugins: {
    scan: (dirs) => ipcRenderer.invoke('opdaw:plugin:scan', { dirs }),
    // A folder of the producer's own, chosen with the OS dialog and remembered
    // by the plugin process for every scan after this one.
    addDir: () => ipcRenderer.invoke('opdaw:plugin:add-dir'),
    describe: (path, sampleRate) => ipcRenderer.invoke('opdaw:plugin:describe', { path, sampleRate }),
    render: (request) => ipcRenderer.invoke('opdaw:plugin:render', request),
    // Panel to plugin: the values the producer set in OpenDAW are handed to the
    // plugin itself, so its own window and this panel never show two answers.
    setParams: (request) => ipcRenderer.invoke('opdaw:plugin:params', request),
    // The plugin's own window: the page says where its FX panel is, the native
    // side opens the editor there and keeps it there. `rect` is in CSS pixels of
    // this viewport; main.cjs converts it to the screen.
    guiOpen: (request) => ipcRenderer.invoke('opdaw:plugin:gui-open', request),
    guiPlace: (request) => ipcRenderer.invoke('opdaw:plugin:gui-place', request),
    guiState: (request) => ipcRenderer.invoke('opdaw:plugin:gui-state', request),
    // Put the plugin's window away while its pane is hidden (the FX panel was
    // minimised, the lane closed) without closing the plugin itself.
    guiShow: (request) => ipcRenderer.invoke('opdaw:plugin:gui-show', request),
    guiClose: (request) => ipcRenderer.invoke('opdaw:plugin:gui-close', request),
    // The live lane: open the plugin at a real-time block size, hand it one batch
    // of samples at a time, and close it when the lane stops listening. These are
    // ordinary requests rather than a port the page built because the plugin's own
    // process is supervised — a .dll that takes itself down is restarted by the
    // app and the page sees an error reply, which a raw port would only show as
    // silence. The measured cost of one trip is about 2.7 ms, and a batch carries
    // 10.7 ms of audio, so the audio thread never waits on any of it.
    liveOpen: (request) => ipcRenderer.invoke('opdaw:plugin:live-open', request),
    liveBlock: (request) => ipcRenderer.invoke('opdaw:plugin:live-block', request),
    liveParams: (request) => ipcRenderer.invoke('opdaw:plugin:live-params', request),
    liveClose: (request) => ipcRenderer.invoke('opdaw:plugin:live-close', request),
  },

  onMenu: (handler) => {
    menuListeners.add(handler)
    return () => menuListeners.delete(handler)
  },
  setMenu: (groups) => ipcRenderer.send('opdaw:menu-structure', groups),
})
