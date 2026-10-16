import {useEffect,useState,useRef} from 'react'
import type {DirectorConfig,DirectorCommand,DirectorResponse} from 'shared/director'
import {assertAuthoringDraftUnchanged,hasUnrenderedCopies,type AuthoringJob,type AuthoredCopy} from 'shared/directorAuthoring'
import {INTERACTION_GOAL_ORDER,INTERACTION_GOAL_LABELS} from 'shared/interactionScript'
import {IPC_CHANNELS} from 'shared/ipcChannels'

const button='rounded border px-3 py-1.5 text-xs disabled:opacity-40'
const input='w-full rounded border bg-background p-2 text-xs'
async function request(command:DirectorCommand):Promise<DirectorResponse> {
  const response=await window.ipcRenderer.invoke(IPC_CHANNELS.director.request,command)
  if(!response.ok)throw new Error(response.error||'素材操作失败')
  return response
}
export function TargetMode({config,accountId,apply}:{config:DirectorConfig;accountId:string;apply:(config:DirectorConfig)=>void}) {
  const latestConfig=useRef(config);latestConfig.current=config
  const [job,setJob]=useState<AuthoringJob>()
  const [copies,setCopies]=useState<Record<string,AuthoredCopy>>({})
  const [gap,setGap]=useState(1.8)
  const [selected,setSelected]=useState('')
  const [frames,setFrames]=useState<Array<{at:number;url:string}>>([])
  const [audio,setAudio]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const working=job&&['preparing','rendering'].includes(job.stage)
  const item=job?.entries.find(e=>e.step.id===selected)
  const copy=item?(copies[item.step.id]??item.copy):undefined
  async function run(fn:()=>Promise<void>) {
    setBusy(true);setError('')
    try {await fn()}catch(error){setError(error instanceof Error?error.message:'操作失败')}
    finally{setBusy(false)}
  }
  function accept(next:AuthoringJob) {
    setJob(next);setSelected(next.entries[0]?.step.id??'');setFrames([]);setAudio('')
    setCopies(Object.fromEntries(next.entries.filter(e=>e.copy).map(e=>[e.step.id,e.copy!])))
  }
  useEffect(()=>{
    if(!job?.id||!working)return
    let live=true,inFlight=false
    const timer=setInterval(async()=>{
      if(inFlight)return
      inFlight=true
      try {
        const response=await request({action:'authoring-status',jobId:job.id})
        if(live&&response.authoring){
          setJob(response.authoring)
          if(response.authoring.stage==='completed')setCopies(Object.fromEntries(response.authoring.entries.filter(e=>e.copy).map(e=>[e.step.id,e.copy!])))
          if(response.authoring.stage==='prepared')setCopies(current=>({...Object.fromEntries(response.authoring!.entries.filter(e=>e.copy).map(e=>[e.step.id,e.copy!])),...current}))
        }
      }catch(error){if(live)setError(error instanceof Error?error.message:'进度读取失败')}
      finally{inFlight=false}
    },1000)
    return()=>{live=false;clearInterval(timer)}
  },[job?.id,working])
  useEffect(()=>{
    setFrames([]);setAudio('')
    if(!job?.id||!selected)return
    let live=true
    void request({action:'authoring-images',jobId:job.id,stepId:selected}).then(r=>{if(live)setFrames(r.frames??[])}).catch(()=>{})
    return()=>{live=false}
  },[job?.id,selected,item?.frames.length])
  const update=(next:AuthoredCopy)=>{if(item)setCopies(current=>({...current,[item.step.id]:next}))}
  return <details className="space-y-3 rounded border p-4">
    <summary className="cursor-pointer font-medium">素材目标模式 · 三图 → 配套文案 → Index2.5 配音</summary>
    <p className="mt-3 text-xs text-muted-foreground">离线制作，不开播、不覆盖原视频。用 DeepSeek Flash 看实际截图；逐句合成后测量，精确留下整句替换和静音插入窗口。确认后仅应用到本页草稿，还需正常保存。</p>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label>句间停顿 <input className="w-16 rounded border bg-background p-1" type="number" min={.8} max={4} step={.1} value={gap} disabled={!!working||busy} onChange={e=>setGap(Number(e.target.value))}/> 秒</label>
      <button type="button" className={button} disabled={!!working||busy} onClick={()=>run(async()=>{
        const response=await request({action:'authoring-prepare',config,accountId,options:{gapSeconds:gap}})
        if(response.authoring)accept(response.authoring)
      })}>1. 截三图并生成文案</button>
      <button type="button" className={button} disabled={!!working||busy} onClick={()=>run(async()=>{
        const response=await request({action:'authoring-import'});if(response.authoring)accept(response.authoring)
      })}>导入已有素材任务</button>
      {working&&<button type="button" className={button} onClick={()=>run(async()=>{
        const response=await request({action:'authoring-cancel',jobId:job!.id});if(response.authoring)setJob(response.authoring)
      })}>取消任务</button>}
    </div>
    {job&&<div className="space-y-3 text-xs">
      <p>状态：{job.stage} · {job.completed}/{job.entries.length} · 成功配音 {job.entries.filter(e=>e.state==='ready').length} · 需处理 {job.entries.filter(e=>e.state==='error').length}</p>
      <p className="break-all text-muted-foreground">输出：{job.directory}</p>
      {job.error&&<p className="text-destructive">{job.error}</p>}
      <select className={input} value={selected} onChange={e=>setSelected(e.target.value)}>
        {job.entries.map(e=><option key={e.step.id} value={e.step.id}>{e.path.mode} · {e.productName||e.trayName} · {e.step.name} · {e.clip?.seconds??'?'}秒 · {e.state}</option>)}
      </select>
      <div className="grid grid-cols-3 gap-2">{frames.map(f=><figure key={f.at}><img className="max-h-72 w-full object-contain" src={f.url} alt={`片段源时间 ${f.at}秒`}/><figcaption className="text-center">源时间 {f.at.toFixed(2)}秒</figcaption></figure>)}</div>
      {item?.error&&<p className="text-destructive">{item.error}</p>}
      {item?.budget&&<p>此片段最多 {item.budget.maxSentences} 句 / {item.budget.maxChars} 字；“可替换”只勾选独立完整、删掉也不破坏其他讲解的句子。</p>}
      <fieldset disabled={!!working||busy} className="space-y-2">
        {copy?.visualNotes&&<p className="text-muted-foreground">看图记录：{copy.visualNotes}</p>}
        {(copy?.sentences??[]).map((sentence,index)=><div className="flex items-start gap-2" key={index}>
          <label className="flex shrink-0 items-center gap-1 pt-2"><input type="checkbox" checked={sentence.replaceable} onChange={e=>update({...copy!,sentences:copy!.sentences.map((s,i)=>i===index?{...s,replaceable:e.target.checked}:s)})}/>可替换</label>
          <input className={input} value={sentence.text} onChange={e=>update({...copy!,sentences:copy!.sentences.map((s,i)=>i===index?{...s,text:e.target.value}:s)})}/>
          <button type="button" className={button} onClick={()=>update({...copy!,sentences:copy!.sentences.filter((_,i)=>i!==index)})}>删句</button>
        </div>)}
        {item&&<button type="button" className={button} onClick={()=>update({...copy??{goals:item.goals,hint:item.hint,sentences:[]},sentences:[...copy?.sentences??[],{text:'',replaceable:true}]})}>添加完整句</button>}
        {copy&&<><div className="flex flex-wrap gap-2">{INTERACTION_GOAL_ORDER.map(g=><label key={g}><input type="checkbox" checked={copy.goals.includes(g)} onChange={e=>update({...copy,goals:e.target.checked?[...copy.goals,g]:copy.goals.filter(goal=>goal!==g)})}/>{INTERACTION_GOAL_LABELS[g]}</label>)}</div>
          <input className={input} value={copy.hint} maxLength={120} placeholder="与实时互动配套的引导（同名步骤共用，不要带某商品专有事实）" onChange={e=>update({...copy,hint:e.target.value})}/></>}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!!working||busy||!['prepared','completed'].includes(job.stage)} onClick={()=>run(async()=>{
          const response=await request({action:'authoring-render',jobId:job.id,copies,accountId:accountId||'default'});if(response.authoring)setJob(response.authoring)
        })}>2. 文案确认后生成 Index2.5 配音</button>
        <button type="button" className={button} disabled={item?.state!=='ready'||busy} onClick={()=>run(async()=>{const response=await request({action:'authoring-audio',jobId:job.id,stepId:selected});setAudio(response.url??'')})}>试听当前配音</button>
        <button type="button" className={button} disabled={job.stage!=='completed'||!!working||busy||hasUnrenderedCopies(job,copies)} onClick={()=>run(async()=>{
          const snapshot=JSON.stringify(config)
          const response=await request({action:'authoring-candidate',jobId:job.id,config})
          assertAuthoringDraftUnchanged(snapshot,latestConfig.current)
          if(response.config)apply(response.config)
        })}>3. 应用成功素材到草稿</button>
      </div>
      {audio&&<audio controls src={audio} className="w-full"/>}
      {item?.result&&<p>实测 {item.result.seconds.toFixed(2)}秒 · 速度 {item.result.speed.toFixed(3)}倍 · 可替换句 {item.result.sentences.filter(s=>s.replaceable).length} · {item.result.warnings.join('；')}</p>}
      <p className="text-muted-foreground">失败步骤保留旧配音；源配置或素材变化时拒绝应用。短片段不能保证容纳长回复，直播时仍按窗口适配，放不下就走文字反馈。</p>
    </div>}
    {error&&<p className="text-xs text-destructive">{error}</p>}
  </details>
}
