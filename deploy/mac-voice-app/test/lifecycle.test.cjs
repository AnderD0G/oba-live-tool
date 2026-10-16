const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { VoiceConnection } = require('../connection.cjs')

// The fake is only the native window boundary; the connection controller is real.
function makeWindow() {
  const window = new EventEmitter()
  window.visible = true
  window.destroyed = false
  window.minimized = false
  window.hide = () => { window.visible = false }
  window.show = () => { window.visible = true }
  window.focus = () => {}
  window.minimize = () => { window.minimized = true }
  window.destroy = () => { window.destroyed = true; window.emit('closed') }
  window.isDestroyed = () => window.destroyed
  return window
}

test('ordinary close hides the same live window instead of releasing its connection', () => {
  const connection = new VoiceConnection({ openWindow: makeWindow })
  connection.start()
  const window = connection.window
  assert.ok(window)
  let prevented = false
  window.emit('close', { preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(window.visible, false)
  assert.equal(window.destroyed, false)
  assert.equal(connection.window, window)
})

test('pause destroys the current connection and late window events cannot undo pause', () => {
  const connection = new VoiceConnection({ openWindow: makeWindow })
  connection.start()
  const window = connection.window
  connection.pause()
  assert.equal(window.destroyed, true)
  assert.equal(connection.window, null)
  assert.equal(connection.state.phase, 'paused')
  connection.resume()
  assert.notEqual(connection.window, window)
  assert.equal(connection.state.phase, 'connecting')
})

test('explicit quit destroys the live window and cannot be resumed', () => {
  const connection = new VoiceConnection({ openWindow: makeWindow })
  connection.start()
  const window = connection.window
  connection.quit()
  assert.equal(window.destroyed, true)
  assert.equal(connection.window, null)
  assert.equal(connection.state.phase, 'quit')
  connection.resume()
  assert.equal(connection.window, null)
})

test('local minimize and hide preserve the same active microphone connection', () => {
  const connection = new VoiceConnection({ openWindow: makeWindow })
  connection.start()
  connection.update({ type: 'transport', open: true })
  connection.update({ type: 'microphone', active: true })
  const window = connection.window
  assert.equal(connection.performWindowAction('minimize'), true)
  assert.equal(window.minimized, true)
  assert.equal(window.destroyed, false)
  assert.equal(connection.state.phase, 'forwarding')
  assert.equal(connection.performWindowAction('hide'), true)
  assert.equal(window.visible, false)
  assert.equal(connection.window, window)
  assert.equal(connection.state.phase, 'forwarding')
})

test('window control actions cannot create a connection while paused or perform destructive commands', () => {
  let opened = 0
  const connection = new VoiceConnection({ openWindow: () => { opened++; return makeWindow() } })
  connection.start()
  const window = connection.window
  for (const command of ['quit', 'close', 'destroy', 'resume', 'reload', {}, null]) {
    assert.equal(connection.performWindowAction(command), false)
    assert.equal(window.destroyed, false)
  }
  connection.pause()
  assert.equal(connection.performWindowAction('minimize'), false)
  assert.equal(connection.performWindowAction('hide'), false)
  assert.equal(connection.window, null)
  assert.equal(connection.state.phase, 'paused')
  assert.equal(opened, 1)
})
