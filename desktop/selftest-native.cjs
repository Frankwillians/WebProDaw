/**
 * Native smoke test, no Electron needed:
 *
 *   node desktop/selftest-native.cjs ["C:\\caminho\\do\\plugin.dll"]
 *
 * Forks the plugin worker, scans the usual VST folders, opens the first VST2 it
 * finds, renders two seconds of audio through it and writes the result next to
 * this file so it can actually be listened to.
 */
const { fork } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2]
const worker = fork(path.join(__dirname, 'vst-worker.cjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })

let nextId = 1
const pending = new Map()

worker.on('message', (message) => {
  if (!message || message.ready) return
  const settle = pending.get(message.id)
  if (!settle) return
  pending.delete(message.id)
  settle.resolve(message)
})

worker.on('exit', (code) => {
  for (const settle of pending.values()) settle.reject(new Error(`o processo dos plugins terminou (código ${code})`))
  pending.clear()
  console.log('worker saiu com código', code)
})

function ask(cmd, extra, timeoutMs = 30000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${cmd} demorou demais`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer)
        resolve(message)
      },
      reject,
    })
    worker.send({ id, cmd, ...extra })
  })
}

async function main() {
  const scanned = await ask('scan')
  const found = scanned.plugins ?? []
  console.log(`\nvarridura: ${found.length} arquivo(s)`)
  // The folders are printed with the answer, each with what it gave up, because
  // "the plugin is missing" is only answerable by looking at where the host
  // actually went. Folders that are not on this machine are left out.
  for (const dir of scanned.dirs ?? []) {
    console.log(`  em ${dir.path} — ${dir.files} arquivo(s)`)
  }
  for (const entry of found) {
    console.log(`  [${entry.kind}] ${entry.label ?? entry.path}  ${entry.error ? '— ' + entry.error : '-> ' + path.basename(entry.binary ?? entry.path)}`)
  }

  const vst2 = found.filter((entry) => entry.kind === 'vst2')
  const chosen = target ?? vst2[0]?.path
  if (!chosen) {
    console.log('nenhum VST2 instalado para testar — varridura mesma assim ok')
    return
  }

  console.log('\nabrir:', chosen)
  const described = await ask('describe', { path: chosen })
  if (!described.ok) throw new Error(described.error)
  const info = described.info
  console.log(`  ${info.name} — ${info.vendor} | ${info.numParams} parâmetros | ${info.numInputs}in/${info.numOutputs}out | atraso ${info.initialDelay} | cauda ${info.tail}`)
  console.log('  host pedidos pelo plugin:', info.hostCalls.join(' ') || '(nenhum)')
  for (const parameter of info.params.slice(0, 6)) {
    console.log(`    · ${parameter.name || '?'} = ${parameter.value.toFixed(3)} (${parameter.display})${parameter.label ? ' ' + parameter.label : ''}`)
  }

  const rendered = await ask('render', { path: chosen, sampleRate: 48000, seconds: 2 }, 60000)
  if (!rendered.ok) throw new Error(rendered.error)
  console.log(`\nrender: pico ${rendered.peak.toFixed(4)} | amostras audíveis ${rendered.nonSilent}/${rendered.total} | inválidas ${rendered.bad}`)
  const outFile = path.join(__dirname, 'selftest-render.wav')
  fs.writeFileSync(outFile, Buffer.from(rendered.outputWav))
  console.log('áudio escrito em', outFile)
  if (rendered.bad > 0 || rendered.nonSilent === 0) throw new Error('o plugin não devolveu áudio utilizável')

  // The bounce in the app hands the plugin a real stereo WAV, so the test does
  // the same: left and right carry different signals, and the report shows what
  // the plugin's own channel count made of them.
  const wav = require('./wav.cjs')
  const frames = 48000 * 2
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / 48000
    left[i] = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 1.2)
    right[i] = Math.sin(2 * Math.PI * 360 * t) * Math.exp(-t * 1.2)
  }
  const bounced = await ask('render', {
    path: chosen,
    sampleRate: 48000,
    inputWav: wav.encodeStereoFloat32(left, right, 48000),
  }, 60000)
  if (!bounced.ok) throw new Error(`bounce: ${bounced.error}`)
  const out = wav.decode(Buffer.from(bounced.outputWav))
  const peakOf = (channel) => channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  console.log(
    `\nbounce estéreo: ${out.left.length / 48000 | 0}s | pico L ${peakOf(out.left).toFixed(4)} ` +
      `| R ${peakOf(out.right).toFixed(4)} | inválidas ${bounced.bad}`,
  )
  fs.writeFileSync(path.join(__dirname, 'selftest-bounce.wav'), Buffer.from(bounced.outputWav))
  console.log('bounce escrito em', path.join(__dirname, 'selftest-bounce.wav'))
  if (bounced.bad > 0 || peakOf(out.left) === 0) throw new Error('o bounce não devolveu áudio utilizável')

  // ---------------------------------------------------------------- live pass
  /**
   * The producer's question is not "can a clip be bounced" but "can I hear the
   * amp while I play". So the same signal is fed block by block, at a real-time
   * block size, with the plugin left running between blocks — and what comes back
   * is stitched into one buffer and held up against the offline pass of the very
   * same audio. The timing is measured too, because every block of a live lane
   * pays this trip twice: in and out.
   */
  const liveBlock = 128
  const liveFrames = Math.floor((48000 * 0.5) / liveBlock) * liveBlock
  const dry = new Float32Array(liveFrames)
  for (let i = 0; i < liveFrames; i += 1) {
    const t = i / 48000
    dry[i] = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 1.2)
  }

  const opened = await ask('live-open', { path: chosen, sampleRate: 48000, block: liveBlock })
  if (!opened.ok) throw new Error(`live-open: ${opened.error}`)
  const size = Number(opened.geometry?.block) || liveBlock
  const expectedBlocks = Math.ceil(liveFrames / size)
  console.log(`\nsessão ao vivo aberta: bloco ${size} | ${opened.geometry.channels}in → ${opened.geometry.outputs}out`)

  // A bounce asked for the same plugin while it is being monitored re-cuts the
  // block size, so the worker puts the session down, runs the pass and picks the
  // session back up. That round trip is its own leg, at the end, where it cannot
  // disturb the clean comparison between the live and the offline pass below.

  const wetL = new Float32Array(liveFrames)
  const wetR = new Float32Array(liveFrames)
  // A block comes back as a Buffer under Electron and as {type:'Buffer', data}
  // under a plain fork, and the revived Buffer may sit at an offset that is not
  // float-aligned — so the copy is explicit instead of a view over the pool.
  const asFloats = (payload) => {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const values = new Float32Array(Math.floor(bytes.byteLength / 4))
    new Uint8Array(values.buffer).set(bytes.subarray(0, values.byteLength))
    return values
  }
  const trip = []
  let livePeak = 0
  let liveBad = 0
  let liveSilent = 0
  let blocks = 0
  for (let offset = 0; offset < liveFrames; offset += size) {
    const chunk = Math.min(size, liveFrames - offset)
    const view = dry.subarray(offset, offset + chunk)
    // A Buffer, not a Float32Array: the same IPC rule as the bounce reply.
    const packet = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    const started = process.hrtime.bigint()
    const answer = await ask('live-block', { path: chosen, left: packet, right: packet }, 20000)
    trip.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (!answer.ok) throw new Error(`live-block: ${answer.error}`)
    const left = asFloats(answer.left)
    const right = asFloats(answer.right)
    liveBad += answer.bad ?? 0
    blocks += 1
    for (let i = 0; i < chunk; i += 1) {
      const at = offset + i
      wetL[at] = left[i] ?? 0
      wetR[at] = right[i] ?? wetL[at]
      const magnitude = Math.max(Math.abs(wetL[at]), Math.abs(wetR[at]))
      if (magnitude > livePeak) livePeak = magnitude
      if (magnitude > 1e-6) liveSilent += 1
    }
  }
  const closed = await ask('live-close', { path: chosen })
  if (!closed.ok) throw new Error(`live-close: ${closed.error}`)
  const sorted = [...trip].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  console.log(
    `  ${blocks} bloco(s) de ${size} | pico ${livePeak.toFixed(4)} | audíveis ${liveSilent}/${liveFrames} ` +
      `| inválidas ${liveBad}`,
  )
  console.log(`  ida e volta por bloco: mediana ${median.toFixed(2)} ms | pior ${sorted[sorted.length - 1]?.toFixed(2)} ms`)
  console.log(`  sessão fechada: ${closed.blocks} chamada(s) no plugin, pico acumulado ${closed.peak?.toFixed(4)}`)
  if (liveBad > 0) throw new Error('a sessão ao vivo devolveu amostras inválidas')
  if (blocks !== expectedBlocks || Number(closed.blocks) !== expectedBlocks) {
    throw new Error(`o plugin processou ${closed.blocks} bloco(s) em vez de ${expectedBlocks}`)
  }
  if (livePeak === 0) throw new Error('a sessão ao vivo não devolveu áudio')

  // The same audio through the offline path, as the reference. A plugin whose
  // internals depend on the block size will differ, so the numbers are printed
  // rather than demanded — except that the signal has to be the same signal.
  const reference = await ask('render', {
    path: chosen,
    sampleRate: 48000,
    inputWav: wav.encodeStereoFloat32(dry, dry, 48000),
  }, 60000)
  if (!reference.ok) throw new Error(`referência offline: ${reference.error}`)
  const ref = wav.decode(Buffer.from(reference.outputWav))
  let dot = 0
  let own = 0
  let other = 0
  let far = 0
  for (let i = 0; i < liveFrames; i += 1) {
    const a = wetL[i]
    const b = ref.left[i] ?? 0
    dot += a * b
    own += a * a
    other += b * b
    far = Math.max(far, Math.abs(a - b))
  }
  const alike = own > 0 && other > 0 ? dot / Math.sqrt(own * other) : 0
  console.log(
    `  ao vivo × offline: correlação ${alike.toFixed(4)} | maior diferença ${far.toFixed(4)} ` +
      `(pico offline ${peakOf(ref.left).toFixed(4)})`,
  )
  if (alike <= 0) throw new Error('o passe ao vivo não é o mesmo áudio do passe do clipe')

  // A second session on the same instance: the plugin was left with its mains
  // closed and its buffers given back, and has to come up clean. This is where a
  // host that forgets to StopProcess shows up as a click, a stuck tail or a fault.
  const second = await ask('live-open', { path: chosen, sampleRate: 48000, block: liveBlock })
  if (!second.ok) throw new Error(`reabrir a sessão: ${second.error}`)
  let secondPeak = 0
  for (let i = 0; i < 8; i += 1) {
    const view = dry.subarray(i * size, i * size + size)
    const packet = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    const answer = await ask('live-block', { path: chosen, left: packet, right: packet }, 20000)
    if (!answer.ok) throw new Error(`segundo passe ao vivo: ${answer.error}`)
    for (const value of asFloats(answer.left)) secondPeak = Math.max(secondPeak, Math.abs(value))
  }
  const again = await ask('live-close', { path: chosen })
  console.log(`  reabrir e fechar de novo: ${again.ok && again.blocks === 8 ? 'ok' : 'errado'} | pico ${secondPeak.toFixed(4)}`)
  if (!again.ok || Number(again.blocks) !== 8) throw new Error('a segunda sessão não contou os blocos certos')

  // The workflow the producer actually walks: the amp is in the ear, and while
  // it is, a clip gets applied to the same plugin. A bounce reconfigures the block
  // size and reopens the mains, so the session has to be put down for the length
  // of the pass and picked back up on its own block size — the monitor goes dry
  // for a moment and comes back, rather than the bounce being refused or the live
  // buffers being left the wrong length.
  const third = await ask('live-open', { path: chosen, sampleRate: 48000, block: liveBlock })
  if (!third.ok) throw new Error(`sessão para o bounce: ${third.error}`)
  const pump = async (count) => {
    let peak = 0
    let errors = 0
    for (let i = 0; i < count; i += 1) {
      const view = dry.subarray(i * size, i * size + size)
      const packet = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
      const answer = await ask('live-block', { path: chosen, left: packet, right: packet }, 20000)
      if (!answer.ok) { errors += 1; continue }
      for (const value of asFloats(answer.left)) peak = Math.max(peak, Math.abs(value))
    }
    return { peak, errors }
  }
  const before = await pump(6)
  const passed = process.hrtime.bigint()
  const whileLive = await ask('render', { path: chosen, sampleRate: 48000, seconds: 0.05 }, 60000)
  const whileMs = Number(process.hrtime.bigint() - passed) / 1e6
  const after = await pump(6)
  const thirdClose = await ask('live-close', { path: chosen })
  console.log(
    `  bounce com a sessão aberta: ${whileLive.ok ? `aceito em ${whileMs.toFixed(0)} ms (pico ${whileLive.peak?.toFixed(4)})` : `recusado — ${whileLive.error}`}` +
      ` | ao vivo antes ${before.peak.toFixed(4)} | depois ${after.peak.toFixed(4)} ` +
      ` | bloco ${third.geometry?.block} → ${thirdClose.blocks ?? '?'} chamada(s) na sessão, ` +
      `${thirdClose.pluginCalls ?? '?'} desde o último passe do clipe`,
  )
  if (!whileLive.ok || !(Number(whileLive.peak) > 0)) {
    throw new Error(`o passe do clipe com a sessão aberta falhou: ${whileLive.error}`)
  }
  if (!(before.peak > 0) || !(after.peak > 0) || before.errors + after.errors > 0) {
    throw new Error('a escuta ao vivo não voltou depois do bounce')
  }
  if (Number(thirdClose.blocks) !== 12) throw new Error(`a sessão atravessada pelo plugin contou ${thirdClose.blocks} blocos, não 12`)

  // A VST3 is opened for its name, its channels and its parameters too: a scan

  // that finds a file is only worth anything if the engine can read that file.
  // This runs last on purpose — a third-party plugin that aborts on start takes
  // this plain Node worker down with it, and unlike the app this test has no
  // supervisor to hand it a fresh process, so the fall is reported, not retried.
  let fallen = ''
  for (const entry of found.filter((item) => !item.error && item.kind === 'vst3').slice(0, 3)) {
    const label = entry.label ?? path.basename(entry.path)
    try {
      const told = await ask('describe', { path: entry.path, sampleRate: 48000 }, 60000)
      if (!told.ok) {
        console.log(`  vst3 ${label}: não abriu — ${told.error}`)
        continue
      }
      const i = told.info
      console.log(
        `  vst3 ${i.name} — ${i.vendor} | ${i.numParams} parâmetros | ` +
          `${i.numInputs}in/${i.numOutputs}out | editor ${i.hasEditor ? 'sim' : 'não'}`,
      )
    } catch (error) {
      fallen = `${label} derrubou o processo (${error.message})`
      console.log(`  vst3 ${fallen} — é do plugin, não do host`)
      break
    }
  }
  return fallen
}

main()
  .then((caveat) => {
    console.log('\nOK — motor nativo de plugins funcionando' + (caveat ? `, mas ${caveat}` : ''))
    worker.kill()
  })
  .catch((error) => {
    console.error('\nFALHA:', error.message)
    worker.kill()
    process.exitCode = 1
  })
