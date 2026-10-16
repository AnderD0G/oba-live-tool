const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTrust, saveTrust } = require('../trust.cjs')

const pin = 'ab'.repeat(32)
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oba-voice-trust-'))

test('an explicit certificate pin persists in a private local trust file', t => {
  const directory = dir()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  saveTrust(directory, pin)
  assert.equal(loadTrust(directory, []), pin)
  assert.equal(fs.statSync(path.join(directory, 'trust.json')).mode & 0o777, 0o600)
  assert.equal(loadTrust(directory, [`--certificate-fingerprint=${'CD'.repeat(32)}`]), 'cd'.repeat(32))
})

test('missing trust fails closed and conflicting or malformed pins are rejected', t => {
  const directory = dir()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.equal(loadTrust(directory, []), null)
  assert.throws(() => loadTrust(directory, ['--certificate-fingerprint=bad']), /fingerprint/i)
  assert.throws(() => loadTrust(directory, [`--certificate-fingerprint=${pin}`, '--certificate=/tmp/cert.pem']), /one|conflict/i)
})

test('untrusted filesystem permissions and symlinks cannot silently replace certificate trust', t => {
  const directory = dir()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'cert.pem')
  fs.writeFileSync(file, 'not a certificate', { mode: 0o666 })
  fs.chmodSync(file, 0o666)
  assert.throws(() => loadTrust(directory, [`--certificate=${file}`]), /permission/i)
  fs.chmodSync(file, 0o600)
  const link = path.join(directory, 'link.pem')
  fs.symlinkSync(file, link)
  assert.throws(() => loadTrust(directory, [`--certificate=${link}`]), /regular|symlink/i)
  assert.throws(() => loadTrust(directory, ['--certificate=relative.pem']), /absolute/i)
})

test('a preinstalled public certificate must pass the same file safety checks before bootstrap', t => {
  const directory = dir()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'server-cert.pem')
  fs.writeFileSync(file, 'untrusted certificate', { mode: 0o666 })
  fs.chmodSync(file, 0o666)
  assert.throws(() => loadTrust(directory, []), /permission/i)
})
