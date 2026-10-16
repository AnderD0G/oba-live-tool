import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceMicRouter } from '../electron/main/services/VoiceMicRouter'

const owner = { accountId: 'default', rowId: 'row-1', sessionId: 'scene-1' }
const delivered = {
  ok: true,
  data: {
    supported: true,
    running: true,
    accessGranted: true,
    hotkey: 'Control+Option+M',
    micState: 'unknown',
    sent: true,
    message: '已发送',
  },
} as const

test('Mac voice leases send one entry and one exit toggle, without replay on repeated release', async () => {
  let sent = 0
  const waits: number[] = []
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => {
      sent++
      return delivered
    },
    now: () => 1000,
    wait: async ms => {
      waits.push(ms)
    },
  })
  assert.equal(await router.acquire(owner), undefined)
  assert.equal(router.state().routeState, 'doubao')
  assert.equal((await router.acquire(owner))?.ok, false)
  assert.equal(sent, 1)
  assert.equal(await router.release(owner), undefined)
  assert.equal(router.state().routeState, 'live')
  assert.equal(await router.release(owner), undefined)
  assert.equal(sent, 2)
  assert.deepEqual(waits, [1200])
})

test('another row cannot release a voice lease or independently toggle the shared Studio helper', async () => {
  let sent = 0
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => {
      sent++
      return delivered
    },
  })
  await router.acquire(owner)
  assert.equal((await router.release({ ...owner, rowId: 'other' }))?.ok, false)
  assert.equal((await router.manualToggle()).ok, false)
  assert.equal(router.alignOpen().ok, false)
  assert.equal(sent, 1)
})

test('a blocked entry does not start an owned route and can be explicitly tried after permissions are fixed', async () => {
  let attempts = 0
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () =>
      ++attempts === 1
        ? { ok: false, error: { code: 'STUDIO_MIC_PERMISSION_REQUIRED', message: '请授权' } }
        : delivered,
  })
  const blocked = await router.acquire(owner)
  assert.equal(blocked?.ok, false)
  assert.equal(router.state().routeState, 'live')
  assert.equal(await router.acquire(owner), undefined)
  assert.equal(attempts, 2)
})

test('an uncertain hotkey is never automatically repeated and requires an explicit no-event alignment', async () => {
  let sent = 0
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => {
      sent++
      return { ok: false, error: { code: 'STUDIO_MIC_TIMEOUT', message: '结果未知' } }
    },
  })
  assert.equal((await router.acquire(owner))?.ok, false)
  assert.equal(router.state().routeState, 'unknown')
  assert.equal((await router.acquire(owner))?.ok, false)
  assert.equal((await router.manualToggle()).ok, false)
  assert.equal(sent, 1)
  assert.equal(router.alignOpen().ok, true)
  assert.equal(router.state().routeState, 'live')
  assert.equal(sent, 1)
})

test('failed restoration keeps unknown state without repeating the toggle on cancel or release', async () => {
  let sent = 0
  const router = new VoiceMicRouter({
    platform: 'darwin',
    wait: async () => {},
    toggle: async () =>
      ++sent === 1
        ? delivered
        : { ok: false, error: { code: 'STUDIO_MIC_TIMEOUT', message: '结果未知' } },
  })
  await router.acquire(owner)
  assert.equal((await router.release(owner))?.ok, false)
  assert.equal(router.state().routeState, 'unknown')
  await router.release(owner)
  assert.equal(sent, 2)
  assert.equal(router.alignOpen().ok, true)
})

test('Windows voice operation does not invoke a Mac hotkey helper', async () => {
  const router = new VoiceMicRouter({
    platform: 'win32',
    toggle: async () => {
      throw Error('No Mac helper on Windows')
    },
  })
  assert.equal(await router.acquire(owner), undefined)
  assert.equal(await router.release(owner), undefined)
  assert.equal(router.state().linked, false)
})

test('API routing mutes explicitly and restores the prior unmuted state without toggling', async () => {
  const targets: boolean[] = []
  let muted = false
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => {
      throw Error('must not toggle')
    },
    setMuted: async target => {
      targets.push(target)
      const beforeMuted = muted
      muted = target
      return {
        ok: true,
        data: {
          ...delivered.data,
          backend: 'api',
          hotkey: '',
          micState: muted ? 'muted' : 'unmuted',
          beforeMuted,
        },
      }
    },
  })
  assert.equal(await router.acquire(owner), undefined)
  assert.equal(await router.release(owner), undefined)
  assert.deepEqual(targets, [true, false])
  assert.equal(muted, false)
})

test('API routing preserves an already-muted microphone after dictation', async () => {
  const targets: boolean[] = []
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => {
      throw Error('must not toggle')
    },
    setMuted: async target => {
      targets.push(target)
      return {
        ok: true,
        data: {
          ...delivered.data,
          backend: 'api',
          hotkey: '',
          micState: 'muted',
          beforeMuted: true,
        },
      }
    },
  })
  assert.equal(await router.acquire(owner), undefined)
  assert.equal(await router.release(owner), undefined)
  assert.deepEqual(targets, [true, true])
})

test('API routing refuses ASR entry or restoration when target state is not confirmed', async () => {
  let calls = 0
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => {
      throw Error('must not toggle')
    },
    setMuted: async () => {
      calls++
      return {
        ok: true,
        data: {
          ...delivered.data,
          backend: 'api',
          hotkey: '',
          micState: 'unmuted',
          beforeMuted: false,
        },
      }
    },
  })
  assert.equal((await router.acquire(owner))?.ok, false)
  assert.equal(router.state().routeState, 'unknown')
  assert.equal(calls, 1)
})

test('a confirmed API manual toggle remains usable without an assumed-open alignment', async () => {
  const router = new VoiceMicRouter({
    platform: 'darwin',
    toggle: async () => ({
      ok: true,
      data: {
        ...delivered.data,
        backend: 'api',
        hotkey: '',
        micState: 'muted',
        beforeMuted: false,
      },
    }),
    setMuted: async () => ({
      ok: true,
      data: { ...delivered.data, backend: 'api', hotkey: '', micState: 'muted', beforeMuted: true },
    }),
  })
  assert.equal((await router.manualToggle()).ok, true)
  assert.equal(router.state().routeState, 'live')
  assert.equal(await router.acquire(owner), undefined)
})
