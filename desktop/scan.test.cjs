/**
 * What the discovery layer is allowed to promise, without loading anything.
 *
 *   node --test desktop/scan.test.cjs
 *
 * Nothing here touches a real plugin: the scanner's job is to decide *which*
 * files are worth opening, and that decision is made from the PE header and the
 * bundle's own `moduleinfo.json`. So the test builds bundles out of text files on
 * a temporary folder — the odd spellings installers really do ship — and checks
 * the scanner points at the binary inside, and nothing else.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { searchDirs, scanDirs, moduleInfo, vst3Binary, peInfo, writeExtraDirs, readExtraDirs } = require('./scan.cjs')

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opdaw-scan-'))

/** A bundle with the given inner files, at `dir/Name.vst3`. */
function bundle(root, name, files) {
  const at = path.join(root, name)
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(at, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return at
}

// A stand-in for "the PE reader says this is a plugin": the sweep only ever asks
// the predicate it was handed, so the test can pass one that trusts a file name.
const byName = (candidate) => /\.dll$|\.vst3$/i.test(candidate) && !/Resources/i.test(candidate)

test('a Windows bundle found by its own moduleinfo.json, whatever the folder is spelled', () => {
  const root = scratch()
  // The spelling the SDK does not use: `win-x86_64` instead of `x86_64-win`, and
  // a binary with a .dll name that is not the bundle's name.
  const at = bundle(root, 'Odd Thing.vst3', {
    'Contents/Resources/moduleinfo.json': JSON.stringify({
      moduleName: 'OddThing',
      module: 'OddThing',
      moduleInfo: { categoryPaths: { 'win-x86_64': './win-x86_64', 'mac-x86_64': './mac-x86_64' } },
      factories: [{ classes: [{ name: 'Odd Thing', category: 'Audio Module Class', subCategories: ['Fx'] }] }],
    }),
    'Contents/win-x86_64/OddThing.dll': 'PE',
    'Contents/mac-x86_64/OddThing': 'macho',
  })
  const found = vst3Binary(at, (file) => file.endsWith('OddThing.dll'))
  assert.match(found, /win-x86_64[\\/]OddThing\.dll$/)
})

test('the old capitalised moduleinfo.json is read, trailing commas and all', () => {
  const root = scratch()
  const at = bundle(root, 'Legacy.vst3', {
    'Contents/Resources/moduleinfo.json': [
      '{',
      '  "Name": "Legacy Delay",',
      '  "Version": "1.0.0",',
      '  "Factory Info": { "Vendor": "Someone", "URL": "", },',
      '  "Bundle": "Legacy",',
      '  "Category Paths": { "Windows x86 64 bit": "./x86_64-win", },',
      '  "Classes": [',
      '    { "CID": "AB", "Category": "Audio Module Class", "Name": "Legacy Delay",',
      '      "Vendor": "Someone", "Sub Categories": ["Fx", "Delay",], },',
      '  ],',
      '}',
    ].join('\n'),
    'Contents/x86_64-win/Legacy.vst3': 'PE',
  })
  const info = moduleInfo(at)
  assert.strictEqual(info.module, 'Legacy Delay', 'the producer-visible name comes from "Name"')
  assert.strictEqual(info.vendor, 'Someone', 'the vendor comes from "Factory Info"')
  assert.strictEqual(info.binaryName, 'Legacy', 'the binary file name comes from "Bundle"')
  assert.strictEqual(info.classes.length, 1)
  assert.deepStrictEqual(info.classes[0].subCategories, ['Fx', 'Delay'], '"Sub Categories" with a space')
  // The recorded folder and the recorded name, joined: no hard-coded guess needed.
  assert.match(vst3Binary(at, byName), /x86_64-win[\\/]Legacy\.vst3$/)
})

test('a bundle with only resources has no binary, and says so', () => {
  const root = scratch()
  const at = bundle(root, 'Empty.vst3', {
    'Contents/Resources/icon.png': 'not a binary',
    'Contents/Resources/manual.txt': 'not a binary',
  })
  assert.strictEqual(vst3Binary(at, () => true), null)
})

test('a bundle whose binary is not named after the bundle is still found', () => {
  const root = scratch()
  // The vendor put the working file in the platform folder under its own name and
  // wrote no description at all; the sweep has to rank the files it can see.
  const at = bundle(root, 'Mystery.vst3', {
    'Contents/x86_64-win/vendor-engine.dll': 'PE',
    'Contents/x86_64-win/README.md': 'docs',
    'Contents/Resources/ui.json': '{}',
  })
  assert.match(vst3Binary(at, (file) => file.endsWith('.dll')), /vendor-engine\.dll$/)
  assert.strictEqual(moduleInfo(at), null, 'a bundle with no description is honest about it')
})

test('the folders a scan walks are listed once, and a path override joins them', () => {
  const extra = path.join(scratch(), 'plugins')
  fs.mkdirSync(extra, { recursive: true })
  const previous = process.env.OPDAW_VST_PATH
  process.env.OPDAW_VST_PATH = extra
  try {
    const dirs = searchDirs()
    assert.ok(dirs.length > 0, 'a Windows host always has candidate folders')
    assert.ok(dirs.includes(extra), 'the folder the producer named is looked in')
    const lower = dirs.map((dir) => dir.toLowerCase())
    assert.strictEqual(new Set(lower).size, lower.length, 'no folder is walked twice')
    assert.ok(scanDirs().every((dir) => dirs.includes(dir)))
  } finally {
    if (previous === undefined) delete process.env.OPDAW_VST_PATH
    else process.env.OPDAW_VST_PATH = previous
  }
})

test('a %VARIABLE% in the override is expanded before the folder is used', () => {
  const previous = process.env.OPDAW_VST_PATH
  process.env.OPDAW_VST_PATH = '%USERPROFILE%\\\\Downloads'
  try {
    const dirs = searchDirs()
    const hit = dirs.find((dir) => /Downloads$/i.test(dir))
    assert.ok(hit, `the variable was left in place: ${JSON.stringify(dirs.filter((d) => d.includes('%')))}`)
    assert.ok(!hit.includes('%'), 'no unexpanded variable survives')
  } finally {
    if (previous === undefined) delete process.env.OPDAW_VST_PATH
    else process.env.OPDAW_VST_PATH = previous
  }
})

test('an added folder is remembered in plain text and read back', () => {
  // The list is the app's own file, so the test points APPDATA somewhere else
  // first: the producer's real list is never touched by a test run.
  const fakeAppData = scratch()
  const previous = process.env.APPDATA
  process.env.APPDATA = fakeAppData
  try {
    const { addExtraDir, extraDirsFile } = require('./scan.cjs')
    const pluginDir = scratch()
    const first = addExtraDir(pluginDir)
    assert.strictEqual(first.error, undefined, first.error)
    assert.deepStrictEqual(readExtraDirs(), [first.added])
    assert.ok(fs.existsSync(extraDirsFile()), 'the list is on disk, not in memory')
    // The same folder twice is one folder; a file is not a folder.
    assert.strictEqual(addExtraDir(pluginDir).dirs.length, 1)
    const aFile = path.join(pluginDir, 'thing.dll')
    fs.writeFileSync(aFile, 'no')
    assert.match(addExtraDir(aFile).error, /não é uma pasta/)
  } finally {
    if (previous === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous
  }
})

test('a text file is not a plugin, and the header says why', () => {
  const root = scratch()
  const file = path.join(root, 'fake.dll')
  fs.writeFileSync(file, 'isto não é um executável')
  const info = peInfo(file)
  assert.match(info.error, /executável/i, 'the answer is a reason, not a crash')
  assert.strictEqual(info.arch, undefined, 'a file that is not a PE has no architecture to report')
})

test('a real Windows binary is read as x64 and refused for having no plugin entry', (t) => {
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const file = path.join(system, 'System32', 'notepad.exe')
  if (!fs.existsSync(file)) {
    t.skip('sem executável do Windows para ler')
    return
  }
  const info = peInfo(file)
  assert.strictEqual(info.error, undefined, info.error)
  // An x64 Windows is the only machine this app runs on; a 32-bit test host would
  // legitimately report something else, and that is not a scanner bug.
  if (info.arch !== 'x64') {
    t.skip(`este Windows não é x64 (${info.arch})`)
    return
  }
  assert.ok(!info.exports.includes('VSTPluginMain'), 'notepad is not a VST')
  assert.ok(!info.exports.includes('GetPluginFactory'), 'notepad is not a VST3 either')
})

test('writeExtraDirs keeps one entry per folder and drops blanks', () => {
  const fakeAppData = scratch()
  const previous = process.env.APPDATA
  process.env.APPDATA = fakeAppData
  try {
    const a = scratch()
    const b = scratch()
    const saved = writeExtraDirs([a, ` ${b} `, '', a.toUpperCase(), '   '])
    assert.strictEqual(saved.length, 2, 'the same folder in another case is the same folder')
    assert.deepStrictEqual(readExtraDirs(), saved)
    assert.deepStrictEqual(writeExtraDirs([]), [], 'the list can be emptied')
  } finally {
    if (previous === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous
  }
})
