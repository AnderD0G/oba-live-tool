const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isAllowedNavigation, isAllowedRequest, canAccessAudio, isPinnedCertificate, isAllowedWindowAction, canControlWindow } = require('../policy.cjs')
const { initialState, transition, statusLabel } = require('../state.cjs')

const origin = 'https://127.0.0.1:13443'
const audioRequest = { permission: 'media', requestingOrigin: origin, topLevelUrl: `${origin}/`,
  details: { requestingUrl: `${origin}/`, isMainFrame: true, mediaTypes: ['audio'] } }

test('window control IPC permits only minimize and hide', () => {
  assert.equal(isAllowedWindowAction('minimize'), true)
  assert.equal(isAllowedWindowAction('hide'), true)
  for (const action of ['close', 'quit', 'destroy', 'reload', 'resume', 'show', null, undefined, {}, ['hide']]) {
    assert.equal(isAllowedWindowAction(action), false)
  }
})

test('window controls reject other origins, frames and WebContents even for an allowed action', () => {
  const input = { action: 'hide', topLevelUrl: `${origin}/`, isMainFrame: true, isCurrentContents: true }
  assert.equal(canControlWindow(input), true)
  for (const altered of [{ action: 'quit' }, { topLevelUrl: 'https://example.org/' },
    { topLevelUrl: 'https://127.0.0.1:13444/' }, { isMainFrame: false }, { isCurrentContents: false }]) {
    assert.equal(canControlWindow({ ...input, ...altered }), false)
  }
})

test('navigation stays on the local desktop and never follows a remote redirect', () => {
  assert.equal(isAllowedNavigation(`${origin}/`), true)
  assert.equal(isAllowedNavigation(`${origin}/#settings`), true)
  for (const url of ['https://example.org/', 'https://localhost:13443/', 'https://127.0.0.1:13444/',
    `${origin}/other`, `${origin}/?url=https://example.org`, 'file:///etc/passwd', `https://user@127.0.0.1:13443/`]) {
    assert.equal(isAllowedNavigation(url), false, url)
  }
})

test('subresource and websocket access cannot escape the exact loopback origin', () => {
  for (const url of [`${origin}/api/websockets`, 'wss://127.0.0.1:13443/api/websockets',
    `blob:${origin}/worker-uuid`]) assert.equal(isAllowedRequest(url), true, url)
  for (const url of ['wss://127.0.0.1:13444/api/websockets', 'http://127.0.0.1:13443/',
    'https://example.org/a.js', 'blob:https://example.org/worker', 'file:///tmp/a.js']) {
    assert.equal(isAllowedRequest(url), false, url)
  }
})

test('microphone is granted only to audio requests in the trusted main frame', () => {
  assert.equal(canAccessAudio(audioRequest), true)
  for (const altered of [
    { permission: 'geolocation' }, { requestingOrigin: 'https://example.org' },
    { topLevelUrl: 'https://example.org' },
    { details: { ...audioRequest.details, isMainFrame: false } },
    { details: { ...audioRequest.details, mediaTypes: ['audio', 'video'] } },
    { details: { ...audioRequest.details, mediaTypes: [] } },
    { details: { ...audioRequest.details, requestingUrl: 'https://example.org' } },
  ]) assert.equal(canAccessAudio({ ...audioRequest, ...altered }), false, JSON.stringify(altered))
})

test('permission checks also reject unknown media and embedded frames', () => {
  const check = { ...audioRequest, details: { requestingUrl: `${origin}/`, isMainFrame: true, mediaType: 'audio' } }
  assert.equal(canAccessAudio(check), true)
  assert.equal(canAccessAudio({ ...check, details: { ...check.details, mediaType: 'video' } }), false)
  assert.equal(canAccessAudio({ ...check, details: { ...check.details, mediaType: 'unknown' } }), false)
  assert.equal(canAccessAudio({ ...check, details: { ...check.details, isMainFrame: false } }), false)
})

test('certificate exceptions require the pinned hash and exact local URL together', () => {
  const fingerprint = 'AB'.repeat(32)
  assert.equal(isPinnedCertificate({ url: `${origin}/`, fingerprint, expectedFingerprint: fingerprint.toLowerCase() }), true)
  assert.equal(isPinnedCertificate({ url: 'wss://127.0.0.1:13443/api/websockets', fingerprint, expectedFingerprint: fingerprint }), true)
  assert.equal(isPinnedCertificate({ url: `${origin}/`, fingerprint, expectedFingerprint: 'CD'.repeat(32) }), false)
  assert.equal(isPinnedCertificate({ url: 'https://example.org/', fingerprint, expectedFingerprint: fingerprint }), false)
  assert.equal(isPinnedCertificate({ url: `${origin}/`, fingerprint, expectedFingerprint: '' }), false)
})

test('an open page or sent request is never reported as an active microphone', () => {
  let state = initialState()
  assert.equal(state.phase, 'connecting')
  state = transition(state, { type: 'transport', open: true })
  assert.equal(state.phase, 'awaiting-ack')
  state = transition(state, { type: 'demand', enabled: true })
  assert.equal(state.phase, 'awaiting-ack')
  state = transition(state, { type: 'microphone', active: false })
  assert.equal(state.phase, 'idle')
  state = transition(state, { type: 'microphone', active: true })
  assert.equal(state.phase, 'forwarding')
  assert.match(statusLabel(state), /正在转发/)
})

test('a disconnected transport clears an earlier microphone acknowledgement', () => {
  let state = transition(initialState(), { type: 'transport', open: true })
  state = transition(state, { type: 'microphone', active: true })
  state = transition(state, { type: 'transport', open: false })
  assert.equal(state.phase, 'disconnected')
  assert.equal(state.microphone, null)
  state = transition(state, { type: 'transport', open: true })
  assert.equal(state.phase, 'awaiting-ack')
})

test('permission denial remains visible until a deliberate reconnect', () => {
  let state = transition(initialState(), { type: 'denied' })
  state = transition(state, { type: 'transport', open: true })
  state = transition(state, { type: 'microphone', active: false })
  assert.equal(state.phase, 'denied')
  state = transition(state, { type: 'reset' })
  assert.equal(state.phase, 'connecting')
})

test('a negative microphone acknowledgement on the legacy backend remains visibly inactive', () => {
  let state = transition(initialState(), { type: 'transport', open: true })
  state = transition(state, { type: 'demand', enabled: false })
  state = transition(state, { type: 'microphone', active: false })
  assert.equal(state.phase, 'inactive')
  assert.match(statusLabel(state), /未开启/)
})

test('late page messages cannot reconnect a paused or quit connection', () => {
  for (const type of ['pause', 'quit']) {
    let state = transition(initialState(), { type })
    for (const event of [{ type: 'transport', open: true }, { type: 'microphone', active: true }, { type: 'reset' }]) {
      state = transition(state, event)
      assert.equal(state.phase, type === 'pause' ? 'paused' : 'quit')
    }
  }
  assert.equal(transition(transition(initialState(), { type: 'pause' }), { type: 'resume' }).phase, 'connecting')
})
