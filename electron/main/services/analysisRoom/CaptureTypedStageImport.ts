import {readCapacityAdmission,type CapacityBindingV2} from './CaptureCapacityLedgerV2'
import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {DatabaseSync,SQLInputValue} from 'node:sqlite'
import {analysisId,type CaptureLimits,type AnalysisSession} from '../../../../shared/analysisRoom'
import {validateCaptureStorageLimits} from './CaptureStorage'
import {createTypedStageSchema,resumeTypedStageSchema,readTypedStageAdmission,readTypedStageProjectionAdmission,readTypedStageCapacityAdmission,type TypedStageBinding,type TypedStagePolicy,type TypedStageAdmission} from './CaptureTypedStageSchema'
import {classifyLegacySource,classifyLegacyMetadataUnit,type LegacyUnitSource,type LegacyMetadataClassification} from './CaptureLegacyImportUnits'
import {readStagedLiteral,CaptureExtentError} from './CaptureStagedExtent'
import type {ProjectionBinding} from './CaptureTypedProjectionDefinition'

/** Private, unconsumed first slice. No capture/native projection or authority publication. */
export type {TypedStageBinding,TypedStagePolicy} from './CaptureTypedStageSchema'
export const createSessionImport=createTypedStageSchema
export const resumeSessionImport=resumeTypedStageSchema
export interface SessionImportIntent {operationId:string;expectedRevision:number}
export type SessionImportPhase='roles'|'metadata'|'charges'|'metadata-complete'
export type SessionImportDomain='begin'|'source-roles'|'session-metadata'|'source-charge'|'phase-boundary'
export interface SessionImportReceipt {
 kind:'legacy-typed';version:1;capability:'session-metadata-v1';domain:SessionImportDomain;
 runId:string;operationId:string;intentDigest:string;batchDigest:string;
 expectedRevision:number;resultRevision:number;watermark:number;cursor:{phase:SessionImportPhase;afterSourceId:number};
 classifiedSources:number;acceptedMetadata:number;seededSessions:number;chargedSources:number;chargedEvidenceBytes:number;
 rejected:number;deferred:number;retained:number;unresolved:number;savedCaptureRows:0;
 rowMutations:number;encodedBytes:number;byteWork:number;reused:boolean;activationAllowed:false;
}
export class TypedStageImportError extends Error {constructor(readonly code:string){super(code)}}
function fail(code:string):never{throw new TypedStageImportError(code)}
type Value=string|number|null
type Row=Record<string,Value>
type Run=Row & {run_id:string;policy_digest:string;revision:number;watermark:number;receipt_count:number;encoded_bytes:number;phase:SessionImportPhase;after_source_id:number;next_ordinal:number}
type Mutation={table:string;kind:'insert'|'update';keys:Row;values:Row}
type Selection={sourceId:number;size:number;sha256:string;role:string;status:string;startOffset:0;nextOffset:number;literalSha256:string|null}
type Envelope={version:1;method:'begin'|'step';previous:Run|null;run:Run;selected:Selection[];mutations:Mutation[]}
const LIMIT=1048576,COMMIT_WORK=262144,UNIT_MODULE='d3ea8f30f647e3f92231a8b70fa74d921a7873e424478e19bd1577f23415a48e',READER_MODULE='2d69cd92d59bd1b93ac6dcfc9508c99004f9fc1816bb37c12c8cb76958578bac'
const phases=['roles','metadata','charges','metadata-complete'],domains=['begin','source-roles','session-metadata','source-charge','phase-boundary']
const runColumns='run_id policy_digest revision watermark receipt_count encoded_bytes phase after_source_id next_ordinal classified_sources accepted_metadata seeded_sessions charged_sources rejected deferred retained unresolved canonical_evidence_bytes'.split(' ')
const sourceColumns='run_id source_id role source_sha256 source_size session_hint status code metadata_progress charge_progress revision'.split(' ')
const coreColumns='id account_id platform source ordinal status complete created_at stopped_at room_id format_version mapping_version reason received saved dropped pending parse_failed redacted bytes original_received original_saved original_dropped original_pending original_bytes original_redacted original_error has_originals live_sequence field_complete last_shard last_line last_offset'.split(' ')
const statsColumns='run_id session_id account_id platform source projection_state accepted_count rejected_count unresolved_count max_record_sequence parse_failed redacted native_valid_count native_rejected_count paired_count orphan_count ambiguous_count charged_record_bytes charged_native_bytes witnessed_native_present revision'.split(' ')
const tableColumns:Record<string,string[]>={
 legacy_typed_sources:sourceColumns,sessions:coreColumns,legacy_session_stats:statsColumns,database_meta:['key','value'],
 legacy_typed_units:'run_id source_id start_offset next_offset unit_kind line outcome code hash_status literal_sha256 session_id account_id platform source capture_position'.split(' '),
 legacy_declared_sessions:'run_id session_id metadata_source_id metadata_offset metadata_outcome account_id platform source declared_session_json created_sequence created_sequence_present seed_ordinal ordinal_policy normalization_timestamp stopped_at_derived declared_originals_present'.split(' '),
 legacy_source_charges:'run_id source_id role source_sha256 source_size session_id account_id platform source charged_bytes original_byte_delta'.split(' '),
}
const receiptKeys='kind version capability domain runId operationId intentDigest batchDigest expectedRevision resultRevision watermark cursor classifiedSources acceptedMetadata seededSessions chargedSources chargedEvidenceBytes rejected deferred retained unresolved savedCaptureRows rowMutations encodedBytes byteWork reused activationAllowed'.split(' ')
const counters:Record<string,string>={classifiedSources:'classified_sources',acceptedMetadata:'accepted_metadata',seededSessions:'seeded_sessions',chargedSources:'charged_sources',chargedEvidenceBytes:'canonical_evidence_bytes',rejected:'rejected',deferred:'deferred',retained:'retained',unresolved:'unresolved'}
const stable=(x:unknown):string=>Array.isArray(x)?'['+x.map(stable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable((x as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(x)
const size=(x:unknown)=>Buffer.byteLength(stable(x))
const digest=(x:unknown)=>createHash('sha256').update(stable(x)).digest('hex')
const nat=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
function shape(x:unknown,keys:string[]):Record<string,unknown>{
 if(!x||typeof x!=='object'||types.isProxy(x)||Array.isArray(x)||![null,Object.prototype].includes(Object.getPrototypeOf(x))||Reflect.ownKeys(x).length!==keys.length)fail('TYPED_INPUT_INVALID')
 const out:Record<string,unknown>={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(x,k);if(!d||!d.enumerable||!('value'in d))fail('TYPED_INPUT_INVALID');out[k]=d.value}return out
}
function rowShape(x:unknown,keys:string[]):Row{const r=shape(x,keys);for(const v of Object.values(r))if(v!==null&&typeof v!=='string'&&!nat(v))fail('TYPED_INPUT_INVALID');return r as Row}
function intent(x:SessionImportIntent):SessionImportIntent{const r=shape(x,['operationId','expectedRevision']);try{analysisId(r.operationId)}catch{fail('TYPED_INPUT_INVALID')}if(!nat(r.expectedRevision))fail('TYPED_INPUT_INVALID');return {operationId:r.operationId as string,expectedRevision:r.expectedRevision}}
/** Strict detached DTO only. A bare DTO is not proof of database authentication. */
export function decodeSessionImportReceipt(value:unknown):SessionImportReceipt{
 try{
  const r=shape(value,receiptKeys),c=shape(r.cursor,['phase','afterSourceId']);
  if(r.kind!=='legacy-typed'||r.version!==1||r.capability!=='session-metadata-v1'||r.activationAllowed!==false||r.savedCaptureRows!==0||typeof r.reused!=='boolean'||typeof r.domain!=='string'||typeof c.phase!=='string'||!domains.includes(r.domain)||!phases.includes(c.phase)||!nat(c.afterSourceId))fail('TYPED_RECEIPT_INVALID')
  analysisId(r.runId);analysisId(r.operationId);if(!hash(r.intentDigest)||!hash(r.batchDigest))fail('TYPED_RECEIPT_INVALID')
  for(const k of ['expectedRevision','resultRevision','watermark','rowMutations','encodedBytes','byteWork',...Object.keys(counters)])if(!nat(r[k]))fail('TYPED_RECEIPT_INVALID')
  if(r.resultRevision!==(r.expectedRevision as number)+1||r.watermark!==r.resultRevision||(r.rowMutations as number)<2||(r.rowMutations as number)>128||(r.encodedBytes as number)<1||(r.encodedBytes as number)>LIMIT||(r.byteWork as number)<1||(r.byteWork as number)>LIMIT||(r.classifiedSources as number)>32||(r.chargedSources as number)>16||(r.acceptedMetadata as number)>1||(r.seededSessions as number)!==r.acceptedMetadata)fail('TYPED_RECEIPT_INVALID')
  const n=(key:string)=>r[key] as number,decision=n('rejected')+n('deferred')+n('retained')+n('unresolved')
  if(n('chargedEvidenceBytes')>5368709120||decision>32)fail('TYPED_RECEIPT_INVALID')
  if(r.domain==='begin'&&(r.expectedRevision!==0||c.phase!=='roles'||c.afterSourceId!==0||Object.keys(counters).some(k=>n(k)!==0)))fail('TYPED_RECEIPT_INVALID')
  if(r.domain==='phase-boundary'&&Object.keys(counters).some(k=>n(k)!==0))fail('TYPED_RECEIPT_INVALID')
  if(r.domain==='source-roles'&&(c.phase!=='roles'||c.afterSourceId===0||n('classifiedSources')<1||decision>n('classifiedSources')||n('acceptedMetadata')||n('chargedSources')||n('chargedEvidenceBytes')))fail('TYPED_RECEIPT_INVALID')
  if(r.domain==='session-metadata'&&(c.phase!=='metadata'||c.afterSourceId===0||n('classifiedSources')||n('chargedSources')||n('chargedEvidenceBytes')||n('retained')||n('acceptedMetadata')+decision!==1))fail('TYPED_RECEIPT_INVALID')
  if(r.domain==='source-charge'&&(c.phase!=='charges'||c.afterSourceId===0||n('classifiedSources')||n('acceptedMetadata')||n('rejected')||n('deferred')||n('retained')||n('chargedSources')+n('unresolved')<1||n('chargedSources')+n('unresolved')>16))fail('TYPED_RECEIPT_INVALID')
  const out={} as Record<string,unknown>;for(const k of receiptKeys)out[k]=k==='cursor'?{phase:c.phase,afterSourceId:c.afterSourceId}:r[k];return out as unknown as SessionImportReceipt
 }catch{fail('TYPED_RECEIPT_INVALID')}
}
export function typedStageImportPolicy(limits:Readonly<CaptureLimits>,normalizationTimestamp:number):TypedStagePolicy{
 if(types.isProxy(limits))fail('TYPED_INPUT_INVALID');const normalized=validateCaptureStorageLimits(limits);if(!nat(normalizationTimestamp))fail('TYPED_INPUT_INVALID');return {version:1,roleModuleDigest:UNIT_MODULE,metadataModuleDigest:UNIT_MODULE,stagedReaderContractDigest:READER_MODULE,ordinalPolicy:'source-id-v1',normalizationTimestamp,limitsDigest:digest(normalized),metadataBytes:131072,decodedNodes:8192,decodedDepth:16,maxRowMutations:128,maxEncodedBytes:LIMIT,maxByteWork:LIMIT}
}
class Work{constructor(public used:number){}add(n:number){if(!nat(n)||this.used+n>LIMIT)fail('TYPED_WORK_LIMIT');this.used+=n}scalar(x:unknown){this.add(2*size(x??null));return x}}
function admission(db:DatabaseSync,input:TypedStageBinding){const a=readTypedStageAdmission(db,input,LIMIT);if(stable(a.binding.policy)!==stable(typedStageImportPolicy(a.binding.limits,a.binding.policy.normalizationTimestamp)))fail('TYPED_POLICY_MISMATCH');return {a,b:a.binding,w:new Work(a.byteWork)}}
function query(db:DatabaseSync,w:Work,sql:string,...args:SQLInputValue[]):Row|undefined{const r=db.prepare(sql).get(...args) as Row|undefined;w.scalar(r);return r}
function loadRun(db:DatabaseSync,b:TypedStageBinding,w:Work):Run|undefined{const r=boundedRow(db,w,'legacy_typed_runs',{run_id:b.runId},runColumns);if(!r)return;return runValue(r,b)}
function runValue(r:unknown,b:TypedStageBinding):Run{const v=rowShape(r,runColumns);if(v.run_id!==b.runId||v.policy_digest!==digest(b.policy)||!phases.includes(String(v.phase))||v.revision!==v.watermark||v.revision!==v.receipt_count||!nat(v.revision)||v.revision<1||!nat(v.next_ordinal)||v.next_ordinal<1||!nat(v.after_source_id)||!nat(v.encoded_bytes))fail('TYPED_STATE_INVALID');for(const k of Object.values(counters))if(!nat(v[k]))fail('TYPED_STATE_INVALID');return v as Run}
function runBounds(run:Run,a:TypedStageAdmission){if(run.after_source_id>a.sourceHighWaterId||Number(run.classified_sources)>a.sourceCount||Number(run.accepted_metadata)!==Number(run.seeded_sessions)||run.next_ordinal!==Number(run.seeded_sessions)+1||Number(run.canonical_evidence_bytes)>a.sourceBytes||run.revision>a.binding.limits.maxIdempotencyRequests||Number(run.accepted_metadata)+Number(run.charged_sources)+Number(run.rejected)+Number(run.deferred)+Number(run.retained)+Number(run.unresolved)>Number(run.classified_sources)||run.encoded_bytes<1||a.sourceBytes+a.bootstrapEncodedBytes+run.encoded_bytes>a.binding.limits.maxStorageBytes)fail('TYPED_STATE_INVALID')}
function numericMeta(db:DatabaseSync,w:Work,key:string):number{const r=query(db,w,'SELECT length(CAST(value AS BLOB)) AS n FROM database_meta WHERE key=?',key);if(!r||!nat(r.n)||r.n>16)fail('TYPED_STATE_INVALID');w.add(3*r.n);const s=query(db,w,'SELECT substr(value,1,16) AS value FROM database_meta WHERE key=?',key);if(!s||typeof s.value!=='string'||!/^(0|[1-9]\d*)$/.test(s.value)||!nat(Number(s.value)))fail('TYPED_STATE_INVALID');return Number(s.value)}
function rawSource(db:DatabaseSync,w:Work,id:number):LegacyUnitSource{
 const r=query(db,w,'SELECT id,size,verified,length(CAST(relative_path AS BLOB)) AS p,length(CAST(sha256 AS BLOB)) AS h FROM legacy_sources WHERE id=?',id)
 if(!r||r.id!==id||r.verified!==1||!nat(r.size)||r.size>5368709120||!nat(r.p)||r.p>4096||r.h!==64)fail('TYPED_SOURCE_INVALID')
 w.add(3*(r.p+64));const v=query(db,w,'SELECT substr(relative_path,1,4096) AS path,substr(sha256,1,64) AS sha FROM legacy_sources WHERE id=?',id);if(!v||typeof v.path!=='string'||!hash(v.sha))fail('TYPED_SOURCE_INVALID');return {sourceId:id,relativePath:v.path,size:r.size,sha256:v.sha}
}
function sourceRow(db:DatabaseSync,b:TypedStageBinding,w:Work,s:LegacyUnitSource):Row{const r=boundedRow(db,w,'legacy_typed_sources',{run_id:b.runId,source_id:s.sourceId});if(!r)fail('TYPED_STATE_INVALID');rowShape(r,sourceColumns);if(r.source_size!==s.size||r.source_sha256!==s.sha256)fail('TYPED_SOURCE_INVALID');return r}
function selected(s:LegacyUnitSource,r:Row,sha:string|null=null):Selection{return {sourceId:s.sourceId,size:s.size,sha256:s.sha256,role:String(r.role),status:String(r.status),startOffset:0,nextOffset:s.size,literalSha256:sha}}
function op(list:Mutation[],table:string,values:Row,keys:Row={}){rowShape(values,tableColumns[table]??[]);for(const [k,v]of Object.entries(keys))if(!tableColumns[table]?.includes(k)||(v!==null&&typeof v!=='string'&&!nat(v)))fail('TYPED_STATE_INVALID');list.push({table,kind:Object.keys(keys).length?'update':'insert',keys,values})}
function outcome(r:SessionImportReceipt,status:string){if(status in counters)(r as unknown as Record<string,number>)[status]++}
function newCore(s:AnalysisSession,ordinal:number,time:number):Row{return {id:s.id,account_id:s.scope.accountId,platform:s.scope.platform,source:s.scope.source,ordinal,status:'interrupted',complete:0,created_at:s.createdAt,stopped_at:s.stoppedAt??time,room_id:s.roomId??null,format_version:s.formatVersion,mapping_version:s.mappingVersion??null,reason:'LEGACY_IMPORT_PARTIAL',received:0,saved:0,dropped:0,pending:0,parse_failed:0,redacted:0,bytes:0,original_received:0,original_saved:0,original_dropped:0,original_pending:0,original_bytes:0,original_redacted:0,original_error:null,has_originals:s.originals?1:0,live_sequence:0,field_complete:0,last_shard:null,last_line:0,last_offset:0}}
function newStats(b:TypedStageBinding,s:AnalysisSession):Row{const r:Row=Object.fromEntries(statsColumns.map(k=>[k,0]));Object.assign(r,{run_id:b.runId,session_id:s.id,account_id:s.scope.accountId,platform:s.scope.platform,source:s.scope.source,projection_state:'not-projected'});return r}
function prepareStep(db:DatabaseSync,a:TypedStageAdmission,b:TypedStageBinding,w:Work,run:Run,r:SessionImportReceipt,ops:Mutation[],selection:Selection[]){
 if(run.phase==='roles'){
  const ids=db.prepare('SELECT id FROM legacy_sources WHERE id>? AND id<=? ORDER BY id LIMIT ?').all(run.after_source_id,a.sourceHighWaterId,Math.min(16,b.limits.maxPendingRecords)) as Row[];w.scalar(ids)
  if(!ids.length){if(run.classified_sources!==a.sourceCount)fail('TYPED_STATE_INVALID');run.phase='metadata';run.after_source_id=0;r.domain='phase-boundary';return}
  r.domain='source-roles'
  for(const id of ids){if(!nat(id.id)||id.id<1)fail('TYPED_SOURCE_INVALID');const s=rawSource(db,w,id.id),c=classifyLegacySource(s);w.add(4*size(s));if(!c.privateSource||c.status==='rejected')fail('TYPED_SOURCE_INVALID')
   const row:Row={run_id:b.runId,source_id:s.sourceId,role:c.role,source_sha256:s.sha256,source_size:s.size,session_hint:c.role.startsWith('canonical-')?s.relativePath.split('/')[1]:null,status:c.status,code:c.code??null,metadata_progress:c.role==='canonical-session'?'pending':'not-applicable',charge_progress:['canonical-records','canonical-native'].includes(c.role)?'pending':'not-applicable',revision:0}
   op(ops,'legacy_typed_sources',row);selection.push(selected(s,row));run.after_source_id=s.sourceId;r.classifiedSources++;outcome(r,c.status)
  }return
 }
 if(run.phase==='metadata'){
  const id=query(db,w,"SELECT source_id FROM legacy_typed_sources WHERE run_id=? AND role='canonical-session' AND source_id>? ORDER BY source_id LIMIT 1",b.runId,run.after_source_id)
  if(!id){run.phase='charges';run.after_source_id=0;r.domain='phase-boundary';return}
  if(!nat(id.source_id))fail('TYPED_STATE_INVALID');const s=rawSource(db,w,id.source_id),row=sourceRow(db,b,w,s);if(row.metadata_progress!=='pending')fail('TYPED_STATE_INVALID');r.domain='session-metadata'
  let c:LegacyMetadataClassification=classifyLegacyMetadataUnit({source:s,limits:b.limits});w.add(4*size(s))
  if(c.code==='METADATA_BYTES_UNAVAILABLE'){
   const extra=6*s.size
   if(w.used+extra+256>LIMIT)c={...c,status:'deferred',code:'RESOURCE_WORK_LIMIT'}
   else try{const literal=readStagedLiteral(db,{sourceId:s.sourceId,startOffset:0,nextOffset:s.size},131072,LIMIT-w.used-extra);w.add(literal.byteWork);w.add(extra);c=classifyLegacyMetadataUnit({source:s,limits:b.limits,literalBytes:literal.bytes});if(c.code==='SOURCE_SHA_MISMATCH'||literal.literalSha256!==s.sha256)fail('TYPED_SOURCE_INVALID')}
   catch(e){if(e instanceof CaptureExtentError&&e.code==='RESOURCE_WORK_LIMIT'){w.add(e.byteWork);c={...c,status:'deferred',code:'RESOURCE_WORK_LIMIT'}}else throw e}
  }
  const accepted=c.status==='accepted'&&c.privateProjection,session=accepted?c.privateProjection!.session:undefined
  if(session){
   const declared=stable(session);if(Buffer.byteLength(declared)>Math.min(16384,b.limits.maxMetadataBytes,b.limits.maxRecordBytes))fail('TYPED_CAPACITY_LIMIT')
   const ordinal=numericMeta(db,w,'session_ordinal');if(ordinal+1!==run.next_ordinal)fail('TYPED_STATE_INVALID');op(ops,'sessions',newCore(session,run.next_ordinal,b.policy.normalizationTimestamp))
  }
  if(s.size)op(ops,'legacy_typed_units',{run_id:b.runId,source_id:s.sourceId,start_offset:0,next_offset:s.size,unit_kind:'file',line:null,outcome:c.status,code:c.code??null,hash_status:c.hashStatus,literal_sha256:c.literalSha256??null,session_id:session?.id??null,account_id:session?.scope.accountId??null,platform:session?.scope.platform??null,source:session?.scope.source??null,capture_position:null})
  if(session){
   op(ops,'legacy_declared_sessions',{run_id:b.runId,session_id:session.id,metadata_source_id:s.sourceId,metadata_offset:0,metadata_outcome:'accepted',account_id:session.scope.accountId,platform:session.scope.platform,source:session.scope.source,declared_session_json:stable(session),created_sequence:c.privateProjection!.createdSequence??null,created_sequence_present:c.privateProjection!.createdSequence===undefined?0:1,seed_ordinal:run.next_ordinal,ordinal_policy:'source-id-v1',normalization_timestamp:b.policy.normalizationTimestamp,stopped_at_derived:session.stoppedAt===undefined?1:0,declared_originals_present:session.originals?1:0})
   op(ops,'legacy_session_stats',newStats(b,session));op(ops,'database_meta',{key:'session_ordinal',value:String(run.next_ordinal)},{key:'session_ordinal',value:String(run.next_ordinal-1)});run.next_ordinal++;r.acceptedMetadata++;r.seededSessions++
  }else outcome(r,c.status)
  const changed={...row,status:c.status,code:c.code??null,metadata_progress:c.status,revision:Number(row.revision)+1};op(ops,'legacy_typed_sources',changed,{run_id:b.runId,source_id:s.sourceId,revision:row.revision});selection.push(selected(s,changed,c.literalSha256??null));run.after_source_id=s.sourceId;return
 }
 if(run.phase==='charges'){
  const cap=Math.min(4,b.limits.maxPendingRecords),byRole:Row[]=[]
  for(const role of ['canonical-records','canonical-native']){const page=db.prepare('SELECT source_id FROM legacy_typed_sources WHERE run_id=? AND role=? AND source_id>? ORDER BY source_id LIMIT ?').all(b.runId,role,run.after_source_id,cap) as Row[];w.scalar(page);byRole.push(...page)}
  const ids=byRole.sort((x,y)=>Number(x.source_id)-Number(y.source_id)).slice(0,cap)
  if(!ids.length){run.phase='metadata-complete';r.domain='phase-boundary';return}
  r.domain='source-charge';const total=numericMeta(db,w,'total_logical_bytes');let delta=0
  const owners=new Map<string,{core:Row;stats:Row;oldBytes:Value;oldRevision:Value}>()
  for(const id of ids){if(!nat(id.source_id))fail('TYPED_STATE_INVALID');const s=rawSource(db,w,id.source_id),row=sourceRow(db,b,w,s);if(row.charge_progress!=='pending')fail('TYPED_STATE_INVALID')
   const owner=boundedRow(db,w,'legacy_declared_sessions',{run_id:b.runId,session_id:row.session_hint})
   let changed:Row
   if(!owner){changed={...row,status:'unresolved',code:'SESSION_METADATA_UNAVAILABLE',charge_progress:'unresolved',revision:Number(row.revision)+1};r.unresolved++}
   else{
    if(owner.session_id!==row.session_hint||typeof owner.session_id!=='string')fail('TYPED_SOURCE_INVALID');let o=owners.get(owner.session_id)
    if(!o){const core=boundedRow(db,w,'sessions',{id:owner.session_id}),stats=boundedRow(db,w,'legacy_session_stats',{run_id:b.runId,session_id:owner.session_id});if(!core||!stats||['account_id','platform','source'].some(k=>core[k]!==owner[k]||stats[k]!==owner[k])||!nat(core.bytes)||!nat(core.original_bytes)||!nat(stats.revision))fail('TYPED_STATE_INVALID');o={core,stats,oldBytes:core.bytes,oldRevision:stats.revision};owners.set(owner.session_id,o)}
    if(Number(o.core.bytes)+s.size>b.limits.maxSessionBytes||total+delta+s.size>b.limits.maxStorageBytes)fail('TYPED_CAPACITY_LIMIT')
    op(ops,'legacy_source_charges',{run_id:b.runId,source_id:s.sourceId,role:row.role,source_sha256:s.sha256,source_size:s.size,session_id:owner.session_id,account_id:owner.account_id,platform:owner.platform,source:owner.source,charged_bytes:s.size,original_byte_delta:row.role==='canonical-native'?s.size:0})
    o.core.bytes=Number(o.core.bytes)+s.size;if(row.role==='canonical-native'){o.core.original_bytes=Number(o.core.original_bytes)+s.size;o.core.has_originals=1;o.stats.charged_native_bytes=Number(o.stats.charged_native_bytes)+s.size;o.stats.witnessed_native_present=1}else o.stats.charged_record_bytes=Number(o.stats.charged_record_bytes)+s.size
    delta+=s.size;r.chargedSources++;r.chargedEvidenceBytes+=s.size;changed={...row,charge_progress:'charged',revision:Number(row.revision)+1}
   }
   op(ops,'legacy_typed_sources',changed,{run_id:b.runId,source_id:s.sourceId,revision:row.revision});selection.push(selected(s,changed));run.after_source_id=s.sourceId
  }
  for(const o of owners.values()){o.stats.revision=Number(o.oldRevision)+1;op(ops,'sessions',o.core,{id:o.core.id,account_id:o.core.account_id,platform:o.core.platform,source:o.core.source,bytes:o.oldBytes});op(ops,'legacy_session_stats',o.stats,{run_id:b.runId,session_id:o.stats.session_id,revision:o.oldRevision})}
  if(owners.size)op(ops,'database_meta',{key:'total_logical_bytes',value:String(total+delta)},{key:'total_logical_bytes',value:String(total)});return
 }
 r.domain='phase-boundary'
}
/** Fixed columns, scalar lengths and reserve precede any mutable TEXT fetch. */
function boundedRow(db:DatabaseSync,w:Work,table:string,keys:Row,columns=tableColumns[table]):Row|undefined{
 const names=Object.keys(keys),where=names.map(k=>`${k} IS ?`).join(' AND ');const sizes=query(db,w,`SELECT ${columns.map((k,i)=>`length(CAST(${k} AS BLOB)) AS n${i}`).join(',')} FROM ${table} WHERE ${where}`,...Object.values(keys))
 if(!sizes)return;let n=0;for(const value of Object.values(sizes)){if(value!==null&&(!nat(value)||value>16384))fail('TYPED_STATE_INVALID');n+=Number(value??0)}if(n>65536)fail('TYPED_STATE_INVALID');w.add(3*n);return query(db,w,`SELECT ${columns.join(',')} FROM ${table} WHERE ${where}`,...Object.values(keys))
}
const abortGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
function checkAbort(signal?:AbortSignal){if(signal===undefined)return;try{if(types.isProxy(signal)||abortGetter.call(signal))fail('TYPED_IMPORT_ABORTED')}catch{fail('TYPED_IMPORT_ABORTED')}}
function durable(db:DatabaseSync){if(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA synchronous').get()?.synchronous!==2||db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')fail('TYPED_DURABILITY_INVALID')}
function intentHash(method:'begin'|'step',b:TypedStageBinding,i:SessionImportIntent){return digest({kind:'legacy-typed',version:1,method,binding:b,intent:i})}
function receiptRow(r:SessionImportReceipt,selectionJson:string,receiptJson:string):Row{return {run_id:r.runId,operation_id:r.operationId,domain:r.domain,intent_digest:r.intentDigest,batch_digest:r.batchDigest,expected_revision:r.expectedRevision,result_revision:r.resultRevision,watermark:r.watermark,phase:r.cursor.phase,after_source_id:r.cursor.afterSourceId,selection_json:selectionJson,receipt_json:receiptJson}}
function encoded(ops:Mutation[],run:Run,row:Row){return size(ops)+size(run)+size(row)}
function receiptBinding(r:SessionImportReceipt){const out:Record<string,unknown>={};for(const k of receiptKeys)if(k!=='batchDigest'&&k!=='reused')out[k]=(r as unknown as Record<string,unknown>)[k];return out}
function batch(e:Envelope,r:SessionImportReceipt){return digest({intentDigest:r.intentDigest,envelope:e,receipt:receiptBinding(r)})}
function encodePlan(b:TypedStageBinding,e:Envelope,r:SessionImportReceipt):Row{
 // Only scalar digit arithmetic in the fixed point; never repeatedly serialize the whole payload.
 const prior=Number(e.previous?.encoded_bytes??0);e.run.encoded_bytes=prior;r.encodedBytes=0
 const preview=stable(e),previewRow=receiptRow(r,preview,stable(r)),base=encoded(e.mutations,e.run,previewRow)
 let bytes=base,settled=false;for(let n=0;n<12;n++){const next=base+2*(String(prior+bytes).length-String(prior).length)+String(bytes).length-1;if(next===bytes){settled=true;break}bytes=next}if(!settled)fail('TYPED_STATE_INVALID')
 r.encodedBytes=bytes;e.run.encoded_bytes=prior+bytes;r.batchDigest=batch(e,r);const selectionJson=stable(e),receiptJson=stable(r),row=receiptRow(r,selectionJson,receiptJson)
 const spent=3*(Buffer.byteLength(preview)+Buffer.byteLength(selectionJson))+2*(2*size(e.mutations)+size(e.run)+size(row)+size(previewRow)+size({...e.run,encoded_bytes:prior}))
 if(spent>COMMIT_WORK)fail('TYPED_WORK_LIMIT')
 if(encoded(e.mutations,e.run,row)!==bytes)fail('TYPED_STATE_INVALID')
 if(bytes>Math.min(LIMIT,b.limits.maxPendingBytes)||Buffer.byteLength(selectionJson)>Math.min(131072,b.limits.maxMetadataBytes,b.limits.maxRecordBytes)||Buffer.byteLength(receiptJson)>Math.min(131072,b.limits.maxMetadataBytes,b.limits.maxRecordBytes))fail('TYPED_CAPACITY_LIMIT')
 return row
}
function apply(db:DatabaseSync,m:Mutation){const columns=Object.keys(m.values),values=Object.values(m.values);let result
 if(m.kind==='insert')result=db.prepare(`INSERT INTO ${m.table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values)
 else{const keys=Object.keys(m.keys);result=db.prepare(`UPDATE ${m.table} SET ${columns.map(k=>`${k}=?`).join(',')} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')}`).run(...values,...Object.values(m.keys))}
 if(result.changes!==1)fail('TYPED_STALE_REVISION')
}
function envelopeValue(value:unknown,b:TypedStageBinding):Envelope{
 const e=shape(value,['version','method','previous','run','selected','mutations']);if(e.version!==1||!['begin','step'].includes(String(e.method))||!Array.isArray(e.selected)||e.selected.length>32||!Array.isArray(e.mutations)||e.mutations.length>126)fail('TYPED_RECEIPT_INVALID')
 const run=runValue(e.run,b),previous=e.previous===null?null:runValue(e.previous,b)
 const selections=e.selected.map(x=>{const s=shape(x,['sourceId','size','sha256','role','status','startOffset','nextOffset','literalSha256']);if(!nat(s.sourceId)||s.sourceId<1||!nat(s.size)||s.size>5368709120||!hash(s.sha256)||typeof s.role!=='string'||typeof s.status!=='string'||s.startOffset!==0||s.nextOffset!==s.size||(s.literalSha256!==null&&!hash(s.literalSha256)))fail('TYPED_RECEIPT_INVALID');return s as unknown as Selection})
 const mutations=e.mutations.map(x=>{const m=shape(x,['table','kind','keys','values']);if(typeof m.table!=='string'||!tableColumns[m.table]||!['insert','update'].includes(String(m.kind)))fail('TYPED_RECEIPT_INVALID');const values=rowShape(m.values,tableColumns[m.table]),raw=m.keys;if(!raw||typeof raw!=='object'||Array.isArray(raw)||types.isProxy(raw))fail('TYPED_RECEIPT_INVALID');const names=Object.keys(raw);if(names.some(k=>!tableColumns[m.table as string].includes(k)))fail('TYPED_RECEIPT_INVALID');const keys=rowShape(raw,names);if((m.kind==='insert')!==!names.length)fail('TYPED_RECEIPT_INVALID');for(const v of [...Object.values(keys),...Object.values(values)])if(typeof v==='string'&&Buffer.byteLength(v)>16384)fail('TYPED_RECEIPT_INVALID');return {table:m.table,kind:m.kind,keys,values} as Mutation})
 return {version:1,method:e.method as 'begin'|'step',previous,run,selected:selections,mutations}
}
function stored(db:DatabaseSync,b:TypedStageBinding,id:string,w:Work,a:TypedStageAdmission):{receipt:SessionImportReceipt;method:'begin'|'step'}|undefined{
 const lengths=query(db,w,'SELECT length(CAST(selection_json AS BLOB)) AS s,length(CAST(receipt_json AS BLOB)) AS r FROM legacy_control_receipts WHERE run_id=? AND operation_id=?',b.runId,id);if(!lengths)return
 try{
  if(!nat(lengths.s)||!nat(lengths.r)||lengths.s>Math.min(131072,b.limits.maxMetadataBytes,b.limits.maxRecordBytes)||lengths.r>Math.min(131072,b.limits.maxMetadataBytes,b.limits.maxRecordBytes))fail('TYPED_RECEIPT_INVALID');w.add(6*(lengths.s+lengths.r))
  const row=query(db,w,'SELECT * FROM legacy_control_receipts WHERE run_id=? AND operation_id=?',b.runId,id)!;rowShape(row,'run_id operation_id domain intent_digest batch_digest expected_revision result_revision watermark phase after_source_id selection_json receipt_json'.split(' '))
  const r=decodeSessionImportReceipt(JSON.parse(String(row.receipt_json))),e=envelopeValue(JSON.parse(String(row.selection_json)),b)
  if(r.reused||r.runId!==b.runId||r.operationId!==id||row.run_id!==b.runId||row.operation_id!==id||row.domain!==r.domain||row.intent_digest!==r.intentDigest||row.batch_digest!==r.batchDigest||row.expected_revision!==r.expectedRevision||row.result_revision!==r.resultRevision||row.watermark!==r.watermark||row.phase!==r.cursor.phase||row.after_source_id!==r.cursor.afterSourceId||r.rowMutations!==e.mutations.length+2||e.run.revision!==r.resultRevision||e.run.phase!==r.cursor.phase||e.run.after_source_id!==r.cursor.afterSourceId||e.run.encoded_bytes!==Number(e.previous?.encoded_bytes??0)+r.encodedBytes||encoded(e.mutations,e.run,row)!==r.encodedBytes||r.intentDigest!==intentHash(e.method,b,{operationId:id,expectedRevision:r.expectedRevision})||r.batchDigest!==batch(e,r))fail('TYPED_RECEIPT_INVALID')
  if((e.method==='begin')!==(e.previous===null)||r.expectedRevision!==Number(e.previous?.revision??0)||(e.method==='begin'&&r.domain!=='begin')||(e.method==='step'&&r.domain==='begin'))fail('TYPED_RECEIPT_INVALID')
  for(const [key,column]of Object.entries(counters))if(e.run[column]!==Number(e.previous?.[column]??0)+Number((r as unknown as Record<string,number>)[key]))fail('TYPED_RECEIPT_INVALID')
  const current=loadRun(db,b,w);if(!current||current.revision<r.resultRevision||current.encoded_bytes<e.run.encoded_bytes||e.run.next_ordinal!==Number(e.previous?.next_ordinal??1)+r.seededSessions)fail('TYPED_RECEIPT_INVALID');runBounds(current,a);runBounds(e.run,a);if(e.previous)runBounds(e.previous,a)
  if(r.domain==='begin'&&(e.selected.length||e.mutations.length||r.classifiedSources||r.seededSessions||r.chargedSources))fail('TYPED_RECEIPT_INVALID')
  if(r.domain==='source-roles'&&e.selected.length!==r.classifiedSources||r.domain==='session-metadata'&&e.selected.length!==1||r.domain==='source-charge'&&e.selected.length!==r.chargedSources+r.unresolved||r.domain==='phase-boundary'&&(e.selected.length||e.mutations.length))fail('TYPED_RECEIPT_INVALID')
  let last=0;for(const s of e.selected){if(s.sourceId<=last)fail('TYPED_RECEIPT_INVALID');last=s.sourceId;const physical=rawSource(db,w,s.sourceId),member=sourceRow(db,b,w,physical);if(physical.size!==s.size||physical.sha256!==s.sha256||member.role!==s.role||s.literalSha256!==null&&s.literalSha256!==physical.sha256)fail('TYPED_RECEIPT_INVALID')}
  return {receipt:{...r,reused:true},method:e.method}
 }catch{fail('TYPED_RECEIPT_INVALID')}
}
function newReceipt(b:TypedStageBinding,i:SessionImportIntent,method:'begin'|'step'):SessionImportReceipt{return {kind:'legacy-typed',version:1,capability:'session-metadata-v1',domain:method==='begin'?'begin':'phase-boundary',runId:b.runId,operationId:i.operationId,intentDigest:intentHash(method,b,i),batchDigest:'0'.repeat(64),expectedRevision:i.expectedRevision,resultRevision:i.expectedRevision+1,watermark:i.expectedRevision+1,cursor:{phase:'roles',afterSourceId:0},classifiedSources:0,acceptedMetadata:0,seededSessions:0,chargedSources:0,chargedEvidenceBytes:0,rejected:0,deferred:0,retained:0,unresolved:0,savedCaptureRows:0,rowMutations:2,encodedBytes:0,byteWork:0,reused:false,activationAllowed:false}}
function commit(db:DatabaseSync,input:TypedStageBinding,command:SessionImportIntent,method:'begin'|'step',signal?:AbortSignal):SessionImportReceipt{
 checkAbort(signal);const i=intent(command),{a,b,w}=admission(db,input);durable(db);db.exec('BEGIN IMMEDIATE')
 try{
  const old=stored(db,b,i.operationId,w,a);if(old){if(old.method!==method||old.receipt.expectedRevision!==i.expectedRevision)fail('TYPED_OPERATION_CONFLICT');checkAbort(signal);db.exec('COMMIT');return old.receipt}
  const previous=loadRun(db,b,w);if(previous)runBounds(previous,a);if(method==='begin'?!!previous||i.expectedRevision!==0:!previous||previous.revision!==i.expectedRevision)fail('TYPED_STALE_REVISION')
  if(i.expectedRevision>=b.limits.maxIdempotencyRequests)fail('TYPED_CAPACITY_LIMIT')
  const run:Run=previous?{...previous}:{run_id:b.runId,policy_digest:digest(b.policy),revision:1,watermark:1,receipt_count:1,encoded_bytes:0,phase:'roles',after_source_id:0,next_ordinal:1,classified_sources:0,accepted_metadata:0,seeded_sessions:0,charged_sources:0,rejected:0,deferred:0,retained:0,unresolved:0,canonical_evidence_bytes:0},r=newReceipt(b,i,method),ops:Mutation[]=[],selected:Selection[]=[]
  w.add(COMMIT_WORK)
  if(method==='step')prepareStep(db,a,b,w,run,r,ops,selected)
  else for(const table of ['sessions','capture_rows','original_rows','operation_receipts','field_entries'])if(query(db,w,`SELECT 1 AS present FROM ${table} LIMIT 1`))fail('TYPED_CORE_NOT_EMPTY')
  run.revision=r.resultRevision;run.watermark=r.watermark;run.receipt_count=r.resultRevision;for(const [k,column]of Object.entries(counters))run[column]=Number(run[column])+Number((r as unknown as Record<string,number>)[k]);r.cursor={phase:run.phase,afterSourceId:run.after_source_id};r.rowMutations=ops.length+2;if(r.rowMutations>128)fail('TYPED_ROW_LIMIT');r.byteWork=w.used
  const envelope:Envelope={version:1,method,previous:previous??null,run,selected,mutations:ops},row=encodePlan(b,envelope,r),detached=decodeSessionImportReceipt(r)
  if(a.sourceBytes+a.bootstrapEncodedBytes+run.encoded_bytes>b.limits.maxStorageBytes)fail('TYPED_CAPACITY_LIMIT')
  const before=Number(db.prepare('SELECT total_changes() AS n').get()!.n);for(const mutation of ops){checkAbort(signal);apply(db,mutation)}checkAbort(signal)
  apply(db,{table:'legacy_typed_runs',kind:previous?'update':'insert',keys:previous?{run_id:b.runId,revision:previous.revision}:{},values:run});checkAbort(signal);apply(db,{table:'legacy_control_receipts',kind:'insert',keys:{},values:row});checkAbort(signal)
  const actual=Number(db.prepare('SELECT total_changes() AS n').get()!.n)-before;if(actual>128)fail('TYPED_ROW_LIMIT');if(actual!==r.rowMutations)fail('TYPED_UNEXPECTED_EFFECT');checkAbort(signal);db.exec('COMMIT');return detached
 }catch(e){try{db.exec('ROLLBACK')}catch{}if(e instanceof TypedStageImportError)throw e;fail('TYPED_IMPORT_FAILED')}
}
export function beginSessionImport(db:DatabaseSync,binding:TypedStageBinding,command:SessionImportIntent,signal?:AbortSignal):SessionImportReceipt{return commit(db,binding,command,'begin',signal)}
export function stepSessionImport(db:DatabaseSync,binding:TypedStageBinding,command:SessionImportIntent,signal?:AbortSignal):SessionImportReceipt{return commit(db,binding,command,'step',signal)}
export function sessionImportReceipt(db:DatabaseSync,input:TypedStageBinding,operationId:string):SessionImportReceipt|undefined{try{analysisId(operationId)}catch{fail('TYPED_INPUT_INVALID')}const {a,b,w}=admission(db,input);return stored(db,b,operationId,w,a)?.receipt}
/** Readonly known-version union seam; the original complete DB decoder authenticates both ACKs. */
export function sessionImportReceiptInProjection(db:DatabaseSync,input:ProjectionBinding,operationId:string):SessionImportReceipt|undefined{
 try{analysisId(operationId)}catch{fail('TYPED_INPUT_INVALID')}
 const a=readTypedStageProjectionAdmission(db,input,LIMIT),b=a.binding.base,w=new Work(a.byteWork),prefix=stored(db,b,a.binding.basePrefixOperationId,w,a.base)
 if(!prefix||prefix.receipt.cursor.phase!=='metadata-complete'||String(prefix.receipt.resultRevision)!==a.header.base_prefix_revision||digest({...prefix.receipt,reused:false})!==a.header.base_prefix_receipt_digest)fail('TYPED_RECEIPT_INVALID')
 return operationId===a.binding.basePrefixOperationId?prefix.receipt:stored(db,b,operationId,w,a.base)?.receipt
}

/** Only after the fixed capacity union is admitted: unchanged private stored() authenticates actual old ACKs. */
export function sessionImportReceiptInCapacityV2(db:DatabaseSync,input:CapacityBindingV2,operationId:string):SessionImportReceipt|undefined{
 try{analysisId(operationId)}catch{fail('TYPED_INPUT_INVALID')}
 const capacity=readCapacityAdmission(db,input),a=readTypedStageCapacityAdmission(db,input.projection,LIMIT-capacity.byteWork),b=a.binding.base,w=new Work(capacity.byteWork+a.byteWork),prefix=stored(db,b,a.binding.basePrefixOperationId,w,a.base)
 if(!prefix||prefix.receipt.cursor.phase!=='metadata-complete'||String(prefix.receipt.resultRevision)!==a.header.base_prefix_revision||digest({...prefix.receipt,reused:false})!==a.header.base_prefix_receipt_digest)fail('TYPED_RECEIPT_INVALID')
 return operationId===a.binding.basePrefixOperationId?prefix.receipt:stored(db,b,operationId,w,a.base)?.receipt
}
