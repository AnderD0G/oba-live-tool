import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantVoiceCoordinator } from '../electron/main/services/AssistantVoiceCoordinator'
import { VoiceMicRouter } from '../electron/main/services/VoiceMicRouter'
import type { AssistantDeskState } from '../shared/assistantDesk'

const command = (action: 'start' | 'stop' | 'cancel', rowId = 'row') => ({
  action,
  accountId: 'default',
  rowId,
})
function fixture(
  options: {
    failedStart?: boolean
    throwStart?: boolean
    failedStop?: boolean
    failedRestore?: boolean
  } = {},
) {
  const events: string[] = []
  let recording = false
  let toggles = 0
  const router = new VoiceMicRouter({
    platform: 'darwin',
    wait: async () => {},
    toggle: async () => {
      events.push('toggle')
      toggles++
      if (options.failedRestore && toggles === 2)
        return { ok: false, error: { code: 'STUDIO_MIC_TIMEOUT', message: 'unknown' } }
      return {
        ok: true,
        data: {
          supported: true,
          running: true,
          accessGranted: true,
          hotkey: 'Control+Option+M',
          micState: 'unknown',
          sent: true,
          message: 'sent',
        },
      }
    },
  })
  const voice = new AssistantVoiceCoordinator({
    micRouter: router,
    state: async () =>
      ({
        activeSession: { id: 'scene', accountId: 'default', status: 'collecting' },
        rows: [{ id: 'row', accountId: 'default', sessionId: 'scene' }],
      }) as unknown as AssistantDeskState,
    request: async path => {
      if (path === '/api/state') return { recording, busy: null }
      events.push(path)
      if (path === '/api/rec/start') {
        if (options.throwStart) throw Error('connection failed')
        if (options.failedStart) return { ok: false, error: 'no_button' }
        recording = true
        return { ok: true }
      }
      if (path === '/api/rec/stop') {
        if (options.failedStop) return { ok: false }
        recording = false
        return { ok: true, text: '中文识别' }
      }
      if (path === '/api/rec/cancel') {
        recording = false
        return { ok: true, recording: false }
      }
    },
  })
  return { voice, events, router, toggles: () => toggles }
}

test('shared voice path toggles before ASR starts and restores after successful stop exactly once', async () => {
  const f = fixture()
  assert.equal((await f.voice.execute(command('start'))).ok, true)
  const result = await f.voice.execute(command('start'))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'VOICE_ALREADY_RECORDING')
  const stopped = await f.voice.execute(command('stop'))
  assert.equal(stopped.ok, true)
  if (stopped.ok) assert.equal(stopped.data.text, '中文识别')
  assert.deepEqual(f.events, ['toggle', '/api/rec/start', '/api/rec/stop', 'toggle'])
  await f.voice.execute(command('cancel'))
  assert.equal(f.toggles(), 2)
})

test('a failed start transport with confirmed cleanup returns an explicitly unowned UI result', async () => {
  const f = fixture({ throwStart: true })
  const result = await f.voice.execute(command('start'))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'VOICE_START_NOT_STARTED')
  assert.equal(f.router.state().routeState, 'live')
  assert.equal(f.toggles(), 2)
})

test('a known failed start restores the entry toggle before returning and leaves no recording owner', async () => {
  const f = fixture({ failedStart: true })
  const result = await f.voice.execute(command('start'))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'VOICE_START_NOT_STARTED')
  assert.deepEqual(f.events, ['toggle', '/api/rec/start', 'toggle'])
  assert.equal(f.router.state().routeState, 'live')
  assert.equal((await f.voice.execute(command('cancel'))).ok, false)
  assert.equal(f.toggles(), 2)
})

test('a failed stop retains the owner and only an explicit successful cancel restores the route', async () => {
  const f = fixture({ failedStop: true })
  await f.voice.execute(command('start'))
  assert.equal((await f.voice.execute(command('stop'))).ok, false)
  assert.equal(f.toggles(), 1)
  assert.equal((await f.voice.execute(command('cancel'))).ok, true)
  assert.equal(f.toggles(), 2)
})

test('restoration failure cannot discard recognized text or automatically repeat a toggle', async () => {
  const f = fixture({ failedRestore: true })
  await f.voice.execute(command('start'))
  const stopped = await f.voice.execute(command('stop'))
  assert.equal(stopped.ok, true)
  if (stopped.ok) {
    assert.equal(stopped.data.text, '中文识别')
    assert.match(stopped.data.micWarning ?? '', /恢复/)
    assert.equal(stopped.data.routeState, 'unknown')
  }
  assert.equal(f.router.state().routeState, 'unknown')
  await f.voice.execute(command('cancel'))
  assert.equal(f.toggles(), 2)
})

test('an invalid row never sends a hotkey and shutdown uses the same owned cancellation path', async () => {
  const f = fixture()
  assert.equal((await f.voice.execute(command('start', 'other'))).ok, false)
  assert.equal(f.toggles(), 0)
  await f.voice.execute(command('start'))
  await f.voice.dispose()
  assert.deepEqual(f.events, ['toggle', '/api/rec/start', '/api/rec/cancel', 'toggle'])
})
