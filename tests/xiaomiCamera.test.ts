import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateXiaomiCameraBaseUrl,
  type XiaomiCameraConfigStore,
  type XiaomiCameraHttpRequest,
  type XiaomiCameraHttpResponse,
  XiaomiCameraService,
  type XiaomiCameraTransport,
} from '../electron/main/services/XiaomiCameraService'

const baseUrl = 'http://192.168.1.5:18765'
const token = 'private-camera-fixture'
function store(): XiaomiCameraConfigStore {
  let config = { baseUrl, token }
  return {
    load: () => ({ ...config }),
    save: value => {
      config = { ...value }
    },
  }
}
function json(value: unknown, status = 200): XiaomiCameraHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(value)),
  }
}
const timestamp = '2026-10-16T06:30:00Z'
const forbidden: XiaomiCameraTransport = async () => {
  throw new Error('must not reach network')
}

test('only literal private LAN base URLs are accepted, without paths, credentials or redirects', () => {
  assert.equal(validateXiaomiCameraBaseUrl(`${baseUrl}/`), baseUrl)
  for (const value of [
    'https://example.com',
    'http://127.0.0.1:18765',
    'http://169.254.169.254',
    'http://192.168.1.5:18765/v1/camera',
    `${baseUrl}?token=x`,
    `${baseUrl}#x`,
    'http://user:pass@192.168.1.5:18765',
    'file:///tmp/camera',
    'http://10.evil.example',
  ]) {
    assert.throws(() => validateXiaomiCameraBaseUrl(value), undefined, value)
  }
})

test('expanded commands and malformed lens parameters fail before any network request', async () => {
  const service = new XiaomiCameraService({ store: store(), transport: forbidden })
  for (const command of [
    null,
    [],
    {},
    { action: 'status', token },
    { action: 'start', path: '/other' },
    { action: 'zoom', ratio: 0.9 },
    { action: 'zoom', ratio: Number.POSITIVE_INFINITY },
    { action: 'zoom', ratio: 11 },
    { action: 'focus', x: -0.1, y: 0.5, previewId: 'x' },
    { action: 'focus', x: 0.5, y: 0.5 },
    { action: 'stop', baseUrl: 'http://example.org' },
  ]) {
    const result = await service.execute(command)
    assert.equal(result.error?.code, 'XIAOMI_INVALID_COMMAND')
  }
})

test('HTTP 200 offline and unavailable settings remain truthful read results', async () => {
  const service = new XiaomiCameraService({
    store: store(),
    transport: async request => {
      assert.equal(request.headers.Authorization, `Bearer ${token}`)
      assert.equal(request.method, 'GET')
      assert.equal(request.body, undefined)
      return request.url.endsWith('/settings')
        ? json({ available: false, saved_zoom: 1, error: 'controls_unavailable', secret: token })
        : json({ state: 'offline', timestamp, error: 'device_offline', secret: token })
    },
  })
  const status = await service.execute({ action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.camera?.state, 'offline')
  const settings = await service.execute({ action: 'settings' })
  assert.equal(settings.ok, true)
  assert.equal(settings.settings?.available, false)
  assert.doesNotMatch(JSON.stringify([status, settings]), new RegExp(token))
})

test('start and stop use fixed empty JSON commands and validate the returned target state', async () => {
  const requests: XiaomiCameraHttpRequest[] = []
  let time = 1000
  const service = new XiaomiCameraService({
    store: store(),
    now: () => time,
    transport: async request => {
      requests.push(request)
      return json({ success: true, changed: false, state: 'capturing', timestamp })
    },
  })
  const start = await service.execute({ action: 'start' })
  assert.equal(start.ok, true)
  assert.equal(start.operation?.changed, false)
  time += 200
  const stop = await service.execute({ action: 'stop' })
  assert.equal(stop.ok, false)
  assert.equal(stop.camera?.state, 'capturing')
  assert.equal(requests[0].url, `${baseUrl}/v1/camera/start`)
  assert.equal(requests[0].body, '{}')
  assert.equal(requests[0].timeoutMs, 180000)
  assert.equal(requests[0].headers['Content-Type'], 'application/json')
})

test('lens acknowledgement distinguishes applied from saved and never treats success alone as applied', async () => {
  let applied = true
  let time = 1000
  const service = new XiaomiCameraService({
    store: store(),
    now: () => time,
    transport: async () =>
      json({ success: true, applied, saved: false, available: true, zoom: 1.3, saved_zoom: 1 }),
  })
  const zoom = await service.execute({ action: 'zoom', ratio: 1.3 })
  assert.equal(zoom.ok, true)
  assert.equal(zoom.operation?.applied, true)
  assert.equal(zoom.operation?.saved, false)
  assert.match(zoom.message || '', /未保存/)
  time += 200
  applied = false
  assert.equal((await service.execute({ action: 'autofocus' })).ok, false)
})

test('redirects, server errors and transport failures cannot expose credentials or imply stopped', async () => {
  for (const transport of [
    async () => ({
      ...json({ error: token }),
      status: 302,
      headers: { location: 'https://evil.example' },
    }),
    async () => json({ success: false, error: token }, 503),
    async () => {
      throw new Error(`failed ${token} Authorization: Bearer ${token}`)
    },
  ] satisfies XiaomiCameraTransport[]) {
    const service = new XiaomiCameraService({ store: store(), transport })
    const result = await service.execute({ action: 'stop' })
    assert.equal(result.ok, false)
    assert.notEqual(result.camera?.state, 'off')
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-camera-fixture|evil\.example|Authorization/,
    )
  }
})

test('writes are single flight and rate limited instead of queueing delayed camera changes', async () => {
  let finish!: (response: XiaomiCameraHttpResponse) => void
  let count = 0
  let time = 1000
  const service = new XiaomiCameraService({
    store: store(),
    now: () => time,
    transport: async () => {
      count++
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  const first = service.execute({ action: 'start' })
  assert.equal((await service.execute({ action: 'stop' })).error?.code, 'XIAOMI_BUSY')
  finish(json({ state: 'ready', timestamp, success: true, changed: true }))
  assert.equal((await first).ok, true)
  time += 199
  assert.equal(
    (await service.execute({ action: 'zoom', ratio: 2 })).error?.code,
    'XIAOMI_RATE_LIMITED',
  )
  assert.equal(count, 1)
})

test('a timeout makes the write outcome unknown and never retries automatically', async () => {
  let calls = 0
  const service = new XiaomiCameraService({
    store: store(),
    transport: async () => {
      calls++
      throw Object.assign(new Error(token), { code: 'ETIMEDOUT' })
    },
  })
  const result = await service.execute({ action: 'stop' })
  assert.equal(result.error?.code, 'XIAOMI_TIMEOUT')
  assert.equal(result.error?.outcomeUnknown, true)
  assert.equal(calls, 1)
  assert.equal(result.camera, undefined)
})

test('focus accepts only a fresh preview issued by this service and invalidates it after zoom', async () => {
  let time = 1000
  const requests: XiaomiCameraHttpRequest[] = []
  const service = new XiaomiCameraService({
    store: store(),
    now: () => time,
    transport: async request => {
      requests.push(request)
      if (request.url.endsWith('/preview.jpg'))
        return {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'x-preview-age-ms': '100' },
          body: Buffer.from([255, 216, 255, 224, 255, 217]),
        }
      return json({ success: true, applied: true, saved: true, focus_submitted: true })
    },
  })
  assert.equal(
    (await service.execute({ action: 'focus', x: 0.5, y: 0.5, previewId: 'not-issued' })).error
      ?.code,
    'XIAOMI_PREVIEW_STALE',
  )
  const preview = await service.execute({ action: 'preview' })
  assert.equal(preview.ok, true)
  assert.match(preview.preview?.dataUrl || '', /^data:image\/jpeg;base64,/)
  assert.ok(preview.preview)
  assert.equal(
    (await service.execute({ action: 'focus', x: 0.25, y: 0.75, previewId: preview.preview.id }))
      .ok,
    true,
  )
  const focusBody = requests.at(-1)?.body
  assert.ok(focusBody)
  assert.deepEqual(JSON.parse(focusBody), { x: 0.25, y: 0.75 })
  time += 200
  const next = await service.execute({ action: 'preview' })
  assert.ok(next.preview)
  time += 2000
  assert.equal(
    (await service.execute({ action: 'focus', x: 0.5, y: 0.5, previewId: next.preview.id })).error
      ?.code,
    'XIAOMI_PREVIEW_STALE',
  )
})

test('zoom requires a matching observed setting and a new preview before focus selection', async () => {
  let time = 1000
  let observed = 1
  let previews = 0
  const service = new XiaomiCameraService({
    store: store(),
    now: () => time,
    transport: async request => {
      if (request.url.endsWith('/zoom')) return json({ success: true, applied: true, saved: true })
      if (request.url.endsWith('/settings'))
        return json({ available: true, observed_zoom: observed })
      previews++
      return {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'x-preview-age-ms': '10' },
        body: Buffer.from([255, 216, 255, 224, 255, 217]),
      }
    },
  })
  const old = await service.execute({ action: 'preview' })
  assert.ok(old.preview)
  assert.equal((await service.execute({ action: 'zoom', ratio: 2 })).ok, true)
  time += 200
  assert.equal(
    (await service.execute({ action: 'focus', x: 0.5, y: 0.5, previewId: old.preview.id })).error
      ?.code,
    'XIAOMI_PREVIEW_STALE',
  )
  await service.execute({ action: 'settings' })
  assert.equal((await service.execute({ action: 'preview' })).error?.code, 'XIAOMI_ZOOM_PENDING')
  assert.equal(previews, 1)
  observed = 2
  await service.execute({ action: 'settings' })
  assert.equal((await service.execute({ action: 'preview' })).ok, true)
  assert.equal(previews, 2)
})
