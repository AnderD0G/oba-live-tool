import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { chromium } from 'playwright'

const executablePath = [
  chromium.executablePath(),
  ...(process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : []),
].find(existsSync)
const browserTest = (name: string, run: (t: TestContext) => Promise<void>) =>
  test(name, { skip: !executablePath && 'Chromium is unavailable' }, run)
type MockWindow = Window & {
  fixture: {
    calls: Array<{ action: string; batch?: { name: string }; playLocalEffects?: boolean }>
    refreshed: string[]
    stored: string[]
    copied: string[]
  }
}

async function fixture(t: TestContext) {
  const require = createRequire(import.meta.url)
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
  const bundle = esbuild.buildSync({
    stdin: {
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MockAssistantPanel} from './src/pages/AssistantDesk/MockAssistantPanel';
    const runtime={accountId:'default',selected:false,phase:'idle',volatile:true,emitted:0};
    let access={active:false,accountId:'default',urls:[]};
    window.fixture={calls:[],refreshed:[],stored:[],copied:[]};
    Storage.prototype.setItem=function(key,value){window.fixture.stored.push(key)};
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.fixture.copied.push(text)}});
    window.ipcRenderer={invoke:async(channel,command)=>{
      if(channel!=='mock-assistant:request')throw Error('Unexpected channel');
      window.fixture.calls.push(command);
      if(command.action==='prepare') {runtime.phase='prepared';runtime.batch={name:command.batch.name,batchId:'batch1',metadataRevision:'a'.repeat(64),userCount:2,eventCount:3,durationMs:1000};}
      if(command.action==='start'){runtime.phase='running';runtime.selected=true;runtime.runId='run1';}
      if(command.action==='stop')runtime.phase='stopped';
      if(command.action==='clear'){runtime.phase='idle';runtime.selected=false;delete runtime.batch;delete runtime.runId;}
      if(command.action==='leave')runtime.selected=false;
      if(command.action==='api-start')access={active:true,accountId:'default',urls:['http://127.0.0.1:19999'],token:'local-worker-secret'};
      if(command.action==='api-stop')access={active:false,accountId:'default',urls:[]};
      if(command.action==='metadata')return{ok:true,data:{version:1,scope:'mock',accountId:'default',metadataRevision:'a'.repeat(64),catalog:{},policy:{},example:{name:'example'}}};
      return{ok:true,data:structuredClone({runtime,access})};
    }};
    createRoot(document.getElementById('root')).render(React.createElement(MockAssistantPanel,{accountId:'default',realCaptureActive:false,onChanged:async action=>window.fixture.refreshed.push(action)}));
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
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.abort())
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByText('模拟数据实验室', { exact: true }).waitFor()
  t.after(() => assert.deepEqual(errors, []))
  return page
}

browserTest(
  'mock controls start collapsed, never enable the API implicitly, and reveal credentials only while expanded',
  async t => {
    const page = await fixture(t)
    assert.equal(await page.locator('details').getAttribute('open'), null)
    assert.equal(await page.getByText('local-worker-secret', { exact: true }).count(), 0)
    await page.getByText('模拟数据实验室', { exact: true }).click()
    await page.getByRole('button', { name: '开启 Worker API', exact: true }).click()
    await page.getByText('local-worker-secret', { exact: true }).waitFor()
    assert.equal(await page.locator('a[href*="local-worker-secret"]').count(), 0)
    await page.getByRole('button', { name: '复制访问令牌', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as MockWindow).fixture.copied), [
      'local-worker-secret',
    ])
    await page.getByText('模拟数据实验室', { exact: true }).click()
    await page.getByText('local-worker-secret', { exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.getByText('local-worker-secret', { exact: true }).count(), 0)
    assert.deepEqual(
      await page.evaluate(
        () =>
          (window as MockWindow).fixture.calls.filter(call => call.action === 'api-start').length,
      ),
      1,
    )
  },
)

browserTest(
  'JSON import only prepares a memory batch; start stop clear and leave remain explicit and refresh the desk',
  async t => {
    const page = await fixture(t)
    await page.getByText('模拟数据实验室', { exact: true }).click()
    await page.getByLabel('导入模拟 JSON').setInputFiles({
      name: 'batch.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ name: '仅内存测试批次' })),
    })
    await page.getByText(/仅内存测试批次.*2 位观众.*3 个事件/).waitFor()
    assert.equal(
      await page.evaluate(() =>
        (window as MockWindow).fixture.calls.some(call => call.action === 'start'),
      ),
      false,
    )
    const effects = page.getByRole('checkbox', { name: '模拟时播放 OBS 本地特效' })
    assert.equal(await effects.isChecked(), true)
    await effects.uncheck()
    for (const [name, action] of [
      ['开始模拟', 'start'],
      ['停止模拟', 'stop'],
      ['退出模拟', 'leave'],
      ['清空模拟数据', 'clear'],
    ]) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.waitForFunction(
        value => (window as MockWindow).fixture.refreshed.includes(value),
        action,
      )
    }
    assert.deepEqual(await page.evaluate(() => (window as MockWindow).fixture.refreshed), [
      'prepare',
      'start',
      'stop',
      'leave',
      'clear',
    ])
    assert.equal(
      await page.evaluate(
        () =>
          (window as MockWindow).fixture.calls.find(call => call.action === 'start')
            ?.playLocalEffects,
      ),
      false,
    )
    assert.deepEqual(await page.evaluate(() => (window as MockWindow).fixture.stored), [])
  },
)

browserTest(
  'oversized and malformed JSON are rejected locally without preparing or persisting a batch',
  async t => {
    const page = await fixture(t)
    await page.getByText('模拟数据实验室', { exact: true }).click()
    const input = page.getByLabel('导入模拟 JSON')
    await input.setInputFiles({
      name: 'too-large.json',
      mimeType: 'application/json',
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 32),
    })
    await page.getByRole('alert').getByText(/2MB/).waitFor()
    await input.setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{bad json'),
    })
    await page
      .getByRole('alert')
      .getByText(/JSON 格式/)
      .waitFor()
    assert.equal(
      await page.evaluate(() =>
        (window as MockWindow).fixture.calls.some(call => call.action === 'prepare'),
      ),
      false,
    )
    assert.equal(
      await page.evaluate(() =>
        (window as MockWindow).fixture.calls.some(call => call.action === 'start'),
      ),
      false,
    )
    assert.deepEqual(await page.evaluate(() => (window as MockWindow).fixture.stored), [])
  },
)
