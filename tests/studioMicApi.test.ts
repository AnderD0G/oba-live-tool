import assert from 'node:assert/strict'
import test from 'node:test'
import { StudioMicApi } from '../electron/main/services/StudioMicApi'

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const good = (before: boolean, after: boolean) => ({
  changed: before !== after,
  before,
  after,
  result_code: before === after ? null : 0,
})

test('API status uses only the fixed loopback read endpoint and reports real microphone state', async () => {
  const api = new StudioMicApi({
    platform: 'darwin',
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:18766/v1/mic')
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.body, undefined)
      return json({ muted: false, inputs: [{ name: 'Microphone', muted: false, volume: 1 }] })
    },
  })
  const result = await api.execute({ action: 'status' })
  assert.ok(result.ok)
  assert.equal(result.data.backend, 'api')
  assert.equal(result.data.micState, 'unmuted')
  assert.equal(result.data.accessGranted, true)
  assert.equal(result.data.hotkey, '')
})

test('setMuted sends the exact target and returns the verified prior state for restoration', async () => {
  const api = new StudioMicApi({
    platform: 'darwin',
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:18766/v1/mic')
      assert.equal(init.method, 'PUT')
      assert.deepEqual(JSON.parse(String(init.body)), { muted: true })
      return json(good(false, true))
    },
  })
  const result = await api.setMuted(true)
  assert.ok(result.ok)
  assert.equal(result.data.micState, 'muted')
  assert.equal(result.data.beforeMuted, false)
})

test('a valid idempotent acknowledgement preserves already-muted state without requiring a toggle code', async () => {
  const api = new StudioMicApi({ platform: 'darwin', fetch: async () => json(good(true, true)) })
  const result = await api.setMuted(true)
  assert.ok(result.ok)
  assert.equal(result.data.beforeMuted, true)
})

test('writes reject wrong targets, failed return codes and unknown prior state without a retry', async () => {
  for (const value of [
    good(false, false),
    { ...good(false, true), result_code: 1 },
    { changed: true, before: null, after: true, result_code: 0 },
    { changed: true, before: false, after: true, result_code: null },
    { changed: false, before: false, after: true, result_code: null },
  ]) {
    let requests = 0
    const api = new StudioMicApi({
      platform: 'darwin',
      fetch: async () => {
        requests++
        return json(value)
      },
    })
    assert.equal((await api.setMuted(true)).ok, false)
    assert.equal(requests, 1)
  }
})

test('manual toggle uses the fixed POST endpoint and validates that the observed state changed', async () => {
  const api = new StudioMicApi({
    platform: 'darwin',
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:18766/v1/mic/toggle')
      assert.equal(init.method, 'POST')
      assert.equal(init.body, undefined)
      return json(good(true, false))
    },
  })
  const result = await api.execute({ action: 'toggle' })
  assert.ok(result.ok)
  assert.equal(result.data.micState, 'unmuted')
})

test('concurrent setters cannot issue two mutations through the shared API instance', async () => {
  let finish!: (response: Response) => void
  let requests = 0
  const api = new StudioMicApi({
    platform: 'darwin',
    fetch: async () => {
      requests++
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  const first = api.setMuted(true)
  assert.equal((await api.setMuted(false)).ok, false)
  finish(json(good(false, true)))
  assert.ok((await first).ok)
  assert.equal(requests, 1)
})

test('schema mismatches and oversized responses never become a real-state success', async () => {
  for (const value of [
    { muted: 'false' },
    { muted: true, inputs: [{ muted: false }] },
    { muted: true, inputs: 'invalid' },
    { muted: false, private: 'x'.repeat(70000) },
  ]) {
    const api = new StudioMicApi({ platform: 'darwin', fetch: async () => json(value) })
    assert.equal((await api.execute({ action: 'status' })).ok, false)
  }
})

test('unavailable or timed-out writes never retry and non-Mac voice does not contact the local API', async () => {
  let requests = 0
  const api = new StudioMicApi({
    platform: 'darwin',
    fetch: async () => {
      requests++
      throw new DOMException('timeout', 'TimeoutError')
    },
  })
  assert.equal((await api.setMuted(true)).ok, false)
  assert.equal(requests, 1)
  const windows = new StudioMicApi({
    platform: 'win32',
    fetch: async () => {
      throw Error('must not request API')
    },
  })
  const result = await windows.execute({ action: 'status' })
  assert.ok(result.ok)
  assert.equal(result.data.supported, false)
  assert.equal((await windows.setMuted(true)).ok, false)
})

test('renderer commands cannot select endpoints or activate the native helper', async () => {
  const api = new StudioMicApi({
    platform: 'darwin',
    fetch: async () => {
      throw Error('must not request API')
    },
  })
  for (const command of [
    { action: 'status', url: 'http://elsewhere' },
    { action: 'request-access' },
    { action: 'toggle', key: 'x' },
    null,
  ])
    assert.equal((await api.execute(command)).ok, false)
})
