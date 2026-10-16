import {bridgeContext,normalizeBridgeStartup,type BridgeStartup} from './CaptureWorkerStartup'
import {encodeCaptureRequestV2,decodeCaptureReplyV2,projectCaptureReplyExpectationV2,isCaptureWriteV2,captureSafeCodeV2,type CaptureReplyExpectationV2,type CaptureWorkerRequestV2,type TypedStageCommandV2,type LiveCommandV2} from './CaptureWorkerProtocolV2'
import type {TypedStageBinding} from './CaptureTypedStageSchema'
import type {SessionImportIntent,SessionImportReceipt} from './CaptureTypedStageImport'
import type {CaptureLiveControlCommand,CaptureLiveControlReceipt} from './CaptureLiveControl'
import { Worker } from 'node:worker_threads'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deserialize } from 'node:v8'
import type { AnalysisScope, AnalysisSession, CaptureLimits, FieldSummary } from '../../../../shared/analysisRoom'
import { analysisInteger, analysisString } from '../../../../shared/analysisRoom'
import type { CaptureCommit, CaptureCommitReceipt, CaptureDatabaseIdentity, CaptureLinePage, CaptureSeek, CaptureSessionPage, SessionSeek } from './CaptureStorage'
import { validateCaptureStorageLimits } from './CaptureStorage'
import { CAPTURE_WORKER_PROTOCOL, CaptureDatabaseError, captureSafeCode, captureSqliteFilePaths, encodeCaptureRequest, preflightCaptureValue, validateCaptureIdentity, validateCaptureSqliteFiles } from './CaptureWorkerProtocol'
import { validateCaptureSession } from './CaptureRecordValidation'
import type { CaptureCreationState, CaptureWorkerCommand, CaptureWorkerStartup } from './CaptureWorkerProtocol'
export { CaptureDatabaseError } from './CaptureWorkerProtocol'

export interface CaptureDatabaseOptions {
  file: string; identity: CaptureDatabaseIdentity; limits: Readonly<CaptureLimits>; mode: 'create' | 'existing'; workerFile?: string
  startupTimeoutMs?: number; requestTimeoutMs?: number; protocol?: 1|2; workerMode?: 'typed-stage'|'live-control'; binding?: TypedStageBinding
}
export interface CaptureRequestOptions { signal?: AbortSignal }
export type CaptureAdmission =
  | { accepted: false; reason: string }
  | { accepted: true; operationId: string; committed: Promise<CaptureCommitReceipt> }
type RequestAdmission<T> =
  | { accepted: false; reason: string }
  | { accepted: true; operationId?: string; committed: Promise<T> }
export interface CaptureDatabaseHealth {
  lifecycle: 'starting' | 'ready' | 'closing' | 'closed' | 'failed'; workerExited: boolean
  pendingOperations: number; pendingBytes: number; ownPendingOperations: number; commitWatermark: number
  commitUncertain: boolean; mode?: 'ordinary'|'typed-stage'|'live-control'; controlWatermark: number; importWatermark: number
  lastFailureCode?: string; creationState: CaptureCreationState
  runtime?: Readonly<{ node: string; sqlite: string; journalMode: string; synchronous: number; foreignKeys: number }>
}
interface Pending {
  bytes: number; method: CaptureWorkerCommand['method']|TypedStageCommandV2['method']|LiveCommandV2['method']; settled: boolean; postAttempted: boolean; expectation?: CaptureReplyExpectationV2
  mutation: boolean
  expectedOperationId?: string; expectedSessionId?: string; expectedScope?: AnalysisScope
  resolve(value: unknown): void; reject(error: CaptureDatabaseError): void
  timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void
}
// One process ledger, so accounts and clients cannot each allocate their own full queue.
let globalOperations = 0, globalBytes = 0
/** Internal packaged path only; exact archive segment, never an HTTP/IPC/MCP path. */
export function resolveCaptureWorkerAsset(moduleDirectory: string): string {
  return join(moduleDirectory.replace(/(^|[\\/])app\.asar(?=$|[\\/])/g, '$1app.asar.unpacked'), 'analysis-capture-worker.cjs')
}
function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 20 || result > 60000) throw new CaptureDatabaseError('INVALID_REQUEST')
  return result
}
function requestSignal(options?: CaptureRequestOptions): AbortSignal | undefined {
  if (options === undefined) return undefined
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).some(key => key !== 'signal')) throw new CaptureDatabaseError('INVALID_REQUEST')
  const descriptor = Object.getOwnPropertyDescriptor(options, 'signal')
  if (!descriptor) return undefined
  if (!('value' in descriptor)) throw new CaptureDatabaseError('INVALID_REQUEST')
  const signal = descriptor.value
  if (signal === undefined) return undefined
  if (!(signal instanceof AbortSignal)) throw new CaptureDatabaseError('INVALID_REQUEST')
  for (const key of ['addEventListener', 'removeEventListener']) {
    const own = Object.getOwnPropertyDescriptor(signal, key)
    if (own && !('value' in own)) throw new CaptureDatabaseError('INVALID_REQUEST')
    if (typeof signal[key as 'addEventListener'] !== 'function') throw new CaptureDatabaseError('INVALID_REQUEST')
  }
  return signal
}
function signalAborted(signal: AbortSignal): boolean { return Reflect.get(AbortSignal.prototype, 'aborted', signal) }
function admissionReason(error: unknown): string {
  return error instanceof CaptureDatabaseError && ['ABORTED', 'DATABASE_CLOSING', 'DATABASE_UNAVAILABLE', 'QUEUE_FULL', 'REQUEST_LIMIT', 'INVALID_REQUEST'].includes(error.code) ? error.code : 'INVALID_REQUEST'
}
async function checkedConstruction(file: string, asset: string, mode: 'create' | 'existing'): Promise<void> {
  if (!isAbsolute(file) || !isAbsolute(asset) || file.length > 1024 || asset.length > 1024) throw new CaptureDatabaseError('INVALID_PATH')
  let worker
  try { worker = await lstat(asset) } catch { throw new CaptureDatabaseError('WORKER_ASSET_MISSING') }
  if (!asset.endsWith('.cjs') || !worker.isFile() || worker.isSymbolicLink() || worker.nlink !== 1 || worker.size > 4 * 1024 * 1024) throw new CaptureDatabaseError('WORKER_ASSET_MISSING')
  let parent
  try { parent = await lstat(dirname(file)) } catch { throw new CaptureDatabaseError('INVALID_PATH') }
  if (!parent.isDirectory() || parent.isSymbolicLink() || resolve(await realpath(dirname(file))) !== resolve(dirname(file))) throw new CaptureDatabaseError('INVALID_PATH')
  const files = await Promise.all(captureSqliteFilePaths(file).map(async path => {
    try { return await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new CaptureDatabaseError('INVALID_PATH')
    }
  }))
  validateCaptureSqliteFiles(mode, files)
}

/** Internal SQLite worker client. This unit does not activate/migrate production capture. */
export class CaptureDatabase {
  private readonly worker: Worker
  private readonly limits: Readonly<CaptureLimits>
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private lifecycle: CaptureDatabaseHealth['lifecycle'] = 'starting'
  private lastFailureCode?: string
  private creationState: CaptureCreationState = 'unknown'
  private controlWatermark = 0
  private importWatermark = 0
  private watermark = 0
  private commitUncertain = false
  private workerExited = false
  private closingRequested = false
  private closedAcknowledged = false
  private closeSent = false
  private terminating = false
  private runtime?: CaptureDatabaseHealth['runtime']
  private startupTimer?: ReturnType<typeof setTimeout>
  private drainPromise?: Promise<void>
  private drainResolve?: () => void
  private closePromise?: Promise<void>
  private readonly ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: CaptureDatabaseError) => void
  private readonly exited: Promise<void>
  private exitResolve!: () => void

  static async open(options: CaptureDatabaseOptions): Promise<CaptureDatabase> {
    if (!options || !['create', 'existing'].includes(options.mode) || typeof options.file !== 'string') throw new CaptureDatabaseError('INVALID_REQUEST')
    const limits = validateCaptureStorageLimits(options.limits), identity = validateCaptureIdentity(options.identity)
    const startupTimeoutMs = timeout(options.startupTimeoutMs, 10000), requestTimeoutMs = timeout(options.requestTimeoutMs, 30000)
    const moduleDirectory = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
    const asset = options.workerFile ?? resolveCaptureWorkerAsset(moduleDirectory)
    await checkedConstruction(options.file, asset, options.mode)
    if(options.protocol!==undefined&&options.protocol!==1&&options.protocol!==2)throw new CaptureDatabaseError('INVALID_REQUEST')
    const startup = normalizeBridgeStartup(options.protocol===2?{version:2,file:options.file,identity,limits,mode:options.mode,workerMode:options.workerMode,...(options.workerMode==='typed-stage'?{binding:options.binding}:{})}:{ version: 1, file: options.file, identity, limits, mode: options.mode })
    preflightCaptureValue(startup, 8192)
    const client = new CaptureDatabase(asset, startup, startupTimeoutMs, requestTimeoutMs)
    try { await client.ready; return client } catch (error) { await client.close(); throw error }
  }
  private constructor(asset: string, private readonly startup: BridgeStartup, startupTimeoutMs: number, private readonly requestTimeoutMs: number) {
    this.limits = startup.limits
    this.ready = new Promise((done, reject) => { this.readyResolve = done; this.readyReject = reject })
    this.exited = new Promise(done => { this.exitResolve = done })
    try { this.worker = new Worker(asset, { workerData: startup, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } }) }
    catch { throw new CaptureDatabaseError('WORKER_FAILED', false, 'not-created') }
    this.worker.on('message', this.onMessage); this.worker.on('error', this.onError); this.worker.on('exit', this.onExit)
    this.startupTimer = setTimeout(() => this.fail('WORKER_START_TIMEOUT'), startupTimeoutMs)
  }
  health(): CaptureDatabaseHealth {
    return { lifecycle: this.lifecycle, workerExited: this.workerExited, pendingOperations: globalOperations, pendingBytes: globalBytes,
      ownPendingOperations: this.pending.size, commitWatermark: this.watermark, controlWatermark:this.controlWatermark,importWatermark:this.importWatermark,mode:this.startup.version===1?'ordinary':this.startup.workerMode, commitUncertain: this.commitUncertain, creationState: this.creationState,
      ...(this.lastFailureCode ? { lastFailureCode: this.lastFailureCode } : {}), ...(this.runtime ? { runtime: { ...this.runtime } } : {}) }
  }
  insertSession(session: AnalysisSession, options?: CaptureRequestOptions): Promise<void> { return this.request({ method: 'insertSession', session }, options) }
  /** Accepted owns transport capacity and attempts submission; only committed proves durability. */
  admitCapture(input: CaptureCommit, options?: CaptureRequestOptions): CaptureAdmission {
    const admitted = this.admitRequest<CaptureCommitReceipt>({ method: 'commit', input }, options)
    return admitted.accepted ? { accepted: true, operationId: admitted.operationId!, committed: admitted.committed } : admitted
  }
  commit(input: CaptureCommit, options?: CaptureRequestOptions): Promise<CaptureCommitReceipt> {
    const admitted = this.admitCapture(input, options)
    return admitted.accepted ? admitted.committed : Promise.reject(new CaptureDatabaseError(admitted.reason))
  }
  session(scope: AnalysisScope, sessionId: string, options?: CaptureRequestOptions): Promise<AnalysisSession> { return this.request({ method: 'session', scope, sessionId }, options) }
  recordPage(scope: AnalysisScope, sessionId: string, limit: number, seek: CaptureSeek, options?: CaptureRequestOptions): Promise<CaptureLinePage> { return this.request({ method: 'recordPage', scope, sessionId, limit, seek }, options) }
  sessionPage(scope: AnalysisScope, limit: number, seek?: SessionSeek, options?: CaptureRequestOptions): Promise<CaptureSessionPage> { return this.request({ method: 'sessionPage', scope, limit, ...(seek ? { seek } : {}) }, options) }
  fieldSummary(scope: AnalysisScope, sessionId: string, options?: CaptureRequestOptions): Promise<FieldSummary> { return this.request({ method: 'fieldSummary', scope, sessionId }, options) }
  receipt(scope: AnalysisScope, sessionId: string, operationId: string, options?: CaptureRequestOptions): Promise<CaptureCommitReceipt | undefined> { return this.request({ method: 'receipt', scope, sessionId, operationId }, options) }

  requestV2<T>(command: TypedStageCommandV2|LiveCommandV2,options?:CaptureRequestOptions):Promise<T>{if(this.startup.version!==2)return Promise.reject(new CaptureDatabaseError('INVALID_REQUEST'));return this.request(command,options)}
  beginSessionImport(intent:SessionImportIntent,options?:CaptureRequestOptions):Promise<SessionImportReceipt>{return this.requestV2({method:'beginSessionImport',intent},options)}
  stepSessionImport(intent:SessionImportIntent,options?:CaptureRequestOptions):Promise<SessionImportReceipt>{return this.requestV2({method:'stepSessionImport',intent},options)}
  sessionImportReceipt(operationId:string,options?:CaptureRequestOptions):Promise<SessionImportReceipt|undefined>{return this.requestV2({method:'sessionImportReceipt',operationId},options)}
  control(input:CaptureLiveControlCommand,options?:CaptureRequestOptions):Promise<CaptureLiveControlReceipt>{return this.requestV2({method:'control',input},options)}
  controlReceipt(scope:AnalysisScope,operationId:string,options?:CaptureRequestOptions):Promise<CaptureLiveControlReceipt|undefined>{return this.requestV2({method:'controlReceipt',scope,operationId},options)}
  controlState(scope:AnalysisScope,sessionId:string,options?:CaptureRequestOptions):Promise<unknown>{return this.requestV2({method:'controlState',scope,sessionId},options)}
  liveRequest(scope:AnalysisScope,requestId:string,options?:CaptureRequestOptions):Promise<unknown>{return this.requestV2({method:'liveRequest',scope,requestId},options)}

  private request<T>(command: CaptureWorkerCommand|TypedStageCommandV2|LiveCommandV2, options?: CaptureRequestOptions): Promise<T> {
    const admitted = this.admitRequest<T>(command, options)
    return admitted.accepted ? admitted.committed : Promise.reject(new CaptureDatabaseError(admitted.reason))
  }
  private admitRequest<T>(command: CaptureWorkerCommand|TypedStageCommandV2|LiveCommandV2, options?: CaptureRequestOptions): RequestAdmission<T> {
    let id: number | undefined, pending: Pending | undefined, reserved = false
    try {
      const signal = requestSignal(options)
      if (signal && signalAborted(signal)) throw new CaptureDatabaseError('ABORTED')
      if (this.lifecycle !== 'ready' || this.closingRequested) throw new CaptureDatabaseError(this.closingRequested ? 'DATABASE_CLOSING' : 'DATABASE_UNAVAILABLE')
      if (globalOperations >= this.limits.maxPendingRecords) throw new CaptureDatabaseError('QUEUE_FULL')
      if (!Number.isSafeInteger(this.nextId)) throw new CaptureDatabaseError('REQUEST_LIMIT')
      id = this.nextId++
      const v2=this.startup.version===2?{version:2,mode:this.startup.workerMode,id,command} as CaptureWorkerRequestV2:undefined
      const encoded = v2?encodeCaptureRequestV2(v2,bridgeContext(this.startup)):encodeCaptureRequest({ version: 1, id, command:command as CaptureWorkerCommand }, this.limits)
      const expectation=v2?projectCaptureReplyExpectationV2(v2,bridgeContext(this.startup)):undefined
      // Reservation covers transport and decoded queue payload; excludes V8/native heap and caller copies.
      const bytes = encoded.buffer.byteLength * 2
      if (globalBytes + bytes > this.limits.maxPendingBytes) throw new CaptureDatabaseError('QUEUE_FULL')
      let done!: (value: T) => void, reject!: (error: CaptureDatabaseError) => void
      const committed = new Promise<T>((resolve, fail) => { done = resolve; reject = fail })
      pending = { bytes, method: command.method, mutation: this.startup.version===2?isCaptureWriteV2(this.startup.workerMode,command):command.method === 'commit' || command.method === 'insertSession', expectation, settled: false, postAttempted: false, resolve: value => done(value as T), reject }
      if (command.method === 'commit') { pending.expectedOperationId = command.input.operationId; pending.expectedSessionId = command.input.sessionId; pending.expectedScope = { ...command.input.record.scope } }
      if (command.method === 'receipt') { pending.expectedOperationId = command.operationId; pending.expectedSessionId = command.sessionId; pending.expectedScope = { ...command.scope } }
      if (this.pending.size === 0) { this.drainPromise = undefined; this.drainResolve = undefined }
      this.pending.set(id, pending)
      globalOperations++; globalBytes += bytes; reserved = true
      // Setup is protected, unlike a throwing Promise executor after reservation.
      pending.timer = setTimeout(() => this.fail('WORKER_REQUEST_TIMEOUT'), this.requestTimeoutMs)
      if (signal) {
        pending.signal = signal
        const owned = pending
        pending.abort = () => {
          if (!owned.postAttempted || owned.settled) return
          owned.settled = true; const uncertain = owned.mutation
          this.commitUncertain ||= uncertain; this.lastFailureCode = uncertain ? 'COMMIT_UNCERTAIN' : 'ABORTED'
          owned.reject(new CaptureDatabaseError(this.lastFailureCode, uncertain))
        }
        signal.addEventListener('abort', pending.abort, { once: true })
        if (signalAborted(signal)) throw new CaptureDatabaseError('ABORTED')
      }
      if (this.lifecycle !== 'ready' || this.closingRequested) throw new CaptureDatabaseError(this.closingRequested ? 'DATABASE_CLOSING' : 'DATABASE_UNAVAILABLE')
      pending.postAttempted = true
      try { this.worker.postMessage({ type: 'request', id, buffer: encoded.buffer }, [encoded.buffer as ArrayBuffer]) }
      catch { this.fail('WORKER_FAILED') }
      return { accepted: true, committed, ...(pending.expectedOperationId ? { operationId: pending.expectedOperationId } : {}) }
    } catch (error) {
      if (id !== undefined && pending && this.pending.get(id) === pending) {
        if (reserved) this.terminal(id)
        else { this.pending.delete(id); this.cleanupPending(pending); if (this.pending.size === 0) this.drainResolve?.() }
      }
      const code=this.startup.version===2?captureSafeCodeV2(error):undefined
      return { accepted: false, reason: code&&['V2_INVALID_REQUEST','V2_LIMIT'].includes(code)?code:admissionReason(error) }
    }
  }
  drain(): Promise<void> {
    if (!this.drainPromise) this.drainPromise = this.pending.size === 0 ? Promise.resolve() : new Promise(done => { this.drainResolve = done })
    return this.drainPromise
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closingRequested = true
    if (this.lifecycle === 'ready') this.lifecycle = 'closing'
    this.closePromise = (async () => {
      await this.drain()
      if (!this.workerExited && !this.terminating) {
        try { this.closeSent=true;this.worker.postMessage({ type: 'close' }) } catch { this.fail('WORKER_FAILED') }
      }
      const timer = setTimeout(() => this.fail('WORKER_CLOSE_TIMEOUT'), this.requestTimeoutMs)
      try { await this.exited } finally { clearTimeout(timer) }
    })()
    return this.closePromise
  }
  private terminal(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id); this.cleanupPending(pending)
    globalOperations--; globalBytes -= pending.bytes
    if (this.pending.size === 0) this.drainResolve?.()
    return pending
  }
  private cleanupPending(pending: Pending): void {
    clearTimeout(pending.timer); pending.timer = undefined
    const signal = pending.signal, abort = pending.abort
    pending.signal = undefined; pending.abort = undefined
    if (signal && abort) {
      try { signal.removeEventListener('abort', abort) }
      catch { try { EventTarget.prototype.removeEventListener.call(signal, 'abort', abort) } catch {} }
    }
  }
  private readonly onMessage = (message: any): void => {
    if (message?.type === 'ready' && this.lifecycle === 'starting') {
      if (message.version !== this.startup.version || this.startup.version===2&&(message.mode!==this.startup.workerMode||!Number.isSafeInteger(message.controlWatermark)||message.controlWatermark<0||!Number.isSafeInteger(message.importWatermark)||message.importWatermark<0||Object.keys(message).sort().join(',')!=='commitWatermark,controlWatermark,creationState,identity,importWatermark,mode,runtime,type,version') || JSON.stringify(message.identity) !== JSON.stringify(this.startup.identity) || !Number.isSafeInteger(message.commitWatermark) || message.commitWatermark < 0) { this.fail('WORKER_PROTOCOL_ERROR'); return }
      clearTimeout(this.startupTimer); this.startupTimer = undefined; this.watermark = message.commitWatermark
      if(this.startup.version===2){const r=message.runtime;if(message.creationState!=='not-created'||!r||Object.keys(r).sort().join(',')!=='foreignKeys,journalMode,node,sqlite,synchronous'||typeof r.node!=='string'||r.node.length>64||typeof r.sqlite!=='string'||r.sqlite.length>64||r.journalMode!=='wal'||r.synchronous!==2||r.foreignKeys!==1){this.fail('WORKER_PROTOCOL_ERROR');return}this.controlWatermark=message.controlWatermark;this.importWatermark=message.importWatermark}
      this.creationState = message.creationState === 'created' ? 'created' : 'not-created'; this.runtime = message.runtime
      this.lifecycle = 'ready'; this.readyResolve(); return
    }
    if (message?.type === 'startup-error' && this.lifecycle === 'starting') {
      if(this.startup.version===2&&(message.version!==2||message.mode!==this.startup.workerMode||JSON.stringify(message.identity)!==JSON.stringify(this.startup.identity)||Object.keys(message).sort().join(',')!=='code,creationState,identity,mode,type,version')){this.fail('WORKER_PROTOCOL_ERROR');return}
      this.creationState = message.creationState === 'created' ? 'created' : 'not-created'
      this.fail(this.startup.version===2?captureSafeCodeV2({code:message.code}):captureSafeCode({ code: message.code }, 'WORKER_INITIALIZATION_FAILED')); return
    }
    if (message?.type === 'closed' && this.closingRequested) { if(!this.closeSent||this.pending.size!==0||this.startup.version===2&&(message.version!==2||message.mode!==this.startup.workerMode||JSON.stringify(message.identity)!==JSON.stringify(this.startup.identity)||Object.keys(message).sort().join(',')!=='identity,mode,type,version')){this.fail('WORKER_PROTOCOL_ERROR');return}this.closedAcknowledged = true; return }
    if (message?.type !== 'reply' || !this.pending.has(message.id)) return
    try {
      if (!(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength > 16 * 1024 * 1024) throw new CaptureDatabaseError('WORKER_PROTOCOL_ERROR')
      if(this.startup.version===2){this.onReplyV2(message);return}
      const reply = deserialize(new Uint8Array(message.buffer))
      if (reply.version !== 1 || reply.id !== message.id || typeof reply.ok !== 'boolean') throw new CaptureDatabaseError('WORKER_PROTOCOL_ERROR')
      const pending = this.pending.get(message.id)!
      if (reply.ok && (pending.method === 'commit' || pending.method === 'receipt') && reply.value !== undefined) {
        const value = reply.value, identity = validateCaptureIdentity({ databaseId: value.databaseId, generation: value.generation, schemaVersion: value.schemaVersion })
        const session = validateCaptureSession(value.session)
        if (JSON.stringify(identity) !== JSON.stringify(this.startup.identity) || typeof value.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.inputDigest) || typeof value.reused !== 'boolean' || value.operationId !== pending.expectedOperationId || session.id !== pending.expectedSessionId || session.scope.accountId !== pending.expectedScope?.accountId || session.scope.platform !== pending.expectedScope?.platform || session.scope.source !== pending.expectedScope?.source) throw new CaptureDatabaseError('WORKER_PROTOCOL_ERROR')
        analysisString(value.operationId, 256); analysisInteger(value.physicalPosition, 1); analysisInteger(value.commitWatermark, 1)
        if (session.originals?.error !== undefined && typeof session.originals.error !== 'string') throw new CaptureDatabaseError('WORKER_PROTOCOL_ERROR')
        reply.value = { ...identity, operationId: value.operationId, inputDigest: value.inputDigest, physicalPosition: value.physicalPosition, commitWatermark: value.commitWatermark, reused: value.reused, session }
        this.watermark = Math.max(this.watermark, reply.value.commitWatermark)
      }
      if (reply.ok && pending.method === 'commit' && reply.value === undefined) throw new CaptureDatabaseError('WORKER_PROTOCOL_ERROR')
      this.terminal(message.id)
      if (!pending.settled) { pending.settled = true
        if (reply.ok) pending.resolve(reply.value)
        else pending.reject(new CaptureDatabaseError(captureSafeCode({ code: reply.code })))
      }
    } catch { this.fail('WORKER_PROTOCOL_ERROR') }
  }
  private onReplyV2(message:any):void{
    const pending=this.pending.get(message.id)!
    const reply=decodeCaptureReplyV2(message.buffer,pending.expectation!,bridgeContext(this.startup))
    if(reply.ok&&reply.value!==undefined){const r=reply.value as any;if(pending.method==='beginSessionImport'||pending.method==='stepSessionImport'||pending.method==='sessionImportReceipt')this.importWatermark=Math.max(this.importWatermark,r.watermark);else if(pending.method==='control'||pending.method==='controlReceipt'){this.controlWatermark=Math.max(this.controlWatermark,r.controlWatermark);this.watermark=Math.max(this.watermark,r.recordWatermarkAtCommit)}else if(pending.method==='commit'||pending.method==='receipt')this.watermark=Math.max(this.watermark,r.commitWatermark)}
    this.terminal(message.id)
    if(!pending.settled){pending.settled=true;if(reply.ok)pending.resolve(reply.value);else{const uncertain=pending.mutation&&reply.code==='COMMIT_UNCERTAIN';this.commitUncertain ||= uncertain;if(uncertain)this.lastFailureCode='COMMIT_UNCERTAIN';pending.reject(new CaptureDatabaseError(reply.code,uncertain))}}
  }
  private readonly onError = (): void => { this.fail('WORKER_FAILED') }
  private readonly onExit = (code: number): void => {
    this.workerExited = true
    if(this.pending.size>0&&this.lifecycle!=='failed')this.fail('WORKER_EXITED')
    if (this.closingRequested && this.closeSent&&this.closedAcknowledged&&this.pending.size===0 && code === 0 && this.lifecycle !== 'failed') this.lifecycle = 'closed'
    else if (this.lifecycle !== 'failed') this.fail('WORKER_EXITED')
    for (const id of [...this.pending.keys()]) this.terminal(id)
    this.worker.removeListener('message', this.onMessage); this.worker.removeListener('error', this.onError); this.worker.removeListener('exit', this.onExit)
    clearTimeout(this.startupTimer); this.startupTimer = undefined; this.exitResolve()
  }
  private fail(code: string): void {
    if (this.lifecycle === 'closed') return
    const wasStarting = this.lifecycle === 'starting'
    this.lifecycle = 'failed'; this.lastFailureCode = code; clearTimeout(this.startupTimer); this.startupTimer = undefined
    if (wasStarting) this.readyReject(new CaptureDatabaseError(code, false, this.creationState))
    for (const [id, pending] of this.pending) {
      this.cleanupPending(pending)
      if (!pending.settled) { pending.settled = true; const uncertain = pending.mutation && pending.postAttempted; this.commitUncertain ||= uncertain; pending.reject(new CaptureDatabaseError(uncertain ? 'COMMIT_UNCERTAIN' : code, uncertain)) }
      if (this.workerExited) this.terminal(id)
    }
    if (!this.workerExited && !this.terminating) { this.terminating = true; void this.worker.terminate().catch(() => {}) }
  }
}
