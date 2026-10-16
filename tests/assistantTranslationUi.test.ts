import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import type { AssistantDeskRow } from '../shared/assistantDesk'
import { AssistantMessageCard } from '../src/pages/AssistantDesk/MessageCard'

const localTranslation = { status: 'ready', source: 'local', method: 'chrome', language: 'en', chinese: '本地中文译文' } as const
const localFallback = { source: 'local', method: 'chrome', language: 'en', chinese: '本地中文译文' } as const
const manualTranslation = { sessionId: 'scene-1', maxAgeSeconds: 600, ai: { used: 0, limit: 50 }, busy: false }
const row: AssistantDeskRow = {
  id: 'comment-1', accountId: 'account-1', sessionId: 'scene-1', platform: 'tiktok',
  receivedAt: 1792123200000, sourceEventId: 'event-1', userId: 'viewer-1', audienceUuid: 'audience-1',
  nickname: 'Viewer', kind: 'comment', original: 'Hello world', translation: localTranslation,
  reply: { status: 'none' },
}
const textOf = (html: string) => html.replace(/<[^>]*>/g, '')
function render(value: AssistantDeskRow = row, update?: AssistantDeskRow) {
  let requests = 0
  const html = renderToStaticMarkup(createElement(AssistantMessageCard, {
    row: value, busy: false, manualTranslation, manualTranslationUpdate: update,
    request: async () => { requests++; return { ok: true } },
  }))
  assert.equal(requests, 0, 'rendering a comment must not request AI translation')
  return html
}

test('a successful Chrome translation still offers an explicit DeepSeek supplement without requesting it', () => {
  const html = render()
  assert.match(textOf(html), /本地中文译文/)
  assert.match(html, /<button[^>]*>[\s\S]*?DeepSeek 翻译<\/button>/)
})

test('an unknown AI result explains original retention without claiming successful translation', () => {
  const html = render({ ...row, original: '@BeefBroccoli 1q1q', translation: {
    status: 'skipped', source: 'ai', language: 'und', chinese: '@BeefBroccoli 1q1q', error: '含义不明确，保留原文',
  } })
  assert.match(textOf(html), /含义不明确，保留原文/)
  assert.doesNotMatch(textOf(html), /翻译失败|中文译文|AI译文/)
  assert.match(textOf(html), /DeepSeek 翻译/)
})

test('pending DeepSeek supplement preserves its existing local translation and source label', () => {
  const html = render({ ...row, translation: { status: 'pending', source: 'ai', fallback: localFallback } })
  assert.match(textOf(html), /本地中文译文/)
  assert.match(textOf(html), /Chrome 本地译文/)
  assert.match(textOf(html), /DeepSeek 翻译中/)
  assert.doesNotMatch(textOf(html), /AI译文/)
})

test('manual failure is a separate alert while a successful local result remains visible', () => {
  const html = render({ ...row, translation: { ...localTranslation, manualAttempt: {
    status: 'failed', message: 'DeepSeek 暂不可用，请重试',
  } } })
  assert.match(textOf(html), /本地中文译文/)
  assert.match(html, /role="alert"[^>]*>DeepSeek 暂不可用，请重试<\/p>/)
  assert.match(textOf(html), /DeepSeek 翻译/)
})

test('unknown manual supplement preserves the usable local translation with a plain explanation', () => {
  const html = render({ ...row, translation: { ...localTranslation, manualAttempt: {
    status: 'skipped', message: '含义不明确，保留原文',
  } } })
  assert.match(textOf(html), /本地中文译文/)
  assert.match(textOf(html), /含义不明确，保留本地译文/)
  assert.doesNotMatch(textOf(html), /翻译失败/)
})

test('a same-comment manual failure snapshot enriches an immutable local timeline row', () => {
  const html = render(row, { ...row, translation: { ...localTranslation, manualAttempt: {
    status: 'failed', message: '补充翻译失败，可重试',
  } } })
  assert.match(textOf(html), /补充翻译失败，可重试/)
  assert.match(textOf(html), /本地中文译文/)
})

test('manual snapshots from another scene or original comment never replace the current translation', () => {
  for (const change of [
    { id: 'comment-2' }, { sessionId: 'scene-2' }, { accountId: 'account-2' }, { platform: 'other' },
    { receivedAt: row.receivedAt + 1 }, { sourceEventId: 'event-2' }, { userId: 'viewer-2' },
    { audienceUuid: 'audience-2' }, { kind: 'event' as const }, { original: 'Different comment' },
  ]) {
    const html = render(row, { ...row, ...change, translation: { status: 'ready', source: 'ai', chinese: '不属于当前评论' } })
    assert.match(textOf(html), /本地中文译文/)
    assert.doesNotMatch(textOf(html), /不属于当前评论/)
  }
})

async function clientFixture(t: any) {
  const require = createRequire(import.meta.url)
  const viteRequire = createRequire(require.resolve('vite/package.json'))
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-translation-ui-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const outfile = path.join(folder, 'ui.js')
  viteRequire('esbuild').buildSync({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AssistantMessageCard } from './src/pages/AssistantDesk/MessageCard';
      const root = createRoot(document.getElementById('root'));
      let finish;
      const calls = [];
      window.fixture = {
        calls,
        render(row, update) { root.render(React.createElement(AssistantMessageCard, {
          row, busy: false, manualTranslation: ${JSON.stringify(manualTranslation)}, manualTranslationUpdate: update,
          request: command => { calls.push(command); return new Promise(resolve => { finish = resolve }); }
        })); },
        resolve(result) { finish(result); }
      };
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', outfile, logLevel: 'silent',
  })
  const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: await readFile(outfile, 'utf8') })
  const show = async (value: AssistantDeskRow, update?: AssistantDeskRow) => {
    await page.evaluate(({ value, update }) => (window as any).fixture.render(value, update), { value, update })
    await page.locator('article').waitFor()
  }
  await show(row)
  return { page, show }
}

test('clicking DeepSeek requests once, keeps local text while pending, then displays the manual result', async t => {
  const { page } = await clientFixture(t)
  const button = page.getByRole('button', { name: 'DeepSeek 翻译', exact: true })
  assert.equal(await button.count(), 1)
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), 0)
  await button.click()
  assert.equal(await page.getByText('本地中文译文', { exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'DeepSeek 翻译中', exact: true }).isDisabled(), true)
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [
    { action: 'translate-retry', params: { accountId: 'account-1', rowId: 'comment-1' } },
  ])
  await page.evaluate(value => (window as any).fixture.resolve({ ok: true, data: value }), {
    ...row, translation: { status: 'ready', source: 'ai', language: 'en', chinese: '补充中文译文' },
  })
  await page.getByText('补充中文译文', { exact: true }).waitFor()
  assert.equal(await page.getByText('本地中文译文', { exact: true }).count(), 0)
})

test('local fallback after a pending snapshot is retained even when later snapshots omit the row', async t => {
  const { page, show } = await clientFixture(t)
  await show(row, { ...row, translation: { status: 'pending', source: 'ai', fallback: localFallback } })
  await page.getByRole('button', { name: 'DeepSeek 翻译中', exact: true }).waitFor()
  await show(row, { ...row, translation: { ...localTranslation, manualAttempt: { status: 'failed', message: '补充结果未取得，请重试' } } })
  await page.getByRole('alert').waitFor()
  await show(row)
  assert.equal(await page.getByText('本地中文译文', { exact: true }).count(), 1)
  assert.match(await page.getByRole('alert').innerText(), /补充结果未取得/)
  assert.equal(await page.getByRole('button', { name: 'DeepSeek 翻译', exact: true }).isEnabled(), true)
})

test('a completed request for a replaced scene cannot leak its translation into the current row', async t => {
  const { page, show } = await clientFixture(t)
  const button = page.getByRole('button', { name: 'DeepSeek 翻译', exact: true })
  assert.equal(await button.count(), 1)
  await button.click()
  const next = { ...row, sessionId: 'scene-2', translation: { ...localTranslation, chinese: '下一场的本地译文' } }
  await show(next)
  await page.getByText('下一场的本地译文', { exact: true }).waitFor()
  await page.evaluate(value => (window as any).fixture.resolve({ ok: true, data: value }), {
    ...row, translation: { status: 'ready', source: 'ai', language: 'en', chinese: '上一场的迟到译文' },
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.getByText('下一场的本地译文', { exact: true }).count(), 1)
  assert.equal(await page.getByText('上一场的迟到译文', { exact: true }).count(), 0)
})

test('a final local fallback response remains visible after the timeline omits its manual attempt', async t => {
  const { page, show } = await clientFixture(t)
  await page.getByRole('button', { name: 'DeepSeek 翻译', exact: true }).click()
  await page.evaluate(value => (window as any).fixture.resolve({ ok: true, data: value }), {
    ...row, translation: { ...localTranslation, manualAttempt: { status: 'failed', message: '人工补充请求失败，请重试' } },
  })
  await page.getByRole('alert').waitFor()
  await show(row)
  assert.equal(await page.getByText('本地中文译文', { exact: true }).count(), 1)
  assert.match(await page.getByRole('alert').innerText(), /人工补充请求失败/)
  assert.equal(await page.getByRole('button', { name: 'DeepSeek 翻译', exact: true }).isEnabled(), true)
})

test('a manual response with the same row ID but different original is rejected for an AI row', async t => {
  const { page, show } = await clientFixture(t)
  const failed: AssistantDeskRow = { ...row, translation: { status: 'failed', source: 'ai', error: '原请求失败' } }
  await show(failed)
  await page.getByText('翻译失败：原请求失败', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'DeepSeek 翻译', exact: true }).click()
  await page.evaluate(value => (window as any).fixture.resolve({ ok: true, data: value }), {
    ...row, original: 'Different original', translation: { status: 'ready', source: 'ai', chinese: '错误消息的译文' },
  })
  await page.getByRole('button', { name: 'DeepSeek 翻译', exact: true }).waitFor()
  assert.equal(await page.getByText('错误消息的译文', { exact: true }).count(), 0)
  assert.equal(await page.getByText('翻译失败：原请求失败', { exact: true }).count(), 1)
})

test('an older local failure snapshot cannot replace a retained successful manual AI translation', async t => {
  const { page, show } = await clientFixture(t)
  await page.getByRole('button', { name: 'DeepSeek 翻译', exact: true }).click()
  await page.evaluate(value => (window as any).fixture.resolve({ ok: true, data: value }), {
    ...row, translation: { status: 'ready', source: 'ai', language: 'en', chinese: '已确认的 AI 中文译文' },
  })
  await page.getByText('已确认的 AI 中文译文', { exact: true }).waitFor()
  await show(row, { ...row, translation: { ...localTranslation, manualAttempt: { status: 'failed', message: '旧的失败回执' } } })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.getByText('已确认的 AI 中文译文', { exact: true }).count(), 1)
  assert.equal(await page.getByText('本地中文译文', { exact: true }).count(), 0)
  assert.equal(await page.getByText('旧的失败回执', { exact: true }).count(), 0)
})

test('an older AI interruption snapshot cannot erase a retained ready AI translation', async t => {
  const { page, show } = await clientFixture(t)
  await show(row, { ...row, translation: { status: 'ready', source: 'ai', language: 'en', chinese: '已经成功的复译' } })
  await page.getByText('已经成功的复译', { exact: true }).waitFor()
  await show(row, { ...row, translation: { status: 'interrupted', source: 'ai', error: '旧的中断快照' } })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.getByText('已经成功的复译', { exact: true }).count(), 1)
  assert.equal(await page.getByText('翻译已中断', { exact: true }).count(), 0)
})
