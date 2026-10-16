import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { chromium } from 'playwright'
import type { AssistantDeskResult } from '../shared/assistantDesk'

type FixtureWindow = Window & {
  fixture: {
    late?: AssistantDeskResult
    startRead(): void
    switchSource(reset?: boolean): Promise<void>
    finishOld(): void
  }
}

type SourceFixtureWindow = Window & {
  fixture: {
    calls: { action: string; source?: { mode: string; runId?: string } }[]
    initial: AssistantDeskResult
    save(): Promise<AssistantDeskResult>
    switchSource(): Promise<void>
    oldSave(): Promise<AssistantDeskResult>
  }
}

type ViewFixtureWindow = Window & { fixture: { show(runId?: string): void } }

const executablePath = [
  chromium.executablePath(),
  ...(process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : []),
].find(existsSync)

test('desk mutations bind the source from their controller render and cannot run before the first state', {
  skip: !executablePath && 'Chromium unavailable',
}, async t => {
  const require = createRequire(import.meta.url)
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
  const bundle = esbuild.buildSync({
    stdin: {
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';import{useAssistantDesk}from'./src/hooks/useAssistantDesk';
      let controller,oldRequest,current={provenance:{mode:'mock',runId:'run-1'},rows:[]};
      const command={action:'context-save',params:{accountId:'default',expectedRevision:0,context:{}}};
      window.fixture={calls:[],save:()=>controller.request(command),oldSave:()=>oldRequest(command),async switchSource(){oldRequest=controller.request;current={rows:[]};await controller.refresh()}};
      window.ipcRenderer={invoke:async(channel,command,source)=>{
        if(channel==='platform-session:request')return{ok:true,data:{loginStatus:'closed'}};
        window.fixture.calls.push({action:command.action,source});
        if(command.action==='state')return{ok:true,data:structuredClone(current)};
        return{ok:true,data:{}};
      }};
      function App(){controller=useAssistantDesk('default');React.useEffect(()=>{window.fixture.initial=controller.request(command)},[]);return React.createElement('p',{},controller.state?.provenance?.runId|| (controller.state?'real':'loading'))}
      createRoot(document.getElementById('root')).render(React.createElement(App));
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
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByText('run-1', { exact: true }).waitFor()
  const initial = await page.evaluate(() => (window as SourceFixtureWindow).fixture.initial)
  assert.ok(!initial.ok)
  assert.equal(initial.error.code, 'ASSISTANT_SOURCE_CHANGED')
  assert.equal(
    await page.evaluate(
      () =>
        (window as SourceFixtureWindow).fixture.calls.filter(call => call.action === 'context-save')
          .length,
    ),
    0,
  )
  await page.evaluate(() => (window as SourceFixtureWindow).fixture.save())
  await page.evaluate(() => (window as SourceFixtureWindow).fixture.switchSource())
  await page.getByText('real', { exact: true }).waitFor()
  await page.evaluate(() => (window as SourceFixtureWindow).fixture.oldSave())
  await page.evaluate(() => (window as SourceFixtureWindow).fixture.save())
  const saves = await page.evaluate(() =>
    (window as SourceFixtureWindow).fixture.calls.filter(call => call.action === 'context-save'),
  )
  assert.deepEqual(
    saves.map(call => call.source),
    [{ mode: 'mock', runId: 'run-1' }, { mode: 'mock', runId: 'run-1' }, { mode: 'real' }],
  )
  assert.ok(
    (
      await page.evaluate(() =>
        (window as SourceFixtureWindow).fixture.calls.filter(call => call.action === 'state'),
      )
    ).every(call => call.source === undefined),
  )
})

test('changing the selected source clears old desk state and rejects a late read from the previous source', {
  skip: !executablePath && 'Chromium unavailable',
}, async t => {
  const require = createRequire(import.meta.url)
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
  const bundle = esbuild.buildSync({
    stdin: {
      contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{useAssistantDesk}from'./src/hooks/useAssistantDesk';
    let current={rows:[{id:'real-row'}]},controller,finish,run=0;
    window.ipcRenderer={invoke:async(channel,command)=>{
      if(channel==='platform-session:request')return{ok:true,data:{loginStatus:'closed'}};
      if(command.action==='state')return{ok:true,data:structuredClone(current)};
      if(command.action==='timeline')return new Promise(resolve=>finish=resolve);
      throw Error('unexpected command');
    }};
    window.fixture={late:undefined,startRead(){window.fixture.late=undefined;controller.request({action:'timeline',params:{accountId:'default'}}).then(value=>window.fixture.late=value)},
      async switchSource(reset=true){current={provenance:{mode:'mock',runId:'new-run-'+(++run)},rows:[{id:'mock-row'}]};if(reset)controller.resetSource();await controller.refresh()},
      finishOld(){finish({ok:true,data:[{id:'real-history'}]})}};
    function App(){controller=useAssistantDesk('default');return React.createElement('div',{},(controller.state?.rows||[]).map(row=>React.createElement('p',{key:row.id},row.id)))}
    createRoot(document.getElementById('root')).render(React.createElement(App));
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
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByText('real-row', { exact: true }).waitFor()
  await page.evaluate(() => (window as FixtureWindow).fixture.startRead())
  await page.evaluate(() => (window as FixtureWindow).fixture.switchSource())
  await page.getByText('mock-row', { exact: true }).waitFor()
  assert.equal(await page.getByText('real-row', { exact: true }).count(), 0)
  await page.evaluate(() => (window as FixtureWindow).fixture.finishOld())
  await page.waitForFunction(() => (window as FixtureWindow).fixture.late)
  const late = await page.evaluate(() => (window as FixtureWindow).fixture.late)
  assert.ok(late && !late.ok)
  assert.equal(late.error.code, 'ASSISTANT_SOURCE_CHANGED')
  await page.evaluate(() => (window as FixtureWindow).fixture.startRead())
  await page.evaluate(() => (window as FixtureWindow).fixture.switchSource(false))
  await page.evaluate(() => (window as FixtureWindow).fixture.finishOld())
  await page.waitForFunction(() => (window as FixtureWindow).fixture.late)
  const changed = await page.evaluate(() => (window as FixtureWindow).fixture.late)
  assert.ok(changed && !changed.ok)
  assert.equal(changed.error.code, 'ASSISTANT_SOURCE_CHANGED')
})

test('the real desk view drops loaded policy and unsaved editor caches between mock runs and real data', {
  skip: !executablePath && 'Chromium unavailable',
}, async t => {
  const require = createRequire(import.meta.url)
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild')
  const bundle = esbuild.buildSync({
    stdin: {
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';import{AssistantDeskView}from'./src/pages/AssistantDesk/AssistantDeskView';import{defaultAssistantReplyPolicy}from'./shared/assistantReplyPolicy';
      window.ipcRenderer={invoke:async()=>{throw Error('isolated fixture')}};
      const root=createRoot(document.getElementById('root'));
      const policy=()=>({...defaultAssistantReplyPolicy(),revision:99,rules:[{id:'old-rule',enabled:true,action:'comment',mode:'manual',priority:1,knowledge:'old-loaded-policy',instructions:''}]});
      window.fixture={show(runId){const state={context:{revision:1,knowledge:'',instructions:'',targetLanguage:'en'},sessions:[],rows:[],segments:[],audience:[],room:{status:'unknown'},ai:{used:0,limit:30},health:{status:'ok',dropped:0,recoveryWarnings:0,pendingWrites:0},...(runId?{provenance:{mode:'mock',runId}}:{})};
        const controller={accountId:'default',sourceRevision:0,state,errors:[],pending:{},busy:false,request:async command=>({ok:true,data:command.action==='reply-policy-get'?policy():[]}),platformRequest:async()=>({ok:true}),refresh:async()=>{},resetSource(){},dismissError(){}};
        root.render(React.createElement(AssistantDeskView,{controller,accountName:'Fixture'}));}};
      window.fixture.show('run-1');
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
  page.setDefaultTimeout(2500)
  page.on('pageerror', error => t.diagnostic(error.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const panel = page.locator('details[aria-label="AI 回复规则设置"]')
  await panel.locator('summary').click()
  await panel.getByRole('button', { name: '读取回复规则', exact: true }).click()
  const knowledge = panel.getByRole('textbox', { name: '发言知识库', exact: true })
  await knowledge.fill('unsaved-run-1-draft')
  await page.evaluate(() => (window as ViewFixtureWindow).fixture.show('run-1'))
  assert.equal(await knowledge.inputValue(), 'unsaved-run-1-draft')
  await page.evaluate(() => (window as ViewFixtureWindow).fixture.show('run-2'))
  await panel.getByText('AI 回复规则 · 等待读取', { exact: false }).waitFor()
  assert.equal(await page.locator('textarea').filter({ hasText: 'unsaved-run-1-draft' }).count(), 0)
  await panel.locator('summary').click()
  await panel.getByRole('button', { name: '读取回复规则', exact: true }).click()
  await knowledge.fill('unsaved-run-2-draft')
  await page.evaluate(() => (window as ViewFixtureWindow).fixture.show())
  await panel.getByText('AI 回复规则 · 等待读取', { exact: false }).waitFor()
  assert.equal(await page.getByText('模拟数据 · 仅内存', { exact: true }).count(), 0)
})
