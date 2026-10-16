import type { DatabaseSync } from 'node:sqlite'
import {types} from 'node:util'
import type { AnalysisScope, AnalysisSession } from '../../../../shared/analysisRoom'
import {analysisId,analysisString,validateAnalysisScope} from '../../../../shared/analysisRoom'
import type { CaptureDatabaseIdentity } from './CaptureStorage'
import {captureSession} from './CaptureDatabaseWorker'
import {preflightCaptureValue,validateCaptureIdentity} from './CaptureWorkerProtocol'

export const CAPTURE_ACTIVE_SCOPE_INDEX_SQL="CREATE INDEX capture_active_scope ON sessions(account_id,platform,source,ordinal) WHERE status IN('collecting','stopping')"
export const CAPTURE_ACTIVE_ACCOUNT_INDEX_SQL="CREATE INDEX capture_active_account ON sessions(account_id,ordinal) WHERE status IN('collecting','stopping')"
export class CaptureSessionViewError extends Error {constructor(readonly code:string){super(code)}}
function fail(code:string):never{throw new CaptureSessionViewError(code)}
function ownData(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('INVALID_METADATA_REQUEST')
 const actual=Reflect.ownKeys(value)
 if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)))fail('INVALID_METADATA_REQUEST')
 const result:Record<string,unknown>={}
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor?.enumerable||!('value'in descriptor))fail('INVALID_METADATA_REQUEST');result[key]=descriptor.value}
 return result
}
function checkedScope(input:AnalysisScope):AnalysisScope{
 try{const detached=ownData(input,['accountId','platform','source']);preflightCaptureValue(detached,4096);return validateAnalysisScope(detached)}catch{fail('INVALID_METADATA_REQUEST')}
}
function checkedId(input:string):string{try{return analysisId(input)}catch{fail('INVALID_METADATA_REQUEST')}}
function checkedAccount(input:string):string{try{return analysisString(input)}catch{fail('INVALID_METADATA_REQUEST')}}
const textCaps={id:36,account_id:1024,platform:128,source:32,status:32,room_id:1024,reason:512,original_error:512,last_shard:48}
const scalarColumns=Object.keys(textCaps).map(key=>'length(CAST('+key+' AS BLOB)) AS '+key+'_bytes').join(',')
const normalize=(sql:string)=>sql.replace(/\s+/g,' ').trim()
/** Caller supplies an authority-checked readonly connection; no file/schema/lifecycle ownership. */
export class CaptureSessionMetadataView {
 private readonly identity:CaptureDatabaseIdentity
 constructor(private readonly db:DatabaseSync,input:CaptureDatabaseIdentity){
  try{this.identity=Object.freeze(validateCaptureIdentity(ownData(input,['databaseId','generation','schemaVersion']) as unknown as CaptureDatabaseIdentity))}catch{fail('INVALID_METADATA_REQUEST')}
 }
 private read<T>(work:()=>T):T{try{this.checkIdentity();return work()}catch(error){if(error instanceof CaptureSessionViewError)throw error;fail('METADATA_UNAVAILABLE')}}
 private checkIdentity():void{
  const keys=['database_id','generation','schema_version']
  const scalar=this.db.prepare("SELECT key,length(CAST(value AS BLOB)) AS bytes FROM database_meta WHERE key IN('database_id','generation','schema_version') LIMIT 4").all()
  if(scalar.length!==3||scalar.some(row=>typeof row.key!=='string'||!keys.includes(row.key)||typeof row.bytes!=='number'||row.bytes<1||row.bytes>64))fail('METADATA_IDENTITY_MISMATCH')
  const rows=this.db.prepare("SELECT key,substr(value,1,65) AS value FROM database_meta WHERE key IN('database_id','generation','schema_version') LIMIT 4").all()
  const wanted:Record<string,string>={database_id:this.identity.databaseId,generation:String(this.identity.generation),schema_version:'1'}
  if(rows.length!==3||rows.some(row=>wanted[String(row.key)]!==row.value))fail('METADATA_IDENTITY_MISMATCH')
 }
 private point(scope:AnalysisScope,id:string):AnalysisSession|undefined{
  const row=this.db.prepare('SELECT complete,has_originals,'+scalarColumns+' FROM sessions WHERE id=? AND account_id=? AND platform=? AND source=? LIMIT 1').get(id,scope.accountId,scope.platform,scope.source)
  if(!row)return undefined
  if(![0,1].includes(row.complete as number)||![0,1].includes(row.has_originals as number))fail('METADATA_INVALID')
  for(const[key,cap]of Object.entries(textCaps)){const size=row[key+'_bytes'];if(size!==null&&(typeof size!=='number'||size<0||size>cap))fail('METADATA_INVALID')}
  try{return captureSession(this.db,scope,id)}catch{fail('METADATA_INVALID')}
 }
 private requireIndex(name:string,ddl:string):void{
  const scalar=this.db.prepare('SELECT type,tbl_name,length(CAST(sql AS BLOB)) AS bytes FROM sqlite_master WHERE name=? LIMIT 1').get(name)
  if(!scalar||scalar.type!=='index'||scalar.tbl_name!=='sessions'||typeof scalar.bytes!=='number'||scalar.bytes<1||scalar.bytes>2048)fail('ACTIVE_INDEX_UNAVAILABLE')
  const definition=this.db.prepare('SELECT substr(sql,1,2049) AS sql FROM sqlite_master WHERE name=? LIMIT 1').get(name)?.sql
  if(typeof definition!=='string'||normalize(definition)!==normalize(ddl))fail('ACTIVE_INDEX_UNAVAILABLE')
 }
 session(input:AnalysisScope,id:string):AnalysisSession|undefined{const scope=checkedScope(input),sessionId=checkedId(id);return this.read(()=>this.point(scope,sessionId))}
 owned(input:AnalysisScope,id:string):AnalysisSession{const result=this.session(input,id);if(!result)fail('SESSION_NOT_FOUND');return result}
 order(input:AnalysisScope,id:string):number|undefined{
  const scope=checkedScope(input),sessionId=checkedId(id)
  return this.read(()=>{const value=this.db.prepare('SELECT ordinal FROM sessions WHERE id=? AND account_id=? AND platform=? AND source=? LIMIT 1').get(sessionId,scope.accountId,scope.platform,scope.source)?.ordinal
   if(value===undefined)return undefined;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)fail('METADATA_INVALID');return value})
 }
 active(input:AnalysisScope):AnalysisSession|undefined{
  const scope=checkedScope(input)
  return this.read(()=>{this.requireIndex('capture_active_scope',CAPTURE_ACTIVE_SCOPE_INDEX_SQL)
   const rows=this.db.prepare("SELECT substr(id,1,37) AS id FROM sessions INDEXED BY capture_active_scope WHERE account_id=? AND platform=? AND source=? AND status IN('collecting','stopping') ORDER BY ordinal DESC LIMIT 2").all(scope.accountId,scope.platform,scope.source)
   if(rows.length>1)fail('ACTIVE_SESSION_CONFLICT');if(!rows.length)return undefined
   let id:string;try{id=analysisId(rows[0].id)}catch{fail('METADATA_INVALID')};return this.point(scope,id)})
 }
 activeForAccount(input:string):AnalysisSession|undefined{
  const account=checkedAccount(input)
  return this.read(()=>{this.requireIndex('capture_active_account',CAPTURE_ACTIVE_ACCOUNT_INDEX_SQL)
   const rows=this.db.prepare("SELECT substr(id,1,37) AS id,substr(platform,1,33) AS platform,substr(source,1,33) AS source FROM sessions INDEXED BY capture_active_account WHERE account_id=? AND status IN('collecting','stopping') ORDER BY ordinal DESC LIMIT 2").all(account)
   if(rows.length>1)fail('ACTIVE_SESSION_CONFLICT');if(!rows.length)return undefined
   let scope:AnalysisScope,id:string;try{scope=validateAnalysisScope({accountId:account,platform:rows[0].platform,source:rows[0].source});id=analysisId(rows[0].id)}catch{fail('METADATA_INVALID')};return this.point(scope,id)})
 }
}
