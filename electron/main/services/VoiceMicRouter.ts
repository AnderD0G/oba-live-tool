import type { AssistantVoiceResult } from '../../../shared/assistantVoice'
import type { StudioMicHotkeyResult } from '../../../shared/studioMicHotkey'

export interface VoiceMicOwner {
  accountId: string
  rowId: string
  sessionId: string
}
type VoiceFailure = Extract<AssistantVoiceResult, { ok: false }>
interface Options {
  platform?: string
  toggle: () => Promise<StudioMicHotkeyResult>
  now?: () => number
  wait?: (ms: number) => Promise<void>
}
interface Lease {
  owner: VoiceMicOwner
  active: boolean
  restored: boolean
  sentAt: number
}
const knownUnsent = new Set([
  'STUDIO_MIC_UNSUPPORTED_PLATFORM',
  'STUDIO_MIC_HELPER_UNAVAILABLE',
  'STUDIO_MIC_PERMISSION_REQUIRED',
  'STUDIO_MIC_NOT_RUNNING',
  'STUDIO_MIC_FOCUS_FAILED',
  'STUDIO_MIC_EVENT_FAILED',
  'STUDIO_MIC_BUSY',
  'STUDIO_MIC_COOLDOWN',
  'STUDIO_MIC_INVALID_COMMAND',
])
function voiceFailure(code: string, message: string): VoiceFailure {
  return { ok: false, error: { code, message } }
}
const same = (a: VoiceMicOwner, b: VoiceMicOwner) =>
  a.accountId === b.accountId && a.rowId === b.rowId && a.sessionId === b.sessionId

/** Expected routing from one fixed pair of events, never an observation of the live microphone. */
export class VoiceMicRouter {
  private lease?: Lease
  private busy = false
  private routeState: 'live' | 'doubao' | 'unknown' = 'live'
  private readonly linked: boolean
  private readonly now: () => number
  private readonly wait: (ms: number) => Promise<void>
  constructor(private readonly options: Options) {
    this.linked = (options.platform ?? process.platform) === 'darwin'
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }
  state() {
    return { linked: this.linked, routeState: this.routeState }
  }
  alignOpen(): { ok: true } | Extract<StudioMicHotkeyResult, { ok: false }> {
    if (this.busy || this.lease?.active)
      return {
        ok: false,
        error: { code: 'STUDIO_MIC_VOICE_BUSY', message: '请先结束或取消豆包录音，再重新对齐' },
      }
    this.lease = undefined
    this.routeState = 'live'
    return { ok: true }
  }
  async manualToggle(): Promise<StudioMicHotkeyResult> {
    if (this.busy || this.lease || this.routeState !== 'live')
      return {
        ok: false,
        error: {
          code: 'STUDIO_MIC_VOICE_BUSY',
          message: '豆包联动正在使用麦克风，或需要先恢复开麦并重新对齐',
        },
      }
    this.busy = true
    try {
      const result = await this.options.toggle()
      if (result.ok || !knownUnsent.has(result.error.code)) this.routeState = 'unknown'
      return result
    } catch {
      this.routeState = 'unknown'
      return {
        ok: false,
        error: { code: 'STUDIO_MIC_TIMEOUT', message: '热键结果未确认，请恢复 TK 开麦后重新对齐' },
      }
    } finally {
      this.busy = false
    }
  }
  async acquire(owner: VoiceMicOwner): Promise<VoiceFailure | undefined> {
    if (!this.linked) return
    if (this.busy || this.lease || this.routeState !== 'live')
      return voiceFailure(
        'VOICE_MIC_BLOCKED',
        '麦克风联动尚未就绪，请先结束录音或恢复 TK 开麦后重新对齐',
      )
    this.busy = true
    try {
      const result = await this.options.toggle()
      if (!result.ok) {
        if (!knownUnsent.has(result.error.code)) this.routeState = 'unknown'
        return voiceFailure('VOICE_MIC_BLOCKED', result.error.message)
      }
      this.lease = { owner: { ...owner }, active: true, restored: false, sentAt: this.now() }
      this.routeState = 'doubao'
    } catch {
      this.routeState = 'unknown'
      return voiceFailure(
        'VOICE_MIC_BLOCKED',
        '热键操作结果未确认，豆包录音未开始；请恢复 TK 开麦后重新对齐',
      )
    } finally {
      this.busy = false
    }
  }
  async release(owner: VoiceMicOwner): Promise<VoiceFailure | undefined> {
    if (!this.linked || !this.lease) return
    if (!same(this.lease.owner, owner))
      return voiceFailure('VOICE_MIC_BLOCKED', '麦克风联动属于另一条录音')
    this.lease.active = false
    if (this.busy || this.lease.restored || this.routeState === 'unknown')
      return voiceFailure('VOICE_MIC_RESTORE_FAILED', '豆包录音已结束；请恢复 TK 开麦后重新对齐')
    this.busy = true
    this.lease.restored = true
    try {
      const remaining = Math.max(0, 1200 - (this.now() - this.lease.sentAt))
      if (remaining) await this.wait(remaining)
      const result = await this.options.toggle()
      if (!result.ok) {
        this.routeState = 'unknown'
        return voiceFailure(
          'VOICE_MIC_RESTORE_FAILED',
          '豆包录音已结束，直播麦克风恢复未确认；请恢复 TK 开麦后重新对齐',
        )
      }
      this.lease = undefined
      this.routeState = 'live'
    } catch {
      this.routeState = 'unknown'
      return voiceFailure(
        'VOICE_MIC_RESTORE_FAILED',
        '豆包录音已结束，直播麦克风恢复未确认；请恢复 TK 开麦后重新对齐',
      )
    } finally {
      this.busy = false
    }
  }
}
