import { randomUUID } from 'node:crypto'
import type { AssistantDeskState } from '../../../shared/assistantDesk'
import type { AssistantVoiceCommand, AssistantVoiceResult } from '../../../shared/assistantVoice'
import { type AssistantDiagnosticContext, type AssistantDiagnosticTrace, runAssistantDiagnosticStage } from './AssistantDiagnostics'
import type { VoiceMicRouter } from './VoiceMicRouter'

type VoicePath = '/api/state' | '/api/rec/start' | '/api/rec/stop' | '/api/rec/cancel'
interface VoiceOptions {
  state: (accountId: string, rowId: string) => Promise<Pick<AssistantDeskState, 'activeSession' | 'rows' | 'attention'>>
  request?: (path: VoicePath, timeoutMs: number) => Promise<unknown>
  trace?: AssistantDiagnosticTrace
  micRouter?: Pick<VoiceMicRouter, 'acquire' | 'release' | 'state'>
}

interface OwnedRecording { accountId: string; rowId: string; sessionId: string }
const MESSAGES: Record<string, string> = {
  VOICE_INVALID_COMMAND: '语音输入参数无效',
  VOICE_BUSY: '语音操作正在进行，请稍候',
  VOICE_SERVICE_BUSY: '豆包正在录音或处理其他操作，请结束后再试',
  VOICE_ALREADY_RECORDING: '当前语音尚未结束，请结束或取消',
  VOICE_NOT_OWNED: '这条消息没有由本助手开启的录音',
  VOICE_NO_ACTIVE_SESSION: '请先开始当前账号的采集',
  VOICE_ROW_NOT_FOUND: '这条消息不在当前采集场次，请重新选择',
  VOICE_SESSION_CHANGED: '采集场次或消息已变化，语音结果未填入草稿；如仍在录音请取消',
  VOICE_SERVICE_UNAVAILABLE: '豆包语音服务未就绪或未确认操作结果，请检查本机7799服务',
  VOICE_START_FAILED: '豆包未确认开始录音，请检查登录及麦克风权限',
  VOICE_STOP_FAILED: '豆包未确认结束录音，请检查服务；如仍在录音请取消',
  VOICE_CANCEL_FAILED: '豆包未确认取消录音，请检查服务后再取消',
  VOICE_NO_TEXT: '未识别到文字，请确认麦克风后重试',
}
function failure(code: string): AssistantVoiceResult { return { ok: false, error: { code, message: MESSAGES[code] } } }
function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}
function validCommand(input: unknown): input is AssistantVoiceCommand {
  const command = record(input)
  const validId = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value)
  return !!command && Object.keys(command).length === 3 && Object.keys(command).every(key => ['action', 'accountId', 'rowId'].includes(key)) &&
    ['start', 'stop', 'cancel'].includes(command.action as string) && validId(command.accountId) && validId(command.rowId)
}

/** Fixed local adapter: renderers and phone clients cannot choose a service URL. */
async function localRequest(path: VoicePath, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:7799${path}`, {
    method: path === '/api/state' ? 'GET' : 'POST',
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  })
  if (!response.ok) throw new Error('Voice service HTTP failure')
  return response.json()
}

export class AssistantVoiceCoordinator {
  private owned?: OwnedRecording
  private running = false
  private closing = false
  private operationDone: Promise<void> = Promise.resolve()
  private disposal?: Promise<void>
  constructor(private readonly options: VoiceOptions) {}

  /** Application shutdown waits for an attempted start before cleaning its owner. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closing = true
    this.disposal = (async () => {
      await this.operationDone
      if (!this.owned) return
      const result = await this.cancelOwned(this.owned, { traceId: randomUUID(), action: 'voice.shutdown', ...this.owned })
      if (!result.ok) throw new Error(result.error.message)
    })()
    return this.disposal
  }

  private async cancelOwned(owned: OwnedRecording, context: AssistantDiagnosticContext): Promise<AssistantVoiceResult> {
    const request = this.options.request ?? localRequest
    // Cleanup remains available even if the scene was stopped or switched.
    const preflight = record(await runAssistantDiagnosticStage(this.options.trace, context, 'service-state', () => request('/api/state', 5000)))
    if (!preflight || typeof preflight.recording !== 'boolean' || !(preflight.busy === null || typeof preflight.busy === 'string')) return failure('VOICE_SERVICE_UNAVAILABLE')
    if (preflight.busy) return failure('VOICE_SERVICE_BUSY')
    if (preflight.recording) {
      // Require the dedicated endpoint's explicit stopped flag. No fallback,
      // automatic retry or recognition text can escape this cleanup path.
      const stopped = record(await runAssistantDiagnosticStage(this.options.trace, context, 'rec-cancel', () => request('/api/rec/cancel', 15000)))
      if (stopped?.ok !== true || stopped.recording !== false) return failure('VOICE_CANCEL_FAILED')
    }
    this.owned = undefined
    const micWarning = await this.releaseMic(owned)
    return { ok: true, data: { status: 'cancelled', rowId: owned.rowId, ...this.micResult(micWarning) } }
  }

  private async releaseMic(owned: OwnedRecording): Promise<string | undefined> {
    try { const result = await this.options.micRouter?.release(owned); return result?.error.message }
    catch { return '豆包录音已结束，直播麦克风恢复未确认；请恢复 TK 开麦后重新对齐' }
  }
  private micResult(micWarning?: string) {
    return { ...(micWarning ? { micWarning } : {}), ...(this.options.micRouter ? { routeState: this.options.micRouter.state().routeState } : {}) }
  }
  private startFailure(result: AssistantVoiceResult): AssistantVoiceResult {
    return !result.ok && !this.owned ? { ok: false, error: { ...result.error, code: 'VOICE_START_NOT_STARTED' } } : result
  }

  private current(command: AssistantVoiceCommand, context: AssistantDiagnosticContext, stage: string, expectedSessionId?: string): Promise<string | AssistantVoiceResult> {
    return runAssistantDiagnosticStage(this.options.trace, context, stage, async () => {
      const state = await this.options.state(command.accountId, command.rowId)
      const session = state.activeSession
      if (!session || session.accountId !== command.accountId || session.status !== 'collecting') return failure(expectedSessionId ? 'VOICE_SESSION_CHANGED' : 'VOICE_NO_ACTIVE_SESSION')
      if (expectedSessionId && session.id !== expectedSessionId) return failure('VOICE_SESSION_CHANGED')
      if (![...state.rows, ...(state.attention?.rows ?? [])].some(row => row.id === command.rowId && row.accountId === command.accountId && row.sessionId === session.id))
        return failure(expectedSessionId ? 'VOICE_SESSION_CHANGED' : 'VOICE_ROW_NOT_FOUND')
      context.sessionId = session.id
      return session.id
    })
  }

  async execute(command: AssistantVoiceCommand): Promise<AssistantVoiceResult> {
    if (!validCommand(command)) return failure('VOICE_INVALID_COMMAND')
    const context: AssistantDiagnosticContext = { traceId: randomUUID(), action: `voice.${command.action}`, accountId: command.accountId, rowId: command.rowId,
      ...(this.owned?.accountId === command.accountId && this.owned.rowId === command.rowId ? { sessionId: this.owned.sessionId } : {}) }
    return runAssistantDiagnosticStage(this.options.trace, context, 'operation', () => this.executeOwned(command, context))
  }

  private async executeOwned(command: AssistantVoiceCommand, context: AssistantDiagnosticContext): Promise<AssistantVoiceResult> {
    if (this.closing) return failure('VOICE_SERVICE_UNAVAILABLE')
    if (this.running) return failure('VOICE_BUSY')
    this.running = true
    let operationFinished!: () => void
    this.operationDone = new Promise<void>(resolve => { operationFinished = resolve })
    let micBeforeRecorder: OwnedRecording | undefined
    try {
      const request = this.options.request ?? localRequest
      const owned = this.owned
      if (owned && (owned.accountId !== command.accountId || owned.rowId !== command.rowId)) return failure('VOICE_NOT_OWNED')
      if (command.action === 'start') {
        if (owned) return failure('VOICE_ALREADY_RECORDING')
        const sessionId = await this.current(command, context, 'state-preflight')
        if (typeof sessionId !== 'string') return sessionId
        // Read only busy/recording. Never expose another application's state.text.
        const preflight = record(await runAssistantDiagnosticStage(this.options.trace, context, 'service-state', () => request('/api/state', 5000)))
        if (!preflight || typeof preflight.recording !== 'boolean' || !(preflight.busy === null || typeof preflight.busy === 'string')) return failure('VOICE_SERVICE_UNAVAILABLE')
        if (preflight.recording || preflight.busy) return failure('VOICE_SERVICE_BUSY')
        const before = await this.current(command, context, 'validate-before', sessionId)
        if (typeof before !== 'string') return before
        const micOwner = { accountId: command.accountId, rowId: command.rowId, sessionId }
        const blocked = await this.options.micRouter?.acquire(micOwner)
        if (blocked) return blocked
        micBeforeRecorder = micOwner
        const afterMic = await this.current(command, context, 'validate-after-mic', sessionId)
        if (typeof afterMic !== 'string') { await this.releaseMic(micOwner); micBeforeRecorder = undefined; return this.startFailure(afterMic) }
        // Preserve uncertain ownership after a timeout so an explicit cancel can
        // clean up this start attempt. No automatic stop, release or retry occurs.
        this.owned = { accountId: command.accountId, rowId: command.rowId, sessionId }
        micBeforeRecorder = undefined
        const started = record(await runAssistantDiagnosticStage(this.options.trace, context, 'rec-start', () => request('/api/rec/start', 10000)))
        if (started?.ok !== true) {
          let micWarning: string | undefined
          if (['busy', 'no_button', 'not_recording'].includes(started?.error as string)) {
            this.owned = undefined; micWarning = await this.releaseMic(micOwner)
          } else {
            const cleanup = await this.cancelOwned(micOwner, context)
            if (cleanup.ok) micWarning = cleanup.data.micWarning
          }
          const result = failure(started?.error === 'busy' ? 'VOICE_SERVICE_BUSY' : 'VOICE_START_FAILED')
          if (!result.ok && micWarning) result.error.message += `；${micWarning}`
          return this.startFailure(result)
        }
        const after = await this.current(command, context, 'validate-after', sessionId)
        if (typeof after !== 'string') { await this.cancelOwned(micOwner, context); return this.startFailure(after) }
        return { ok: true, data: { status: 'recording', rowId: command.rowId, ...this.micResult() } }
      }
      if (!owned) return failure('VOICE_NOT_OWNED')
      if (command.action === 'cancel') return await this.cancelOwned(owned, context)
      const before = await this.current(command, context, 'validate-before', owned.sessionId)
      if (typeof before !== 'string') return before
      // The service may wait 30s for recognition. Do not retry a timed-out stop.
      const stopped = record(await runAssistantDiagnosticStage(this.options.trace, context, 'rec-stop', () => request('/api/rec/stop', 45000)))
      if (stopped?.ok !== true) {
        // The documented no_text branch runs only after the microphone stopped.
        // It must not leave ownership that could later release external dictation.
        let micWarning: string | undefined
        if (stopped?.error === 'no_text') { this.owned = undefined; micWarning = await this.releaseMic(owned) }
        const result = failure(stopped?.error === 'no_text' ? 'VOICE_NO_TEXT' : 'VOICE_STOP_FAILED')
        if (!result.ok && micWarning) result.error.message += `；${micWarning}`
        return result
      }
      this.owned = undefined
      const micWarning = await this.releaseMic(owned)
      const after = await this.current(command, context, 'validate-after', owned.sessionId)
      if (typeof after !== 'string') return after
      if (typeof stopped.text !== 'string' || !stopped.text.trim() || stopped.text.length > 1000) return failure('VOICE_NO_TEXT')
      return { ok: true, data: { status: 'stopped', rowId: command.rowId, text: stopped.text.trim(), ...this.micResult(micWarning) } }
    } catch {
      // A failed/abandoned start is cleaned only after the recorder confirms it stopped.
      // If that acknowledgement is unavailable, retain ownership for explicit cancel.
      if (command.action === 'start' && this.owned?.accountId === command.accountId && this.owned.rowId === command.rowId) {
        try { await this.cancelOwned(this.owned, context) } catch { /* Keep uncertain ownership. */ }
      }
      if (micBeforeRecorder) await this.releaseMic(micBeforeRecorder)
      return command.action === 'start' ? this.startFailure(failure('VOICE_SERVICE_UNAVAILABLE')) : failure('VOICE_SERVICE_UNAVAILABLE')
    }
    finally { this.running = false; operationFinished() }
  }
}
