import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { chromium } from 'playwright'
import { createMobileClient, rowCommand } from '../public/assistant-mobile/app.js'

const row = {
  id: 'row',
  accountId: 'default',
  sessionId: 'scene',
  receivedAt: Date.now(),
  nickname: 'Viewer',
  kind: 'comment',
  original: 'Hello',
  translation: {
    status: 'ready',
    source: 'local',
    method: 'chrome',
    language: 'en',
    chinese: '本地中文',
  },
  reply: { status: 'none' },
}
const snapshot = {
  accountId: 'default',
  accountName: 'Test',
  serverNow: Date.now(),
  collecting: true,
  sessionId: 'scene',
  rows: [row],
  tasks: [row],
  pinnedRowIds: [],
  totalTasks: 1,
  room: { status: 'unknown' },
  ai: { used: 0, limit: 30, paused: false },
  audienceRules: [],
  marker: { completed: 0 },
}
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) })
const browserExecutable = [
  chromium.executablePath(),
  ...(process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : []),
].find(existsSync)
const browserTest = (name: string, run: (t: TestContext) => Promise<void>) =>
  test(name, { skip: !browserExecutable && 'Playwright Chromium/Chrome is not installed' }, run)

test('mobile client allows only explicit fixed control commands and never retries after uncertain delivery', async () => {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  let failToggle = true
  const client = createMobileClient({
    fetch: async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })
      if (url === './api/state') return response(snapshot)
      if (url === './api/studio-mic' && body.action === 'toggle' && failToggle)
        throw Error('delivery unknown')
      return response({ selected: 'android', routeState: 'live' })
    },
  })
  await client.poll()
  assert.equal((await client.camera({ action: 'switch', target: 'android' })).ok, true)
  assert.equal((await client.studioMic('toggle')).ok, false)
  failToggle = false
  await client.poll()
  assert.equal(calls.filter(value => value.url === './api/studio-mic').length, 1)
  assert.equal((await client.studioMic('request-access')).ok, false)
  assert.equal((await client.camera({ action: 'save', url: 'remote' })).ok, false)
  assert.equal((await client.xiaomi({ action: 'config-get' })).ok, false)
  assert.equal(calls.filter(value => value.url !== './api/state').length, 2)
})

test('manual comment retranslation is separate from reply preview and has no public-send action', () => {
  assert.deepEqual(rowCommand('retranslate', row), {
    action: 'translate-retry',
    params: { rowId: 'row' },
  })
})

test('waiting for camera startup does not freeze live-comment polling or replay a camera command', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  let writes = 0
  const client = createMobileClient({
    fetch: async (url: string) => {
      if (url === './api/state') return response(snapshot)
      writes++
      return new Promise(resolve => {
        finish = resolve
      })
    },
  })
  await client.poll()
  const starting = client.xiaomi({ action: 'start' })
  try {
    assert.equal(await client.poll(), true)
  } finally {
    finish(response({ camera: { state: 'ready' } }))
    await starting
  }
  assert.equal(writes, 1)
})

async function ui(t: any, data: any = snapshot, apiMic = false) {
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(3000)
  await page.setContent('<div id="app"></div>')
  await page.addScriptTag({ content: 'globalThis.__name = fn => fn;' })
  await page.addStyleTag({
    content: await readFile(new URL('../public/assistant-mobile/app.css', import.meta.url), 'utf8'),
  })
  await page.evaluate(
    ({ value, apiMic }) => {
      let current = value
      let micRoute: 'live' | 'unknown' = 'live'
      let focusResult = 'focused'
      let focusSubmitted = false
      let previewExpired = false
      let previewSequence = 0
      let observedZoom = 1
      let holdZoom = false
      let finishZoom: (() => void) | undefined
      const calls: any[] = []
      let finish: any
      ;(window as any).fixture = {
        calls,
        observedZoom(value: number) {
          observedZoom = value
        },
        holdZoom() {
          holdZoom = true
        },
        finishZoom() {
          holdZoom = false
          finishZoom?.()
        },
        focusResult(value: string) {
          focusResult = value
        },
        expirePreview() {
          previewExpired = true
        },
        micRouteUnknown() {
          micRoute = 'unknown'
        },
        update(next: any) {
          current = next
        },
        finish(data: any) {
          finish({ ok: true, json: async () => ({ ok: true, data }) })
        },
      }
      window.fetch = (async (url: any, init: any = {}) => {
        const payload = init.body ? JSON.parse(init.body) : undefined
        calls.push({ url, payload })
        const ok = (data: any) => ({ ok: true, json: async () => ({ ok: true, data }) })
        if (url === './api/state') return ok({ ...current, serverNow: Date.now() })
        if (url === './api/command' && payload.action === 'translate-retry')
          return new Promise(resolve => {
            finish = resolve
          })
        if (url === './api/camera')
          return ok({
            available: true,
            selected: payload.target || 'iphone',
            onProgram: true,
            message: '机位已核对',
          })
        if (url === './api/studio-mic')
          return ok({
            supported: true,
            running: true,
            accessGranted: true,
            hotkey: apiMic ? '' : 'Control+Option+M',
            micState: apiMic ? 'muted' : 'unknown',
            ...(apiMic ? { backend: 'api' } : {}),
            routeState: !apiMic && payload.action === 'toggle' ? 'unknown' : micRoute,
            linked: true,
            message: apiMic ? 'TK Studio 麦克风已静音' : '已发送热键',
          })
        if (url === './api/xiaomi') {
          if (payload.action === 'preview') {
            const canvas = document.createElement('canvas')
            canvas.width = 360
            canvas.height = 640
            return ok({
              preview: {
                id: `preview-${++previewSequence}`,
                dataUrl: canvas.toDataURL('image/jpeg'),
                capturedAt: Date.now(),
                expiresAt: Date.now() + (previewExpired ? -1 : 2000),
              },
            })
          }
          if (payload.action === 'zoom') {
            if (holdZoom)
              return new Promise(resolve => {
                finishZoom = () => {
                  observedZoom = payload.ratio
                  resolve(ok({ operation: { success: true, applied: true } }))
                }
              })
            observedZoom = payload.ratio
            return ok({ operation: { success: true, applied: true } })
          }
          if (payload.action === 'focus') {
            focusSubmitted = true
            focusResult = 'pending'
            return ok({ operation: { success: true, focus_submitted: true } })
          }
          return ok({
            camera: { state: 'ready' },
            settings: {
              available: true,
              zoom: observedZoom,
              zoom_min: 1,
              zoom_max: 10,
              observed_zoom: observedZoom,
              focus_supported: true,
              focus_pending: focusSubmitted && focusResult === 'pending',
              focus_state: focusResult === 'pending' ? 'focusing' : 'idle',
              last_focus_result: focusResult,
            },
          })
        }
        if (url === './api/voice')
          return ok({
            status:
              payload.action === 'start'
                ? 'recording'
                : payload.action === 'stop'
                  ? 'stopped'
                  : 'cancelled',
            rowId: payload.rowId,
            text: '手机识别中文',
            ...(payload.action === 'stop'
              ? { micWarning: '请恢复 TK 开麦后重新对齐', routeState: 'unknown' }
              : {}),
          })
        return ok({})
      }) as typeof fetch
    },
    { value: data, apiMic },
  )
  const script = (
    await readFile(new URL('../public/assistant-mobile/app.js', import.meta.url), 'utf8')
  ).replace(/^export /gm, '')
  await page.addScriptTag({ content: script })
  await page
    .getByText('已连接', { exact: true })
    .waitFor()
    .catch(async () => {
      throw Error(
        JSON.stringify({
          errors,
          text: await page.locator('body').innerText(),
          calls: await page.evaluate(() => (window as any).fixture.calls),
        }),
      )
    })
  return page
}

browserTest(
  'phone keeps local translation during explicit DeepSeek supplement and preserves the fallback error',
  async t => {
    const page = await ui(t)
    const supplement = page.getByRole('button', { name: 'DeepSeek 复译', exact: true }).first()
    const live = page.locator('.pane-live')
    assert.equal(await supplement.count(), 1)
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (value: any) => value.payload?.action === 'translate-retry',
          ).length,
      ),
      0,
    )
    await supplement.click()
    assert.equal(await live.getByText('本地中文', { exact: true }).isVisible(), true)
    const failed = {
      ...row,
      translation: {
        ...row.translation,
        manualAttempt: { status: 'failed', message: '复译失败，已保留本地译文' },
      },
    }
    await page.evaluate(
      value => {
        ;(window as any).fixture.update({
          ...value.snapshot,
          rows: [value.failed],
          tasks: [value.failed],
        })
        ;(window as any).fixture.finish(value.failed)
      },
      { snapshot, failed },
    )
    await page.getByText('复译失败，已保留本地译文', { exact: true }).first().waitFor()
    assert.equal(await live.getByText('本地中文', { exact: true }).isVisible(), true)
    assert.equal(
      await page.evaluate(() =>
        (window as any).fixture.calls.some((value: any) =>
          ['reply-approve', 'context-save'].includes(value.payload?.action),
        ),
      ),
      false,
    )
  },
)

browserTest(
  'phone control panel can switch cameras without capture and never claims a sent hotkey is muted',
  async t => {
    const page = await ui(t, {
      ...snapshot,
      collecting: false,
      sessionId: undefined,
      rows: [],
      tasks: [],
    })
    await page.getByText('机位与麦克风', { exact: true }).click()
    const camera = page.getByRole('button', { name: '小米机位', exact: true })
    assert.equal(await camera.isEnabled(), true)
    await camera.click()
    await page.getByText('机位已核对', { exact: true }).waitFor()
    await page.getByRole('button', { name: '切换直播麦克风', exact: true }).click()
    await page.getByRole('button', { name: '我已恢复 TK 开麦，重新对齐', exact: true }).waitFor()
    assert.equal(await page.getByText('已闭麦', { exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.calls.filter((value: any) => value.url === './api/voice').length,
      ),
      0,
    )
  },
)

browserTest(
  'phone ASR retains recognized text and displays a route restoration warning',
  async t => {
    const page = await ui(t)
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await page.getByRole('button', { name: '使用电脑麦克风', exact: true }).click()
    await page.getByRole('button', { name: '结束录音并获取文字', exact: true }).first().click()
    await page.getByRole('textbox', { name: '中文回复草稿', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('textbox', { name: '中文回复草稿', exact: true }).inputValue(),
      '手机识别中文',
    )
    assert.match(await page.getByRole('status').first().innerText(), /恢复 TK 开麦/)
  },
)

browserTest('phone displays API mute state and keeps confirmed manual controls usable', async t => {
  const page = await ui(t, snapshot, true)
  await page.getByText('机位与麦克风', { exact: true }).click()
  await page.getByText('TK Studio 麦克风已静音', { exact: true }).waitFor()
  const toggle = page.getByRole('button', { name: '切换直播麦克风', exact: true })
  await toggle.click()
  assert.equal(await toggle.isEnabled(), true)
  assert.equal(
    await page.getByRole('button', { name: '重新读取麦克风状态', exact: true }).isVisible(),
    false,
  )
  assert.doesNotMatch(await page.locator('.live-controls').innerText(), /热键|辅助功能|初始开麦/)
  await page.evaluate(() => (window as any).fixture.micRouteUnknown())
  await page.getByRole('button', { name: '检查麦克风控制', exact: true }).click()
  await page.getByRole('button', { name: '重新读取麦克风状态', exact: true }).waitFor()
  assert.doesNotMatch(await page.locator('.live-controls').innerText(), /热键|手动恢复 TK 开麦/)
})

browserTest(
  'phone focus retains the preview, marks the requested point and observes the real failed result without replay',
  async t => {
    const page = await ui(t, snapshot, true)
    await page.getByText('机位与麦克风', { exact: true }).click()
    await page.getByRole('button', { name: '刷新镜头设置', exact: true }).click()
    await page.getByRole('button', { name: '刷新预览，点选对焦', exact: true }).click()
    const image = page.getByAltText('小米相机预览，点选对焦')
    await image.waitFor()
    await image.scrollIntoViewIfNeeded()
    const box = (await image.boundingBox())!
    await image.click({ position: { x: box.width * 0.25, y: box.height * 0.6 } })
    const marker = page.locator('.xiaomi-focus-marker')
    await marker.waitFor()
    const marked = (await marker.boundingBox())!
    assert.ok(Math.abs(marked.x + marked.width / 2 - box.x - box.width * 0.25) < 2)
    assert.ok(Math.abs(marked.y + marked.height / 2 - box.y - box.height * 0.6) < 2)
    await page.getByText(/对焦已提交.*等待/).waitFor()
    assert.equal(await marker.getAttribute('data-state'), 'pending')
    await page.locator('.live-controls-body').evaluate(node => {
      node.scrollTop = Math.max(0, node.scrollTop - 45)
    })
    await page.screenshot({ path: '.cache/native/mobile-camera-focus-yellow.png', fullPage: true })
    await image.click({ position: { x: 20, y: 20 } })
    assert.equal(await marker.isVisible(), true)
    await page.getByText(/对焦中/).waitFor()
    await page.evaluate(() => {
      setTimeout(() => (window as any).fixture.focusResult('not_focused'), 1550)
    })
    await page.getByText(/对焦未合焦.*not_focused/).waitFor({ timeout: 4500 })
    assert.equal(await marker.getAttribute('data-state'), 'failed')
    assert.equal(await image.isVisible(), true)
    await page.waitForFunction(
      () =>
        (window as any).fixture.calls.filter(
          (call: any) => call.url === './api/xiaomi' && call.payload.action === 'preview',
        ).length >= 2,
    )
    assert.equal(await marker.isVisible(), true)
    const focusCalls = await page.evaluate(() =>
      (window as any).fixture.calls.filter(
        (call: any) => call.url === './api/xiaomi' && call.payload.action === 'focus',
      ),
    )
    assert.equal(focusCalls.length, 1)
    assert.ok(Math.abs(focusCalls[0].payload.x - 0.25) < 0.01)
    assert.ok(Math.abs(focusCalls[0].payload.y - 0.6) < 0.01)
    await page.getByRole('button', { name: '刷新预览，点选对焦', exact: true }).click()
    assert.equal(await marker.isVisible(), false)
    await image.click({ position: { x: 20, y: 20 } })
    await marker.waitFor()
    await page.getByRole('button', { name: '应用变焦', exact: true }).click()
    assert.equal(await marker.isVisible(), false)
    assert.equal(await image.isVisible(), true)
  },
)

browserTest(
  'phone expired preview never submits focus and closing the panel clears its marker',
  async t => {
    const page = await ui(t)
    await page.getByText('机位与麦克风', { exact: true }).click()
    await page.getByRole('button', { name: '刷新镜头设置', exact: true }).click()
    const refreshPreview = page.getByRole('button', { name: '刷新预览，点选对焦', exact: true })
    await refreshPreview.click()
    const image = page.getByAltText('小米相机预览，点选对焦')
    await image.click({ position: { x: 30, y: 30 } })
    const marker = page.locator('.xiaomi-focus-marker')
    await marker.waitFor()
    await page.getByText('机位与麦克风', { exact: true }).click()
    await page.getByText('机位与麦克风', { exact: true }).click()
    assert.equal(await marker.isVisible(), false)
    await page.evaluate(() => (window as any).fixture.expirePreview())
    await refreshPreview.click()
    await image.click({ position: { x: 30, y: 30 } })
    await page.getByText('预览已过期，请刷新图像后再点选对焦', { exact: true }).waitFor()
    assert.equal(await marker.isVisible(), false)
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (call: any) => call.url === './api/xiaomi' && call.payload.action === 'focus',
          ).length,
      ),
      1,
    )
  },
)

browserTest(
  'phone zoom sends during a continuous drag and coalesces in-flight fractional targets into the final value',
  async t => {
    const page = await ui(t)
    await page.getByText('机位与麦克风', { exact: true }).click()
    await page.getByRole('button', { name: '刷新镜头设置', exact: true }).click()
    await page.getByRole('button', { name: '刷新预览，点选对焦', exact: true }).click()
    const image = page.getByAltText('小米相机预览，点选对焦')
    const slider = page.getByRole('slider', { name: '小米无级变焦', exact: true })
    await slider.waitFor()
    await page.evaluate(() => (window as any).fixture.holdZoom())
    await slider.evaluate((node: HTMLInputElement) => {
      let index = 0
      const values = ['1.21', '1.38', '1.57', '1.82', '1.99', '2.12', '2.24', '2.37']
      const timer = setInterval(() => {
        node.value = values[index++]
        node.dispatchEvent(new Event('input', { bubbles: true }))
        if (index === values.length) {
          clearInterval(timer)
          node.dispatchEvent(new Event('change', { bubbles: true }))
          ;(window as any).fixture.dragDone = true
        }
      }, 100)
      setTimeout(() => {
        ;(window as any).fixture.sentDuringDrag = (window as any).fixture.calls.some(
          (call: any) => call.url === './api/xiaomi' && call.payload.action === 'zoom',
        )
      }, 650)
    })
    await page.waitForFunction(() => (window as any).fixture.dragDone)
    assert.equal(await page.evaluate(() => (window as any).fixture.sentDuringDrag), true)
    assert.equal(await image.isVisible(), true)
    assert.equal(await slider.isEnabled(), true)
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (call: any) => call.url === './api/xiaomi' && call.payload.action === 'zoom',
          ).length,
      ),
      1,
    )
    await page.evaluate(() => (window as any).fixture.finishZoom())
    await page.waitForFunction(
      () =>
        (window as any).fixture.calls.filter(
          (call: any) => call.url === './api/xiaomi' && call.payload.action === 'preview',
        ).length >= 2,
    )
    const zooms = await page.evaluate(() =>
      (window as any).fixture.calls.filter(
        (call: any) => call.url === './api/xiaomi' && call.payload.action === 'zoom',
      ),
    )
    assert.equal(zooms.length, 2)
    assert.equal(zooms[1].payload.ratio, 2.37)
    assert.equal(
      await page.getByRole('spinbutton', { name: '小米变焦倍率', exact: true }).inputValue(),
      '2.37',
    )
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (call: any) => call.url === './api/xiaomi' && call.payload.action === 'focus',
          ).length,
      ),
      0,
    )
  },
)

browserTest('phone lens writes lock other actions during the rate-limit wait', async t => {
  const page = await ui(t)
  await page.getByText('机位与麦克风', { exact: true }).click()
  await page.getByRole('button', { name: '刷新镜头设置', exact: true }).click()
  await page.getByRole('button', { name: '刷新预览，点选对焦', exact: true }).click()
  await page.getByAltText('小米相机预览，点选对焦').click({ position: { x: 30, y: 30 } })
  await page.getByText(/对焦已提交.*等待/).waitFor()
  const blocked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')]
    const autofocus = buttons.find(button => button.textContent === '自动对焦')!
    const start = buttons.find(button => button.textContent === '开启小米相机')!
    autofocus.click()
    const disabled = start.disabled
    start.click()
    return disabled
  })
  assert.equal(blocked, true)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await page.waitForTimeout(350)
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).fixture.calls.filter(
          (call: any) => call.url === './api/xiaomi' && call.payload.action === 'autofocus',
        ).length,
    ),
    0,
  )
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).fixture.calls.filter(
          (call: any) => call.url === './api/xiaomi' && call.payload.action === 'start',
        ).length,
    ),
    0,
  )
})

browserTest(
  'phone clears an in-progress focus when another client changes the observed zoom',
  async t => {
    const page = await ui(t)
    await page.getByText('机位与麦克风', { exact: true }).click()
    await page.getByRole('button', { name: '刷新镜头设置', exact: true }).click()
    await page.getByRole('button', { name: '刷新预览，点选对焦', exact: true }).click()
    const image = page.getByAltText('小米相机预览，点选对焦')
    await image.click({ position: { x: 30, y: 30 } })
    await page.getByText(/对焦已提交.*等待/).waitFor()
    const marker = page.locator('.xiaomi-focus-marker')
    assert.equal(await marker.isVisible(), true)
    await page.evaluate(() => (window as any).fixture.observedZoom(2.75))
    await page.getByRole('button', { name: '刷新镜头设置', exact: true }).click()
    await marker.waitFor({ state: 'hidden' })
    const reads = () =>
      page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (call: any) => call.url === './api/xiaomi' && call.payload.action === 'settings',
          ).length,
      )
    const observedReads = await reads()
    await page.waitForTimeout(900)
    assert.equal(await reads(), observedReads)
    assert.equal(await image.isVisible(), true)
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (call: any) => call.url === './api/xiaomi' && call.payload.action === 'focus',
          ).length,
      ),
      1,
    )
  },
)
