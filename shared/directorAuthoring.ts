import type { DirectorConfig, DirectorStep } from './director'
import type { DirectorStepPath } from './directorOps'
import { INTERACTION_GOAL_ORDER, type InteractionGoal, scriptForStep } from './interactionScript'

export interface AuthoringOptions { gapSeconds?: number }
export interface AuthoringClip { start:number; end:number; seconds:number }
export interface AuthoringEntry {
  step:DirectorStep; path:DirectorStepPath; trayName:string; productName:string
  facts:string; summary:string; goals:InteractionGoal[]; hint:string
  /** Tray-wide A steps need scoped evidence too; never merge unlike materials. */
  trayProductFacts?:Array<{id:string;name:string;facts:string}>
  reviewedCopy?:AuthoredCopy
}
export interface AuthoredSentence { text:string; replaceable:boolean }
export interface AuthoredCopy { sentences:AuthoredSentence[]; goals:InteractionGoal[]; hint:string; visualNotes?:string }
export interface AuthoringBudget { maxSentences:number; maxChars:number; gapSeconds:number; targetChars?:number }
export interface AuthoringSpan { start:number; end:number }
export type AuthoredTimeline = {fit:false; requiredSeconds:number} | {
  fit:true; speed:number; seconds:number; sentences:AuthoringSpan[]; silences:AuthoringSpan[]
}
export interface AuthoringFrame { at:number; file:string }
export interface AuthoringResult {
  audio:string; audioVersion:string; seconds:number; speed:number
  sentences:Array<AuthoringSpan & AuthoredSentence>
  silences:AuthoringSpan[]; warnings:string[]
  gapSeconds?:number
  evidence?:{file:string;version:string;sha256:string}
}
export interface AuthoringItem extends AuthoringEntry {
  state:'pending'|'prepared'|'ready'|'error'; frames:AuthoringFrame[]
  clip?:AuthoringClip; budget?:AuthoringBudget; videoVersion?:string
  copy?:AuthoredCopy; result?:AuthoringResult; error?:string
  approvedCopy?:AuthoredCopy
}
export function assertProtectedCopy(reviewed:AuthoredCopy,next:AuthoredCopy) {
  if(reviewed.sentences.some(s=>!s.replaceable&&!next.sentences.some(n=>n.text===s.text&&!n.replaceable)))
    throw new Error('重写必须保留已审核的不可替换句，请人工复核新文案')
}
export interface AuthoringJob {
  id:string; directory:string; createdAt:string; configHash:string; options:AuthoringOptions
  stage:'preparing'|'prepared'|'rendering'|'completed'|'cancelled'|'error'
  entries:AuthoringItem[]; completed:number; error?:string; voice?:unknown
}
export function assertAuthoringDraftUnchanged(snapshot:string,current:DirectorConfig) {
  if(snapshot!==JSON.stringify(current))throw new Error('当前草稿已改变，旧结果未应用；请重新准备。')
}
export function hasUnrenderedCopies(job:AuthoringJob,copies:Record<string,AuthoredCopy>) {
  return job.entries.some(item=>copies[item.step.id]&&JSON.stringify(copies[item.step.id])!==JSON.stringify(item.copy))
}
const round=(n:number)=>Math.round(n*1e6)/1e6
function gap(options:AuthoringOptions) {
  const value=options.gapSeconds??1.8
  if(!Number.isFinite(value)||value<.8||value>4) throw new Error('句间停顿须在 0.8..4 秒之间')
  return value
}
export function collectAuthoringSteps(config:DirectorConfig):AuthoringEntry[] {
  const entries:AuthoringEntry[]=[]
  const seen=new Set<string>()
  function add(step:DirectorStep,path:DirectorStepPath,trayName:string,productName:string,facts:string,summary:string,
    trayProductFacts?:AuthoringEntry['trayProductFacts']) {
    if(!step.id||seen.has(step.id)) throw new Error('步骤 id 必须唯一')
    seen.add(step.id)
    if(step.kind==='image') return
    const script=config.interaction?.interactionScript
    const selected=script&&scriptForStep(script,step.name)
    entries.push({step:structuredClone(step),path,trayName,productName,facts,summary,
      ...(trayProductFacts?{trayProductFacts:structuredClone(trayProductFacts)}:{}),
      goals:selected?.goals??['comment','ask'],hint:selected?.hint??'评论报颜色或编号，安排对应展示。'})
  }
  for(const tray of config.trays) {
    for(const step of tray.A) add(step,{trayId:tray.id,mode:'A'},tray.name,'','',tray.summary??'',
      tray.products.map(product=>({id:product.id,name:product.name,facts:product.facts})))
    for(const product of tray.products) for(const mode of ['B','C'] as const)
      for(const step of product[mode]) add(step,{trayId:tray.id,productId:product.id,mode},tray.name,product.name,product.facts,tray.summary??'')
  }
  return entries
}
export function resolveAuthoringClip(step:Pick<DirectorStep,'start'|'end'>,sourceSeconds:number):AuthoringClip {
  const start=step.start
  const end=step.end===0?sourceSeconds:step.end
  if(![start,end,sourceSeconds].every(Number.isFinite)||start<0||end<=start||end>sourceSeconds+.01||sourceSeconds<=0)
    throw new Error('片段起止时间无效或超出源视频')
  return {start,end:Math.min(end,sourceSeconds),seconds:round(Math.min(end,sourceSeconds)-start)}
}
export function frameSampleTimes(clip:AuthoringClip):number[] {
  if(!Number.isFinite(clip.seconds)||clip.seconds<=0) throw new Error('片段时长无效')
  return [.15,.5,.85].map(r=>round(clip.start+clip.seconds*r))
}
export function narrationBudget(seconds:number,options:AuthoringOptions={}):AuthoringBudget {
  const gapSeconds=gap(options)
  if(!Number.isFinite(seconds)||seconds<1||seconds>600) throw new Error('配音片段须为 1..600 秒')
  const maxSentences=Math.min(4,Math.max(1,Math.floor((seconds+2)/7)))
  // Conservative Chinese starting estimate; measured Index duration, not this estimate, decides fit.
  const speaking=Math.max(.5,seconds-.5-(maxSentences-1)*gapSeconds)
  return {maxSentences,maxChars:Math.min(240,Math.max(4,Math.floor(speaking*2.4))),gapSeconds}
}
export function authoringVoiceIdentity(value:unknown):string {
  const v=value as Record<string,unknown>
  if(!v||['model','version','checkpoint','voice_reference'].some(k=>typeof v[k]!=='string'||!v[k])) throw new Error('Index 音色身份无效')
  return JSON.stringify([v.model,v.version,v.checkpoint,v.voice_reference])
}
export function validateAuthoredCopy(value:unknown,budget:AuthoringBudget):AuthoredCopy {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('文案必须是对象')
  const v=value as AuthoredCopy
  if(!Array.isArray(v.sentences)||!v.sentences.length||v.sentences.length>budget.maxSentences)
    throw new Error(`须填写 1..${budget.maxSentences} 个完整句子`)
  let count=0
  const sentences=v.sentences.map(s=>{
    if(!s||typeof s.text!=='string'||typeof s.replaceable!=='boolean') throw new Error('句子格式无效')
    const text=s.text.trim()
    if(!text||!/[。！？!?]$/u.test(text)||/[\r\n]/u.test(text)||/[<>]/u.test(text)||/积分|评分|恶意用户|黑名单/u.test(text))
      throw new Error('文案须为完整自然句子，不能披露内部积分或标记')
    count+=Array.from(text).length
    return {text,replaceable:s.replaceable}
  })
  if(count>budget.maxChars) throw new Error(`文案超出 ${budget.maxChars} 字预算，请精简`)
  if(!Array.isArray(v.goals)||!v.goals.length||v.goals.some(g=>!INTERACTION_GOAL_ORDER.includes(g))||new Set(v.goals).size!==v.goals.length)
    throw new Error('互动目标无效')
  const hint=typeof v.hint==='string'?v.hint.trim():''
  if(hint.length>120) throw new Error('互动指引最多 120 字')
  const visualNotes=typeof v.visualNotes==='string'?v.visualNotes.trim().slice(0,1000):undefined
  return {sentences,goals:[...v.goals],hint,...(visualNotes?{visualNotes}:{})}
}
export function planAuthoredTimeline(durations:number[],clipSeconds:number,options:AuthoringOptions={}):AuthoredTimeline {
  const gapSeconds=gap(options)
  if(!durations.length||durations.length>4||durations.some(n=>!Number.isFinite(n)||n<=0)||!Number.isFinite(clipSeconds)||clipSeconds<1)
    throw new Error('句子或片段时长无效')
  const speaking=durations.reduce((a,b)=>a+b,0)
  const available=clipSeconds-.5-(durations.length-1)*gapSeconds
  const speed=Math.max(1,Math.ceil(speaking/available*1000)/1000)
  if(available<=0||speed>1.15) return {fit:false,requiredSeconds:round(speaking/1.15+.5+(durations.length-1)*gapSeconds)}
  let cursor=.25
  const sentences:AuthoringSpan[]=[]
  const silences:AuthoringSpan[]=[{start:0,end:.25}]
  for(const [index,duration] of durations.entries()) {
    const start=round(cursor),end=round(cursor+duration/speed)
    sentences.push({start,end});cursor=end
    if(index<durations.length-1) { const next=round(cursor+gapSeconds);silences.push({start:end,end:next});cursor=next }
  }
  silences.push({start:round(cursor),end:clipSeconds})
  return {fit:true,speed,seconds:clipSeconds,sentences,silences}
}
