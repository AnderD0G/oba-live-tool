import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const require = createRequire(import.meta.url)
const script = path.resolve('scripts/build-mac-desktop.cjs')
const load = () => require(script)
const baseConfig = {
  appId: 'com.local.oba.codexdraft', asar: true,
  files: ['dist-electron', 'dist'],
  asarUnpack: ['dist-electron/main/analysis-capture-worker.cjs', 'dist-electron/main/fresh-analysis-worker.cjs'],
  electronDist: 'a-Windows-Electron-installation',
  extraResources: [
    { from: 'vendor-build/codex/package', to: 'codex' },
    { from: 'INSTALL-GUIDE.txt', to: 'INSTALL-GUIDE.txt' },
    { from: 'THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' },
  ],
  mac: { icon: 'public/favicon.png', target: [{ target: 'dmg', arch: ['x64', 'arm64'] }] },
}
function request(overrides: Record<string, unknown> = {}) {
  return load().createMacDesktopBuildRequest({ platform: 'darwin', hostArch: 'arm64', args: [],
    root: path.resolve('.'), version: '1.6.7-voice.52', baseConfig, ...overrides })
}

test('Mac build preserves the complete Electron UI and unpacked SQLite workers without Windows runtime resources', () => {
  const before = JSON.stringify(baseConfig)
  const actual = request()
  assert.equal(actual.arch, 'arm64')
  assert.equal(actual.target, 'dir')
  assert.equal(actual.publish, 'never')
  assert.deepEqual(actual.config.files, ['dist-electron', 'dist'])
  assert.deepEqual(actual.config.asarUnpack, ['dist-electron/main/analysis-capture-worker.cjs', 'dist-electron/main/fresh-analysis-worker.cjs'])
  assert.equal(actual.config.asar, true)
  assert.equal('electronDist' in actual.config, false)
  assert.deepEqual(actual.config.extraResources, [
    { from: 'INSTALL-GUIDE.txt', to: 'INSTALL-GUIDE.txt' },
    { from: 'THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' },
  ])
  assert.deepEqual(actual.config.mac.target, [{ target: 'dir', arch: ['arm64'] }])
  assert.equal(actual.config.mac.identity, null)
  assert.equal(actual.config.mac.icon, 'public/favicon.png')
  assert.equal(JSON.stringify(baseConfig), before, 'base Windows packaging config is not modified')
})

test('Mac build selects exactly one requested architecture and only creates a DMG when requested', () => {
  for (const arch of ['arm64', 'x64']) {
    const actual = request({ hostArch: arch, args: ['--dmg', '--arch', arch] })
    assert.equal(actual.arch, arch)
    assert.equal(actual.target, 'dmg')
    assert.deepEqual(actual.config.mac.target, [{ target: 'dmg', arch: [arch] }])
    assert.equal(actual.config.directories.output, path.resolve(`release/1.6.7-voice.52-mac-${arch}`))
  }
  assert.equal(request({ hostArch: 'arm64', args: ['--arch', 'x64'] }).arch, 'x64')
})

test('Mac build rejects other hosts, unsupported architectures and unsafe or unrecognized flags before packaging', () => {
  for (const platform of ['win32', 'linux']) assert.throws(() => request({ platform }), /MAC_BUILD_REQUIRES_DARWIN/)
  assert.throws(() => request({ hostArch: 'ia32' }), /UNSUPPORTED_MAC_ARCH/)
  for (const args of [['--arch', 'universal'], ['--arch'], ['--publish', 'always'], ['--unknown'], ['--arch', 'arm64', '--arch', 'x64']])
    assert.throws(() => request({ args }), /INVALID_MAC_BUILD_ARGUMENT|UNSUPPORTED_MAC_ARCH/)
})

test('Mac build CLI refuses a non-Mac host without launching a build', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /MAC_BUILD_REQUIRES_DARWIN/)
  assert.equal(result.stdout, '')
})
