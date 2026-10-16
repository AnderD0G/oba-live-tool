import type {DatabaseSync} from 'node:sqlite'
import {readTypedStageAdmission,readTypedStageProjectionAdmission,readProjectionBaseRunSnapshot,projectionHeaderForAuthenticatedPrefix} from './CaptureTypedStageSchema'
import {sessionImportReceipt,sessionImportReceiptInProjection} from './CaptureTypedStageImport'
import {PROJECTION_STAGE_DDL,projectionExact,normalizeProjectionBinding,projectionDigest,projectionStable,projectionFailure,TypedProjectionSchemaError,type ProjectionBinding} from './CaptureTypedProjectionDefinition'
/** Private schema/readonly prefix seams only. No projection writer or activation authority. */
function durable(db:DatabaseSync){if(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA synchronous').get()?.synchronous!==2||db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')projectionFailure('PROJECTION_DURABILITY_INVALID')}
function prepared(db:DatabaseSync,input:ProjectionBinding){
 projectionExact(input,['base','basePrefixOperationId','policy']);const a=readTypedStageAdmission(db,input.base,1048576),b=normalizeProjectionBinding(input,a.binding),r=sessionImportReceipt(db,b.base,b.basePrefixOperationId),run=readProjectionBaseRunSnapshot(db,b.base.runId)
 if(!r||r.cursor.phase!=='metadata-complete'||r.resultRevision!==run.revision||r.cursor.afterSourceId!==run.after_source_id)projectionFailure('PROJECTION_PREFIX_INVALID')
 const h=projectionHeaderForAuthenticatedPrefix(b,a,run,projectionDigest({...r,reused:false})),charge=Buffer.byteLength(projectionStable(h))
 if(charge>Math.min(16384,b.base.limits.maxMetadataBytes,b.base.limits.maxRecordBytes,b.base.limits.maxPendingBytes)||a.sourceBytes+a.bootstrapEncodedBytes+Number(run.encoded_bytes)+charge>b.base.limits.maxStorageBytes)projectionFailure('PROJECTION_ADMISSION_LIMIT')
 for(const table of ['capture_rows','original_rows','operation_receipts','field_entries','legacy_capture_links','legacy_native_units','legacy_native_links','legacy_pair_groups'])if(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())projectionFailure('PROJECTION_TARGET_NOT_EMPTY')
 if(db.prepare("SELECT value FROM database_meta WHERE key='commit_watermark'").get()?.value!=='0')projectionFailure('PROJECTION_TARGET_NOT_EMPTY')
 return {a,b,h}
}
export function createTypedProjectionSchema(db:DatabaseSync,input:ProjectionBinding):void{
 const before=prepared(db,input);durable(db);db.exec('BEGIN IMMEDIATE')
 try{
  const now=prepared(db,input);if(projectionStable(before.h)!==projectionStable(now.h))projectionFailure('PROJECTION_PREFIX_CHANGED')
  db.exec(PROJECTION_STAGE_DDL);const put=db.prepare('INSERT INTO legacy_projection_meta(key,value) VALUES(?,?)');for(const [k,v]of Object.entries(now.h))put.run(k,v)
  readTypedStageProjectionAdmission(db,now.b,1048576);if(!sessionImportReceiptInProjection(db,now.b,now.b.basePrefixOperationId))projectionFailure('PROJECTION_PREFIX_INVALID')
  db.exec('COMMIT')
 }catch(e){try{db.exec('ROLLBACK')}catch{}if(e instanceof TypedProjectionSchemaError)throw e;projectionFailure('PROJECTION_SCHEMA_CREATE_FAILED')}
}
export function resumeTypedProjectionSchema(db:DatabaseSync,input:ProjectionBinding):void{
 durable(db);const a=readTypedStageProjectionAdmission(db,input,1048576);if(!sessionImportReceiptInProjection(db,a.binding,a.binding.basePrefixOperationId))projectionFailure('PROJECTION_PREFIX_INVALID')
}
