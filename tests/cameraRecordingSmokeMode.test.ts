import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

/** Run the actual smoke script against isolated filesystem/Electron boundaries. */
async function smoke(mode: 'preview' | 'duplicate' | 'full') {
  const program = `
    import assert from 'node:assert/strict';
    import * as vm from 'node:vm';
    import * as path from 'node:path';
    import {readFile} from 'node:fs/promises';
    import {promisify} from 'node:util';
    const mode = ${JSON.stringify(mode)};
    const writes = [], reads = [], calls = [], logs = [];
    let closed = false, removed = false, clock = 0, checks = 0;
    const profile = '/tmp/oba-camera-recording-smoke-fixture';
    let draft = {draftId:'draft-1',revision:0,chinese:'',finalText:'',delivery:{status:'idle'},useOriginal:true};
    const textbox = {async fill(text) {draft={...draft,revision:1,chinese:text,finalText:text};},async waitFor(){}};
    const summary = {async count(){return 1;},async click(){}};
    const composer = {async count(){checks++;return mode==='duplicate'?2:1;},locator(selector){assert.equal(selector,':scope > summary');return summary;},getByRole(role){assert.equal(role,'textbox');return textbox;}};
    const workspace = {async count(){return 1;},getByRole(){return{async waitFor(){}};},locator(selector){assert.equal(selector,':scope > details[aria-label="自由发言"]');return composer;}};
    const page = {async waitForLoadState(){},async waitForFunction(fn){assert.ok(fn());},getByRole(){return{async waitFor(){}};},locator(selector){assert.equal(selector,'main.assistant-desk');return workspace;},async evaluate(fn,arg){return fn(arg);}};
    const application = {async evaluate(fn){return fn({app:{getVersion:()=> 'fixture-60',isPackaged:true,getPath:()=>profile}});},async firstWindow(){return page;},async close(){closed=true;}};
    const context = vm.createContext({
      process:{argv:['node','smoke',...(mode==='full'?[]:['--preview-only']),'/fixture/executable','/fixture/source','/fixture/receipts'],env:{}},
      console:{log:value=>logs.push(JSON.parse(value))},
      Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;queueMicrotask(fn);},
      window:{ipcRenderer:{async invoke(channel,command){
        calls.push({channel,action:command.action});
        if(channel==='obsEffect:request') throw Error('DEFAULT_FULL_CAMERA_STATUS');
        assert.equal(channel,'assistant-broadcast:request');
        assert.ok(['state','clear'].includes(command.action));
        if(command.action==='clear')draft={...draft,draftId:'draft-2',revision:0,chinese:'',finalText:''};
        return {ok:true,data:structuredClone(draft)};
      }}}
    });
    const exports = new Map([
      ['node:assert/strict',{default:assert}],
      ['node:child_process',{execFile(){throw Error('No external processes permitted');}}],
      ['node:fs/promises',{chmod:async()=>{},mkdtemp:async()=>profile,realpath:async value=>value,rm:async()=>{removed=true;},
        readFile:async filename=>{reads.push(filename);return '{"url":"ws://live-observable:4455","password":"fixture-secret"}';},
        writeFile:async(filename,content)=>{writes.push({filename,content:JSON.parse(content)});}}],
      ['node:os',{tmpdir:()=>'/tmp'}],
      ['node:path',{isAbsolute:path.isAbsolute,join:path.join,relative:path.relative,resolve:path.resolve}],
      ['node:util',{promisify}],
      ['playwright',{_electron:{async launch(){return application;}}}]
    ]);
    const source=await readFile('scripts/smoke-desktop-camera-recording.mjs','utf8');
    const module = new vm.SourceTextModule(source,{context});
    await module.link(async specifier=>{
      const values=exports.get(specifier);assert.ok(values,'Unexpected module '+specifier);
      return new vm.SyntheticModule(Object.keys(values),function(){for(const[key,value]of Object.entries(values))this.setExport(key,value);},{context});
    });
    let error;
    try{await module.evaluate();}catch(cause){error=cause.message;}
    console.log(JSON.stringify({writes,reads,calls,logs,closed,removed,checks,error}));
  `
  const result = await promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', program], { cwd: process.cwd(), maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout) as {
    writes: { filename: string; content: Record<string, unknown> }[]
    reads: string[]
    calls: { channel: string; action: string }[]
    logs: Record<string, unknown>[]
    closed: boolean
    removed: boolean
    checks: number
    error?: string
  }
}

test('preview-only smoke never reads OBS credentials or requests a live operation, including cleanup', async () => {
  const result = await smoke('preview')
  assert.equal(result.error, undefined)
  assert.deepEqual(result.reads, [])
  assert.equal(result.writes.find(write => write.filename.endsWith('obs-enter-effect.json'))?.content.url, 'ws://127.0.0.1:1')
  assert.equal(result.writes.find(write => write.filename.endsWith('obs-enter-effect.json'))?.content.password, '')
  assert.ok(result.calls.every(call => call.channel === 'assistant-broadcast:request' && ['state', 'clear'].includes(call.action)))
  assert.ok(result.checks >= 30, 'uniqueness must be observed through the two state-poll intervals')
  assert.equal(result.logs[0].previewOnly, true)
  assert.equal(result.logs[0].publicSends, false)
  assert.equal(result.logs[0].obsConnection, 'disabled')
  assert.equal(result.closed && result.removed, true)
})

test('smoke rejects duplicate composers before touching a draft or entering the recording flow', async () => {
  const result = await smoke('duplicate')
  assert.match(result.error ?? '', /State polling must preserve exactly one freeform composer/)
  assert.deepEqual(result.calls, [])
  assert.equal(result.closed && result.removed, true)
})

test('the default smoke still copies its OBS configuration and enters full recording acceptance', async () => {
  const result = await smoke('full')
  assert.match(result.error ?? '', /DEFAULT_FULL_CAMERA_STATUS/)
  assert.deepEqual(result.reads, ['/fixture/source/obs-enter-effect.json', '/fixture/source/obs-camera.json'])
  assert.deepEqual(result.calls.at(-1), { channel: 'obsEffect:request', action: 'camera-status' })
  assert.equal(result.logs.length, 0)
  assert.equal(result.closed && result.removed, true)
})
