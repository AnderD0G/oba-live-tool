import type {AnalysisScope} from '../../../../shared/analysisRoom'
import {analysisId,analysisInteger,validateAnalysisScope} from '../../../../shared/analysisRoom'
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
import {types} from 'node:util'
import type {CaptureDatabaseIdentity,CaptureSeek,SessionSeek} from './CaptureStorage'
import {preflightCaptureValue,validateCaptureIdentity} from './CaptureWorkerProtocol'
export class CaptureCursorError extends Error {readonly code='INVALID_CAPTURE_CURSOR';constructor(){super('INVALID_CAPTURE_CURSOR')}}
export type CaptureSqlCursor=
 | {cursorVersion:2;identity:CaptureDatabaseIdentity;kind:'sessions';scope:AnalysisScope;upperOrder:number;beforeOrder?:number}
 | {cursorVersion:2;identity:CaptureDatabaseIdentity;kind:'records';scope:AnalysisScope;sessionId:string;upperPosition:number;afterPosition?:number}
function invalid():never{throw new CaptureCursorError()}
function own(input:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))invalid()
 const keys=Reflect.ownKeys(input),allowed=[...required,...optional]
 if(keys.some(key=>typeof key!=='string'||!allowed.includes(key))||required.some(key=>!Object.hasOwn(input,key)))invalid()
 const detached:Record<string,unknown>={}
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key)!;if(!d.enumerable||!('value'in d))invalid();detached[String(key)]=d.value}
 return detached
}
function checkedScope(input:unknown):AnalysisScope{const value=own(input,['accountId','platform','source']);preflightCaptureValue(value,4096);return validateAnalysisScope(value)}
function sameScope(a:AnalysisScope,b:AnalysisScope):boolean{return a.accountId===b.accountId&&a.platform===b.platform&&a.source===b.source}
export class CaptureCursorCodec {
 private readonly identity:CaptureDatabaseIdentity
 private readonly key:Buffer
 constructor(input:CaptureDatabaseIdentity,inputKey:Uint8Array=randomBytes(32)){
  try{this.identity=Object.freeze(validateCaptureIdentity(own(input,['databaseId','generation','schemaVersion']) as unknown as CaptureDatabaseIdentity))
   if(types.isProxy(inputKey)||!(inputKey instanceof Uint8Array)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(inputKey))||['byteLength','buffer','byteOffset','length'].some(key=>Object.hasOwn(inputKey,key))||inputKey.byteLength!==32)invalid()
   this.key=Buffer.alloc(32);this.key.set(inputKey)
  }catch{invalid()}
 }
 private guard<T>(work:()=>T):T{try{return work()}catch{invalid()}}
 private validate(input:unknown):CaptureSqlCursor{
  const head=own(input,['cursorVersion','identity','kind','scope'],['sessionId','upperPosition','afterPosition','upperOrder','beforeOrder'])
  if(head.cursorVersion!==2)invalid()
  const identity=validateCaptureIdentity(own(head.identity,['databaseId','generation','schemaVersion']) as unknown as CaptureDatabaseIdentity)
  if(identity.databaseId!==this.identity.databaseId||identity.generation!==this.identity.generation||identity.schemaVersion!==this.identity.schemaVersion)invalid()
  const scope=checkedScope(head.scope)
  if(head.kind==='sessions'){
   const row=own(input,['cursorVersion','identity','kind','scope','upperOrder'],['beforeOrder']),upperOrder=analysisInteger(row.upperOrder)
   const beforeOrder=row.beforeOrder===undefined?undefined:analysisInteger(row.beforeOrder,1,upperOrder)
   return{cursorVersion:2,identity,kind:'sessions',scope,upperOrder,...(beforeOrder===undefined?{}:{beforeOrder})}
  }
  if(head.kind==='records'){
   const row=own(input,['cursorVersion','identity','kind','scope','sessionId','upperPosition'],['afterPosition']),sessionId=analysisId(row.sessionId),upperPosition=analysisInteger(row.upperPosition)
   const afterPosition=row.afterPosition===undefined?undefined:analysisInteger(row.afterPosition,0,upperPosition)
   return{cursorVersion:2,identity,kind:'records',scope,sessionId,upperPosition,...(afterPosition===undefined?{}:{afterPosition})}
  }
  invalid()
 }
 private encode(input:CaptureSqlCursor):string{
  const cursor=this.validate(input),payload=Buffer.from(JSON.stringify(cursor)).toString('base64url'),signature=createHmac('sha256',this.key).update(payload).digest('base64url')
  const text=payload+'.'+signature;if(text.length>2048)invalid();return text
 }
 encodeSessions(input:AnalysisScope,seekInput:SessionSeek):string{return this.guard(()=>{const scope=checkedScope(input),seek=own(seekInput,['upperOrder'],['beforeOrder']);return this.encode({cursorVersion:2,identity:this.identity,kind:'sessions',scope,upperOrder:seek.upperOrder as number,...(seek.beforeOrder===undefined?{}:{beforeOrder:seek.beforeOrder as number})})})}
 encodeRecords(input:AnalysisScope,id:string,seekInput:CaptureSeek):string{return this.guard(()=>{const scope=checkedScope(input),sessionId=analysisId(id),seek=own(seekInput,['upperPosition'],['afterPosition']);return this.encode({cursorVersion:2,identity:this.identity,kind:'records',scope,sessionId,upperPosition:seek.upperPosition as number,...(seek.afterPosition===undefined?{}:{afterPosition:seek.afterPosition as number})})})}
 decode(text:string,kind:CaptureSqlCursor['kind'],input:AnalysisScope,id?:string):CaptureSqlCursor{return this.guard(()=>{
  const scope=checkedScope(input)
  if(!['sessions','records'].includes(kind)||kind==='records'&&id===undefined||kind==='sessions'&&id!==undefined)invalid()
  const sessionId=id===undefined?undefined:analysisId(id)
  if(typeof text!=='string'||text.length<1||text.length>2048)invalid()
  const parts=text.split('.');if(parts.length!==2||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part)))invalid()
  const[payload,signature]=parts,expected=createHmac('sha256',this.key).update(payload).digest(),supplied=Buffer.from(signature,'base64url')
  if(supplied.length!==32||supplied.toString('base64url')!==signature||!timingSafeEqual(supplied,expected))invalid()
  const bytes=Buffer.from(payload,'base64url');if(bytes.toString('base64url')!==payload)invalid()
  const value=this.validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))
  if(value.kind!==kind||!sameScope(value.scope,scope)||value.kind==='records'&&value.sessionId!==sessionId)invalid()
  return value
 })}
}
