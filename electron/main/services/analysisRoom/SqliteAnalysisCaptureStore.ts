import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {AnalysisCaptureStore,sameAnalysisScope,type CaptureIO,type CaptureRequest,type StoredLine} from './AnalysisCaptureStore'
import {FreshAnalysisDatabase,type FreshAppendInput,type FreshAppendResult} from './FreshAnalysisDatabase'
import {validateObservationEnvelope,validStoredReason} from './CaptureRecordValidation'
import {sanitizeBusinessPayload} from './BusinessPayload'
import {emptyOriginalSummary,originalData} from './OriginalEvidence'
import {AnalysisError,analysisId,analysisInteger,validateAnalysisScope,type AnalysisScope,type AnalysisRecord,type AnalysisSession,type BusinessObservation,type AppendReceipt,type CaptureLimits,type RecoverySummary} from '../../../../shared/analysisRoom'

/** Fresh capture authority. Compatibility DTOs never refer to readable JSON files. */
export class SqliteAnalysisCaptureStore extends AnalysisCaptureStore {
 readonly sqlite:FreshAnalysisDatabase
 private freshClock:()=>number
 private sqlRecovery?:Promise<RecoverySummary>
 private sqlListeners=new Set<(session:AnalysisSession)=>void>()
 private active=new Map<string,{sequence:number;pending:number;finish?:Promise<AnalysisSession>;failure?:string}>()
 private closingStore=false
 private storageFailure?:string
 constructor(options:{root:string;workerFile?:string;now?:()=>number;limits?:Partial<CaptureLimits>;io?:CaptureIO;requestTimeoutMs?:number}){
  super(options)
  this.freshClock=options.now??Date.now
  this.sqlite=new FreshAnalysisDatabase({root:this.root,limits:this.limits,workerFile:options.workerFile,requestTimeoutMs:options.requestTimeoutMs})
  this.sqlite.onCommitted(()=>this.syncBudget())
 }
 private syncBudget(){const usage=this.sqlite.usage();this.budget.rawBytes=usage.rawBytes;this.budget.committedMetadata('capture.sqlite:metadata',usage.metadataBytes)}
 override recover():Promise<RecoverySummary>{return this.sqlRecovery??=(async()=>{try{await this.sqlite.ready;const result=await this.sqlite.recover(this.freshClock());this.syncBudget();return result}catch(e){this.storageFailure='FRESH_RECOVERY_FAILED';throw e}})()}
 override recoveryHealth(){return{healthy:!this.storageFailure,errorCodes:this.storageFailure?[this.storageFailure]:[]}}
 override assertHealthy(){if(this.storageFailure)throw new AnalysisError('ANALYSIS_STORAGE_FAILED','SQLite capture storage is unavailable',false)}
 override onChanged(listener:(session:AnalysisSession)=>void){this.sqlListeners.add(listener);return()=>this.sqlListeners.delete(listener)}
 private notify(id:string){let session:AnalysisSession;try{session=this.get(id)}catch{return}for(const listener of this.sqlListeners)try{listener(structuredClone(session))}catch{}}
 override get(id:string):AnalysisSession{const s=this.sqlite.get(id),state=this.active.get(id);if(state){s.counters.pending=state.pending;if(state.finish&&s.status==='collecting')s.status='stopping';if(state.failure){s.status='storage-error';s.complete=false;s.reason=state.failure}}return s}
 override owned(scope:AnalysisScope,id:string){validateAnalysisScope(scope);const s=this.get(id);if(!sameAnalysisScope(s.scope,scope))throw new AnalysisError('ANALYSIS_NOT_FOUND','Session not found in scope');return s}
 override order(id:string){return this.sqlite.order(id)}
 activeSession(scope:AnalysisScope):AnalysisSession|undefined{const session=this.sqlite.activeSession(scope);return session?this.get(session.id):undefined}
 pageSessions(scope:AnalysisScope,options:{upper?:number;after?:number;limit:number}){this.assertHealthy();return this.sqlite.pageSessions(scope,options)}
 pageRecords(id:string,options:{upper:number;after?:number;limit:number}){this.assertHealthy();return this.sqlite.pageRecords(id,options)}
 override list(scope:AnalysisScope,upper=Number.MAX_SAFE_INTEGER){const items:AnalysisSession[]=[];let after:number|undefined;do{const page=this.pageSessions(scope,{upper,after,limit:100});items.push(...page.items);after=page.nextAfter}while(after!==undefined&&items.length<1000);return items.slice(0,1000)}
 override async create(scope:AnalysisScope,metadata:{formatVersion:number;mappingVersion?:number;roomId?:string}){
  await this.recover();this.assertHealthy();if(this.closingStore)throw new AnalysisError('ANALYSIS_UNAVAILABLE','Capture store is closing',true)
  scope=validateAnalysisScope(scope);analysisInteger(metadata.formatVersion,1);if(metadata.mappingVersion!==undefined)analysisInteger(metadata.mappingVersion,1)
  const session:AnalysisSession={id:randomUUID(),scope,status:'collecting',complete:true,createdAt:this.freshClock(),formatVersion:metadata.formatVersion,bytes:0,counters:{received:0,saved:0,dropped:0,pending:0,parseFailed:0,redacted:0},...(metadata.mappingVersion===undefined?{}:{mappingVersion:metadata.mappingVersion}),...(metadata.roomId===undefined?{}:{roomId:metadata.roomId}),...(scope.platform==='tiktok'?{originals:emptyOriginalSummary()}:{})}
  const saved=await this.sqlite.create(session);this.active.set(saved.id,{sequence:0,pending:0});this.notify(saved.id);return saved
 }
 override append(id:string,observation:BusinessObservation,mappingVersion?:number):AppendReceipt{
  if(this.closingStore||this.storageFailure)return{accepted:false,reason:'NOT_COLLECTING'}
  let session:AnalysisSession;try{session=this.get(id)}catch{return{accepted:false,reason:'NOT_COLLECTING'}}
  const state=this.active.get(id);if(!state||state.finish||state.failure||session.status!=='collecting')return{accepted:false,reason:'NOT_COLLECTING'}
  if(!sameAnalysisScope(session.scope,observation.scope))return{accepted:false,reason:'SCOPE_MISMATCH'}
  let envelope:ReturnType<typeof validateObservationEnvelope>
  try{envelope=validateObservationEnvelope(observation);if(mappingVersion!==undefined)analysisInteger(mappingVersion,1)}catch{return{accepted:false,reason:'INVALID_OBSERVATION'}}
  const sequence=state.sequence+1
  const input:FreshAppendInput={operationId:randomUUID(),sessionId:id,scope:session.scope,sequence,receivedAt:envelope.receivedAt}
  if(observation.formatVersion!==session.formatVersion)input.failure='FORMAT_CHANGED'
  else if(session.roomId&&observation.roomId&&session.roomId!==observation.roomId)input.failure='ROOM_CHANGED'
  else {
   const clean=sanitizeBusinessPayload(observation.data,{maxBytes:this.limits.maxRecordBytes,maxDepth:this.limits.maxDepth})
   const record:AnalysisRecord={...envelope,...clean,sessionId:id,recordSequence:sequence,complete:envelope.complete&&clean.complete,removedPaths:[...envelope.removedPaths,...clean.removedPaths],truncatedPaths:[...envelope.truncatedPaths,...clean.truncatedPaths],...(mappingVersion===undefined?{}:{mappingVersion})}
   if(Buffer.byteLength(JSON.stringify(record))>this.limits.maxRecordBytes){record.data=null;record.complete=false;record.failureCode='PAYLOAD_LIMIT';record.removedPaths=[];record.truncatedPaths=['']}
   input.record=record
  }
  if(observation.originalFailureCode)input.nativeFailure=`ORIGINAL_${observation.originalFailureCode}`
  else if(observation.original){try{if(envelope.provenance!==undefined&&observation.original.provenance!==envelope.provenance)throw new Error();originalData(observation.original,this.limits.maxRecordBytes,this.limits.maxDepth);input.native=observation.original}catch{input.nativeFailure='INVALID_ORIGINAL'}}
  const admitted=this.sqlite.admit<FreshAppendResult>({method:'append',input})
  if(!admitted.accepted)return{accepted:false,reason:admitted.reason}
  state.sequence=sequence;state.pending++;this.notify(id)
  void admitted.committed.then(()=>{state.pending--;this.notify(id)},()=>{state.pending--;state.failure='RAW_WRITE_FAILED';this.storageFailure='FRESH_WRITE_FAILED';this.notify(id)})
  return{accepted:true,recordSequence:sequence}
 }
 override finish(id:string,reason:string):Promise<AnalysisSession>{analysisId(id);if(reason!=='operator'&&!validStoredReason(reason))return Promise.reject(new AnalysisError('ANALYSIS_INVALID_INPUT','Invalid stop reason'));const state=this.active.get(id);if(state?.finish)return state.finish;if(!state)return Promise.resolve(this.get(id));const work=(async()=>{await this.sqlite.drain();const session=await this.sqlite.finish(id,reason,this.freshClock());this.active.delete(id);this.notify(id);return session})();state.finish=work;this.notify(id);return work}
 override async *records(id:string,startShard='',startOffset=0):AsyncGenerator<StoredLine>{if(startShard!==''&&startShard!=='sqlite')throw new AnalysisError('ANALYSIS_INVALID_INPUT','SQLite capture cursor required');analysisInteger(startOffset);const upper=this.get(id).counters.received;let after=startOffset;while(after<upper){const page=this.pageRecords(id,{upper,after,limit:100});for(const record of page.items){after=record.recordSequence;yield{record,shard:'sqlite',line:after,nextOffset:after}}if(page.nextAfter===undefined)break;after=page.nextAfter}}
 override requestEntries(accountId:string):CaptureRequest[]{return this.sqlite.requestEntries(accountId)}
 override async saveRequests(accountId:string,items:CaptureRequest[]){if(!Array.isArray(items)||items.length>1000)throw new AnalysisError('ANALYSIS_INVALID_INPUT','Request page exceeds bound');for(const item of items)await this.sqlite.putRequest(accountId,item)}
 override async safePath(file:string){if(resolve(file)!==this.sqlite.file)throw new AnalysisError('ANALYSIS_INVALID_INPUT','Fresh SQLite has no JSON authority')}
 override async writeMetadata(_file:string,_value:unknown,_credit=0,_beforeCommit?:()=>void):Promise<void>{throw new AnalysisError('ANALYSIS_INVALID_INPUT','Use typed SQLite metadata persistence')}
 backup(){return this.sqlite.backup()}
 async close(){this.closingStore=true;await this.sqlite.close();this.active.clear();this.sqlListeners.clear()}
}
