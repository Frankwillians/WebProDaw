/**
 * Plugin discovery for the native app — no loading, no risk.
 *
 * A .dll is only interesting if it is 64-bit and exports VSTPluginMain; a .vst3
 * bundle is only interesting if its binary exports GetPluginFactory. Both are
 * answered by reading the PE header straight off disk, so a broken or 32-bit
 * plugin is filtered out before anything is ever loaded into a process.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** Machine type + exported symbol names of a Windows PE file. */
function peInfo(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return { error: 'não é um executável Windows' }
  const peOff = buf.readUInt32LE(0x3c)
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return { error: 'assinatura PE inválida' }
  const machine = buf.readUInt16LE(peOff + 4)
  const sections = buf.readUInt16LE(peOff + 6)
  const optSize = buf.readUInt16LE(peOff + 20)
  const opt = peOff + 24
  const magic = buf.readUInt16LE(opt)
  const dataDir = magic === 0x10b ? opt + 96 : opt + 112
  const exportRva = buf.readUInt32LE(dataDir)
  const secOff = opt + Math.min(optSize, magic === 0x10b ? 224 : 240)
  const secs = []
  for (let i = 0; i < sections; i += 1) {
    const s = secOff + i * 40
    if (s + 40 > buf.length) break
    secs.push({ va: buf.readUInt32LE(s + 12), vsize: buf.readUInt32LE(s + 8), raw: buf.readUInt32LE(s + 20) })
  }
  const rvaToOff = (rva) => {
    const section = secs.find((item) => rva >= item.va && rva < item.va + Math.max(item.vsize, 1))
    return section ? section.raw + (rva - section.va) : -1
  }
  const exports = []
  if (exportRva) {
    const e = rvaToOff(exportRva)
    // IMAGE_EXPORT_DIRECTORY: +0 chars, +4 timestamp, +8/+10 versions,
    // +12 name, +16 ordinalBase, +20 numberOfFunctions, +24 numberOfNames,
    // +28 AddressOfFunctions, +32 AddressOfNames, +36 AddressOfNameOrdinals.
    if (e >= 0 && e + 36 <= buf.length) {
      const nameCount = buf.readUInt32LE(e + 24)
      const namesRva = buf.readUInt32LE(e + 32)
      const n = rvaToOff(namesRva)
      for (let i = 0; i < Math.min(nameCount, 4096) && n >= 0; i += 1) {
        const strOff = rvaToOff(buf.readUInt32LE(n + i * 4))
        if (strOff < 0 || strOff >= buf.length) continue
        let end = strOff
        while (end < buf.length && buf[end] !== 0 && end - strOff < 256) end += 1
        exports.push(buf.slice(strOff, end).toString('latin1'))
      }
    }
  }
  return {
    arch: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : `0x${machine.toString(16)}`,
    exports,
  }
}

/**
 * Plugin names, as the producer reads them.
 *
 * REAPER's VST3 reference: the folders the installer registered in the Windows
 * registry, plus the per-user folders. Paths in the registry are often written
 * with %VST3% style variables, so they go through the same expansion as anything
 * the producer types into the "pasta extra" dialog.
 */
const REG_KEYS = [
  'HKCU\\SOFTWARE\\VST',
  'HKLM\\SOFTWARE\\VST',
  'HKLM\\SOFTWARE\\WOW6432Node\\VST',
]
const REG_VALUES = ['VST3 Install Path', 'VST2 Install Path', 'VST Plugins Path', 'VST Path']

function expandEnv(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const replacement = process.env[name] ?? Object.entries(process.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    return replacement ?? whole
  })
}

/**
 * `reg query` prints the values of a key, one per line:
 *
 *     "VST3 Install Path"    REG_SZ    C:\Program Files\Common Files\VST3
 *
 * The name is always in quotes, so the path is everything after the second run
 * of spaces that follows the closing quote. Asking for a value that is not there
 * is an error and prints nothing useful, so the whole key is read and the wanted
 * names are matched from its text — one call per key instead of one per name. The
 * error text `reg` writes goes nowhere: a machine with no VST registry is the
 * normal case, not something to complain about on the console.
 */
function registryDirs() {
  // Cached for the life of the process: the scan runs whenever a panel opens and
  // a sub-process, a `reg` call costs more than every folder on the disk.
  if (registryDirs.cached) return registryDirs.cached
  const dirs = []
  for (const key of REG_KEYS) {
    let text = ''
    try {
      text = execFileSync('reg', ['query', key], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*"([^"]+)"\s+REG_[A-Z_]+\s+(.*)$/.exec(line)
      if (!match) continue
      if (!REG_VALUES.some((name) => name.toLowerCase() === match[1].toLowerCase())) continue
      // One value holds several folders, separated by semicolons.
      for (const piece of match[2].split(';')) {
        const dir = expandEnv(piece.trim())
        if (dir) dirs.push(dir)
      }
    }
  }
  return dirs
}

/** Folders the host would look in: registered ones first, then the usual ones. */
function searchDirs() {
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
  const common = path.join(programFiles, 'Common Files')
  const commonX86 = path.join(programFilesX86, 'Common Files')
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const appData = process.env.APPDATA ?? ''
  const userDocs = path.join(process.env.USERPROFILE ?? '', 'Documents')
  const list = [
    ...registryDirs(),
    path.join(common, 'VST3'),
    path.join(commonX86, 'VST3'),
    path.join(common, 'VST'),
    path.join(commonX86, 'VST'),
    path.join(programFiles, 'Steinberg', 'VstPlugins'),
    path.join(programFilesX86, 'Steinberg', 'VstPlugins'),
    path.join(programFiles, 'VSTPlugins'),
    path.join(programFilesX86, 'VSTPlugins'),
    path.join(common, 'Avid', 'Audio', 'Plugins', 'VST'),
    // Installers that run without admin rights put plugins under the user.
    ...(localAppData
      ? [
          path.join(localAppData, 'Programs', 'Common', 'VST'),
          path.join(localAppData, 'Programs', 'Common', 'VST3'),
          path.join(localAppData, 'Programs', 'VST3'),
          path.join(localAppData, 'Programs', 'VST'),
          path.join(localAppData, 'VST3'),
        ]
      : []),
    ...(appData ? [path.join(appData, 'VST3'), path.join(appData, 'VST')] : []),
    ...(userDocs ? [path.join(userDocs, 'VSTPlugins'), path.join(userDocs, 'VST')] : []),
  ]
  const envPath = [process.env.OPDAW_VST_PATH, process.env.VST_PATH, process.env.VST3_PATH]
    .filter(Boolean)
    .flatMap((value) => expandEnv(value).split(';'))
    .map((item) => item.trim())
    .filter(Boolean)
  const seen = new Set()
  const ordered = []
  // An existing folder is worth listing twice only once; one that is not there
  // costs nothing to skip, so a producer with a custom install sees a longer list
  // but never a slower scan.
  for (const dir of [...list, ...envPath]) {
    const key = dir.toLowerCase().replace(/[\\/]+$/, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    ordered.push(dir)
  }
  return ordered
}

function walk(dir, depth, out) {
  if (depth < 0) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // A .vst3 / .component bundle IS the plugin: its binary sits inside.
      if (/(\.vst3|\.component)$/i.test(entry.name)) {
        out.push(full)
        continue
      }
      walk(full, depth - 1, out)
    } else if (entry.isFile() && /\.(dll|vst|dylib|so)$/i.test(entry.name)) {
      out.push(full)
    }
  }
}

/**
 * The bundle's own description, read from its `moduleinfo.json`.
 *
 * Two families of VST3 bundles exist in the wild. Steinberg's SDK writes a file
 * with `moduleName` and a `moduleInfo.categoryPaths` map; the older style, still
 * shipped by big names, writes capitalised keys — `Name`, `Bundle`, `Classes`,
 * and a `Windows x86 64 bit: "./x86_64-win"` map — and closes its objects with a
 * trailing comma that strict JSON refuses. Both are read here, leniently, because
 * the bundle knows where its own binary is and a hard-coded guess does not.
 */
function looseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    /* the SDK writes valid JSON; third parties do not always */
  }
  try {
    return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return null
  }
}

/** The platform key of a category path, cut down to the words that matter. */
function platformWords(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Does this platform key describe the machine the host is running on? */
function isThisPlatform(key) {
  const words = platformWords(key)
  const win = /(win|windows|pc)/.test(words)
  const bitness = process.arch === 'arm64' ? /(arm|aarch)/.test(words) : /(x86|64|i386|x64)/.test(words) && !/32/.test(words)
  return win && bitness
}

function moduleInfo(bundle) {
  const hits = []
  const seek = (dir, depth) => {
    if (depth < 0) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) seek(full, depth - 1)
      else if (entry.name.toLowerCase() === 'moduleinfo.json') hits.push(full)
    }
  }
  seek(path.join(bundle, 'Contents'), 3)
  if (hits.length === 0) seek(bundle, 1)
  const base = path.basename(bundle).replace(/(\.vst3|\.component)$/i, '')
  for (const file of hits) {
    let raw = null
    try {
      raw = looseJson(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const factories = Array.isArray(raw.factories) ? raw.factories : []
    // The old style writes its keys with spaces ("Sub Categories"), the SDK
    // writes them camel-cased; both spellings mean the same thing.
    const subCategoriesOf = (klass) => klass?.['Sub Categories'] ?? klass?.SubCategories ?? klass?.subCategories ?? []
    const classes = Array.isArray(raw.Classes)
      ? raw.Classes.map((klass) => ({
          name: klass?.Name ?? '',
          vendor: klass?.Vendor ?? '',
          category: klass?.Category ?? '',
          subCategories: subCategoriesOf(klass),
          classId: klass?.CID ?? '',
        }))
      : factories.flatMap((factory) =>
          (factory?.classes ?? []).map((klass) => ({
            name: klass?.name ?? '',
            vendor: klass?.vendor ?? '',
            category: klass?.category ?? '',
            subCategories: subCategoriesOf(klass),
            classId: klass?.cid ?? '',
          })),
        )
    const folderMap = raw.moduleInfo?.categoryPaths ?? raw['Category Paths'] ?? raw['CategoryPaths'] ?? {}
    const categoryPaths = {}
    if (folderMap && typeof folderMap === 'object') {
      for (const [platform, folder] of Object.entries(folderMap)) {
        if (typeof folder === 'string' && folder.trim()) categoryPaths[platform] = folder.trim()
      }
    }
    const name = raw.moduleName ?? raw.module ?? raw.Name ?? base
    return {
      module: name,
      vendor: raw['Factory Info']?.Vendor ?? classes.find((klass) => klass.vendor)?.vendor ?? '',
      // The file name of the binary: the SDK calls it `module`, the old style
      // calls it `Bundle`. Empty means the description does not say.
      binaryName: typeof raw.module === 'string' ? raw.module : raw.Bundle ?? '',
      categoryPaths,
      classes,
    }
  }
  return null
}

/** Every regular file under a bundle's Contents folder. */
function bundleFiles(bundle) {
  const out = []
  const seek = (dir, depth) => {
    if (depth < 0) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) seek(full, depth - 1)
      else if (entry.isFile()) out.push(full)
    }
  }
  seek(path.join(bundle, 'Contents'), 4)
  // A bundle that is not a folder at all — a bare .vst3 file — answers with itself.
  if (out.length === 0) {
    try {
      if (fs.statSync(bundle).isFile()) return [bundle]
    } catch {
      /* nothing to read */
    }
  }
  return out
}

/**
 * The binary inside a VST3 bundle, for the platforms we run on.
 *
 * Nothing here assumes a folder spelling. Every file the bundle carries is
 * ranked — the name recorded in its own moduleinfo.json first, then this host's
 * machine and OS, then any other Windows folder, then the rest — and the first
 * candidate that reads as a 64-bit PE with plugin exports is the answer. So a
 * bundle packed in an unusual way still opens, and a bundle holding only
 * resources is honestly reported as having no binary.
 */
function vst3Binary(bundle, exported = () => false) {
  const wanted = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const description = moduleInfo(bundle)
  const listed = Object.entries(description?.categoryPaths ?? {})
    .filter(([, folder]) => typeof folder === 'string' && folder.trim())
    .map(([platform, folder]) => ({ platform, folder: folder.trim().replace(/\\/g, '/') }))
  const pick =
    listed.find((item) => isThisPlatform(item.platform)) ??
    listed.find((item) => /(win|windows|pc)/.test(platformWords(item.platform)))
  if (pick) {
    const dir = path.join(bundle, 'Contents', pick.folder)
    // `names` is tried in order and each one is only kept if it is really a file,
    // so a spelling that does not exist costs a stat and nothing else. The
    // bundle's own name with its extension is included: a Windows binary is
    // conventionally `<Module>.vst3`, which is the bundle's name verbatim.
    const names = [
      description.binaryName,
      `${description.binaryName}.vst3`,
      description.module,
      `${description.module}.vst3`,
      path.basename(bundle),
    ]
    for (const name of names.filter(Boolean)) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* the recorded name is not there; the sweep below will look */
      }
    }
  }

  const base = path.basename(bundle).replace(/(\.vst3|\.component)$/i, '').toLowerCase()
  const scored = bundleFiles(bundle)
    // A bundle carries icons, translations, manuals and JSON beside the binary;
    // none of those can be it.
    .filter((file) => !/(\.json|\.txt|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.ico|\.icns|\.rtf|\.html|\.css|\.plist|\.strings|\.ttf|\.otf|\.woff2?|\.qcb|\.xml|\.rcc|\.wav|\.mp3|\.png\.rpl)$/i.test(file))
    .map((file) => {
      const relative = path.relative(path.join(bundle, 'Contents'), file)
      const folder = (relative.split(/[\\/]/)[0] ?? '').toLowerCase()
      const name = path.basename(file).toLowerCase()
      let rank = 60
      if (folder === wanted || folder.includes(wanted)) rank = 0
      else if (folder.includes('x86_64') || folder.includes('amd64')) rank = 10
      else if (folder.includes('win')) rank = 20
      else if (folder === 'resources') rank = 95
      else if (folder.includes('mac') || folder.includes('linux')) rank = 90
      if (/\.(dll|vst3|exe)$/.test(name)) rank += 2
      if (!name.includes('.')) rank -= 1
      if (name === base || name === `${base}.vst3` || name === `${base}.dll`) rank -= 4
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        /* ranked anyway: the read will report the failure */
      }
      return { file, rank, size }
    })
    .sort((a, b) => a.rank - b.rank || b.size - a.size)

  for (const candidate of scored) {
    try {
      if (exported(candidate.file)) return candidate.file
    } catch {
      /* unreadable, so the next candidate answers */
    }
  }
  return scored.length > 0 ? scored[0].file : null
}

/** Names and categories straight out of the bundle's moduleinfo.json. */
function vst3Meta(bundle) {
  const description = moduleInfo(bundle)
  if (!description) return null
  return {
    module: description.module,
    info: { binary: description.binaryName, categoryPaths: description.categoryPaths },
    classes: description.classes,
  }
}

/**
 * Folders the producer pointed the host at, kept between runs.
 *
 * The registry and the standard folders cover an installed plugin; a .dll that
 * lives in a download folder or on a second disk does not. Instead of pretending
 * to search the whole machine, the app asks for one folder and remembers it.
 */
function extraDirsFile() {
  const dir = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
  return path.join(dir, 'OpenDAW', 'vst-folders.json')
}

function readExtraDirs() {
  try {
    const raw = JSON.parse(fs.readFileSync(extraDirsFile(), 'utf8'))
    return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && item.trim()) : []
  } catch {
    return []
  }
}

function writeExtraDirs(dirs) {
  // Windows paths do not care about case, and a trailing slash is the same
  // folder — so the list is deduplicated the way the scan would see it.
  const clean = []
  const seen = new Set()
  for (const item of dirs.map((entry) => String(entry).trim()).filter(Boolean)) {
    const key = item.toLowerCase().replace(/[\\/]+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(item)
  }
  fs.mkdirSync(path.dirname(extraDirsFile()), { recursive: true })
  fs.writeFileSync(extraDirsFile(), JSON.stringify(clean, null, 2))
  return clean
}

function addExtraDir(dir) {
  const wanted = String(dir ?? '').trim()
  if (!wanted) return { error: 'nenhuma pasta informada' }
  let full = wanted
  try {
    full = fs.realpathSync.native(wanted)
  } catch {
    return { error: `não deu para ler a pasta: ${wanted}` }
  }
  if (!fs.statSync(full).isDirectory()) return { error: 'o caminho não é uma pasta' }
  const dirs = writeExtraDirs([...readExtraDirs(), full])
  return { dirs, added: full }
}

/**
 * The folders a scan would walk, in order. The panel shows them so a producer who
 * just installed a plugin can tell whether the host ever looked where it landed.
 */
function scanDirs() {
  return [...new Set([...searchDirs(), ...readExtraDirs()])]
}

function scan(extraDirs = [], tally = null) {
  const found = []
  const files = []
  // The folders the producer added are read from disk every scan, so a folder
  // picked in one session is looked in by the next one without a restart.
  // One folder, one walk — however many ways it was written down.
  const wanted = []
  const lookedUp = new Set()
  for (const dir of [...scanDirs(), ...extraDirs]) {
    const clean = String(dir).trim()
    const key = clean.toLowerCase().replace(/[\\/]+$/, '')
    if (!clean || lookedUp.has(key)) continue
    lookedUp.add(key)
    wanted.push(clean)
  }
  for (const dir of wanted) {
    const before = files.length
    walk(dir, 4, files)
    // `tally` is for a caller that wants to say where it looked, per folder.
    if (Array.isArray(tally)) tally.push({ path: dir, exists: fs.existsSync(dir), files: files.length - before })
  }
  const seen = new Set()
  for (const file of files) {
    if (seen.has(file.toLowerCase())) continue
    seen.add(file.toLowerCase())
    const isBundle = /(\.vst3|\.component)$/i.test(file)
    // The sweep asks the PE header whether each candidate exports a plugin
    // entry, so a bundle carrying more than one binary gives up the real one
    // rather than the largest.
    const looksLikePlugin = (candidate) => {
      const read = peInfo(candidate)
      if (read.error || read.arch !== 'x64') return false
      return (
        read.exports.includes('VSTPluginMain') ||
        read.exports.includes('AudioEffectMain') ||
        read.exports.includes('main') ||
        read.exports.includes('GetPluginFactory') ||
        read.exports.includes('AllocatePluginFactories')
      )
    }
    const binary = isBundle ? vst3Binary(file, looksLikePlugin) : file
    if (!binary) {
      found.push({ path: file, kind: isBundle ? 'vst3' : 'vst2', error: 'binário interno não encontrado' })
      continue
    }
    let info
    try {
      info = peInfo(binary)
    } catch (error) {
      found.push({ path: file, kind: isBundle ? 'vst3' : 'vst2', error: `não deu para ler: ${error.message}` })
      continue
    }
    if (info.error) {
      found.push({ path: file, kind: isBundle ? 'vst3' : 'vst2', error: info.error })
      continue
    }
    const vst2 = info.exports.includes('VSTPluginMain') || info.exports.includes('AudioEffectMain') || info.exports.includes('main')
    const vst3 = info.exports.includes('GetPluginFactory') || info.exports.includes('AllocatePluginFactories')
    const meta = isBundle ? vst3Meta(file) : null
    // The name the producer reads in the list: the bundle says what it is
    // called, and a loose .dll is named by its own file.
    const label = meta?.module ?? path.basename(binary).replace(/(\.vst3|\.dll|\.vst|\.component)$/i, '')
    if (info.arch !== 'x64') {
      const why = info.arch === 'x86' ? 'precisa de um host de 32 bits' : `não é um binário x64 de Intel (é ${info.arch})`
      found.push({ path: file, label, kind: isBundle ? 'vst3' : 'vst2', arch: info.arch, error: why })
      continue
    }
    if (!vst2 && !vst3) {
      found.push({ path: file, label, kind: 'estranho', arch: info.arch, exports: info.exports.slice(0, 8), error: 'não exporta entrada de plugin' })
      continue
    }
    const entry = {
      path: file,
      label,
      binary,
      kind: vst3 && isBundle ? 'vst3' : vst2 ? 'vst2' : 'vst3',
      arch: info.arch,
      entry: vst3 ? 'GetPluginFactory' : 'VSTPluginMain',
      exports: info.exports.length,
    }
    if (meta) entry.meta = meta
    found.push(entry)
  }
  return found
}

module.exports = { scan, scanDirs, peInfo, searchDirs, vst3Binary, moduleInfo, addExtraDir, readExtraDirs, writeExtraDirs, extraDirsFile }
