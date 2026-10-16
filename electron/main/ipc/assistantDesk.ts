import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, globalShortcut } from 'electron'
import { type AnalysisSession, validateAnalysisScope } from '../../../shared/analysisRoom'
import type { AssistantDeskCommand, AssistantDeskResult, AssistantDeskState } from '../../../shared/assistantDesk'
import { validateDeskHttp } from '../../../shared/assistantDeskContract.mjs'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { emitter } from '../event/eventBus'
import { accountManager } from '../managers/AccountManager'
import { createAssistantDiagnostics } from '../services/AssistantDiagnostics'
import { AssistantDeskService } from '../services/assistantDesk/AssistantDeskService'
import { ChromeLocalTranslationService } from '../services/assistantDesk/ChromeLocalTranslationService'
import { CaptureSourceAudit } from '../services/assistantDesk/CaptureSourceAudit'
import { releaseAssistantCapture } from '../services/assistantDesk/releaseCapture'
import type { CommentSubscription } from '../services/CommentSubscriptionCoordinator'
import { ObsRecordingControl } from '../services/ObsRecordingControl'
import { ObsWebSocketClient } from '../services/ObsWebSocketClient'
import { typedIpcMainHandle } from '../utils/ipc'
import { requireAnalysisRoomReady, registerAnalysisShutdown } from './analysisRoom'
import { assistantProviderModel, interpretAssistant, translateAssistantDraft } from './deepSeekAuto'
import { dispatchAssistantLocalEffects,reserveEffectSequence } from './hooks'
import { getObsEffectService, markCurrentObsCamera, markCurrentObsCameraFromShortcut, peekObsEffectOperationQueueState } from './obsEffect'
import { executeMockDeskCommand, getMockRuntime, isMockAssistantSelected } from './mockAssistant'
import { withAssistantSourceTransition } from '../services/mockAssistant/MockSourceBarrier'
import { matchesAssistantSource, type AssistantSourceExpectation } from '../../../shared/mockAssistantControl'

let service: AssistantDeskService | undefined
let localTranslator: ChromeLocalTranslationService | undefined
let sourceAudit: CaptureSourceAudit | undefined
let diagnostics: ReturnType<typeof createAssistantDiagnostics> | undefined
export function getAssistantDesk() {
  if (!service) {
    diagnostics ??= createAssistantDiagnostics(join(app.getPath('userData'), 'logs'))
    sourceAudit = new CaptureSourceAudit({ directory: join(app.getPath('userData'), 'analysis', 'source-audit') })
    localTranslator = new ChromeLocalTranslationService({
      profileDirectory: join(app.getPath('userData'), 'assistant-local-translation'),
    })
    const translator = localTranslator
    const completedMetadata = new Map<string, { startedAt?: number; roomId?: string }>()
    const recording = new ObsRecordingControl(new ObsWebSocketClient(), () =>
      getObsEffectService().getSettings(),
    )
    service = new AssistantDeskService(join(app.getPath('userData'), 'assistant-desk'), {
      interpret: interpretAssistant,
      translateDraft: translateAssistantDraft,
      model: assistantProviderModel,
      send: async (id, text, signal) => {
        const session = accountManager.accountSessions.get(id)
        if (!session || !(await session.sendAssistantReply(text, signal)))
          throw new Error('平台未确认发送成功；请核对直播间及登录状态')
      },
      recording: (id, action) => recording.execute(id, action),
      subscribeTranslations: (accountId, listener) => accountManager.accountSessions.get(accountId)?.subscribeTranslations(listener) ?? (() => {}),
      localTranslate: input => translator.translate(input),
      localTranslationState: () => translator.state(),
      captureMetadata: async (accountId, platform, captureSessionId) => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(captureSessionId)) return undefined
        const key = JSON.stringify([accountId, platform, captureSessionId])
        const cached = completedMetadata.get(key)
        if (cached) return cached
        try {
          const raw = requireAnalysisRoomReady().readSession(validateAnalysisScope({ accountId, platform, source: 'control' }), captureSessionId)
          const metadata = {
            ...(Number.isSafeInteger(raw.createdAt) && raw.createdAt >= 0 ? { startedAt: raw.createdAt as number } : {}),
            ...(typeof raw.roomId === 'string' && raw.roomId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(raw.roomId) ? { roomId: raw.roomId } : {}),
          }
          if (['completed', 'interrupted', 'storage-error'].includes(raw.status)) {
            completedMetadata.set(key, metadata)
            while (completedMetadata.size > 1000) completedMetadata.delete(completedMetadata.keys().next().value ?? '')
          }
          return metadata
        } catch { return undefined }
      },
      onObservedPersisted: (id,message,row) => dispatchAssistantLocalEffects(id,message,row),
      startCapture: async (id, assistantId, onComment, onCaptureCreated) => {
        const session = accountManager.accountSessions.get(id)
        if (!session) throw new Error('请先登录并选直播间')
        const scope = session.getAnalysisScope()
        if (!session.getAnalysisCapabilities(scope).connected)
          throw new Error('直播间未就绪，请先登录并选择直播间')
        const platformState = await session.getPlatformSessionState()
        const target = platformState.loginStatus === 'authenticated' && platformState.roomReady ? platformState.target : undefined
        // Closing can race the Assistant scene's awaited persistence.
        const api = requireAnalysisRoomReady()
        const owner = `assistant:${assistantId}`
        const started = await api.execute(
          { action: 'start', params: { scope, requestId: randomUUID() } },
          'api',
          owner,
        )
        if (!started.ok) throw new Error(started.error.message)
        const capture = started.data as AnalysisSession
        let lease: CommentSubscription | undefined
        try {
          // The raw capture is already durable here; retain its identity even if
          // the separate comment subscription subsequently fails to become ready.
          await onCaptureCreated?.({ captureSessionId: capture.id, startedAt: capture.createdAt, ...(target ? { target: { ...target } } : {}) })
          lease = session.getCommentSubscriptions().acquire(scope, {
            id: `assistant:${assistantId}`,
            onComment: message => {
              reserveEffectSequence(message)
              onComment(message)
            },
          })
          await lease.ready
        } catch (error) {
          await lease?.release().catch(() => {})
          const stopped = await api.execute(
            { action: 'stop', params: { scope, sessionId: capture.id, requestId: randomUUID() } },
            'api',
            owner,
          )
          if (!stopped.ok) throw new Error(stopped.error.message)
          throw error
        }
        const acquired = lease
        return {
          captureSessionId: capture.id,
          captureStartedAt: capture.createdAt,
          ...(target ? { target: { ...target } } : {}),
          release: releaseAssistantCapture(
            () => acquired.release(),
            async () => {
              const stopped = await api.execute(
                {
                  action: 'stop',
                  params: { scope, sessionId: capture.id, requestId: randomUUID() },
                },
                'api',
                owner,
              )
              if (!stopped.ok) throw new Error(stopped.error.message)
            },
          ),
        }
      },
    }, { trace: diagnostics.trace })
  }
  return service
}
export function translateLocalAssistant(input: { text: string; signal: AbortSignal }) {
  getAssistantDesk()
  return localTranslator!.translate(input)
}
export function localAssistantTranslationState() {
  getAssistantDesk()
  return localTranslator!.state()
}
let audienceEffectSync:((accountId:string)=>Promise<void>)|undefined
export async function executeAssistantVoiceScene(accountId: string, rowId: string) {
  const desk = isMockAssistantSelected(accountId) ? await getMockRuntime().serviceFor(accountId) : getAssistantDesk()
  return desk.voiceScene(accountId, rowId)
}
export function registerAudienceEffectSync(callback:(accountId:string)=>Promise<void>){audienceEffectSync=callback}
export async function executeAssistantDeskCommand(
  input: AssistantDeskCommand,
  origin: 'api' | 'desktop' | 'mobile' = 'api',
  expectedSource?: AssistantSourceExpectation,
): Promise<AssistantDeskResult> {
  try {
    const command = validateDeskHttp('/assistant/command', input) as AssistantDeskCommand
    if (command.action === 'segment-toggle') {
      const result = await markCurrentObsCamera(command.params)
      return result.ok
        ? { ok: true, data: result.recording }
        : { ok: false, error: { code: 'OBS_RECORDING_MARK_UNCONFIRMED', message: result.error } }
    }
    const run = async (): Promise<AssistantDeskResult> => {
    const reads = new Set(['state', 'storage-status', 'context-get', 'policy-fields', 'policy-get', 'reply-policy-get', 'policy-simulate', 'timeline', 'audience', 'sessions', 'segments', 'segment-summary', 'attention-window', 'message-batches', 'message-batch'])
    if (origin === 'desktop' && ((!reads.has(command.action) && !expectedSource) || expectedSource &&
      !matchesAssistantSource(expectedSource, isMockAssistantSelected(command.params.accountId)
        ? getMockRuntime().status(command.params.accountId).runId ?? 'mock-empty' : undefined)))
      return { ok: false, error: { code: 'ASSISTANT_SOURCE_CHANGED', message: '数据来源已切换，请刷新后重新操作' } }
    if (isMockAssistantSelected(command.params.accountId)) return executeMockDeskCommand(command, origin)
    if (command.action === 'start') {
      const actualPlatform = accountManager.accountSessions
        .get(command.params.accountId)
        ?.getAnalysisScope().platform
      if (!actualPlatform) throw new Error('请先登录并选择直播间')
      if (command.params.platform && command.params.platform !== actualPlatform)
        throw new Error('请求平台与已连接账号不一致')
      command.params.platform = actualPlatform
      // Do this before Service.start can persist a new collecting scene.
      requireAnalysisRoomReady()
    }
    const result = await getAssistantDesk().execute(command)
    if(result.ok&&command.action==='policy-save'&&audienceEffectSync)
      void Promise.resolve().then(()=>audienceEffectSync!(command.params.accountId)).catch(error=>console.error('Audience effect reconciliation:',error instanceof Error?error.message:String(error)))
    if (result.ok && command.action === 'state') return {
      ...result,
      data: { ...(result.data as AssistantDeskState), sourceAudit: sourceAudit?.snapshot(command.params.accountId), obsOperations: peekObsEffectOperationQueueState() },
    }
    return result
    }
    return ['start', 'context-save', 'policy-save', 'reply-policy-save'].includes(command.action)
      ? await withAssistantSourceTransition(command.params.accountId, run) : await run()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'ASSISTANT_INVALID_COMMAND',
        message: error instanceof Error ? error.message : '助播操作失败',
      },
    }
  }
}
export function setupAssistantDeskIpc() {
  getAssistantDesk()
  typedIpcMainHandle(IPC_CHANNELS.assistantDesk.request, (_event, command, expectedSource) =>
    executeAssistantDeskCommand(command, 'desktop', expectedSource),
  )
  emitter.on('business-observation', observation => {
    getAssistantDesk().observeBusiness(observation)
    sourceAudit?.observe(observation)
  })
  emitter.on('analysis-session-changed', session => {
    if (!['completed', 'interrupted', 'storage-error'].includes(session.status)) return
    void getAssistantDesk()
      .disconnect(session.scope.accountId, 'RAW_CAPTURE_ENDED', session.id)
      .catch(() => {})
  })
  emitter.on('business-listener-invalidated', ({ accountId, reason }) => {
    void getAssistantDesk()
      .disconnect(accountId, reason)
      .catch(() => {})
  })
  emitter.on('page-closed', ({ accountId, sessionId }) => {
    const current = accountManager.accountSessions.get(accountId)
    if (sessionId && current && current.instanceId !== sessionId) return
    void getAssistantDesk()
      .disconnect(accountId, 'PAGE_CLOSED')
      .catch(() => {})
  })
  registerAnalysisShutdown(async () => {
    try { await getAssistantDesk().shutdown() }
    finally { await Promise.allSettled([localTranslator?.shutdown(), sourceAudit?.shutdown(), diagnostics?.flush()]) }
  })
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    void markCurrentObsCameraFromShortcut().catch(error => console.error('OBS 打点未确认', error instanceof Error ? error.message : String(error)))
  })
  app.on('will-quit', () => globalShortcut.unregister('CommandOrControl+Shift+M'))
}
