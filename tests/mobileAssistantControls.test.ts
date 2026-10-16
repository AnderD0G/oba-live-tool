import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  MobileAssistantDeskServer,
  projectMobileAssistantState,
} from '../electron/main/services/MobileAssistantDeskServer'
import type {
  AssistantDeskCommand,
  AssistantDeskRow,
  AssistantDeskState,
} from '../shared/assistantDesk'

const row: AssistantDeskRow = {
  id: 'row-1',
  accountId: 'default',
  sessionId: 'session-1',
  platform: 'tiktok',
  receivedAt: 1000,
  nickname: 'Viewer',
  kind: 'comment',
  original: 'Hello',
  translation: {
    status: 'ready',
    source: 'local',
    method: 'chrome',
    language: 'en',
    chinese: '你好',
  },
  reply: { status: 'none' },
}
function state(collecting = true): AssistantDeskState {
  return {
    activeSession: collecting
      ? {
          id: 'session-1',
          accountId: 'default',
          status: 'collecting',
          startedAt: 1000,
          platform: 'tiktok',
          aiRequests: 0,
        }
      : undefined,
    context: {
      revision: 1,
      knowledge: '',
      instructions: '',
      replyMode: 'off',
      translationEnabled: true,
      translationMode: 'local',
      aiRequestLimit: 30,
      aiPaused: false,
      goldLevel: 10,
      priorityGold: false,
      localEffectsEnabled: false,
    },
    rows: [row],
    attention: { rows: [row], pinnedRowIds: [], total: 1 },
    sessions: [],
    segments: [],
    audience: [],
    audiencePolicy: { enabled: false, rules: [] },
    room: { status: 'unknown' },
    ai: { used: 0, limit: 30, queued: 0, running: 0, paused: false },
    health: { status: 'ok', pendingWrites: 0, dropped: 0, recoveryWarnings: 0 },
  } as AssistantDeskState
}

test('phone snapshots identify the selected memory simulation and its real manual-send target without projecting extra configuration', () => {
  const value = state()
  value.provenance = { mode: 'mock', runId: 'mock-run-1' }
  value.mockReplyTarget = { ready: true, username: 'actual_host' }
  const snapshot = projectMobileAssistantState(value, 'default', 'Test', 1000)
  assert.deepEqual(snapshot.provenance, { mode: 'mock', runId: 'mock-run-1' })
  assert.deepEqual(snapshot.mockReplyTarget, { ready: true, username: 'actual_host' })
  delete value.provenance
  delete value.mockReplyTarget
  const real = projectMobileAssistantState(value, 'default', 'Test', 1000)
  assert.equal(real.provenance, undefined)
  assert.equal(real.mockReplyTarget, undefined)
})
async function fixture(t: TestContext, collecting = true, apiMic = false) {
  let current = state(collecting)
  const commands: AssistantDeskCommand[] = []
  const cameras: unknown[] = []
  const microphones: unknown[] = []
  const xiaomis: unknown[] = []
  let cameraSelected = 'iphone'
  let finishCommand: (() => Promise<void>) | undefined
  const server = new MobileAssistantDeskServer({
    accountId: 'default',
    accountName: '测试账号',
    assetDirectory: path.resolve('public/assistant-mobile'),
    host: '127.0.0.1',
    port: 0,
    execute: async command => {
      if (command.action === 'state') return { ok: true, data: current }
      commands.push(command)
      await finishCommand?.()
      return {
        ok: true,
        data: {
          ...row,
          translation: { status: 'ready', source: 'ai', chinese: '人工复译', language: 'en' },
        },
      }
    },
    camera: async command => {
      cameras.push(command)
      if (command.action === 'switch') cameraSelected = command.target
      return {
        ok: true,
        cameraStatus: { ok: true, selected: cameraSelected, onProgram: true },
        settings: { password: 'PRIVATE-CAMERA-SECRET' },
      }
    },
    studioMic: async command => {
      microphones.push(command)
      return {
        ok: true,
        data: {
          supported: true,
          running: true,
          accessGranted: true,
          hotkey: apiMic ? '' : 'Control+Option+M',
          micState: apiMic ? 'muted' : 'unknown',
          ...(apiMic
            ? { backend: 'api' as const, beforeMuted: false, routeState: 'live' as const }
            : command.action === 'toggle'
              ? { sent: true }
              : {}),
          message: 'Native message',
        },
      }
    },
    xiaomi: async command => {
      xiaomis.push(command)
      return {
        ok: true,
        config: { baseUrl: 'http://192.168.1.5:18765', hasToken: true },
        camera: { state: 'ready', timestamp: '2026-10-16' },
        settings: {
          available: true,
          observed_zoom: 1,
          last_control_error: 'PRIVATE-DEVICE-SECRET',
        },
      }
    },
  })
  const access = await server.start()
  const base = access.urls[0]
  t.after(() => server.stop())
  const request = async (
    route: string,
    body: unknown,
    options: { base?: string; headers?: Record<string, string>; method?: string } = {},
  ) => {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpRequest(
        new URL(route, options.base ?? base),
        {
          method: options.method ?? 'POST',
          headers: { 'Content-Type': 'application/json', ...options.headers },
        },
        response => {
          let data = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            data += chunk
          })
          response.on('end', () => {
            try {
              resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) })
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      request.on('error', reject)
      request.end(JSON.stringify(body))
    })
  }
  return {
    base,
    request,
    commands,
    cameras,
    microphones,
    xiaomis,
    server,
    state: () => current,
    setState: (value: AssistantDeskState) => {
      current = value
    },
    beforeCommand: (value: typeof finishCommand) => {
      finishCommand = value
    },
  }
}

test('mobile camera and Studio mic control remain available without starting capture', async t => {
  const f = await fixture(t, false)
  const camera = await f.request('api/camera', { action: 'status' })
  assert.equal(camera.status, 200)
  assert.equal(camera.body.data.selected, 'iphone')
  assert.doesNotMatch(JSON.stringify(camera.body), /PRIVATE|settings|password/)
  const switched = await f.request('api/camera', { action: 'switch', target: 'android' })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.data.selected, 'android')
  const mic = await f.request('api/studio-mic', { action: 'toggle' })
  assert.equal(mic.status, 200)
  assert.equal(mic.body.data.sent, true)
  assert.equal(mic.body.data.micState, 'unknown')
  assert.equal(f.commands.length, 0)
})

test('closing one phone preview aborts only its read and leaves another viewer active', async t => {
  const entries: { signal?: AbortSignal; finish: () => void }[] = []
  let entered!: () => void
  let nextEntry = new Promise<void>(resolve => { entered = resolve })
  const server = new MobileAssistantDeskServer({
    accountId: 'default', accountName: 'fixture', host: '127.0.0.1', port: 0,
    assetDirectory: path.resolve('public/assistant-mobile'),
    execute: async () => ({ ok: true, data: state(false) }),
    xiaomi: async (_command, signal?: AbortSignal) => {
      await new Promise<void>(resolve => { entries.push({ signal, finish: resolve }); entered() })
      return { ok: false, error: { code: 'XIAOMI_CANCELLED', message: 'cancelled' } }
    },
  })
  const access = await server.start()
  const clients: ReturnType<typeof httpRequest>[] = []
  t.after(async () => {
    for (const client of clients) client.destroy()
    for (const entry of entries) entry.finish()
    await server.stop()
  })
  const open = () => {
    const client = httpRequest(new URL('api/xiaomi', access.urls[0]), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, response => response.resume())
    client.on('error', () => {})
    client.end(JSON.stringify({ action: 'preview' }))
    clients.push(client)
    return client
  }
  const first = open()
  await nextEntry
  nextEntry = new Promise<void>(resolve => { entered = resolve })
  open()
  await nextEntry
  assert.ok(entries[0].signal, 'Preview must receive its request-owned cancellation signal')
  assert.ok(entries[1].signal)
  const aborted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Phone preview was not aborted')), 1000)
    entries[0].signal!.addEventListener('abort', () => { clearTimeout(timeout); resolve() }, { once: true })
  })
  first.destroy()
  await aborted
  assert.equal(entries[0].signal!.aborted, true)
  assert.equal(entries[1].signal!.aborted, false)
})

test('continuous phone preview does not emit a diagnostic record for every frame', async t => {
  const traces: { action: string }[] = []
  const server = new MobileAssistantDeskServer({
    accountId: 'default', accountName: 'fixture', host: '127.0.0.1', port: 0,
    assetDirectory: path.resolve('public/assistant-mobile'),
    execute: async () => ({ ok: true, data: state(false) }),
    xiaomi: async () => ({ ok: true }),
    trace: entry => { traces.push(entry) },
  })
  const access = await server.start()
  t.after(() => server.stop())
  const request = async (action: string) => {
    const response = await fetch(new URL('api/xiaomi', access.urls[0]), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
  }
  for (let frame = 0; frame < 3; frame++) await request('preview')
  assert.equal(traces.length, 0)
  await request('settings')
  assert.ok(traces.some(trace => trace.action === 'mobile.xiaomi'))
})

test('control routes reject extra actions, arbitrary targets and caller account overrides', async t => {
  const f = await fixture(t)
  for (const [route, payload] of [
    ['api/studio-mic', { action: 'request-access' }],
    ['api/studio-mic', { action: 'toggle', accountId: 'other' }],
    ['api/camera', { action: 'save', config: {} }],
    ['api/camera', { action: 'switch', target: 'arbitrary' }],
    ['api/camera', { action: 'status', url: 'ws://example.com' }],
  ] as const)
    assert.equal((await f.request(route, payload)).status, 400)
  assert.equal(f.microphones.length, 0)
  assert.equal(f.cameras.length, 0)
})

test('control routes enforce the active secret path and same-origin requests', async t => {
  const f = await fixture(t)
  const wrongBase = new URL(f.base)
  wrongBase.pathname = '/wrong-token/'
  assert.equal(
    (await f.request('api/studio-mic', { action: 'toggle' }, { base: wrongBase.href })).status,
    404,
  )
  assert.equal(
    (
      await f.request(
        'api/camera',
        { action: 'switch', target: 'iphone' },
        { headers: { Origin: 'http://foreign.invalid' } },
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request(
        'api/studio-mic',
        { action: 'toggle' },
        { headers: { Host: 'foreign.invalid:8888' } },
      )
    ).status,
    403,
  )
  assert.equal(f.microphones.length, 0)
  assert.equal(f.cameras.length, 0)
})

test('mobile DeepSeek retry dispatches only a current scene row through the bound account', async t => {
  const f = await fixture(t)
  const translated = await f.request('api/command', {
    action: 'translate-retry',
    params: { rowId: row.id },
  })
  assert.equal(translated.status, 200)
  assert.equal(translated.body.data.translation.chinese, '人工复译')
  assert.deepEqual(f.commands, [
    { action: 'translate-retry', params: { accountId: 'default', rowId: 'row-1' } },
  ])
  const override = await f.request('api/command', {
    action: 'translate-retry',
    params: { rowId: row.id, accountId: 'another' },
  })
  assert.equal(override.status, 400)
  const missing = await f.request('api/command', {
    action: 'translate-retry',
    params: { rowId: 'old-row' },
  })
  assert.equal(missing.status, 400)
  assert.equal(f.commands.length, 1)
})

test('mobile DeepSeek retry obeys AI pause and quota without dispatching any provider action', async t => {
  const f = await fixture(t)
  const paused = state()
  paused.ai.paused = true
  paused.ai.pauseReason = 'user-paused'
  f.setState(paused)
  const pauseResult = await f.request('api/command', {
    action: 'translate-retry',
    params: { rowId: row.id },
  })
  assert.equal(pauseResult.status, 400)
  assert.equal(pauseResult.body.error.code, 'AI_PAUSED')
  const limited = state()
  limited.ai.used = limited.ai.limit
  f.setState(limited)
  const limitResult = await f.request('api/command', {
    action: 'translate-retry',
    params: { rowId: row.id },
  })
  assert.equal(limitResult.status, 400)
  assert.equal(limitResult.body.error.code, 'AI_REQUEST_LIMIT')
  assert.equal(f.commands.length, 0)
})

test('a stopped or replaced capture cannot yield a stale manual translation to the phone', async t => {
  const f = await fixture(t)
  f.beforeCommand(async () => {
    f.setState(state(false))
  })
  const result = await f.request('api/command', {
    action: 'translate-retry',
    params: { rowId: row.id },
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'MOBILE_SESSION_CHANGED')
})

test('phone snapshots retain usable fallback, ambiguity and retry errors without exposing AI configuration', () => {
  const value = state()
  value.rows = [
    {
      ...row,
      translation: {
        status: 'pending',
        source: 'ai',
        error: '安全翻译提示',
        fallback: { source: 'local', method: 'chrome', language: 'en', chinese: '保留中文' },
      },
    },
    {
      ...row,
      id: 'row-2',
      translation: {
        ...row.translation,
        manualAttempt: { status: 'failed', message: '复译未完成' },
      },
    },
  ]
  const projected = projectMobileAssistantState(value, 'default', '账号', 2000)
  assert.equal(projected.rows[0].translation.error, '安全翻译提示')
  assert.equal(projected.rows[0].translation.fallback?.chinese, '保留中文')
  assert.equal(projected.rows[1].translation.manualAttempt?.message, '复译未完成')
  assert.equal((projected as unknown as Record<string, unknown>).context, undefined)
})

test('phone lens controls use the configured camera without exposing or accepting device credentials', async t => {
  const f = await fixture(t, false)
  const read = await f.request('api/xiaomi', { action: 'settings' })
  assert.equal(read.status, 200)
  assert.equal(read.body.data.settings.observed_zoom, 1)
  assert.doesNotMatch(JSON.stringify(read.body), /PRIVATE|baseUrl|hasToken|192\.168/)
  for (const payload of [
    { action: 'config-get' },
    { action: 'config-save', config: { token: 'forbidden' } },
    { action: 'status', token: 'forbidden' },
    { action: 'zoom', ratio: 100 },
    { action: 'focus', x: 0.5, y: 0.5, previewId: 'http://elsewhere' },
  ])
    assert.equal((await f.request('api/xiaomi', payload)).status, 400)
  assert.deepEqual(f.xiaomis, [{ action: 'settings' }])
  const align = await f.request('api/studio-mic', { action: 'align-open' })
  assert.equal(align.status, 200)
  assert.notEqual(align.body.data.sent, true)
})

test('phone projects the confirmed API microphone state without keyboard permission or sent claims', async t => {
  const f = await fixture(t, false, true)
  for (const action of ['status', 'toggle', 'align-open', 'mute', 'unmute']) {
    const result = await f.request('api/studio-mic', { action })
    assert.equal(result.status, 200)
    assert.equal(result.body.data.backend, 'api')
    assert.equal(result.body.data.micState, 'muted')
    assert.equal(result.body.data.routeState, 'live')
    assert.equal(result.body.data.beforeMuted, false)
    assert.equal(result.body.data.sent, undefined)
    assert.doesNotMatch(result.body.data.message, /热键|辅助功能|重新对齐/)
  }
})
