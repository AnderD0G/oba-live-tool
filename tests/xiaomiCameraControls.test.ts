import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { chromium } from 'playwright'

type FixtureWindow = Window & {
  fixture: {
    calls: string[]
    counts: { status: number; settings: number }
    holdLatest: boolean
    releaseInitial(): void
    releaseLatest(): void
    pausePreview: boolean
    focusCommands: Array<{ x: number; y: number; previewId: string; at: number }>
    zoomCommands: Array<{ ratio: number; at: number }>
    resolveFocus(): void
    resolveNextZoom(): void
    setFocusOutcome(result: string): void
    advanceClock(ms: number): void
    setObservedZoom(ratio: number): void
  }
}

const executablePath = [
  chromium.executablePath(),
  ...(process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : []),
].find(existsSync)
const browserTest = (name: string, run: (t: TestContext) => Promise<void>) =>
  test(name, { skip: !executablePath && 'Playwright Chromium/Chrome is not installed' }, run)

let bundle: string | undefined
function fixtureBundle() {
  if (bundle) return bundle
  const require = createRequire(import.meta.url)
  const viteRequire = createRequire(require.resolve('vite/package.json'))
  const result = viteRequire('esbuild').buildSync({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { XiaomiCameraControls } from './src/pages/AssistantDesk/XiaomiCameraControls';
        const calls = [];
        const counts = { status: 0, settings: 0 };
        const initial = [];
        const latest = [];
        const lensMode = window.xiaomiFixtureMode === 'lens';
        const lens = { available: true, zoom: 2, observed_zoom: 2, saved_zoom: 2, zoom_min: 1, zoom_max: 10,
          focus_supported: true, focus_pending: false, last_focus_result: 'focused', timestamp_ms: Date.now() };
        let finishFocus;
        const zoomWaiters = [];
        const focusCommands = [], zoomCommands = [];
        const realNow = Date.now; let clockOffset = 0;
        Date.now = () => realNow() + clockOffset;
        const timestamp = '2026-10-16T06:30:00Z';
        window.fixture = {
          calls, counts, holdLatest: false, pausePreview: false, focusCommands, zoomCommands,
          advanceClock(ms) { clockOffset += ms; },
          setObservedZoom(ratio) { Object.assign(lens, { zoom: ratio, observed_zoom: ratio }); },
          releaseInitial() { for (const resolve of initial.splice(0)) resolve(); },
          releaseLatest() { window.fixture.holdLatest = false; for (const resolve of latest.splice(0)) resolve(); },
          resolveFocus() {
            Object.assign(lens, { focus_pending: true, last_focus_result: 'pending', timestamp_ms: Date.now() });
            finishFocus({ ok: true, operation: { success: true, applied: true, focus_submitted: true }, settings: { ...lens } });
          },
          resolveNextZoom() {
            const next = zoomWaiters.shift();
            Object.assign(lens, { zoom: next.ratio, observed_zoom: next.ratio, saved_zoom: next.ratio });
            next.resolve({ ok: true, operation: { success: true, applied: true, saved: true }, settings: { ...lens } });
          },
          setFocusOutcome(result) { Object.assign(lens, { focus_pending: result === 'pending', last_focus_result: result, timestamp_ms: Date.now() }); }
        };
        window.ipcRenderer = { async invoke(channel, command) {
          if (channel !== 'xiaomi-camera:request') throw Error('unexpected channel');
          calls.push(command.action);
          if (command.action === 'config-get') return { ok: true, config: { baseUrl: 'http://192.168.1.5:18765', hasToken: true } };
          if (command.action === 'status' || command.action === 'settings') {
            const count = ++counts[command.action];
            if (lensMode) return command.action === 'status' ? { ok: true, camera: { state: 'capturing', timestamp } } : { ok: true, settings: { ...lens } };
            if (count === 1) await new Promise(resolve => initial.push(resolve));
            else if (window.fixture.holdLatest) await new Promise(resolve => latest.push(resolve));
            return command.action === 'status'
              ? { ok: true, camera: { state: count === 1 ? 'off' : 'capturing', timestamp } }
              : { ok: true, settings: { available: count !== 1, zoom: count === 1 ? 1 : 2,
                  observed_zoom: count === 1 ? 1 : 2, saved_zoom: count === 1 ? 1 : 2, focus_supported: true } };
          }
          if (lensMode && command.action === 'preview') {
            counts.preview = (counts.preview || 0) + 1;
            if (window.fixture.pausePreview) return { ok: false, error: { code: 'XIAOMI_PREVIEW_STALE', message: '等待新鲜预览' } };
            const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 640;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = counts.preview % 2 ? '#666' : '#999'; ctx.fillRect(0, 0, 360, 640);
            return { ok: true, preview: { id: 'preview-' + counts.preview, dataUrl: canvas.toDataURL('image/jpeg'), capturedAt: Date.now(), expiresAt: Date.now() + 2000 } };
          }
          if (lensMode && command.action === 'focus') { focusCommands.push({ ...command, at: Date.now() }); return new Promise(resolve => { finishFocus = resolve }); }
          if (lensMode && command.action === 'zoom') { zoomCommands.push({ ratio: command.ratio, at: Date.now() }); return new Promise(resolve => { zoomWaiters.push({ ratio: command.ratio, resolve }); }); }
          if (command.action === 'start') return { ok: false, error: {
            code: 'XIAOMI_HTTP_503', message: '相机服务未确认操作，请重新查询状态和设置', outcomeUnknown: true } };
          throw Error('fixture refuses unexpected camera commands');
        } };
        createRoot(document.getElementById('root')).render(React.createElement(XiaomiCameraControls));
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
  return bundle
}

async function fixture(t: TestContext, mode = 'refresh') {
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  // All device interactions are the local IPC fixture above, never a LAN camera.
  await page.route('**/*', route => route.abort())
  await page.setContent('<div id="root"></div>')
  await page.evaluate(value => {
    ;(window as Window & { xiaomiFixtureMode: string }).xiaomiFixtureMode = value
  }, mode)
  await page.addScriptTag({ content: fixtureBundle() })
  await page.waitForFunction(() => {
    const value = (window as FixtureWindow).fixture
    return value?.counts.status === 1 && value.counts.settings === 1
  })
  page.setDefaultTimeout(2500)
  t.after(() => assert.deepEqual(errors, []))
  return page
}

browserTest(
  'a post-write refresh waits behind the initial read and replaces unknown state with fresh status and lens data',
  async t => {
    const page = await fixture(t)
    await page.evaluate(() => {
      ;(window as FixtureWindow).fixture.holdLatest = true
    })
    await page.getByRole('button', { name: '开启小米相机', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByText('相机状态未知', { exact: true }).count(), 1)
    await page.evaluate(() => (window as FixtureWindow).fixture.releaseInitial())
    await page.waitForFunction(() => (window as FixtureWindow).fixture.counts.status === 2)
    assert.equal(await page.getByText('相机状态未知', { exact: true }).count(), 1)
    assert.equal(await page.getByText('已核验关闭', { exact: true }).count(), 0)
    assert.match(await page.locator('section').innerText(), /实际倍率：未观测；下次启动：未确认/)
    await page.evaluate(() => (window as FixtureWindow).fixture.releaseLatest())
    await page.getByText('已连接视频消费者', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('变焦倍率', { exact: true }).inputValue(), '2.00')
    assert.match(await page.locator('section').innerText(), /实际倍率：2.00；下次启动：2.00/)
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as FixtureWindow).fixture.calls), [
      'config-get',
      'status',
      'settings',
      'start',
      'status',
      'settings',
    ])
  },
)

async function lensFixture(t: TestContext) {
  const page = await fixture(t, 'lens')
  await page.getByRole('button', { name: '打开操作预览', exact: true }).click()
  await page.getByRole('img', { name: '小米相机竖屏操作预览', exact: true }).waitFor()
  await page.waitForFunction(() => {
    const img = document.querySelector('img')
    return img && img.naturalWidth === 360
  })
  return page
}

async function captureFixture(page: Awaited<ReturnType<typeof fixture>>, name: string) {
  const directory = process.env.XIAOMI_FIXTURE_SCREENSHOTS
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.locator('section').screenshot({ path: path.join(directory, `${name}.png`) })
}

browserTest(
  'point focus preserves the image and yellow marker until a real phone result changes its status',
  async t => {
    const page = await lensFixture(t)
    await page.evaluate(() => {
      ;(window as FixtureWindow).fixture.pausePreview = true
    })
    const img = page.getByRole('img', { name: '小米相机竖屏操作预览', exact: true })
    await img.click({ position: { x: 90, y: 480 } })
    const marker = page.getByRole('img', { name: '点按对焦位置', exact: true })
    await marker.waitFor()
    assert.equal(await img.isVisible(), true)
    assert.equal(
      await marker.evaluate(node => (node as HTMLElement).style.borderColor),
      'rgb(250, 204, 21)',
    )
    assert.equal(await marker.evaluate(node => (node as HTMLElement).style.left), '25%')
    assert.equal(await marker.evaluate(node => (node as HTMLElement).style.top), '75%')
    await page.getByText('正在提交选点对焦…', { exact: true }).waitFor()
    assert.equal(
      await page.getByText('手机已确认合焦，仍请观察主体清晰度', { exact: true }).count(),
      0,
    )
    await captureFixture(page, 'xiaomi-focus-yellow')
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveFocus())
    await page.getByText('正在对焦，等待手机结果…', { exact: true }).waitFor()
    assert.equal(await img.isVisible(), true)
    assert.equal(
      await page
        .getByRole('button', { name: '在小米新鲜预览中点按对焦', exact: true })
        .isDisabled(),
      true,
    )
    await page.evaluate(() => (window as FixtureWindow).fixture.setFocusOutcome('focused'))
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await page.getByText('手机已确认合焦，仍请观察主体清晰度', { exact: true }).waitFor()
    assert.equal(
      await marker.evaluate(node => (node as HTMLElement).style.borderColor),
      'rgb(34, 197, 94)',
    )
    await page.evaluate(() => {
      ;(window as FixtureWindow).fixture.pausePreview = false
    })
    await page.waitForFunction(
      () =>
        !(document.querySelector('[aria-label="在小米新鲜预览中点按对焦"]') as HTMLButtonElement)
          .disabled,
    )
    assert.equal(
      await marker.evaluate(node => (node as HTMLElement).style.borderColor),
      'rgb(34, 197, 94)',
    )
    await captureFixture(page, 'xiaomi-focus-green')
    assert.equal(
      await page.evaluate(() => (window as FixtureWindow).fixture.focusCommands.length),
      1,
    )
  },
)

browserTest(
  'a failed focus shows a red marker and closing the preview clears the old point',
  async t => {
    const page = await lensFixture(t)
    await page
      .getByRole('img', { name: '小米相机竖屏操作预览', exact: true })
      .click({ position: { x: 180, y: 320 } })
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveFocus())
    await page.getByText('正在对焦，等待手机结果…', { exact: true }).waitFor()
    await page.evaluate(() => (window as FixtureWindow).fixture.setFocusOutcome('not_focused'))
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await page.getByText('手机报告未合焦，请重新选点', { exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('img', { name: '点按对焦位置', exact: true })
        .evaluate(node => (node as HTMLElement).style.borderColor),
      'rgb(239, 68, 68)',
    )
    await page.getByRole('button', { name: '关闭操作预览', exact: true }).click()
    assert.equal(await page.getByRole('img', { name: '点按对焦位置', exact: true }).count(), 0)
    await page.getByRole('button', { name: '打开操作预览', exact: true }).click()
    await page.getByRole('img', { name: '小米相机竖屏操作预览', exact: true }).waitFor()
    assert.equal(await page.getByRole('img', { name: '点按对焦位置', exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as FixtureWindow).fixture.focusCommands.length),
      1,
    )
  },
)

browserTest(
  'an acknowledged focus without a phone result becomes unconfirmed without replaying the request',
  async t => {
    const page = await lensFixture(t)
    await page
      .getByRole('img', { name: '小米相机竖屏操作预览', exact: true })
      .click({ position: { x: 180, y: 320 } })
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveFocus())
    await page.getByText('正在对焦，等待手机结果…', { exact: true }).waitFor()
    await page.evaluate(() => (window as FixtureWindow).fixture.advanceClock(6500))
    await page.getByText('对焦结果未确认，请刷新状态', { exact: true }).waitFor()
    assert.equal(
      await page.getByText('手机已确认合焦，仍请观察主体清晰度', { exact: true }).count(),
      0,
    )
    assert.equal(
      await page.evaluate(() => (window as FixtureWindow).fixture.focusCommands.length),
      1,
    )
  },
)

browserTest(
  'a zoom observed from another client clears the old focus marker and disables its old image',
  async t => {
    const page = await lensFixture(t)
    await page
      .getByRole('img', { name: '小米相机竖屏操作预览', exact: true })
      .click({ position: { x: 180, y: 320 } })
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveFocus())
    await page.getByText('正在对焦，等待手机结果…', { exact: true }).waitFor()
    await page.evaluate(() => (window as FixtureWindow).fixture.setFocusOutcome('focused'))
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await page.getByText('手机已确认合焦，仍请观察主体清晰度', { exact: true }).waitFor()
    await page.evaluate(() => {
      const fixture = (window as FixtureWindow).fixture
      fixture.pausePreview = true
      fixture.setObservedZoom(3.14)
    })
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await page.waitForFunction(
      () => (document.querySelector('#xiaomi-camera-zoom') as HTMLInputElement).value === '3.14',
    )
    assert.equal(await page.getByRole('img', { name: '点按对焦位置', exact: true }).count(), 0)
    assert.equal(
      await page.getByRole('img', { name: '小米相机竖屏操作预览', exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await page
        .getByRole('button', { name: '在小米新鲜预览中点按对焦', exact: true })
        .isDisabled(),
      true,
    )
    assert.equal(
      await page.evaluate(() => (window as FixtureWindow).fixture.focusCommands.length),
      1,
    )
  },
)

browserTest(
  'continuous zoom keeps the image and slider usable while only the last decimal target follows the in-flight write',
  async t => {
    const page = await lensFixture(t)
    const slider = page.getByRole('slider', { name: '连续变焦倍率', exact: true })
    const change = (ratio: number) =>
      slider.evaluate((input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          String(value),
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, ratio)
    await change(1.23)
    await page.waitForFunction(() => (window as FixtureWindow).fixture.zoomCommands.length === 1)
    assert.equal(await slider.isEnabled(), true)
    await change(2.38)
    await change(2.67)
    assert.equal(
      await page.getByRole('img', { name: '小米相机竖屏操作预览', exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await page
        .getByRole('button', { name: '在小米新鲜预览中点按对焦', exact: true })
        .isDisabled(),
      true,
    )
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveNextZoom())
    await page.waitForFunction(() => (window as FixtureWindow).fixture.zoomCommands.length === 2)
    assert.deepEqual(
      await page.evaluate(() =>
        (window as FixtureWindow).fixture.zoomCommands.map(value => value.ratio),
      ),
      [1.23, 2.67],
    )
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveNextZoom())
    await page.getByLabel('变焦倍率', { exact: true }).waitFor()
    await page.waitForFunction(
      () => (document.querySelector('#xiaomi-camera-zoom') as HTMLInputElement).value === '2.67',
    )
    assert.equal(await slider.inputValue(), '2.67')
    await page.waitForFunction(
      () =>
        !(document.querySelector('[aria-label="在小米新鲜预览中点按对焦"]') as HTMLButtonElement)
          .disabled,
    )
    assert.equal(
      await page.evaluate(() => (window as FixtureWindow).fixture.focusCommands.length),
      0,
    )
  },
)

browserTest(
  'a zoom drag respects the write interval after point focus without replaying focus',
  async t => {
    const page = await lensFixture(t)
    await page
      .getByRole('img', { name: '小米相机竖屏操作预览', exact: true })
      .click({ position: { x: 180, y: 320 } })
    await page.evaluate(() => (window as FixtureWindow).fixture.resolveFocus())
    const slider = page.getByRole('slider', { name: '连续变焦倍率', exact: true })
    await page.waitForFunction(
      () => !(document.querySelector('#xiaomi-camera-zoom-slider') as HTMLInputElement).disabled,
    )
    await slider.evaluate(input => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '2.15')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForFunction(() => (window as FixtureWindow).fixture.zoomCommands.length === 1)
    const timing = await page.evaluate(() => {
      const fixture = (window as FixtureWindow).fixture
      return {
        focus: fixture.focusCommands[0].at,
        zoom: fixture.zoomCommands[0].at,
        focusCount: fixture.focusCommands.length,
      }
    })
    assert.ok(timing.zoom - timing.focus >= 300)
    assert.equal(timing.focusCount, 1)
    assert.equal(await page.getByRole('img', { name: '点按对焦位置', exact: true }).count(), 0)
  },
)

browserTest(
  'repeated refresh clicks coalesce into one fresh read without replaying a device write',
  async t => {
    const page = await fixture(t)
    const refresh = page.getByRole('button', { name: '刷新状态', exact: true })
    await refresh.click()
    await refresh.click()
    await page.evaluate(() => (window as FixtureWindow).fixture.releaseInitial())
    await page.getByText('已连接视频消费者', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as FixtureWindow).fixture.calls), [
      'config-get',
      'status',
      'settings',
      'status',
      'settings',
    ])
  },
)
