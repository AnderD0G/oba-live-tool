const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

// NSIS cannot open >260-character include paths in pnpm's nested store.
// Stage only immutable builder templates in a short temporary path; do not modify node_modules.
const builderRequire = createRequire(require.resolve('electron-builder'))
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const pathManager = libRequire('./util/pathManager')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oba-nsis-'))
const templates = path.join(temp, 'templates')
fs.cpSync(pathManager.getTemplatePath(''), templates, { recursive: true })
pathManager.getTemplatePath = file => path.join(templates, file)
const { build, Platform, Arch } = require('electron-builder')
const pkg = require('../package.json')
const prepackaged = process.argv.includes('--prepackaged')
  ? path.resolve(`release/${pkg.version}/win-unpacked`)
  : undefined
build({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  prepackaged,
  config: { electronDist: 'node_modules/electron/dist' },
})
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    // mkdtemp creates this known child exclusively for this invocation.
    if (
      path.dirname(temp) === path.resolve(os.tmpdir()) &&
      path.basename(temp).startsWith('oba-nsis-')
    )
      fs.rmSync(temp, { recursive: true, force: true })
  })
