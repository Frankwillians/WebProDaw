import { LoudnessMeterCore } from './src/audio/loudness-meter-core.ts'
const RATE = 48000
const core = new LoudnessMeterCore(RATE)
const sine = (f, a, n) => Float32Array.from(Array.from({length: n}, (_, i) => a * Math.sin(2*Math.PI*f*i/RATE)))
const run = (arr) => { let last = null; for (let s = 0; s < arr.length; s += 128) { const c = arr.subarray(s, Math.min(s+128, arr.length)); const r = core.processBlock(c, c); if (r) last = r } return last }
const tone = sine(1000, 0.1, RATE*4)
console.log('after tone', run(tone))
const zeros = new Float32Array(RATE*6)
console.log('after 6s zeros', run(zeros))
console.log('state', core.sumL, core.sumR, core.powerSum, core.powerFilled, core.ringFilled, core.windowSize, core.stepSize, core.blockPeaks.length, core.peakFilled)
let nz = 0
for (let i = 0; i < core.ringL.length; i++) if (core.ringL[i] !== 0) nz++
console.log('ringL nonzero', nz, 'max', core.ringL.reduce((m,v)=>Math.max(m,v),0))
let pnz = 0
for (let i = 0; i < core.powers.length; i++) if (core.powers[i] !== 0) pnz++
console.log('powers nonzero', pnz, [...core.powers].slice(0,5))
let bpnz = 0
for (let i = 0; i < core.blockPeaks.length; i++) if (core.blockPeaks[i] !== 0) bpnz++
console.log('blockPeaks nonzero', bpnz, 'sample', [...core.blockPeaks].slice(0,4))
