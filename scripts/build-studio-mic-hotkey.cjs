const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** Compile only the public macOS keyboard-event helper; other desktop targets never call this. */
function buildStudioMicHotkey({
  platform = process.platform,
  arch = process.arch,
  root = path.resolve(__dirname, '..'),
} = {}) {
  if (platform !== 'darwin')
    throw new Error('MAC_HELPER_REQUIRES_DARWIN: build the native helper on macOS')
  if (arch !== 'arm64' && arch !== 'x64')
    throw new Error('UNSUPPORTED_MAC_ARCH: expected arm64 or x64')
  const source = path.join(root, 'native', 'mac', 'StudioMicHotkey.swift')
  const output = path.join(root, '.cache', 'native', 'studio-mic-hotkey')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const target = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos11.0`
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      target,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      source,
      '-o',
      output,
    ],
    { cwd: root, stdio: 'inherit', timeout: 120000 },
  )
  // Sign this standalone helper only. Do not alter the enclosing OBA app's identity.
  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--identifier', 'com.local.oba.studio-mic-hotkey', output],
    { cwd: root, stdio: 'inherit', timeout: 30000 },
  )
  return output
}

module.exports = { buildStudioMicHotkey }
if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--arch'))
      throw new Error('INVALID_MAC_HELPER_ARGUMENT: use --arch arm64|x64')
    console.log(buildStudioMicHotkey({ arch: args[1] ?? process.arch }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
