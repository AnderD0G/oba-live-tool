import { serialize, deserialize } from 'node:v8'
import type { Stats } from 'node:fs'
import type { AnalysisScope, AnalysisSession, CaptureLimits } from '../../../../shared/analysisRoom'
import { analysisId, analysisInteger, analysisString, validateAnalysisScope } from '../../../../shared/analysisRoom'
import type { CaptureCommit, CaptureDatabaseIdentity, CaptureSeek, SessionSeek } from './CaptureStorage'
import { CAPTURE_STORAGE_LIMITS } from './CaptureStorage'

export const CAPTURE_WORKER_PROTOCOL = 1
export type CaptureWorkerCommand =
  | { method: 'insertSession'; session: AnalysisSession }
  | { method: 'commit'; input: CaptureCommit }
  | { method: 'session' | 'fieldSummary'; scope: AnalysisScope; sessionId: string }
  | { method: 'receipt'; scope: AnalysisScope; sessionId: string; operationId: string }
  | { method: 'recordPage'; scope: AnalysisScope; sessionId: string; limit: number; seek: CaptureSeek }
  | { method: 'sessionPage'; scope: AnalysisScope; limit: number; seek?: SessionSeek }
export interface CaptureRequestEnvelope { version: 1; id: number; command: CaptureWorkerCommand }
export interface CaptureWorkerStartup {
  version: 1; file: string; identity: CaptureDatabaseIdentity; limits: Readonly<CaptureLimits>; mode: 'create' | 'existing'
}
export type CaptureCreationState = 'not-created' | 'created' | 'unknown'
export class CaptureDatabaseError extends Error {
  constructor(readonly code: string, readonly commitUncertain = false, readonly creationState?: CaptureCreationState) { super(code) }
}
/** SQLite opens these paths itself; none may alias an unrelated physical file. */
export function captureSqliteFilePaths(file: string): readonly [string, string, string] {
  return [file, `${file}-wal`, `${file}-shm`]
}
export function validateCaptureSqliteFiles(mode: 'create' | 'existing', files: readonly (Stats | undefined)[]): void {
  if (files.length !== 3) throw new CaptureDatabaseError('INVALID_PATH')
  for (const file of files) if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)) throw new CaptureDatabaseError('INVALID_PATH')
  if (mode === 'create' && files.some(Boolean)) throw new CaptureDatabaseError('DATABASE_EXISTS')
  if (mode === 'existing' && !files[0]) throw new CaptureDatabaseError('DATABASE_MISSING')
}
const safeCodes = new Set([
  'ANALYSIS_INVALID_INPUT', 'SCHEMA_VERSION_UNSUPPORTED', 'SCHEMA_IDENTITY_MISMATCH', 'SCHEMA_INVALID',
  'INVALID_DATABASE_METADATA', 'INVALID_DELTA', 'INVALID_FIELD_SUMMARY', 'INVALID_INPUT', 'INVALID_NATIVE_PAIR',
  'INVALID_OFFSET', 'INVALID_RECORD_LINE', 'INVALID_SHARD', 'OPERATION_CONFLICT', 'RECORD_LINE_MISMATCH',
  'SCOPE_MISMATCH', 'SESSION_LIMIT', 'SESSION_NOT_FOUND', 'SESSION_STATE_MISMATCH', 'STALE_SEQUENCE', 'STORAGE_LIMIT',
  'UNSANITIZED_RECORD', 'INVALID_REQUEST', 'REQUEST_LIMIT', 'DATABASE_EXISTS', 'DATABASE_MISSING', 'INVALID_PATH',
  'WORKER_OPERATION_FAILED', 'WORKER_INITIALIZATION_FAILED',
])
export function captureSafeCode(error: unknown, fallback = 'WORKER_OPERATION_FAILED'): string {
  try { const code = (error as { code?: unknown })?.code; return typeof code === 'string' && safeCodes.has(code) ? code : fallback } catch { return fallback }
}
function reject(code: string): never { throw new CaptureDatabaseError(code) }

/** Pre-copy budget, not a promise about V8/native heap. Accessors/prototypes are never serialized. */
export function preflightCaptureValue(value: unknown, maxBytes: number, maxDepth = 28): void {
  let bytes = 0, nodes = 0
  const ancestors = new Set<object>()
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > 65536 || depth > maxDepth) reject('REQUEST_LIMIT')
    if (current === undefined || current === null || typeof current === 'boolean') bytes += 4
    else if (typeof current === 'number') { if (!Number.isFinite(current)) reject('INVALID_REQUEST'); bytes += 8 }
    else if (typeof current === 'string') bytes += Buffer.byteLength(current) + 8
    else if (current instanceof Uint8Array) {
      const proto = Object.getPrototypeOf(current)
      if (proto !== Uint8Array.prototype && proto !== Buffer.prototype) reject('INVALID_REQUEST')
      // An own byteLength/buffer getter would run before any later object walk.
      for (const key of ['byteLength', 'byteOffset', 'buffer', 'length']) if (Object.hasOwn(current, key)) reject('INVALID_REQUEST')
      if (current.byteLength > CAPTURE_STORAGE_LIMITS.maxRecordBytes) reject('REQUEST_LIMIT')
      for (const key of Reflect.ownKeys(current)) if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) reject('INVALID_REQUEST')
      bytes += current.byteLength + 16
    } else if (typeof current === 'object') {
      const object = current as object, proto = Object.getPrototypeOf(object), array = Array.isArray(object)
      if ((!array && proto !== Object.prototype && proto !== null) || ancestors.has(object)) reject('INVALID_REQUEST')
      if (array && (object as unknown[]).length >= 65536) reject('REQUEST_LIMIT')
      ancestors.add(object); bytes += 16
      // Check enumerables incrementally before allocating the bounded descriptor-key list.
      let keys = 0
      for (const key in object) { if (++keys > 65536 || ++nodes > 65536) reject('REQUEST_LIMIT'); bytes += Buffer.byteLength(key) + 8; if (bytes > maxBytes) reject('REQUEST_LIMIT') }
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key !== 'string') reject('INVALID_REQUEST')
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!
        if (!('value' in descriptor)) reject('INVALID_REQUEST')
        if (array && key === 'length') continue
        if (!descriptor.enumerable) reject('INVALID_REQUEST')
        visit(descriptor.value, depth + 1)
      }
      ancestors.delete(object)
    } else reject('INVALID_REQUEST')
    if (bytes > maxBytes) reject('REQUEST_LIMIT')
  }
  visit(value, 0)
}

export function encodeCaptureRequest(envelope: CaptureRequestEnvelope, limits: Readonly<CaptureLimits>): Buffer {
  preflightCaptureValue(envelope, limits.maxPendingBytes)
  validateCaptureCommand(envelope.command, limits)
  const bytes = serialize(envelope)
  if (bytes.byteLength > limits.maxMetadataBytes || bytes.buffer.byteLength * 2 > limits.maxPendingBytes) reject('REQUEST_LIMIT')
  return bytes
}
export function decodeCaptureRequest(buffer: ArrayBuffer, limits: Readonly<CaptureLimits>): CaptureRequestEnvelope {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > limits.maxPendingBytes / 2) reject('REQUEST_LIMIT')
  const value = deserialize(new Uint8Array(buffer)) as CaptureRequestEnvelope
  preflightCaptureValue(value, limits.maxPendingBytes)
  if (value.version !== CAPTURE_WORKER_PROTOCOL) reject('INVALID_REQUEST')
  analysisInteger(value.id, 1)
  validateCaptureCommand(value.command, limits)
  return value
}
export function validateCaptureIdentity(input: CaptureDatabaseIdentity): CaptureDatabaseIdentity {
  preflightCaptureValue(input, 2048)
  const keys = Object.keys(input)
  if (keys.length !== 3 || keys.some(key => !['databaseId', 'generation', 'schemaVersion'].includes(key)) || input.schemaVersion !== 1) reject('INVALID_REQUEST')
  return { databaseId: analysisId(input.databaseId), generation: analysisInteger(input.generation, 1), schemaVersion: 1 }
}
export function validateCaptureCommand(command: CaptureWorkerCommand, limits: Readonly<CaptureLimits>): void {
  if (!command || typeof command !== 'object') reject('INVALID_REQUEST')
  switch (command.method) {
    case 'insertSession': return
    case 'commit': {
      const input = command.input
      if (!input || !(input.recordLine instanceof Uint8Array)) reject('INVALID_REQUEST')
      for (const bytes of [input.recordLine, input.originalLine, input.originalJson]) {
        if (bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxRecordBytes)) reject('REQUEST_LIMIT')
      }
      analysisString(input.operationId, 256); analysisId(input.sessionId); analysisInteger(input.expectedSequence)
      analysisInteger(input.nextOffset, 0, limits.maxShardBytes)
      if (input.record?.data !== undefined) preflightCaptureValue(input.record.data, limits.maxRecordBytes, limits.maxDepth)
      return
    }
    case 'session': case 'fieldSummary': case 'receipt':
      validateAnalysisScope(command.scope); analysisId(command.sessionId)
      if (command.method === 'receipt') analysisString(command.operationId, 256)
      return
    case 'recordPage':
      validateAnalysisScope(command.scope); analysisId(command.sessionId); analysisInteger(command.limit, 1, 100)
      analysisInteger(command.seek?.upperPosition); if (command.seek.afterPosition !== undefined) analysisInteger(command.seek.afterPosition)
      return
    case 'sessionPage':
      validateAnalysisScope(command.scope); analysisInteger(command.limit, 1, 100)
      if (command.seek) { analysisInteger(command.seek.upperOrder); if (command.seek.beforeOrder !== undefined) analysisInteger(command.seek.beforeOrder) }
      return
    default: reject('INVALID_REQUEST')
  }
}
