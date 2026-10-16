import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AnalysisRecord,
  AnalysisScope,
  AnalysisSession,
  CaptureLimits,
  FieldEntry,
  FieldSummary,
  JsonValue,
  OriginalEvidenceSummary,
} from '../../../../shared/analysisRoom'
import {
  analysisId,
  analysisInteger,
  analysisString,
  validateAnalysisScope,
} from '../../../../shared/analysisRoom'
import type {
  CaptureCommit,
  CaptureCommitReceipt,
  CaptureDatabaseIdentity,
  CapturePosition,
  CaptureSeek,
  CaptureSessionPage,
  CaptureStoredLine,
  SessionSeek,
} from './CaptureStorage'
import { CAPTURE_STORAGE_LIMITS, validateCaptureStorageLimits } from './CaptureStorage'
import {
  validateCaptureRecord,
  validateCaptureSession,
  validateObservationEnvelope,
} from './CaptureRecordValidation'
import { originalData } from './OriginalEvidence'

const MAX_OPERATION_ID = 256
const MAX_SHARD = 64
const MAX_EXAMPLE_BYTES = 256
const MAX_EXAMPLES = 3
const MAX_FIELD_PATHS = 1000
const MAX_PAGE = 100

export class CaptureWorkerError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function fail(code: string): never {
  throw new CaptureWorkerError(code)
}

function pointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM database_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO database_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

function databaseIdentity(db: DatabaseSync): CaptureDatabaseIdentity {
  const databaseId = readMeta(db, 'database_id'),
    generation = readMeta(db, 'generation')
  if (!databaseId || !generation || readMeta(db, 'schema_version') !== '1')
    fail('INVALID_DATABASE_METADATA')
  return {
    databaseId: analysisId(databaseId),
    generation: analysisInteger(Number(generation), 1),
    schemaVersion: 1,
  }
}

function scopeMatches(
  row: { account_id: string; platform: string; source: string },
  scope: AnalysisScope,
): boolean {
  return (
    row.account_id === scope.accountId &&
    row.platform === scope.platform &&
    row.source === scope.source
  )
}

function sessionRowToDto(row: Record<string, unknown>): AnalysisSession {
  const originals: OriginalEvidenceSummary = {
    file: 'originals.jsonl',
    received: Number(row.original_received),
    saved: Number(row.original_saved),
    dropped: Number(row.original_dropped),
    pending: Number(row.original_pending),
    bytes: Number(row.original_bytes),
    redacted: Number(row.original_redacted),
  }
  if (row.original_error !== null && row.original_error !== undefined)
    originals.error = String(row.original_error)
  return validateCaptureSession({
    id: String(row.id),
    scope: {
      accountId: String(row.account_id),
      platform: String(row.platform) as AnalysisScope['platform'],
      source: String(row.source) as AnalysisScope['source'],
    },
    status: String(row.status) as AnalysisSession['status'],
    complete: Number(row.complete) === 1,
    createdAt: Number(row.created_at),
    bytes: Number(row.bytes),
    formatVersion: Number(row.format_version),
    counters: {
      received: Number(row.received),
      saved: Number(row.saved),
      dropped: Number(row.dropped),
      pending: Number(row.pending),
      parseFailed: Number(row.parse_failed),
      redacted: Number(row.redacted),
    },
    ...(row.stopped_at === null || row.stopped_at === undefined
      ? {}
      : { stoppedAt: Number(row.stopped_at) }),
    ...(row.mapping_version === null || row.mapping_version === undefined
      ? {}
      : { mappingVersion: Number(row.mapping_version) }),
    ...(row.room_id === null || row.room_id === undefined ? {} : { roomId: String(row.room_id) }),
    ...(row.reason === null || row.reason === undefined ? {} : { reason: String(row.reason) }),
    ...(Number(row.has_originals) === 1 ? { originals } : {}),
  })
}

function loadSessionRow(
  db: DatabaseSync,
  scope: AnalysisScope,
  sessionId: string,
): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined
  if (!row || !scopeMatches(row as { account_id: string; platform: string; source: string }, scope))
    fail('SESSION_NOT_FOUND')
  return row
}

/** Caller owns BEGIN/COMMIT/ROLLBACK. Does not publish or open a transaction. */
export function insertCaptureSessionInTransaction(db: DatabaseSync, session: AnalysisSession, inputLimits: Readonly<CaptureLimits> = CAPTURE_STORAGE_LIMITS): void {
  const validated = validateCaptureSession(session)
  const limits = validateCaptureStorageLimits(inputLimits)
    databaseIdentity(db)
    const ordinal = analysisInteger(Number(readMeta(db, 'session_ordinal')) + 1, 1)
    const totalLogicalBytes = analysisInteger(
      Number(readMeta(db, 'total_logical_bytes')) + validated.bytes,
    )
    if (
      validated.bytes > limits.maxSessionBytes ||
      totalLogicalBytes > limits.maxStorageBytes
    )
      fail('STORAGE_LIMIT')
    const originals = validated.originals ?? {
      file: 'originals.jsonl' as const,
      received: 0,
      saved: 0,
      dropped: 0,
      pending: 0,
      bytes: 0,
      redacted: 0,
    }
    db.prepare(
      `INSERT INTO sessions(
      id, account_id, platform, source, ordinal, status, complete, created_at, stopped_at, room_id,
      format_version, mapping_version, reason, received, saved, dropped, pending, parse_failed, redacted, bytes,
      original_received, original_saved, original_dropped, original_pending, original_bytes, original_redacted, original_error,
      has_originals, live_sequence, field_complete
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      validated.id,
      validated.scope.accountId,
      validated.scope.platform,
      validated.scope.source,
      ordinal,
      validated.status,
      validated.complete ? 1 : 0,
      validated.createdAt,
      validated.stoppedAt ?? null,
      validated.roomId ?? null,
      validated.formatVersion,
      validated.mappingVersion ?? null,
      validated.reason ?? null,
      validated.counters.received,
      validated.counters.saved,
      validated.counters.dropped,
      validated.counters.pending,
      validated.counters.parseFailed,
      validated.counters.redacted,
      validated.bytes,
      originals.received,
      originals.saved,
      originals.dropped,
      originals.pending,
      originals.bytes,
      originals.redacted,
      originals.error ?? null,
      validated.originals === undefined ? 0 : 1,
      0,
      validated.complete ? 1 : 0,
    )
    writeMeta(db, 'session_ordinal', String(ordinal))
    writeMeta(db, 'total_logical_bytes', String(totalLogicalBytes))
}

export function insertCaptureSession(db: DatabaseSync, session: AnalysisSession): void {
  const validated = validateCaptureSession(session)
  db.exec('BEGIN IMMEDIATE')
  try {
    insertCaptureSessionInTransaction(db, validated)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
}

export function captureSession(
  db: DatabaseSync,
  scope: AnalysisScope,
  sessionId: string,
): AnalysisSession {
  const validatedScope = validateAnalysisScope(scope)
  analysisId(sessionId)
  const row = loadSessionRow(db, validatedScope, sessionId)
  return sessionRowToDto(row)
}

function stableJson(value: unknown): string {
  if (value === undefined) return '<absent>'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`
}

function canonicalDigest(input: CaptureCommit): string {
  const hash = createHash('sha256')
  const parts: Array<string | Uint8Array> = [
    input.operationId,
    input.sessionId,
    String(input.expectedSequence),
    input.shard,
    String(input.nextOffset),
    stableJson(input.delta),
    input.recordLine,
    input.originalLine ?? new Uint8Array(),
    input.originalJson ?? new Uint8Array(),
    input.protobufBase64 ?? '',
    stableJson(input.record),
  ]
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part
    hash.update(`${bytes.byteLength}:`).update(bytes)
  }
  return hash.digest('hex')
}

function validateShard(shard: string): void {
  if (typeof shard !== 'string' || shard.length > MAX_SHARD || !/^\d{6}\.jsonl$/.test(shard))
    fail('INVALID_SHARD')
}

function validateDelta(delta: CaptureCommit['delta']): void {
  function literal(input: unknown, allowed: string[]) {
    if (!isPlainObject(input)) fail('INVALID_DELTA')
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        fail('INVALID_DELTA')
    }
  }
  literal(delta, [
    'received',
    'saved',
    'dropped',
    'pending',
    'parseFailed',
    'redacted',
    'bytes',
    'originals',
  ])
  for (const key of [
    'received',
    'saved',
    'dropped',
    'pending',
    'parseFailed',
    'redacted',
    'bytes',
  ] as const)
    analysisInteger(delta[key])
  if (Object.hasOwn(delta, 'originals')) {
    literal(delta.originals, [
      'received',
      'saved',
      'dropped',
      'pending',
      'bytes',
      'redacted',
      'file',
      'error',
    ])
    if (delta.originals === undefined) fail('INVALID_DELTA')
    for (const key of ['received', 'saved', 'dropped', 'pending', 'bytes', 'redacted'] as const)
      if (Object.hasOwn(delta.originals!, key)) analysisInteger(delta.originals![key])
    if (
      Object.keys(delta.originals).some(
        key =>
          ![
            'received',
            'saved',
            'dropped',
            'pending',
            'bytes',
            'redacted',
            'file',
            'error',
          ].includes(key),
      )
    )
      fail('INVALID_DELTA')
    if (Object.hasOwn(delta.originals, 'file') && delta.originals.file !== 'originals.jsonl')
      fail('INVALID_DELTA')
    if (
      Object.hasOwn(delta.originals, 'error') &&
      (typeof delta.originals.error !== 'string' || !/^[A-Z_]{1,128}$/.test(delta.originals.error))
    )
      fail('INVALID_DELTA')
  }
}

function validateRecordLine(input: CaptureCommit, limits: CaptureLimits): void {
  const line = input.recordLine
  if (
    !(line instanceof Uint8Array) ||
    line.byteLength === 0 ||
    line.byteLength > limits.maxRecordBytes
  )
    fail('INVALID_RECORD_LINE')
  if (line[line.byteLength - 1] !== 0x0a) fail('INVALID_RECORD_LINE')
  if (line.subarray(0, line.byteLength - 1).includes(0x0a)) fail('INVALID_RECORD_LINE')
  const body = line.subarray(0, line.byteLength - 1)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    fail('INVALID_RECORD_LINE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('INVALID_RECORD_LINE')
  }
  if (!isPlainObject(parsed)) fail('INVALID_RECORD_LINE')
  if (stableJson(parsed) !== stableJson(input.record)) fail('RECORD_LINE_MISMATCH')
}

function validateNativePair(
  input: CaptureCommit,
  limits: CaptureLimits,
): { originalJson: Uint8Array; originalLine: Uint8Array } | undefined {
  const hasLine = input.originalLine !== undefined
  const hasJson = input.originalJson !== undefined
  if (hasLine !== hasJson) fail('INVALID_NATIVE_PAIR')
  if (!hasLine) {
    if (input.protobufBase64 !== undefined) fail('INVALID_NATIVE_PAIR')
    return undefined
  }
  const originalLine = input.originalLine!
  const originalJson = input.originalJson!
  if (
    !(originalLine instanceof Uint8Array) ||
    originalLine.byteLength === 0 ||
    originalLine.byteLength > limits.maxRecordBytes
  )
    fail('INVALID_NATIVE_PAIR')
  if (
    !(originalJson instanceof Uint8Array) ||
    originalJson.byteLength === 0 ||
    originalJson.byteLength > limits.maxRecordBytes
  )
    fail('INVALID_NATIVE_PAIR')
  if (originalLine[originalLine.byteLength - 1] !== 0x0a) fail('INVALID_NATIVE_PAIR')
  if (originalLine.subarray(0, originalLine.byteLength - 1).includes(0x0a))
    fail('INVALID_NATIVE_PAIR')
  let envelopeText: string
  try {
    envelopeText = new TextDecoder('utf-8', { fatal: true }).decode(
      originalLine.subarray(0, originalLine.byteLength - 1),
    )
  } catch {
    fail('INVALID_NATIVE_PAIR')
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(envelopeText)
  } catch {
    fail('INVALID_NATIVE_PAIR')
  }
  if (!isPlainObject(envelope)) fail('INVALID_NATIVE_PAIR')
  if (envelope.mappingVersion !== undefined) analysisInteger(envelope.mappingVersion, 1)
  let jsonText: string
  try {
    jsonText = new TextDecoder('utf-8', { fatal: true }).decode(originalJson)
  } catch {
    fail('INVALID_NATIVE_PAIR')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(jsonText)
  } catch {
    fail('INVALID_NATIVE_PAIR')
  }
  const evidence = {
    format: envelope.format,
    provenance: envelope.provenance,
    complete: envelope.complete,
    json: jsonText,
    ...(envelope.protobufBase64 === undefined ? {} : { protobufBase64: envelope.protobufBase64 }),
    ...(envelope.removedPaths === undefined ? {} : { removedPaths: envelope.removedPaths }),
  }
  try {
    originalData(evidence as never, limits.maxRecordBytes, limits.maxDepth)
  } catch {
    fail('INVALID_NATIVE_PAIR')
  }
  if (stableJson(decoded) !== stableJson(envelope.data)) fail('INVALID_NATIVE_PAIR')
  if (input.protobufBase64 !== envelope.protobufBase64) fail('INVALID_NATIVE_PAIR')
  return { originalJson, originalLine }
}

function validateNativeEnvelopePairing(
  input: CaptureCommit,
  envelope: Record<string, unknown>,
  session: AnalysisSession,
): number {
  const validated = validateObservationEnvelope(envelope)
  if (
    envelope.mappingVersion !== undefined &&
    input.record.mappingVersion !== undefined &&
    envelope.mappingVersion !== input.record.mappingVersion
  )
    fail('INVALID_NATIVE_PAIR')
  for (const key of Object.keys(validated) as Array<keyof typeof validated>) {
    if (['complete', 'removedPaths', 'truncatedPaths'].includes(key)) continue
    if (key === 'provenance' && input.record.provenance === undefined) continue
    if (stableJson(validated[key]) !== stableJson(input.record[key])) fail('INVALID_NATIVE_PAIR')
  }
  for (const key of [
    'platformTime',
    'sourceMessageId',
    'roomId',
    'businessType',
    'failureCode',
    'provenance',
  ] as const)
    if (
      !(key === 'provenance' && input.record.provenance === undefined) &&
      stableJson(envelope[key]) !== stableJson(input.record[key])
    )
      fail('INVALID_NATIVE_PAIR')
  const allowed = new Set([
    ...Object.keys(validated),
    'sessionId',
    'recordSequence',
    'originalSequence',
    'format',
    'data',
    'protobufBase64',
    'mappingVersion',
  ])
  if (Object.keys(envelope).some(key => !allowed.has(key))) fail('INVALID_NATIVE_PAIR')
  if (envelope.sessionId !== session.id) fail('INVALID_NATIVE_PAIR')
  const scope = envelope.scope as Record<string, unknown> | undefined
  if (
    !scope ||
    scope.accountId !== session.scope.accountId ||
    scope.platform !== session.scope.platform ||
    scope.source !== session.scope.source
  )
    fail('INVALID_NATIVE_PAIR')
  if (envelope.recordSequence !== input.record.recordSequence) fail('INVALID_NATIVE_PAIR')
  if (envelope.observationId !== input.record.observationId) fail('INVALID_NATIVE_PAIR')
  if (!Number.isSafeInteger(envelope.originalSequence) || (envelope.originalSequence as number) < 1)
    fail('INVALID_NATIVE_PAIR')
  return envelope.originalSequence as number
}

function parseNativeEnvelope(originalLine: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    originalLine.subarray(0, originalLine.byteLength - 1),
  )
  const parsed = JSON.parse(text)
  if (!isPlainObject(parsed)) fail('INVALID_NATIVE_PAIR')
  return parsed
}

function updateFieldEntries(db: DatabaseSync, sessionId: string, data: JsonValue): boolean {
  const stack: Array<{ value: JsonValue; path: string }> = [{ value: data, path: '' }]
  let complete = true
  let paths = Number(
    db.prepare('SELECT count(*) AS n FROM field_entries WHERE session_id=?').get(sessionId)!.n,
  )
  const get = db.prepare(
    'SELECT count, types, examples FROM field_entries WHERE session_id=? AND path=?',
  )
  const update = db.prepare(
    'UPDATE field_entries SET count=?, types=?, examples=? WHERE session_id=? AND path=?',
  )
  const insert = db.prepare(
    'INSERT INTO field_entries(session_id,path,count,types,examples) VALUES(?,?,?,?,?)',
  )
  while (stack.length) {
    const { value, path } = stack.pop()!
    if (path) {
      if (Buffer.byteLength(path) > 4096) {
        complete = false
        continue
      }
      const existing = get.get(sessionId, path) as
        | { count: number; types: string; examples: string }
        | undefined
      if (!existing && paths >= MAX_FIELD_PATHS) {
        complete = false
        continue
      }
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      const types = new Set<string>(existing ? JSON.parse(existing.types) : [])
      types.add(type)
      const examples: JsonValue[] = existing ? JSON.parse(existing.examples) : []
      if ((value === null || typeof value !== 'object') && examples.length < MAX_EXAMPLES) {
        let example = value
        if (typeof value === 'string') {
          let small = ''
          for (const character of value) {
            if (Buffer.byteLength(JSON.stringify(small + character)) > MAX_EXAMPLE_BYTES) break
            small += character
          }
          example = small
        }
        if (!examples.some(prior => stableJson(prior) === stableJson(example)))
          examples.push(example)
      }
      if (existing)
        update.run(
          analysisInteger(Number(existing.count) + 1, 1),
          JSON.stringify([...types]),
          JSON.stringify(examples),
          sessionId,
          path,
        )
      else {
        insert.run(sessionId, path, 1, JSON.stringify([...types]), JSON.stringify(examples))
        paths++
      }
    }
    if (value && typeof value === 'object')
      for (const key of Object.keys(value))
        stack.push({
          value: (value as Record<string, JsonValue>)[key],
          path: `${path}/${pointer(key)}`,
        })
  }
  return complete
}

export function commitCaptureTransaction(
  db: DatabaseSync,
  input: CaptureCommit,
  requestedLimits: Readonly<CaptureLimits> = CAPTURE_STORAGE_LIMITS,
): CaptureCommitReceipt {
  const limits = validateCaptureStorageLimits(requestedLimits)
  if (!input || typeof input !== 'object') fail('INVALID_INPUT')
  analysisString(input.operationId, MAX_OPERATION_ID)
  analysisId(input.sessionId)
  analysisInteger(input.expectedSequence)
  analysisInteger(input.nextOffset)
  validateShard(input.shard)
  validateDelta(input.delta)
  // Existing exact receipts describe committed facts, independent of later
  // reductions. Default hard caps still bound validation before reconciliation.
  validateRecordLine(input, CAPTURE_STORAGE_LIMITS)
  const native = validateNativePair(input, CAPTURE_STORAGE_LIMITS)
  const digest = canonicalDigest(input)
  db.exec('BEGIN IMMEDIATE')
  try {
    const identity = databaseIdentity(db)
    const existing = db
      .prepare(
        'SELECT input_digest, physical_position, commit_watermark, session_snapshot FROM operation_receipts WHERE operation_id = ?',
      )
      .get(input.operationId) as
      | {
          input_digest: string
          physical_position: number
          commit_watermark: number
          session_snapshot: string
        }
      | undefined
    if (existing) {
      if (existing.input_digest !== digest) fail('OPERATION_CONFLICT')
      const session = validateCaptureSession(JSON.parse(existing.session_snapshot))
      const receipt: CaptureCommitReceipt = {
        ...identity,
        operationId: input.operationId,
        inputDigest: existing.input_digest,
        physicalPosition: Number(existing.physical_position),
        commitWatermark: Number(existing.commit_watermark),
        session,
        reused: true,
      }
      db.exec('COMMIT')
      return receipt
    }

    const sessionRow = loadSessionRow(
      db,
      validateAnalysisScope(input.record.scope),
      input.sessionId,
    )
    const session = sessionRowToDto(sessionRow)
    validateRecordLine(input, limits)
    validateNativePair(input, limits)
    if (
      session.scope.accountId !== input.record.scope.accountId ||
      session.scope.platform !== input.record.scope.platform ||
      session.scope.source !== input.record.scope.source
    )
      fail('SCOPE_MISMATCH')
    if (input.record.sessionId !== session.id) fail('SCOPE_MISMATCH')
    if (
      input.expectedSequence !== Number(sessionRow.live_sequence) ||
      input.record.recordSequence !== input.expectedSequence + 1
    )
      fail('STALE_SEQUENCE')
    if (
      !['collecting', 'stopping'].includes(session.status) ||
      input.record.formatVersion !== session.formatVersion ||
      (session.roomId && input.record.roomId && session.roomId !== input.record.roomId)
    )
      fail('SESSION_STATE_MISMATCH')

    const validatedRecord = validateCaptureRecord(input.record, session, limits)
    if (stableJson(validatedRecord) !== stableJson(input.record)) fail('UNSANITIZED_RECORD')
    let originalSequence: number | undefined
    let originalEnvelope: Record<string, unknown> | undefined
    if (native) {
      originalEnvelope = parseNativeEnvelope(native.originalLine)
      originalSequence = validateNativeEnvelopePairing(input, originalEnvelope, session)
      const expectedOriginal =
        Number(sessionRow.original_received) + (input.delta.originals?.received ?? 0)
      if (originalSequence !== expectedOriginal) fail('INVALID_NATIVE_PAIR')
    }
    const delta = input.delta,
      originals = delta.originals
    const originalReceived = originals?.received ?? 0
    if (
      delta.received !== 1 ||
      delta.saved !== 1 ||
      delta.dropped !== 0 ||
      delta.pending !== 0 ||
      delta.bytes !== input.recordLine.byteLength + (native?.originalLine.byteLength ?? 0) ||
      delta.parseFailed !== (validatedRecord.failureCode === 'PARSE_FAILED' ? 1 : 0) ||
      delta.redacted !== validatedRecord.removedPaths.length
    )
      fail('INVALID_DELTA')
    if (
      (originals?.saved ?? 0) !== (native ? 1 : 0) ||
      (originals?.bytes ?? 0) !== (native?.originalLine.byteLength ?? 0) ||
      (originals?.pending ?? 0) !== 0 ||
      (originals?.redacted ?? 0) !==
        ((originalEnvelope?.removedPaths as string[] | undefined)?.length ?? 0) ||
      (native
        ? originalReceived !== 1 || (originals?.dropped ?? 0) !== 0
        : originalReceived > 1 || (originals?.dropped ?? 0) !== originalReceived)
    )
      fail('INVALID_DELTA')
    for (const [column, increment] of Object.entries({
      received: delta.received,
      saved: delta.saved,
      dropped: delta.dropped,
      pending: delta.pending,
      parse_failed: delta.parseFailed,
      redacted: delta.redacted,
      bytes: delta.bytes,
      original_received: originalReceived,
      original_saved: originals?.saved ?? 0,
      original_dropped: originals?.dropped ?? 0,
      original_pending: originals?.pending ?? 0,
      original_bytes: originals?.bytes ?? 0,
      original_redacted: originals?.redacted ?? 0,
    }))
      analysisInteger(Number(sessionRow[column]) + increment)
    if (Number(sessionRow.bytes) + delta.bytes > limits.maxSessionBytes) fail('SESSION_LIMIT')
    const totalLogicalBytes = analysisInteger(
      Number(readMeta(db, 'total_logical_bytes')) + delta.bytes,
    )
    if (totalLogicalBytes > limits.maxStorageBytes) fail('STORAGE_LIMIT')
    const priorShard = sessionRow.last_shard as string | null
    if (
      input.nextOffset < input.recordLine.byteLength ||
      input.nextOffset > limits.maxShardBytes ||
      (priorShard !== null &&
        (input.shard < priorShard ||
          (input.shard === priorShard &&
            input.nextOffset < Number(sessionRow.last_offset) + input.recordLine.byteLength)))
    )
      fail('INVALID_OFFSET')
    const lineNumber =
      input.shard === priorShard ? analysisInteger(Number(sessionRow.last_line) + 1, 1) : 1
    const watermark = analysisInteger(Number(readMeta(db, 'commit_watermark')) + 1, 1)
    const positionRow = db
      .prepare('SELECT COALESCE(MAX(physical_position), 0) AS n FROM capture_rows')
      .get() as { n: number }
    const physicalPosition = analysisInteger(Number(positionRow.n) + 1, 1)
    db.prepare(
      `INSERT INTO capture_rows(
        physical_position, session_id, account_id, platform, source, record_sequence, validation_status,
        record_line, received_at, format_version, provenance, complete, shard, line_number, next_offset, source_id, source_offset
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      physicalPosition,
      session.id,
      session.scope.accountId,
      session.scope.platform,
      session.scope.source,
      validatedRecord.recordSequence,
      'accepted',
      input.recordLine,
      validatedRecord.receivedAt,
      validatedRecord.formatVersion,
      validatedRecord.provenance ?? null,
      validatedRecord.complete ? 1 : 0,
      input.shard,
      lineNumber,
      input.nextOffset,
      null,
      null,
    )
    if (native) {
      const sha = createHash('sha256').update(native.originalJson).digest('hex')
      db.prepare(
        'INSERT INTO original_rows(physical_position, session_id, original_sequence, original_line, original_json, original_json_sha256, protobuf_base64) VALUES(?,?,?,?,?,?,?)',
      ).run(
        physicalPosition,
        session.id,
        originalSequence!,
        native.originalLine,
        native.originalJson,
        sha,
        input.protobufBase64 ?? null,
      )
    }
    const updatedFields = updateFieldEntries(db, session.id, validatedRecord.data)
    const complete =
      session.complete &&
      validatedRecord.complete &&
      (!originalEnvelope || originalEnvelope.complete === true) &&
      (originals?.dropped ?? 0) === 0
    const fieldComplete =
      Number(sessionRow.field_complete) === 1 && updatedFields && validatedRecord.complete
    const publication = db
      .prepare(
        `UPDATE sessions SET
        received = received + ?, saved = saved + ?, dropped = dropped + ?, pending = pending + ?,
        parse_failed = parse_failed + ?, redacted = redacted + ?, bytes = bytes + ?,
        original_received = original_received + ?, original_saved = original_saved + ?,
        original_dropped = original_dropped + ?, original_pending = original_pending + ?,
        original_bytes = original_bytes + ?, original_redacted = original_redacted + ?,
        live_sequence = live_sequence + 1, field_complete = ?, complete = ?, has_originals = ?,
        original_error = ?, last_shard = ?, last_line = ?, last_offset = ?, room_id = COALESCE(room_id,?)
      WHERE id = ? AND live_sequence = ?`,
      )
      .run(
        delta.received,
        delta.saved,
        delta.dropped,
        delta.pending,
        delta.parseFailed,
        delta.redacted,
        delta.bytes,
        originals?.received ?? 0,
        originals?.saved ?? 0,
        originals?.dropped ?? 0,
        originals?.pending ?? 0,
        originals?.bytes ?? 0,
        originals?.redacted ?? 0,
        fieldComplete ? 1 : 0,
        complete ? 1 : 0,
        Number(sessionRow.has_originals) === 1 || originalReceived > 0 ? 1 : 0,
        originals?.error ??
          (originalEnvelope?.complete === false
            ? 'ORIGINAL_REDACTED'
            : (sessionRow.original_error as string | null)),
        input.shard,
        lineNumber,
        input.nextOffset,
        validatedRecord.roomId ?? null,
        session.id,
        input.expectedSequence,
      )
    if (Number(publication.changes) !== 1) fail('STALE_SEQUENCE')
    const updatedRow = loadSessionRow(db, session.scope, session.id)
    const updatedSession = sessionRowToDto(updatedRow)
    db.prepare(
      'INSERT INTO operation_receipts(operation_id, input_digest, physical_position, commit_watermark, session_snapshot) VALUES(?,?,?,?,?)',
    ).run(input.operationId, digest, physicalPosition, watermark, JSON.stringify(updatedSession))
    writeMeta(db, 'commit_watermark', String(watermark))
    writeMeta(db, 'total_logical_bytes', String(totalLogicalBytes))
    const receipt: CaptureCommitReceipt = {
      ...identity,
      operationId: input.operationId,
      inputDigest: digest,
      physicalPosition,
      commitWatermark: watermark,
      session: updatedSession,
      reused: false,
    }
    db.exec('COMMIT')
    return receipt
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
}

export function captureRecordPage(
  db: DatabaseSync,
  scope: AnalysisScope,
  sessionId: string,
  limit: number,
  seek: CaptureSeek,
): { rows: CaptureStoredLine[]; next?: CapturePosition } {
  const validatedScope = validateAnalysisScope(scope)
  analysisString(sessionId, 256)
  analysisInteger(limit, 1, MAX_PAGE)
  analysisInteger(seek.upperPosition)
  if (seek.afterPosition !== undefined) analysisInteger(seek.afterPosition)
  const session = captureSession(db, validatedScope, sessionId)
  const after = seek.afterPosition ?? 0
  const rows = db
    .prepare(
      `SELECT physical_position, record_line, shard, next_offset, line_number
     FROM capture_rows
     WHERE session_id = ? AND account_id = ? AND platform = ? AND source = ?
       AND physical_position > ? AND physical_position <= ?
     ORDER BY physical_position ASC
     LIMIT ?`,
    )
    .all(
      session.id,
      validatedScope.accountId,
      validatedScope.platform,
      validatedScope.source,
      after,
      seek.upperPosition,
      limit + 1,
    ) as Array<{
    physical_position: number
    record_line: Uint8Array
    shard: string
    next_offset: number
    line_number: number
  }>
  const page = rows.slice(0, limit)
  const result: CaptureStoredLine[] = page.map(row => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(row.record_line)
    const parsed = JSON.parse(text)
    const record = validateCaptureRecord(parsed, session, CAPTURE_STORAGE_LIMITS)
    return {
      physicalPosition: Number(row.physical_position),
      shard: String(row.shard),
      nextOffset: Number(row.next_offset),
      line: Number(row.line_number),
      record,
    }
  })
  const next: CapturePosition | undefined =
    rows.length > limit
      ? {
          physicalPosition: Number(page[page.length - 1].physical_position),
          shard: String(page[page.length - 1].shard),
          nextOffset: Number(page[page.length - 1].next_offset),
        }
      : undefined
  return next ? { rows: result, next } : { rows: result }
}

export function captureFieldSummary(
  db: DatabaseSync,
  scope: AnalysisScope,
  sessionId: string,
): FieldSummary {
  const validatedScope = validateAnalysisScope(scope)
  analysisString(sessionId, 256)
  const session = captureSession(db, validatedScope, sessionId)
  const rows = db
    .prepare(
      'SELECT path, count, types, examples FROM field_entries WHERE session_id = ? ORDER BY path ASC LIMIT 1001',
    )
    .all(session.id) as Array<{
    path: string
    count: number
    types: string
    examples: string
  }>
  if (rows.length > MAX_FIELD_PATHS) fail('INVALID_FIELD_SUMMARY')
  const fields: FieldEntry[] = rows.map(row => ({
    path: String(row.path),
    count: Number(row.count),
    types: JSON.parse(String(row.types)) as string[],
    examples: JSON.parse(String(row.examples)) as JsonValue[],
  }))
  const completeRow = db
    .prepare('SELECT field_complete FROM sessions WHERE id = ?')
    .get(session.id) as { field_complete: number }
  return { fields, complete: Number(completeRow.field_complete) === 1, badLines: 0 }
}

export function captureSessionPage(
  db: DatabaseSync,
  scope: AnalysisScope,
  limit: number,
  seek?: SessionSeek,
): CaptureSessionPage {
  const validatedScope = validateAnalysisScope(scope)
  analysisInteger(limit, 1, MAX_PAGE)
  const upperOrder = seek?.upperOrder ?? Number(readMeta(db, 'session_ordinal') ?? '0')
  const beforeOrder = seek?.beforeOrder ?? upperOrder + 1
  analysisInteger(upperOrder)
  analysisInteger(beforeOrder)
  const rows = db
    .prepare(
      `SELECT * FROM sessions
     WHERE account_id = ? AND platform = ? AND source = ? AND ordinal <= ? AND ordinal < ?
     ORDER BY ordinal DESC
     LIMIT ?`,
    )
    .all(
      validatedScope.accountId,
      validatedScope.platform,
      validatedScope.source,
      upperOrder,
      beforeOrder,
      limit + 1,
    ) as Array<Record<string, unknown>>
  const page = rows.slice(0, limit)
  const result = page.map(sessionRowToDto)
  const nextBefore = rows.length > limit ? Number(page[page.length - 1].ordinal) : undefined
  return nextBefore === undefined
    ? { rows: result, upperOrder }
    : { rows: result, upperOrder, nextBefore }
}
