import {
  analysisId,
  analysisInteger,
  analysisString,
  validateAnalysisScope,
  type AnalysisRecord,
  type AnalysisSession,
  type BusinessObservation,
  type CaptureLimits,
  type ReanalysisJob,
} from '../../../../shared/analysisRoom'
import { sanitizeBusinessPayload } from './BusinessPayload'
import { originalSummaryFromDisk } from './OriginalEvidence'

// These exact historical listener values are accepted without rewriting evidence.
const LEGACY_DISCONNECT_REASONS = new Set([
  'page-closed', 'reconnected', 'disconnected', 'target-changed',
])
export const validStoredReason = (value: unknown): value is string =>
  typeof value === 'string' && (/^[A-Z_]{1,128}$/.test(value) || LEGACY_DISCONNECT_REASONS.has(value))

/** Pure metadata projection; recovery/counter repair belongs to the storage owner. */
export function validateCaptureSession(raw: unknown): AnalysisSession {
  const value = raw as AnalysisSession
  analysisId(value.id)
  const scope = validateAnalysisScope(value.scope)
  if (
    !['collecting', 'stopping', 'completed', 'interrupted', 'storage-error'].includes(value.status) ||
    typeof value.complete !== 'boolean'
  ) throw new Error('invalid session')
  analysisInteger(value.createdAt)
  analysisInteger(value.bytes)
  analysisInteger(value.formatVersion, 1)
  for (const key of ['received', 'saved', 'dropped', 'pending', 'parseFailed', 'redacted'] as const)
    analysisInteger(value.counters[key])
  if (value.stoppedAt !== undefined) analysisInteger(value.stoppedAt)
  if (value.mappingVersion !== undefined) analysisInteger(value.mappingVersion, 1)
  if (value.roomId !== undefined) analysisString(value.roomId, 256)
  if (value.reason !== undefined && !validStoredReason(value.reason)) throw new Error('invalid reason')
  return {
    id: value.id,
    scope,
    status: value.status,
    complete: value.complete,
    createdAt: value.createdAt,
    bytes: value.bytes,
    formatVersion: value.formatVersion,
    counters: {
      received: value.counters.received,
      saved: value.counters.saved,
      dropped: value.counters.dropped,
      pending: value.counters.pending,
      parseFailed: value.counters.parseFailed,
      redacted: value.counters.redacted,
    },
    ...(value.stoppedAt === undefined ? {} : { stoppedAt: value.stoppedAt }),
    ...(value.mappingVersion === undefined ? {} : { mappingVersion: value.mappingVersion }),
    ...(value.roomId === undefined ? {} : { roomId: value.roomId }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.originals === undefined ? {} : { originals: originalSummaryFromDisk(value.originals) }),
  }
}

function boundedPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length > 1000 ||
    value.some(path => typeof path !== 'string' || Buffer.byteLength(path) > 4096)
  ) throw new Error('invalid diagnostic paths')
  return value
}

/** Shared by stored records, live admission and private-original recovery. */
export function validateObservationEnvelope(
  raw: unknown,
): Omit<BusinessObservation, 'data' | 'original' | 'originalFailureCode'> {
  const value = raw as BusinessObservation
  const scope = validateAnalysisScope(value.scope)
  analysisString(value.observationId, 256)
  analysisString(value.streamId, 256)
  analysisInteger(value.sequence)
  analysisInteger(value.receivedAt)
  analysisInteger(value.formatVersion, 1)
  if (typeof value.complete !== 'boolean') throw new Error('invalid completion')
  if (value.platformTime !== undefined) analysisInteger(value.platformTime)
  if (
    value.provenance !== undefined &&
    !['sdk-decoded', 'cdp-websocket-decoded', 'cdp-http-decoded', 'dom-observation'].includes(value.provenance)
  ) throw new Error('invalid provenance')
  if (value.failureCode !== undefined && !['PARSE_FAILED', 'PAYLOAD_LIMIT'].includes(value.failureCode))
    throw new Error('invalid failure code')
  for (const [key, max] of [
    ['sourceMessageId', 256], ['roomId', 256], ['businessType', 128],
  ] as const)
    if (value[key] !== undefined) analysisString(value[key], max)
  return {
    scope,
    observationId: value.observationId,
    streamId: value.streamId,
    sequence: value.sequence,
    receivedAt: value.receivedAt,
    formatVersion: value.formatVersion,
    complete: value.complete,
    removedPaths: boundedPaths(value.removedPaths),
    truncatedPaths: boundedPaths(value.truncatedPaths),
    ...(value.platformTime === undefined ? {} : { platformTime: value.platformTime }),
    ...(value.sourceMessageId === undefined ? {} : { sourceMessageId: value.sourceMessageId }),
    ...(value.roomId === undefined ? {} : { roomId: value.roomId }),
    ...(value.businessType === undefined ? {} : { businessType: value.businessType }),
    ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode }),
    ...(value.provenance === undefined ? {} : { provenance: value.provenance }),
  }
}

/**
 * Validate a parsed sanitized record. The reader/importer must separately enforce
 * maxRecordBytes on the original physical line, before JSON parsing. Re-encoding
 * this object cannot prove the original whitespace, UTF-8 bytes or framing size.
 */
export function validateCaptureRecord(
  raw: unknown,
  session: AnalysisSession,
  limits: CaptureLimits,
): AnalysisRecord {
  const value = raw as AnalysisRecord
  analysisId(session.id)
  if (
    value.sessionId !== session.id ||
    value.scope.accountId !== session.scope.accountId ||
    value.scope.platform !== session.scope.platform ||
    value.scope.source !== session.scope.source
  ) throw new Error('record scope')
  analysisInteger(value.recordSequence, 1)
  const envelope = validateObservationEnvelope(value)
  if (value.mappingVersion !== undefined) analysisInteger(value.mappingVersion, 1)
  const clean = sanitizeBusinessPayload(value.data, {
    maxBytes: limits.maxRecordBytes,
    maxDepth: limits.maxDepth,
  })
  return {
    ...envelope,
    sessionId: session.id,
    recordSequence: value.recordSequence,
    ...clean,
    complete: value.complete && clean.complete,
    removedPaths: [...envelope.removedPaths, ...clean.removedPaths],
    truncatedPaths: [...envelope.truncatedPaths, ...clean.truncatedPaths],
    ...(value.mappingVersion === undefined ? {} : { mappingVersion: value.mappingVersion }),
  }
}

/** Includes the UUID guard previously performed by the history directory reader. */
export function validateReanalysisJob(raw: unknown, jobId: string): ReanalysisJob {
  analysisId(jobId)
  const value = raw as ReanalysisJob
  if (value.id !== jobId || !['running', 'completed', 'failed'].includes(value.status))
    throw new Error('job identity/status')
  const scope = validateAnalysisScope(value.scope)
  analysisId(value.sessionId)
  analysisInteger(value.mappingVersion, 1)
  analysisInteger(value.createdAt)
  analysisInteger(value.received)
  analysisInteger(value.saved)
  if (value.saved > value.received) throw new Error('job counters')
  if (value.finishedAt !== undefined) analysisInteger(value.finishedAt)
  if (value.error !== undefined && !/^[A-Z_]{1,128}$/.test(value.error)) throw new Error('job error')
  return {
    id: jobId,
    scope,
    sessionId: value.sessionId,
    mappingVersion: value.mappingVersion,
    status: value.status,
    received: value.received,
    saved: value.saved,
    createdAt: value.createdAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}
