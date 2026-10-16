import { createHash } from 'node:crypto'
import {
  AnalysisError,
  type AnalysisScope,
  type AnalysisSession,
  analysisId,
  analysisString,
  type BusinessObservation,
  validateAnalysisScope,
} from '../../../../shared/analysisRoom'
import type {
  CommentSubscription,
  CommentSubscriptionCoordinator,
} from '../CommentSubscriptionCoordinator'
import {
  type AnalysisCaptureStore,
  type CaptureRequest,
  sameAnalysisScope,
} from './AnalysisCaptureStore'
import { SqliteAnalysisCaptureStore } from './SqliteAnalysisCaptureStore'

interface ServiceOptions {
  store: AnalysisCaptureStore
  subscriptions: (scope: AnalysisScope) => CommentSubscriptionCoordinator
  mappingVersion?: (scope: AnalysisScope) => number | undefined
  formatVersion?: (scope: AnalysisScope) => number | undefined
}
interface ActiveCapture {
  sessionId: string
  scope: AnalysisScope
  lease?: CommentSubscription
  stopping?: Promise<AnalysisSession>
  owners: Set<string>
}

export class AnalysisRoomService {
  private active = new Map<string, ActiveCapture>()
  private accountTails = new Map<string, Promise<void>>()
  private inflight = new Map<string, { digest: string; promise: Promise<AnalysisSession> }>()
  private draining = new Set<Promise<AnalysisSession>>()
  private closed = false
  private unsubscribe: () => void
  constructor(private options: ServiceOptions) {
    this.unsubscribe = options.store.onChanged(session => {
      const capture = this.active.get(session.scope.accountId)
      if (
        capture?.sessionId === session.id &&
        !capture.stopping &&
        ['stopping', 'storage-error'].includes(session.status)
      ) {
        this.end(capture, session.reason ?? 'CAPTURE_ENDED').catch(() => {})
      }
    })
  }
  private serial<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const next = this.options.store.mutateAccount(accountId, work)
    this.accountTails.set(
      accountId,
      next.then(
        () => {},
        () => {},
      ),
    )
    return next
  }
  private request(accountId: string, requestId: string): CaptureRequest | undefined {
    const store = this.options.store
    return store instanceof SqliteAnalysisCaptureStore
      ? store.sqlite.getRequest(accountId, requestId)
      : store.requestEntries(accountId).find(item => item.requestId === requestId)
  }
  private async saveRequest(accountId: string, item: CaptureRequest): Promise<void> {
    const store = this.options.store
    if (store instanceof SqliteAnalysisCaptureStore) {
      await store.sqlite.putRequest(accountId, item)
      return
    }
    const saved = store.requestEntries(accountId)
    const index = saved.findIndex(old => old.requestId === item.requestId)
    if (index >= 0) saved[index] = item
    else saved.push(item)
    await store.saveRequests(accountId, saved)
  }
  private remember(
    scope: AnalysisScope,
    action: 'start' | 'stop',
    requestId: string,
    sessionId: string | undefined,
    operation: (entry: CaptureRequest) => Promise<AnalysisSession>,
  ): Promise<AnalysisSession> {
    validateAnalysisScope(scope)
    analysisString(requestId, 128)
    const key = JSON.stringify([scope.accountId, requestId])
    const digest = createHash('sha256')
      .update(
        JSON.stringify([action, scope.accountId, scope.platform, scope.source, sessionId ?? null]),
      )
      .digest('hex')
    const existing = this.inflight.get(key)
    if (existing) {
      if (existing.digest !== digest)
        return Promise.reject(
          new AnalysisError('ANALYSIS_REQUEST_CONFLICT', '同一请求 ID 的参数不一致'),
        )
      return existing.promise
    }
    const promise = (async () => {
      const entry = await this.serial(scope.accountId, async () => {
        await this.options.store.recover()
        const old = this.request(scope.accountId, requestId)
        if (old) {
          if (old.digest !== digest)
            throw new AnalysisError('ANALYSIS_REQUEST_CONFLICT', '同一请求 ID 的参数不一致')
          if (old.status === 'terminal') return old
          throw new AnalysisError(
            'ANALYSIS_INCOMPLETE',
            '原请求在关闭时中断，请检查采集会话并使用新的请求 ID',
          )
        }
        const store = this.options.store
        if (store instanceof SqliteAnalysisCaptureStore) {
          if (
            store.sqlite.countInflightRequests(scope.accountId) >=
            store.limits.maxIdempotencyRequests
          )
            throw new AnalysisError('ANALYSIS_LIMIT', '正在执行的幂等请求已达上限')
        } else {
          const saved = store.requestEntries(scope.accountId)
          while (saved.length >= store.limits.maxIdempotencyRequests) {
            const index = saved.findIndex(item => item.status === 'terminal')
            if (index < 0) throw new AnalysisError('ANALYSIS_LIMIT', '正在执行的幂等请求已达上限')
            saved.splice(index, 1)
          }
          // Only the retired file-backed test store compacts its request array.
          await store.saveRequests(scope.accountId, saved)
        }
        const item: CaptureRequest = {
          requestId,
          digest,
          action,
          createdAt: Date.now(),
          status: 'inflight',
          ...(sessionId ? { sessionId } : {}),
        }
        await this.saveRequest(scope.accountId, item)
        return item
      })
      if (entry.error)
        throw new AnalysisError(entry.error.code, entry.error.message, entry.error.retryable)
      if (entry.result) return this.options.store.owned(scope, entry.result.id)
      let result: AnalysisSession
      try {
        result = await operation(entry)
      } catch (error) {
        const safe =
          error instanceof AnalysisError
            ? error
            : new AnalysisError('ANALYSIS_INTERNAL', '采集请求失败')
        await this.serial(scope.accountId, async () => {
          if (this.request(scope.accountId, requestId)) {
            await this.saveRequest(scope.accountId, {
              ...entry,
              status: 'terminal',
              error: { code: safe.code, message: safe.message, retryable: safe.retryable },
            })
          }
        })
        throw error
      }
      await this.serial(scope.accountId, async () => {
        await this.saveRequest(scope.accountId, {
          ...entry,
          sessionId: result.id,
          status: 'terminal',
          result,
        })
      })
      return result
    })()
    this.inflight.set(key, { digest, promise })
    promise
      .finally(() => {
        this.inflight.delete(key)
      })
      .catch(() => {})
    return promise
  }
  start(
    input: { scope: AnalysisScope; requestId: string },
    owner = 'operator',
  ): Promise<AnalysisSession> {
    if (this.closed)
      return Promise.reject(new AnalysisError('ANALYSIS_UNAVAILABLE', '分析室正在关闭'))
    return this.remember(input.scope, 'start', input.requestId, undefined, async entry => {
      const capture = await this.serial(input.scope.accountId, async () => {
        if (this.closed) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析室正在关闭')
        const existing = this.active.get(input.scope.accountId)
        if (existing) {
          if (!sameAnalysisScope(existing.scope, input.scope))
            throw new AnalysisError('ANALYSIS_SOURCE_CONFLICT', '账号正在采集不同来源')
          existing.owners.add(owner)
          return existing
        }
        const subscriptions = this.options.subscriptions(input.scope)
        const session = await this.options.store.create(input.scope, {
          formatVersion: this.options.formatVersion?.(input.scope) ?? 1,
          mappingVersion: this.options.mappingVersion?.(input.scope),
        })
        const active: ActiveCapture = {
          sessionId: session.id,
          scope: input.scope,
          owners: new Set([owner]),
        }
        this.active.set(input.scope.accountId, active)
        entry.sessionId = session.id
        try {
          await this.saveRequest(input.scope.accountId, entry)
          if (this.closed) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析室正在关闭')
          active.lease = subscriptions.acquire(input.scope, { id: `analysis:${session.id}` })
        } catch (error) {
          await this.end(active, 'START_FAILED')
          throw error
        }
        return active
      })
      try {
        await capture.lease?.ready
      } catch (error) {
        await this.end(capture, 'START_FAILED')
        throw error
      }
      return this.options.store.get(capture.sessionId)
    })
  }
  stop(
    input: {
      scope: AnalysisScope
      sessionId: string
      requestId: string
    },
    owner?: string,
  ): Promise<AnalysisSession> {
    analysisId(input.sessionId)
    return this.remember(input.scope, 'stop', input.requestId, input.sessionId, async () => {
      this.options.store.owned(input.scope, input.sessionId)
      const active = this.active.get(input.scope.accountId)
      if (
        owner &&
        active?.sessionId === input.sessionId &&
        [...active.owners].some(id => id !== owner)
      ) {
        active.owners.delete(owner)
        return this.options.store.get(active.sessionId)
      }
      return active?.sessionId === input.sessionId
        ? this.end(active, 'operator')
        : this.options.store.finish(input.sessionId, 'operator')
    })
  }
  private end(capture: ActiveCapture, reason: string): Promise<AnalysisSession> {
    if (capture.stopping) return capture.stopping
    // Assign the guard before finish emits changed, so nested notifications cannot recurse.
    const promise = Promise.resolve().then(async () => {
      let terminalReason = reason
      try {
        await capture.lease?.release()
      } catch {
        terminalReason = 'LISTENER_STOP_FAILED'
      }
      try {
        return await this.options.store.finish(capture.sessionId, terminalReason)
      } finally {
        if (this.active.get(capture.scope.accountId) === capture)
          this.active.delete(capture.scope.accountId)
      }
    })
    capture.stopping = promise
    this.draining.add(promise)
    promise
      .finally(() => {
        this.draining.delete(promise)
      })
      .catch(() => {})
    return promise
  }
  observe(observation: BusinessObservation): void {
    const active = this.active.get(observation.scope.accountId)
    if (!active || active.stopping || !sameAnalysisScope(active.scope, observation.scope)) return
    const receipt = this.options.store.append(
      active.sessionId,
      observation,
      this.options.mappingVersion?.(observation.scope),
    )
    if (!receipt.accepted) this.end(active, receipt.reason ?? 'CAPTURE_ENDED').catch(() => {})
  }
  async disconnect(accountId: string, reason: string): Promise<void> {
    const active = this.active.get(accountId)
    if (active) await this.end(active, reason)
  }
  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.all([...this.active.values()].map(capture => this.end(capture, 'APP_SHUTDOWN')))
    await Promise.all([...this.draining])
    await Promise.allSettled([...this.inflight.values()].map(item => item.promise))
    await Promise.all([...this.accountTails.values()])
    this.unsubscribe()
  }
}
