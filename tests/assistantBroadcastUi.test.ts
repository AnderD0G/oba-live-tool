import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { chromium } from 'playwright'
import type { AssistantBroadcastState } from '../shared/assistantBroadcast'

const initial: AssistantBroadcastState = {
  accountId: 'default', draftId: 'draft-1', revision: 1, chinese: '', targetLanguage: 'en', translatedText: '', useOriginal: true, finalText: '',
  roomReady: true, bindingCurrent: true, binding: { browserSessionId: 'browser-1', target: { username: 'real_shop', url: 'https://www.tiktok.com/@real_shop/live' } },
  translation: { status: 'idle' }, delivery: { status: 'idle' }, canSend: false,
}

async function fixture(t: TestContext, state = initial) {
  const require = createRequire(import.meta.url)
  const viteRequire = createRequire(require.resolve('vite/package.json'))
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-broadcast-ui-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const outfile = path.join(folder, 'ui.js')
  viteRequire('esbuild').buildSync({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BroadcastComposer } from './src/pages/AssistantDesk/BroadcastComposer';
      const calls = [], voices = [];
      let finishTranslation, finishSend, rejectSend, count = 0;
      if (!crypto.randomUUID) crypto.randomUUID = () => 'request-' + (++count);
      const ready = state => { const locked = ['sent','sending','unconfirmed'].includes(state.delivery.status); return !locked && state.roomReady && state.bindingCurrent && !!state.finalText.trim(); };
      window.fixture = { calls, voices, current: ${JSON.stringify(state)},
        translated(text) { const s = this.current; this.current = { ...s, revision:s.revision+1, translatedRevision:s.revision+1, translatedText:text, finalText:text, canSend:true, translation:{status:'ready'} }; finishTranslation({ok:true,data:this.current}); },
        sent() { this.current = {...this.current,delivery:{status:'sent',sentAt:Date.now()},canSend:false}; finishSend({ok:true,data:this.current}); },
        unknown() { this.current = {...this.current,delivery:{status:'unconfirmed',error:'发送结果待确认'},canSend:false}; rejectSend(Error('response lost')); },
        changeRoom() { this.current = {...this.current,bindingCurrent:false,canSend:false}; }
      };
      window.ipcRenderer = { async invoke(channel, command) {
        voices.push({channel,command});
        return { ok:true, data:{ rowId:command.rowId, status:{start:'recording',stop:'stopped',cancel:'cancelled'}[command.action], ...(command.action==='stop'?{text:'请看这个款式'}:{}) } };
      } };
      const request = async command => {
        calls.push(command);
        const s = window.fixture.current;
        if (command.action === 'state') {
          if (window.fixture.holdRead) return new Promise(resolve => { window.fixture.finishRead = () => resolve({ok:true,data:{...s}}); });
          return {ok:true,data:{...s}};
        }
        if (command.action === 'edit') {
          if (command.expectedRevision !== s.revision || command.draftId !== s.draftId) return {ok:false,error:{code:'BROADCAST_CHANGED',message:'草稿已改变'}};
          const p = command.patch;
          let next = {...s,...p,revision:s.revision+1};
          if (p.chinese !== undefined && p.chinese !== s.chinese || p.targetLanguage !== undefined && p.targetLanguage !== s.targetLanguage) next = {...next,translatedText:'',translatedRevision:undefined,translation:{status:'idle'}};
          if (p.translatedText !== undefined && p.translatedText !== s.translatedText) next = {...next,translatedText:p.translatedText,translatedRevision:next.revision,translation:{status:'ready'}};
          next.finalText = next.useOriginal ? next.chinese : next.translatedText;
          next.canSend = ready(next);
          window.fixture.current = next;
          return {ok:true,data:next};
        }
        if (command.action === 'translate') return new Promise(resolve => { finishTranslation = resolve; });
        if (command.action === 'send') return new Promise((resolve,reject) => { finishSend = resolve; rejectSend = reject; });
        if (command.action === 'clear') {
          window.fixture.current = {...${JSON.stringify(initial)}, draftId:'draft-2', binding:{browserSessionId:'browser-2',target:{username:'new_shop',url:'https://www.tiktok.com/@new_shop/live'}}};
          return {ok:true,data:window.fixture.current};
        }
        throw Error('unexpected command');
      };
      createRoot(document.getElementById('root')).render(React.createElement(BroadcastComposer, { accountId:'default', request }));
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
  await page.getByText('自由发言', { exact: true }).click()
  await page.getByText('@real_shop', { exact: true }).waitFor()
  return page
}

test('free speech starts with original text and sends only after the explicit current-room click', async t => {
  const page = await fixture(t)
  assert.equal(await page.getByLabel('自由发言语言').inputValue(), 'original')
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.every((call: any) => call.action === 'state')), true)
  await page.getByLabel('自由发言中文草稿').fill('大家看看这个新款')
  const send = page.getByRole('button', { name: '发送到当前直播间', exact: true })
  await send.click()
  const commands = await page.evaluate(() => (window as any).fixture.calls)
  const writes = commands.filter((command: any) => command.action === 'send')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].draftId, 'draft-1')
  assert.equal(writes[0].expectedText, '大家看看这个新款')
  assert.equal(writes[0].accountId, 'default')
  assert.equal(commands.some((command: any) => command.action === 'translate'), false)
  assert.equal(Object.hasOwn(writes[0], 'rowId'), false)
  await page.evaluate(() => (window as any).fixture.sent())
  await page.getByText(/已发送到直播间/).waitFor()
  assert.equal(await send.isDisabled(), true)
})

test('translation produces an editable preview and never sends it automatically', async t => {
  const page = await fixture(t)
  await page.getByLabel('自由发言中文草稿').fill('欢迎大家')
  await page.getByLabel('自由发言语言').selectOption('en')
  const send = page.getByRole('button', { name: '发送到当前直播间', exact: true })
  assert.equal(await send.isDisabled(), true)
  await page.getByRole('button', { name: '翻译并预览', exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.some((call: any) => call.action === 'send')), false)
  await page.evaluate(() => (window as any).fixture.translated('Welcome everyone'))
  await page.getByLabel('自由发言发送预览').fill('Welcome, take a look!')
  assert.equal(await page.getByLabel('自由发言中文草稿').inputValue(), '欢迎大家')
  await send.click()
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.find((call: any) => call.action === 'send').expectedText), 'Welcome, take a look!')
})

test('a room change disables the old draft until the operator explicitly creates a new one', async t => {
  const page = await fixture(t)
  await page.getByLabel('自由发言中文草稿').fill('上一间直播间草稿')
  await page.getByRole('button', { name: '刷新发言状态', exact: true }).click()
  await page.evaluate(() => (window as any).fixture.changeRoom())
  await page.getByRole('button', { name: '刷新发言状态', exact: true }).click()
  await page.getByText(/直播间已变化/).waitFor()
  assert.equal(await page.getByRole('button', { name: '发送到当前直播间', exact: true }).isDisabled(), true)
  assert.equal(await page.getByLabel('自由发言中文草稿').inputValue(), '上一间直播间草稿')
  await page.getByRole('button', { name: '为当前直播间新建草稿', exact: true }).click()
  await page.getByText('@new_shop', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('自由发言中文草稿').inputValue(), '')
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.some((call: any) => call.action === 'send')), false)
})

test('an uncertain public send stays locked and cannot become a second send on refresh', async t => {
  const page = await fixture(t)
  await page.getByLabel('自由发言中文草稿').fill('看一下这个颜色')
  const send = page.getByRole('button', { name: '发送到当前直播间', exact: true })
  await send.click()
  await page.evaluate(() => (window as any).fixture.unknown())
  await page.getByText(/发送结果待确认/).first().waitFor()
  await page.getByRole('button', { name: '刷新发言状态', exact: true }).click()
  assert.equal(await send.isDisabled(), true)
  assert.equal(await page.getByLabel('自由发言中文草稿').isDisabled(), true)
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.action === 'send').length), 1)
})

test('broadcast dictation uses its draft owner and only fills Chinese without translating or sending', async t => {
  const page = await fixture(t)
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.getByRole('button', { name: '结束并填入草稿', exact: true }).click()
  await page.waitForFunction(() => (document.querySelector('[aria-label="自由发言中文草稿"]') as HTMLTextAreaElement)?.value === '请看这个款式')
  const voices = await page.evaluate(() => (window as any).fixture.voices)
  assert.deepEqual(voices.map((voice: any) => voice.command), [
    { action: 'start', accountId: 'default', rowId: 'broadcast:draft-1' },
    { action: 'stop', accountId: 'default', rowId: 'broadcast:draft-1' },
  ])
  assert.equal(voices.every((voice: any) => voice.channel === 'assistant-voice:request'), true)
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.some((call: any) => ['send', 'translate'].includes(call.action))), false)
})

test('a delayed status response cannot replace a newer edited broadcast draft', async t => {
  const page = await fixture(t)
  await page.evaluate(() => { (window as any).fixture.holdRead = true })
  await page.getByRole('button', { name: '刷新发言状态', exact: true }).click()
  await page.getByLabel('自由发言中文草稿').fill('这是刚刚修改的新文字')
  await page.waitForFunction(() => (window as any).fixture.current.revision === 2)
  await page.evaluate(() => (window as any).fixture.finishRead())
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.getByLabel('自由发言中文草稿').inputValue(), '这是刚刚修改的新文字')
  await page.getByRole('button', { name: '发送到当前直播间', exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).fixture.calls.find((call: any) => call.action === 'send').expectedRevision), 2)
})

test('reopening free speech refreshes the actual room before re-enabling an old draft', async t => {
  const page = await fixture(t)
  await page.getByLabel('自由发言中文草稿').fill('保留的草稿')
  await page.waitForFunction(() => (window as any).fixture.current.revision === 2)
  await page.getByText('自由发言', { exact: true }).click()
  await page.evaluate(() => (window as any).fixture.changeRoom())
  await page.getByText('自由发言', { exact: true }).click()
  await page.getByText(/直播间已变化/).waitFor()
  assert.equal(await page.getByRole('button', { name: '发送到当前直播间', exact: true }).isDisabled(), true)
  assert.equal(await page.getByLabel('自由发言中文草稿').inputValue(), '保留的草稿')
})

test('the full assistant view keeps exactly one broadcast composer across repeated state polls', async t => {
  const require = createRequire(import.meta.url)
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
  const bundle = esbuild.buildSync({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {AssistantDeskView} from './src/pages/AssistantDesk/AssistantDeskView';
      const root = createRoot(document.getElementById('root'));
      let polls = 0;
      window.ipcRenderer = { async invoke(channel) {
        if (channel === 'assistant-broadcast:request') return {ok:true,data:${JSON.stringify(initial)}};
        throw Error('isolated full-view fixture');
      }};
      window.fixture = { poll() {
        const state = polls++ ? { context:{revision:1,knowledge:'',instructions:'',targetLanguage:'en'}, sessions:[],rows:[],segments:[],audience:[],room:{status:'unknown'},ai:{used:0,limit:30},health:{status:'ok',dropped:0,recoveryWarnings:0,pendingWrites:0} } : undefined;
        const controller = {accountId:'default',sourceRevision:0,state,errors:[],pending:{},busy:false,request:async()=>({ok:true,data:[]}),platformRequest:async()=>({ok:true}),refresh:async()=>{},resetSource(){},dismissError(){}};
        root.render(React.createElement(AssistantDeskView,{controller,accountName:'Fixture'}));
      }};
      window.fixture.poll();
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent',
  })
  const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const composers = page.locator('details[aria-label="自由发言"]')
  await composers.waitFor()
  for (let poll = 0; poll < 6; poll++) {
    await page.evaluate(() => (window as any).fixture.poll())
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await composers.count(), 1, `state poll ${poll + 1} must preserve exactly one composer`)
  }
  assert.equal(await page.getByRole('region', { name: '历史与片段复盘', exact: true }).count(), 1)
  assert.deepEqual(errors, [])
})
