#!/usr/bin/env node
/**
 * Monta o OpenDAW portátil — uma pasta que abre com duplo clique, sem npm, sem
 * Node instalado, sem servidor de desenvolvimento.
 *
 * Não baixa nada: o Electron já está em desktop/node_modules/electron/dist e o
 * motor de plugins (koffi) já está instalado. O script copia a distribuição do
 * Electron para release/OpenDAW, troca o nome do executável, e coloca o app
 * dentro de resources/app — que é exatamente onde o Electron procura um app
 * quando existe um.
 *
 *   node desktop/build-app.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const DESKTOP = __dirname
const ROOT = path.join(DESKTOP, '..')
const ELECTRON_DIST = path.join(DESKTOP, 'node_modules', 'electron', 'dist')
const WEB_DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, 'release', 'OpenDAW')
const APP = path.join(OUT, 'resources', 'app')

/** Everything the native side needs; the .cjs files are the whole engine. */
const DESKTOP_FILES = [
  'main.cjs',
  'preload.cjs',
  'server.cjs',
  'plugins.cjs',
  'scan.cjs',
  'vst2.cjs',
  'vst3.cjs',
  'plugin-gui.cjs',
  'vst-worker.cjs',
  'wav.cjs',
  'selftest-native.cjs',
]

/** koffi loads its prebuilt binary through this package, so it has to travel. */
const NATIVE_DEPS = ['koffi', '@koromix/koffi-win32-x64']

function fail(message) {
  console.error(`\nNÃO DÁ: ${message}\n`)
  process.exit(1)
}

function sizeMb(dir) {
  let bytes = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else bytes += fs.statSync(full).size
    }
  }
  walk(dir)
  return (bytes / 1024 / 1024).toFixed(1)
}

function main() {
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
    fail(`falta a distribuição do Electron em ${ELECTRON_DIST}. Rode "npm install" dentro de desktop/.`)
  }
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    fail(`falta o app gerado em ${WEB_DIST}. Rode "npm run build" na raiz do projeto.`)
  }
  for (const file of DESKTOP_FILES) {
    if (!fs.existsSync(path.join(DESKTOP, file))) fail(`falta desktop/${file}`)
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))

  console.log(`gerando ${OUT}`)
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(APP, { recursive: true })

  console.log('  copiando o Electron (uns segundos)')
  fs.cpSync(ELECTRON_DIST, OUT, {
    recursive: true,
    // resources/default_app.asar is the "no app" screen; ours sits next to it.
    filter: (source) => !source.endsWith('default_app.asar'),
  })

  const exe = path.join(OUT, 'OpenDAW.exe')
  fs.renameSync(path.join(OUT, 'electron.exe'), exe)

  console.log('  montando resources/app')
  fs.mkdirSync(path.join(APP, 'desktop'), { recursive: true })
  for (const file of DESKTOP_FILES) {
    fs.copyFileSync(path.join(DESKTOP, file), path.join(APP, 'desktop', file))
  }
  if (fs.existsSync(path.join(DESKTOP, 'icon.png'))) {
    fs.copyFileSync(path.join(DESKTOP, 'icon.png'), path.join(APP, 'desktop', 'icon.png'))
  }

  fs.writeFileSync(
    path.join(APP, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.name ?? 'opendaw-desktop',
        productName: manifest.productName ?? 'OpenDAW',
        version: manifest.version ?? '0.0.0',
        description: manifest.description ?? 'OpenDAW para Windows',
        main: 'desktop/main.cjs',
        type: 'commonjs',
        private: true,
      },
      null,
      2,
    )}\n`,
  )

  console.log('  copiando o motor de plugins')
  fs.mkdirSync(path.join(APP, 'node_modules'), { recursive: true })
  for (const dependency of NATIVE_DEPS) {
    const from = path.join(DESKTOP, 'node_modules', ...dependency.split('/'))
    if (!fs.existsSync(from)) fail(`falta desktop/node_modules/${dependency}`)
    fs.cpSync(from, path.join(APP, 'node_modules', ...dependency.split('/')), { recursive: true })
  }

  console.log('  copiando o app de áudio')
  fs.cpSync(WEB_DIST, path.join(APP, 'dist'), { recursive: true })

  console.log(`\npronto: ${exe}`)
  console.log(`tamanho: ${sizeMb(OUT)} MB`)
  console.log('abre com duplo clique, ou: release/OpenDAW/OpenDAW.exe')
}

main()
