import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import {
  AnalysisError,
  type AnalysisParameters,
  type AnalysisScope,
  analysisId,
  analysisInteger,
  analysisString,
  assertBoundedJson,
  type ReanalysisJob,
  type ReanalysisPage,
  validateAnalysisScope,
} from '../../../../shared/analysisRoom'
import type {
  AttributeSnapshot,
  PublishedAttributeDictionary,
} from '../../../../shared/audienceAttributes'
import {
  type AnalysisCaptureStore,
  type CaptureRequest,
  sameAnalysisScope,
} from './AnalysisCaptureStore'
import type { AttributeDictionaryService } from './AttributeDictionaryService'
import type { SqliteAnalysisCaptureStore } from './SqliteAnalysisCaptureStore'
import { interpretValue, mapObservation } from './AttributeMapper'
import { type CaptureHandle, captureLines } from './CaptureIO'
import { parseHistoricalResultEnvelope } from './CaptureHistoricalSnapshot'

interface JobState {
  job: ReanalysisJob
  terminalReservation: number
  work?: Promise<ReanalysisJob>
  requestId?: string
}
interface ResultCursor {
  scope: AnalysisScope
  jobId: string
  upper: number
  shard?: string
  offset?: number
  afterSequence?: number
  storage?: 'sqlite'
}
export class AnalysisReanalyzer {
  readonly ready: Promise<void>
  readonly recoveryErrors: Array<{ jobId: string; code: string }> = []
  private jobs = new Map<string, JobState>()
  private cursorKey = randomBytes(32)
  private closed = false
  private listeners = new Set<(job: ReanalysisJob) => void>()
  private get sql() {
    return (this.options.store as AnalysisCaptureStore & { sqlite?: SqliteAnalysisCaptureStore['sqlite'] }).sqlite
  }
  onChanged(listener: (job: ReanalysisJob) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(job: ReanalysisJob): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(job))
      } catch {}
    }
  }
  private starting = new Set<Promise<ReanalysisJob>>()
  constructor(
    private options: {
      store: AnalysisCaptureStore
      dictionaries: AttributeDictionaryService
      now?: () => number
    },
  ) {
    this.ready = this.initialize()
    this.ready.catch(() => {})
  }
  private directory(id: string) {
    return join(this.options.store.root, 'history', analysisId(id))
  }
  private meta(id: string) {
    return join(this.directory(id), 'metadata.json')
  }
  private get(id: string): JobState {
    analysisId(id)
    const state = this.jobs.get(id)
    if (!state && this.sql) {
      const job = this.sql.readJob(id) as ReanalysisJob | undefined
      if (job) return { job: this.jobFromDisk(job, id), terminalReservation: 0 }
    }
    if (!state) throw new AnalysisError('ANALYSIS_NOT_FOUND', '重新分析任务不存在')
    return state
  }
  private owned(scope: AnalysisScope, id: string): JobState {
    validateAnalysisScope(scope)
    const state = this.get(id)
    if (!sameAnalysisScope(scope, state.job.scope))
      throw new AnalysisError('ANALYSIS_NOT_FOUND', '账号来源范围内未找到重新分析任务')
    return state
  }
  private jobFromDisk(value: ReanalysisJob, id: string): ReanalysisJob {
    if (value.id !== id || !['running', 'completed', 'failed'].includes(value.status))
      throw new Error('job identity/status')
    const scope = validateAnalysisScope(value.scope)
    analysisId(value.sessionId)
    analysisInteger(value.mappingVersion, 1)
    analysisInteger(value.createdAt)
    analysisInteger(value.received)
    analysisInteger(value.saved)
    if (value.saved > value.received) throw new Error('job counters')
    if (value.finishedAt !== undefined) analysisInteger(value.finishedAt)
    if (value.error !== undefined && !/^[A-Z_]{1,128}$/.test(value.error))
      throw new Error('job error')
    return {
      id,
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
  private async initialize(): Promise<void> {
    await Promise.all([this.options.store.recover(), this.options.dictionaries.ready])
    if (this.sql) { await this.sql.interruptRunningJobs(); return }
    for (const id of await this.options.store.io.list(join(this.options.store.root, 'history'))) {
      try {
        analysisId(id)
        await this.options.store.safePath(this.meta(id))
        if (
          (await this.options.store.io.size(this.meta(id))) >
          this.options.store.limits.maxMetadataBytes
        )
          throw new Error('metadata bytes')
        const job = this.jobFromDisk(
          JSON.parse(await this.options.store.io.read(this.meta(id))),
          id,
        )
        const state: JobState = { job, terminalReservation: 0 }
        this.jobs.set(id, state)
        let saved = 0
        let broken = false
        for await (const row of this.rows(job)) {
          if (row.snapshot && row.resultSequence === saved + 1) saved++
          else broken = true
        }
        if (job.status === 'running' || saved !== job.saved || broken) {
          job.status = 'failed'
          job.error = broken ? 'CORRUPT_RESULTS' : 'APP_INTERRUPTED'
          job.saved = saved
          job.received = Math.max(job.received, saved)
          job.finishedAt = (this.options.now ?? Date.now)()
          await this.options.store.writeMetadata(this.meta(id), job)
        }
      } catch {
        this.jobs.delete(id)
        this.recoveryErrors.push({ jobId: id, code: 'HISTORY_UNREADABLE' })
      }
    }
  }
  start(input: AnalysisParameters['reanalyze']): Promise<ReanalysisJob> {
    const work = this.startInternal(input)
    this.starting.add(work)
    work
      .finally(() => {
        this.starting.delete(work)
      })
      .catch(() => {})
    return work
  }
  private async startInternal(input: AnalysisParameters['reanalyze']): Promise<ReanalysisJob> {
    await this.ready
    validateAnalysisScope(input.scope)
    analysisId(input.sessionId)
    analysisInteger(input.mappingVersion, 1)
    analysisString(input.requestId, 128)
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'reanalyze',
          input.scope.accountId,
          input.scope.platform,
          input.scope.source,
          input.sessionId,
          input.mappingVersion,
        ]),
      )
      .digest('hex')
    return this.options.store.mutateAccount(input.scope.accountId, async () => {
      if (this.closed) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '历史分析正在关闭')
      const saved = this.sql ? undefined : this.options.store.requestEntries(input.scope.accountId)
      const old = this.sql
        ? this.sql.getRequest(input.scope.accountId, input.requestId) as CaptureRequest | undefined
        : saved!.find(item => item.requestId === input.requestId)
      if (old) {
        if (old.digest !== digest)
          throw new AnalysisError('ANALYSIS_REQUEST_CONFLICT', '同一请求 ID 的参数不一致')
        if (old.jobId) return structuredClone(this.owned(input.scope, old.jobId).job)
        throw new AnalysisError(
          'ANALYSIS_INCOMPLETE',
          '原重新分析请求没有可恢复任务，请使用新的请求 ID',
        )
      }
      if (this.sql?.hasRunningJob(input.scope.accountId) ||
        [...this.jobs.values()].some(
          state =>
            state.job.scope.accountId === input.scope.accountId && state.job.status === 'running',
        )
      )
        throw new AnalysisError('ANALYSIS_REQUEST_CONFLICT', '该账号已有重新分析任务')
      const session = this.options.store.owned(input.scope, input.sessionId)
      if (['collecting', 'stopping'].includes(session.status))
        throw new AnalysisError('ANALYSIS_INCOMPLETE', '请先停止保存来源会话')
      const version = this.options.dictionaries.published(
        input.scope.platform,
        input.scope.source,
        input.mappingVersion,
      )
      if (!version) throw new AnalysisError('MAPPING_INVALID', '指定已发布字典不存在')
      while (saved && saved.length >= this.options.store.limits.maxIdempotencyRequests) {
        const index = saved.findIndex(item => item.status === 'terminal')
        if (index < 0) throw new AnalysisError('ANALYSIS_LIMIT', '正在执行的幂等请求已达上限')
        saved.splice(index, 1)
      }
      if (!this.sql) this.options.store.budget.reserveTerminal(4096)
      const job: ReanalysisJob = {
        id: randomUUID(),
        scope: { ...input.scope },
        sessionId: input.sessionId,
        mappingVersion: input.mappingVersion,
        status: 'running',
        received: 0,
        saved: 0,
        createdAt: (this.options.now ?? Date.now)(),
      }
      const state: JobState = { job, terminalReservation: this.sql ? 0 : 4096, requestId: input.requestId }
      try {
        const entry: CaptureRequest = {
          requestId: input.requestId,
          digest,
          action: 'reanalyze',
          createdAt: job.createdAt,
          status: 'inflight',
          jobId: job.id,
        }
        if (this.sql) await this.sql.writeJob(job, entry)
        else {
          await this.options.store.writeMetadata(this.meta(job.id), job)
          saved!.push(entry)
          await this.options.store.saveRequests(input.scope.accountId, saved!)
        }
      } catch {
        this.options.store.budget.releaseTerminal(state.terminalReservation)
        throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '无法创建重新分析任务')
      }
      this.jobs.set(job.id, state)
      this.changed(job)
      state.work = this.run(state, version, this.closed)
      state.work.catch(() => {})
      if (this.sql) void state.work.finally(() => { if (this.jobs.get(job.id) === state) this.jobs.delete(job.id) }).catch(() => {})
      if (this.closed) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '历史分析正在关闭')
      return structuredClone(job)
    })
  }
  private async run(
    state: JobState,
    version: PublishedAttributeDictionary,
    cancelled = false,
  ): Promise<ReanalysisJob> {
    const job = state.job
    const store = this.options.store
    let handle: CaptureHandle | undefined
    let shard = 0
    let shardBytes = 0
    let corrupt = false
    try {
      if (cancelled) throw new Error('APP_SHUTDOWN')
      for await (const row of store.records(job.sessionId)) {
        if (this.sql && this.closed) throw new Error('APP_SHUTDOWN')
        job.received++
        if (!row.record) corrupt = true
        else {
          const snapshot = mapObservation(row.record, version)
          snapshot.origin = 'history'
          if (this.sql) {
            await this.sql.appendJobResult(job.id, job.saved + 1, snapshot)
            job.saved++
          } else {
          const line = `${JSON.stringify({ resultSequence: job.saved + 1, snapshot })}\n`
          const bytes = Buffer.byteLength(line)
          if (bytes > store.limits.maxRecordBytes || bytes > store.limits.maxShardBytes)
            throw new Error('RESULT_LIMIT')
          if (!store.budget.reserveRaw(bytes)) throw new Error('STORAGE_LIMIT')
          if (!handle || shardBytes + bytes > store.limits.maxShardBytes) {
            if (handle) {
              await handle.sync()
              await handle.close()
              handle = undefined
              shard++
              shardBytes = 0
            }
            const file = join(this.directory(job.id), `${String(shard).padStart(6, '0')}.jsonl`)
            await store.safePath(file)
            handle = await store.io.open(file)
          }
          await handle.append(line)
          shardBytes += bytes
          job.saved++
          }
        }
        if (job.received % 200 === 0) {
          await handle?.sync()
          if (this.sql) await this.sql.writeJob(job)
          else await store.writeMetadata(this.meta(job.id), job)
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
      await handle?.sync()
      job.status = corrupt ? 'failed' : 'completed'
      if (corrupt) job.error = 'CORRUPT_SOURCE'
    } catch (error) {
      job.status = 'failed'
      job.error =
        error instanceof Error &&
        ['RESULT_LIMIT', 'STORAGE_LIMIT', 'APP_SHUTDOWN'].includes(error.message)
          ? error.message
          : 'HISTORY_WRITE_FAILED'
    } finally {
      try {
        await handle?.close()
      } catch {
        job.status = 'failed'
        job.error = 'HISTORY_CLOSE_FAILED'
      }
      job.finishedAt = (this.options.now ?? Date.now)()
      if (this.sql) {
        try {
          const original = this.sql.getRequest(job.scope.accountId, state.requestId!) as CaptureRequest | undefined
          if (!original || original.action !== 'reanalyze' || original.jobId !== job.id)
            throw new Error('HISTORY_REQUEST_FAILED')
          const terminal: CaptureRequest = { ...original, status: 'terminal', jobResult: structuredClone(job) }
          delete terminal.error
          await this.sql.writeJob(job, terminal)
        } catch {
          job.status = 'failed'
          job.error = 'HISTORY_METADATA_FAILED'
        }
      } else {
      try {
        await store.writeMetadata(this.meta(job.id), job, state.terminalReservation)
      } catch {
        job.status = 'failed'
        job.error = 'HISTORY_METADATA_FAILED'
      }
      store.budget.releaseTerminal(state.terminalReservation)
      state.terminalReservation = 0
      try {
        await store.mutateAccount(job.scope.accountId, async () => {
          const requests = store.requestEntries(job.scope.accountId)
          const index = requests.findIndex(
            item => item.action === 'reanalyze' && item.jobId === job.id,
          )
          if (index >= 0) {
            const entry: CaptureRequest = {
              ...requests[index],
              status: 'terminal',
              jobResult: structuredClone(job),
            }
            delete entry.error
            requests[index] = entry
            await store.saveRequests(job.scope.accountId, requests)
          }
        })
      } catch {
        job.status = 'failed'
        job.error = 'HISTORY_REQUEST_FAILED'
      }
      }
    }
    this.changed(job)
    return structuredClone(job)
  }
  private snapshotFromDisk(value: AttributeSnapshot, job: ReanalysisJob): AttributeSnapshot {
    assertBoundedJson(value)
    if (
      value.origin !== 'history' ||
      !sameAnalysisScope(value.scope, job.scope) ||
      value.mappingVersion !== job.mappingVersion
    )
      throw new Error('result scope')
    analysisString(value.observationId, 256)
    analysisString(value.streamId, 256)
    analysisInteger(value.sequence)
    analysisInteger(value.observedAt)
    if (value.userId !== undefined) analysisString(value.userId, 256)
    if (value.nickname !== undefined) analysisString(value.nickname, 128)
    if (value.platformTime !== undefined) analysisInteger(value.platformTime)
    const definitions = this.options.dictionaries.published(
      job.scope.platform,
      job.scope.source,
      job.mappingVersion,
    )?.definitions
    if (!definitions) throw new Error('result mapping')
    const values: AttributeSnapshot['values'] = {}
    for (const definition of definitions) {
      const fact = value.values[definition.id]
      if (
        !fact ||
        !sameAnalysisScope(fact.scope, job.scope) ||
        fact.mappingVersion !== job.mappingVersion ||
        fact.type !== definition.type ||
        !['known', 'unknown', 'conflict'].includes(fact.status)
      )
        throw new Error('result fact')
      analysisString(fact.observationId, 256)
      analysisString(fact.streamId, 256)
      analysisInteger(fact.sequence)
      analysisInteger(fact.observedAt)
      analysisInteger(fact.expiresAt)
      if (!['platform', 'local-sequence'].includes(fact.timeBasis))
        throw new Error('result time basis')
      if (fact.platformTime !== undefined) analysisInteger(fact.platformTime)
      if (fact.path !== undefined) analysisString(fact.path, 2048)
      const provenance = {
        scope: job.scope,
        observationId: fact.observationId,
        streamId: fact.streamId,
        sequence: fact.sequence,
        observedAt: fact.observedAt,
        mappingVersion: job.mappingVersion,
        type: fact.type,
        timeBasis: fact.timeBasis,
        expiresAt: fact.expiresAt,
        ...(fact.platformTime === undefined ? {} : { platformTime: fact.platformTime }),
        ...(fact.path === undefined ? {} : { path: fact.path }),
      }
      if (fact.status === 'known') {
        if (
          interpretValue(definition.type, fact.value, undefined, definition.enumValues).status !==
          'known'
        )
          throw new Error('result value')
        values[definition.id] = { ...provenance, status: 'known', value: fact.value }
      } else {
        analysisString(fact.reason, 128)
        values[definition.id] = { ...provenance, status: fact.status, reason: fact.reason }
      }
    }
    return {
      origin: 'history',
      scope: job.scope,
      mappingVersion: job.mappingVersion,
      observationId: value.observationId,
      streamId: value.streamId,
      sequence: value.sequence,
      observedAt: value.observedAt,
      ...(value.userId === undefined ? {} : { userId: value.userId }),
      ...(value.nickname === undefined ? {} : { nickname: value.nickname }),
      ...(value.platformTime === undefined ? {} : { platformTime: value.platformTime }),
      values,
    }
  }
  private async *rows(job: ReanalysisJob, startShard = '', offset = 0) {
    await this.options.store.safePath(this.directory(job.id))
    const files = (await this.options.store.io.list(this.directory(job.id)))
      .filter(file => /^\d{6}\.jsonl$/.test(file))
      .sort()
    for (const shard of files) {
      if (shard < startShard) continue
      const file = join(this.directory(job.id), shard)
      await this.options.store.safePath(file)
      for await (const line of captureLines(
        this.options.store.io,
        file,
        this.options.store.limits.maxRecordBytes,
        shard === startShard ? offset : 0,
      )) {
        let snapshot: AttributeSnapshot | undefined
        let resultSequence = 0
        try {
          const dictionary = this.options.dictionaries.published(
            job.scope.platform,
            job.scope.source,
            job.mappingVersion,
          )
          if (!dictionary) throw new Error('result mapping')
          const parsed = parseHistoricalResultEnvelope(
            line.text,
            job,
            dictionary,
            this.options.store.limits.maxRecordBytes,
          )
          resultSequence = parsed.resultSequence
          snapshot = parsed.snapshot
        } catch {
          /* Keep bad bytes as evidence. */
        }
        yield { snapshot, resultSequence, shard, nextOffset: line.nextOffset }
      }
    }
  }
  private encode(cursor: ResultCursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    return `${payload}.${createHmac('sha256', this.cursorKey).update(payload).digest('base64url')}`
  }
  private decode(text: string, scope: AnalysisScope, jobId: string): ResultCursor {
    try {
      analysisString(text, 2048)
      const [payload, signature, extra] = text.split('.')
      const expected = createHmac('sha256', this.cursorKey).update(payload).digest()
      const actual = Buffer.from(signature, 'base64url')
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error('signature')
      const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ResultCursor
      if (!sameAnalysisScope(scope, cursor.scope) || cursor.jobId !== jobId)
        throw new Error('cursor scope')
      analysisInteger(cursor.upper)
      if (cursor.offset !== undefined) analysisInteger(cursor.offset)
      if (cursor.afterSequence !== undefined) analysisInteger(cursor.afterSequence)
      if (this.sql ? cursor.storage !== 'sqlite' || cursor.shard !== undefined || cursor.offset !== undefined : cursor.storage !== undefined)
        throw new Error('cursor storage')
      if (cursor.shard !== undefined && !/^\d{6}\.jsonl$/.test(cursor.shard))
        throw new Error('cursor shard')
      return cursor
    } catch {
      throw new AnalysisError('ANALYSIS_INVALID_INPUT', '结果分页凭据失效或范围不一致')
    }
  }
  async results(input: AnalysisParameters['results']): Promise<ReanalysisPage> {
    await this.ready
    const job = this.owned(input.scope, input.jobId).job
    const limit = analysisInteger(input.limit ?? 50, 1, 100)
    const cursor = input.cursor
      ? this.decode(input.cursor, input.scope, job.id)
      : { scope: input.scope, jobId: job.id, upper: job.saved, ...(this.sql ? { storage: 'sqlite' as const, afterSequence: 0 } : {}) }
    if (this.sql) {
      const page = this.sql.pageJobResults(job.id, cursor.afterSequence ?? 0, limit, cursor.upper) as { rows: Array<{ sequence: number; result: AttributeSnapshot }>; nextAfterSequence?: number }
      let after = cursor.afterSequence ?? 0
      const items = page.rows.map(row => {
        analysisInteger(row.sequence, after + 1, cursor.upper); after = row.sequence
        try { return this.snapshotFromDisk(row.result, job) }
        catch { throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '历史结果范围或内容校验失败') }
      })
      return { job: structuredClone(job), items, ...(page.nextAfterSequence === undefined ? {} : { nextCursor: this.encode({ ...cursor, afterSequence: page.nextAfterSequence }) }) }
    }
    const items: AttributeSnapshot[] = []
    let next: ResultCursor | undefined
    for await (const row of this.rows(job, cursor.shard, cursor.offset)) {
      if (!row.snapshot || row.resultSequence > cursor.upper) continue
      if (items.length === limit && next)
        return { job: structuredClone(job), items, nextCursor: this.encode(next) }
      items.push(row.snapshot)
      next = { ...cursor, shard: row.shard, offset: row.nextOffset }
    }
    return { job: structuredClone(job), items }
  }
  async completion(jobId: string): Promise<ReanalysisJob> {
    await this.ready
    const state = this.get(jobId)
    return state.work ? state.work : structuredClone(state.job)
  }
  async shutdown(): Promise<void> {
    this.closed = true
    await this.ready
    await Promise.allSettled([...this.starting])
    await Promise.all([...this.jobs.values()].map(state => state.work))
  }
}
