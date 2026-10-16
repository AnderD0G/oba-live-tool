import type { AnalysisRecord, AnalysisSession, CaptureLimits, JsonValue } from '../../../../shared/analysisRoom'
import {createHash} from 'node:crypto'
import {analysisInteger} from '../../../../shared/analysisRoom'
import {validateCaptureStorageLimits} from './CaptureStorage'
import {validateCaptureRecord,validateCaptureSession,validateObservationEnvelope} from './CaptureRecordValidation'
import {originalData} from './OriginalEvidence'

// Private legacy projection only: not SQL import, activation or public read authority.
export interface LegacyLocation { sourceId:number; startOffset:number; nextOffset:number; line:number }
export interface LegacyNativeInput { literalBytes:Uint8Array; location:LegacyLocation; session:AnalysisSession; limits:Readonly<CaptureLimits> }
export interface LegacyNativePrivate {
  origin:'legacy-envelope'; location:LegacyLocation; literalEnvelopeBytes:Uint8Array; literalEnvelopeSha256:string
  session:AnalysisSession; limits:Readonly<CaptureLimits>; header:Omit<AnalysisRecord,'data'>; originalSequence:number
  format:'tiktok-decoded-v1'; data:JsonValue; protobufBase64?:string
  upstreamOriginalJson?:never; upstreamOriginalSha256?:never
}
export type LegacyNativeValidation = {status:'validated';origin:'legacy-envelope';privateProjection:LegacyNativePrivate;activationAllowed:false} |
  {status:'rejected';origin:'legacy-envelope';code:string;location?:LegacyLocation;activationAllowed:false}
export interface LegacyRecordProbe { location:LegacyLocation; literalBytes:Uint8Array }
export interface LegacyNativeResolution { status:'paired'|'orphan'|'ambiguous'|'unresolved';origin:'legacy-envelope';code:string;location:LegacyLocation;partner?:LegacyLocation;activationAllowed:false }
export interface LegacyNativeAudit { status:LegacyNativeValidation['status']|LegacyNativeResolution['status'];origin:'legacy-envelope';code?:string;location?:LegacyLocation;activationAllowed:false }
class ProjectionFailure extends Error { constructor(readonly code:string){super(code)} }
function fail(code:string):never {throw new ProjectionFailure(code)}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
function location(value:unknown):LegacyLocation|undefined {
  if(!plain(value)||Reflect.ownKeys(value).length!==4||!['sourceId','startOffset','nextOffset','line'].every(key=>Object.hasOwn(value,key)))return undefined
  for(const key of ['sourceId','startOffset','nextOffset','line'])if(!Number.isSafeInteger(value[key]))return undefined
  if((value.sourceId as number)<1||(value.startOffset as number)<0||(value.nextOffset as number)<=(value.startOffset as number)||(value.line as number)<1)return undefined
  return {sourceId:value.sourceId as number,startOffset:value.startOffset as number,nextOffset:value.nextOffset as number,line:value.line as number}
}
const envelopeKeys=new Set(['scope','observationId','streamId','sequence','receivedAt','platformTime','sourceMessageId','roomId','businessType','formatVersion','failureCode','provenance','complete','removedPaths','truncatedPaths','sessionId','recordSequence','originalSequence','format','data','protobufBase64','mappingVersion'])
/** One source extent only. Parsed objects do not prove physical framing. */
function parsedFrame(bytes:unknown,point:LegacyLocation,limits:Readonly<CaptureLimits>):{literal:Uint8Array;parsed:unknown} {
  if(!(bytes instanceof Uint8Array))fail('FRAME_INVALID')
  const length=bytes.byteLength
  if(length>limits.maxRecordBytes+2)fail('BODY_LIMIT')
  if(point.nextOffset-point.startOffset!==length)fail('EXTENT_MISMATCH')
  if(length===0)fail('FRAME_INVALID')
  // Exact-size standalone storage cannot retain unrelated subview/pool bytes.
  const literal=Buffer.alloc(length);literal.set(bytes)
  if(literal[length-1]!==10)fail('FRAME_INVALID')
  const framing=length>=2&&literal[length-2]===13?2:1,bodyLength=length-framing
  if(bodyLength===0)fail('FRAME_INVALID')
  if(bodyLength>limits.maxRecordBytes)fail('BODY_LIMIT')
  const body=literal.subarray(0,bodyLength)
  for(const byte of body)if(byte===10||byte===13)fail('FRAME_INVALID')
  if(body[0]===0xef&&body[1]===0xbb&&body[2]===0xbf)fail('UTF8_INVALID')
  let text:string
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(body)}catch{fail('UTF8_INVALID')}
  let parsed:unknown
  try{parsed=JSON.parse(text)}catch{fail('JSON_INVALID')}
  return {literal,parsed}
}
export function validateLegacyNativeEnvelope(input:LegacyNativeInput):LegacyNativeValidation {
  let ownedLocation:LegacyLocation|undefined
  try {
    ownedLocation=location(input?.location);if(!ownedLocation)fail('LOCATION_INVALID')
    let limits:Readonly<CaptureLimits>
    try{limits=validateCaptureStorageLimits(input.limits)}catch{fail('LIMITS_INVALID')}
    const {literal,parsed}=parsedFrame(input.literalBytes,ownedLocation,limits)
    if(!plain(parsed))fail('ENVELOPE_INVALID')
    if(Object.keys(parsed).some(key=>!envelopeKeys.has(key)))fail('UNKNOWN_ENVELOPE_FIELD')
    const rawScope=parsed.scope
    if(!plain(rawScope)||Reflect.ownKeys(rawScope).length!==3||!['accountId','platform','source'].every(key=>Object.hasOwn(rawScope,key)))fail('UNKNOWN_ENVELOPE_FIELD')
    let session:AnalysisSession
    try{session=validateCaptureSession(input.session)}catch{fail('SESSION_INVALID')}
    if(parsed.sessionId!==session.id||rawScope.accountId!==session.scope.accountId||rawScope.platform!==session.scope.platform||rawScope.source!==session.scope.source)fail('SCOPE_MISMATCH')
    let header:Omit<AnalysisRecord,'data'>
    try {
      const observed=validateObservationEnvelope(parsed)
      analysisInteger(parsed.recordSequence,1);analysisInteger(parsed.originalSequence,1)
      if(parsed.mappingVersion!==undefined)analysisInteger(parsed.mappingVersion,1)
      header={...observed,scope:{...observed.scope},removedPaths:[...observed.removedPaths],truncatedPaths:[...observed.truncatedPaths],sessionId:session.id,recordSequence:parsed.recordSequence as number,...(parsed.mappingVersion===undefined?{}:{mappingVersion:parsed.mappingVersion as number})}
    }catch{fail('HEADER_INVALID')}
    if(!Object.hasOwn(parsed,'data'))fail('NATIVE_INVALID')
    let data:JsonValue
    try {
      // Reconstructed JSON is used only by the existing privacy validator.
      // It is never retained or labelled as the unavailable upstream body.
      data=originalData({format:parsed.format,provenance:parsed.provenance,complete:parsed.complete,json:JSON.stringify(parsed.data),...(parsed.protobufBase64===undefined?{}:{protobufBase64:parsed.protobufBase64}),removedPaths:parsed.removedPaths} as any,limits.maxRecordBytes,limits.maxDepth)
    }catch(error){fail(error instanceof Error&&error.message==='ORIGINAL_LIMIT'?'NATIVE_LIMIT':'NATIVE_INVALID')}
    const projection:LegacyNativePrivate={origin:'legacy-envelope',location:ownedLocation,literalEnvelopeBytes:literal,literalEnvelopeSha256:createHash('sha256').update(literal).digest('hex'),session,limits,header,originalSequence:parsed.originalSequence as number,format:'tiktok-decoded-v1',data,...(parsed.protobufBase64===undefined?{}:{protobufBase64:parsed.protobufBase64 as string})}
    return {status:'validated',origin:'legacy-envelope',privateProjection:projection,activationAllowed:false}
  }catch(error){return {status:'rejected',origin:'legacy-envelope',code:error instanceof ProjectionFailure?error.code:'ENVELOPE_INVALID',...(ownedLocation?{location:ownedLocation}:{}),activationAllowed:false}}
}
export function resolveLegacyNativeCounterpart(native:LegacyNativePrivate,request:{candidateCount:number;probes:readonly LegacyRecordProbe[]}):LegacyNativeResolution {
  const ownLocation=location(native?.location)
  if(!ownLocation)fail('NATIVE_INVALID')
  const result=(status:LegacyNativeResolution['status'],code:string,partner?:LegacyLocation):LegacyNativeResolution=>({status,origin:'legacy-envelope',code,location:ownLocation,...(partner?{partner:{...partner}}:{}),activationAllowed:false})
  if(!Number.isSafeInteger(request?.candidateCount)||request.candidateCount<0)return result('unresolved','PROBE_COUNT_CONFLICT')
  if(!Array.isArray(request.probes)||request.probes.length>2)return result('unresolved','PROBE_LIMIT')
  if(request.probes.length!==Math.min(request.candidateCount,2))return result('unresolved','PROBE_COUNT_CONFLICT')
  let session:AnalysisSession,limits:Readonly<CaptureLimits>
  try{session=validateCaptureSession(native.session);limits=validateCaptureStorageLimits(native.limits)}catch{return result('unresolved','NATIVE_INVALID')}
  const h=native.header
  if(!h||h.sessionId!==session.id||h.scope?.accountId!==session.scope.accountId||h.scope?.platform!==session.scope.platform||h.scope?.source!==session.scope.source)return result('unresolved','NATIVE_INVALID')
  const candidates:Array<{location:LegacyLocation;header:Omit<AnalysisRecord,'data'>}>=[]
  for(const candidate of request.probes){
    const position=location(candidate?.location)
    if(!position)return result('unresolved','PROBE_INVALID')
    if(candidates.some(previous=>previous.location.sourceId===position.sourceId&&previous.location.startOffset===position.startOffset))return result('unresolved','PROBE_POSITION_CONFLICT')
    if(!(candidate.literalBytes instanceof Uint8Array))return result('unresolved','PROBE_INPUT_UNSUPPORTED')
    let value:unknown
    try{value=parsedFrame(candidate.literalBytes,position,limits).parsed}catch(error){return result('unresolved',error instanceof ProjectionFailure?'PROBE_'+error.code:'PROBE_INVALID')}
    if(!plain(value)||!plain(value.scope))return result('unresolved','PROBE_INVALID')
    if(!value||value.sessionId!==session.id||value.scope?.accountId!==session.scope.accountId||value.scope?.platform!==session.scope.platform||value.scope?.source!==session.scope.source||value.recordSequence!==h.recordSequence)return result('unresolved','PROBE_SCOPE_CONFLICT')
    let record:AnalysisRecord
    try{record=validateCaptureRecord(value,session,limits)}catch{return result('unresolved','PROBE_INVALID')}
    const {data:_privateData,...header}=record
    candidates.push({location:position,header})
  }
  if(request.candidateCount===0)return result('orphan','NO_CANDIDATE')
  // The counted physical key-set is ambiguous even when one header looks closer.
  if(request.candidateCount>=2)return result('ambiguous','CANDIDATE_AMBIGUOUS')
  const candidate=candidates[0],r=candidate.header
  for(const key of ['sessionId','recordSequence','observationId','streamId','sequence','receivedAt','formatVersion'] as const)if(h[key]!==r[key])return result('orphan','HEADER_CONFLICT')
  for(const key of ['platformTime','sourceMessageId','roomId','businessType','failureCode'] as const)if(Object.hasOwn(h,key)!==Object.hasOwn(r,key)||h[key]!==r[key])return result('orphan','HEADER_CONFLICT')
  if(r.provenance!==undefined&&h.provenance!==r.provenance)return result('orphan','HEADER_CONFLICT')
  if(h.mappingVersion!==undefined&&r.mappingVersion!==undefined&&h.mappingVersion!==r.mappingVersion)return result('orphan','HEADER_CONFLICT')
  return result('paired','PAIRED',candidate.location)
}
const safeCodes=new Set(['LOCATION_INVALID','LIMITS_INVALID','FRAME_INVALID','BODY_LIMIT','EXTENT_MISMATCH','UTF8_INVALID','JSON_INVALID','ENVELOPE_INVALID','UNKNOWN_ENVELOPE_FIELD','SESSION_INVALID','SCOPE_MISMATCH','HEADER_INVALID','NATIVE_INVALID','NATIVE_LIMIT','PROBE_COUNT_CONFLICT','PROBE_LIMIT','PROBE_INVALID','PROBE_POSITION_CONFLICT','PROBE_SCOPE_CONFLICT','PROBE_INPUT_UNSUPPORTED','PROBE_BODY_LIMIT','PROBE_EXTENT_MISMATCH','PROBE_FRAME_INVALID','PROBE_UTF8_INVALID','PROBE_JSON_INVALID','NO_CANDIDATE','CANDIDATE_AMBIGUOUS','HEADER_CONFLICT','PAIRED','SUMMARY_INVALID'])
export function legacyNativeAuditSummary(value:LegacyNativeValidation|LegacyNativeResolution):LegacyNativeAudit {
  const invalid=():LegacyNativeAudit=>({status:'rejected',origin:'legacy-envelope',code:'SUMMARY_INVALID',activationAllowed:false})
  try {
    if(!value||!['validated','rejected','paired','orphan','ambiguous','unresolved'].includes(value.status))return invalid()
    const position=location(value.status==='validated'?value.privateProjection.location:value.location)
    if(value.status==='validated')return position?{status:'validated',origin:'legacy-envelope',location:position,activationAllowed:false}:invalid()
    if(!safeCodes.has(value.code))return invalid()
    return {status:value.status,origin:'legacy-envelope',code:value.code,...(position?{location:position}:{}),activationAllowed:false}
  }catch{return invalid()}
}
