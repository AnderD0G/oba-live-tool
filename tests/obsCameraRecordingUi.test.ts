import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { chromium } from 'playwright'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MobileAssistantDeskServer } from '../electron/main/services/MobileAssistantDeskServer'
import { createMobileClient } from '../public/assistant-mobile/app.js'
import { ReviewPanel } from '../src/pages/AssistantDesk/ReviewPanel'

const snapshot = {
  accountId: 'default',
  accountName: 'Test',
  serverNow: 1000,
  collecting: false,
  rows: [],
  tasks: [],
  totalTasks: 0,
  pinnedRowIds: [],
  marker: { completed: 0 },
  room: { status: 'unknown' },
  ai: { used: 0, limit: 30, paused: false },
  audienceRules: [],
}
const idle = {
  ok: true,
  ready: true,
  running: false,
  cameras: [
    {
      target: 'iphone',
      sourceName: 'iPhone source',
      filterName: 'iPhone record',
      active: false,
      owned: false,
    },
    {
      target: 'android',
      sourceName: 'Xiaomi source',
      filterName: 'Xiaomi record',
      active: false,
      owned: false,
    },
  ],
  marks: [],
}
const recording = {
  ...idle,
  running: true,
  runId: 'run-1',
  startedAt: 1000,
  cameras: idle.cameras.map(camera => ({
    ...camera,
    active: true,
    owned: true,
    outputPath: `/recordings/${camera.target}.mkv`,
    outputDurationMs: 12345,
  })),
  indexPath: '/recordings/run-1/index.json',
  manifestPath: '/recordings/run-1/manifest.json',
}
const mark = {
  runId: 'run-1',
  requestId: 'mark-1',
  sequence: 1,
  target: 'iphone',
  sourceName: 'iPhone source',
  filterName: 'iPhone record',
  programScene: 'iPhone program',
  label: '观众问题',
  chapterName: '001 观众问题',
  outputPath: '/recordings/iphone.mkv',
  offsetMs: 12345,
  requestedAt: 13345,
  status: 'confirmed',
}

async function mobileFixture(t: TestContext) {
  const calls: Record<string, unknown>[] = []
  const privateRecording = {
    ...recording,
    marks: [{ ...mark, outputPath: '/PRIVATE/iphone.mkv' }],
    indexPath: '/PRIVATE/index.json',
    password: 'PRIVATE-SECRET',
  }
  let fail = false
  const server = new MobileAssistantDeskServer({
    accountId: 'default',
    accountName: 'Test',
    assetDirectory: path.resolve('public/assistant-mobile'),
    host: '127.0.0.1',
    port: 0,
    execute: async () => ({ ok: false, error: { code: 'NO_ACTIVE_SESSION', message: '未采集' } }),
    cameraRecording: async (command: Record<string, unknown>) => {
      calls.push(command)
      return fail
        ? { ok: false, error: 'PRIVATE-OBS-ERROR', recording: { ...privateRecording, ok: false } }
        : { ok: true, recording: privateRecording }
    },
  } as any)
  const access = await server.start()
  t.after(() => server.stop())
  const base = access.urls[0]
  const send = async (
    body: unknown,
    options: { base?: string; headers?: Record<string, string> } = {},
  ) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpRequest(
        new URL('api/camera-recording', options.base ?? base),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...options.headers },
        },
        response => {
          let result = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            result += chunk
          })
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(result) }),
          )
        },
      )
      request.on('error', reject)
      request.end(JSON.stringify(body))
    })
  return {
    send,
    calls,
    base,
    fail: () => {
      fail = true
    },
  }
}

test('phone can read and mark independent camera recordings without an assistant capture', async t => {
  const f = await mobileFixture(t)
  const state = await f.send({ action: 'status' })
  assert.equal(state.status, 200)
  assert.equal(state.body.data.runId, 'run-1')
  assert.equal(state.body.data.marks[0].offsetMs, 12345)
  assert.equal(state.body.data.marks[0].target, 'iphone')
  assert.doesNotMatch(JSON.stringify(state.body), /PRIVATE|password|indexPath/)
  const marked = await f.send({
    action: 'mark',
    runId: 'run-1',
    requestId: 'mark-1',
    label: '观众问题',
  })
  assert.equal(marked.status, 200)
  assert.deepEqual(f.calls, [
    { action: 'status' },
    { action: 'mark', runId: 'run-1', requestId: 'mark-1', label: '观众问题' },
  ])
})

test('phone recording route rejects arbitrary writes, paths and stale-origin requests before dispatch', async t => {
  const f = await mobileFixture(t)
  for (const command of [
    { action: 'start', requestId: 'start-1' },
    { action: 'stop', runId: 'run-1', requestId: 'stop-1' },
    { action: 'status', runId: 'run-1' },
    { action: 'mark', runId: '', requestId: 'mark-1' },
    { action: 'mark', runId: 'run-1', requestId: 'mark-1', label: 'x'.repeat(101) },
    { action: 'mark', runId: 'run-1', requestId: 'mark-1', sourceName: 'iPhone' },
    { action: 'mark', runId: 'run-1', requestId: 'mark-1', path: '/tmp/a.mkv' },
    { action: 'mark', runId: 'run-1', requestId: 'mark-1', label: '\u0000' },
  ])
    assert.equal((await f.send(command)).status, 400)
  assert.equal(
    (await f.send({ action: 'status' }, { headers: { Origin: 'http://untrusted.example' } }))
      .status,
    403,
  )
  assert.equal(
    (await f.send({ action: 'status' }, { base: f.base.replace(/\/[a-zA-Z0-9_-]+\/$/, '/wrong/') }))
      .status,
    404,
  )
  assert.deepEqual(f.calls, [])
})

test('phone camera recording client never repeats a mark after uncertain delivery', async () => {
  const calls: { url: string; body?: any }[] = []
  const client = createMobileClient({
    fetch: async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })
      if (url === './api/state')
        return { ok: true, json: async () => ({ ok: true, data: snapshot }) }
      if (body.action === 'mark') throw Error('response lost')
      return { ok: true, json: async () => ({ ok: true, data: { runId: 'run-1', marks: [] } }) }
    },
  }) as any
  await client.poll()
  assert.equal(
    (
      await client.cameraRecording({
        action: 'mark',
        runId: 'run-1',
        requestId: 'mark-1',
        label: '补货',
      })
    ).ok,
    false,
  )
  await client.poll()
  await client.cameraRecording({ action: 'status' })
  assert.equal(calls.filter(value => value.body?.action === 'mark').length, 1)
  assert.equal((await client.cameraRecording({ action: 'start' })).error.code, 'UNSUPPORTED')
  assert.equal(
    (
      await client.cameraRecording({
        action: 'mark',
        runId: 'run-1',
        requestId: 'mark-2',
        path: '/tmp/other.mkv',
      })
    ).error.code,
    'UNSUPPORTED',
  )
  assert.equal(calls.filter(value => value.body?.action === 'mark').length, 1)
})

test('phone receives safe partial recording ownership on an OBS error', async t => {
  const f = await mobileFixture(t)
  f.fail()
  const state = await f.send({ action: 'status' })
  assert.equal(state.body.ok, false)
  assert.equal(state.body.recording.runId, 'run-1')
  assert.equal(state.body.recording.cameras[0].active, true)
  assert.doesNotMatch(
    JSON.stringify(state.body),
    /PRIVATE|outputPath|filterName|sourceName|indexPath/,
  )
})

async function desktopFixture(t: TestContext, initial = recording) {
  const require = createRequire(import.meta.url)
  const viteRequire = createRequire(require.resolve('vite/package.json'))
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-recording-ui-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const outfile = path.join(folder, 'ui.js')
  viteRequire('esbuild').buildSync({
    stdin: {
      contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CameraRecordingControls } from './src/pages/AssistantDesk/CameraRecordingControls';
      let finish;
      const calls = [];
      let requestNumber = 0;
      if (!crypto.randomUUID) crypto.randomUUID = () => 'request-' + (++requestNumber);
      window.fixture = { calls, current: ${JSON.stringify(initial)}, finish(result) { if (result.recording) this.current = result.recording; finish(result); } };
      const request = command => {
        calls.push(command);
        if (command.action === 'camera-recording-status') return Promise.resolve({ ok: window.fixture.current.ok, recording: window.fixture.current, error: window.fixture.current.error });
        return new Promise(resolve => { finish = resolve; });
      };
      createRoot(document.getElementById('root')).render(React.createElement(CameraRecordingControls, { request }));
    `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile,
    logLevel: 'silent',
  })
  const executablePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find(existsSync)
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(4000)
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: await readFile(outfile, 'utf8') })
  await page.getByRole('region', { name: '双路独立录像' }).waitFor()
  return page
}

test('desktop reads independent recordings without starting them and marks once using the displayed run', async t => {
  const page = await desktopFixture(t)
  await page.getByText('/recordings/iphone.mkv', { exact: true }).waitFor()
  assert.equal(await page.getByText('/recordings/android.mkv', { exact: true }).count(), 1)
  assert.equal(await page.getByText('/recordings/run-1/index.json', { exact: true }).count(), 1)
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [
    { action: 'camera-recording-status' },
  ])
  await page.getByLabel('章节标题').fill('观众问题')
  const button = page.getByRole('button', { name: '打点当前机位', exact: true })
  await button.click()
  await button.evaluate((element: HTMLButtonElement) => element.click())
  const writes = await page.evaluate(() =>
    (window as any).fixture.calls.filter(
      (command: any) => command.action === 'camera-recording-mark',
    ),
  )
  assert.equal(writes.length, 1)
  assert.equal(writes[0].runId, 'run-1')
  assert.equal(writes[0].label, '观众问题')
  assert.equal(typeof writes[0].requestId, 'string')
  assert.deepEqual(Object.keys(writes[0]).sort(), ['action', 'label', 'requestId', 'runId'])
  assert.equal(await button.isDisabled(), true)
  await page.evaluate(value => (window as any).fixture.finish(value), {
    ok: true,
    recording: { ...recording, marks: [{ ...mark, requestId: writes[0].requestId }] },
  })
  await page.getByText('001 观众问题', { exact: true }).waitFor()
  assert.match(await page.getByRole('region', { name: '双路独立录像' }).innerText(), /约00:00:12/)
  assert.match(
    await page.getByRole('region', { name: '双路独立录像' }).innerText(),
    /OBS 已接受章节/,
  )
})

test('desktop refreshes after an uncertain mark without retrying or claiming a confirmed chapter', async t => {
  const page = await desktopFixture(t)
  await page.getByRole('button', { name: '打点当前机位', exact: true }).click()
  await page.evaluate(
    value => {
      ;(window as any).fixture.current = value
      ;(window as any).fixture.finish({ ok: false, error: '打点结果未确认' })
    },
    {
      ...recording,
      marks: [{ ...mark, status: 'unconfirmed', error: 'vendor response lost' }],
    },
  )
  await page.getByRole('alert').waitFor()
  await page.getByText('001 观众问题', { exact: true }).waitFor()
  const text = await page.getByRole('region', { name: '双路独立录像' }).innerText()
  assert.match(text, /结果待确认/)
  assert.doesNotMatch(text, /OBS 已接受章节/)
  const calls = await page.evaluate(() => (window as any).fixture.calls)
  assert.equal(calls.filter((command: any) => command.action === 'camera-recording-mark').length, 1)
  assert.equal(
    calls.filter((command: any) => command.action === 'camera-recording-status').length,
    2,
  )
})

test('desktop starts only after a click then stops the returned run without a second start', async t => {
  const page = await desktopFixture(t, idle as typeof recording)
  await page.getByRole('button', { name: '开始两路录像', exact: true }).click()
  assert.equal(
    await page.getByRole('button', { name: '打点当前机位', exact: true }).isDisabled(),
    true,
  )
  await page.evaluate(value => (window as any).fixture.finish(value), { ok: true, recording })
  await page.getByText('/recordings/iphone.mkv', { exact: true }).waitFor()
  await page.getByRole('button', { name: '停止两路录像', exact: true }).click()
  const writes = await page.evaluate(() =>
    (window as any).fixture.calls.filter(
      (command: any) => command.action !== 'camera-recording-status',
    ),
  )
  assert.deepEqual(
    writes.map((command: any) => command.action),
    ['camera-recording-start', 'camera-recording-stop'],
  )
  assert.equal(writes[1].runId, 'run-1')
  await page.evaluate(value => (window as any).fixture.finish(value), {
    ok: true,
    recording: {
      ...recording,
      running: false,
      cameras: recording.cameras.map(camera => ({ ...camera, active: false })),
    },
  })
  await page
    .getByRole('button', { name: '开始两路录像', exact: true })
    .waitFor({ state: 'visible' })
})

test('a partial recording error keeps stop and the surviving camera mark available', async t => {
  const page = await desktopFixture(t, {
    ...recording,
    ok: false,
    error: '小米录像已断开',
    cameras: recording.cameras.map(camera =>
      camera.target === 'android' ? { ...camera, active: false, error: '来源已断开' } : camera,
    ),
  })
  await page.getByText('/recordings/iphone.mkv', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('button', { name: '停止两路录像', exact: true }).isEnabled(),
    true,
  )
  assert.equal(
    await page.getByRole('button', { name: '打点当前机位', exact: true }).isEnabled(),
    true,
  )
  assert.equal(
    await page.getByRole('button', { name: '开始两路录像', exact: true }).isEnabled(),
    false,
  )
  await page.getByRole('button', { name: '停止两路录像', exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).runId), 'run-1')
})

async function phoneUiFixture(t: TestContext) {
  const executablePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find(existsSync)
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(4000)
  await page.setContent('<div id="app"></div>')
  await page.addScriptTag({ content: 'globalThis.__name = fn => fn;' })
  await page.addStyleTag({
    content: await readFile(new URL('../public/assistant-mobile/app.css', import.meta.url), 'utf8'),
  })
  await page.evaluate(
    ({ snapshot, recording }) => {
      const calls: any[] = []
      let finish: (value: unknown) => void
      const ok = (data: any) => ({ ok: true, json: async () => ({ ok: true, data }) })
      ;(window as any).fixture = {
        calls,
        current: recording,
        finish(result: any) {
          if (result.data) this.current = result.data
          if (result.recording) this.current = result.recording
          finish({ ok: result.ok, json: async () => result })
        },
      }
      window.fetch = (async (url: any, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, body })
        if (url === './api/state') return ok({ ...snapshot, serverNow: Date.now() })
        if (url === './api/camera-recording') {
          if (body.action === 'status' && (window as any).fixture.holdRecordingStatus)
            return new Promise(() => {})
          if (body.action === 'status') return ok((window as any).fixture.current)
          return new Promise(resolve => {
            finish = resolve
          })
        }
        if (url === './api/camera')
          return ok({ available: true, selected: 'iphone', onProgram: true, message: '已核对' })
        if (url === './api/studio-mic')
          return ok({ supported: true, backend: 'api', routeState: 'live', micState: 'unmuted' })
        return ok({})
      }) as typeof fetch
    },
    {
      snapshot,
      recording: {
        ok: true,
        ready: true,
        running: true,
        runId: 'run-1',
        cameras: [
          { target: 'iphone', owned: true, active: true },
          { target: 'android', owned: true, active: true },
        ],
        marks: [],
      },
    },
  )
  await page.addScriptTag({
    content: (
      await readFile(new URL('../public/assistant-mobile/app.js', import.meta.url), 'utf8')
    ).replace(/^export /gm, ''),
  })
  await page.getByRole('region', { name: '录像章节' }).waitFor()
  return page
}

test('phone offers a separate current-program chapter button without requiring comment capture', async t => {
  const page = await phoneUiFixture(t)
  await page.getByLabel('录像章节标题').fill('观众问题')
  await page.getByRole('button', { name: '打点当前机位', exact: true }).click()
  assert.equal(
    await page.getByRole('button', { name: '打点当前机位', exact: true }).isDisabled(),
    true,
  )
  const command = await page.evaluate(
    () => (window as any).fixture.calls.find((call: any) => call.body?.action === 'mark').body,
  )
  assert.equal(command.runId, 'run-1')
  assert.equal(command.label, '观众问题')
  assert.equal(Object.hasOwn(command, 'sessionId'), false)
  await page.evaluate(value => (window as any).fixture.finish(value), {
    ok: true,
    data: {
      ok: true,
      ready: true,
      running: true,
      runId: 'run-1',
      cameras: [{ target: 'iphone', active: true, owned: true }],
      marks: [{ ...mark, requestId: command.requestId }],
    },
  })
  const bar = page.getByRole('region', { name: '录像章节' })
  await bar.getByText(/OBS 已接受章节/).waitFor()
  assert.match(await bar.innerText(), /iPhone.*约00:00:12/)
  const calls = await page.evaluate(() => (window as any).fixture.calls)
  assert.equal(calls.filter((call: any) => call.body?.action === 'mark').length, 1)
  assert.equal(
    calls.some((call: any) => ['start', 'stop'].includes(call.body?.action)),
    false,
  )
  assert.equal(await page.getByRole('region', { name: '片段范围' }).count(), 0)
  assert.equal(
    await page.getByRole('button', { name: /开始片段|结束片段|开始打点|结束打点/ }).count(),
    0,
  )
})

test('phone preserves an unconfirmed chapter and only refreshes status after the error', async t => {
  const page = await phoneUiFixture(t)
  await page.getByRole('button', { name: '打点当前机位', exact: true }).click()
  const command = await page.evaluate(
    () => (window as any).fixture.calls.find((call: any) => call.body?.action === 'mark').body,
  )
  await page.evaluate(value => (window as any).fixture.finish(value), {
    ok: false,
    error: { code: 'MOBILE_CAMERA_RECORDING_UNCONFIRMED', message: '章节结果未确认' },
    recording: {
      ok: true,
      ready: true,
      running: true,
      runId: 'run-1',
      cameras: [{ target: 'iphone', active: true, owned: true }],
      marks: [{ ...mark, requestId: command.requestId, status: 'unconfirmed' }],
    },
  })
  const bar = page.getByRole('region', { name: '录像章节' })
  await bar.getByText(/结果待确认/).waitFor()
  assert.doesNotMatch(await bar.innerText(), /OBS 已接受章节/)
  const calls = await page.evaluate(() => (window as any).fixture.calls)
  assert.equal(calls.filter((call: any) => call.body?.action === 'mark').length, 1)
  assert.ok(
    calls.filter(
      (call: any) => call.url === './api/camera-recording' && call.body?.action === 'status',
    ).length >= 2,
  )
})

test('historical ranges remain readable without offering a second marker or range editing', () => {
  const html = renderToStaticMarkup(
    createElement(ReviewPanel, {
      accountId: 'default',
      busy: false,
      request: async () => ({ ok: true }),
      state: {
        context: { localEffectsEnabled: false },
        activeSession: {
          id: 'scene-1',
          accountId: 'default',
          status: 'collecting',
          captureSessionId: 'capture-1',
        },
        sessions: [
          {
            id: 'scene-1',
            accountId: 'default',
            platform: 'tiktok',
            startedAt: 1000,
            aiRequests: 0,
            status: 'collecting',
            captureSessionId: 'capture-1',
            captureRuns: [{ captureSessionId: 'capture-1', startedAt: 1000 }],
          },
        ],
        segments: [
          {
            id: 'legacy-1',
            accountId: 'default',
            sessionId: 'scene-1',
            captureSessionId: 'capture-1',
            name: '历史商品演示',
            startedAt: 2000,
            endedAt: 5000,
          },
        ],
      } as any,
    }),
  )
  const text = html.replace(/<[^>]*>/g, '')
  assert.match(text, /历史商品演示/)
  assert.match(text, /capture-1/)
  assert.doesNotMatch(text, /开始片段打点|结束 历史商品演示/)
  assert.doesNotMatch(html, /aria-label="片段名称/)
})

test('a slow recording status read does not stop the phone live-comment polling loop', async t => {
  const page = await phoneUiFixture(t)
  await page.getByRole('button', { name: '打点当前机位', exact: true }).waitFor()
  await page.evaluate(() => {
    ;(window as any).fixture.holdRecordingStatus = true
  })
  await page.waitForFunction(
    () =>
      (window as any).fixture.calls.filter((call: any) => call.url === './api/state').length >= 3,
    undefined,
    { timeout: 5500 },
  )
  assert.equal(
    await page.evaluate(() =>
      (window as any).fixture.calls.some((call: any) => call.body?.action === 'mark'),
    ),
    false,
  )
})
