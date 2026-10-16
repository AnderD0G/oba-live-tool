import type {
  AnalysisRecord,
  AnalysisScope,
  AnalysisSession,
  CaptureLimits,
  FieldSummary,
  OriginalEvidenceSummary,
} from '../../../../shared/analysisRoom'

/** Phase32 foundation DTOs only. This does not change production CaptureIO. */
export const CAPTURE_STORAGE_LIMITS: Readonly<CaptureLimits> = Object.freeze({
  maxRecordBytes: 128 * 1024,
  maxDepth: 16,
  maxPendingRecords: 1000,
  maxPendingBytes: 8 * 1024 * 1024,
  maxShardBytes: 16 * 1024 * 1024,
  maxSessionBytes: 500 * 1024 * 1024,
  maxStorageBytes: 5 * 1024 ** 3,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxIdempotencyRequests: 1000,
})
export class CaptureStorageLimitsError extends Error {
  readonly code = 'INVALID_CAPTURE_LIMITS'
  constructor() {
    super('INVALID_CAPTURE_LIMITS')
  }
}
/** Shared worker/client boundary: detached complete limits, never broader caps. */
export function validateCaptureStorageLimits(input: unknown): Readonly<CaptureLimits> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new CaptureStorageLimitsError()
  const keys = Object.keys(CAPTURE_STORAGE_LIMITS) as Array<keyof CaptureLimits>
  if (Reflect.ownKeys(input).length !== keys.length) throw new CaptureStorageLimitsError()
  const output = {} as CaptureLimits
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'number' ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 1 ||
      descriptor.value > CAPTURE_STORAGE_LIMITS[key]
    )
      throw new CaptureStorageLimitsError()
    output[key] = descriptor.value
  }
  return Object.freeze(output)
}
export interface CaptureDatabaseIdentity {
  databaseId: string
  generation: number
  schemaVersion: 1
}
export interface CaptureCounterDelta {
  received: number
  saved: number
  dropped: number
  pending: number
  parseFailed: number
  redacted: number
  bytes: number
  originals?: Partial<OriginalEvidenceSummary>
}
export interface CaptureCommit {
  operationId: string
  sessionId: string
  expectedSequence: number
  record: AnalysisRecord
  recordLine: Uint8Array
  originalLine?: Uint8Array
  originalJson?: Uint8Array
  protobufBase64?: string
  shard: string
  nextOffset: number
  delta: CaptureCounterDelta
}
export interface CaptureCommitReceipt extends CaptureDatabaseIdentity {
  operationId: string
  inputDigest: string
  physicalPosition: number
  commitWatermark: number
  session: AnalysisSession
  reused: boolean
}
export interface CaptureSeek {
  upperPosition: number
  afterPosition?: number
}
export interface SessionSeek {
  upperOrder: number
  beforeOrder?: number
}
export interface CapturePosition {
  physicalPosition: number
  shard: string
  nextOffset: number
}
export interface CaptureStoredLine extends CapturePosition {
  record?: AnalysisRecord
  line: number
}
export interface CaptureLinePage {
  rows: CaptureStoredLine[]
  next?: CapturePosition
}
export interface CaptureSessionPage {
  rows: AnalysisSession[]
  upperOrder: number
  nextBefore?: number
}
export type CaptureFieldSummary = FieldSummary
export type CaptureScope = AnalysisScope
