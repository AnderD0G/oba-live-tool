import { createHash, randomUUID } from 'node:crypto'
import { mkdir,readFile,writeFile,stat,rename } from 'node:fs/promises'
import { join,resolve,dirname,sep } from 'node:path'
import type { DirectorConfig } from '../../../shared/director'
import { collectAuthoringSteps,resolveAuthoringClip,frameSampleTimes,narrationBudget,validateAuthoredCopy,
  planAuthoredTimeline,authoringVoiceIdentity,assertProtectedCopy,type AuthoredCopy,type AuthoringOptions,type AuthoringItem,type AuthoringJob,
  type AuthoringEntry,type AuthoringFrame,type AuthoringBudget } from '../../../shared/directorAuthoring'
import { defaultInteractionScript } from '../../../shared/interactionScript'
import { narrationSegments,type SpeechWindow } from '../../../shared/directorNarration'
import { speechMaterialConfiguration } from '../../../shared/directorSpeechAnalysis'
import { validateSpeechMaterials } from './DirectorSpeechAnalysis'
import { getIndexVoiceClient,validateIndexWav,type IndexVoiceClient } from './IndexVoiceClient'
import { runMediaCommand } from './DirectorMedia'

export interface AuthoringDependencies {
  index?:IndexVoiceClient
  duration?:(file:string,signal:AbortSignal)=>Promise<number>
  extract?:(file:string,at:number,out:string,signal:AbortSignal)=>Promise<void>
  synthesize?:(text:string,signal:AbortSignal)=>Promise<Uint8Array>
  copy?:(entry:AuthoringEntry,frames:AuthoringFrame[],budget:AuthoringBudget,signal:AbortSignal)=>Promise<unknown>
}
interface JobRecord { job:AuthoringJob; config:DirectorConfig; controller:AbortController; task:Promise<void> }
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Natural short-tail tolerance; never turn a sparse draft into a long placeholder.
const maxTail=(options:AuthoringOptions)=>Math.max(2.1,options.gapSeconds??1.8)
const tailSeconds=(result:{silences:Array<{start:number;end:number}>})=>{
  const tail=result.silences.at(-1)
  return tail?tail.end-tail.start:Infinity
}
export async function authoringMaterialVersion(file:string) {
  const s=await stat(file)
  if(!s.isFile()) throw new Error('素材不是普通文件')
  return JSON.stringify([s.size,s.mtimeMs,s.ctimeMs])
}
/** Final WAV composition stays PCM16 mono22050; DirectorMedia resamples to48000 for OBS. */
export function pcmWav(pcm:Buffer):Buffer {
  if(!pcm.length||pcm.length%2||pcm.length>60*1024*1024) throw new Error('PCM 长度无效')
  const header=Buffer.alloc(44)
  header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8)
  header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22)
  header.writeUInt32LE(22050,24);header.writeUInt32LE(44100,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34)
  header.write('data',36);header.writeUInt32LE(pcm.length,40)
  return Buffer.concat([header,pcm])
}
/** Only authored zero PCM permits early interception; never infer it from a timestamp alone. */
export function verifiedAuthoredEntryStart(pcm:Buffer,start:number):number {
  const boundary=Math.round(start*22050)
  if(!Number.isFinite(start)||start<0||boundary*2>pcm.length||pcm.length%2||
    Math.abs(start*22050-boundary)>1e-6) throw new Error('原句进入点无效，须为PCM采样边界')
  const first=Math.max(0,boundary-2205)
  // Recover integer sample indices: floor(timestamp * rate) can drop the last
  // pre-sentence sample through floating-point rounding. Fractional samples are refused.
  const entry=Math.max(0,start-.1,first/22050)
  const leading=pcm.subarray(first*2,boundary*2)
  if(!leading.length||!leading.every(byte=>byte===0)) throw new Error('句前进入点没有经过零PCM静音验证')
  return entry
}
/** Offline-only preparation. Exports a candidate; never mutates live settings or touches OBS. */
export class DirectorAuthoring {
  private records=new Map<string,JobRecord>()
  private active?:string
  constructor(private root:string,private deps:AuthoringDependencies={}) {
    this.root=resolve(root)
    if(/^(?:\\\\|\/\/)/.test(this.root)) throw new Error('素材输出必须是本机目录')
  }
  status(id:string):AuthoringJob { return structuredClone(this.record(id).job) }
  get busy() {return Boolean(this.active)}
  private get index() {return this.deps.index??getIndexVoiceClient()}
  async load(directory:string):Promise<AuthoringJob> {
    if(this.active) throw new Error('已有素材任务正在运行')
    const canonical=resolve(directory)
    if(dirname(canonical)!==this.root) throw new Error('任务必须位于素材工作目录内')
    const raw=await readFile(join(canonical,'manifest.json'),'utf8')
    if(raw.length>10*1024*1024) throw new Error('素材清单过大')
    const job=JSON.parse(raw) as AuthoringJob
    const config=JSON.parse(await readFile(join(canonical,'original-config.json'),'utf8')) as DirectorConfig
    if(!job.id||join(this.root,job.id)!==canonical||job.directory!==canonical||hash(config)!==job.configHash)
      throw new Error('素材任务身份或源配置不匹配')
    const entries=collectAuthoringSteps(config)
    if(!Array.isArray(job.entries)||job.entries.length!==entries.length) throw new Error('素材步骤清单无效')
    narrationBudget(10,job.options)
    for(const [i,item] of job.entries.entries()) {
      const expected=entries[i],child=join(canonical,String(i+1).padStart(3,'0'))+sep
      if(hash({...item.step})!==hash(expected.step)||hash(item.path)!==hash(expected.path)) throw new Error('素材步骤配置不匹配')
      if(!Array.isArray(item.frames)||item.frames.some(f=>!resolve(f.file).startsWith(child))||
        (item.result&&!resolve(item.result.audio).startsWith(child))) throw new Error('素材路径超出任务范围')
    }
    if(['preparing','rendering'].includes(job.stage)) job.stage='prepared'
    this.records.set(job.id,{job,config,controller:new AbortController(),task:Promise.resolve()})
    return this.status(job.id)
  }
  private record(id:string) { const record=this.records.get(id);if(!record) throw new Error('素材任务不存在');return record }
  private async persist(record:JobRecord) {
    const tmp=join(record.job.directory,'manifest.tmp.json'),dest=join(record.job.directory,'manifest.json')
    await writeFile(tmp,JSON.stringify(record.job,null,2)+'\n');await rename(tmp,dest)
  }
  startPrepare(config:DirectorConfig,options:AuthoringOptions={}):AuthoringJob {
    if(this.active) throw new Error('已有素材任务正在运行')
    narrationBudget(10,options)
    const snapshot=structuredClone(config)
    const entries=collectAuthoringSteps(snapshot)
    if(!entries.length||entries.length>500) throw new Error('须有 1..500 个视频步骤')
    const id=randomUUID(),directory=join(this.root,id)
    const job:AuthoringJob={id,directory,createdAt:new Date().toISOString(),configHash:hash(snapshot),options:{...options},
      stage:'preparing',entries:entries.map(e=>({...e,state:'pending',frames:[]})),completed:0}
    const record:JobRecord={job,config:snapshot,controller:new AbortController(),task:Promise.resolve()}
    this.records.set(id,record);this.active=id
    record.task=this.prepareRecord(record).catch(async error=>{
      job.stage=record.controller.signal.aborted?'cancelled':'error';job.error=this.message(error)
      await this.persist(record).catch(()=>{})
    }).finally(()=>{if(this.active===id) this.active=undefined})
    return structuredClone(job)
  }
  async prepare(config:DirectorConfig,options:AuthoringOptions={}) { const job=this.startPrepare(config,options);return this.wait(job.id) }
  async wait(id:string) { await this.record(id).task;return this.status(id) }
  cancel(id:string) {
    const record=this.record(id)
    if(this.active!==id) return false
    record.controller.abort(new Error('素材任务已取消'));return true
  }
  private message(error:unknown) { return (error instanceof Error?error.message:String(error)).slice(0,1000) }
  private async verifyEvidence(job:AuthoringJob,item:AuthoringItem) {
    const result=item.result!,copy=item.copy!,directory=dirname(result.audio)
    const gapSeconds=result.gapSeconds??job.options.gapSeconds??1.8
    narrationBudget(10,{gapSeconds})
    if(result.evidence) {
      if(result.evidence.file!==join(directory,'timeline.json')||await authoringMaterialVersion(result.evidence.file)!==result.evidence.version)
        throw new Error('生成证据已改变，请重新合成')
      const bytes=await readFile(result.evidence.file)
      const expected={...result};delete expected.evidence
      if(createHash('sha256').update(bytes).digest('hex')!==result.evidence.sha256||hash(JSON.parse(bytes.toString()))!==hash({jobId:job.id,stepId:item.step.id,copy,result:expected}))
        throw new Error('导入时间轴与生成证据不匹配')
    }
    const recorded=JSON.parse(await readFile(join(directory,'copy.json'),'utf8'))
    if(hash(recorded)!==hash(copy))throw new Error('文案与逐句生成证据不匹配')
    const pcm=validateIndexWav(await readFile(result.audio))
    if(!item.clip||pcm.length!==Math.floor(item.clip.seconds*22050)*2||
      !Number.isFinite(result.seconds)||Math.abs(result.seconds-pcm.length/44100)>1/22050)
      throw new Error('完整配音时长与视频片段不匹配，请重新制作')
    const expected=Buffer.alloc(pcm.length)
    let cursor=Math.round(.25*22050)
    const sentences=[];const silences=[{start:0,end:cursor/22050}]
    for(const [i,sentence] of copy.sentences.entries()) {
      const file=join(directory,`sentence-${i+1}${result.speed>1?'-fit':''}.wav`)
      const part=validateIndexWav(await readFile(file))
      const start=cursor/22050
      if(cursor*2+part.length>pcm.length)throw new Error('整句生成证据超出时间轴')
      part.copy(expected,cursor*2);cursor+=part.length/2
      sentences.push({...sentence,start,end:cursor/22050})
      if(i<copy.sentences.length-1){const end=cursor+Math.round(gapSeconds*22050);silences.push({start:cursor/22050,end:end/22050});cursor=end}
    }
    silences.push({start:cursor/22050,end:pcm.length/44100})
    if(hash(sentences)!==hash(result.sentences)||hash(silences)!==hash(result.silences)||!expected.equals(pcm))
      throw new Error('原句/时间轴与完整逐句PCM生成证据不匹配')
  }
  private async extractFrame(config:DirectorConfig,file:string,at:number,out:string,signal:AbortSignal) {
    if(this.deps.extract)await this.deps.extract(file,at,out,signal)
    else await runMediaCommand(config.ffmpeg,['-nostdin','-y','-v','error','-ss',String(at),'-i',file,
      '-frames:v','1','-vf','scale=540:-2,format=yuvj420p','-q:v','3','-threads','1',out],AbortSignal.any([signal,AbortSignal.timeout(30000)]))
    let size=await stat(out).then(s=>s.size).catch(()=>0)
    if(!size&&!this.deps.extract) {
      // Some VFR/iPhone clips hold their final frame past the final packet timestamp.
      // Decode and sample the displayed timeline rather than seeking a nonexistent later packet.
      await runMediaCommand(config.ffmpeg,['-nostdin','-y','-v','error','-i',file,'-frames:v','1',
        '-vf',`fps=30,select=gte(t\\,${at}),scale=540:-2,format=yuvj420p`,'-q:v','3','-threads','1',out],AbortSignal.any([signal,AbortSignal.timeout(30000)]))
      size=await stat(out).then(s=>s.size).catch(()=>0)
    }
    if(!size)throw new Error('截图为空，采样位置没有可显示视频帧')
  }
  private async prepareRecord(record:JobRecord) {
    const {job,config,controller}=record,signal=controller.signal
    await mkdir(job.directory,{recursive:true})
    await writeFile(join(job.directory,'original-config.json'),JSON.stringify(config,null,2)+'\n')
    const durations=new Map<string,number>()
    for(const [i,item] of job.entries.entries()) {
      signal.throwIfAborted()
      try {
        const version=await authoringMaterialVersion(item.step.file)
        let seconds=durations.get(item.step.file)
        if(seconds===undefined) {
          seconds=this.deps.duration?await this.deps.duration(item.step.file,signal):Number(await runMediaCommand(config.ffprobe,
            ['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',item.step.file],AbortSignal.any([signal,AbortSignal.timeout(30000)])))
          durations.set(item.step.file,seconds)
        }
        item.clip=resolveAuthoringClip(item.step,seconds)
        const directory=join(job.directory,String(i+1).padStart(3,'0'));await mkdir(directory,{recursive:true})
        const frames:AuthoringFrame[]=[]
        for(const [j,at] of frameSampleTimes(item.clip).entries()) {
          signal.throwIfAborted()
          const file=join(directory,`frame-${j+1}.jpg`)
          await this.extractFrame(config,item.step.file,at,file,signal)
          frames.push({at,file})
        }
        if(version!==await authoringMaterialVersion(item.step.file)) throw new Error('截图期间素材已改变')
        item.frames=frames;item.videoVersion=version;item.state='prepared'
        item.budget=narrationBudget(item.clip.seconds,job.options)
        if(this.deps.copy) {
          const raw=await this.deps.copy(item,frames,item.budget,signal)
          item.copy=validateAuthoredCopy(raw,item.budget)
        }
      } catch(error) {
        signal.throwIfAborted();item.state='error';item.error=this.message(error)
      }
      job.completed=i+1;await this.persist(record)
    }
    signal.throwIfAborted();job.stage='prepared';await this.persist(record)
  }
  startRender(id:string,copies:Record<string,AuthoredCopy>):AuthoringJob {
    if(this.active) throw new Error('已有素材任务正在运行')
    const record=this.record(id)
    if(!['prepared','completed'].includes(record.job.stage)) throw new Error('请先完成截图准备')
    if(!copies||typeof copies!=='object'||Array.isArray(copies)||Object.keys(copies).some(key=>!record.job.entries.some(e=>e.step.id===key)))
      throw new Error('文案步骤 id 不在当前任务中')
    record.controller=new AbortController();record.job.stage='rendering';record.job.completed=0;this.active=id
    const snapshot=structuredClone(copies)
    record.task=this.renderRecord(record,snapshot).catch(async error=>{
      record.job.stage=record.controller.signal.aborted?'cancelled':'error';record.job.error=this.message(error)
      await this.persist(record).catch(()=>{})
    }).finally(async()=>{
      if(!this.deps.synthesize)await this.index.waitForIdle()
      if(this.active===id)this.active=undefined
    })
    return this.status(id)
  }
  async render(id:string,copies:Record<string,AuthoredCopy>) { this.startRender(id,copies);return this.wait(id) }
  async repairFrames(id:string):Promise<AuthoringJob> {
    if(this.active) throw new Error('已有素材任务正在运行')
    const record=this.record(id),{job,config}=record
    record.controller=new AbortController();const signal=record.controller.signal
    this.active=id;job.stage='preparing'
    try {
      for(const [i,item] of job.entries.entries()) {
        signal.throwIfAborted()
        if(item.frames.length===3||!item.clip)continue
        try {
          const version=await authoringMaterialVersion(item.step.file)
          if(item.videoVersion&&version!==item.videoVersion)throw new Error('源素材已改变，请重新准备')
          const directory=join(job.directory,String(i+1).padStart(3,'0'));await mkdir(directory,{recursive:true})
          const frames:AuthoringFrame[]=[]
          for(const [j,at] of frameSampleTimes(item.clip).entries()) {
            const file=join(directory,`frame-${j+1}.jpg`)
            await this.extractFrame(config,item.step.file,at,file,signal);frames.push({at,file})
          }
          if(version!==await authoringMaterialVersion(item.step.file))throw new Error('截图期间素材已改变')
          item.frames=frames;item.videoVersion=version;item.budget=narrationBudget(item.clip.seconds,job.options);item.state='prepared';item.error=undefined
        }catch(error){signal.throwIfAborted();item.state='error';item.error=this.message(error)}
        await this.persist(record)
      }
      job.stage='prepared';await this.persist(record)
    }catch(error){job.stage=signal.aborted?'cancelled':'error';job.error=this.message(error);await this.persist(record)}
    finally{this.active=undefined}
    return this.status(id)
  }
  async copyDrafts(id:string,failedOnly=true):Promise<AuthoringJob> {
    if(this.active) throw new Error('已有素材任务正在运行')
    const record=this.record(id),{job}=record
    if(!this.deps.copy) throw new Error('看图文案接口未配置')
    record.controller=new AbortController();const signal=record.controller.signal
    this.active=id;job.stage='preparing';job.completed=0
    try {
      for(const [i,item] of job.entries.entries()) {
        signal.throwIfAborted()
        if(!item.clip||item.frames.length!==3) {job.completed=i+1;continue}
        item.budget=narrationBudget(item.clip.seconds,job.options)
        if(failedOnly&&item.copy&&item.state!=='error'){try{validateAuthoredCopy(item.copy,item.budget);job.completed=i+1;continue}catch{}}
        try {
          if(item.videoVersion!==await authoringMaterialVersion(item.step.file)) throw new Error('源素材已改变')
          item.copy=validateAuthoredCopy(await this.deps.copy(item,item.frames,item.budget,signal),item.budget)
          item.state='prepared';item.error=undefined;item.result=undefined
        }catch(error){signal.throwIfAborted();item.state='error';item.error=this.message(error)}
        job.completed=i+1;await this.persist(record)
      }
      job.stage='prepared';await this.persist(record)
    }catch(error){job.stage=signal.aborted?'cancelled':'error';job.error=this.message(error);await this.persist(record)}
    finally {this.active=undefined}
    return this.status(id)
  }
  private async renderRecord(record:JobRecord,copies:Record<string,AuthoredCopy>) {
    const {job,config,controller}=record,signal=controller.signal
    if(!this.deps.synthesize) {
      const voice=await this.index.ensureReady()
      if(job.voice&&authoringVoiceIdentity(job.voice)!==authoringVoiceIdentity(voice))throw new Error('任务原音色/模型与当前 Index 不同，请重新准备')
      job.voice=voice
    }
    for(const [i,item] of job.entries.entries()) {
      signal.throwIfAborted()
      if(!item.clip||!item.budget||!item.videoVersion||item.frames.length!==3) {job.completed=i+1;continue}
      const directory=join(job.directory,String(i+1).padStart(3,'0'),`render-${randomUUID()}`)
      try {
        if(item.step.overlayVariants?.some(v=>v.audio.length&&hash(v.audio)!==hash(item.step.audio)))
          throw new Error('变体有专属配音，须分别制作配套文案；本次保留原步骤，未覆盖变体。')
        if(item.videoVersion!==await authoringMaterialVersion(item.step.file)) throw new Error('源素材已改变，请重新截图')
        const raw=copies[item.step.id]??item.copy
        if(!raw) throw new Error('尚未提供看图审核后的文案')
        let copy=validateAuthoredCopy(raw,item.budget)
        const reviewedCopy=structuredClone(item.approvedCopy??(['ready','error'].includes(item.state)?item.copy:undefined)??copy)
        assertProtectedCopy(reviewedCopy,copy)
        item.approvedCopy=reviewedCopy
        if(item.state==='ready'&&item.result&&hash(copy)===hash(item.copy)&&tailSeconds(item.result)<=maxTail(job.options)) {
          if(item.result.audioVersion!==await authoringMaterialVersion(item.result.audio)) throw new Error('已生成配音发生改变，请重新生成')
          await this.verifyEvidence(job,item);job.completed=i+1;continue
        }
        await mkdir(directory,{recursive:true})
        item.copy=copy;item.result=undefined;item.error=undefined
        const protectedSentences=reviewedCopy.sentences.filter(s=>!s.replaceable)
        let timingOptions={...job.options}
        let pcm:Buffer[]=[]
        let proposed=planAuthoredTimeline([.01],item.clip.seconds,job.options)
        for(let attempt=0;;attempt++) {
          pcm=[]
          for(const [j,sentence] of copy.sentences.entries()) {
          signal.throwIfAborted()
          const wav=this.deps.synthesize?await this.deps.synthesize(sentence.text,signal):await this.index.synthesize('offline',`${job.id}-${i}-${j}`,sentence.text,signal,{priority:-100})
          signal.throwIfAborted()
          if(!this.deps.synthesize&&authoringVoiceIdentity(this.index.status.health)!==authoringVoiceIdentity(job.voice)) throw new Error('Index 音色/模型已改变，请重新开始素材任务')
          const buffer=Buffer.from(wav);pcm.push(validateIndexWav(buffer))
          await writeFile(join(directory,`sentence-${j+1}.wav`),buffer)
          }
          const durations=pcm.map(b=>b.length/44100)
          proposed=planAuthoredTimeline(durations,item.clip.seconds,timingOptions)
          if((!proposed.fit||proposed.speed>1)&&durations.length>1&&(timingOptions.gapSeconds??1.8)>.8){
            // Remove only authored dead time before shortening complete words.
            timingOptions={...timingOptions,gapSeconds:.8}
            proposed=planAuthoredTimeline(durations,item.clip.seconds,timingOptions)
          }
          const underfilled=proposed.fit&&tailSeconds(proposed)>maxTail(job.options)
          if(proposed.fit&&!underfilled)break
          if(attempt>=4||!this.deps.copy) throw new Error(proposed.fit
            ?`默认讲解不足，片尾留白 ${tailSeconds(proposed).toFixed(2)} 秒；请补充看图讲解，不会批准长静音等待`
            :`配音需要 ${proposed.requiredSeconds} 秒，片段只有 ${item.clip.seconds} 秒；请缩写重做`)
          const used=copy.sentences.reduce((sum,s)=>sum+Array.from(s.text).length,0)
          const protectedChars=protectedSentences.reduce((sum,s)=>sum+Array.from(s.text).length,0)
          const speaking=pcm.reduce((sum,b)=>sum+b.length/44100,0)
          // A protected-only seed cannot be lengthened in place. Allow one separate
          // grounded sentence, and budget its pause rather than asking the model
          // for an impossible longer version of the immutable original.
          const needsAddition=underfilled&&protectedSentences.length===copy.sentences.length
          const nextCount=needsAddition?Math.min(4,copy.sentences.length+1):copy.sentences.length
          if(needsAddition)timingOptions={...timingOptions,gapSeconds:.8}
          const targetSpeaking=item.clip.seconds-.25-Math.min(1,maxTail(job.options)/2)-(nextCount-1)*(timingOptions.gapSeconds??1.8)
          // Character rate is only copy feedback. The next complete PCM, not this estimate,
          // must pass both coverage and overflow checks before it can be approved.
          const targetChars=Math.min(240,Math.max(used+1,Math.ceil(used*targetSpeaking/speaking)))
          const previousBudget:AuthoringBudget=item.budget!
          const budget:AuthoringBudget=underfilled
            ?{...previousBudget,maxSentences:Math.max(nextCount,previousBudget.maxSentences),
              maxChars:Math.min(240,Math.max(previousBudget.maxChars,targetChars+Math.ceil(targetChars*.12))),targetChars}
            :{...previousBudget,targetChars:undefined,maxSentences:Math.max(1,protectedSentences.length,copy.sentences.length),
              maxChars:Math.max(2,protectedChars,Math.min(previousBudget.maxChars-1,used-1,
                Math.floor(used*(item.clip.seconds-.5-(copy.sentences.length-1)*(timingOptions.gapSeconds??1.8))*1.12/speaking)))}
          const next=validateAuthoredCopy(await this.deps.copy({...item,reviewedCopy},item.frames,budget,signal),budget)
          if(protectedSentences.some(s=>!next.sentences.some(n=>n.text===s.text&&!n.replaceable))) throw new Error('重写必须保留已审核的不可替换句，请人工复核新文案')
          if(hash(next)===hash(copy)) throw new Error('文案重写未改变，默认讲解不足或过长，请人工复核')
          // Retry-specific shortening must not shrink the persisted editor budget:
          // a failed attempt may later be resubmitted with the original reviewed copy.
          item.budget={...previousBudget,maxChars:Math.max(previousBudget.maxChars,budget.maxChars),
            maxSentences:Math.max(previousBudget.maxSentences,budget.maxSentences),targetChars:undefined}
          copy=next
          item.copy=copy
        }
        const appliedSpeed=proposed.speed>1?Math.min(1.15,proposed.speed+.02):1
        if(appliedSpeed>1) for(let j=0;j<pcm.length;j++) {
          const out=join(directory,`sentence-${j+1}-fit.wav`)
          await runMediaCommand(config.ffmpeg,['-nostdin','-y','-v','error','-i',join(directory,`sentence-${j+1}.wav`),
            '-af',`atempo=${appliedSpeed}`,'-ac','1','-ar','22050','-c:a','pcm_s16le',out],AbortSignal.any([signal,AbortSignal.timeout(30000)]))
          pcm[j]=validateIndexWav(await readFile(out))
        }
        const measured=planAuthoredTimeline(pcm.map(b=>b.length/44100),item.clip.seconds,timingOptions)
        if(!measured.fit||measured.speed>1) throw new Error('实测配音仍然过长，请缩写；不会裁切句子')
        if(tailSeconds(measured)>maxTail(job.options)) throw new Error('默认讲解不足，实测片尾留白过长，请重新制作')
        const totalSamples=Math.floor(item.clip.seconds*22050),body=Buffer.alloc(totalSamples*2)
        let cursor=Math.round(.25*22050)
        const sentences=[];const silences=[{start:0,end:cursor/22050}]
        for(const [j,buffer] of pcm.entries()) {
          const start=cursor/22050
          if(cursor*2+buffer.length>body.length) throw new Error('完整句超出片段')
          buffer.copy(body,cursor*2);cursor+=buffer.length/2
          sentences.push({...copy.sentences[j],start,end:cursor/22050})
          if(j<pcm.length-1) {const end=cursor+Math.round((timingOptions.gapSeconds??1.8)*22050)
            silences.push({start:cursor/22050,end:end/22050});cursor=end}
        }
        if(cursor>totalSamples-Math.floor(.25*22050)) throw new Error('实测句尾安全余量不足')
        silences.push({start:cursor/22050,end:totalSamples/22050})
        const audio=join(directory,'narration.wav');await writeFile(audio,pcmWav(body))
        signal.throwIfAborted()
        validateIndexWav(await readFile(audio))
        if(item.videoVersion!==await authoringMaterialVersion(item.step.file)) throw new Error('生成期间源素材已改变')
        const warnings:string[]=[]
        item.result={audio,audioVersion:await authoringMaterialVersion(audio),seconds:totalSamples/22050,speed:appliedSpeed,
          gapSeconds:timingOptions.gapSeconds??1.8,sentences,silences,warnings};item.state='ready'
        await writeFile(join(directory,'copy.json'),JSON.stringify(copy,null,2)+'\n')
        const evidenceFile=join(directory,'timeline.json'),evidence=Buffer.from(JSON.stringify({jobId:job.id,stepId:item.step.id,copy,result:item.result}))
        await writeFile(evidenceFile,evidence)
        item.result.evidence={file:evidenceFile,version:await authoringMaterialVersion(evidenceFile),sha256:createHash('sha256').update(evidence).digest('hex')}
      }catch(error) {signal.throwIfAborted();item.state='error';item.error=this.message(error);item.result=undefined}
      job.completed=i+1;await this.persist(record)
    }
    signal.throwIfAborted();job.stage='completed';await this.persist(record)
  }
  async candidate(id:string,current:DirectorConfig):Promise<DirectorConfig> {
    const record=this.record(id),{job}=record
    if(job.stage!=='completed') throw new Error('配音任务尚未完成')
    if(job.configHash!==hash(current)) throw new Error('源配置已改变，不能覆盖当前编辑；请重新准备')
    const candidate=structuredClone(current)
    const located=collectAuthoringSteps(candidate)
    const script=candidate.interaction?.interactionScript??defaultInteractionScript()
    const additions=new Map<string,{step:string;goals:AuthoredCopy['goals'];hint:string}>()
    let ready=0
    for(const item of job.entries) {
      if(item.state!=='ready'||!item.result||!item.copy) continue
      if(item.step.overlayVariants?.some(v=>v.audio.length&&hash(v.audio)!==hash(item.step.audio)))throw new Error('变体有专属配音，不能统一覆盖')
      if(item.videoVersion!==await authoringMaterialVersion(item.step.file)) throw new Error('源素材已改变，请重新生成')
      const result=item.result,audioVersion=await authoringMaterialVersion(result.audio)
      if(tailSeconds(result)>maxTail(job.options)) throw new Error('旧配音讲解不足，片尾留白过长，请重新合成；不会批准长静音等待')
      if(audioVersion!==result.audioVersion) throw new Error('生成配音已改变，请重新生成')
      await this.verifyEvidence(job,item)
      const pcm=validateIndexWav(await readFile(result.audio))
      if(Math.abs(pcm.length/44100-result.seconds)>1/22050) throw new Error('生成配音已改变')
      const entry=located.find(e=>e.step.id===item.step.id)!
      const tray=candidate.trays.find(t=>t.id===entry.path.trayId)!
      const steps=entry.path.mode==='A'?tray.A:tray.products.find(p=>p.id===entry.path.productId)![entry.path.mode]
      const step=steps.find(s=>s.id===item.step.id)!
      step.audio=[result.audio];step.audioOverflow='continue';step.speechSlot=false
      if(step.overlayVariants) for(const variant of step.overlayVariants) if(variant.audio.length) variant.audio=[result.audio]
      const material={stepId:step.id,video:step.file,audio:result.audio,configuration:speechMaterialConfiguration(step),audioVersion,videoVersion:item.videoVersion}
      const windows:SpeechWindow[]=[]
      for(const [i,s] of result.sentences.entries()) if(s.replaceable&&s.end-s.start>=1.2&&s.end-s.start<=12) {
        windows.push({audio:result.audio,start:s.start,end:s.end,entryStart:verifiedAuthoredEntryStart(pcm,s.start),kind:'sentence',transcript:{start:s.start,end:s.end,text:s.text},material,
          review:{analysisId:job.id,candidateId:`sentence-${i}`,reason:'独立完整讲解句，经文案审核；逐句合成保留全句，边界来自实测PCM，不依靠猜测气口。',reviewedAt:new Date().toISOString()}})
      }
      for(const [i,s] of result.silences.entries()) if(s.end-s.start>=1.4) {
        // These samples are constructed zeros, not merely low-amplitude original speech.
        const start=s.start+.1,end=s.end-.1
        const bytes=pcm.subarray(Math.ceil(start*22050)*2,Math.floor(end*22050)*2)
        if(!bytes.every(b=>b===0)) throw new Error('静音窗口不再是实际零静音，配音已改变')
        windows.push({audio:result.audio,start,end,kind:'silence',material,
          review:{analysisId:job.id,candidateId:`silence-${i}`,reason:'程序写入并复核为全零PCM的句间/片尾静音；两侧各留0.1秒。',reviewedAt:new Date().toISOString()}})
      }
      step.speechWindows=windows.sort((a,b)=>a.start-b.start)
      narrationSegments(result.audio,result.seconds,step.speechWindows);await validateSpeechMaterials(step)
      if(!script.scripts.some(s=>s.step===step.name)&&!additions.has(step.name)) additions.set(step.name,{step:step.name,goals:[...item.copy.goals],hint:item.copy.hint})
      ready++
    }
    if(!ready) throw new Error('没有可应用的成功配音')
    if(candidate.interaction) candidate.interaction.interactionScript={...script,scripts:[...script.scripts,...additions.values()]}
    await writeFile(join(job.directory,'candidate-director.json'),JSON.stringify(candidate,null,2)+'\n')
    return candidate
  }
  async images(id:string,stepId:string) {
    const item=this.record(id).job.entries.find(e=>e.step.id===stepId)
    if(!item) throw new Error('步骤不存在')
    return Promise.all(item.frames.map(async frame=>{
      const bytes=await readFile(frame.file)
      if(bytes.length>2*1024*1024) throw new Error('预览图片过大')
      return {at:frame.at,url:`data:image/jpeg;base64,${bytes.toString('base64')}`}
    }))
  }
}
