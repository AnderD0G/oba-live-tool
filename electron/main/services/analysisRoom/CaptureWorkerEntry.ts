import {normalizeBridgeStartup,bridgeContext,type BridgeStartup} from './CaptureWorkerStartup'
import {decodeCaptureRequestV2,encodeCaptureReplyV2,projectCaptureReplyExpectationV2,isCaptureWriteV2,captureSafeCodeV2,type CaptureWorkerRequestV2} from './CaptureWorkerProtocolV2'
import {readTypedStageAdmission} from './CaptureTypedStageSchema'
import {beginSessionImport,stepSessionImport,sessionImportReceipt} from './CaptureTypedStageImport'
import {initializeCaptureLiveControlSchema} from './CaptureLiveControlSchema'
import {executeLiveControl,liveControlReceipt,liveControlState,liveRequest} from './CaptureLiveControl'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { serialize } from 'node:v8'
import { analysisInteger } from '../../../../shared/analysisRoom'
import { initializeCaptureSchema } from './CaptureDatabaseSchema'
import { captureFieldSummary, captureRecordPage, captureSession, captureSessionPage, commitCaptureTransaction, insertCaptureSession } from './CaptureDatabaseWorker'
import { validateCaptureSession } from './CaptureRecordValidation'
import { validateCaptureStorageLimits } from './CaptureStorage'
import type { CaptureCommitReceipt } from './CaptureStorage'
import { CAPTURE_WORKER_PROTOCOL, CaptureDatabaseError, captureSafeCode, captureSqliteFilePaths, decodeCaptureRequest, preflightCaptureValue, validateCaptureIdentity, validateCaptureSqliteFiles } from './CaptureWorkerProtocol'
import type { CaptureWorkerCommand, CaptureWorkerStartup } from './CaptureWorkerProtocol'

// Separate bundled entry; no production test commands, HTTP input, retry or replacement worker.
if (!parentPort) throw new CaptureDatabaseError('WORKER_INITIALIZATION_FAILED')
const port = parentPort
let db: DatabaseSync | undefined, created = false, closing = false
let startup!: BridgeStartup

function checkedFile(file: string, mode: 'create' | 'existing'): void {
  if (typeof file !== 'string' || !isAbsolute(file) || file.length > 1024 || !file.trim()) throw new CaptureDatabaseError('INVALID_PATH')
  const parent = dirname(file), info = lstatSync(parent)
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(realpathSync(parent)) !== resolve(parent)) throw new CaptureDatabaseError('INVALID_PATH')
  const statFamily = () => captureSqliteFilePaths(file).map(path => {
    try { return lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new CaptureDatabaseError('INVALID_PATH')
    }
  })
  validateCaptureSqliteFiles(mode, statFamily())
  if (mode === 'create') {
    const fd = openSync(file, 'wx', 0o600); created = true; closeSync(fd)
    // Creation owns only the primary. Unexpected sidecars still forbid SQLite
    // initialization; retain the owned empty file with visible creationState.
    const files = statFamily(); validateCaptureSqliteFiles('existing', files)
    if (files[1] || files[2]) throw new CaptureDatabaseError('DATABASE_EXISTS')
  }
}
function requireOrdinaryExisting(database: DatabaseSync): void {
  // This namespace is reserved for private byte/typed staging. Object presence
  // blocks ordinary admission even for a partial marker, view, index or trigger.
  // GLOB keeps the underscore literal; unrelated legacyX_* objects stay valid.
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE lower(name) GLOB 'legacy_*' LIMIT 1").get() ||
      !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_meta'").get())
    throw new CaptureDatabaseError('SCHEMA_INVALID')
}
const LIVE_OBJECT_NAMES=Object.freeze(["capture_active_account","capture_active_scope","capture_rows","capture_rows_immutable_delete","capture_rows_immutable_update","capture_rows_scope","database_meta","field_entries","live_account_slots","live_control_meta","live_control_receipts","live_controls_owner_update","live_controls_unclean","live_meta_evidence_delete","live_meta_identity_update","live_receipts_immutable_delete","live_receipts_immutable_update","live_receipts_owner","live_requests","live_requests_evidence_delete","live_requests_identity_update","live_requests_slots","live_requests_terminal_update","live_session_controls","operation_receipts","original_rows","original_rows_immutable_delete","original_rows_immutable_update","original_rows_session","receipts_immutable_delete","receipts_immutable_update","sessions","sessions_ordinal","sessions_scope"])
function requireModeExisting(database:DatabaseSync):void{
 if(startup.version===1){requireOrdinaryExisting(database);return}
 if(startup.workerMode==='typed-stage'){readTypedStageAdmission(database,startup.binding!,1048576);return}
 const objects=database.prepare("SELECT length(CAST(name AS BLOB)) n,substr(name,1,129) name,length(CAST(sql AS BLOB)) bytes FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 129").all()
 if(objects.length!==LIVE_OBJECT_NAMES.length||objects.some((o,i)=>o.name!==LIVE_OBJECT_NAMES[i]||typeof o.n!=='number'||o.n>128||typeof o.bytes!=='number'||o.bytes>16384))throw new CaptureDatabaseError('SCHEMA_INVALID')
 initializeCaptureLiveControlSchema(database,startup.identity,'existing')
}
function dispatchV2(request:CaptureWorkerRequestV2):unknown{
 const command=request.command
 if(request.mode==='typed-stage'){switch(command.method){case 'beginSessionImport':return beginSessionImport(db!,startup.version===2?startup.binding!:undefined as never,command.intent);case 'stepSessionImport':return stepSessionImport(db!,startup.version===2?startup.binding!:undefined as never,command.intent);case 'sessionImportReceipt':return sessionImportReceipt(db!,startup.version===2?startup.binding!:undefined as never,command.operationId)}}
 if(command.method==='control')return executeLiveControl(db!,command.input,startup.limits)
 if(command.method==='controlReceipt')return liveControlReceipt(db!,command.scope,command.operationId)
 if(command.method==='controlState')return liveControlState(db!,command.scope,command.sessionId)
 if(command.method==='liveRequest')return liveRequest(db!,command.scope,command.requestId)
 if(command.method==='commit'){const state=liveControlState(db!,command.input.record.scope,command.input.sessionId);if(state.startState!=='ready'||state.stopRequested)throw new CaptureDatabaseError('SESSION_STATE_MISMATCH')}
 return dispatch(command as CaptureWorkerCommand)
}
function sendV2(request:CaptureWorkerRequestV2,ok:boolean,value:unknown):void{
 const context=bridgeContext(startup),expected=projectCaptureReplyExpectationV2(request,context),reply={version:2,mode:request.mode,id:request.id,identity:startup.identity,...(context.mode==='live-control'?{scope:expected.scope}:{}),...(ok?{ok:true,value}:{ok:false,code:value})},buffer=encodeCaptureReplyV2(reply,expected,context)
 port.postMessage({type:'reply',id:request.id,buffer:buffer.buffer},[buffer.buffer as ArrayBuffer])
}
function sendReply(id: number, ok: boolean, value: unknown): void {
  const buffer = serialize(ok ? { version: 1, id, ok, value } : { version: 1, id, ok, code: value })
  if (buffer.byteLength > 16 * 1024 * 1024) throw new CaptureDatabaseError('REQUEST_LIMIT')
  port.postMessage({ type: 'reply', id, buffer: buffer.buffer }, [buffer.buffer as ArrayBuffer])
}
function receipt(command: Extract<CaptureWorkerCommand, { method: 'receipt' }>): CaptureCommitReceipt | undefined {
  // Scope/session validation has already run. No native blobs are read or returned.
  captureSession(db!, command.scope, command.sessionId)
  const row = db!.prepare(`SELECT r.input_digest, r.physical_position, r.commit_watermark, r.session_snapshot
    FROM operation_receipts r JOIN capture_rows c ON c.physical_position=r.physical_position
    WHERE r.operation_id=? AND c.session_id=? AND c.account_id=? AND c.platform=? AND c.source=?`).get(
      command.operationId, command.sessionId, command.scope.accountId, command.scope.platform, command.scope.source,
    ) as { input_digest: string; physical_position: number; commit_watermark: number; session_snapshot: string } | undefined
  if (!row) return undefined
  const session = validateCaptureSession(JSON.parse(row.session_snapshot))
  if (session.id !== command.sessionId || session.scope.accountId !== command.scope.accountId || session.scope.platform !== command.scope.platform || session.scope.source !== command.scope.source || !/^[0-9a-f]{64}$/.test(row.input_digest)) throw new CaptureDatabaseError('INVALID_DATABASE_METADATA')
  return { ...startup.identity, operationId: command.operationId, inputDigest: row.input_digest,
    physicalPosition: analysisInteger(row.physical_position, 1), commitWatermark: analysisInteger(row.commit_watermark, 1), session, reused: true }
}
function dispatch(command: CaptureWorkerCommand): unknown {
  switch (command.method) {
    case 'insertSession': return insertCaptureSession(db!, command.session)
    case 'commit': return commitCaptureTransaction(db!, command.input, startup.limits)
    case 'session': return captureSession(db!, command.scope, command.sessionId)
    case 'recordPage': return captureRecordPage(db!, command.scope, command.sessionId, command.limit, command.seek)
    case 'sessionPage': return captureSessionPage(db!, command.scope, command.limit, command.seek)
    case 'fieldSummary': return captureFieldSummary(db!, command.scope, command.sessionId)
    case 'receipt': return receipt(command)
  }
}
try {
  startup = normalizeBridgeStartup(workerData)
  checkedFile(startup.file, startup.mode)
  if (startup.mode === 'existing') {
    // Read-only preflight avoids writable admission or schema initialization of
    // a candidate. SQLite can still map/create WAL/SHM; no zero-sidecar promise.
    const preflight = new DatabaseSync(startup.file, { readOnly: true })
    try { requireModeExisting(preflight) } finally { preflight.close() }
    checkedFile(startup.file, 'existing')
  }
  db = new DatabaseSync(startup.file)
  if (startup.mode === 'existing') requireModeExisting(db)
  if(startup.version===1)initializeCaptureSchema(db,startup.identity);else{db.exec('PRAGMA foreign_keys=ON');db.exec('PRAGMA synchronous=FULL');db.exec('PRAGMA journal_mode=WAL')}
  const watermark = analysisInteger(Number((db.prepare("SELECT value FROM database_meta WHERE key='commit_watermark'").get() as { value: string }).value))
  port.on('message', message => {
    if (message?.type === 'close' && !closing) {
      closing = true; db!.close(); db = undefined; port.postMessage({ type: 'closed',...(startup.version===2?{version:2,mode:startup.workerMode,identity:startup.identity}:{}) }); port.close(); return
    }
    if (closing) return
    let id = message?.id
    try {
      analysisInteger(id, 1)
      if (message.type !== 'request') throw new CaptureDatabaseError('INVALID_REQUEST')
      if(startup.version===2){
       const request=decodeCaptureRequestV2(message.buffer,bridgeContext(startup));if(request.id!==id)throw new CaptureDatabaseError('INVALID_REQUEST')
       const mutation=isCaptureWriteV2(request.mode,request.command);let completed=false
       try{const value=dispatchV2(request);completed=mutation;sendV2(request,true,value)}catch(error){const code=captureSafeCodeV2(error),uncertain=mutation&&(completed||['TYPED_IMPORT_FAILED','CONTROL_COMMIT_UNCERTAIN','WORKER_OPERATION_FAILED'].includes(code));sendV2(request,false,uncertain?'COMMIT_UNCERTAIN':code)}
       return
      }
      const request = decodeCaptureRequest(message.buffer, startup.limits)
      if (request.id !== id) throw new CaptureDatabaseError('INVALID_REQUEST')
      // Synchronous event callback: only one SQL dispatch executes at a time.
      sendReply(id, true, dispatch(request.command))
    } catch (error) {
      if (!Number.isSafeInteger(id) || id < 1) { db?.close(); port.close(); return }
      if(startup.version===2){db?.close();db=undefined;port.close()}else sendReply(id, false, captureSafeCode(error))
    }
  })
  port.postMessage({ type: 'ready', version: startup.version,...(startup.version===2?{mode:startup.workerMode,controlWatermark:startup.workerMode==='live-control'?Number(db.prepare('SELECT control_watermark n FROM live_control_meta WHERE id=1').get()?.n):0,importWatermark:startup.workerMode==='typed-stage'?Number(db.prepare('SELECT watermark n FROM legacy_typed_runs WHERE run_id=?').get(startup.binding!.runId)?.n??0):0}:{}), identity: startup.identity, commitWatermark: watermark, creationState: created ? 'created' : 'not-created',
    runtime: { node: process.versions.node, sqlite: (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
      journalMode: (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      synchronous: (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
      foreignKeys: (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys } })
} catch (error) {
  try { db?.close() } catch {}
  port.postMessage({ type: 'startup-error',...(startup?.version===2?{version:2,mode:startup.workerMode,identity:startup.identity}:{}), code: startup?.version===2?captureSafeCodeV2(error):captureSafeCode(error, 'WORKER_INITIALIZATION_FAILED'), creationState: created ? 'created' : 'not-created' })
  port.close()
}
