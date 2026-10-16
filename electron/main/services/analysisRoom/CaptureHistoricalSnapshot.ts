import {analysisInteger,analysisString,assertBoundedJson,type ReanalysisJob} from '../../../../shared/analysisRoom'
import type {AttributeSnapshot,PublishedAttributeDictionary} from '../../../../shared/audienceAttributes'
import {interpretValue} from './AttributeMapper'
import {CAPTURE_STORAGE_LIMITS} from './CaptureStorage'

export class CaptureHistoricalSnapshotError extends Error {
 readonly code='HISTORY_LITERAL_INVALID'
 constructor(){super('HISTORY_LITERAL_INVALID')}
}
const sameScope=(a:AttributeSnapshot['scope'],b:AttributeSnapshot['scope'])=>a.accountId===b.accountId&&a.platform===b.platform&&a.source===b.source

function literal(text:unknown,maxLiteralBytes:number):unknown {
 if(typeof maxLiteralBytes!=='number'||!Number.isSafeInteger(maxLiteralBytes)||maxLiteralBytes<1||maxLiteralBytes>CAPTURE_STORAGE_LIMITS.maxRecordBytes||typeof text!=='string'||Buffer.byteLength(text)>maxLiteralBytes)throw Error('literal')
 return JSON.parse(text)
}

/** Private literal parser only. Job/dictionary must come from trusted owned readers.
 * No source, schema, request or publication authority is established here. */
export function parseHistoricalSnapshot(text:unknown,job:ReanalysisJob,dictionary:PublishedAttributeDictionary,maxLiteralBytes:number=CAPTURE_STORAGE_LIMITS.maxRecordBytes):AttributeSnapshot {
 try {return project(literal(text,maxLiteralBytes) as AttributeSnapshot,job,dictionary)}catch{throw new CaptureHistoricalSnapshotError()}
}
/** Full result line parser. No JSON.stringify roundtrip can alter parsed scalar facts. */
export function parseHistoricalResultEnvelope(text:unknown,job:ReanalysisJob,dictionary:PublishedAttributeDictionary,maxLiteralBytes:number=CAPTURE_STORAGE_LIMITS.maxRecordBytes):{resultSequence:number;snapshot:AttributeSnapshot} {
 try {
  const value=literal(text,maxLiteralBytes) as {resultSequence:unknown;snapshot:AttributeSnapshot}
  return {resultSequence:analysisInteger(value.resultSequence,1),snapshot:project(value.snapshot,job,dictionary)}
 }catch{throw new CaptureHistoricalSnapshotError()}
}
function project(value:AttributeSnapshot,job:ReanalysisJob,dictionary:PublishedAttributeDictionary):AttributeSnapshot {
  assertBoundedJson(value)
  if(dictionary.platform!==job.scope.platform||dictionary.source!==job.scope.source||dictionary.version!==job.mappingVersion)throw Error('mapping')
  if(value.origin!=='history'||!sameScope(value.scope,job.scope)||value.mappingVersion!==job.mappingVersion)throw Error('scope')
  analysisString(value.observationId,256);analysisString(value.streamId,256)
  analysisInteger(value.sequence);analysisInteger(value.observedAt)
  if(value.userId!==undefined)analysisString(value.userId,256)
  if(value.nickname!==undefined)analysisString(value.nickname,128)
  if(value.platformTime!==undefined)analysisInteger(value.platformTime)
  const values:AttributeSnapshot['values']={}
  for(const definition of dictionary.definitions) {
   const fact=value.values[definition.id]
   if(!fact||!sameScope(fact.scope,job.scope)||fact.mappingVersion!==job.mappingVersion||fact.type!==definition.type||!['known','unknown','conflict'].includes(fact.status))throw Error('fact')
   analysisString(fact.observationId,256);analysisString(fact.streamId,256)
   analysisInteger(fact.sequence);analysisInteger(fact.observedAt);analysisInteger(fact.expiresAt)
   if(!['platform','local-sequence'].includes(fact.timeBasis))throw Error('time basis')
   if(fact.platformTime!==undefined)analysisInteger(fact.platformTime)
   if(fact.path!==undefined)analysisString(fact.path,2048)
   const provenance={scope:job.scope,observationId:fact.observationId,streamId:fact.streamId,sequence:fact.sequence,observedAt:fact.observedAt,mappingVersion:job.mappingVersion,type:fact.type,timeBasis:fact.timeBasis,expiresAt:fact.expiresAt,...(fact.platformTime===undefined?{}:{platformTime:fact.platformTime}),...(fact.path===undefined?{}:{path:fact.path})}
   if(fact.status==='known') {
    if(interpretValue(definition.type,fact.value,undefined,definition.enumValues).status!=='known')throw Error('value')
    values[definition.id]={...provenance,status:'known',value:fact.value}
   } else {
    analysisString(fact.reason,128)
    values[definition.id]={...provenance,status:fact.status,reason:fact.reason}
   }
  }
  return structuredClone({origin:'history' as const,scope:job.scope,mappingVersion:job.mappingVersion,observationId:value.observationId,streamId:value.streamId,sequence:value.sequence,observedAt:value.observedAt,...(value.userId===undefined?{}:{userId:value.userId}),...(value.nickname===undefined?{}:{nickname:value.nickname}),...(value.platformTime===undefined?{}:{platformTime:value.platformTime}),values})
}
