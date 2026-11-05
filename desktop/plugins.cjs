/**
 * One supervised plugin process for the whole app.
 *
 * Requests are queued and answered one at a time — loading two plugins at once
 * is a crash risk no host should take. If the child dies (a bad .dll, a plugin
 * that faults), every waiting request gets an error and the next request starts
 * a fresh process, so a plugin can never take the session down with it.
 *
 * A plugin that takes its process down is retried, in a clean child, before the
 * producer is told anything. This is not hiding a bug: it is what a plugin host
 * owes a session, because a third-party binary faults for reasons no host can
 * fix — AmpliTube 5 loads every time, and Gateway (a Neural Amp Modeler build)
 * aborts inside its own `createInstance` roughly once in two runs, with a heap
 * or stack fault, without touching anything of ours. Re-trying is how the second
 * case stops being the producer's problem.
 */
const path = require('node:path')
const { utilityProcess } = require('electron')

const WORKER = path.join(__dirname, 'vst-worker.cjs')
const START_TIMEOUT = 15000
/** How many times one request gets a process of its own. */
const ATTEMPTS = 3

/** Windows fault codes, said in the producer's language instead of in hex. */
function faultName(code) {
  if (code === 3221225477) return 'violou a própria memória'
  if (code === 3221226356) return 'interrompeu a execução internamente'
  if (code === 3221225619) return 'terminou durante a inicialização'
  if (code === 3221226505) return 'corrompeu o gerenciador de memória'
  if (code === 3221225254) return 'dividiu por zero'
  return `saiu com o código ${code}`
}

// The child the app talks to right now, and the requests waiting on it.
let current = null
const waiting = new Map()
let nextId = 1
let busy = Promise.resolve()
/**
 * How many times a plugin took its own process down since the app opened, and
 * the last reason. The producer never sees a number here, but the selftest and
 * the log do: "the window disappeared" is a fact about a third-party binary, and
 * saying which one and how many is the difference between a bug report and a
 * mystery.
 */
let faults = 0
let lastFault = ''

function create() {
  const proc = utilityProcess.fork(WORKER, [], { stdio: 'pipe', serviceName: 'OpenDAW plugins' })
  let settleStart
  const started = new Promise((resolve, reject) => {
    settleStart = { resolve, reject }
  })
  const startTimer = setTimeout(() => settleStart.reject(new Error('o processo dos plugins não respondeu ao iniciar')), START_TIMEOUT)

  proc.on('message', (message) => {
    if (!message) return
    if (message.ready) {
      clearTimeout(startTimer)
      settleStart.resolve()
      return
    }
    if (message.id) {
      const settle = waiting.get(message.id)
      if (!settle) return
      waiting.delete(message.id)
      settle.resolve(message)
    }
  })
  proc.on('exit', (code) => {
    clearTimeout(startTimer)
    if (current && current.proc === proc) {
      current = null
    }
    // A plugin can take its process down while no request is in flight at all —
    // its own GUI pump, a preset it loads on its own time. The producer then sees
    // a window that simply vanished, and the log has nothing in it. Say so.
    // Only a code that is not 0 counts: when the app closes, this process is told
    // to leave, and being told is not the same as falling down.
    if (code !== 0) {
      faults += 1
      lastFault = faultName(code)
      process.stderr.write(
        `[plugins] o processo dos plugins ${lastFault}: os plugins abertos e as janelas dele se foram ` +
          `com ele — o próximo pedido recebe um processo novo\n`,
      )
    }
    settleStart.reject(new Error(`o processo dos plugins ${faultName(code)} durante a inicialização`))
    // Anything in flight is marked as a fault, so the caller knows this try is
    // worth repeating in a fresh process rather than believing the plugin said no.
    const reason = new Error(faultName(code))
    reason.faulted = true
    // The plugins and the windows that process owned are gone with it. Nothing
    // has to be told from here: the FX panel keeps asking about its own window,
    // and a fresh process answers `noEditor` — the strip closes itself on that.
    for (const settle of waiting.values()) settle.reject(reason)
    waiting.clear()
  })
  proc.stdout?.on('data', (chunk) => process.stdout.write(`[plugins] ${chunk}`))
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[plugins] ${chunk}`))

  return { proc, started }
}

/** One try, in the process that is up right now. Rejects only if that process dies or hangs. */
function attempt(cmd, extra, timeoutMs) {
  if (!current) current = create()
  const entry = current
  return entry.started.then(
    () =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          waiting.delete(id)
          // A process that stopped answering holds the plugin and its memory and
          // is not coming back: stop it, so the next try gets a clean one.
          try {
            entry.proc.kill()
          } catch {
            // already gone
          }
          if (current && current.proc === entry.proc) current = null
          const error = new Error(`${cmd} demorou demais`)
          error.faulted = true
          reject(error)
        }, timeoutMs)
        waiting.set(id, {
          resolve: (message) => {
            clearTimeout(timer)
            resolve(message)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        entry.proc.postMessage({ id, cmd, ...extra })
      }),
  )
}

function request(cmd, extra, timeoutMs = 45000) {
  const task = busy.then(async () => {
    let lastFault = null
    for (let tryNumber = 1; tryNumber <= ATTEMPTS; tryNumber += 1) {
      try {
        return await attempt(cmd, extra, timeoutMs)
      } catch (error) {
        // A plugin that answers `ok: false` resolves: it said no, and saying no
        // twice is its answer, not a fault. Only a process that died or hung is
        // retried — in another process, with the plugin loaded from scratch.
        if (!error.faulted) throw error
        lastFault = error
      }
    }
    throw new Error(
      `o plugin ${lastFault ? lastFault.message : 'travou'} — o processo dele foi recriado ${ATTEMPTS} vezes e não completou a tarefa. O projeto está intacto: tente outro plugin, ou reabra o OpenDAW.`,
    )
  })
  // A rejected task must not poison the queue.
  busy = task.catch(() => {})
  return task
}

module.exports = {
  request,
  faultName,
  /** `{count, reason}` — what the plugin process has survived so far. */
  faults: () => ({ count: faults, reason: lastFault }),
}
