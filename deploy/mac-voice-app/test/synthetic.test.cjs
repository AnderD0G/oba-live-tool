const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isSyntheticAudioSession } = require('../synthetic.cjs')

test('fake microphone permission bypass requires a separate temporary profile and a WAV inside it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oba-voice-smoke-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const wav = path.join(directory, 'tone.wav')
  fs.writeFileSync(wav, Buffer.from('RIFF0000WAVEfmt '))
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`]
  const input = { args, userData: directory, productionUserData: '/Users/example/Library/Application Support/OBA-Voice' }
  assert.equal(isSyntheticAudioSession(input), true)
  assert.equal(isSyntheticAudioSession({ ...input, args: [] }), false)
  assert.throws(() => isSyntheticAudioSession({ ...input, args: args.slice(1) }), /fake|synthetic/i)
  assert.throws(() => isSyntheticAudioSession({ ...input, productionUserData: directory }), /profile/i)
  fs.writeFileSync(wav, 'not a wav')
  assert.throws(() => isSyntheticAudioSession(input), /WAV/i)
})
