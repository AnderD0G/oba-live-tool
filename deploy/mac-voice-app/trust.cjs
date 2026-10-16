const fs = require('node:fs')
const path = require('node:path')
const { X509Certificate } = require('node:crypto')
const { normalizeFingerprint, ORIGIN } = require('./policy.cjs')

function readPrivateFile(file) {
  if (!path.isAbsolute(file)) throw new Error('Certificate/trust path must be absolute')
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('Certificate/trust must be a regular file, never a symlink')
    if (stat.uid !== process.getuid() || stat.mode & 0o022) throw new Error('Unsafe certificate/trust file permissions or owner')
    if (stat.size > 65536) throw new Error('Certificate/trust file is too large')
    return fs.readFileSync(descriptor, 'utf8')
  } catch (error) { throw error }
  finally { fs.closeSync(descriptor) }
}

function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('User data path must be absolute')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) {
    throw new Error('User data directory requires private permissions (0700) and the current owner')
  }
}

function saveTrust(directory, value) {
  const fingerprint = normalizeFingerprint(value)
  if (!fingerprint) throw new Error('Invalid SHA-256 certificate fingerprint')
  privateDirectory(directory)
  const file = path.join(directory, 'trust.json')
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, origin: ORIGIN, fingerprint }), { mode: 0o600, flag: 'wx' })
  try { fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}

function loadTrust(directory, args) {
  const pins = args.filter(value => value.startsWith('--certificate-fingerprint='))
  const certificates = args.filter(value => value.startsWith('--certificate='))
  if (pins.length + certificates.length > 1) throw new Error('Choose only one certificate or fingerprint argument; conflicting trust inputs')
  if (pins.length) {
    const fingerprint = normalizeFingerprint(pins[0].slice('--certificate-fingerprint='.length))
    if (!fingerprint) throw new Error('Invalid SHA-256 certificate fingerprint')
    return fingerprint
  }
  if (certificates.length) {
    const file = certificates[0].slice('--certificate='.length)
    try { return normalizeFingerprint(new X509Certificate(readPrivateFile(file)).fingerprint256) }
    catch (error) {
      if (error.code === 'ELOOP') throw new Error('Certificate must be a regular file, never a symlink')
      throw error
    }
  }
  const file = path.join(directory, 'trust.json')
  try {
    const data = JSON.parse(readPrivateFile(file))
    const fingerprint = normalizeFingerprint(data.fingerprint)
    if (data.version !== 1 || data.origin !== ORIGIN || !fingerprint) throw new Error('Invalid local certificate trust configuration')
    return fingerprint
  } catch (error) {
    if (error.code === 'ENOENT') {
      const installedCertificate = path.join(directory, 'server-cert.pem')
      if (!fs.existsSync(installedCertificate)) return null
      return loadTrust(directory, [`--certificate=${installedCertificate}`])
    }
    throw error
  }
}

module.exports = { loadTrust, saveTrust, privateDirectory }
