import type {CaptureLimits,AnalysisScope} from '../../../../shared/analysisRoom'
import type {CaptureDatabaseIdentity} from './CaptureStorage'
import type {CaptureWorkerCommand} from './CaptureWorkerProtocol'
import type {CaptureLiveControlCommand} from './CaptureLiveControl'
import type {SessionImportIntent} from './CaptureTypedStageImport'
import {serialize,deserialize} from 'node:v8'
import {types} from 'node:util'
import {analysisId,analysisInteger,analysisString,validateAnalysisScope} from '../../../../shared/analysisRoom'
import {validateCaptureStorageLimits} from './CaptureStorage'
import {preflightCaptureValue,captureSafeCode} from './CaptureWorkerProtocol'
import {validateCaptureSession,validateObservationEnvelope,validStoredReason} from './CaptureRecordValidation'
import {decodeSessionImportReceipt} from './CaptureTypedStageImport'
import {decodeLiveControlReceipt,liveRequestDigest} from './CaptureLiveControl'

export type CaptureWorkerModeV2='typed-stage'|'live-control'
export type CaptureProtocolContextV2=
 | {mode:'typed-stage';identity:CaptureDatabaseIdentity;limits:Readonly<CaptureLimits>;runId:string}
 | {mode:'live-control';identity:CaptureDatabaseIdentity;limits:Readonly<CaptureLimits>}
export type TypedStageCommandV2=
 | {method:'beginSessionImport'|'stepSessionImport';intent:SessionImportIntent}
 | {method:'sessionImportReceipt';operationId:string}
export type LiveCommandV2=Exclude<CaptureWorkerCommand,{method:'insertSession'}>
 | {method:'control';input:CaptureLiveControlCommand}
 | {method:'controlReceipt';scope:AnalysisScope;operationId:string}
 | {method:'liveRequest';scope:AnalysisScope;requestId:string}
 | {method:'controlState';scope:AnalysisScope;sessionId:string}
export type CaptureWorkerRequestV2=
 | {version:2;mode:'typed-stage';id:number;command:TypedStageCommandV2}
 | {version:2;mode:'live-control';id:number;command:LiveCommandV2}
export type CaptureWorkerReplyV2={version:2;mode:CaptureWorkerModeV2;id:number;identity:CaptureDatabaseIdentity;scope?:AnalysisScope}&
 ({ok:true;value:unknown}|{ok:false;code:string})
/** Small pending-owner metadata only: no request payload, byte buffers or startup paths. */
export interface CaptureReplyExpectationV2{
 tag:'capture-v2-expectation';version:2;mode:CaptureWorkerModeV2;id:number;method:string;identity:CaptureDatabaseIdentity;
 scope?:AnalysisScope;runId?:string;operationId?:string;sessionId?:string;requestId?:string;expectedRevision?:number;
 controlKind?:CaptureLiveControlCommand['kind'];resultSequence?:number;limit?:number;upperPosition?:number;afterPosition?:number;upperOrder?:number;beforeOrder?:number
}
export type CaptureReplyExpectedV2=CaptureWorkerRequestV2|CaptureReplyExpectationV2
export class CaptureProtocolV2Error extends Error{constructor(readonly code:string){super(code)}}
export const CAPTURE_V2_MUTATING_METHODS=Object.freeze({
 'typed-stage':Object.freeze(['beginSessionImport','stepSessionImport'] as const),
 'live-control':Object.freeze(['control','commit'] as const),
})
export const CAPTURE_V2_READING_METHODS=Object.freeze({
 'typed-stage':Object.freeze(['sessionImportReceipt'] as const),
 'live-control':Object.freeze(['session','receipt','sessionPage','recordPage','fieldSummary','controlReceipt','liveRequest','controlState'] as const),
})
const domainCodes=new Set(`CONTROL_COMMIT_UNCERTAIN CONTROL_DOMAIN_UNSUPPORTED CONTROL_FAILED CONTROL_INVALID_INPUT CONTROL_INVALID_RECEIPT CONTROL_METADATA_LIMIT CONTROL_OPERATION_CONFLICT CONTROL_REQUEST_CONFLICT CONTROL_REQUEST_LIMIT CONTROL_RESULT_LIMIT CONTROL_REVISION_CONFLICT CONTROL_SCHEMA_INVALID CONTROL_SEQUENCE_CONFLICT CONTROL_SOURCE_CONFLICT CONTROL_STATE_CONFLICT CONTROL_STORAGE_LIMIT INVALID_CAPTURE_LIMITS TYPED_CAPACITY_LIMIT TYPED_CORE_NOT_EMPTY TYPED_DURABILITY_INVALID TYPED_IMPORT_ABORTED TYPED_IMPORT_FAILED TYPED_INPUT_INVALID TYPED_OPERATION_CONFLICT TYPED_POLICY_MISMATCH TYPED_RECEIPT_INVALID TYPED_ROW_LIMIT TYPED_SOURCE_INVALID TYPED_STALE_REVISION TYPED_STATE_INVALID TYPED_UNEXPECTED_EFFECT TYPED_WORK_LIMIT TYPED_ADMISSION_LIMIT TYPED_BINDING_CONFLICT TYPED_BOOTSTRAP_LIMIT TYPED_CAPTURE_LINK_MISMATCH TYPED_CHARGE_BINDING_MISMATCH TYPED_DECLARATION_BINDING_MISMATCH TYPED_DESCRIPTOR_INVALID TYPED_DESCRIPTOR_LIMIT TYPED_EXTENT_MISMATCH TYPED_HEADER_INVALID TYPED_IDENTITY_CONFLICT TYPED_MANIFEST_CONFLICT TYPED_MANIFEST_SEALED TYPED_NATIVE_BINDING_MISMATCH TYPED_RUN_BINDING_MISMATCH TYPED_SCHEMA_CREATE_FAILED TYPED_SCHEMA_INVALID TYPED_SOURCE_BINDING_MISMATCH TYPED_STAGE_NOT_VERIFIED TYPED_UNIT_OWNER_MISMATCH COMMIT_UNCERTAIN ABORTED QUEUE_FULL DATABASE_CLOSING DATABASE_UNAVAILABLE WORKER_FAILED WORKER_PROTOCOL_ERROR WORKER_EXITED REQUEST_TIMEOUT WORKER_CLOSE_TIMEOUT V2_INVALID_REQUEST V2_INVALID_REPLY V2_LIMIT`.split(' '))
for(const code of ['ACTIVE_INDEX_UNAVAILABLE','INVALID_METADATA_REQUEST','METADATA_UNAVAILABLE','METADATA_IDENTITY_MISMATCH','METADATA_INVALID'])domainCodes.add(code)
function knownCode(value:unknown):value is string{return typeof value==='string'&&value.length>0&&(domainCodes.has(value)||captureSafeCode({code:value},'')===value)}
/** Error text/cause and accessor/proxy code properties never reach a reply. */
export function captureSafeCodeV2(error:unknown):string{
 if(!error||typeof error!=='object'||types.isProxy(error))return'WORKER_OPERATION_FAILED'
 const descriptor=Object.getOwnPropertyDescriptor(error,'code');return descriptor&&'value'in descriptor&&knownCode(descriptor.value)?descriptor.value:'WORKER_OPERATION_FAILED'
}
type ObjectValue=Record<string,any>
function fail(code:string):never{throw new CaptureProtocolV2Error(code)}
function own(value:unknown,allowed:readonly string[],required:readonly string[]=allowed):ObjectValue{
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('V2_INVALID_REQUEST')
 const out:ObjectValue={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=='string'||!allowed.includes(key)||!d.enumerable||!('value'in d))fail('V2_INVALID_REQUEST');out[key]=d.value}
 if(required.some(key=>!Object.hasOwn(out,key)))fail('V2_INVALID_REQUEST');return out
}
function mode(value:unknown):CaptureWorkerModeV2{if(value!=='typed-stage'&&value!=='live-control')fail('V2_INVALID_REQUEST');return value}
function scope(value:unknown):AnalysisScope{return validateAnalysisScope(own(value,['accountId','platform','source']))}
function identity(value:unknown):CaptureDatabaseIdentity{const i=own(value,['databaseId','generation','schemaVersion']);if(i.schemaVersion!==1)fail('V2_INVALID_REQUEST');return{databaseId:analysisId(i.databaseId),generation:analysisInteger(i.generation,1),schemaVersion:1}}
const sameScope=(a:AnalysisScope,b:AnalysisScope)=>a.accountId===b.accountId&&a.platform===b.platform&&a.source===b.source
const sameIdentity=(a:CaptureDatabaseIdentity,b:CaptureDatabaseIdentity)=>a.databaseId===b.databaseId&&a.generation===b.generation&&a.schemaVersion===b.schemaVersion
function contextValue(value:CaptureProtocolContextV2):CaptureProtocolContextV2{
 const c=own(value,['mode','identity','limits','runId'],['mode','identity','limits']),m=mode(c.mode)
 if(types.isProxy(c.limits))fail('V2_INVALID_REQUEST');const limits=validateCaptureStorageLimits(c.limits),i=identity(c.identity)
 if(m==='typed-stage')return{mode:m,identity:i,limits,runId:analysisId(c.runId)}
 if(Object.hasOwn(c,'runId'))fail('V2_INVALID_REQUEST');return{mode:m,identity:i,limits}
}
/** Check hooks/prototypes before the existing budget walk can inspect nested values. */
function safeGraph(value:unknown,bytesAllowed:boolean,maxDepth=28):void{
 const ancestors=new Set<object>();let nodes=0
 const visit=(v:unknown,depth:number):void=>{
  if(++nodes>65536||depth>maxDepth)fail('V2_LIMIT')
  if(v===null||v===undefined||typeof v==='string'||typeof v==='boolean')return
  if(typeof v==='number'){if(!Number.isFinite(v))fail('V2_INVALID_REQUEST');return}
  if(typeof v!=='object'||types.isProxy(v))fail('V2_INVALID_REQUEST')
  if(ArrayBuffer.isView(v)){
   if(!bytesAllowed||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(v)))fail('V2_INVALID_REQUEST')
   for(const key of ['byteLength','byteOffset','buffer','length'])if(Object.hasOwn(v,key))fail('V2_INVALID_REQUEST')
   if(types.isSharedArrayBuffer((v as Uint8Array).buffer))fail('V2_INVALID_REQUEST');return
  }
  const array=Array.isArray(v);if(array?Object.getPrototypeOf(v)!==Array.prototype:![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('V2_INVALID_REQUEST');if(ancestors.has(v))fail('V2_INVALID_REQUEST')
  if(array&&(v as unknown[]).length>=65536)fail('V2_LIMIT');ancestors.add(v)
  let keys=0;for(const key in v){if(++keys>65536)fail('V2_LIMIT')}
  for(const key of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,key)!;if(typeof key!=='string'||!('value'in d))fail('V2_INVALID_REQUEST');if(array&&key==='length')continue;if(!d.enumerable||array&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=(v as unknown[]).length))fail('V2_INVALID_REQUEST');visit(d.value,depth+1)}
  ancestors.delete(v)
 };visit(value,0)
}
function budget(value:unknown,bytes:number,depth=28):void{try{preflightCaptureValue(value,bytes,depth)}catch{fail('V2_LIMIT')}}
function json(value:unknown):void{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return
 if(Array.isArray(value)){for(const item of value)json(item);return}
 if(value&&typeof value==='object'&&!ArrayBuffer.isView(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))){for(const item of Object.values(value))json(item);return}fail('V2_INVALID_REQUEST')
}
function checkedSession(value:unknown):ReturnType<typeof validateCaptureSession>{
 const v=own(value,['id','scope','status','complete','createdAt','stoppedAt','roomId','formatVersion','mappingVersion','counters','bytes','reason','originals'],['id','scope','status','complete','createdAt','formatVersion','counters','bytes']);scope(v.scope);own(v.counters,['received','saved','dropped','pending','parseFailed','redacted'])
 if(Object.hasOwn(v,'originals'))own(v.originals,['file','received','saved','dropped','pending','bytes','redacted','error'],['file','received','saved','dropped','pending','bytes','redacted'])
 for(const key of ['stoppedAt','roomId','mappingVersion','reason','originals'])if(Object.hasOwn(v,key)&&v[key]===undefined)fail('V2_INVALID_REQUEST')
 return validateCaptureSession(v)
}
function checkedRecord(value:unknown,limits:Readonly<CaptureLimits>):ObjectValue{
 const keys=['scope','observationId','streamId','sequence','receivedAt','platformTime','sourceMessageId','roomId','businessType','formatVersion','failureCode','provenance','complete','removedPaths','truncatedPaths','data','sessionId','recordSequence','mappingVersion']
 const v=own(value,keys,['scope','observationId','streamId','sequence','receivedAt','formatVersion','complete','removedPaths','truncatedPaths','data','sessionId','recordSequence']);scope(v.scope);analysisId(v.sessionId);analysisInteger(v.recordSequence,1);validateObservationEnvelope(v);if(v.mappingVersion!==undefined)analysisInteger(v.mappingVersion,1);json(v.data);budget(v.data,limits.maxRecordBytes,limits.maxDepth);return v
}
function checkedControl(value:unknown):void{
 const header=own(value,['kind','operationId','scope','expectedRevision','requestId','requestDigest','session','sessionId','ready','expectedSequence','allocatedAttempts','reason','delta','stoppedAt','knownLoss'],['kind','operationId','scope','expectedRevision'])
 if(typeof header.kind!=='string')fail('V2_INVALID_REQUEST')
 const fields:Record<string,string[]>={'prepare-start':['requestId','requestDigest','session'],'start-result':['sessionId','requestId','ready'],'prepare-stop':['sessionId','requestId','requestDigest'],reject:['sessionId','expectedSequence','allocatedAttempts','reason','delta'],finish:['sessionId','expectedSequence','stoppedAt','reason','knownLoss','requestId']}
 if(!Object.hasOwn(fields,header.kind))fail('V2_INVALID_REQUEST');const keys=['kind','operationId','scope','expectedRevision',...fields[header.kind]],c=own(value,keys,keys.filter(k=>header.kind!=='finish'||k!=='requestId'))
 const owner=scope(c.scope);analysisString(c.operationId);analysisInteger(c.expectedRevision);if(c.requestId!==undefined)analysisString(c.requestId,128);if(c.sessionId!==undefined)analysisId(c.sessionId)
 if(c.kind==='prepare-start'){const s=checkedSession(c.session);if(!sameScope(owner,s.scope)||s.status!=='collecting')fail('V2_INVALID_REQUEST')}
 if(c.kind==='prepare-start'||c.kind==='prepare-stop'){if(typeof c.requestDigest!=='string'||!/^[0-9a-f]{64}$/.test(c.requestDigest))fail('V2_INVALID_REQUEST')}
 if(c.kind==='start-result'&&typeof c.ready!=='boolean')fail('V2_INVALID_REQUEST')
 if(c.kind==='finish'){analysisInteger(c.expectedSequence);analysisInteger(c.stoppedAt);if(typeof c.knownLoss!=='boolean'||c.reason!=='operator'&&!validStoredReason(c.reason))fail('V2_INVALID_REQUEST')}
 if(c.kind==='reject'){analysisInteger(c.expectedSequence);analysisInteger(c.allocatedAttempts);if(!validStoredReason(c.reason))fail('V2_INVALID_REQUEST');const d=own(c.delta,['received','dropped','parseFailed','redacted','originals'],['received','dropped','parseFailed','redacted']);for(const k of ['received','dropped','parseFailed','redacted'])analysisInteger(d[k]);if(d.originals!==undefined){const o=own(d.originals,['received','dropped','redacted','error'],['received','dropped','redacted']);for(const k of ['received','dropped','redacted'])analysisInteger(o[k]);if(o.error!==undefined&&(typeof o.error!=='string'||!/^[A-Z_]{1,128}$/.test(o.error)))fail('V2_INVALID_REQUEST')}}
}
function methodFor(modeValue:CaptureWorkerModeV2,command:unknown):string{
 const c=own(command,['method','intent','operationId','input','scope','sessionId','requestId','limit','seek'],['method']);if(typeof c.method!=='string'||![...CAPTURE_V2_MUTATING_METHODS[modeValue],...CAPTURE_V2_READING_METHODS[modeValue]].includes(c.method as never))fail('V2_INVALID_REQUEST');return c.method
}
export function isCaptureWriteV2(modeValue:unknown,command:unknown):boolean{try{const m=mode(modeValue),method=methodFor(m,command);return (CAPTURE_V2_MUTATING_METHODS[m] as readonly string[]).includes(method)}catch{fail('V2_INVALID_REQUEST')}}
function commandValue(value:unknown,c:CaptureProtocolContextV2):void{
 const method=methodFor(c.mode,value),v=value as ObjectValue
 if(c.mode==='typed-stage'){
  if(method==='sessionImportReceipt'){own(value,['method','operationId']);analysisId(v.operationId)}
  else{own(value,['method','intent']);const intent=own(v.intent,['operationId','expectedRevision']);analysisId(intent.operationId);analysisInteger(intent.expectedRevision);if(method==='beginSessionImport'&&intent.expectedRevision!==0)fail('V2_INVALID_REQUEST')};return
 }
 if(method==='control'){own(value,['method','input']);checkedControl(v.input);return}
 if(method==='commit'){
  own(value,['method','input']);const i=own(v.input,['operationId','sessionId','expectedSequence','record','recordLine','originalLine','originalJson','protobufBase64','shard','nextOffset','delta'],['operationId','sessionId','expectedSequence','record','recordLine','shard','nextOffset','delta']);analysisString(i.operationId);analysisId(i.sessionId);analysisInteger(i.expectedSequence);const record=checkedRecord(i.record,c.limits);if(record.sessionId!==i.sessionId)fail('V2_INVALID_REQUEST')
  for(const key of ['recordLine','originalLine','originalJson'])if(i[key]!==undefined){if(!(i[key] instanceof Uint8Array)||i[key].byteLength>c.limits.maxRecordBytes)fail('V2_LIMIT')}
  if(!(i.recordLine instanceof Uint8Array)||typeof i.shard!=='string'||!/^\d{6}\.jsonl$/.test(i.shard))fail('V2_INVALID_REQUEST');analysisInteger(i.nextOffset,0,c.limits.maxShardBytes);if(i.protobufBase64!==undefined&&(typeof i.protobufBase64!=='string'||i.protobufBase64.length>c.limits.maxRecordBytes*2))fail('V2_LIMIT')
  const d=own(i.delta,['received','saved','dropped','pending','parseFailed','redacted','bytes','originals'],['received','saved','dropped','pending','parseFailed','redacted','bytes']);for(const key of ['received','saved','dropped','pending','parseFailed','redacted','bytes'])analysisInteger(d[key]);if(d.originals!==undefined){const o=own(d.originals,['file','received','saved','dropped','pending','bytes','redacted','error'],[]);for(const key of ['received','saved','dropped','pending','bytes','redacted'])if(o[key]!==undefined)analysisInteger(o[key]);if(o.file!==undefined&&o.file!=='originals.jsonl'||o.error!==undefined&&(typeof o.error!=='string'||!/^[A-Z_]{1,128}$/.test(o.error)))fail('V2_INVALID_REQUEST')};return
 }
 const extra:Record<string,string[]>={session:['sessionId'],fieldSummary:['sessionId'],receipt:['sessionId','operationId'],recordPage:['sessionId','limit','seek'],sessionPage:['limit','seek'],controlReceipt:['operationId'],liveRequest:['requestId'],controlState:['sessionId']};const keys=['method','scope',...extra[method]];own(value,keys,keys.filter(k=>method!=='sessionPage'||k!=='seek'));scope(v.scope)
 if(v.sessionId!==undefined)analysisId(v.sessionId);if(v.operationId!==undefined)analysisString(v.operationId);if(v.requestId!==undefined)analysisString(v.requestId,128);if(v.limit!==undefined)analysisInteger(v.limit,1,100)
 if(method==='recordPage'){const seek=own(v.seek,['upperPosition','afterPosition'],['upperPosition']);analysisInteger(seek.upperPosition);if(seek.afterPosition!==undefined)analysisInteger(seek.afterPosition)}
 if(method==='sessionPage'&&v.seek!==undefined){const seek=own(v.seek,['upperOrder','beforeOrder'],['upperOrder']);analysisInteger(seek.upperOrder);if(seek.beforeOrder!==undefined)analysisInteger(seek.beforeOrder)}
}
function requestValue(value:unknown,c:CaptureProtocolContextV2,detach=true):CaptureWorkerRequestV2{
 const r=own(value,['version','mode','id','command']);if(r.version!==2||r.mode!==c.mode)fail('V2_INVALID_REQUEST');analysisInteger(r.id,1);safeGraph(r,true);budget(r,Math.min(c.limits.maxMetadataBytes,c.limits.maxPendingBytes/2));commandValue(r.command,c);return (detach?structuredClone(r):r) as CaptureWorkerRequestV2
}
export function validateCaptureRequestV2(value:unknown,context:CaptureProtocolContextV2):CaptureWorkerRequestV2{try{return requestValue(value,contextValue(context))}catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REQUEST')}}
function packet(value:unknown,cap:number):Buffer{const encoded=serialize(value);if(encoded.byteLength>cap)fail('V2_LIMIT');if(encoded.byteOffset===0&&encoded.byteLength===encoded.buffer.byteLength)return encoded;const owned=Buffer.allocUnsafeSlow(encoded.byteLength);encoded.copy(owned);return owned}
export function encodeCaptureRequestV2(value:unknown,context:CaptureProtocolContextV2):Buffer{try{const c=contextValue(context),r=validateCaptureRequestV2(value,c);return packet(r,Math.min(c.limits.maxPendingBytes/2,c.limits.maxMetadataBytes))}catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REQUEST')}}
function raw(buffer:unknown,cap:number,error:string):unknown{
 if(types.isProxy(buffer)||!types.isArrayBuffer(buffer)||Reflect.ownKeys(buffer as object).length)fail(error)
 const length=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!.call(buffer);if(length>cap)fail('V2_LIMIT')
 try{return deserialize(new Uint8Array(buffer as ArrayBuffer))}catch{fail(error)}
}
export function decodeCaptureRequestV2(buffer:unknown,context:CaptureProtocolContextV2):CaptureWorkerRequestV2{try{const c=contextValue(context);return validateCaptureRequestV2(raw(buffer,Math.min(c.limits.maxPendingBytes/2,c.limits.maxMetadataBytes),'V2_INVALID_REQUEST'),c)}catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REQUEST')}}
function requestScope(req:CaptureWorkerRequestV2):AnalysisScope{const c=req.command as ObjectValue;return c.method==='control'?scope(c.input.scope):c.method==='commit'?scope(c.input.record.scope):scope(c.scope)}
function expectationValue(value:unknown,c:CaptureProtocolContextV2):CaptureReplyExpectationV2{
 const possible=['tag','version','mode','id','method','identity','scope','runId','operationId','sessionId','requestId','expectedRevision','controlKind','resultSequence','limit','upperPosition','afterPosition','upperOrder','beforeOrder'],header=own(value,possible,['tag','version','mode','id','method','identity'])
 if(header.tag!=='capture-v2-expectation'||header.version!==2||header.mode!==c.mode||!sameIdentity(identity(header.identity),c.identity))fail('V2_INVALID_REQUEST');analysisInteger(header.id,1);const method=methodFor(c.mode,{method:header.method}),required=['tag','version','mode','id','method','identity'],optional:string[]=[]
 if(c.mode==='typed-stage'){required.push('runId','operationId');if(header.runId!==c.runId)fail('V2_INVALID_REQUEST');analysisId(header.operationId);if(method!=='sessionImportReceipt')required.push('expectedRevision')}
 else{
  required.push('scope');scope(header.scope)
  if(method==='control'){
   required.push('controlKind','operationId','expectedRevision');if(typeof header.controlKind!=='string'||!['prepare-start','start-result','prepare-stop','reject','finish'].includes(header.controlKind))fail('V2_INVALID_REQUEST')
   if(header.controlKind!=='prepare-start')required.push('sessionId');if(['prepare-start','start-result','prepare-stop'].includes(header.controlKind))required.push('requestId');if(header.controlKind==='finish')optional.push('requestId');if(['reject','finish'].includes(header.controlKind))required.push('resultSequence')
  }else if(method==='commit'||method==='receipt')required.push('sessionId','operationId')
  else if(method==='controlReceipt')required.push('operationId')
  else if(method==='liveRequest')required.push('requestId')
  else if(method==='sessionPage'){required.push('limit');optional.push('upperOrder','beforeOrder')}
  else if(method==='recordPage')required.push('sessionId','limit','upperPosition','afterPosition')
  else required.push('sessionId')
 }
 const p=own(value,[...required,...optional],required);safeGraph(p,false);budget(p,4096)
 for(const key of ['expectedRevision','resultSequence','upperPosition','afterPosition','upperOrder','beforeOrder'])if(Object.hasOwn(p,key))analysisInteger(p[key]);if(p.limit!==undefined)analysisInteger(p.limit,1,100);if(p.sessionId!==undefined)analysisId(p.sessionId);if(p.requestId!==undefined)analysisString(p.requestId,128);if(p.operationId!==undefined)analysisString(p.operationId)
 if(c.mode==='typed-stage'&&method==='beginSessionImport'&&p.expectedRevision!==0)fail('V2_INVALID_REQUEST');return structuredClone(p) as CaptureReplyExpectationV2
}
export function projectCaptureReplyExpectationV2(value:CaptureWorkerRequestV2,context:CaptureProtocolContextV2):CaptureReplyExpectationV2{
 try{
  const c=contextValue(context),r=requestValue(value,c,false),cmd=r.command as ObjectValue,p:ObjectValue={tag:'capture-v2-expectation',version:2,mode:r.mode,id:r.id,method:cmd.method,identity:c.identity}
  if(c.mode==='typed-stage'){p.runId=c.runId;p.operationId=cmd.intent?.operationId??cmd.operationId;if(cmd.intent)p.expectedRevision=cmd.intent.expectedRevision}
  else{
   p.scope=requestScope(r)
   if(cmd.method==='control'){const i=cmd.input;p.controlKind=i.kind;p.operationId=i.operationId;p.expectedRevision=i.expectedRevision;if(i.kind!=='prepare-start')p.sessionId=i.sessionId;if(i.requestId!==undefined)p.requestId=i.requestId;if(i.kind==='reject')p.resultSequence=analysisInteger(i.expectedSequence+i.allocatedAttempts);if(i.kind==='finish')p.resultSequence=i.expectedSequence}
   else if(cmd.method==='commit'){p.operationId=cmd.input.operationId;p.sessionId=cmd.input.sessionId}
   else{for(const key of ['operationId','sessionId','requestId','limit'])if(cmd[key]!==undefined)p[key]=cmd[key];if(cmd.method==='recordPage'){p.upperPosition=cmd.seek.upperPosition;p.afterPosition=cmd.seek.afterPosition??0}if(cmd.method==='sessionPage'&&cmd.seek){p.upperOrder=cmd.seek.upperOrder;if(cmd.seek.beforeOrder!==undefined)p.beforeOrder=cmd.seek.beforeOrder}}
  }
  return expectationValue(p,c)
 }catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REQUEST')}
}
function expectedValue(value:CaptureReplyExpectedV2,c:CaptureProtocolContextV2):CaptureReplyExpectationV2{
 if(!value||typeof value!=='object'||types.isProxy(value))fail('V2_INVALID_REPLY');const tag=Object.getOwnPropertyDescriptor(value,'tag');return tag&&'value'in tag&&tag.value==='capture-v2-expectation'?expectationValue(value,c):projectCaptureReplyExpectationV2(value as CaptureWorkerRequestV2,c)
}
function rowReceipt(value:unknown,p:CaptureReplyExpectationV2,c:CaptureProtocolContextV2):void{
 const r=own(value,['databaseId','generation','schemaVersion','operationId','inputDigest','physicalPosition','commitWatermark','session','reused']);if(!sameIdentity(identity({databaseId:r.databaseId,generation:r.generation,schemaVersion:r.schemaVersion}),c.identity)||typeof r.inputDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.inputDigest)||typeof r.reused!=='boolean')fail('V2_INVALID_REPLY')
 analysisInteger(r.physicalPosition,1);analysisInteger(r.commitWatermark,1);analysisString(r.operationId);const s=checkedSession(r.session);if(r.operationId!==p.operationId||s.id!==p.sessionId||!sameScope(s.scope,p.scope!))fail('V2_INVALID_REPLY')
}
function position(value:unknown):ObjectValue{const p=own(value,['physicalPosition','shard','nextOffset']);analysisInteger(p.physicalPosition,1);analysisInteger(p.nextOffset);if(typeof p.shard!=='string'||!/^\d{6}\.jsonl$/.test(p.shard))fail('V2_INVALID_REPLY');return p}
function liveRead(value:unknown,command:ObjectValue,c:CaptureProtocolContextV2):void{
 const m=command.method,owner=scope(command.scope)
 if(m==='session'){const s=checkedSession(value);if(s.id!==command.sessionId||!sameScope(s.scope,owner))fail('V2_INVALID_REPLY')}
 else if(m==='sessionPage'){const page=own(value,['rows','upperOrder','nextBefore'],['rows','upperOrder']);if(!Array.isArray(page.rows)||page.rows.length>command.limit)fail('V2_INVALID_REPLY');analysisInteger(page.upperOrder);if(command.seek&&page.upperOrder!==command.seek.upperOrder)fail('V2_INVALID_REPLY');if(page.nextBefore!==undefined){analysisInteger(page.nextBefore,1);if(!page.rows.length||page.nextBefore>page.upperOrder||command.seek?.beforeOrder!==undefined&&page.nextBefore>=command.seek.beforeOrder)fail('V2_INVALID_REPLY')}for(const row of page.rows)if(!sameScope(checkedSession(row).scope,owner))fail('V2_INVALID_REPLY')}
 else if(m==='recordPage'){const page=own(value,['rows','next'],['rows']);if(!Array.isArray(page.rows)||page.rows.length>command.limit)fail('V2_INVALID_REPLY');let prior=command.seek.afterPosition??0;for(const row of page.rows){const r=own(row,['physicalPosition','shard','nextOffset','line','record']);position({physicalPosition:r.physicalPosition,shard:r.shard,nextOffset:r.nextOffset});analysisInteger(r.line,1);const record=checkedRecord(r.record,c.limits);if(r.physicalPosition<=prior||r.physicalPosition>command.seek.upperPosition||record.sessionId!==command.sessionId||!sameScope(record.scope,owner))fail('V2_INVALID_REPLY');prior=r.physicalPosition}if(page.next!==undefined){const next=position(page.next),last=page.rows[page.rows.length-1];if(!last||next.physicalPosition!==last.physicalPosition||next.shard!==last.shard||next.nextOffset!==last.nextOffset)fail('V2_INVALID_REPLY')}}
 else if(m==='fieldSummary'){const v=own(value,['fields','complete','badLines']);if(typeof v.complete!=='boolean'||!Array.isArray(v.fields)||v.fields.length>1000)fail('V2_INVALID_REPLY');analysisInteger(v.badLines);for(const field of v.fields){const f=own(field,['path','count','types','examples']);if(typeof f.path!=='string'||Buffer.byteLength(f.path)>4096||!Array.isArray(f.types)||f.types.length>8||f.types.some((x:unknown)=>typeof x!=='string'||!['null','object','array','number','string','boolean'].includes(x))||!Array.isArray(f.examples)||f.examples.length>3)fail('V2_INVALID_REPLY');analysisInteger(f.count);for(const example of f.examples){json(example);if(Buffer.byteLength(JSON.stringify(example))>256)fail('V2_INVALID_REPLY')}}}
 else if(m==='liveRequest'){if(value===undefined)return;const r=own(value,['requestId','action','requestDigest','status','revision','sessionId','retained','receiptOperationId','errorCode','retryable'],['requestId','action','requestDigest','status','revision','sessionId','retained']);if(r.requestId!==command.requestId||!['start','stop'].includes(r.action)||!['inflight','terminal'].includes(r.status)||typeof r.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.requestDigest)||typeof r.retained!=='boolean')fail('V2_INVALID_REPLY');analysisInteger(r.revision,1);analysisId(r.sessionId);if(r.requestDigest!==liveRequestDigest(r.action,owner,r.action==='stop'?r.sessionId:undefined))fail('V2_INVALID_REPLY');if(r.receiptOperationId!==undefined)analysisString(r.receiptOperationId);if(r.errorCode!==undefined&&(typeof r.errorCode!=='string'||!/^[A-Z_]{1,128}$/.test(r.errorCode)||typeof r.retryable!=='boolean')||r.errorCode===undefined&&r.retryable!==undefined)fail('V2_INVALID_REPLY');if(r.status==='terminal'&&r.receiptOperationId===undefined)fail('V2_INVALID_REPLY')}
 else if(m==='controlState'){const r=own(value,['sessionId','revision','startState','stopRequested','unclean','counterLossKnown','terminalCreditBytes']);if(r.sessionId!==command.sessionId||!['prepared','ready','failed'].includes(r.startState)||[r.stopRequested,r.unclean,r.counterLossKnown].some(x=>typeof x!=='boolean'))fail('V2_INVALID_REPLY');analysisInteger(r.revision,1);analysisInteger(r.terminalCreditBytes)}
 else fail('V2_INVALID_REPLY')
}
function replyValue(value:unknown,p:CaptureReplyExpectationV2,c:CaptureProtocolContextV2):CaptureWorkerReplyV2{
 const keys=['version','mode','id','identity','ok','value','code',...(c.mode==='live-control'?['scope']:[])],r=own(value,keys,['version','mode','id','identity','ok',...(c.mode==='live-control'?['scope']:[])])
 if(r.version!==2||r.mode!==c.mode||r.id!==p.id||typeof r.ok!=='boolean'||!sameIdentity(identity(r.identity),c.identity))fail('V2_INVALID_REPLY')
 if(c.mode==='live-control'&&!sameScope(scope(r.scope),p.scope!))fail('V2_INVALID_REPLY')
 safeGraph(r,false);budget(r,Math.min(16*1024*1024,c.limits.maxMetadataBytes))
 if(!r.ok){if(Object.hasOwn(r,'value')||!knownCode(r.code))fail('V2_INVALID_REPLY');return structuredClone(r) as CaptureWorkerReplyV2}
 if(Object.hasOwn(r,'code')||!Object.hasOwn(r,'value'))fail('V2_INVALID_REPLY');const command:ObjectValue={...p,seek:p.method==='recordPage'?{upperPosition:p.upperPosition,afterPosition:p.afterPosition}:p.upperOrder===undefined?undefined:{upperOrder:p.upperOrder,beforeOrder:p.beforeOrder}}
 if(c.mode==='typed-stage'){
  if(r.value===undefined){if(command.method!=='sessionImportReceipt')fail('V2_INVALID_REPLY')}
  else{r.value=decodeSessionImportReceipt(r.value);const receipt=r.value;if(receipt.runId!==p.runId||receipt.operationId!==p.operationId||p.expectedRevision!==undefined&&receipt.expectedRevision!==p.expectedRevision||p.method==='beginSessionImport'&&receipt.domain!=='begin'||p.method==='stepSessionImport'&&receipt.domain==='begin')fail('V2_INVALID_REPLY')}
 }else if(command.method==='control'||command.method==='controlReceipt'){
  if(r.value===undefined){if(command.method!=='controlReceipt')fail('V2_INVALID_REPLY')}
  else{r.value=decodeLiveControlReceipt(r.value);const receipt=r.value;if(!sameIdentity(receipt,c.identity)||receipt.operationId!==p.operationId||!sameScope(receipt.owner.scope,p.scope!)||p.method==='control'&&(receipt.expectedRevision!==p.expectedRevision||p.controlKind!=='prepare-start'&&receipt.owner.sessionId!==p.sessionId||receipt.owner.requestId!==p.requestId||p.resultSequence!==undefined&&receipt.result.liveSequence!==p.resultSequence))fail('V2_INVALID_REPLY')}
 }else if(command.method==='commit'||command.method==='receipt'){if(r.value===undefined){if(command.method!=='receipt')fail('V2_INVALID_REPLY')}else rowReceipt(r.value,p,c)}
 else liveRead(r.value,command,c)
 return structuredClone(r) as CaptureWorkerReplyV2
}
export function validateCaptureReplyV2(value:unknown,expected:CaptureReplyExpectedV2,context:CaptureProtocolContextV2):CaptureWorkerReplyV2{try{const c=contextValue(context),p=expectedValue(expected,c);return replyValue(value,p,c)}catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REPLY')}}
export function encodeCaptureReplyV2(value:unknown,expected:CaptureReplyExpectedV2,context:CaptureProtocolContextV2):Buffer{try{const c=contextValue(context);return packet(validateCaptureReplyV2(value,expected,c),Math.min(16*1024*1024,c.limits.maxMetadataBytes))}catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REPLY')}}
export function decodeCaptureReplyV2(buffer:unknown,expected:CaptureReplyExpectedV2,context:CaptureProtocolContextV2):CaptureWorkerReplyV2{try{const c=contextValue(context);return validateCaptureReplyV2(raw(buffer,Math.min(16*1024*1024,c.limits.maxMetadataBytes),'V2_INVALID_REPLY'),expected,c)}catch(e){if(e instanceof CaptureProtocolV2Error&&e.code==='V2_LIMIT')throw e;fail('V2_INVALID_REPLY')}}
