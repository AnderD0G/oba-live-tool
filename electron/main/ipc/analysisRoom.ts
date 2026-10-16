import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import {
  type AnalysisCapabilities,
  type AnalysisCommand,
  AnalysisError,
  type AnalysisResponse,
  type AnalysisScope,
  validateAnalysisCommand,
} from '../../../shared/analysisRoom'
import type { AuditDraft } from '../../../shared/audit'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { emitter } from '../event/eventBus'
import { accountManager } from '../managers/AccountManager'
import { analysisFailure } from '../services/analysisRoom/AnalysisResponses'
import { createAnalysisQuitHandler } from '../services/analysisRoom/AnalysisShutdown'
import {
  type AnalysisRoomApi,
  createAnalysisRoomApi,
} from '../services/analysisRoom/AnalysisRoomApi'
import { typedIpcMainHandle } from '../utils/ipc'
import windowManager from '../windowManager'
import { recordAudit } from './audit'
import { getAnalysisHookSummaries } from './hooks'
import {
  currentInteractionMode,
  interactionGroupRepository,
  setAnalysisInteractionRuntime,
  setAnalysisReadinessGate,
} from './interactionRouting'

let singleton: Promise<AnalysisRoomApi> | undefined
let readyApi: AnalysisRoomApi | undefined
let initializationError: AnalysisError | undefined
let closing = false
let shutdown: Promise<void> | undefined
let setup: Promise<void> | undefined
let auditWriteFailed = false
const shutdownDependents=new Set<()=>Promise<void>>()
export function registerAnalysisShutdown(callback:()=>Promise<void>){
  if (closing) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析服务正在关闭')
  shutdownDependents.add(callback)
}
function recordAnalysisAudit(entry: AuditDraft): boolean {
  const saved = recordAudit(entry)
  if (!saved) auditWriteFailed = true
  return saved
}
function capabilities(scope: AnalysisScope): AnalysisCapabilities {
  return (
    accountManager.accountSessions.get(scope.accountId)?.getAnalysisCapabilities(scope) ?? {
      scope: { ...scope },
      connected: false,
      supported: false,
      sources: [],
      limits: { maxBytes: 131072, maxDepth: 16 },
      reason: '请先连接对应账号的中控台',
    }
  )
}
export function getAnalysisRoomApi(): Promise<AnalysisRoomApi> {
  if (closing) return Promise.reject(new AnalysisError('ANALYSIS_UNAVAILABLE', '分析服务正在关闭'))
  if (!singleton) {
    singleton = createAnalysisRoomApi({
      root: join(app.getPath('userData'), 'analysis-sqlite'),
      repository: interactionGroupRepository(),
      effectiveMode: currentInteractionMode,
      capabilities,
      subscriptions: scope => {
        const session = accountManager.accountSessions.get(scope.accountId)
        if (!session || !capabilities(scope).connected)
          throw new AnalysisError('ANALYSIS_NOT_CONNECTED', '中控台连接已断开')
        return session.getCommentSubscriptions()
      },
      scope: accountId => {
        const session = accountManager.accountSessions.get(accountId)
        const scope = session?.getAnalysisScope()
        return scope && capabilities(scope).connected ? scope : undefined
      },
      formatVersion: scope => {
        for (const session of accountManager.accountSessions.values()) {
          const current = session.getAnalysisScope()
          if (current.platform === scope.platform) {
            const capability = session.getAnalysisCapabilities({ ...current, source: scope.source })
            if (capability.connected && capability.supported) return capability.formatVersion
          }
        }
        return undefined
      },
      hooks: accountId => {
        const platform = accountManager.accountSessions.get(accountId)?.getAnalysisScope().platform
        return platform ? getAnalysisHookSummaries(platform) : []
      },
      onChanged: event => {
        windowManager.send(IPC_CHANNELS.analysisRoom.changed, event)
      },
      onLifecycle: session => emitter.emit('analysis-session-changed',session),
      auditHealthy: () => !auditWriteFailed,
      onAudit: event => {
        const saved = recordAnalysisAudit({
          traceId: event.traceId,
          accountId: event.accountId,
          origin: `analysis-${event.actor ?? 'system'}`,
          platform: event.platform,
          actionId: event.jobId ?? event.sessionId,
          ruleRevision: event.revision?.toString(),
          phase: 'action',
          status: event.status === 'accepted' ? 'pending' : event.status,
          actionType: `analysis.${event.action}`,
          detail: JSON.stringify(event),
        })
        if (!saved) throw new Error('AUDIT_WRITE_FAILED')
      },
      onError: code =>
        recordAnalysisAudit({
          traceId: randomUUID(),
          origin: 'analysis-system',
          phase: 'decision',
          status: 'failed',
          actionType: 'analysis.runtime',
          detail: code,
        }),
      onDecision: (accountId, context, evaluation, observationId, metadata) =>
        recordAnalysisAudit({
          traceId: context.trace?.traceId ?? randomUUID(),
          accountId,
          origin: 'analysis-system',
          platform: metadata?.scope.platform,
          ruleRevision: metadata?.revision.toString(),
          phase: 'decision',
          status: evaluation.winner ? 'matched' : 'skipped',
          ruleId: evaluation.winner?.id,
          actionType: 'analysis.group-evaluation',
          detail: JSON.stringify({
            expected: 'known current attributes and enabled matching strategy',
            actual: evaluation.winner?.id ?? 'legacy',
            memberships: evaluation.memberships,
            conditions: evaluation.conditions,
            warnings: evaluation.warnings,
            observationId,
            source: metadata?.scope.source,
            mappingVersion: metadata?.mappingVersion,
          }),
        }),
    })
      .then(api => {
        if (!closing) {
          readyApi = api
          setAnalysisInteractionRuntime(api.runtime)
        }
        return api
      })
      .catch(error => {
        // Retain only a fixed-format storage code; arbitrary error text may
        // contain private paths or values and must not enter the audit.
        const candidate = error instanceof Error
          ? (error as Error & { code?: unknown }).code ?? error.message : undefined
        const cause = typeof candidate === 'string' && /^FRESH_[A-Z0-9_]{1,64}$/.test(candidate)
          ? candidate : 'INITIALIZATION_FAILED'
        initializationError = new AnalysisError(
          'ANALYSIS_STORAGE_FAILED',
          '分析室初始化失败；已保留原始证据，请检查本机存储',
          true,
        )
        const response = analysisFailure(initializationError)
        recordAnalysisAudit({ traceId: response.traceId, origin: 'human-ai', phase: 'action', status: 'failed', actionType: 'analysis.initialize', detail: JSON.stringify({ code: 'ANALYSIS_STORAGE_FAILED', cause }) })
        throw initializationError
      })
    singleton.catch(() => {})
  }
  return singleton.then(api => {
    if (closing) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析服务正在关闭')
    return api
  })
}
/** Public requests never wait in a payload queue behind retained-evidence recovery. */
export function requireAnalysisRoomReady(): AnalysisRoomApi {
  if (closing) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析服务正在关闭')
  if (initializationError) throw initializationError
  if (readyApi) return readyApi
  if (!singleton) void getAnalysisRoomApi().catch(() => {})
  throw new AnalysisError('ANALYSIS_UNAVAILABLE', '分析数据正在恢复，请稍后重试；尚未开始新的采集', true)
}
export async function executeAnalysisRoomCommand(command: AnalysisCommand, actor: 'ui' | 'api' = 'api'): Promise<AnalysisResponse> {
  try {
    // The ready API owns validation/audit (including invalid-operation failures).
    if (!closing && readyApi) return await readyApi.execute(command, actor)
    const validated = validateAnalysisCommand(command)
    return await requireAnalysisRoomReady().execute(validated, actor)
  } catch (error) { return analysisFailure(error) }
}
/** Both native close paths drain one existing owner; cold close never creates storage. */
export function shutdownAnalysisServices(): Promise<void> {
  if (shutdown) return shutdown
  closing = true
  setAnalysisInteractionRuntime(undefined)
  shutdown = (async () => {
    try {
      await Promise.allSettled([...shutdownDependents].map(callback => Promise.resolve().then(callback)))
      if (singleton) await (await singleton).shutdown()
    } finally { readyApi = undefined }
  })()
  return shutdown
}
export function setupAnalysisRoomIpcHandlers(): Promise<void> {
  if (setup) return setup
  setup = (async () => {
    app.on('before-quit', createAnalysisQuitHandler({
      shutdown: shutdownAnalysisServices,
      quit: () => app.quit(),
    }))
    setAnalysisReadinessGate(requireAnalysisRoomReady, () => !closing && !!readyApi)
    typedIpcMainHandle(IPC_CHANNELS.analysisRoom.request, (_event, command) => executeAnalysisRoomCommand(command, 'ui'))
    emitter.on('business-observation', observation => readyApi?.observeBusiness(observation))
    emitter.on('business-listener-invalidated', ({ accountId, reason }) => {
      void readyApi?.disconnect(accountId, reason).catch(() => {})
    })
    emitter.on('page-closed', ({ accountId, sessionId }) => {
      const current = accountManager.accountSessions.get(accountId)
      if (sessionId && current && current.instanceId !== sessionId) return
      void readyApi?.disconnect(accountId, 'PAGE_CLOSED').catch(() => {})
    })
  })()
  return setup
}
