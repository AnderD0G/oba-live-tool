const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { X509Certificate } = require('node:crypto')
const { certificateVerificationResult } = require('../policy.cjs')

test('certificate verification pins every connection even when system CA verification succeeds', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oba-voice-cert-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  const certificates = []
  for (const name of ['installed', 'replacement']) {
    const output = path.join(directory, `${name}.pem`)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-nodes', '-keyout', path.join(directory, `${name}.key`), '-out', output,
      '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' })
    certificates.push(fs.readFileSync(output, 'utf8'))
  }
  const [installed, replacement] = certificates
  const pin = new X509Certificate(installed).fingerprint256
  const request = { hostname: '127.0.0.1', certificate: { data: installed },
    verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', errorCode: -202 }
  assert.equal(certificateVerificationResult(request, pin), 0)
  assert.equal(certificateVerificationResult({ ...request, verificationResult: 'net::OK', errorCode: 0 }, pin), 0)
  assert.equal(certificateVerificationResult({ ...request, certificate: { data: replacement },
    verificationResult: 'net::OK', errorCode: 0 }, pin), -2)
  assert.equal(certificateVerificationResult({ ...request, hostname: 'example.org' }, pin), -2)
  assert.equal(certificateVerificationResult({ ...request, certificate: { data: 'invalid', fingerprint: pin } }, pin), -2)
})
