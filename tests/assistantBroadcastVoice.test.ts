import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantVoiceCoordinator } from '../electron/main/services/AssistantVoiceCoordinator'

test('freeform voice uses a real draft scope and fills text without a viewer or capture', async () => {
  let recording = false
  let acquired = 0
  let released = 0
  const voice = new AssistantVoiceCoordinator({
    state: async () => { throw Error('A freeform draft must not query viewer rows') },
    scope: async (_account, row) => row === 'broadcast:draft' ? { sessionId: 'real-room-draft' } : null,
    request: async path => {
      if (path === '/api/state') return { recording, busy: null }
      if (path === '/api/rec/start') { recording = true; return { ok: true } }
      if (path === '/api/rec/stop') { recording = false; return { ok: true, text: '正在补货，请稍等' } }
      throw Error('Unexpected voice request')
    },
    micRouter: {
      acquire: async () => { acquired++; return undefined },
      release: async () => { released++; return undefined },
      state: () => ({ routeState: 'unknown' }) as never,
    },
  })
  assert.equal((await voice.execute({ action: 'start', accountId: 'default', rowId: 'broadcast:draft' })).ok, true)
  const stopped = await voice.execute({ action: 'stop', accountId: 'default', rowId: 'broadcast:draft' })
  assert.ok(stopped.ok)
  assert.equal(stopped.data.text, '正在补货，请稍等')
  assert.equal(acquired, 1)
  assert.equal(released, 1)
  await voice.dispose()
})

test('an invalid freeform owner cannot start recording or mute the live microphone', async () => {
  let requests = 0
  const voice = new AssistantVoiceCoordinator({
    state: async () => { throw Error('No captured viewer exists') },
    scope: async () => null,
    request: async () => { requests++; throw Error('must not be called') },
  })
  const result = await voice.execute({ action: 'start', accountId: 'default', rowId: 'broadcast:old' })
  assert.equal(result.ok, false)
  assert.equal(requests, 0)
  await voice.dispose()
})
