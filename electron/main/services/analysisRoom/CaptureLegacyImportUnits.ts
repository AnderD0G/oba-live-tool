import {createHash} from 'node:crypto'
import {analysisId,validateMappingScope,validateAnalysisScope,type AnalysisScope,type AnalysisSession,type CaptureLimits} from '../../../../shared/analysisRoom'
import {CAPTURE_STORAGE_LIMITS,validateCaptureStorageLimits} from './CaptureStorage'
import {validateCaptureSession} from './CaptureRecordValidation'

export interface LegacyUnitSource {sourceId:number;relativePath:string;size:number;sha256:string}
export type LegacySourceRole='canonical-session'|'canonical-records'|'canonical-native'|'retained-alternate'|'deferred-request'|'deferred-dictionary'|'deferred-history'|'deferred-config'|'unresolved-path'
export interface LegacySourceSpan {sourceId:number;sourceSha256:string;startOffset:number;nextOffset:number}
export interface LegacySourceClassification {
 origin:'legacy-import-unit';role:LegacySourceRole;status:'classified'|'accepted'|'rejected'|'retained'|'deferred'|'unresolved';code?:string;
 span?:LegacySourceSpan;hashStatus:'source-span-only'|'literal';literalSha256?:string;privateSource?:LegacyUnitSource;
 privateProjection?:{session:AnalysisSession;createdSequence?:number};activationAllowed:false;
}
export type LegacyMetadataClassification=LegacySourceClassification
export interface MetadataUnitInput {source:LegacyUnitSource;limits:Readonly<CaptureLimits>;literalBytes?:Uint8Array;expectedScope?:AnalysisScope}
export type SafeLegacyUnitAudit=Pick<LegacySourceClassification,'origin'|'role'|'status'|'activationAllowed'|'code'>&{location?:{sourceId:number;startOffset:number;nextOffset:number}}
const origin='legacy-import-unit' as const
function ownData(input:unknown,required:readonly string[]):Record<string,unknown>|undefined {
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return
 const keys=Reflect.ownKeys(input)
 if(keys.length!==required.length||keys.some(key=>typeof key!=='string'||!required.includes(key)))return
 const result:Record<string,unknown>={}
 for(const key of required){const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!d.enumerable||!('value'in d))return;result[key]=d.value}
 return result
}
function sourceValue(input:unknown):LegacyUnitSource|undefined {
 const x=ownData(input,['sourceId','relativePath','size','sha256']);if(!x)return
 if(typeof x.sourceId!=='number'||!Number.isSafeInteger(x.sourceId)||x.sourceId<1||typeof x.size!=='number'||!Number.isSafeInteger(x.size)||x.size<0||x.size>CAPTURE_STORAGE_LIMITS.maxStorageBytes)return
 if(typeof x.sha256!=='string'||!/^[a-f0-9]{64}$/.test(x.sha256)||typeof x.relativePath!=='string'||!x.relativePath||Buffer.byteLength(x.relativePath)>4096||/[\\:\x00-\x1f\x7f]/.test(x.relativePath)||x.relativePath.split('/').some(part=>!part||part==='.'||part==='..'))return
 return {sourceId:x.sourceId,relativePath:x.relativePath,size:x.size,sha256:x.sha256}
}
function validId(input:string):boolean{try{analysisId(input);return true}catch{return false}}
function directRole(path:string):LegacySourceRole {
 const session=path.match(/^sessions\/([^/]+)\/(metadata\.json|originals\.jsonl|\d{6}\.jsonl)$/)
 if(session&&validId(session[1]))return session[2]==='metadata.json'?'canonical-session':session[2]==='originals.jsonl'?'canonical-native':'canonical-records'
 if(/^requests\/[a-f0-9]{64}\.json$/.test(path))return 'deferred-request'
 const dictionary=path.match(/^dictionaries\/([^/]+)-(control|compass)\.json$/)
 if(dictionary){try{validateMappingScope({platform:dictionary[1],source:dictionary[2]});return 'deferred-dictionary'}catch{}}
 const history=path.match(/^history\/([^/]+)\/(metadata\.json|\d{6}\.jsonl)$/)
 if(history&&validId(history[1]))return 'deferred-history'
 if(path==='config.json'||path==='configuration.json')return 'deferred-config'
 return 'unresolved-path'
}
export function classifyLegacySource(source:LegacyUnitSource):LegacySourceClassification {
 let value:LegacyUnitSource|undefined
 try{value=sourceValue(source)}catch{}
 if(!value)return {origin,role:'unresolved-path',status:'rejected',code:'INVALID_SOURCE',hashStatus:'source-span-only',activationAllowed:false}
 let role=directRole(value.relativePath)
 if(role==='unresolved-path'){
  const pending=value.relativePath.match(/^(.*)\.pending-([^/]+)$/),backup=value.relativePath.match(/^(.*)\.(?:bak|backup)$/)
  const base=pending&&validId(pending[2])?pending[1]:backup?.[1]
  if(base&&directRole(base)!=='unresolved-path')role='retained-alternate'
 }
 const status=role==='retained-alternate'?'retained':role.startsWith('deferred-')?'deferred':role==='unresolved-path'?'unresolved':'classified'
 const code=status==='retained'?'RETAINED_ALTERNATE':status==='deferred'?'DEFERRED_CONSUMER':status==='unresolved'?'UNKNOWN_SOURCE_PATH':undefined
 return {origin,role,status,...(code?{code}:{}),privateSource:value,span:{sourceId:value.sourceId,sourceSha256:value.sha256,startOffset:0,nextOffset:value.size},hashStatus:'source-span-only',activationAllowed:false}
}
function dataValue(input:unknown,key:string):{value:unknown}|undefined {
 if(!input||typeof input!=='object')return
 const d=Object.getOwnPropertyDescriptor(input,key)
 return d&&'value'in d?{value:d.value}:undefined
}
function graphWithin(value:unknown,depthCap:number):boolean {
 let nodes=0
 function visit(x:unknown,depth:number):boolean{
  if(++nodes>8192||depth>depthCap)return false
  if(x&&typeof x==='object'){
   if(Array.isArray(x)){for(const child of x)if(!visit(child,depth+1))return false}
   else for(const key in x)if(!visit((x as Record<string,unknown>)[key],depth+1))return false
  }
  return true
 }
 return visit(value,1)
}
export function classifyLegacyMetadataUnit(input:MetadataUnitInput):LegacyMetadataClassification {
 let base:LegacySourceClassification
 try{base=classifyLegacySource(dataValue(input,'source')?.value as LegacyUnitSource)}catch{base=classifyLegacySource(undefined as unknown as LegacyUnitSource)}
 if(!base.privateSource)return base
 const issue=(code:string,status:'rejected'|'deferred'|'unresolved'='rejected',physical=base):LegacyMetadataClassification=>({...physical,status,code})
 let limits:Readonly<CaptureLimits>
 try{limits=validateCaptureStorageLimits(dataValue(input,'limits')?.value)}catch{return issue('INVALID_LIMITS')}
 if(base.role!=='canonical-session')return base.status==='classified'?issue('METADATA_NOT_CANONICAL','unresolved'):base
 const source=base.privateSource
 if(source.size===0)return issue('METADATA_EMPTY')
 if(source.size>limits.maxMetadataBytes)return issue('METADATA_LIMIT')
 if(source.size>Math.min(131072,limits.maxRecordBytes))return issue('METADATA_DECODE_DEFERRED','deferred')
 let bytes:Buffer
 try{
  const raw=dataValue(input,'literalBytes')?.value
  if(raw===undefined)return issue('METADATA_BYTES_UNAVAILABLE')
  if(!(raw instanceof Uint8Array)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(raw))||['byteLength','buffer','byteOffset','length'].some(key=>Object.hasOwn(raw,key)))return issue('METADATA_BYTES_INVALID')
  if(raw.byteLength!==source.size)return issue('EXTENT_MISMATCH')
  bytes=Buffer.alloc(raw.byteLength);bytes.set(raw)
 }catch{return issue('METADATA_BYTES_INVALID')}
 const literalSha256=createHash('sha256').update(bytes).digest('hex')
 if(literalSha256!==source.sha256)return issue('SOURCE_SHA_MISMATCH')
 const physical:LegacySourceClassification={...base,hashStatus:'literal',literalSha256}
 let text:string
 try{
  if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)return issue('UTF8_INVALID','rejected',physical)
  text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
 }catch{return issue('UTF8_INVALID','rejected',physical)}
 let parsed:unknown
 try{parsed=JSON.parse(text)}catch{return issue('JSON_INVALID','rejected',physical)}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return issue('METADATA_INVALID','rejected',physical)
 if(!graphWithin(parsed,Math.min(16,limits.maxDepth)))return issue('RESOURCE_WORK_LIMIT','deferred',physical)
 let session:AnalysisSession,createdSequence:number|undefined
 try{
  session=validateCaptureSession(parsed)
  const created=(parsed as {createdSequence?:unknown}).createdSequence
  if(created!==undefined){if(typeof created!=='number'||!Number.isSafeInteger(created)||created<1)return issue('METADATA_INVALID','rejected',physical);createdSequence=created}
 }catch{return issue('METADATA_INVALID','rejected',physical)}
 if(session.id!==source.relativePath.split('/')[1])return issue('SESSION_PATH_MISMATCH','rejected',physical)
 let expected:AnalysisScope|undefined
 try{
  const d=Object.getOwnPropertyDescriptor(input,'expectedScope')
  if(d){if(!('value'in d))return issue('SCOPE_INVALID','rejected',physical);if(d.value!==undefined){const scope=ownData(d.value,['accountId','platform','source']);if(!scope)return issue('SCOPE_INVALID','rejected',physical);expected=validateAnalysisScope(scope)}}
 }catch{return issue('SCOPE_INVALID','rejected',physical)}
 if(expected&&(session.scope.accountId!==expected.accountId||session.scope.platform!==expected.platform||session.scope.source!==expected.source))return issue('SCOPE_MISMATCH','rejected',physical)
 return {...physical,status:'accepted',privateProjection:{session,...(createdSequence===undefined?{}:{createdSequence})}}
}
const roles=new Set<string>(['canonical-session','canonical-records','canonical-native','retained-alternate','deferred-request','deferred-dictionary','deferred-history','deferred-config','unresolved-path'])
const statuses=new Set<string>(['classified','accepted','rejected','retained','deferred','unresolved'])
const codes=new Set<string>(['INVALID_SOURCE','RETAINED_ALTERNATE','DEFERRED_CONSUMER','UNKNOWN_SOURCE_PATH','INVALID_LIMITS','METADATA_NOT_CANONICAL','METADATA_EMPTY','METADATA_LIMIT','METADATA_DECODE_DEFERRED','METADATA_BYTES_UNAVAILABLE','METADATA_BYTES_INVALID','EXTENT_MISMATCH','SOURCE_SHA_MISMATCH','UTF8_INVALID','JSON_INVALID','METADATA_INVALID','RESOURCE_WORK_LIMIT','SESSION_PATH_MISMATCH','SCOPE_INVALID','SCOPE_MISMATCH'])
export function legacyImportUnitAudit(result:LegacySourceClassification):SafeLegacyUnitAudit {
 const safe:SafeLegacyUnitAudit={origin,role:'unresolved-path',status:'unresolved',activationAllowed:false}
 try{
  const role=dataValue(result,'role')?.value,status=dataValue(result,'status')?.value,code=dataValue(result,'code')?.value
  if(typeof role==='string'&&roles.has(role))safe.role=role as LegacySourceRole
  if(typeof status==='string'&&statuses.has(status))safe.status=status as LegacySourceClassification['status']
  if(typeof code==='string'&&codes.has(code))safe.code=code
  const span=dataValue(result,'span')?.value,id=dataValue(span,'sourceId')?.value,start=dataValue(span,'startOffset')?.value,end=dataValue(span,'nextOffset')?.value
  if(typeof id==='number'&&Number.isSafeInteger(id)&&id>0&&typeof start==='number'&&Number.isSafeInteger(start)&&start>=0&&typeof end==='number'&&Number.isSafeInteger(end)&&end>=start)safe.location={sourceId:id,startOffset:start,nextOffset:end}
 }catch{/* No caller error, accessor or private value becomes public audit text. */}
 return safe
}
