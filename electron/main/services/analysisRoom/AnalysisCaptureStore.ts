import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  AnalysisError,
  type AnalysisErrorCode,
  type AnalysisRecord,
  type AnalysisScope,
  type AnalysisSession,
  type AppendReceipt,
  analysisId,
  analysisInteger,
  analysisString,
  type BusinessObservation,
  type CaptureLimits,
  type ReanalysisJob,
  type RecoverySummary,
  validateAnalysisScope,
} from '../../../../shared/analysisRoom'
import { sanitizeBusinessPayload } from './BusinessPayload'
import { CaptureBudget } from './CaptureBudget'
import { type CaptureHandle, type CaptureIO, captureLines, NODE_CAPTURE_IO } from './CaptureIO'
import { emptyOriginalSummary, originalData, originalSummaryFromDisk } from './OriginalEvidence'

export { type CaptureIO, NODE_CAPTURE_IO } from './CaptureIO'

export const DEFAULT_CAPTURE_LIMITS: Readonly<CaptureLimits> = Object.freeze({
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
interface SessionState {
  session: AnalysisSession
  tail: Promise<void>
  finish?: Promise<AnalysisSession>
  handle?: CaptureHandle
  originalHandle?: CaptureHandle
  shard: number
  shardBytes: number
  pendingBytes: number
  reservedTerminal: number
  sequence: number
}
export interface CaptureRequest {
  requestId: string
  digest: string
  action: 'start' | 'stop' | 'reanalyze'
  createdAt: number
  status: 'inflight' | 'terminal'
  sessionId?: string
  result?: AnalysisSession
  jobId?: string
  jobResult?: ReanalysisJob
  error?: { code: AnalysisErrorCode; message: string; retryable: boolean }
}
export interface StoredLine {
  record?: AnalysisRecord
  shard: string
  line: number
  nextOffset: number
}
const TERMINAL_RESERVATION = 4096
// AccountSession historically forwarded these internal listener reasons verbatim.
// Accept only those known legacy values on recovery; keep archived bytes intact.
const LEGACY_DISCONNECT_REASONS = new Map([
  ['page-closed', 'PAGE_CLOSED'],
  ['reconnected', 'RECONNECTED'],
  ['disconnected', 'DISCONNECTED'],
  ['target-changed', 'TARGET_CHANGED'],
])
const validStoredReason = (value: unknown): value is string =>
  typeof value === 'string' && (/^[A-Z_]{1,128}$/.test(value) || LEGACY_DISCONNECT_REASONS.has(value))
export function sameAnalysisScope(a: AnalysisScope, b: AnalysisScope): boolean {
  return a.accountId === b.accountId && a.platform === b.platform && a.source === b.source
}

function sessionFromDisk(value: AnalysisSession): AnalysisSession {
  analysisId(value.id)
  const scope = validateAnalysisScope(value.scope)
  if (
    !['collecting', 'stopping', 'completed', 'interrupted', 'storage-error'].includes(
      value.status,
    ) ||
    typeof value.complete !== 'boolean'
  )
    throw new Error('invalid session')
  analysisInteger(value.createdAt)
  analysisInteger(value.bytes)
  analysisInteger(value.formatVersion, 1)
  for (const key of ['received', 'saved', 'dropped', 'pending', 'parseFailed', 'redacted'] as const)
    analysisInteger(value.counters[key])
  if (value.stoppedAt !== undefined) analysisInteger(value.stoppedAt)
  if (value.mappingVersion !== undefined) analysisInteger(value.mappingVersion, 1)
  if (value.roomId !== undefined) analysisString(value.roomId, 256)
  if (value.reason !== undefined && !validStoredReason(value.reason))
    throw new Error('invalid reason')
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
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(path => typeof path !== 'string' || Buffer.byteLength(path) > 4096)
  )
    throw new Error('invalid diagnostic paths')
  return value
}

function observationEnvelope(value: BusinessObservation): Omit<BusinessObservation, 'data' | 'original' | 'originalFailureCode'> {
  const scope = validateAnalysisScope(value.scope)
  analysisString(value.observationId, 256)
  analysisString(value.streamId, 256)
  analysisInteger(value.sequence)
  analysisInteger(value.receivedAt)
  analysisInteger(value.formatVersion, 1)
  if (typeof value.complete !== 'boolean') throw new Error('invalid completion')
  if (value.platformTime !== undefined) analysisInteger(value.platformTime)
  if (value.provenance !== undefined && !['sdk-decoded', 'cdp-websocket-decoded', 'cdp-http-decoded', 'dom-observation'].includes(value.provenance))
    throw new Error('invalid provenance')
  if (
    value.failureCode !== undefined &&
    !['PARSE_FAILED', 'PAYLOAD_LIMIT'].includes(value.failureCode)
  )
    throw new Error('invalid failure code')
  for (const [key, max] of [
    ['sourceMessageId', 256],
    ['roomId', 256],
    ['businessType', 128],
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

export class AnalysisCaptureStore {
  readonly root: string
  readonly limits: CaptureLimits
  readonly io: CaptureIO
  readonly budget: CaptureBudget
  private now: () => number
  private states = new Map<string, SessionState>()
  private recovery?: Promise<RecoverySummary>
  private recoverySummary?: RecoverySummary
  private metadataTail: Promise<void> = Promise.resolve()
  private listeners = new Set<(session: AnalysisSession) => void>()
  private requests = new Map<string, CaptureRequest[]>()
  private sessionOrder = new Map<string, number>()
  private nextSessionOrder = 0
  private accountMutations = new Map<string, Promise<void>>()
  private configurationTail = Promise.resolve()

  constructor(options: {
    root: string
    now?: () => number
    limits?: Partial<CaptureLimits>
    io?: CaptureIO
  }) {
    if (!isAbsolute(options.root))
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '分析目录必须是绝对路径')
    this.root = resolve(options.root)
    this.limits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits }
    for (const key of Object.keys(this.limits) as Array<keyof CaptureLimits>) {
      if (
        !Object.hasOwn(DEFAULT_CAPTURE_LIMITS, key) ||
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > DEFAULT_CAPTURE_LIMITS[key]
      ) {
        throw new AnalysisError('ANALYSIS_INVALID_INPUT', '采集上限只能降低且必须为正整数')
      }
    }
    this.io = options.io ?? NODE_CAPTURE_IO
    this.now = options.now ?? Date.now
    this.budget = new CaptureBudget(this.limits)
  }
  onChanged(listener: (session: AnalysisSession) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  recoveryHealth(): { healthy: boolean; errorCodes: string[] } {
    return {
      healthy: !this.recoverySummary?.errors.length,
      errorCodes: [...new Set(this.recoverySummary?.errors.map(error => error.code) ?? [])].slice(
        0,
        20,
      ),
    }
  }
  assertHealthy(): void {
    if (!this.recoveryHealth().healthy)
      throw new AnalysisError(
        'ANALYSIS_STORAGE_FAILED',
        '分析证据恢复失败；已保留文件，写入已暂停，请检查存储',
        false,
      )
  }
  private changed(state: SessionState): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(state.session))
      } catch {
        /* Independent subscribers. */
      }
    }
  }
  private directory(id: string): string {
    return join(this.root, 'sessions', analysisId(id))
  }
  private metaFile(id: string): string {
    return join(this.directory(id), 'metadata.json')
  }
  private requestFile(accountId: string): string {
    return join(
      this.root,
      'requests',
      `${createHash('sha256').update(accountId).digest('hex')}.json`,
    )
  }
  async safePath(file: string): Promise<void> {
    const path = resolve(file)
    const within = relative(this.root, path)
    if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '分析路径超出存储目录')
    let current = this.root
    for (const part of [undefined, ...within.split(sep)]) {
      if (part !== undefined) current = join(current, part)
      const kind = await this.io.kind(current)
      if (kind === 'link' || kind === 'other')
        throw new AnalysisError('ANALYSIS_INVALID_INPUT', '分析路径不允许链接或特殊文件')
    }
  }
  async writeMetadata(
    file: string,
    value: unknown,
    credit = 0,
    beforeCommit?: () => void,
  ): Promise<void> {
    const work = this.metadataTail.then(async () => {
      this.assertHealthy()
      await this.safePath(file)
      const text = `${JSON.stringify(value)}\n`
      const bytes = Buffer.byteLength(text)
      const release = this.budget.reserveMetadataWrite(bytes, credit)
      try {
        await this.io.atomic(file, text, beforeCommit)
        this.budget.committedMetadata(file, bytes)
      } catch (error) {
        // An unsuccessful rename may leave both the old file and its temporary evidence.
        for (const name of await this.io.list(dirname(file)).catch(() => []))
          if (name === basename(file) || name.startsWith(`${basename(file)}.pending-`)) {
            const evidence = join(dirname(file), name)
            if ((await this.io.kind(evidence)) === 'file')
              this.budget.committedMetadata(evidence, await this.io.size(evidence))
          }
        throw error
      } finally {
        release()
      }
    })
    this.metadataTail = work.catch(() => {})
    return work
  }
  mutateAccount<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const promise = (this.accountMutations.get(accountId) ?? Promise.resolve()).then(work)
    const tail = promise.then(
      () => {},
      () => {},
    )
    this.accountMutations.set(accountId, tail)
    tail.finally(() => {
      if (this.accountMutations.get(accountId) === tail) this.accountMutations.delete(accountId)
    })
    return promise
  }
  mutateConfiguration<T>(work: () => Promise<T>): Promise<T> {
    const promise = this.configurationTail.then(() => {
      this.assertHealthy()
      return work()
    })
    this.configurationTail = promise.then(
      () => {},
      () => {},
    )
    return promise
  }
  private async saveState(state: SessionState, terminal = false): Promise<void> {
    await this.writeMetadata(
      this.metaFile(state.session.id),
      { ...state.session, createdSequence: this.sessionOrder.get(state.session.id) },
      terminal ? state.reservedTerminal : 0,
    )
  }
  async create(
    scope: AnalysisScope,
    metadata: { formatVersion: number; mappingVersion?: number; roomId?: string },
  ): Promise<AnalysisSession> {
    validateAnalysisScope(scope)
    analysisInteger(metadata.formatVersion, 1)
    await this.recover()
    this.assertHealthy()
    if (
      [...this.states.values()].some(
        state =>
          state.session.scope.accountId === scope.accountId &&
          ['collecting', 'stopping'].includes(state.session.status),
      )
    ) {
      throw new AnalysisError('ANALYSIS_REQUEST_CONFLICT', '该账号已在采集')
    }
    this.budget.reserveTerminal(TERMINAL_RESERVATION)
    const session: AnalysisSession = {
      id: randomUUID(),
      scope: { ...scope },
      status: 'collecting',
      complete: true,
      createdAt: this.now(),
      formatVersion: metadata.formatVersion,
      ...(metadata.mappingVersion === undefined ? {} : { mappingVersion: metadata.mappingVersion }),
      ...(metadata.roomId ? { roomId: metadata.roomId.slice(0, 256) } : {}),
      counters: { received: 0, saved: 0, dropped: 0, pending: 0, parseFailed: 0, redacted: 0 },
      bytes: 0,
      ...(scope.platform === 'tiktok' ? { originals: emptyOriginalSummary() } : {}),
    }
    const state: SessionState = {
      session,
      tail: Promise.resolve(),
      shard: 0,
      shardBytes: 0,
      pendingBytes: 0,
      reservedTerminal: TERMINAL_RESERVATION,
      sequence: 0,
    }
    this.states.set(session.id, state)
    this.sessionOrder.set(session.id, ++this.nextSessionOrder)
    try {
      await this.saveState(state)
    } catch {
      this.states.delete(session.id)
      this.budget.releaseTerminal(state.reservedTerminal)
      throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '无法创建采集元数据')
    }
    this.changed(state)
    return structuredClone(session)
  }
  get(id: string): AnalysisSession {
    const state = this.states.get(analysisId(id))
    if (!state) throw new AnalysisError('ANALYSIS_NOT_FOUND', '采集会话不存在')
    return structuredClone(state.session)
  }
  owned(scope: AnalysisScope, id: string): AnalysisSession {
    validateAnalysisScope(scope)
    const session = this.get(id)
    if (!sameAnalysisScope(scope, session.scope))
      throw new AnalysisError('ANALYSIS_NOT_FOUND', '账号来源范围内未找到该会话')
    return session
  }
  list(scope: AnalysisScope, upper = Number.MAX_SAFE_INTEGER): AnalysisSession[] {
    this.assertHealthy()
    validateAnalysisScope(scope)
    return [...this.states.values()]
      .filter(
        state =>
          sameAnalysisScope(scope, state.session.scope) && this.order(state.session.id) <= upper,
      )
      .map(state => structuredClone(state.session))
      .sort((a, b) => this.order(b.id) - this.order(a.id))
  }
  order(id: string): number {
    return this.sessionOrder.get(id) ?? 0
  }
  private fail(state: SessionState, reason: string, storage = false): void {
    state.session.complete = false
    state.session.reason = reason
    state.session.status = storage ? 'storage-error' : 'stopping'
    this.changed(state)
  }
  append(id: string, observation: BusinessObservation, mappingVersion?: number): AppendReceipt {
    const state = this.states.get(id)
    if (state?.session.status !== 'collecting') return { accepted: false, reason: 'NOT_COLLECTING' }
    if (!sameAnalysisScope(state.session.scope, observation.scope))
      return { accepted: false, reason: 'SCOPE_MISMATCH' }
    let envelope: Omit<BusinessObservation, 'data' | 'original' | 'originalFailureCode'>
    try {
      envelope = observationEnvelope(observation)
      if (mappingVersion !== undefined) analysisInteger(mappingVersion, 1)
    } catch {
      return { accepted: false, reason: 'INVALID_OBSERVATION' }
    }
    const session = state.session
    session.counters.received++
    const hasOriginal = !!observation.original || !!observation.originalFailureCode
    const originals = hasOriginal ? (session.originals ??= emptyOriginalSummary()) : undefined
    if (originals) originals.received++
    if (observation.formatVersion !== session.formatVersion) {
      session.counters.dropped++
      if (originals) { originals.dropped++; originals.error = 'FORMAT_CHANGED' }
      this.fail(state, 'FORMAT_CHANGED')
      return { accepted: false, reason: 'FORMAT_CHANGED' }
    }
    if (observation.failureCode === 'PARSE_FAILED') session.counters.parseFailed++
    session.counters.redacted += observation.removedPaths.length
    if (!session.roomId && observation.roomId) session.roomId = observation.roomId
    if (session.roomId && observation.roomId && session.roomId !== observation.roomId) {
      session.counters.dropped++
      if (originals) { originals.dropped++; originals.error = 'ROOM_CHANGED' }
      this.fail(state, 'ROOM_CHANGED')
      return { accepted: false, reason: 'ROOM_CHANGED' }
    }
    const clean = sanitizeBusinessPayload(observation.data, {
      maxBytes: Math.max(256, Math.min(this.limits.maxRecordBytes, 128 * 1024)),
      maxDepth: this.limits.maxDepth,
    })
    session.counters.redacted += clean.removedPaths.length
    const record: AnalysisRecord = {
      ...envelope,
      ...clean,
      complete: observation.complete && clean.complete,
      removedPaths: [...observation.removedPaths, ...clean.removedPaths],
      truncatedPaths: [...observation.truncatedPaths, ...clean.truncatedPaths],
      sessionId: id,
      recordSequence: ++state.sequence,
      ...(mappingVersion === undefined ? {} : { mappingVersion }),
    }
    let line = `${JSON.stringify(record)}\n`
    let bytes = Buffer.byteLength(line)
    if (bytes > this.limits.maxRecordBytes) {
      record.data = null
      record.complete = false
      record.failureCode = 'PAYLOAD_LIMIT'
      record.removedPaths = []
      record.truncatedPaths = ['']
      line = `${JSON.stringify(record)}\n`
      bytes = Buffer.byteLength(line)
    }
    const sanitizedBytes = bytes
    let originalLine: string | undefined
    let originalBytes = 0
    if (originals) {
      try {
        if (observation.originalFailureCode) throw new Error(`ORIGINAL_${observation.originalFailureCode}`)
        const original = observation.original!
        if (envelope.provenance !== undefined && original.provenance !== envelope.provenance)
          throw new Error('INVALID_ORIGINAL')
        const data = originalData(original, this.limits.maxRecordBytes, this.limits.maxDepth)
        originalLine = `${JSON.stringify({
          ...envelope,
          sessionId: id,
          recordSequence: record.recordSequence,
          originalSequence: originals.received,
          format: original.format,
          provenance: original.provenance,
          complete: original.complete,
          removedPaths: original.removedPaths ?? [],
          truncatedPaths: [],
          data,
          ...(original.protobufBase64 === undefined ? {} : { protobufBase64: original.protobufBase64 }),
        })}\n`
        originalBytes = Buffer.byteLength(originalLine)
        if (originalBytes > this.limits.maxRecordBytes) throw new Error('ORIGINAL_LIMIT')
        if (!original.complete) {
          session.complete = false
          originals.error = 'ORIGINAL_REDACTED'
        }
        originals.redacted += original.removedPaths?.length ?? 0
      } catch (error) {
        const reason = error instanceof Error && /^ORIGINAL_[A-Z_]+$/.test(error.message)
          ? error.message : 'INVALID_ORIGINAL'
        originals.dropped++
        originals.error = reason
        session.counters.dropped++
        this.fail(state, reason)
        return { accepted: false, reason }
      }
    }
    bytes += originalBytes
    let reason: string | undefined
    if (sanitizedBytes > this.limits.maxRecordBytes || sanitizedBytes > this.limits.maxShardBytes)
      reason = 'RECORD_LIMIT'
    else if (
      session.counters.pending + 1 > this.limits.maxPendingRecords ||
      state.pendingBytes + bytes > this.limits.maxPendingBytes
    )
      reason = 'QUEUE_LIMIT'
    else if (session.bytes + state.pendingBytes + bytes > this.limits.maxSessionBytes)
      reason = 'SESSION_LIMIT'
    else if (!this.budget.reserveRaw(bytes)) reason = 'STORAGE_LIMIT'
    if (reason) {
      session.counters.dropped++
      if (originals) { originals.dropped++; originals.error = reason }
      this.fail(state, reason)
      return { accepted: false, reason }
    }
    if (!record.complete) session.complete = false
    session.counters.pending++
    if (originals) originals.pending++
    state.pendingBytes += bytes
    state.tail = state.tail.then(async () => {
      let sanitizedWritten = false
      let originalWritten = false
      try {
        if (session.status === 'storage-error') {
          session.counters.dropped++
          if (originals) originals.dropped++
          this.budget.releaseRaw(bytes)
          return
        }
        if (!state.handle || state.shardBytes + sanitizedBytes > this.limits.maxShardBytes) {
          if (state.handle) {
            await state.handle.sync()
            await state.handle.close()
            state.handle = undefined
            state.shard++
            state.shardBytes = 0
          }
          const file = join(this.directory(id), `${String(state.shard).padStart(6, '0')}.jsonl`)
          await this.safePath(file)
          state.handle = await this.io.open(file)
        }
        await state.handle.append(line)
        sanitizedWritten = true
        state.shardBytes += sanitizedBytes
        session.bytes += sanitizedBytes
        session.counters.saved++
        if (originalLine && originals) {
          if (!state.originalHandle) {
            const file = join(this.directory(id), originals.file)
            await this.safePath(file)
            state.originalHandle = await this.io.open(file)
          }
          await state.originalHandle.append(originalLine)
          originalWritten = true
          originals.saved++
          originals.bytes += originalBytes
          session.bytes += originalBytes
        }
      } catch {
        if (!sanitizedWritten) session.counters.dropped++
        const reason = sanitizedWritten ? 'ORIGINAL_WRITE_FAILED' : 'RAW_WRITE_FAILED'
        if (originals && !originalWritten) { originals.dropped++; originals.error = reason }
        this.fail(state, reason, true)
      } finally {
        session.counters.pending--
        if (originals) originals.pending--
        state.pendingBytes -= bytes
        this.changed(state)
      }
    })
    this.changed(state)
    return { accepted: true, recordSequence: record.recordSequence }
  }
  finish(id: string, reason: string): Promise<AnalysisSession> {
    const state = this.states.get(analysisId(id))
    if (!state) return Promise.reject(new AnalysisError('ANALYSIS_NOT_FOUND', '采集会话不存在'))
    if (state.finish) return state.finish
    if (!['collecting', 'stopping', 'storage-error'].includes(state.session.status))
      return Promise.resolve(structuredClone(state.session))
    if (reason !== 'operator' && !validStoredReason(reason))
      return Promise.reject(new AnalysisError('ANALYSIS_INVALID_INPUT', '采集结束原因无效'))
    reason = LEGACY_DISCONNECT_REASONS.get(reason) ?? reason
    const session = state.session
    if (session.status === 'collecting') session.status = 'stopping'
    if (!['operator', 'APP_SHUTDOWN'].includes(reason) && !session.reason) {
      session.complete = false
      session.reason = reason
    }
    this.changed(state)
    state.finish = (async () => {
      await state.tail
      try {
        await state.handle?.sync()
      } catch {
        this.fail(state, 'RAW_SYNC_FAILED', true)
      }
      try {
        await state.handle?.close()
      } catch {
        this.fail(state, 'RAW_CLOSE_FAILED', true)
      }
      state.handle = undefined
      try {
        await state.originalHandle?.sync()
      } catch {
        if (session.originals) session.originals.error = 'ORIGINAL_SYNC_FAILED'
        this.fail(state, 'ORIGINAL_SYNC_FAILED', true)
      }
      try {
        await state.originalHandle?.close()
      } catch {
        if (session.originals) session.originals.error = 'ORIGINAL_CLOSE_FAILED'
        this.fail(state, 'ORIGINAL_CLOSE_FAILED', true)
      }
      state.originalHandle = undefined
      session.stoppedAt = this.now()
      if (session.status !== 'storage-error')
        session.status = session.reason ? 'interrupted' : 'completed'
      session.complete =
        session.complete && session.counters.dropped === 0 && session.counters.pending === 0 &&
        (!session.originals || (session.originals.dropped === 0 && session.originals.pending === 0 && !session.originals.error))
      try {
        await this.saveState(state, true)
      } catch {
        session.status = 'storage-error'
        session.complete = false
        session.reason = 'METADATA_WRITE_FAILED'
      }
      this.budget.releaseTerminal(state.reservedTerminal)
      state.reservedTerminal = 0
      this.changed(state)
      return structuredClone(session)
    })()
    return state.finish
  }
  async *records(id: string, startShard = '', startOffset = 0): AsyncGenerator<StoredLine> {
    const session = this.get(id)
    await this.safePath(this.directory(id))
    const files = (await this.io.list(this.directory(id)))
      .filter(file => /^\d{6}\.jsonl$/.test(file))
      .sort()
    for (const shard of files) {
      if (shard < startShard) continue
      const offset = shard === startShard ? startOffset : 0
      await this.safePath(join(this.directory(id), shard))
      for await (const line of captureLines(
        this.io,
        join(this.directory(id), shard),
        this.limits.maxRecordBytes,
        offset,
      )) {
        let record: AnalysisRecord | undefined
        try {
          const parsed = JSON.parse(line.text ?? '') as AnalysisRecord
          if (
            parsed.sessionId === id &&
            sameAnalysisScope(parsed.scope, session.scope) &&
            Number.isSafeInteger(parsed.recordSequence) &&
            parsed.recordSequence > 0
          ) {
            const envelope = observationEnvelope(parsed)
            if (parsed.mappingVersion !== undefined) analysisInteger(parsed.mappingVersion, 1)
            const clean = sanitizeBusinessPayload(parsed.data)
            record = {
              ...envelope,
              sessionId: id,
              recordSequence: parsed.recordSequence,
              ...clean,
              complete: parsed.complete && clean.complete,
              removedPaths: [...envelope.removedPaths, ...clean.removedPaths],
              truncatedPaths: [...envelope.truncatedPaths, ...clean.truncatedPaths],
              ...(parsed.mappingVersion === undefined
                ? {}
                : { mappingVersion: parsed.mappingVersion }),
            }
          }
        } catch {
          /* Invalid bytes stay on disk and are represented only by location. */
        }
        yield { record, shard, line: line.line, nextOffset: line.nextOffset }
      }
    }
  }
  recover(): Promise<RecoverySummary> {
    if (!this.recovery) this.recovery = this.initialize()
    return this.recovery
  }
  private async initialize(): Promise<RecoverySummary> {
    const summary: RecoverySummary = { interruptedSessionIds: [], badLines: [], errors: [] }
    for (const directory of [
      this.root,
      ...['sessions', 'requests', 'dictionaries', 'history'].map(name => join(this.root, name)),
    ]) {
      const kind = await this.io.kind(directory)
      if (kind !== 'missing' && kind !== 'directory')
        throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '分析存储目录不是普通目录')
    }
    await this.io.mkdir(this.root)
    await this.io.mkdir(join(this.root, 'sessions'))
    await this.io.mkdir(join(this.root, 'requests'))
    await this.io.mkdir(join(this.root, 'dictionaries'))
    await this.io.mkdir(join(this.root, 'history'))
    // Explicit known subdirectories only. No symlink traversal or arbitrary API paths.
    for (const name of ['sessions', 'history', 'requests', 'dictionaries']) {
      const directory = join(this.root, name)
      for (const child of await this.io.list(directory)) {
        const file = join(directory, child)
        if (['sessions', 'history'].includes(name) && /^[0-9a-f-]{36}$/i.test(child)) {
          if ((await this.io.kind(file)) !== 'directory') continue
          for (const leaf of await this.io.list(file)) {
            const path = join(file, leaf)
            if ((await this.io.kind(path)) === 'file')
              this.budget.observeFile(path, await this.io.size(path), leaf.endsWith('.jsonl'))
          }
        } else if (
          (name === 'requests' || name === 'dictionaries') &&
          (await this.io.kind(file)) === 'file'
        )
          this.budget.observeFile(file, await this.io.size(file), false)
      }
    }
    for (const id of await this.io.list(join(this.root, 'sessions'))) {
      try {
        analysisId(id)
        await this.safePath(this.metaFile(id))
        if ((await this.io.size(this.metaFile(id))) > this.limits.maxMetadataBytes)
          throw new Error('metadata limit')
        const diskValue = JSON.parse(await this.io.read(this.metaFile(id))) as AnalysisSession & {
          createdSequence?: number
        }
        const value = sessionFromDisk(diskValue)
        if (value.id !== id) throw new Error('session ID')
        if (diskValue.createdSequence !== undefined) analysisInteger(diskValue.createdSequence, 1)
        const state: SessionState = {
          session: value,
          tail: Promise.resolve(),
          shard: 0,
          shardBytes: 0,
          pendingBytes: 0,
          reservedTerminal: 0,
          sequence: 0,
        }
        this.states.set(id, state)
        this.sessionOrder.set(id, diskValue.createdSequence ?? ++this.nextSessionOrder)
        this.nextSessionOrder = Math.max(this.nextSessionOrder, this.order(id))
        let saved = 0
        let maxSequence = 0
        let bad = false
        let parsedFailures = 0
        let redacted = 0
        let incomplete = false
        let bytes = 0
        for (const leaf of await this.io.list(this.directory(id)))
          if (/^\d{6}\.jsonl$/.test(leaf)) {
            await this.safePath(join(this.directory(id), leaf))
            bytes += await this.io.size(join(this.directory(id), leaf))
          }
        for await (const row of this.records(id)) {
          if (!row.record) {
            bad = true
            if (summary.badLines.length < 1000)
              summary.badLines.push({ sessionId: id, shard: row.shard, line: row.line })
          } else {
            saved++
            maxSequence = Math.max(maxSequence, row.record.recordSequence)
            parsedFailures += row.record.failureCode === 'PARSE_FAILED' ? 1 : 0
            redacted += row.record.removedPaths.length
            incomplete ||= !row.record.complete
          }
        }
        let originalBad = false
        let originalMismatch = false
        const originalFile = join(this.directory(id), 'originals.jsonl')
        const originalKind = await this.io.kind(originalFile)
        if (value.originals || originalKind !== 'missing') {
          await this.safePath(originalFile)
          if (originalKind !== 'file' && originalKind !== 'missing') throw new Error('invalid original file')
          const originals = value.originals ??= emptyOriginalSummary()
          const before = JSON.stringify(originals)
          let originalSaved = 0
          let originalReceived = 0
          let previousRecordSequence = 0
          let originalRedacted = 0
          const originalBytes = originalKind === 'file' ? await this.io.size(originalFile) : 0
          bytes += originalBytes
          if (originalKind === 'file') {
            for await (const row of captureLines(this.io, originalFile, this.limits.maxRecordBytes)) {
              try {
                const parsed = JSON.parse(row.text ?? '')
                if (parsed.sessionId !== id || !sameAnalysisScope(parsed.scope, value.scope)) throw new Error('original scope')
                analysisInteger(parsed.recordSequence, 1, maxSequence)
                analysisInteger(parsed.originalSequence, 1)
                if (parsed.originalSequence <= originalReceived || parsed.recordSequence <= previousRecordSequence)
                  throw new Error('original sequence')
                observationEnvelope(parsed)
                originalData({
                  format: parsed.format,
                  provenance: parsed.provenance,
                  complete: parsed.complete,
                  json: JSON.stringify(parsed.data),
                  protobufBase64: parsed.protobufBase64,
                  removedPaths: parsed.removedPaths,
                }, this.limits.maxRecordBytes, this.limits.maxDepth)
                originalSaved++
                originalReceived = Math.max(originalReceived, parsed.originalSequence)
                previousRecordSequence = parsed.recordSequence
                originalRedacted += parsed.removedPaths.length
                incomplete ||= !parsed.complete
              } catch {
                originalBad = true
                if (summary.badLines.length < 1000)
                  summary.badLines.push({ sessionId: id, shard: 'originals.jsonl', line: row.line })
              }
            }
          }
          originals.received = Math.max(originals.received, originalReceived)
          originals.saved = originalSaved
          originals.dropped = Math.max(originals.dropped, originals.received - originalSaved)
          originals.pending = 0
          originals.bytes = originalBytes
          originals.redacted = originalRedacted
          if (originalBad) originals.error = 'CORRUPT_ORIGINALS'
          else if (originalKind === 'missing' && originals.received > 0) originals.error = 'ORIGINAL_MISSING'
          originalMismatch = before !== JSON.stringify(originals)
        }
        state.sequence = maxSequence
        if (
          ['collecting', 'stopping'].includes(value.status) ||
          bad ||
          value.counters.saved !== saved ||
          value.bytes !== bytes ||
          maxSequence > value.counters.received ||
          originalBad || originalMismatch ||
          (incomplete && value.complete)
        ) {
          if (['collecting', 'stopping'].includes(value.status))
            summary.interruptedSessionIds.push(id)
          value.status = value.status === 'storage-error' ? 'storage-error' : 'interrupted'
          value.complete = false
          value.reason = bad ? 'CORRUPT_RECORDS' : originalBad ? 'CORRUPT_ORIGINALS' : 'APP_INTERRUPTED'
          value.stoppedAt = this.now()
          const received = Math.max(value.counters.received, maxSequence)
          value.bytes = bytes
          value.counters = {
            received,
            saved,
            dropped: Math.max(value.counters.dropped, received - saved),
            pending: 0,
            parseFailed: parsedFailures,
            redacted,
          }
          await this.saveState(state)
        }
      } catch {
        this.states.delete(id)
        this.sessionOrder.delete(id)
        summary.errors.push({ sessionId: id, code: 'METADATA_UNREADABLE' })
      }
    }
    for (const file of await this.io.list(join(this.root, 'requests'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      try {
        const fullPath = join(this.root, 'requests', file)
        await this.safePath(fullPath)
        if ((await this.io.size(fullPath)) > this.limits.maxMetadataBytes)
          throw new Error('requests limit')
        const data = JSON.parse(await this.io.read(fullPath)) as {
          accountId: string
          items: CaptureRequest[]
        }
        if (
          this.requestFile(data.accountId) !== fullPath ||
          !Array.isArray(data.items) ||
          data.items.length > 1000
        )
          throw new Error('request scope')
        for (const item of data.items) {
          analysisString(item.requestId, 128)
          analysisInteger(item.createdAt)
          if (
            !/^[a-f0-9]{64}$/.test(item.digest) ||
            !['start', 'stop', 'reanalyze'].includes(item.action) ||
            !['inflight', 'terminal'].includes(item.status)
          )
            throw new Error('invalid request')
          if (item.sessionId !== undefined) analysisId(item.sessionId)
          if (item.jobId !== undefined) analysisId(item.jobId)
          if (item.result) {
            item.result = sessionFromDisk(item.result)
            if (item.result.scope.accountId !== data.accountId) throw new Error('request owner')
          }
          if (item.error) {
            analysisString(item.error.code, 128)
            analysisString(item.error.message, 256)
            if (typeof item.error.retryable !== 'boolean') throw new Error('invalid request error')
          }
          if (item.status === 'inflight') {
            item.status = 'terminal'
            if (item.sessionId && this.states.has(item.sessionId))
              item.result = this.get(item.sessionId)
            else
              item.error = {
                code: 'ANALYSIS_INCOMPLETE',
                message: '原请求在关闭时中断，请使用新的请求 ID',
                retryable: false,
              }
          }
        }
        this.requests.set(data.accountId, data.items)
      } catch {
        summary.errors.push({ code: 'IDEMPOTENCY_UNREADABLE' })
      }
    }
    this.recoverySummary = summary
    return summary
  }
  requestEntries(accountId: string): CaptureRequest[] {
    return structuredClone(this.requests.get(accountId) ?? [])
  }
  async saveRequests(accountId: string, items: CaptureRequest[]): Promise<void> {
    this.assertHealthy()
    if (items.length > this.limits.maxIdempotencyRequests)
      throw new AnalysisError('ANALYSIS_LIMIT', '幂等记录容量已满')
    await this.writeMetadata(this.requestFile(accountId), { accountId, items })
    this.requests.set(accountId, structuredClone(items))
  }
}
