const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nativeArchitecture } = require('../../../scripts/build-mac-voice-app.cjs')

test('packaging refuses cross architecture requests before reusing the local Electron runtime', () => {
  assert.equal(nativeArchitecture([], 'arm64'), 'arm64')
  assert.equal(nativeArchitecture(['arm64'], 'arm64'), 'arm64')
  assert.equal(nativeArchitecture(['x64'], 'x64'), 'x64')
  assert.throws(() => nativeArchitecture(['x64'], 'arm64'), /native|runtime|architecture/i)
  assert.throws(() => nativeArchitecture(['arm64'], 'x64'), /native|runtime|architecture/i)
})
