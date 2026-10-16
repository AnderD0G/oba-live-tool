const { test } = require('node:test')
const assert = require('node:assert/strict')
const { MicrophoneGate } = require('../protocol.cjs')

test('legacy auto forwarding waits for both a live transport and real server settings', () => {
  const gate = new MicrophoneGate()
  assert.equal(gate.accept({ type: 'settings', demand: false }), false)
  assert.equal(gate.accept({ type: 'transport', open: true }), true)
  assert.equal(gate.accept({ type: 'transport', open: true }), false)
  assert.equal(gate.accept({ type: 'settings', demand: false }), false)
  assert.equal(gate.accept({ type: 'microphone', active: false }), false)
})

test('each reconnection requires fresh settings and permits only one microphone attempt', () => {
  const gate = new MicrophoneGate()
  assert.equal(gate.accept({ type: 'transport', open: true }), false)
  assert.equal(gate.accept({ type: 'settings', demand: false }), true)
  assert.equal(gate.accept({ type: 'transport', open: false }), false)
  assert.equal(gate.accept({ type: 'transport', open: true }), false)
  assert.equal(gate.accept({ type: 'settings', demand: false }), true)
  assert.equal(gate.accept({ type: 'settings', demand: false }), false)
})

test('a backend offering demand capture is never forced to open the microphone', () => {
  const gate = new MicrophoneGate()
  assert.equal(gate.accept({ type: 'transport', open: true }), false)
  assert.equal(gate.accept({ type: 'settings', demand: true }), false)
  assert.equal(gate.accept({ type: 'settings', demand: true }), false)
})
