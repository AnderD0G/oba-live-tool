import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopLandingHash } from '../electron/main/desktopLanding'

test('Mac opens the existing assistant desk even without launcher arguments', () => {
  assert.equal(desktopLandingHash('darwin', []), '/assistant-desk')
  assert.equal(desktopLandingHash('darwin', ['--assistant-desk']), '/assistant-desk')
})

test('Windows preserves its default route and its explicit assistant desk launcher', () => {
  assert.equal(desktopLandingHash('win32', []), undefined)
  assert.equal(desktopLandingHash('win32', ['--assistant-desk']), '/assistant-desk')
  assert.equal(desktopLandingHash('linux', []), undefined)
})
