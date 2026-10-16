import type {DatabaseSync} from 'node:sqlite'
import type {CaptureDatabaseIdentity} from './CaptureStorage'
import {initializeCaptureSchema} from './CaptureDatabaseSchema'
import {CAPTURE_ACTIVE_SCOPE_INDEX_SQL,CAPTURE_ACTIVE_ACCOUNT_INDEX_SQL} from './CaptureSessionMetadataView'
export class CaptureLiveControlError extends Error {constructor(readonly code:string){super(code)}}
export const CAPTURE_LIVE_CONTROL_VERSION=1
export const CAPTURE_LIVE_RESULT_BYTES=8192
export const CAPTURE_LIVE_TERMINAL_CREDIT_BYTES=16*1024
const definitions=[
`CREATE TABLE live_control_meta(id INTEGER PRIMARY KEY CHECK(id=1),extension_version INTEGER NOT NULL,database_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),control_watermark INTEGER NOT NULL CHECK(control_watermark>=0),metadata_used_bytes INTEGER NOT NULL CHECK(metadata_used_bytes>=0),terminal_reserved_bytes INTEGER NOT NULL CHECK(terminal_reserved_bytes>=0)) STRICT`,
`CREATE TABLE live_session_controls(session_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,control_revision INTEGER NOT NULL CHECK(control_revision>0),start_state TEXT NOT NULL CHECK(start_state IN('prepared','ready','failed')),stop_requested INTEGER NOT NULL CHECK(stop_requested IN(0,1)),unclean_epoch INTEGER NOT NULL CHECK(unclean_epoch IN(0,1)),counter_loss_known INTEGER NOT NULL CHECK(counter_loss_known IN(0,1)),terminal_credit_bytes INTEGER NOT NULL CHECK(terminal_credit_bytes>=0),UNIQUE(session_id,account_id,platform,source),FOREIGN KEY(session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source)) STRICT`,
`CREATE TABLE live_account_slots(account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),retained_slots INTEGER NOT NULL CHECK(retained_slots>=0),active_session_id TEXT,platform TEXT,source TEXT,CHECK((active_session_id IS NULL AND platform IS NULL AND source IS NULL) OR(active_session_id IS NOT NULL AND platform IS NOT NULL AND source IS NOT NULL)),FOREIGN KEY(active_session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source)) STRICT`,
`CREATE TABLE live_requests(account_id TEXT NOT NULL,request_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('start','stop')),request_digest TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(created_at>=0),status TEXT NOT NULL CHECK(status IN('inflight','terminal')),request_revision INTEGER NOT NULL CHECK(request_revision>0),session_id TEXT NOT NULL,terminal_receipt_operation_id TEXT,error_code TEXT,retryable INTEGER CHECK(retryable IN(0,1)),retained_slot INTEGER NOT NULL CHECK(retained_slot IN(0,1)),PRIMARY KEY(account_id,request_id),CHECK((error_code IS NULL AND retryable IS NULL) OR(error_code IS NOT NULL AND retryable IS NOT NULL)),CHECK(status='inflight' OR terminal_receipt_operation_id IS NOT NULL),FOREIGN KEY(session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source),FOREIGN KEY(terminal_receipt_operation_id) REFERENCES live_control_receipts(operation_id)) STRICT`,
`CREATE TABLE live_control_receipts(operation_id TEXT PRIMARY KEY,intent_digest TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('prepare-start','start-result','prepare-stop','reject','finish')),account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,session_id TEXT NOT NULL,request_id TEXT,expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),result_revision INTEGER NOT NULL CHECK(result_revision>0),control_watermark INTEGER NOT NULL CHECK(control_watermark>0),record_watermark_at_commit INTEGER NOT NULL CHECK(record_watermark_at_commit>=0),result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=8192),FOREIGN KEY(session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source),FOREIGN KEY(account_id,request_id) REFERENCES live_requests(account_id,request_id)) STRICT`,
`CREATE INDEX live_requests_slots ON live_requests(account_id,retained_slot,status,created_at,request_id)`,
`CREATE INDEX live_controls_unclean ON live_session_controls(unclean_epoch,session_id)`,
`CREATE INDEX live_receipts_owner ON live_control_receipts(account_id,platform,source,session_id,control_watermark)`,
`CREATE TRIGGER live_meta_identity_update BEFORE UPDATE ON live_control_meta WHEN NEW.id IS NOT OLD.id OR NEW.extension_version IS NOT OLD.extension_version OR NEW.database_id IS NOT OLD.database_id OR NEW.generation IS NOT OLD.generation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_IDENTITY'); END`,
`CREATE TRIGGER live_meta_evidence_delete BEFORE DELETE ON live_control_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_IDENTITY'); END`,
`CREATE TRIGGER live_receipts_immutable_update BEFORE UPDATE ON live_control_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_RECEIPT'); END`,
`CREATE TRIGGER live_receipts_immutable_delete BEFORE DELETE ON live_control_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_RECEIPT'); END`,
`CREATE TRIGGER live_requests_identity_update BEFORE UPDATE ON live_requests WHEN NEW.account_id IS NOT OLD.account_id OR NEW.request_id IS NOT OLD.request_id OR NEW.platform IS NOT OLD.platform OR NEW.source IS NOT OLD.source OR NEW.action IS NOT OLD.action OR NEW.request_digest IS NOT OLD.request_digest OR NEW.created_at IS NOT OLD.created_at OR NEW.session_id IS NOT OLD.session_id BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_REQUEST'); END`,
`CREATE TRIGGER live_requests_terminal_update BEFORE UPDATE ON live_requests WHEN OLD.status='terminal' AND(NEW.status IS NOT OLD.status OR NEW.request_revision IS NOT OLD.request_revision OR NEW.terminal_receipt_operation_id IS NOT OLD.terminal_receipt_operation_id OR NEW.error_code IS NOT OLD.error_code OR NEW.retryable IS NOT OLD.retryable) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_RESULT'); END`,
`CREATE TRIGGER live_requests_evidence_delete BEFORE DELETE ON live_requests BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_REQUEST'); END`,
`CREATE TRIGGER live_controls_owner_update BEFORE UPDATE ON live_session_controls WHEN NEW.session_id IS NOT OLD.session_id OR NEW.account_id IS NOT OLD.account_id OR NEW.platform IS NOT OLD.platform OR NEW.source IS NOT OLD.source BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIVE_OWNER'); END`,
CAPTURE_ACTIVE_SCOPE_INDEX_SQL,CAPTURE_ACTIVE_ACCOUNT_INDEX_SQL,
] as const
const normalize=(sql:string)=>sql.replace(/\s+/g,' ').trim().replace(/;$/,'')
const objects=definitions.map(sql=>{const match=/^CREATE (TABLE|INDEX|TRIGGER) (\w+)/.exec(sql)!;return{sql,name:match[2],type:match[1].toLowerCase()}})
const fail=():never=>{throw new CaptureLiveControlError('CONTROL_SCHEMA_INVALID')}
function core(db:DatabaseSync,identity:CaptureDatabaseIdentity):void{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_meta'").get())fail()
 for(const [key,wanted]of [['database_id',identity.databaseId],['generation',String(identity.generation)],['schema_version','1']]){
  const row=db.prepare('SELECT length(CAST(value AS BLOB)) AS n,substr(value,1,65) AS value FROM database_meta WHERE key=?').get(key)
  if(!row||typeof row.n!=='number'||row.n>64||row.value!==wanted)fail()
 }
 // The existing branch verifies the exact frozen core DDL; it never bootstraps a missing core.
 initializeCaptureSchema(db,identity)
}
function definition(db:DatabaseSync,item:typeof objects[number]):boolean{
 const row=db.prepare('SELECT type,length(CAST(sql AS BLOB)) AS n,substr(sql,1,8193) AS sql FROM sqlite_master WHERE name=?').get(item.name)
 if(!row)return false
 if(row.type!==item.type||typeof row.n!=='number'||row.n>8192||typeof row.sql!=='string'||normalize(row.sql)!==normalize(item.sql))fail()
 return true
}
/** Explicit ordinary-core extension only. It is not a factory/authority opener. */
export function initializeCaptureLiveControlSchema(db:DatabaseSync,identity:CaptureDatabaseIdentity,mode:'create'|'existing'):void{
 try{
  if(!['create','existing'].includes(mode)||identity?.schemaVersion!==1)fail()
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE lower(name) GLOB 'legacy_*' LIMIT 1").get())fail()
  const present=db.prepare("SELECT name FROM sqlite_master WHERE lower(name) GLOB 'live_*' LIMIT 64").all()
  if(mode==='create'&&present.length)fail()
  if(mode==='existing'&&present.length!==objects.filter(x=>x.name.startsWith('live_')).length)fail()
  if(mode==='existing'){for(const item of objects)if(!definition(db,item))fail()}
  else for(const item of objects.filter(x=>!x.name.startsWith('live_')))definition(db,item)
  core(db,identity)
  if(mode==='existing'){
   const rows=db.prepare('SELECT * FROM live_control_meta LIMIT 2').all()
   if(rows.length!==1)fail();const row=rows[0]
   if(row.id!==1||row.extension_version!==1||row.database_id!==identity.databaseId||row.generation!==identity.generation)fail()
   for(const key of ['control_watermark','metadata_used_bytes','terminal_reserved_bytes'])if(typeof row[key]!=='number'||!Number.isSafeInteger(row[key])||(row[key] as number)<0)fail()
   return
  }
  db.exec('BEGIN IMMEDIATE')
  try{
   for(const item of objects)if(!definition(db,item))db.exec(item.sql)
   db.prepare('INSERT INTO live_control_meta VALUES(1,1,?,?,0,0,0)').run(identity.databaseId,identity.generation)
   db.exec('COMMIT')
  }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
 }catch{fail()}
}
