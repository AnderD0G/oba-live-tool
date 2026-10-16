const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function isSyntheticAudioSession({ args, userData, productionUserData }) {
  const device = args.includes('--use-fake-device-for-media-stream')
  const ui = args.includes('--use-fake-ui-for-media-stream')
  const files = args.filter(value => value.startsWith('--use-file-for-fake-audio-capture='))
  if (!device && !ui && !files.length) return false
  if (!device || !ui || files.length !== 1) throw new Error('Synthetic audio requires all three fake media flags')
  const profile = fs.realpathSync(userData)
  const production = fs.existsSync(productionUserData) ? fs.realpathSync(productionUserData) : path.resolve(productionUserData)
  const temporary = fs.realpathSync(os.tmpdir()) + path.sep
  if (profile === production || !profile.startsWith(temporary)) throw new Error('Synthetic audio requires a separate temporary profile')
  const file = files[0].slice('--use-file-for-fake-audio-capture='.length)
  if (!path.isAbsolute(file) || !fs.realpathSync(file).startsWith(profile + path.sep)) {
    throw new Error('Synthetic WAV must be inside the temporary profile')
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const header = Buffer.alloc(12)
    fs.readSync(descriptor, header, 0, header.length, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Synthetic audio requires a RIFF WAV file')
  } finally { fs.closeSync(descriptor) }
  return true
}

module.exports = { isSyntheticAudioSession }
