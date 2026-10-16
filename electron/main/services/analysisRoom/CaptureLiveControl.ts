import type {DatabaseSync} from 'node:sqlite'
import type {AnalysisScope,CaptureLimits} from '../../../../shared/analysisRoom'
import type {AnalysisSession} from '../../../../shared/analysisRoom'
import {analysisId,analysisInteger,analysisString,validateAnalysisScope} from '../../../../shared/analysisRoom'
import {createHash} from 'node:crypto'
import {types} from 'node:util'
import {CaptureLiveControlError,CAPTURE_LIVE_RESULT_BYTES,CAPTURE_LIVE_TERMINAL_CREDIT_BYTES} from './CaptureLiveControlSchema'
import {CAPTURE_STORAGE_LIMITS,validateCaptureStorageLimits} from './CaptureStorage'
import {validateCaptureSession,validStoredReason} from './CaptureRecordValidation'
import {insertCaptureSessionInTransaction} from './CaptureDatabaseWorker'
import {preflightCaptureValue} from './CaptureWorkerProtocol'
import {CaptureSessionMetadataView} from './CaptureSessionMetadataView'

type Common={operationId:string;scope:AnalysisScope;expectedRevision:number}
export type LiveRejectDelta={received:number;dropped:number;parseFailed:number;redacted:number;originals?:{received:number;dropped:number;redacted:number;error?:string}}
export type CaptureLiveControlCommand=
 | (Common&{kind:'prepare-start';requestId:string;requestDigest:string;session:AnalysisSession})
 | (Common&{kind:'start-result';sessionId:string;requestId:string;ready:boolean})
 | (Common&{kind:'prepare-stop';sessionId:string;requestId:string;requestDigest:string})
 | (Common&{kind:'reject';sessionId:string;expectedSequence:number;allocatedAttempts:number;reason:string;delta:LiveRejectDelta})
 | (Common&{kind:'finish';sessionId:string;requestId?:string;expectedSequence:number;stoppedAt:number;reason:string;knownLoss:boolean})
export interface CaptureLiveControlReceipt{
 protocol:2;mode:'live-control';controlExtensionVersion:1;schemaVersion:1;databaseId:string;generation:number;
 operationId:string;intentDigest:string;domain:'session';owner:{scope:AnalysisScope;sessionId:string;requestId?:string};expectedRevision:number;resultRevision:number;controlWatermark:number;recordWatermarkAtCommit:number;
 result:Omit<AnalysisSession,'id'|'scope'>&{sessionId:string;liveSequence:number;requestStatus?:'inflight'|'terminal'};reused:boolean
}
type Row=Record<string,any>
function fail(code:string):never{throw new CaptureLiveControlError(code)}
function literal(value:unknown,allowed:string[],required=allowed):Row{
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('CONTROL_INVALID_INPUT')
 const result:Row={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=='string'||!allowed.includes(key)||!d.enumerable||!('value'in d))fail('CONTROL_INVALID_INPUT');result[key]=d.value}
 if(required.some(key=>!Object.hasOwn(result,key)))fail('CONTROL_INVALID_INPUT');return result
}
function scalarFields(value:Row,children:string[]=[]):void{for(const[key,item]of Object.entries(value))if(!children.includes(key)&&(item!==undefined&&!['string','number','boolean'].includes(typeof item)))fail('CONTROL_INVALID_INPUT')}
function checkedScope(scope:AnalysisScope):AnalysisScope{return validateAnalysisScope(literal(scope,['accountId','platform','source']))}
function checkedRoom(value:unknown):void{
 if(value===undefined)return
 const room=analysisString(value,256)
 // New live commands carry a platform identifier, never a URL or filesystem path.
 if(Buffer.from(room,'utf8').toString('utf8')!==room||/[\s:/\\?#]/u.test(room))fail('CONTROL_INVALID_INPUT')
}
const same=(a:AnalysisScope,b:AnalysisScope)=>a.accountId===b.accountId&&a.platform===b.platform&&a.source===b.source
const canonical=(v:any):string=>v===undefined?'<absent>':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex')
function integer(value:unknown,min=0):number{try{return analysisInteger(value,min)}catch{fail('CONTROL_INVALID_INPUT')}}
/** Structural wire validation only; database authenticity/intent binding belongs to its caller. */
export function decodeLiveControlReceipt(value:unknown):CaptureLiveControlReceipt{
 try{
  const raw=literal(value,['protocol','mode','controlExtensionVersion','schemaVersion','databaseId','generation','operationId','intentDigest','domain','owner','expectedRevision','resultRevision','controlWatermark','recordWatermarkAtCommit','result','reused'])
  if(raw.protocol!==2||raw.mode!=='live-control'||raw.controlExtensionVersion!==1||raw.schemaVersion!==1||raw.domain!=='session'||typeof raw.reused!=='boolean')fail('CONTROL_INVALID_RECEIPT')
  analysisId(raw.databaseId);analysisString(raw.operationId);integer(raw.generation,1);integer(raw.expectedRevision);integer(raw.resultRevision,1);integer(raw.controlWatermark,1);integer(raw.recordWatermarkAtCommit)
  if(typeof raw.intentDigest!=='string'||!/^[a-f0-9]{64}$/.test(raw.intentDigest))fail('CONTROL_INVALID_RECEIPT')
  scalarFields(raw,['owner','result']);const owner=literal(raw.owner,['scope','sessionId','requestId'],['scope','sessionId']);scalarFields(owner,['scope']);const scope=checkedScope(owner.scope);analysisId(owner.sessionId);if(Object.hasOwn(owner,'requestId'))analysisString(owner.requestId,128)
  const result=literal(raw.result,['sessionId','liveSequence','requestStatus','status','complete','createdAt','stoppedAt','roomId','formatVersion','mappingVersion','bytes','counters','reason','originals'],['sessionId','liveSequence','status','complete','createdAt','formatVersion','bytes','counters'])
  if(result.sessionId!==owner.sessionId)fail('CONTROL_INVALID_RECEIPT');integer(result.liveSequence)
  if(Object.hasOwn(result,'requestStatus')&&!['inflight','terminal'].includes(result.requestStatus))fail('CONTROL_INVALID_RECEIPT')
  if(Object.hasOwn(owner,'requestId')!==Object.hasOwn(result,'requestStatus'))fail('CONTROL_INVALID_RECEIPT')
  scalarFields(result,['counters','originals']);scalarFields(literal(result.counters,['received','saved','dropped','pending','parseFailed','redacted']))
  if(Object.hasOwn(result,'originals'))scalarFields(literal(result.originals,['file','received','saved','dropped','pending','bytes','redacted','error'],['file','received','saved','dropped','pending','bytes','redacted']))
  preflightCaptureValue(raw,16*1024,16)
  for(const key of ['stoppedAt','roomId','mappingVersion','reason','originals'])if(Object.hasOwn(result,key)&&result[key]===undefined)fail('CONTROL_INVALID_RECEIPT')
  const {sessionId,liveSequence,requestStatus,...stored}=result;validateCaptureSession({...stored,id:sessionId,scope});checkedRoom(result.roomId)
  for(const text of [scope.accountId,raw.operationId,owner.requestId])if(text!==undefined&&Buffer.from(text,'utf8').toString('utf8')!==text)fail('CONTROL_INVALID_RECEIPT')
  if(Buffer.byteLength(JSON.stringify(raw))>CAPTURE_LIVE_RESULT_BYTES)fail('CONTROL_INVALID_RECEIPT')
  return structuredClone(raw) as CaptureLiveControlReceipt
 }catch{fail('CONTROL_INVALID_RECEIPT')}
}
function metadata(db:DatabaseSync):Row{
 const row=db.prepare('SELECT * FROM live_control_meta LIMIT 2').all();if(row.length!==1)fail('CONTROL_SCHEMA_INVALID');const header=row[0] as Row
 if(header.id!==1||header.extension_version!==1||typeof header.database_id!=='string'||header.database_id.length!==36||integer(header.generation,1)!==header.generation)fail('CONTROL_SCHEMA_INVALID')
 for(const[key,wanted]of [['database_id',header.database_id],['generation',String(header.generation)],['schema_version','1']]){const stored=db.prepare('SELECT substr(value,1,65) AS value,length(CAST(value AS BLOB)) AS n FROM database_meta WHERE key=?').get(key);if(stored?.value!==wanted||typeof stored.n!=='number'||stored.n<1||stored.n>64)fail('CONTROL_SCHEMA_INVALID')}
 for(const key of ['control_watermark','metadata_used_bytes','terminal_reserved_bytes'])integer(header[key])
 return header
}
function owner(db:DatabaseSync,scope:AnalysisScope,id:string):Row{
 const row=db.prepare('SELECT * FROM live_session_controls WHERE session_id=? AND account_id=? AND platform=? AND source=?').get(id,scope.accountId,scope.platform,scope.source) as Row|undefined
 if(!row)fail('SESSION_NOT_FOUND');integer(row.control_revision,1);integer(row.terminal_credit_bytes);if(!['prepared','ready','failed'].includes(row.start_state)||[row.stop_requested,row.unclean_epoch,row.counter_loss_known].some(x=>![0,1].includes(x)))fail('CONTROL_SCHEMA_INVALID');return row
}
function session(db:DatabaseSync,scope:AnalysisScope,id:string):AnalysisSession{const meta=metadata(db);return new CaptureSessionMetadataView(db,{databaseId:meta.database_id,generation:meta.generation,schemaVersion:1}).owned(scope,id)}
function requestRow(db:DatabaseSync,scope:AnalysisScope,id:string):Row|undefined{
 const fields={request_digest:64,session_id:36,terminal_receipt_operation_id:1024,error_code:128,action:5,status:8}
 const bounds=db.prepare('SELECT '+Object.keys(fields).map(key=>'length(CAST('+key+' AS BLOB)) AS '+key).join(',')+' FROM live_requests WHERE account_id=? AND request_id=? AND platform=? AND source=?').get(scope.accountId,id,scope.platform,scope.source);if(!bounds)return undefined
 for(const[key,cap]of Object.entries(fields))if(bounds[key]!==null&&(typeof bounds[key]!=='number'||Number(bounds[key])>cap))fail('CONTROL_SCHEMA_INVALID')
 const row=db.prepare('SELECT * FROM live_requests WHERE account_id=? AND request_id=? AND platform=? AND source=?').get(scope.accountId,id,scope.platform,scope.source) as Row
 if(!['start','stop'].includes(row.action)||!['inflight','terminal'].includes(row.status)||typeof row.request_digest!=='string'||!/^[a-f0-9]{64}$/.test(row.request_digest)||![0,1].includes(row.retained_slot))fail('CONTROL_SCHEMA_INVALID')
 try{analysisId(row.session_id);integer(row.created_at);integer(row.request_revision,1);if(row.terminal_receipt_operation_id!==null)analysisString(row.terminal_receipt_operation_id);if(row.status==='terminal'&&row.terminal_receipt_operation_id===null)fail('CONTROL_SCHEMA_INVALID');if(row.error_code!==null&&(!/^[A-Z_]{1,128}$/.test(row.error_code)||![0,1].includes(row.retryable))||row.error_code===null&&row.retryable!==null)fail('CONTROL_SCHEMA_INVALID')}catch{fail('CONTROL_SCHEMA_INVALID')}
 return row
}
function result(db:DatabaseSync,scope:AnalysisScope,id:string,requestId?:string):CaptureLiveControlReceipt['result']{
 const value=session(db,scope,id),sequence=db.prepare('SELECT live_sequence FROM sessions WHERE id=?').get(id)?.live_sequence
 const {id:_,scope:__,...metadata}=value
 return{...metadata,sessionId:id,liveSequence:integer(sequence),...(requestId?{requestStatus:requestRow(db,scope,requestId)?.status}:{})}
}
export function liveRequestDigest(action:'start'|'stop',scope:AnalysisScope,id?:string):string{
 const checked=checkedScope(scope);if(!['start','stop'].includes(action))fail('CONTROL_INVALID_INPUT');if(action==='stop')analysisId(id)
 return createHash('sha256').update(JSON.stringify([action,checked.accountId,checked.platform,checked.source,action==='stop'?id:null])).digest('hex')
}
export function liveControlState(db:DatabaseSync,input:AnalysisScope,id:string){const scope=checkedScope(input);analysisId(id);metadata(db);const row=owner(db,scope,id);return{sessionId:id,revision:row.control_revision,startState:row.start_state,stopRequested:row.stop_requested===1,unclean:row.unclean_epoch===1,counterLossKnown:row.counter_loss_known===1,terminalCreditBytes:row.terminal_credit_bytes}}
export function liveRequest(db:DatabaseSync,input:AnalysisScope,id:string){const scope=checkedScope(input);analysisString(id,128);metadata(db);const row=requestRow(db,scope,id);return row?{requestId:id,action:row.action,requestDigest:row.request_digest,status:row.status,revision:row.request_revision,sessionId:row.session_id,retained:row.retained_slot===1,...(row.terminal_receipt_operation_id?{receiptOperationId:row.terminal_receipt_operation_id}:{}),...(row.error_code?{errorCode:row.error_code,retryable:row.retryable===1}:{})}:undefined}
function receipt(db:DatabaseSync,scope:AnalysisScope,operationId:string):CaptureLiveControlReceipt|undefined{
 const meta=metadata(db),bounds=db.prepare('SELECT length(CAST(result_json AS BLOB)) AS n,length(CAST(intent_digest AS BLOB)) AS digest_n,length(CAST(session_id AS BLOB)) AS session_n,length(CAST(request_id AS BLOB)) AS request_n FROM live_control_receipts WHERE operation_id=? AND account_id=? AND platform=? AND source=?').get(operationId,scope.accountId,scope.platform,scope.source);if(!bounds)return undefined
 if(typeof bounds.n!=='number'||bounds.n>CAPTURE_LIVE_RESULT_BYTES||bounds.digest_n!==64||bounds.session_n!==36||bounds.request_n!==null&&(typeof bounds.request_n!=='number'||bounds.request_n>512))fail('CONTROL_SCHEMA_INVALID')
 const row=db.prepare('SELECT * FROM live_control_receipts WHERE operation_id=? AND account_id=? AND platform=? AND source=?').get(operationId,scope.accountId,scope.platform,scope.source) as Row
 try{
  if(!['prepare-start','start-result','prepare-stop','reject','finish'].includes(row.kind)||row.control_watermark>meta.control_watermark)fail('CONTROL_SCHEMA_INVALID')
  const recordWatermark=Number(db.prepare("SELECT value FROM database_meta WHERE key='commit_watermark'").get()?.value);integer(recordWatermark);if(row.record_watermark_at_commit>recordWatermark)fail('CONTROL_SCHEMA_INVALID')
  owner(db,scope,row.session_id);session(db,scope,row.session_id)
  if(row.request_id!==null){const request=requestRow(db,scope,row.request_id);if(!request||request.session_id!==row.session_id||(row.kind==='prepare-start'||row.kind==='start-result')&&request.action!=='start'||row.kind==='prepare-stop'&&request.action!=='stop')fail('CONTROL_SCHEMA_INVALID')}
  return decodeLiveControlReceipt({protocol:2,mode:'live-control',controlExtensionVersion:1,schemaVersion:1,databaseId:meta.database_id,generation:meta.generation,operationId,intentDigest:row.intent_digest,domain:'session',owner:{scope,sessionId:row.session_id,...(row.request_id!==null?{requestId:row.request_id}:{})},expectedRevision:row.expected_revision,resultRevision:row.result_revision,controlWatermark:row.control_watermark,recordWatermarkAtCommit:row.record_watermark_at_commit,result:JSON.parse(row.result_json),reused:true})
 }catch{fail('CONTROL_SCHEMA_INVALID')}
}
export function liveControlReceipt(db:DatabaseSync,input:AnalysisScope,id:string){const scope=checkedScope(input);analysisString(id);return receipt(db,scope,id)}
function validate(input:CaptureLiveControlCommand):CaptureLiveControlCommand{
 if(!input||typeof input!=='object'||types.isProxy(input))fail('CONTROL_INVALID_INPUT')
 const descriptor=Object.getOwnPropertyDescriptor(input,'kind');if(!descriptor||!('value'in descriptor))fail('CONTROL_INVALID_INPUT');const kind=descriptor.value
 const fields:Record<string,string[]>={'prepare-start':['requestId','requestDigest','session'],'start-result':['sessionId','requestId','ready'],'prepare-stop':['sessionId','requestId','requestDigest'],reject:['sessionId','expectedSequence','allocatedAttempts','reason','delta'],finish:['sessionId','expectedSequence','stoppedAt','reason','knownLoss','requestId']}
 if(typeof kind!=='string'||!Object.hasOwn(fields,kind))fail('CONTROL_DOMAIN_UNSUPPORTED')
 const allowed=['kind','operationId','scope','expectedRevision',...fields[kind]],required=allowed.filter(k=>kind!=='finish'||k!=='requestId');const value=literal(input,allowed,required)
 scalarFields(value,['scope',...(kind==='prepare-start'?['session']:kind==='reject'?['delta']:[])]);scalarFields(literal(value.scope,['accountId','platform','source']))
 if(kind==='prepare-start'){
  const s=literal(value.session,['id','scope','status','complete','createdAt','formatVersion','bytes','counters','mappingVersion','roomId','originals'],['id','scope','status','complete','createdAt','formatVersion','bytes','counters']);scalarFields(s,['scope','counters','originals']);scalarFields(literal(s.scope,['accountId','platform','source']));scalarFields(literal(s.counters,['received','saved','dropped','pending','parseFailed','redacted']));if(s.originals!==undefined)scalarFields(literal(s.originals,['file','received','saved','dropped','pending','bytes','redacted','error'],['file','received','saved','dropped','pending','bytes','redacted']))
 }
 if(kind==='reject'){const d=literal(value.delta,['received','dropped','parseFailed','redacted','originals'],['received','dropped','parseFailed','redacted']);scalarFields(d,['originals']);if(d.originals!==undefined)scalarFields(literal(d.originals,['received','dropped','redacted','error'],['received','dropped','redacted']))}
 preflightCaptureValue(value,CAPTURE_STORAGE_LIMITS.maxRecordBytes,CAPTURE_STORAGE_LIMITS.maxDepth)
 const detached=structuredClone(value);detached.scope=checkedScope(detached.scope);analysisString(detached.operationId);integer(detached.expectedRevision)
 for(const text of [detached.scope.accountId,detached.operationId,detached.requestId])if(text!==undefined&&Buffer.from(text,'utf8').toString('utf8')!==text)fail('CONTROL_INVALID_INPUT')
 if(detached.requestId!==undefined)analysisString(detached.requestId,128)
 if(detached.sessionId!==undefined)analysisId(detached.sessionId)
 if(kind==='prepare-start'){
  literal(detached.session,['id','scope','status','complete','createdAt','formatVersion','bytes','counters','mappingVersion','roomId','originals'],['id','scope','status','complete','createdAt','formatVersion','bytes','counters'])
  literal(detached.session.counters,['received','saved','dropped','pending','parseFailed','redacted'])
  if(detached.session.originals!==undefined)literal(detached.session.originals,['file','received','saved','dropped','pending','bytes','redacted','error'],['file','received','saved','dropped','pending','bytes','redacted'])
  for(const key of ['mappingVersion','roomId','originals'])if(Object.hasOwn(detached.session,key)&&detached.session[key]===undefined)fail('CONTROL_INVALID_INPUT')
  const s=validateCaptureSession(detached.session);checkedRoom(s.roomId);if(!same(s.scope,detached.scope)||s.status!=='collecting'||!s.complete||s.bytes!==0||Object.values(s.counters).some(x=>x!==0)||s.originals&&Object.entries(s.originals).some(([k,v])=>k!=='file'&&v!==0))fail('CONTROL_INVALID_INPUT');detached.session=s
 }
 if(kind==='prepare-start'||kind==='prepare-stop'){const action=kind==='prepare-start'?'start':'stop';if(detached.requestDigest!==liveRequestDigest(action,detached.scope,detached.sessionId))fail('CONTROL_INVALID_INPUT')}
 if(kind==='start-result'&&typeof detached.ready!=='boolean')fail('CONTROL_INVALID_INPUT')
 if(kind==='reject'){
  integer(detached.expectedSequence);integer(detached.allocatedAttempts)
  const d=literal(detached.delta,['received','dropped','parseFailed','redacted','originals'],['received','dropped','parseFailed','redacted']);for(const key of ['received','dropped','parseFailed','redacted'])integer(d[key]);if(!d.received||d.dropped!==d.received||d.parseFailed>d.received||detached.allocatedAttempts>d.received)fail('CONTROL_INVALID_INPUT')
  if(['FORMAT_CHANGED','ROOM_CHANGED'].includes(detached.reason)&&detached.allocatedAttempts!==0)fail('CONTROL_INVALID_INPUT')
  if(d.originals!==undefined){const o=literal(d.originals,['received','dropped','redacted','error'],['received','dropped','redacted']);for(const key of ['received','dropped','redacted'])integer(o[key]);if(o.received>d.received||o.received!==o.dropped||o.error!==undefined&&!/^[A-Z_]{1,128}$/.test(o.error))fail('CONTROL_INVALID_INPUT')}
  if(!validStoredReason(detached.reason))fail('CONTROL_INVALID_INPUT')
 }
 if(kind==='finish'){integer(detached.expectedSequence);integer(detached.stoppedAt);if(typeof detached.knownLoss!=='boolean'||detached.reason!=='operator'&&!validStoredReason(detached.reason))fail('CONTROL_INVALID_INPUT')}
 return detached as CaptureLiveControlCommand
}
function claim(db:DatabaseSync,scope:AnalysisScope,requestId:string,action:'start'|'stop',requestDigest:string,id:string,at:number,limits:Readonly<CaptureLimits>):number{
 const old=db.prepare('SELECT * FROM live_requests WHERE account_id=? AND request_id=?').get(scope.accountId,requestId) as Row|undefined
 if(old){if(old.request_digest!==requestDigest||old.action!==action||old.platform!==scope.platform||old.source!==scope.source||old.session_id!==id)fail('CONTROL_REQUEST_CONFLICT');return 0}
 const slot=db.prepare('SELECT retained_slots FROM live_account_slots WHERE account_id=?').get(scope.accountId) as Row;integer(slot.retained_slots)
 if(slot.retained_slots>=limits.maxIdempotencyRequests){const archive=db.prepare("SELECT request_id FROM live_requests INDEXED BY live_requests_slots WHERE account_id=? AND retained_slot=1 AND status='terminal' ORDER BY created_at,request_id LIMIT 1").get(scope.accountId)
  if(!archive)fail('CONTROL_REQUEST_LIMIT');db.prepare('UPDATE live_requests SET retained_slot=0 WHERE account_id=? AND request_id=?').run(scope.accountId,archive.request_id);db.prepare('UPDATE live_account_slots SET retained_slots=retained_slots-1 WHERE account_id=?').run(scope.accountId)
 }
 db.prepare('INSERT INTO live_requests(account_id,request_id,platform,source,action,request_digest,created_at,status,request_revision,session_id,retained_slot) VALUES(?,?,?,?,?,?,?,\'inflight\',1,?,1)').run(scope.accountId,requestId,scope.platform,scope.source,action,requestDigest,at,id)
 integer(slot.retained_slots+1);db.prepare('UPDATE live_account_slots SET retained_slots=retained_slots+1 WHERE account_id=?').run(scope.accountId)
 return Buffer.byteLength(canonical({scope,requestId,action,requestDigest,sessionId:id,createdAt:at}))+256
}
function checkedNewBudget(db:DatabaseSync,limits:Readonly<CaptureLimits>,used:number,reserved:number){integer(used);integer(reserved);if(used+reserved>limits.maxMetadataBytes||!Number.isSafeInteger(used+reserved))fail('CONTROL_METADATA_LIMIT');const bytes=db.prepare("SELECT substr(value,1,21) AS value,length(CAST(value AS BLOB)) AS n FROM database_meta WHERE key='total_logical_bytes'").get();if(!bytes||typeof bytes.n!=='number'||bytes.n>20||typeof bytes.value!=='string'||!/^(0|[1-9]\d*)$/.test(bytes.value))fail('CONTROL_SCHEMA_INVALID');const total=integer(Number(bytes.value))+used+reserved;if(!Number.isSafeInteger(total)||total>limits.maxStorageBytes)fail('CONTROL_STORAGE_LIMIT')}
/** Ordinary core1 live metadata only; caller has bootstrapped this extension. No authority/worker integration. */
export function executeLiveControl(db:DatabaseSync,input:CaptureLiveControlCommand,inputLimits:Readonly<CaptureLimits>=CAPTURE_STORAGE_LIMITS,hooks?:{checkpoint?:(stage:string)=>void}):CaptureLiveControlReceipt{
 const limits=validateCaptureStorageLimits(inputLimits);let command:CaptureLiveControlCommand
 try{command=validate(input)}catch(error){if(error instanceof CaptureLiveControlError)throw error;fail('CONTROL_INVALID_INPUT')}
 const intentDigest=digest(command);let commitAttempted=false,began=false
 try{
  if(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA synchronous').get()?.synchronous!==2||db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')fail('CONTROL_SCHEMA_INVALID')
  db.exec('BEGIN IMMEDIATE');began=true
  const meta=metadata(db),old=db.prepare('SELECT account_id,platform,source,intent_digest FROM live_control_receipts WHERE operation_id=?').get(command.operationId) as Row|undefined
  if(old){if(old.intent_digest!==intentDigest||old.account_id!==command.scope.accountId||old.platform!==command.scope.platform||old.source!==command.scope.source)fail('CONTROL_OPERATION_CONFLICT');const reused=receipt(db,command.scope,command.operationId)!;db.exec('COMMIT');return reused}
  try{preflightCaptureValue(command,limits.maxRecordBytes,limits.maxDepth)}catch{fail('CONTROL_INVALID_INPUT')}
  const scope=command.scope;let id='sessionId'in command?command.sessionId:command.session.id;let charge=0,revision=0,creditChange=0,terminalRequest=false,errorCode:string|undefined
  const checkpoint=(stage:string)=>hooks?.checkpoint?.(stage)
  if(command.kind==='prepare-start'){
   const existing=db.prepare('SELECT * FROM live_requests WHERE account_id=? AND request_id=?').get(scope.accountId,command.requestId) as Row|undefined
   if(existing){if(existing.request_digest!==command.requestDigest||existing.action!=='start'||existing.platform!==scope.platform||existing.source!==scope.source)fail('CONTROL_REQUEST_CONFLICT');id=existing.session_id}
   else{
    const slot=db.prepare('SELECT * FROM live_account_slots WHERE account_id=?').get(scope.accountId) as Row|undefined
    integer(slot?.revision??0);if((slot?.revision??0)!==command.expectedRevision)fail('CONTROL_REVISION_CONFLICT')
    const active=db.prepare("SELECT id,platform,source,status FROM sessions INDEXED BY capture_active_account WHERE account_id=? AND status IN('collecting','stopping') ORDER BY ordinal DESC LIMIT 2").all(scope.accountId)
    if(active.length>1)fail('CONTROL_STATE_CONFLICT')
    if(active.length){if(active[0].platform!==scope.platform||active[0].source!==scope.source)fail('CONTROL_SOURCE_CONFLICT');id=String(active[0].id);if(active[0].status!=='collecting'||owner(db,scope,id).stop_requested)fail('CONTROL_STATE_CONFLICT')}
    else{
     if(slot?.active_session_id)fail('CONTROL_STATE_CONFLICT')
     insertCaptureSessionInTransaction(db,command.session,limits);checkpoint('session')
     db.prepare("INSERT INTO live_session_controls VALUES(?,?,?,?,1,'prepared',0,1,1,?)").run(id,scope.accountId,scope.platform,scope.source,CAPTURE_LIVE_TERMINAL_CREDIT_BYTES);creditChange=CAPTURE_LIVE_TERMINAL_CREDIT_BYTES;charge+=Buffer.byteLength(canonical(command.session))+256
    }
    if(!slot)db.prepare('INSERT INTO live_account_slots VALUES(?,0,0,NULL,NULL,NULL)').run(scope.accountId)
    if(!active.length){integer((slot?.revision??0)+1);db.prepare('UPDATE live_account_slots SET active_session_id=?,platform=?,source=?,revision=revision+1 WHERE account_id=?').run(id,scope.platform,scope.source,scope.accountId)}
    checkpoint('slot');charge+=claim(db,scope,command.requestId,'start',command.requestDigest,id,command.session.createdAt,limits);checkpoint('request')
   }
   revision=owner(db,scope,id).control_revision
  }else{
   const state=owner(db,scope,id),current=session(db,scope,id)
   if(state.control_revision!==command.expectedRevision)fail('CONTROL_REVISION_CONFLICT')
   integer(state.control_revision+1)
   if(command.kind==='prepare-stop'){
    charge+=claim(db,scope,command.requestId,'stop',command.requestDigest,id,current.createdAt,limits);checkpoint('request')
    if(['completed','interrupted','storage-error'].includes(current.status))terminalRequest=true
    else db.prepare("UPDATE sessions SET status='stopping' WHERE id=?").run(id)
    db.prepare('UPDATE live_session_controls SET stop_requested=1,control_revision=control_revision+1 WHERE session_id=?').run(id)
   }else if(command.kind==='start-result'){
    const request=requestRow(db,scope,command.requestId);if(!request||request.session_id!==id||request.action!=='start'||request.status!=='inflight')fail('CONTROL_STATE_CONFLICT')
    if(!command.ready){
     if(!['completed','interrupted','storage-error'].includes(current.status)||state.start_state!=='failed')fail('CONTROL_STATE_CONFLICT')
     // One explicit failed alias only: no session/slot rewrite or source replay.
     db.prepare('UPDATE live_session_controls SET control_revision=control_revision+1 WHERE session_id=?').run(id);errorCode='START_FAILED'
    }else{
     if(!['prepared','ready'].includes(state.start_state)||state.stop_requested||current.status!=='collecting')fail('CONTROL_STATE_CONFLICT')
     db.prepare("UPDATE live_session_controls SET start_state='ready',control_revision=control_revision+1 WHERE session_id=?").run(id)
    }
    terminalRequest=true
   }else if(command.kind==='reject'){
    if(!['collecting','stopping'].includes(current.status))fail('CONTROL_STATE_CONFLICT')
    const live=integer(db.prepare('SELECT live_sequence FROM sessions WHERE id=?').get(id)?.live_sequence);if(live!==command.expectedSequence)fail('CONTROL_SEQUENCE_CONFLICT')
    const d=command.delta,o=d.originals;for(const[k,v]of Object.entries(d)){if(k!=='originals')integer((current.counters as any)[k]+v)}integer(live+command.allocatedAttempts)
    if(o&&current.originals){integer(current.originals.received+o.received);integer(current.originals.dropped+o.dropped);integer(current.originals.redacted+o.redacted)}
    db.prepare("UPDATE sessions SET received=received+?,dropped=dropped+?,parse_failed=parse_failed+?,redacted=redacted+?,live_sequence=live_sequence+?,original_received=original_received+?,original_dropped=original_dropped+?,original_redacted=original_redacted+?,original_error=COALESCE(?,original_error),has_originals=CASE WHEN ? THEN 1 ELSE has_originals END,complete=0,field_complete=0,status='stopping',reason=COALESCE(reason,?) WHERE id=?").run(d.received,d.dropped,d.parseFailed,d.redacted,command.allocatedAttempts,o?.received??0,o?.dropped??0,o?.redacted??0,o?.error??null,o?1:0,command.reason,id)
    db.prepare('UPDATE live_session_controls SET stop_requested=1,control_revision=control_revision+1 WHERE session_id=?').run(id)
   }else{
    if(!['collecting','stopping'].includes(current.status))fail('CONTROL_STATE_CONFLICT')
    const live=integer(db.prepare('SELECT live_sequence FROM sessions WHERE id=?').get(id)?.live_sequence);if(live!==command.expectedSequence)fail('CONTROL_SEQUENCE_CONFLICT')
    const reason=current.reason??(command.reason==='operator'||command.reason==='APP_SHUTDOWN'?undefined:command.reason)??(!command.knownLoss?'COUNTERS_INCOMPLETE':undefined)
    const complete=current.complete&&command.knownLoss&&current.counters.dropped===0&&current.counters.pending===0&&(!current.originals||current.originals.dropped===0&&current.originals.pending===0&&!current.originals.error)
    db.prepare('UPDATE sessions SET status=?,complete=?,stopped_at=?,reason=?,pending=0,original_pending=0 WHERE id=?').run(reason?'interrupted':'completed',complete?1:0,command.stoppedAt,reason??null,id)
    db.prepare("UPDATE live_session_controls SET start_state=CASE WHEN start_state='prepared' THEN 'failed' ELSE start_state END,stop_requested=1,unclean_epoch=?,counter_loss_known=?,terminal_credit_bytes=0,control_revision=control_revision+1 WHERE session_id=?").run(command.knownLoss?0:1,command.knownLoss?1:0,id)
    const slot=db.prepare('SELECT revision FROM live_account_slots WHERE account_id=? AND active_session_id=?').get(scope.accountId,id);if(slot)integer(Number(slot.revision)+1)
    db.prepare('UPDATE live_account_slots SET active_session_id=NULL,platform=NULL,source=NULL,revision=revision+1 WHERE account_id=? AND active_session_id=?').run(scope.accountId,id)
    creditChange=-state.terminal_credit_bytes;terminalRequest=command.requestId!==undefined
    if(terminalRequest){const request=requestRow(db,scope,command.requestId!);if(!request||request.session_id!==id||request.status!=='inflight')fail('CONTROL_STATE_CONFLICT');if(request.action==='start')errorCode='START_FAILED'}
   }
   checkpoint('session');revision=owner(db,scope,id).control_revision;charge+=Buffer.byteLength(canonical(session(db,scope,id)))+256
  }
  const requestId='requestId'in command?command.requestId:undefined
  const state=result(db,scope,id,requestId);if(terminalRequest)state.requestStatus='terminal'
  const watermark=integer(meta.control_watermark+1,1),recordWatermark=integer(Number(db.prepare("SELECT value FROM database_meta WHERE key='commit_watermark'").get()?.value))
  const output:CaptureLiveControlReceipt={protocol:2,mode:'live-control',controlExtensionVersion:1,schemaVersion:1,databaseId:meta.database_id,generation:meta.generation,operationId:command.operationId,intentDigest,domain:'session',owner:{scope,sessionId:id,...(requestId?{requestId}:{})},expectedRevision:command.expectedRevision,resultRevision:revision,controlWatermark:watermark,recordWatermarkAtCommit:recordWatermark,result:state,reused:false}
  if(Buffer.byteLength(JSON.stringify(output))>CAPTURE_LIVE_RESULT_BYTES)fail('CONTROL_RESULT_LIMIT')
  decodeLiveControlReceipt(output)
  // Conservative logical metadata billing: immutable receipt, full rewritten session
  // above, plus the complete control/slot/request snapshots and fixed header overhead.
  charge+=Buffer.byteLength(JSON.stringify(output))+Buffer.byteLength(canonical(owner(db,scope,id)))+256+512
  const slotBill=db.prepare('SELECT * FROM live_account_slots WHERE account_id=?').get(scope.accountId);if(slotBill)charge+=Buffer.byteLength(canonical(slotBill))+256
  if(terminalRequest){const request=requestRow(db,scope,requestId!);if(request){integer(request.request_revision+1);charge+=Buffer.byteLength(canonical({...request,status:'terminal',request_revision:request.request_revision+1,terminal_receipt_operation_id:command.operationId,error_code:errorCode??null,retryable:errorCode?0:null}))+256}}
  const used=integer(meta.metadata_used_bytes+charge),reserved=integer(meta.terminal_reserved_bytes+creditChange);checkedNewBudget(db,limits,used,reserved)
  db.prepare('INSERT INTO live_control_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(output.operationId,intentDigest,command.kind,scope.accountId,scope.platform,scope.source,id,requestId??null,command.expectedRevision,revision,watermark,recordWatermark,JSON.stringify(state));checkpoint('receipt')
  if(terminalRequest){const request=requestRow(db,scope,requestId!);if(request?.status==='inflight')integer(request.request_revision+1);db.prepare("UPDATE live_requests SET status='terminal',request_revision=request_revision+1,terminal_receipt_operation_id=?,error_code=?,retryable=? WHERE account_id=? AND request_id=? AND status='inflight'").run(command.operationId,errorCode??null,errorCode?0:null,scope.accountId,requestId!)}
  db.prepare('UPDATE live_control_meta SET control_watermark=?,metadata_used_bytes=?,terminal_reserved_bytes=? WHERE id=1').run(watermark,used,reserved)
  checkpoint('before-commit');commitAttempted=true;db.exec('COMMIT');checkpoint('after-commit');return output
 }catch(error){if(began)try{db.exec('ROLLBACK')}catch{};if(commitAttempted)fail('CONTROL_COMMIT_UNCERTAIN');if(error instanceof CaptureLiveControlError)throw error;if((error as any)?.code==='SESSION_NOT_FOUND')fail('SESSION_NOT_FOUND');fail('CONTROL_FAILED')}
}
