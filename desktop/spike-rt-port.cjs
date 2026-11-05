/**
 * The one question the live plugin depends on, asked on its own:
 *
 *   can the audio thread of the page and the process that holds the plugins
 *   talk to each other once per block, and how long does that take?
 *
 * The audio thread is the only place a live effect can be, and it cannot call
 * out to another process. The obvious pipe — the app's process sends a port to
 * the page — was tried first and does not work: a port that arrives through the
 * context bridge is a proxy, and a proxy is not transferable into a worklet. So
 * this harness measures the other direction, which is the one the browser lets
 * the page own: the page builds the channel, keeps one end in its audio thread,
 * and passes the far end out through the window to the preload, which gives it
 * to the app's process.
 *
 * It is a spike, not a feature. `npm --prefix desktop run spike-rt` prints the
 * journey step by step and the round trip in milliseconds; those numbers say
 * whether a live native chain can be promised, and at how many samples of
 * delay.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** Ports the page has handed down, one per handoff, all answered locally. */
const pipes = []

ipcMain.on('opdaw:plugin:rt-handoff', (event) => {
  const port = event.ports?.[0]
  if (!port) return
  let answered = 0
  port.on('message', (message) => {
    const data = message.data ?? {}
    if (data.kind !== 'probe') return
    answered += 1
    // Both hops stop here in the spike: the question is the pipe, and the same
    // journey through the plugin process is measured by `npm run app:test`.
    port.postMessage({ kind: 'probe-echo', hop: data.hop, answered, from: 'app' })
  })
  port.start()
  pipes.push(port)
})

const tmp = os.tmpdir()
fs.copyFileSync(path.join(__dirname, '..', 'public', 'rt', 'rt-bridge-worklet.js'), path.join(tmp, 'rt-bridge-worklet.js'))
const page = path.join(tmp, 'opdaw-spike-rt.html')
fs.writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><title>spike</title>
<script>
window.result = { done: false, log: [], stats: null, error: '' };
const say = (line) => window.result.log.push(line);
window.addEventListener('message', (event) => {
  if (event.source === window && event.data && event.data.opdawRt === 'status') say('preload: ' + event.data.line);
});
async function run() {
  try {
    const ctx = new AudioContext();
    say('contexto de áudio: ' + ctx.sampleRate + 'Hz ' + ctx.state);
    await ctx.audioWorklet.addModule('rt-bridge-worklet.js');
    say('worklet carregado');
    const node = new AudioWorkletNode(ctx, 'rt-bridge', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.kind === 'ready') say('worklet aceitou a porta criada na página');
      if (data.kind === 'worklet-error') say('erro no quanta de áudio: ' + data.text);
      if (data.kind === 'stats') {
        if (!window.result.stats) say('primeiro quanta: ' + data.blocks + ' blocos');
        window.result.stats = data;
        // Finished by the audio thread's own report, not by a timer: a window
        // this harness never paints has its timers throttled, and a throttled
        // timer must not read as a stalled audio thread.
        if (data.frames >= data.rate * 2) window.result.done = true;
      }
    };
    const channel = new MessageChannel();
    try {
      node.port.postMessage({ attachPort: channel.port1 }, [channel.port1]);
      say('porta transferida para o worklet: OK');
    } catch (transferError) {
      say('TRANSFERÊNCIA FALHOU: ' + transferError.message);
      window.result.error = 'transfer: ' + transferError.message;
      window.result.done = true;
      return;
    }
    // The far end leaves the page's world through the window itself; the preload
    // listens for it there and carries it to the app's process.
    window.postMessage({ opdawRt: 'handoff' }, '*', [channel.port2]);
  } catch (error) {
    window.result.error = String(error && error.message ? error.message : error);
    window.result.done = true;
  }
}
run();
</script>`,
)

async function main() {
  const win = new BrowserWindow({
    show: true,
    width: 420,
    height: 320,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A window this harness never paints is otherwise treated as background:
      // the audio graph and the port messages it posts have to keep running for
      // the measurement to mean anything.
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  await win.loadFile(page)
  win.focus()
  for (let i = 0; i < 200; i += 1) {
    if (await win.webContents.executeJavaScript('window.result.done === true')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const result = await win.webContents.executeJavaScript('JSON.stringify(window.result)')
  console.log('SPIKE ' + result)
  app.quit()
}

// A page needs no second window: the answer either arrives here or it does not.
app.whenReady().then(main)
