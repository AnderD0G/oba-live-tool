import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {DatabaseSync} from 'node:sqlite'
import {analysisId,analysisInteger,validateAnalysisScope,type AnalysisScope,type ReanalysisJob} from "../../../../shared/analysisRoom"
import type {AttributeSnapshot,PublishedAttributeDictionary} from "../../../../shared/audienceAttributes"
import type {TypedStageBinding} from "./CaptureTypedStageSchema"
import {BASE_NAMES,TYPED_DEFINITIONS,baseHeader,catalog as baseCatalog} from "./CaptureMetadataRequestDefinition"
import {CAPACITY_POLICY_V2} from "./CaptureCapacityPolicyV2"
import {readStagedLiteral,type StagedLiteralSpan} from "./CaptureStagedExtent"
import {parseHistoricalResultEnvelope} from "./CaptureHistoricalSnapshot"
type Row=Record<string,string|number|null>
type Step={rowMutations:number;encodedBytes:number;byteWork:number}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),json=(v:unknown):string=>JSON.stringify(v),size=(v:unknown)=>Buffer.byteLength(json(v))
const normalize=(sql:string)=>sql.trim().replace(/\s+/g,' ').replace(/;$/,'')
const DDL=`
CREATE TABLE history_projection_header(singleton INTEGER PRIMARY KEY CHECK(singleton=1),database_id TEXT NOT NULL,generation INTEGER NOT NULL,run_id TEXT NOT NULL,manifest_digest TEXT NOT NULL,schema_digest TEXT NOT NULL) STRICT;
CREATE TABLE history_jobs(
 job_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,session_id TEXT NOT NULL,
 mapping_version INTEGER NOT NULL CHECK(mapping_version>=1),created_at INTEGER NOT NULL CHECK(created_at>=0),
 declared_status TEXT NOT NULL CHECK(declared_status IN('running','completed','failed')),
 declared_received INTEGER NOT NULL CHECK(declared_received>=0),declared_saved INTEGER NOT NULL CHECK(declared_saved>=0 AND declared_saved<=declared_received),
 declared_finished_at INTEGER,declared_error TEXT,metadata_source_id INTEGER NOT NULL UNIQUE,metadata_sha256 TEXT NOT NULL,
 next_position INTEGER NOT NULL DEFAULT 1 CHECK(next_position>=1),contiguous_saved INTEGER NOT NULL DEFAULT 0 CHECK(contiguous_saved>=0),broken INTEGER NOT NULL DEFAULT 0 CHECK(broken IN(0,1)),
 imported INTEGER NOT NULL DEFAULT 0 CHECK(imported IN(0,1)),effective_status TEXT,effective_received INTEGER,effective_saved INTEGER,effective_finished_at INTEGER,effective_error TEXT,
 FOREIGN KEY(session_id) REFERENCES sessions(id),FOREIGN KEY(metadata_source_id) REFERENCES legacy_sources(id)
) STRICT;
CREATE TABLE history_results(
 job_id TEXT NOT NULL,physical_ordinal INTEGER NOT NULL CHECK(physical_ordinal>=1),result_sequence INTEGER NOT NULL CHECK(result_sequence>=1),
 source_id INTEGER NOT NULL,start_offset INTEGER NOT NULL,next_offset INTEGER NOT NULL,literal_sha256 TEXT NOT NULL,
 user_id TEXT,nickname TEXT,observation_id TEXT NOT NULL,stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,observed_at INTEGER NOT NULL,platform_time INTEGER,
 expected_facts INTEGER NOT NULL CHECK(expected_facts>=0 AND expected_facts<=1000),facts_digest TEXT,sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN(0,1)),
 PRIMARY KEY(job_id,physical_ordinal),UNIQUE(source_id,start_offset),FOREIGN KEY(job_id) REFERENCES history_jobs(job_id),FOREIGN KEY(source_id) REFERENCES legacy_sources(id)
) STRICT;
CREATE TABLE history_result_facts(
 job_id TEXT NOT NULL,physical_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=1),attribute_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('known','unknown','conflict')),type TEXT NOT NULL,value_json TEXT,reason TEXT,
 observation_id TEXT NOT NULL,stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,observed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 time_basis TEXT NOT NULL CHECK(time_basis IN('platform','local-sequence')),platform_time INTEGER,path TEXT,
 PRIMARY KEY(job_id,physical_ordinal,ordinal),UNIQUE(job_id,physical_ordinal,attribute_id),
 FOREIGN KEY(job_id,physical_ordinal) REFERENCES history_results(job_id,physical_ordinal),
 CHECK((status='known' AND value_json IS NOT NULL AND reason IS NULL AND json_valid(value_json) AND json_type(value_json) IN('text','integer','real','true','false')) OR(status<>'known' AND value_json IS NULL AND reason IS NOT NULL))
) STRICT;
CREATE TABLE history_import_lines(source_id INTEGER NOT NULL,start_offset INTEGER NOT NULL,next_offset INTEGER NOT NULL,literal_sha256 TEXT NOT NULL,job_id TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN('accepted','rejected')),physical_ordinal INTEGER,code TEXT,PRIMARY KEY(source_id,start_offset),FOREIGN KEY(source_id) REFERENCES legacy_sources(id),FOREIGN KEY(job_id) REFERENCES history_jobs(job_id)) STRICT;
CREATE INDEX history_jobs_scope ON history_jobs(account_id,platform,source,created_at,job_id);
CREATE INDEX history_results_sequence ON history_results(job_id,result_sequence,physical_ordinal);
CREATE INDEX history_results_page ON history_results(job_id,sealed,physical_ordinal);
CREATE TRIGGER history_header_immutable_update BEFORE UPDATE ON history_projection_header BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_header_immutable_delete BEFORE DELETE ON history_projection_header BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_job_identity BEFORE UPDATE ON history_jobs WHEN OLD.job_id IS NOT NEW.job_id OR OLD.account_id IS NOT NEW.account_id OR OLD.platform IS NOT NEW.platform OR OLD.source IS NOT NEW.source OR OLD.session_id IS NOT NEW.session_id OR OLD.mapping_version IS NOT NEW.mapping_version OR OLD.created_at IS NOT NEW.created_at OR OLD.declared_status IS NOT NEW.declared_status OR OLD.declared_received IS NOT NEW.declared_received OR OLD.declared_saved IS NOT NEW.declared_saved OR OLD.declared_finished_at IS NOT NEW.declared_finished_at OR OLD.declared_error IS NOT NEW.declared_error OR OLD.metadata_source_id IS NOT NEW.metadata_source_id OR OLD.metadata_sha256 IS NOT NEW.metadata_sha256 OR OLD.imported=1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_JOB'); END;
CREATE TRIGGER history_job_no_delete BEFORE DELETE ON history_jobs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_result_identity BEFORE UPDATE ON history_results WHEN OLD.job_id IS NOT NEW.job_id OR OLD.physical_ordinal IS NOT NEW.physical_ordinal OR OLD.result_sequence IS NOT NEW.result_sequence OR OLD.source_id IS NOT NEW.source_id OR OLD.start_offset IS NOT NEW.start_offset OR OLD.next_offset IS NOT NEW.next_offset OR OLD.literal_sha256 IS NOT NEW.literal_sha256 OR OLD.user_id IS NOT NEW.user_id OR OLD.nickname IS NOT NEW.nickname OR OLD.observation_id IS NOT NEW.observation_id OR OLD.stream_id IS NOT NEW.stream_id OR OLD.sequence IS NOT NEW.sequence OR OLD.observed_at IS NOT NEW.observed_at OR OLD.platform_time IS NOT NEW.platform_time OR OLD.expected_facts IS NOT NEW.expected_facts OR OLD.sealed<>0 OR NEW.sealed<>1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_RESULT'); END;
CREATE TRIGGER history_result_no_delete BEFORE DELETE ON history_results BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_fact_no_update BEFORE UPDATE ON history_result_facts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_fact_no_delete BEFORE DELETE ON history_result_facts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_fact_after_seal BEFORE INSERT ON history_result_facts WHEN (SELECT sealed FROM history_results WHERE job_id=NEW.job_id AND physical_ordinal=NEW.physical_ordinal)<>0 BEGIN SELECT RAISE(ABORT,'SEALED_HISTORY_RESULT'); END;
CREATE TRIGGER history_line_no_update BEFORE UPDATE ON history_import_lines BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
CREATE TRIGGER history_line_no_delete BEFORE DELETE ON history_import_lines BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
`
const definitions=[...(DDL.match(/CREATE (?:TABLE|INDEX) [^;]+;/g)??[]),...(DDL.match(/CREATE TRIGGER[\s\S]*? END;/g)??[])].map(sql=>{const m=normalize(sql).match(/^CREATE (TABLE|INDEX|TRIGGER) (\w+)/)!;return {type:m[1].toLowerCase(),name:m[2],sql:normalize(sql)}})
class HistoryError extends Error {constructor(readonly code:string){super(code)}}
function fail(code='HISTORY_INVALID'):never{throw new HistoryError(code)}
const nativeAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
function abort(signal?:AbortSignal){if(signal===undefined)return;try{if(types.isProxy(signal)||nativeAborted.call(signal))fail('HISTORY_ABORTED')}catch{fail('HISTORY_ABORTED')}}
const scalarJson=(v:string|number|boolean)=>typeof v==='number'&&Object.is(v,-0)?'-0':json(v)
const unjson=(v:string|number|null)=>typeof v==='string'?JSON.parse(v):undefined
function checkedScope(input:unknown):AnalysisScope {try{return validateAnalysisScope(input)}catch{return fail('HISTORY_SCOPE_INVALID')}}
function checkedSpan(input:unknown):StagedLiteralSpan {
 if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('HISTORY_SOURCE_INVALID')
 const keys=['sourceId','startOffset','nextOffset'];if(Reflect.ownKeys(input).length!==3)fail('HISTORY_SOURCE_INVALID')
 const out:Record<string,number>={}
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!d.enumerable||!('value'in d))fail('HISTORY_SOURCE_INVALID');out[key]=analysisInteger(d.value,key==='startOffset'?0:1)}
 if(out.nextOffset<=out.startOffset)fail('HISTORY_SOURCE_INVALID')
 return out as unknown as StagedLiteralSpan
}
/** Trusted private DB domain. No file opener, final authority or worker dispatch. */
export class HistoryProjection {
 private cookie:number
 private busy=false
 private readonly header:Row
 constructor(readonly db:DatabaseSync,readonly binding:TypedStageBinding){
  this.header={singleton:1,database_id:binding.identity.databaseId,generation:binding.identity.generation,run_id:binding.runId,manifest_digest:binding.manifestDigest,schema_digest:sha(normalize(DDL))}
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_projection_header'").get()){
   baseCatalog(db,false);baseHeader(db,{base:binding,policy:CAPACITY_POLICY_V2});if(db.isTransaction)fail('HISTORY_TRANSACTION_INVALID')
   let attempted=false;db.exec('BEGIN IMMEDIATE');try{db.exec(DDL);this.insert('history_projection_header',this.header);attempted=true;db.exec('COMMIT')}catch(e){try{if(db.isTransaction)db.exec('ROLLBACK')}catch{};if(attempted)fail('HISTORY_COMMIT_UNCERTAIN');if(e instanceof HistoryError)throw e;fail('HISTORY_SCHEMA_INVALID')}
  }
  this.catalog();this.cookie=Number(db.prepare('PRAGMA schema_version').get()!.schema_version);this.guard()
 }
 private catalog(){
  const wanted=[...BASE_NAMES,...TYPED_DEFINITIONS.map(x=>x.name),...definitions.map(x=>x.name)],rows=this.db.prepare("SELECT type,name,length(CAST(sql AS BLOB)) n FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT ?").all(wanted.length+1)
  if(rows.length!==wanted.length||rows.some(r=>!wanted.includes(String(r.name))||Number(r.n)<1||Number(r.n)>32768))fail('HISTORY_SCHEMA_INVALID')
  const base:string[]=[]
  for(const row of rows){const sql=normalize(String(this.db.prepare('SELECT substr(sql,1,32769) sql FROM sqlite_master WHERE type=? AND name=?').get(row.type,row.name)!.sql));if(BASE_NAMES.includes(String(row.name)))base.push(`${row.type}|${row.name}|${sql}\n`);else if(![...TYPED_DEFINITIONS,...definitions].some(x=>x.type===row.type&&x.name===row.name&&x.sql===sql))fail('HISTORY_SCHEMA_INVALID')}
  if(sha(base.join(''))!=='76817cee32be166ef95b0fb3d30f68177e9095bacdc297525d0afe94caba867d')fail('HISTORY_SCHEMA_INVALID')
 }
 private guard(){
  if(Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version)!==this.cookie||this.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys!==1||this.db.prepare('PRAGMA synchronous').get()!.synchronous!==2||this.db.prepare('PRAGMA journal_mode').get()!.journal_mode!=='wal')fail('HISTORY_REVOKED')
  if(json(this.db.prepare('SELECT * FROM history_projection_header WHERE singleton=1').get())!==json(this.header))fail('HISTORY_BINDING_CONFLICT')
  baseHeader(this.db,{base:this.binding,policy:CAPACITY_POLICY_V2})
 }
 private insert(table:string,row:Row){const names=Object.keys(row);this.db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(row))}
 private transaction(rows:readonly Row[],work:number,fn:()=>void,signal?:AbortSignal):Step {
  abort(signal)
  this.guard();if(this.db.isTransaction)fail('HISTORY_TRANSACTION_INVALID')
  const encodedBytes=size(rows),byteWork=work+3*encodedBytes+32768
  if(encodedBytes>1048576||byteWork>1048576||rows.length>128)fail('HISTORY_STEP_LIMIT')
  const before=Number(this.db.prepare('SELECT total_changes() n').get()!.n);let commit=false
  this.db.exec('BEGIN IMMEDIATE')
  try{this.guard();fn();abort(signal);const rowMutations=Number(this.db.prepare('SELECT total_changes() n').get()!.n)-before;if(rowMutations>128||rowMutations!==rows.length)fail('HISTORY_EFFECT_INVALID');commit=true;this.db.exec('COMMIT');return {rowMutations,encodedBytes,byteWork}}catch(e){try{this.db.exec('ROLLBACK')}catch{};if(commit)fail('HISTORY_COMMIT_UNCERTAIN');throw e}
 }
 private source(sourceId:number){
  analysisInteger(sourceId,1)
  const row=this.db.prepare('SELECT id,substr(relative_path,1,4097) path,size,verified,substr(sha256,1,65) sha256 FROM legacy_sources WHERE id=?').get(sourceId)
  const member=this.db.prepare('SELECT role,source_size,substr(source_sha256,1,65) sha256 FROM legacy_typed_sources WHERE run_id=? AND source_id=?').get(this.binding.runId,sourceId)
  if(!row||row.verified!==1||String(row.path).length>4096||!member||member.role!=='deferred-history'||member.source_size!==row.size||member.sha256!==row.sha256)fail('HISTORY_SOURCE_INVALID')
  return row
 }
 private job(jobId:string,scope?:AnalysisScope):Row {this.guard();analysisId(jobId);const row=this.db.prepare('SELECT * FROM history_jobs WHERE job_id=?').get(jobId) as Row|undefined;if(!row||scope&&(json(scope.accountId)!==row.account_id||scope.platform!==row.platform||scope.source!==row.source))fail('HISTORY_NOT_FOUND');return row}
 private declared(row:Row):ReanalysisJob {return {id:String(row.job_id),scope:{accountId:unjson(row.account_id),platform:row.platform,source:row.source} as AnalysisScope,sessionId:String(row.session_id),mappingVersion:Number(row.mapping_version),createdAt:Number(row.created_at),status:row.declared_status as ReanalysisJob['status'],received:Number(row.declared_received),saved:Number(row.declared_saved),...(row.declared_finished_at===null?{}:{finishedAt:Number(row.declared_finished_at)}),...(row.declared_error===null?{}:{error:String(row.declared_error)})}}
 private effective(row:Row):ReanalysisJob {const j=this.declared(row);if(row.imported!==1)fail('HISTORY_INCOMPLETE');return {...j,status:row.effective_status as ReanalysisJob['status'],received:Number(row.effective_received),saved:Number(row.effective_saved),...(row.effective_finished_at===null?{}:{finishedAt:Number(row.effective_finished_at)}),...(row.effective_error===null?{}:{error:String(row.effective_error)})}}
 private facts(jobId:string,position:number,s:AttributeSnapshot):Row[]{return Object.entries(s.values).map(([id,f],i):Row=>({job_id:jobId,physical_ordinal:position,ordinal:i+1,attribute_id:json(id),status:f.status,type:f.type,value_json:f.status==='known'?scalarJson(f.value as string|number|boolean):null,reason:f.status==='known'?null:json(f.reason),observation_id:json(f.observationId),stream_id:json(f.streamId),sequence:f.sequence,observed_at:f.observedAt,expires_at:f.expiresAt,time_basis:f.timeBasis,platform_time:f.platformTime??null,path:f.path===undefined?null:json(f.path)}))}
 private acceptedSourceRetry(jobId:string,line:Row,parsed:ReturnType<typeof parseHistoricalResultEnvelope>){
  const position=analysisInteger(line.physical_ordinal,1),s=parsed.snapshot,facts=this.facts(jobId,position,s)
  if(facts.length>1000)fail('HISTORY_FACT_LIMIT')
  const sizes=this.db.prepare('SELECT length(CAST(job_id AS BLOB)) j,length(CAST(literal_sha256 AS BLOB)) l,length(CAST(facts_digest AS BLOB)) f,length(CAST(user_id AS BLOB)) u,length(CAST(nickname AS BLOB)) n,length(CAST(observation_id AS BLOB)) o,length(CAST(stream_id AS BLOB)) s FROM history_results WHERE job_id=? AND physical_ordinal=?').get(jobId,position)
  if(!sizes||sizes.l!==64||sizes.f!==64||Object.values(sizes).some(v=>v!==null&&(!Number.isSafeInteger(v)||Number(v)>16384)))fail('HISTORY_FACT_CONFLICT')
  const expected:Row={job_id:jobId,physical_ordinal:position,result_sequence:parsed.resultSequence,source_id:line.source_id,start_offset:line.start_offset,next_offset:line.next_offset,literal_sha256:line.literal_sha256,user_id:s.userId===undefined?null:json(s.userId),nickname:s.nickname===undefined?null:json(s.nickname),observation_id:json(s.observationId),stream_id:json(s.streamId),sequence:s.sequence,observed_at:s.observedAt,platform_time:s.platformTime??null,expected_facts:facts.length,sealed:1,facts_digest:sha(facts.map(f=>json(f)).join('\n'))}
  const row=this.db.prepare('SELECT * FROM history_results WHERE job_id=? AND physical_ordinal=?').get(jobId,position) as Row|undefined
  if(!row||Object.entries(expected).some(([k,v])=>row[k]!==v)||line.code!==null)fail('HISTORY_FACT_CONFLICT')
  let after=0
  for(;;){
   const lengths=this.db.prepare(`SELECT ordinal,${['attribute_id','type','value_json','reason','observation_id','stream_id','time_basis','path'].map(k=>'length(CAST('+k+' AS BLOB)) n_'+k).join(',')} FROM history_result_facts WHERE job_id=? AND physical_ordinal=? AND ordinal>? ORDER BY ordinal LIMIT 32`).all(jobId,position,after)
   if(!lengths.length)break
   let bytes=0
   for(const f of lengths){for(const[k,v]of Object.entries(f))if(k!=='ordinal'&&v!==null){if(!Number.isSafeInteger(v)||Number(v)>16384)fail('HISTORY_FACT_CONFLICT');bytes+=Number(v)}}
   if(3*bytes+32*1024>1048576)fail('HISTORY_READ_LIMIT')
   const rows=this.db.prepare('SELECT * FROM history_result_facts WHERE job_id=? AND physical_ordinal=? AND ordinal>? ORDER BY ordinal LIMIT 32').all(jobId,position,after) as Row[]
   if(rows.length!==lengths.length)fail('HISTORY_FACT_CONFLICT')
   for(const stored of rows){const fact=facts[after];if(!fact||stored.ordinal!==after+1||Object.entries(fact).some(([k,v])=>stored[k]!==v))fail('HISTORY_FACT_CONFLICT');after++}
  }
  if(after!==facts.length)fail('HISTORY_FACT_CONFLICT')
 }
 importJob(sourceId:number){
  this.guard();const source=this.source(sourceId),match=String(source.path).match(/^history\/([0-9a-f-]{36})\/metadata\.json$/i)
  if(!match||Number(source.size)<1||Number(source.size)>131072)fail('HISTORY_METADATA_INVALID')
  const literal=readStagedLiteral(this.db,{sourceId,startOffset:0,nextOffset:Number(source.size)},131072,700000)
  let job:ReanalysisJob
  try{const v=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(literal.bytes)),scope=checkedScope(v.scope);analysisId(v.id);analysisId(v.sessionId);if(v.id!==match[1]||!['running','completed','failed'].includes(v.status))fail();for(const k of ['mappingVersion','createdAt','received','saved'])analysisInteger(v[k],k==='mappingVersion'?1:0);if(v.saved>v.received)fail();if(v.finishedAt!==undefined)analysisInteger(v.finishedAt);if(v.error!==undefined&&!/^[A-Z_]{1,128}$/.test(v.error))fail();job={id:v.id,scope,sessionId:v.sessionId,mappingVersion:v.mappingVersion,status:v.status,received:v.received,saved:v.saved,createdAt:v.createdAt,...(v.finishedAt===undefined?{}:{finishedAt:v.finishedAt}),...(v.error===undefined?{}:{error:v.error})}}catch{fail('HISTORY_METADATA_INVALID')}
  const parent=this.db.prepare('SELECT account_id,platform,source FROM sessions WHERE id=?').get(job.sessionId)
  if(!parent||parent.account_id!==job.scope.accountId||parent.platform!==job.scope.platform||parent.source!==job.scope.source)fail('HISTORY_OWNER_INVALID')
  const row:Row={job_id:job.id,account_id:json(job.scope.accountId),platform:job.scope.platform,source:job.scope.source,session_id:job.sessionId,mapping_version:job.mappingVersion,created_at:job.createdAt,declared_status:job.status,declared_received:job.received,declared_saved:job.saved,declared_finished_at:job.finishedAt??null,declared_error:job.error??null,metadata_source_id:sourceId,metadata_sha256:literal.literalSha256}
  const old=this.db.prepare('SELECT * FROM history_jobs WHERE job_id=?').get(job.id) as Row|undefined
  if(old){if(Object.entries(row).some(([k,v])=>old[k]!==v))fail('HISTORY_SOURCE_CONFLICT');return {...job,reused:true}}
  const step=this.transaction([row],literal.byteWork+4*literal.bytes.length,()=>this.insert('history_jobs',row));return {...job,reused:false,step}
 }
 async importResult(jobId:string,span:StagedLiteralSpan,dictionary:PublishedAttributeDictionary,signal?:AbortSignal){
  abort(signal)
  span=checkedSpan(span)
  if(this.busy)fail('HISTORY_BUSY');this.busy=true
  try{
   const row=this.job(jobId),job=this.declared(row),source=this.source(span.sourceId)
   if(!new RegExp(`^history/${jobId}/[0-9]{6}\\.jsonl$`).test(String(source.path)))fail('HISTORY_SOURCE_INVALID')
   const indexed=this.db.prepare('SELECT next_offset FROM legacy_lines WHERE source_id=? AND start_offset=?').get(span.sourceId,span.startOffset)
   if(!indexed||indexed.next_offset!==span.nextOffset)fail('HISTORY_SOURCE_INVALID')
   const literal=readStagedLiteral(this.db,span,131074,750000),existing=this.db.prepare('SELECT * FROM history_import_lines WHERE source_id=? AND start_offset=?').get(span.sourceId,span.startOffset) as Row|undefined
   if(existing&&(existing.job_id!==jobId||existing.literal_sha256!==literal.literalSha256||existing.next_offset!==span.nextOffset))fail('HISTORY_SOURCE_CONFLICT')
   if(!existing&&row.imported===1)fail('HISTORY_FINISHED')
   let parsed:ReturnType<typeof parseHistoricalResultEnvelope>
   try{let text=new TextDecoder('utf8',{fatal:true}).decode(literal.bytes);if(text.endsWith('\n'))text=text.slice(0,-1);if(text.endsWith('\r'))text=text.slice(0,-1);parsed=parseHistoricalResultEnvelope(text,job,dictionary)}catch{
    if(existing){if(existing.outcome!=='rejected'||existing.code!=='HISTORY_LITERAL_INVALID'||existing.physical_ordinal!==null||row.broken!==1||this.db.prepare('SELECT 1 FROM history_results WHERE source_id=? AND start_offset=?').get(span.sourceId,span.startOffset))fail('HISTORY_SOURCE_CONFLICT');return {reused:true,steps:[] as Step[]}}
    const diagnostic:Row={source_id:span.sourceId,start_offset:span.startOffset,next_offset:span.nextOffset,literal_sha256:literal.literalSha256,job_id:jobId,outcome:'rejected',physical_ordinal:null,code:'HISTORY_LITERAL_INVALID'},changed:Row={job_id:jobId,broken:1}
    const step=this.transaction([diagnostic,changed],literal.byteWork+4*literal.bytes.length,()=>{this.insert('history_import_lines',diagnostic);this.db.prepare('UPDATE history_jobs SET broken=1 WHERE job_id=? AND imported=0').run(jobId)},signal);return {reused:false,rejected:true,steps:[step]}
   }
   if(existing){if(existing.outcome!=='accepted')fail('HISTORY_SOURCE_CONFLICT');this.acceptedSourceRetry(jobId,existing,parsed);return {reused:true,steps:[] as Step[]}}
   const s=parsed.snapshot,values=Object.entries(s.values);if(values.length>1000)fail('HISTORY_FACT_LIMIT')
   const steps:Step[]=[],old=this.db.prepare('SELECT * FROM history_results WHERE source_id=? AND start_offset=?').get(span.sourceId,span.startOffset) as Row|undefined,position=old?Number(old.physical_ordinal):Number(row.next_position)
   const header:Row={job_id:jobId,physical_ordinal:position,result_sequence:parsed.resultSequence,source_id:span.sourceId,start_offset:span.startOffset,next_offset:span.nextOffset,literal_sha256:literal.literalSha256,user_id:s.userId===undefined?null:json(s.userId),nickname:s.nickname===undefined?null:json(s.nickname),observation_id:json(s.observationId),stream_id:json(s.streamId),sequence:s.sequence,observed_at:s.observedAt,platform_time:s.platformTime??null,expected_facts:values.length}
   if(old){if(Object.entries(header).some(([k,v])=>old[k]!==v)||old.sealed!==0)fail('HISTORY_SOURCE_CONFLICT')}
   else steps.push(this.transaction([header,{job_id:jobId,next_position:position+1}],literal.byteWork+4*literal.bytes.length,()=>{this.insert('history_results',header);if(this.db.prepare('UPDATE history_jobs SET next_position=? WHERE job_id=? AND next_position=? AND imported=0').run(position+1,jobId,position).changes!==1)fail('HISTORY_STALE')},signal))
   const facts=this.facts(jobId,position,s)
   for(let i=0;i<facts.length;i+=32){abort(signal);const chunk=facts.slice(i,i+32),added:Row[]=[];for(const fact of chunk){const stored=this.db.prepare('SELECT * FROM history_result_facts WHERE job_id=? AND physical_ordinal=? AND ordinal=?').get(jobId,position,fact.ordinal) as Row|undefined;if(stored){if(Object.entries(fact).some(([k,v])=>stored[k]!==v))fail('HISTORY_FACT_CONFLICT')}else added.push(fact)}if(added.length)steps.push(this.transaction(added,2*size(chunk),()=>{for(const fact of added)this.insert('history_result_facts',fact)},signal));await new Promise<void>(resolve=>setImmediate(resolve))}
   const current=this.job(jobId),saved=Number(current.contiguous_saved),next=parsed.resultSequence===saved+1?saved+1:saved,digest=sha(facts.map(f=>json(f)).join('\n'))
   const result:Row={job_id:jobId,physical_ordinal:position,sealed:1,facts_digest:digest},line:Row={source_id:span.sourceId,start_offset:span.startOffset,next_offset:span.nextOffset,literal_sha256:literal.literalSha256,job_id:jobId,outcome:'accepted',physical_ordinal:position,code:null},progress:Row={job_id:jobId,contiguous_saved:next,broken:current.broken===1||next===saved?1:0}
   steps.push(this.transaction([result,line,progress],3*size(facts),()=>{this.db.prepare('UPDATE history_results SET sealed=1,facts_digest=? WHERE job_id=? AND physical_ordinal=? AND sealed=0').run(digest,jobId,position);this.insert('history_import_lines',line);this.db.prepare('UPDATE history_jobs SET contiguous_saved=?,broken=? WHERE job_id=? AND imported=0').run(next,progress.broken,jobId)},signal))
   return {reused:false,steps}
  }finally{this.busy=false}
 }
 finishJob(jobId:string){
  if(this.busy)fail('HISTORY_BUSY');const row=this.job(jobId);if(row.imported===1)return this.effective(row)
  const prefix=`history/${jobId}/`,sources=this.db.prepare('SELECT id,relative_path FROM legacy_sources WHERE relative_path>=? AND relative_path<? ORDER BY relative_path LIMIT 1001').all(prefix,prefix+'\uffff');if(sources.length>1000)fail('HISTORY_SOURCE_LIMIT')
  for(const source of sources)if(/\/[0-9]{6}\.jsonl$/.test(String(source.relative_path))&&this.db.prepare('SELECT 1 FROM legacy_lines l WHERE l.source_id=? AND NOT EXISTS(SELECT 1 FROM history_import_lines h WHERE h.source_id=l.source_id AND h.start_offset=l.start_offset) LIMIT 1').get(source.id))fail('HISTORY_INCOMPLETE')
  if(this.db.prepare('SELECT 1 FROM history_results WHERE job_id=? AND sealed=0 LIMIT 1').get(jobId))fail('HISTORY_INCOMPLETE')
  const mismatch=row.declared_status==='running'||row.declared_saved!==row.contiguous_saved||row.broken===1,status=mismatch?'failed':String(row.declared_status),error=mismatch?(row.broken===1?'CORRUPT_RESULTS':'APP_INTERRUPTED'):row.declared_error
  const changed:Row={job_id:jobId,imported:1,effective_status:status,effective_received:Math.max(Number(row.declared_received),Number(row.contiguous_saved)),effective_saved:row.contiguous_saved,effective_finished_at:mismatch?this.binding.policy.normalizationTimestamp:row.declared_finished_at,effective_error:error}
  this.transaction([changed],2*size(sources),()=>{this.db.prepare('UPDATE history_jobs SET imported=1,effective_status=?,effective_received=?,effective_saved=?,effective_finished_at=?,effective_error=? WHERE job_id=? AND imported=0').run(status,changed.effective_received,changed.effective_saved,changed.effective_finished_at,error,jobId)});return this.effective(this.job(jobId))
 }
 jobsPage(input:unknown,options:{limit?:number;beforeCreatedAt?:number;beforeJobId?:string}={}){this.guard();const scope=checkedScope(input),limit=analysisInteger(options.limit??50,1,100),before=options.beforeCreatedAt??Number.MAX_SAFE_INTEGER,id=options.beforeJobId??'\uffff';const rows=this.db.prepare('SELECT * FROM history_jobs WHERE account_id=? AND platform=? AND source=? AND imported=1 AND (created_at<? OR(created_at=? AND job_id<?)) ORDER BY created_at DESC,job_id DESC LIMIT ?').all(json(scope.accountId),scope.platform,scope.source,before,before,id,limit+1) as Row[];return {items:rows.slice(0,limit).map(r=>this.effective(r)),...(rows.length>limit?{next:{beforeCreatedAt:Number(rows[limit-1].created_at),beforeJobId:String(rows[limit-1].job_id)}}:{})}}
 resultsPage(input:unknown,jobId:string,options:{limit?:number;after?:number;upper?:number}={}){
  const scope=checkedScope(input),job=this.job(jobId,scope);this.effective(job);const limit=analysisInteger(options.limit??50,1,100),upper=analysisInteger(options.upper??Number(job.next_position)-1),after=analysisInteger(options.after??0);if(upper>=Number(job.next_position)||after>upper)fail('HISTORY_CURSOR_INVALID')
  const rows=this.db.prepare('SELECT * FROM history_results WHERE job_id=? AND sealed=1 AND physical_ordinal>? AND physical_ordinal<=? AND result_sequence<=? ORDER BY physical_ordinal LIMIT ?').all(jobId,after,upper,job.effective_saved!,limit+1) as Row[]
  const items:AttributeSnapshot[]=[],selected:Row[]=[];let reservation=0
  for(const r of rows.slice(0,limit)){
   const lengths=this.db.prepare(`SELECT count(*) n,coalesce(sum(length(CAST(attribute_id AS BLOB))+length(CAST(type AS BLOB))+coalesce(length(CAST(value_json AS BLOB)),0)+coalesce(length(CAST(reason AS BLOB)),0)+length(CAST(observation_id AS BLOB))+length(CAST(stream_id AS BLOB))+length(CAST(time_basis AS BLOB))+coalesce(length(CAST(path AS BLOB)),0)),0) b FROM(SELECT attribute_id,type,value_json,reason,observation_id,stream_id,time_basis,path FROM history_result_facts WHERE job_id=? AND physical_ordinal=? ORDER BY ordinal LIMIT 1001)`).get(jobId,r.physical_ordinal!)!
   if(lengths.n!==r.expected_facts||Number(lengths.n)>1000)fail('HISTORY_FACT_CONFLICT')
   const needed=Number(lengths.b)+Number(lengths.n)*(512+2*size(scope))+2*size(r)
   if(reservation+needed>1048576){if(!items.length)fail('HISTORY_READ_LIMIT');break}
   reservation+=needed
   const facts=this.db.prepare('SELECT * FROM history_result_facts WHERE job_id=? AND physical_ordinal=? ORDER BY ordinal LIMIT 1001').all(jobId,r.physical_ordinal!) as Row[]
   if(facts.length!==r.expected_facts||sha(facts.map(f=>json(f)).join('\n'))!==r.facts_digest)fail('HISTORY_FACT_CONFLICT')
   const values:AttributeSnapshot['values']={}
   for(const f of facts){const common={scope,mappingVersion:Number(job.mapping_version),type:f.type,observationId:unjson(f.observation_id),streamId:unjson(f.stream_id),sequence:Number(f.sequence),observedAt:Number(f.observed_at),expiresAt:Number(f.expires_at),timeBasis:f.time_basis,...(f.platform_time===null?{}:{platformTime:Number(f.platform_time)}),...(f.path===null?{}:{path:unjson(f.path)})};values[unjson(f.attribute_id)]={...common,status:f.status,...(f.status==='known'?{value:unjson(f.value_json)}:{reason:unjson(f.reason)})} as AttributeSnapshot['values'][string]}
   items.push({origin:'history',scope,mappingVersion:Number(job.mapping_version),observationId:unjson(r.observation_id),streamId:unjson(r.stream_id),sequence:Number(r.sequence),observedAt:Number(r.observed_at),...(r.user_id===null?{}:{userId:unjson(r.user_id)}),...(r.nickname===null?{}:{nickname:unjson(r.nickname)}),...(r.platform_time===null?{}:{platformTime:Number(r.platform_time)}),values});selected.push(r)
  }
  if(size(items)>1048576)fail('HISTORY_READ_LIMIT');return {items,upper,...(rows.length>selected.length?{nextAfter:Number(selected.at(-1)!.physical_ordinal)}:{})}
 }
}
