import { randomUUID } from 'node:crypto'
import {
  type AnalysisCapabilities,
  type AnalysisChanged,
  type AnalysisCommand,
  type AnalysisCommandResult,
  AnalysisError,
  type AnalysisHealth,
  type AnalysisResponse,
  type AnalysisScope,
  type AnalysisSession,
  type BusinessObservation,
  type MappingScope,
  validateAnalysisCommand,
} from '../../../../shared/analysisRoom'
import type { CommentSubscriptionCoordinator } from '../CommentSubscriptionCoordinator'
import { AnalysisCaptureStore } from './AnalysisCaptureStore'
import { SqliteAnalysisCaptureStore } from './SqliteAnalysisCaptureStore'
import { AnalysisQueries } from './AnalysisQueries'
import { AnalysisReanalyzer } from './AnalysisReanalyzer'
import { analysisFailure } from './AnalysisResponses'
import { AnalysisRoomRuntime } from './AnalysisRoomRuntime'
import { AnalysisRoomService } from './AnalysisRoomService'
import { AttributeDictionaryService } from './AttributeDictionaryService'
import { AttributeSnapshotCache } from './AttributeSnapshotCache'
import { AudienceGroupService, type GroupConfigurationRepository } from './AudienceGroupService'

interface ApiOptions {
  store: AnalysisCaptureStore
  capture: AnalysisRoomService
  queries: AnalysisQueries
  dictionaries: AttributeDictionaryService
  groups: AudienceGroupService
  reanalyzer: AnalysisReanalyzer
  runtime: AnalysisRoomRuntime
  capabilities: (scope: AnalysisScope) => AnalysisCapabilities
  onChanged?: (event: AnalysisChanged) => void
  onLifecycle?: (session: AnalysisSession) => void
  auditHealthy?: () => boolean
  onAudit?: (event: {
    traceId: string
    action: string
    accountId?: string
    status: 'accepted' | 'done' | 'failed'
    code?: string
    actor?: 'ui' | 'api' | 'system'
    platform?: LiveControlPlatform
    source?: AnalysisScope['source']
    sessionId?: string
    jobId?: string
    revision?: number
    mappingVersion?: number
    expected?: string
    actual?: string
    counters?: AnalysisSession['counters']
    bytes?: number
  }) => void
}
export class AnalysisRoomApi {
  readonly ready: Promise<void>
  private closed = false
  private closing?: Promise<void>
  private requests = new Set<Promise<AnalysisResponse>>()
  private changes = new Map<string, AnalysisChanged>()
  private scopes = new Map<string, AnalysisScope>()
  private timer?: ReturnType<typeof setTimeout>
  private unsubscribe: () => void
  private unsubscribeHistory: () => void
  private auditDegraded = false
  private lifecycleStates = new Map<string, string>()
  private health(): AnalysisHealth {
    const storage = this.options.store.recoveryHealth()
    const historyErrors = this.options.reanalyzer.recoveryErrors.length
      ? ['HISTORY_UNREADABLE']
      : []
    const auditHealthy = !this.auditDegraded && this.options.auditHealthy?.() !== false
    return {
      storage: {
        healthy: storage.healthy && !historyErrors.length,
        errorCodes: [...storage.errorCodes, ...historyErrors].slice(0, 20),
      },
      audit: { healthy: auditHealthy, errorCodes: !auditHealthy ? ['AUDIT_WRITE_FAILED'] : [] },
    }
  }
  constructor(private options: ApiOptions) {
    this.ready = Promise.all([
      options.store.recover(),
      options.dictionaries.ready,
      options.reanalyzer.ready,
    ]).then(() => {})
    this.ready.catch(() => {})
    this.unsubscribe = options.store.onChanged(session => {
      const signature = JSON.stringify([session.status, session.complete, session.reason])
      if (this.lifecycleStates.get(session.id) !== signature) {
        this.lifecycleStates.delete(session.id)
        this.lifecycleStates.set(session.id, signature)
        this.options.onLifecycle?.(session)
        while (this.lifecycleStates.size > 1000)
          this.lifecycleStates.delete(this.lifecycleStates.keys().next().value ?? '')
        this.audit({
          traceId: randomUUID(),
          action: 'capture.lifecycle',
          actor: 'system',
          accountId: session.scope.accountId,
          platform: session.scope.platform,
          source: session.scope.source,
          sessionId: session.id,
          mappingVersion: session.mappingVersion,
          expected: 'completed',
          actual: session.status,
          status: ['collecting', 'stopping'].includes(session.status)
            ? 'accepted'
            : session.status === 'completed' && session.complete
              ? 'done'
              : 'failed',
          code:
            session.reason ??
            (!session.complete && session.status === 'completed'
              ? 'ANALYSIS_INCOMPLETE'
              : undefined),
          counters: session.counters,
          bytes: session.bytes,
        })
      }
      this.changed({
        accountId: session.scope.accountId,
        scope: session.scope,
        session,
        samples: [],
        health: this.health(),
      })
    })
    this.unsubscribeHistory = options.reanalyzer.onChanged(job => {
      this.audit({
        traceId: randomUUID(),
        action: 'reanalyze.lifecycle',
        actor: 'system',
        accountId: job.scope.accountId,
        platform: job.scope.platform,
        source: job.scope.source,
        sessionId: job.sessionId,
        jobId: job.id,
        mappingVersion: job.mappingVersion,
        expected: 'completed',
        actual: job.status,
        status:
          job.status === 'running' ? 'accepted' : job.status === 'completed' ? 'done' : 'failed',
        code: job.error,
      })
      this.changed({
        accountId: job.scope.accountId,
        scope: job.scope,
        reanalysis: job,
        samples: [],
        health: this.health(),
      })
    })
  }
  get runtime(): AnalysisRoomRuntime {
    return this.options.runtime
  }
  /** Internal assistant linkage; indexed by session ID in the production store. */
  readSession(scope: AnalysisScope, sessionId: string): AnalysisSession {
    return this.options.store.owned(scope, sessionId)
  }
  private rememberScope(scope: AnalysisScope): void {
    this.scopes.delete(scope.accountId)
    this.scopes.set(scope.accountId, { ...scope })
    while (this.scopes.size > 1000) this.scopes.delete(this.scopes.keys().next().value ?? '')
  }
  private dictionaryChanged(scope: MappingScope, revision: number): void {
    for (const known of this.scopes.values())
      if (known.platform === scope.platform && known.source === scope.source)
        this.changed({
          accountId: known.accountId,
          scope: known,
          dictionaryRevision: revision,
          samples: [],
        })
  }
  private changed(change: AnalysisChanged): void {
    const previous = this.changes.get(change.accountId)
    this.changes.delete(change.accountId)
    this.changes.set(change.accountId, {
      ...previous,
      ...change,
      samples: [...(previous?.samples ?? []), ...change.samples].slice(-10),
    })
    while (this.changes.size > 1000) this.changes.delete(this.changes.keys().next().value ?? '')
    if (!this.timer) {
      this.timer = setTimeout(() => this.flushChanges(), 250)
      this.timer.unref()
    }
  }
  private flushChanges(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const pending = [...this.changes.values()]
    this.changes.clear()
    for (const event of pending) {
      try {
        this.options.onChanged?.(structuredClone(event))
      } catch {}
    }
  }
  private audit(event: Parameters<NonNullable<ApiOptions['onAudit']>>[0]): void {
    try {
      this.options.onAudit?.(event)
    } catch {
      this.auditDegraded = true
      if (event.accountId)
        this.changed({ accountId: event.accountId, samples: [], health: this.health() })
    }
  }
  execute(
    input: AnalysisCommand,
    actor: 'ui' | 'api' = 'api',
    captureOwner?: string,
  ): Promise<AnalysisResponse> {
    const request = this.executeInternal(input, actor, captureOwner)
    this.requests.add(request)
    void request.finally(() => this.requests.delete(request)).catch(() => {})
    return request
  }
  private async executeInternal(
    input: AnalysisCommand,
    actor: 'ui' | 'api',
    captureOwner?: string,
  ): Promise<AnalysisResponse> {
    const traceId = randomUUID()
    let action = 'invalid'
    let accountId: string | undefined
    let auditScope: Partial<AnalysisScope> = {}
    try {
      const command = validateAnalysisCommand(input)
      action = command.action
      accountId =
        'scope' in command.params
          ? command.params.scope.accountId
          : 'accountId' in command.params
            ? command.params.accountId
            : undefined
      auditScope =
        'scope' in command.params
          ? command.params.scope
          : 'platform' in command.params
            ? { platform: command.params.platform, source: command.params.source }
            : {}
      if (this.closed) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析室正在关闭')
      await this.ready
      if (this.closed) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析室正在关闭')
      if ('scope' in command.params) this.rememberScope(command.params.scope)
      else if (command.action === 'mapping-preview')
        this.rememberScope({
          accountId: command.params.accountId,
          platform: command.params.platform,
          source: command.params.source,
        })
      let data: AnalysisCommandResult
      switch (command.action) {
        case 'capabilities': {
          const capability = this.options.capabilities(command.params.scope)
          const store = this.options.store
          const session =
            store instanceof SqliteAnalysisCaptureStore
              ? store.activeSession(command.params.scope)
              : store
                  .list(command.params.scope)
                  .find(session => ['collecting', 'stopping'].includes(session.status))
          data = { ...capability, ...(session ? { activeSession: session } : {}) }
          break
        }
        case 'start': {
          const capability = this.options.capabilities(command.params.scope)
          if (!capability.connected)
            throw new AnalysisError('ANALYSIS_NOT_CONNECTED', '请先连接对应账号的中控台')
          if (!capability.supported || !capability.sources.includes(command.params.scope.source))
            throw new AnalysisError('ANALYSIS_SOURCE_UNSUPPORTED', '该平台来源暂不支持原始业务分析')
          data = await this.options.capture.start(command.params, captureOwner)
          break
        }
        case 'stop':
          data = await this.options.capture.stop(command.params, captureOwner)
          break
        case 'sessions':
          data = await this.options.queries.sessions(command.params)
          break
        case 'records':
          data = await this.options.queries.records(command.params)
          break
        case 'fields':
          data = await this.options.queries.fields(command.params.scope, command.params.sessionId)
          break
        case 'mappings':
          data = this.options.dictionaries.read(
            command.params.platform,
            command.params.source,
            command.params.version,
          )
          break
        case 'mapping-draft':
          data = await this.options.dictionaries.saveDraft(command.params)
          this.dictionaryChanged(command.params, data.revision)
          break
        case 'mapping-preview':
          data = await this.options.dictionaries.preview(command.params)
          break
        case 'mapping-publish':
          data = await this.options.dictionaries.publish(command.params)
          this.dictionaryChanged(command.params, data.revision)
          break
        case 'reanalyze':
          data = await this.options.reanalyzer.start(command.params)
          break
        case 'results':
          data = await this.options.reanalyzer.results(command.params)
          break
        case 'groups-get':
          data = this.options.groups.read(command.params.accountId)
          break
        case 'groups-simulate':
          data = await this.options.groups.simulate(command.params)
          break
        case 'groups-apply': {
          data = await this.options.groups.apply(command.params)
          this.changed({
            accountId: command.params.accountId,
            interactionRevision: data.revision,
            samples: [],
          })
          break
        }
      }
      const result = data as unknown as Record<string, unknown>
      const session = ['start', 'stop'].includes(action) ? (data as AnalysisSession) : undefined
      const job =
        action === 'reanalyze'
          ? (data as import('../../../../shared/analysisRoom').ReanalysisJob)
          : undefined
      this.audit({
        traceId,
        action,
        actor,
        accountId,
        ...auditScope,
        status: ['start', 'reanalyze'].includes(action) ? 'accepted' : 'done',
        expected: ['start', 'reanalyze'].includes(action)
          ? 'accepted'
          : 'validated scoped operation',
        actual: session?.status ?? job?.status ?? 'committed or read',
        sessionId:
          session?.id ??
          job?.sessionId ??
          ('sessionId' in command.params ? command.params.sessionId : undefined),
        jobId: job?.id ?? ('jobId' in command.params ? command.params.jobId : undefined),
        revision: typeof result.revision === 'number' ? result.revision : undefined,
        mappingVersion:
          session?.mappingVersion ??
          job?.mappingVersion ??
          (typeof result.activeVersion === 'number' ? result.activeVersion : undefined),
      })
      return { ok: true, data, traceId, health: this.health() }
    } catch (error) {
      const response = analysisFailure(error, traceId)
      if (!response.ok)
        this.audit({
          traceId,
          action,
          actor,
          accountId,
          ...auditScope,
          expected: 'validated scoped operation',
          actual: 'failed',
          status: 'failed',
          code: response.error.code,
        })
      return { ...response, health: this.health() }
    }
  }
  observeBusiness(observation: BusinessObservation): void {
    if (this.closed) return
    this.rememberScope(observation.scope)
    this.options.runtime.observeBusiness(observation)
    let summary = `序号 ${observation.sequence}；类型 ${(observation.businessType ?? '未知').slice(0, 64)}；${observation.complete ? '完整' : '不完整'}；观察 ${observation.observationId.slice(0, 80)}`
    const chars = [...summary]
    while (Buffer.byteLength(JSON.stringify(summary)) > 512) {
      chars.pop()
      summary = chars.join('')
    }
    this.changed({
      accountId: observation.scope.accountId,
      scope: observation.scope,
      samples: [summary],
    })
  }
  async disconnect(accountId: string, reason: string): Promise<void> {
    this.options.runtime.disconnect(accountId)
    try {
      await this.options.capture.disconnect(accountId, reason)
    } catch {
      this.changed({ accountId, error: 'ANALYSIS_STORAGE_FAILED', samples: [] })
    }
  }
  shutdown(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      await this.ready.catch(() => {})
      const drained = await Promise.allSettled([
        this.options.capture.shutdown(),
        this.options.reanalyzer.shutdown(),
      ])
      await Promise.allSettled([...this.requests])
      if (this.options.store instanceof SqliteAnalysisCaptureStore) await this.options.store.close()
      if (drained.some(result => result.status === 'rejected'))
        this.audit({
          traceId: randomUUID(),
          action: 'shutdown',
          status: 'failed',
          code: 'ANALYSIS_STORAGE_FAILED',
        })
      this.flushChanges()
      this.unsubscribe()
      this.unsubscribeHistory()
      this.lifecycleStates.clear()
      this.scopes.clear()
    })()
    return this.closing
  }
}

export interface AnalysisRoomFactoryOptions {
  root: string
  /** Internal runtime/test asset path; never accepted from HTTP, IPC or MCP. */
  workerFile?: string
  repository: GroupConfigurationRepository
  subscriptions: (scope: AnalysisScope) => CommentSubscriptionCoordinator
  scope: (accountId: string) => AnalysisScope | undefined
  capabilities: ApiOptions['capabilities']
  formatVersion?: (scope: MappingScope) => number | undefined
  hooks?: ConstructorParameters<typeof AnalysisRoomRuntime>[0]['hooks']
  effectiveMode?: ConstructorParameters<typeof AudienceGroupService>[0]['effectiveMode']
  onDecision?: ConstructorParameters<typeof AnalysisRoomRuntime>[0]['onDecision']
  onError?: ConstructorParameters<typeof AnalysisRoomRuntime>[0]['onError']
  onChanged?: ApiOptions['onChanged']
  onLifecycle?: ApiOptions['onLifecycle']
  onAudit?: ApiOptions['onAudit']
  auditHealthy?: ApiOptions['auditHealthy']
}
/** Only the main process calls this factory; every transport reuses its one result. */
export async function createAnalysisRoomApi(
  options: AnalysisRoomFactoryOptions,
): Promise<AnalysisRoomApi> {
  const store = new SqliteAnalysisCaptureStore({
    root: options.root,
    workerFile: options.workerFile,
  })
  try {
    await store.recover()
    const cache = new AttributeSnapshotCache()
    let groups!: AudienceGroupService
    const dictionaries = new AttributeDictionaryService({
      store,
      formatVersion: options.formatVersion,
      enabledGroupReferences: (platform, source) => groups.enabledReferences(platform, source),
      onPublished: dictionary =>
        cache.invalidateDictionary(dictionary.platform, dictionary.source, dictionary.version),
    })
    await dictionaries.ready
    groups = new AudienceGroupService({
      store,
      repository: options.repository,
      dictionary: (platform, source) => dictionaries.published(platform, source),
      hooks: options.hooks,
      effectiveMode: options.effectiveMode,
    })
    const capture = new AnalysisRoomService({
      store,
      subscriptions: options.subscriptions,
      mappingVersion: scope => dictionaries.published(scope.platform, scope.source)?.version,
      formatVersion: scope => options.capabilities(scope).formatVersion,
    })
    const runtime = new AnalysisRoomRuntime({
      groups,
      capture,
      cache,
      scope: options.scope,
      dictionary: (platform, source) => dictionaries.published(platform, source),
      hooks: options.hooks,
      onDecision: options.onDecision,
      onError: options.onError,
    })
    const reanalyzer = new AnalysisReanalyzer({ store, dictionaries })
    const api = new AnalysisRoomApi({
      store,
      capture,
      queries: new AnalysisQueries(store),
      dictionaries,
      groups,
      reanalyzer,
      runtime,
      capabilities: options.capabilities,
      onChanged: options.onChanged,
      onLifecycle: options.onLifecycle,
      onAudit: options.onAudit,
      auditHealthy: options.auditHealthy,
    })
    await api.ready
    return api
  } catch (error) {
    await store.close().catch(() => {})
    throw error
  }
}
