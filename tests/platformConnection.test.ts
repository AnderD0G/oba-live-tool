import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'

// Bundle the actual production connection code, without launching the Electron app.
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const directory = path.resolve('node_modules/.cache/oba-platform-tests')
mkdirSync(directory, { recursive: true })
const bundled = path.join(directory, 'platforms.cjs')
viteRequire('esbuild').buildSync({
  stdin: {
    contents:
      "export { connect } from './electron/main/platforms/helper'; export { DouyinPlatform } from './electron/main/platforms/douyin'; export { XiaohongshuPlatform } from './electron/main/platforms/xiaohongshu';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: bundled,
  alias: { '#/logger': path.resolve('tests/fixtures/platform-logger.ts') },
})
const { connect, DouyinPlatform, XiaohongshuPlatform } = require(bundled)
const executablePath = [
  ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap(root => [
      path.join(root as string, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(root as string, 'Google/Chrome/Application/chrome.exe'),
    ]),
].find(existsSync)

test('hidden duplicate control marker no longer stalls Douyin; refresh restores a unique action button', {
  timeout: 15000,
}, async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    let navigations = 0
    await page.route('**/*', route => {
      navigations++
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body:
          navigations === 1
            ? '<div class="goodsPanel-old" hidden><button>讲解</button></div><div class="goodsPanel-new"><button>讲解</button></div>'
            : '<div class="goodsPanel-new"><button>讲解</button></div>',
      })
    })
    const platform = new DouyinPlatform()
    assert.equal(await platform.connect({ page }), true)
    assert.equal(platform.mainPage, page)
    assert.equal(navigations, 2)
    assert.equal(await page.getByRole('button', { name: '讲解', includeHidden: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '讲解' }).isEnabled(), true)
  } finally {
    await browser.close()
  }
})

test('shared connector still detects login redirects as unauthenticated', {
  timeout: 15000,
}, async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route =>
      route.request().url().endsWith('/control')
        ? route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<script>setTimeout(() => location.replace("https://fixture.test/login"), 20)</script>',
          })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>登录</h1>' }),
    )
    assert.equal(
      await connect(page, {
        liveControlUrl: 'https://fixture.test/control',
        loginUrlRegex: /fixture\.test\/login/,
        isInLiveControlSelector: '.goodsPanel',
      }),
      false,
    )
  } finally {
    await browser.close()
  }
})

test('Xiaohongshu keeps its existing popup-based connection without an extra reload', {
  timeout: 15000,
}, async () => {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const context = await browser.newContext()
    let navigations = 0
    await context.route('**/*', route => {
      if (route.request().isNavigationRequest()) navigations++
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<div class="app-root-topbar-wrapper">千帆中控台</div>',
      })
    })
    const page = await context.newPage()
    const platform = new XiaohongshuPlatform()
    const session = { page }
    assert.equal(await platform.connect(session), true)
    await session.page.waitForSelector('.app-root-topbar-wrapper')
    assert.notEqual(session.page, page)
    assert.equal(page.isClosed(), true)
    assert.equal(navigations, 2)
  } finally {
    await browser.close()
  }
})
