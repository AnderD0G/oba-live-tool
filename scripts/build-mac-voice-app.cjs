const fs = require('node:fs')
const path = require('node:path')

function nativeArchitecture(args, hostArch) {
  const arch = args.length ? args[0] : hostArch
  if (args.length > 1 || !['arm64', 'x64'].includes(arch)) throw new Error('Use build-mac-voice-app.cjs [arm64|x64]')
  if (arch !== hostArch) throw new Error(`Native Electron runtime architecture is ${hostArch}; build ${arch} on a matching Mac/runtime`)
  return arch
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('OBA Voice must be packaged on macOS')
  const root = path.resolve(__dirname, '..')
  const projectDir = path.join(root, 'deploy', 'mac-voice-app')
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
  const args = process.argv.slice(2)
  const arch = nativeArchitecture(args, process.arch)
  const electronDist = path.dirname(require.resolve('electron/package.json')) + '/dist'
  const electronVersion = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim()
  const output = path.join(root, 'release', `oba-voice-${pkg.version}-mac-${arch}`)
  if (fs.existsSync(output)) throw new Error(`Build output exists; preserve it before rebuilding: ${output}`)
  const { build, Platform, Arch } = require('electron-builder')
  await build({ projectDir, targets: Platform.MAC.createTarget('dir', Arch[arch]), publish: 'never', config: {
    appId: 'com.local.oba.voice', productName: 'OBA Voice', electronVersion, electronDist,
    npmRebuild: false, asar: true, directories: { output },
    files: ['*.cjs', 'package.json', 'README.md'], electronLanguages: ['zh-CN', 'en-US'],
    mac: { identity: null, target: [{ target: 'dir', arch: [arch] }],
      icon: path.join(root, 'public', 'favicon.png'),
      extendInfo: { NSMicrophoneUsageDescription: '将本机麦克风转发到本机 OBA 语音容器，供您主动使用豆包语音识别。关闭窗口后连接继续，退出 OBA Voice 后停止。' } },
  } })
  console.log(`OBA Voice app built in ${output}`)
}

module.exports = { main, nativeArchitecture }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
