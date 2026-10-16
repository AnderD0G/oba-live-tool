const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** Pure build planning is also usable on Windows; executing a build requires macOS. */
function createMacDesktopBuildRequest({ platform, hostArch, args, root, version, baseConfig }) {
  if (platform !== 'darwin') throw new Error('MAC_BUILD_REQUIRES_DARWIN: build the native desktop app on the Mac')
  let arch = hostArch
  let target = 'dir'
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (seen.has(argument)) throw new Error('INVALID_MAC_BUILD_ARGUMENT')
    seen.add(argument)
    if (argument === '--dmg') target = 'dmg'
    else if (argument === '--arch' && args[index + 1]) arch = args[++index]
    else throw new Error('INVALID_MAC_BUILD_ARGUMENT: use --arch arm64|x64 and optional --dmg')
  }
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('UNSUPPORTED_MAC_ARCH: expected arm64 or x64')
  const config = structuredClone(baseConfig)
  // A copied Windows Electron distribution must never become the Mac runtime.
  delete config.electronDist
  config.directories = { ...config.directories, output: path.join(root, 'release', `${version}-mac-${arch}`) }
  config.extraResources = (config.extraResources ?? []).filter(resource => {
    const from = typeof resource === 'string' ? resource : resource.from
    return resource.to !== 'codex' && !/^vendor-build\/codex(?:\/|$)/.test(String(from).replaceAll('\\', '/'))
  })
  config.extraResources.push({ from: path.join(root, '.cache', 'native', 'studio-mic-hotkey'), to: 'studio-mic-hotkey' })
  config.mac = { ...config.mac, identity: null, target: [{ target, arch: [arch] }] }
  return { arch, target, config, publish: 'never' }
}

async function main() {
  // Reject other hosts before dependency checks, compilation, downloads or packaging.
  if (process.platform !== 'darwin') throw new Error('MAC_BUILD_REQUIRES_DARWIN: run pnpm build:mac on the Mac')
  const root = path.resolve(__dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.json'), 'utf8'))
  const request = createMacDesktopBuildRequest({ platform: process.platform, hostArch: process.arch,
    args: process.argv.slice(2), root, version: pkg.version, baseConfig })
  if (fs.existsSync(request.config.directories.output)) throw new Error('MAC_BUILD_OUTPUT_EXISTS: preserve the existing app and choose a fresh release directory')
  const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' })
  run(path.join(root, 'scripts', 'build-studio-mic-hotkey.cjs'), ['--arch', request.arch])
  run(require.resolve('typescript/bin/tsc'), ['--noEmit'])
  run(path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ['build'])
  const { build, Platform, Arch } = require('electron-builder')
  await build({ targets: Platform.MAC.createTarget(request.target, Arch[request.arch]),
    publish: request.publish, config: request.config })
  console.log(`Mac desktop app built in ${request.config.directories.output}`)
}

module.exports = { createMacDesktopBuildRequest }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
