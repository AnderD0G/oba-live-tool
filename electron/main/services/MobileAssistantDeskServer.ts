import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { compareAssistantAttentionRows } from '../../../shared/assistantAttentionOrder'
import type { AssistantDeskCommand, AssistantDeskResult, AssistantDeskRow, AssistantDeskState } from '../../../shared/assistantDesk'
import { validateDeskHttp } from '../../../shared/assistantDeskContract.mjs'
import type { AssistantVoiceCommand, AssistantVoiceResult } from '../../../shared/assistantVoice'
import { MOBILE_ASSISTANT_ACTIONS, type MobileAssistantAccessStatus, type MobileAssistantDeskSnapshot, type MobileAssistantCameraCommand, type MobileAssistantCameraState, type MobileStudioMicCommand, type MobileCameraRecordingCommand, type MobileCameraRecordingState } from '../../../shared/mobileAssistantDesk'
import type { ObsEffectResponse } from '../../../shared/obsEffect'
import type { StudioMicHotkeyResult } from '../../../shared/studioMicHotkey'
import type { XiaomiCameraCommand, XiaomiCameraResult } from '../../../shared/xiaomiCamera'
import type { AssistantDiagnosticContext, AssistantDiagnosticTrace } from './AssistantDiagnostics'

export interface MobileAssistantDeskServerOptions {
  accountId: string
  accountName: string
  assetDirectory: string
  execute: (command: AssistantDeskCommand) => Promise<AssistantDeskResult>
  voice?: (command: AssistantVoiceCommand) => Promise<AssistantVoiceResult>
  camera?: (command: MobileAssistantCameraCommand) => Promise<ObsEffectResponse>
  cameraRecording?: (command: MobileCameraRecordingCommand) => Promise<ObsEffectResponse>
  studioMic?: (command: MobileStudioMicCommand) => Promise<StudioMicHotkeyResult>
  xiaomi?: (command: Exclude<XiaomiCameraCommand, { action: 'config-get' } | { action: 'config-save' } | { action: 'preview-cancel' }>, signal?: AbortSignal) => Promise<XiaomiCameraResult>
  voiceScene?: (accountId: string, rowId: string) => Promise<Pick<AssistantDeskState, 'activeSession' | 'rows' | 'attention'>>
  trace?: AssistantDiagnosticTrace
  host?: string
  port?: number
  addresses?: () => string[]
  now?: () => number
}

function projectRow(row: AssistantDeskRow): AssistantDeskRow {
  const output: AssistantDeskRow = {
    id: row.id, accountId: row.accountId, sessionId: row.sessionId, platform: row.platform,
    receivedAt: row.receivedAt, nickname: row.nickname, kind: row.kind, original: row.original,
    translation: { status: row.translation.status }, reply: { status: row.reply.status },
  }
  for (const key of ['mentionHandle', 'mentionWarning', 'likeCount', 'payLevel', 'fansClubLevel', 'followerCount'] as const) {
    if (row[key] !== undefined) Object.assign(output, { [key]: row[key] })
  }
  if (row.replyLanguageHint) output.replyLanguageHint = { language: row.replyLanguageHint.language, source: row.replyLanguageHint.source }
  for (const key of ['source', 'method', 'language', 'chinese', 'error'] as const) {
    if (row.translation[key] !== undefined) Object.assign(output.translation, { [key]: row.translation[key] })
  }
  if (row.translation.fallback) {
    const fallback = row.translation.fallback
    output.translation.fallback = { source: fallback.source, chinese: fallback.chinese,
      ...(fallback.method ? { method: fallback.method } : {}), ...(fallback.language ? { language: fallback.language } : {}) }
  }
  if (row.translation.manualAttempt) output.translation.manualAttempt = {
    status: row.translation.manualAttempt.status, message: row.translation.manualAttempt.message,
  }
  for (const key of ['text', 'chinese', 'targetLanguage', 'sentAt'] as const) {
    if (row.reply[key] !== undefined) Object.assign(output.reply, { [key]: row.reply[key] })
  }
  if (row.reply.draftTranslation) output.reply.draftTranslation = { status: row.reply.draftTranslation.status, requestId: row.reply.draftTranslation.requestId }
  if (row.gift) {
    output.gift = { final: row.gift.final, contributed: row.gift.contributed }
    for (const key of ['name', 'count', 'unitCoins', 'totalCoins'] as const) {
      if (row.gift[key] !== undefined) Object.assign(output.gift, { [key]: row.gift[key] })
    }
  }
  if (row.triage) {
    // Keep the existing row type while withholding rule evaluation, manual notes and evidence.
    output.triage = { policyRevision: row.triage.policyRevision, tier: row.triage.tier, label: row.triage.label,
      autoAttention: row.triage.autoAttention, messageCategory: row.triage.messageCategory,
      reasons: [], evaluatedRules: [], facts: {}, country: { source: 'unknown', evidenceStrength: 0, evidence: [], uncertainties: [], tagRevision: 0 } }
    for (const key of ['cardColor', 'matchedRuleId'] as const) {
      if (row.triage[key] !== undefined) Object.assign(output.triage, { [key]: row.triage[key] })
    }
    const attention = row.triage.attention
    if (attention) {
      output.triage.attention = { source: attention.source, reviewDueAt: attention.reviewDueAt, reviewDue: attention.reviewDue }
      for (const key of ['deferredUntil', 'pinRevision'] as const) {
        if (attention[key] !== undefined) Object.assign(output.triage.attention, { [key]: attention[key] })
      }
    }
  }
  return output
}

function projectWindow(window: NonNullable<AssistantDeskState['attention']>['window']): MobileAssistantDeskSnapshot['window'] {
  if (!window) return undefined
  const output: NonNullable<MobileAssistantDeskSnapshot['window']> = {
    id: window.id, startedAt: window.startedAt, endsAt: window.endsAt, intervalSeconds: window.intervalSeconds,
  }
  for (const key of ['active', 'paused', 'remainingMs'] as const) {
    if (window[key] !== undefined) Object.assign(output, { [key]: window[key] })
  }
  return output
}

/** Phone access has no historical scene fallback and no configuration or audience record lists. */
export function projectMobileAssistantState(state: AssistantDeskState, accountId: string, accountName: string, serverNow: number): MobileAssistantDeskSnapshot {
  const active = state.activeSession
  const session = active?.accountId === accountId && active.endedAt === undefined && ['collecting', 'storage-error'].includes(active.status) ? active : undefined
  const collecting = session?.status === 'collecting'
  const current = (row: AssistantDeskRow) => !!session && row.accountId === accountId && row.sessionId === session.id
  const tasks = (state.attention?.rows ?? []).filter(current)
  const taskIds = new Set(tasks.map(row => row.id))
  const pinnedRowIds = (state.attention?.pinnedRowIds ?? []).filter(id => taskIds.has(id))
  const pins = new Set(pinnedRowIds)
  tasks.sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || compareAssistantAttentionRows(a, b, state.audiencePolicy?.enabled ?? true))
  const room: AssistantDeskState['room'] = { status: state.room.status }
  for (const key of ['onlineCount', 'totalUser', 'anonymous', 'receivedAt', 'ageMs', 'source'] as const) {
    if (state.room[key] !== undefined) Object.assign(room, { [key]: state.room[key] })
  }
  const ai = state.ai
  const health = state.health
  const segments = collecting && !state.currentMarker ? state.segments.filter(segment => segment.accountId === accountId && segment.sessionId === session.id && segment.captureSessionId === session.captureSessionId) : []
  const marker = collecting && state.currentMarker ? state.currentMarker : { open: segments.find(segment => segment.endedAt === undefined), completed: segments.filter(segment => segment.endedAt !== undefined).length }
  const openSegment = marker.open
  return {
    accountId, accountName, serverNow, collecting, captureActive: !!session,
    ...(state.provenance?.mode === 'mock' ? {
      provenance: { mode: 'mock' as const, runId: state.provenance.runId },
      mockReplyTarget: { ready: state.mockReplyTarget?.ready === true,
        ...(typeof state.mockReplyTarget?.username === 'string' ? { username: state.mockReplyTarget.username } : {}) },
    } : {}),
    ...(session ? { sessionId: session.id, captureStatus: session.status as 'collecting' | 'storage-error' } : {}),
    rows: state.rows.filter(current).map(projectRow), tasks: tasks.map(projectRow),
    totalTasks: session ? Math.max(state.attention?.total ?? 0, tasks.length) : 0, pinnedRowIds,
    marker: { ...(openSegment ? { open: { id: openSegment.id, name: openSegment.name, startedAt: openSegment.startedAt } } : {}), completed: marker.completed },
    ...(session && state.attention?.window ? { window: projectWindow(state.attention.window) } : {}), room,
    ai: { used: ai.used, limit: ai.limit, queued: ai.queued, running: ai.running, paused: ai.paused, ...(ai.pauseReason ? { pauseReason: ai.pauseReason } : {}) },
    health: { status: health.status, pendingWrites: health.pendingWrites, dropped: health.dropped, recoveryWarnings: health.recoveryWarnings },
    audienceRules: (state.audiencePolicy?.enabled ? state.audiencePolicy.rules.filter(rule => rule.enabled) : []).map(rule => ({ id: rule.id, label: rule.result.label || rule.label, tier: rule.result.tier, ...(rule.result.cardColor ? { color: rule.result.cardColor } : {}) })),
  }
}

const MAX_BODY_BYTES = 16 * 1024
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
const SAFE_MESSAGES: Record<string, string> = {
  STALE_DRAFT: '草稿已更新，请重新确认最新文本',
  REPLY_CHANGED: '这条消息或草稿已更新，请刷新后重试',
  REPLY_NOT_REVIEW: '该回复不处于待审核状态，请刷新',
  REPLY_NOT_EDITABLE: '当前回复不能编辑，请刷新',
  ROW_NOT_FOUND: '当前账号没有这条消息，请刷新',
  ATTENTION_WINDOW_CHANGED: '批次已更新，请刷新后重试',
  ATTENTION_CHANGED: '这条任务已被重新钉住或更新，请刷新后重试',
  ATTENTION_NOT_ACTIVE: '当前没有采集中的任务批次',
  ATTENTION_ARCHIVED: '这条任务已归档，请处理当前批次',
  ATTENTION_NOT_AVAILABLE: '这条消息当前不能进行此操作，请刷新',
  ATTENTION_LIMIT: '钉住任务已达上限，请先处理现有任务',
  NO_ACTIVE_SESSION: '当前没有采集中的场次',
  MOBILE_SESSION_CHANGED: '采集场次已更新，请刷新后重试',
  SEGMENT_CHANGED: '打点状态已更新，请确认当前片段后重试',
  SEGMENT_LIMIT: '打点片段已达上限，请在电脑端检查',
  REQUEST_CONFLICT: '这次操作内容已变化，请刷新后重试',
  TRANSLATION_LANGUAGE_UNKNOWN: '观众语言尚未确定，请先选择回复语言后重试',
  AI_TRANSLATION_UNAVAILABLE: '回复翻译服务尚未连接，请在电脑端检查',
  AI_TRANSLATION_FAILED: '翻译未完成，中文草稿已保留，请重试',
  AI_REQUEST_LIMIT: '本场 AI 请求已达上限，请在电脑端检查额度',
  AI_BUSY: '翻译任务较多，请稍后重试',
  AI_PAUSED: 'AI 已暂停或正在更新设置，请在电脑端检查',
  AI_NOT_ACTIVE: '当前场次不可处理，请先检查采集状态',
  AI_INTERRUPTED: '操作已取消，草稿已保留，请重新确认后重试',
  ATTENTION_EXPIRED: '这条消息已过期或不在当前场次，请处理当前消息',
  PREVIOUS_REQUEST_FAILED: '此前操作失败，请重新提交本次操作',
  SEND_FAILED: '发送未成功，请先核对直播间消息后再重试',
  VOICE_INVALID_COMMAND: '语音输入参数无效',
  VOICE_BUSY: '语音操作正在进行，请稍候',
  VOICE_SERVICE_BUSY: '豆包正在录音或处理其他操作，请结束后再试',
  VOICE_ALREADY_RECORDING: '当前语音尚未结束，请结束或取消',
  VOICE_NOT_OWNED: '这条消息没有由本助手开启的录音',
  VOICE_NO_ACTIVE_SESSION: '请先开始当前账号的采集',
  VOICE_ROW_NOT_FOUND: '这条消息不在当前采集场次，请重新选择',
  VOICE_SESSION_CHANGED: '采集场次或消息已变化，语音结果未填入草稿；如仍在录音请取消',
  VOICE_SERVICE_UNAVAILABLE: '豆包语音服务未就绪或未确认操作结果，请检查电脑上的语音服务',
  VOICE_START_FAILED: '豆包未确认开始录音，请检查登录及麦克风权限',
  VOICE_STOP_FAILED: '豆包未确认结束录音；如仍在录音请取消',
  VOICE_CANCEL_FAILED: '豆包未确认取消录音，请检查服务后再取消',
  VOICE_NO_TEXT: '未识别到文字，请确认麦克风后重试',
  STUDIO_MIC_UNSUPPORTED_PLATFORM: '此麦克风热键当前仅支持 Mac，请在电脑端检查',
  STUDIO_MIC_HELPER_UNAVAILABLE: '麦克风热键助手未就绪，请在电脑端检查',
  STUDIO_MIC_PERMISSION_REQUIRED: '尚未获得 Mac 辅助功能权限，请在电脑端授权',
  STUDIO_MIC_NOT_RUNNING: '请先在电脑上打开 TikTok LIVE Studio',
  STUDIO_MIC_FOCUS_FAILED: '无法激活 TikTok LIVE Studio，未发送热键',
  STUDIO_MIC_BUSY: '正在发送麦克风热键，请稍候',
  STUDIO_MIC_COOLDOWN: '操作太快，请稍后再切换麦克风',
  STUDIO_MIC_TIMEOUT: '热键操作超时，请先核对 TikTok LIVE Studio 麦克风状态',
  STUDIO_MIC_HELPER_FAILED: '热键操作结果未确认，请在电脑端核对麦克风状态',
  STUDIO_MIC_INVALID_RESPONSE: '热键状态未确认，请在电脑端检查',
  STUDIO_MIC_VOICE_BUSY: '请先结束豆包录音，或重新读取麦克风状态',
  STUDIO_MIC_API_INVALID_COMMAND: '麦克风操作参数无效',
  STUDIO_MIC_API_UNAVAILABLE: 'TK Studio 麦克风接口未连接，请在电脑端检查',
  STUDIO_MIC_API_INVALID_RESPONSE: '麦克风接口状态无效，请重新读取状态',
  STUDIO_MIC_API_UNCONFIRMED: '麦克风操作未确认，请重新读取状态',
  STUDIO_MIC_API_BUSY: '麦克风操作正在进行，请稍候',
  STUDIO_MIC_API_TIMEOUT: '麦克风操作超时，请重新读取状态；不会自动重复切换',
  VOICE_MIC_BLOCKED: '麦克风联动未就绪，请检查 TK Studio 或重新读取麦克风状态',
  VOICE_START_NOT_STARTED: '豆包录音未开始，请检查语音服务和麦克风权限后重试',
}

function failure(code: string, message = '操作未完成，请刷新后重试'): Extract<AssistantDeskResult, { ok: false }> {
  return { ok: false, error: { code, message } }
}

function publicFailure(result: Extract<AssistantDeskResult, { ok: false }>): AssistantDeskResult {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code) ? result.error.code : 'MOBILE_ASSISTANT_FAILED'
  return failure(code, SAFE_MESSAGES[code])
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0, failed = false
    request.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        chunks.length = 0
        reject(new HttpFailure(413, 'MOBILE_BODY_TOO_LARGE', '请求超过16KiB上限'))
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      if (failed) return
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new HttpFailure(400, 'MOBILE_INVALID_COMMAND', '请求内容无效')) }
    })
    request.on('error', () => reject(new HttpFailure(400, 'MOBILE_INVALID_COMMAND', '请求内容无效')))
  })
}

export function mobileAssistantNetworkAddresses(interfaces = networkInterfaces()): string[] {
  const rank = (name: string, address: string) => {
    const adapter = /vethernet|virtual|tap|tun|vpn|wsl|docker|tailscale|zerotier|clash/i.test(name) ? 20 : /wi-?fi|wlan|ethernet/i.test(name) ? 0 : 10
    const privateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
    return adapter + (privateLan ? 0 : 1)
  }
  return Object.entries(interfaces).flatMap(([name, values]) => (values ?? []).map(address => ({ name, ...address })))
    .filter(address => address.family === 'IPv4' && !address.internal)
    .sort((a, b) => rank(a.name, a.address) - rank(b.name, b.address))
    .map(address => address.address)
}

interface Access {
  server: Server
  token: string
  active: boolean
  port: number
  hosts: Set<string>
  urls: string[]
  startedAt: number
}

export class MobileAssistantDeskServer {
  private access?: Access
  private lifecycle: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: MobileAssistantDeskServerOptions) {
    validateDeskHttp('/assistant/command', { action: 'state', params: { accountId: options.accountId } })
  }

  private async cameraRecordingCommand(body: unknown): Promise<AssistantDeskResult<MobileCameraRecordingState> & { recording?: MobileCameraRecordingState }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('MOBILE_INVALID_COMMAND', '录像打点参数无效')
    const input = body as Record<string, unknown>
    const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value)
    const valid = input.action === 'status' ? Object.keys(input).length === 1
      : input.action === 'mark' && Object.keys(input).every(key => ['action', 'runId', 'requestId', 'label'].includes(key)) && id(input.runId) && id(input.requestId) &&
        (input.label === undefined || typeof input.label === 'string' && input.label.length <= 100 && !/[\u0000-\u001f\u007f]/.test(input.label))
    if (!valid) return failure('MOBILE_INVALID_COMMAND', '录像打点参数无效')
    if (!this.options.cameraRecording) return failure('MOBILE_CAMERA_RECORDING_UNAVAILABLE', '独立录像未就绪，请在电脑端检查')
    const result = await this.options.cameraRecording(input as unknown as MobileCameraRecordingCommand)
    const raw = result.recording
    let recording: MobileCameraRecordingState | undefined
    if (raw && typeof raw.ok === 'boolean' && typeof raw.ready === 'boolean' && typeof raw.running === 'boolean' && Array.isArray(raw.cameras) && Array.isArray(raw.marks)) {
      recording = {
        ok: raw.ok, ready: raw.ready, running: raw.running,
        ...(id(raw.runId) ? { runId: raw.runId } : {}),
        ...(Number.isSafeInteger(raw.startedAt) && raw.startedAt! >= 0 ? { startedAt: raw.startedAt } : {}),
        cameras: raw.cameras.filter(camera => ['iphone', 'android'].includes(camera.target) && typeof camera.active === 'boolean' && typeof camera.owned === 'boolean')
          .map(camera => ({ target: camera.target, active: camera.active, owned: camera.owned })),
        marks: raw.marks.slice(-100).filter(mark => id(mark.runId) && id(mark.requestId) && Number.isSafeInteger(mark.sequence) && mark.sequence >= 0 && ['iphone', 'android'].includes(mark.target) &&
          typeof mark.label === 'string' && mark.label.length <= 100 && typeof mark.chapterName === 'string' && mark.chapterName.length <= 256 &&
          Number.isSafeInteger(mark.offsetMs) && mark.offsetMs >= 0 && Number.isSafeInteger(mark.requestedAt) && mark.requestedAt >= 0 && ['pending', 'confirmed', 'unconfirmed', 'failed'].includes(mark.status))
          .map(mark => ({ runId: mark.runId, requestId: mark.requestId, sequence: mark.sequence, target: mark.target, label: mark.label, chapterName: mark.chapterName, offsetMs: mark.offsetMs, requestedAt: mark.requestedAt, status: mark.status })),
        ...(raw.error || raw.lastMarkError ? { message: '部分录像或章节结果异常，请在电脑端核对' } : {}),
      }
    }
    if (!result.ok || !recording) return { ...failure('MOBILE_CAMERA_RECORDING_UNAVAILABLE', '录像操作结果未确认，请刷新状态并在电脑端核对'), ...(recording ? { recording } : {}) }
    if (input.action === 'mark' && !recording.marks.some(mark => mark.runId === input.runId && mark.requestId === input.requestId && mark.status === 'confirmed'))
      return { ...failure('MOBILE_CAMERA_RECORDING_UNCONFIRMED', '章节结果未确认，请刷新状态后核对，勿重复提交'), recording }
    return { ok: true, data: recording }
  }

  private async cameraCommand(body: unknown): Promise<AssistantDeskResult<MobileAssistantCameraState>> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('MOBILE_INVALID_COMMAND', '机位操作参数无效') as AssistantDeskResult<MobileAssistantCameraState>
    const input = body as Record<string, unknown>
    const valid = input.action === 'status' ? Object.keys(input).length === 1
      : input.action === 'switch' && Object.keys(input).length === 2 && ['android', 'iphone'].includes(input.target as string)
    if (!valid) return failure('MOBILE_INVALID_COMMAND', '机位操作参数无效') as AssistantDeskResult<MobileAssistantCameraState>
    if (!this.options.camera) return failure('MOBILE_CAMERA_UNAVAILABLE', 'OBS 机位控制未就绪，请在电脑端检查') as AssistantDeskResult<MobileAssistantCameraState>
    const result = await this.options.camera(body as MobileAssistantCameraCommand)
    if (!result.ok || !result.cameraStatus?.ok) return failure('MOBILE_CAMERA_UNAVAILABLE', 'OBS 机位未就绪，请检查手机画面和电脑上的 OBS') as AssistantDeskResult<MobileAssistantCameraState>
    const status = result.cameraStatus
    if (input.action === 'switch' && status.selected !== input.target)
      return failure('MOBILE_CAMERA_UNCONFIRMED', '未确认机位已切换，请先检查当前画面') as AssistantDeskResult<MobileAssistantCameraState>
    const data: MobileAssistantCameraState = { available: true, message: status.onProgram === false
      ? '机位场景当前不在直播输出，请在电脑上检查 OBS'
      : input.action === 'switch' ? `已切到${input.target === 'iphone' ? 'iPhone' : '小米'}机位` : 'OBS 机位状态已读取' }
    if (status.selected && ['android', 'iphone', 'both', 'none'].includes(status.selected)) data.selected = status.selected
    for (const key of ['androidEnabled', 'iphoneEnabled', 'onProgram'] as const)
      if (typeof status[key] === 'boolean') Object.assign(data, { [key]: status[key] })
    return { ok: true, data }
  }

  private async studioMicCommand(body: unknown): Promise<AssistantDeskResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('MOBILE_INVALID_COMMAND', '麦克风操作参数无效')
    const input = body as Record<string, unknown>
    if (Object.keys(input).length !== 1 || !['status', 'toggle', 'align-open', 'mute', 'unmute'].includes(input.action as string)) return failure('MOBILE_INVALID_COMMAND', '麦克风操作参数无效')
    if (!this.options.studioMic) return failure('STUDIO_MIC_HELPER_UNAVAILABLE', SAFE_MESSAGES.STUDIO_MIC_HELPER_UNAVAILABLE)
    const result = await this.options.studioMic(body as MobileStudioMicCommand)
    if (!result.ok) return publicFailure(result)
    const data = result.data
    if (data?.backend === 'api') {
      if ([data.supported, data.running, data.accessGranted].some(value => typeof value !== 'boolean') || data.hotkey !== '' ||
        (data.supported ? !['muted', 'unmuted'].includes(data.micState) || !data.running || !data.accessGranted : data.micState !== 'unknown'))
        return failure('STUDIO_MIC_API_INVALID_RESPONSE', SAFE_MESSAGES.STUDIO_MIC_API_INVALID_RESPONSE)
      return { ok: true, data: { supported: data.supported, running: data.running, accessGranted: data.accessGranted,
        backend: 'api', hotkey: '', micState: data.micState,
        ...(typeof data.beforeMuted === 'boolean' ? { beforeMuted: data.beforeMuted } : {}),
        ...(data.routeState && ['live', 'doubao', 'unknown'].includes(data.routeState) ? { routeState: data.routeState } : {}),
        ...(typeof data.linked === 'boolean' ? { linked: data.linked } : {}),
        message: !data.supported ? '此麦克风接口当前仅在 Mac 启用' : data.micState === 'muted' ? 'TK Studio 麦克风已静音' : 'TK Studio 麦克风已开麦' } }
    }
    if (!data || data.micState !== 'unknown' || data.hotkey !== 'Control+Option+M' ||
      [data.supported, data.running, data.accessGranted].some(value => typeof value !== 'boolean') ||
      (input.action === 'toggle' && data.sent !== true)) return failure('STUDIO_MIC_INVALID_RESPONSE', SAFE_MESSAGES.STUDIO_MIC_INVALID_RESPONSE)
    return { ok: true, data: { supported: data.supported, running: data.running, accessGranted: data.accessGranted,
      hotkey: 'Control+Option+M', micState: 'unknown', ...(input.action === 'toggle' && data.sent ? { sent: true } : {}),
      ...(data.routeState && ['live', 'doubao', 'unknown'].includes(data.routeState) ? { routeState: data.routeState } : {}),
      ...(typeof data.linked === 'boolean' ? { linked: data.linked } : {}),
      message: input.action === 'toggle' ? '已发送切换热键，请在 TikTok LIVE Studio 核对直播麦克风状态' : !data.supported ? SAFE_MESSAGES.STUDIO_MIC_UNSUPPORTED_PLATFORM
        : !data.running ? SAFE_MESSAGES.STUDIO_MIC_NOT_RUNNING : !data.accessGranted ? SAFE_MESSAGES.STUDIO_MIC_PERMISSION_REQUIRED : '热键助手已就绪；直播麦克风状态仍需在 TikTok LIVE Studio 核对' } }
  }

  private async xiaomiCommand(body: unknown, signal?: AbortSignal): Promise<AssistantDeskResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('MOBILE_INVALID_COMMAND', '镜头操作参数无效')
    const input = body as Record<string, unknown>
    const simple = ['status', 'settings', 'start', 'stop', 'autofocus', 'preview'].includes(input.action as string)
    const number = (value: unknown, minimum: number, maximum: number) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    const valid = simple ? Object.keys(input).length === 1 : input.action === 'zoom'
      ? Object.keys(input).length === 2 && number(input.ratio, 1, 10)
      : input.action === 'focus' && Object.keys(input).length === 4 && number(input.x, 0, 1) && number(input.y, 0, 1)
        && typeof input.previewId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(input.previewId)
    if (!valid) return failure('MOBILE_INVALID_COMMAND', '镜头操作参数无效')
    if (!this.options.xiaomi) return failure('XIAOMI_CONNECTION_FAILED', '小米相机控制未就绪，请在电脑端检查')
    const result = await this.options.xiaomi(body as Exclude<XiaomiCameraCommand, { action: 'config-get' } | { action: 'config-save' } | { action: 'preview-cancel' }>, signal)
    if (!result.ok) {
      const code = result.error?.code && /^XIAOMI_[A-Z0-9_]{1,50}$/.test(result.error.code) ? result.error.code : 'XIAOMI_CONNECTION_FAILED'
      const messages: Record<string, string> = { XIAOMI_PREVIEW_STALE: '预览已过期，请刷新图像后再点选对焦', XIAOMI_ZOOM_PENDING: '请先刷新镜头设置，等待实际倍率确认后再获取预览', XIAOMI_TOKEN_REQUIRED: '请先在电脑上保存小米相机密钥', XIAOMI_BUSY: '镜头操作正在进行，请稍候', XIAOMI_RATE_LIMITED: '镜头操作太快，请稍后再试' }
      return failure(code, messages[code] ?? '小米相机操作未确认，请检查相机连接后刷新状态')
    }
    const data: Record<string, unknown> = {}
    if (result.camera && ['off', 'ready', 'capturing', 'offline', 'unknown'].includes(result.camera.state)) data.camera = { state: result.camera.state, timestamp: String(result.camera.timestamp).slice(0, 100) }
    if (result.settings) {
      const settings: Record<string, unknown> = { available: result.settings.available === true }
      for (const key of ['zoom', 'zoom_min', 'zoom_max', 'observed_zoom', 'saved_zoom', 'timestamp_ms'] as const)
        if (typeof result.settings[key] === 'number' && Number.isFinite(result.settings[key])) settings[key] = result.settings[key]
      for (const key of ['ready', 'focus_supported', 'focus_pending'] as const)
        if (typeof result.settings[key] === 'boolean') settings[key] = result.settings[key]
      for (const key of ['focus_mode', 'observed_focus_mode', 'focus_state', 'last_focus_result'] as const)
        if (typeof result.settings[key] === 'string') settings[key] = result.settings[key]?.slice(0, 100)
      data.settings = settings
    }
    if (result.operation) {
      const operation: Record<string, boolean> = {}
      for (const key of ['success', 'changed', 'applied', 'saved', 'focus_submitted'] as const)
        if (typeof result.operation[key] === 'boolean') operation[key] = result.operation[key] as boolean
      data.operation = operation
    }
    if (result.preview && /^[a-zA-Z0-9_-]{1,256}$/.test(result.preview.id) && /^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(result.preview.dataUrl)
      && result.preview.dataUrl.length <= 8 * 1024 * 1024 && Number.isSafeInteger(result.preview.capturedAt) && Number.isSafeInteger(result.preview.expiresAt)) data.preview = { id: result.preview.id, dataUrl: result.preview.dataUrl, capturedAt: result.preview.capturedAt, expiresAt: result.preview.expiresAt }
    return { ok: true, data }
  }

  status(): MobileAssistantAccessStatus {
    const access = this.access
    return access?.active ? { active: true, accountId: this.options.accountId, urls: [...access.urls], startedAt: access.startedAt } : { active: false, urls: [] }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation)
    this.lifecycle = result.catch(() => {})
    return result
  }

  start(): Promise<MobileAssistantAccessStatus> {
    return this.enqueue(async () => {
      // A revoked listener may still be waiting for its queued stop. Never replace
      // it before stop owns and closes it, including start(); stop() in one turn.
      if (this.access) return this.status()
      const token = randomBytes(32).toString('base64url')
      const server = createServer((request, response) => { void this.handle(access, request, response) })
      const access: Access = { server, token, active: false, port: 0, hosts: new Set(), urls: [], startedAt: 0 }
      server.requestTimeout = 15000
      server.headersTimeout = 10000
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.removeListener('listening', ready); reject(error) }
        const ready = () => { server.removeListener('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0')
      })
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('手机入口启动失败')
        access.port = address.port
        const host = this.options.host ?? '0.0.0.0'
        const addresses = [...new Set((this.options.addresses ?? mobileAssistantNetworkAddresses)().filter(address => isIP(address) !== 0 && !['0.0.0.0', '::'].includes(address)))]
        const visible = host !== '0.0.0.0' && host !== '::' ? [host] : addresses.length ? addresses : ['127.0.0.1']
        for (const candidate of [...visible, '127.0.0.1', 'localhost', '[::1]']) access.hosts.add(candidate.includes(':') && !candidate.startsWith('[') ? `[${candidate}]` : candidate)
        access.urls = visible.map(hostname => `http://${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:${access.port}/${token}/`)
        access.startedAt = (this.options.now ?? Date.now)()
        access.active = true
        this.access = access
        return this.status()
      } catch (error) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
        throw error
      }
    })
  }

  stop(): Promise<void> {
    // Revoke immediately as well as inside the queue, so shutdown cannot accept another command.
    if (this.access) this.access.active = false
    return this.enqueue(async () => {
      const access = this.access
      this.access = undefined
      if (!access) return
      access.active = false
      await new Promise<void>((resolve, reject) => {
        access.server.close(error => error ? reject(error) : resolve())
        access.server.closeAllConnections()
      })
    })
  }

  private async handle(access: Access, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let diagnostic: AssistantDiagnosticContext | undefined
    let diagnosticStarted = 0, diagnosticCode: string | undefined
    const trace = (phase: 'start' | 'finish' | 'error') => {
      if (!diagnostic) return
      try { this.options.trace?.({ ...diagnostic, stage: 'mobile-http', phase,
        ...(phase === 'start' ? {} : { durationMs: Math.max(0, performance.now() - diagnosticStarted) }),
        ...(diagnosticCode ? { code: diagnosticCode } : {}) }) } catch { /* Diagnostics cannot delay or fail a live request. */ }
    }
    const send = (status: number, body: unknown, type = 'application/json; charset=utf-8') => {
      if (response.destroyed || response.writableEnded) return
      if (diagnostic && body && typeof body === 'object' && 'ok' in body && body.ok === false) {
        const error = 'error' in body ? body.error as { code?: string } : undefined
        diagnosticCode = error?.code ?? 'MOBILE_REQUEST_FAILED'
      }
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP })
      response.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
    }
    try {
      if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
      const host = request.headers.host
      const authority = typeof host === 'string' ? /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):([0-9]{1,5})$/i.exec(host) : null
      if (!authority || !access.hosts.has(authority[1]) || authority[2] !== String(access.port)) return send(403, failure('MOBILE_FORBIDDEN', '请求来源无效'))
      if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) return send(403, failure('MOBILE_FORBIDDEN', '请求来源无效'))
      const base = `/${access.token}/`
      const path = request.url ?? ''
      const assets: Record<string, { name: string; type: string }> = {
        [base]: { name: 'index.html', type: 'text/html; charset=utf-8' },
        [`${base}index.html`]: { name: 'index.html', type: 'text/html; charset=utf-8' },
        [`${base}app.js`]: { name: 'app.js', type: 'application/javascript; charset=utf-8' },
        [`${base}app.css`]: { name: 'app.css', type: 'text/css; charset=utf-8' },
      }
      const asset = Object.hasOwn(assets, path) ? assets[path] : undefined
      if (asset) {
        if (request.method !== 'GET') return send(405, failure('MOBILE_METHOD_NOT_ALLOWED', '请求方法无效'))
        return send(200, await readFile(join(this.options.assetDirectory, asset.name)), asset.type)
      }
      if (path === `${base}api/state`) {
        if (request.method !== 'GET') return send(405, failure('MOBILE_METHOD_NOT_ALLOWED', '请求方法无效'))
        const result = await this.options.execute({ action: 'state', params: { accountId: this.options.accountId } })
        if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
        return result.ok ? send(200, { ok: true, data: projectMobileAssistantState(result.data as AssistantDeskState, this.options.accountId, this.options.accountName, (this.options.now ?? Date.now)()) }) : send(400, publicFailure(result))
      }
      const isVoice = path === `${base}api/voice`
      const control = path === `${base}api/camera` ? 'camera' : path === `${base}api/camera-recording` ? 'camera-recording' : path === `${base}api/studio-mic` ? 'studio-mic' : path === `${base}api/xiaomi` ? 'xiaomi' : undefined
      if (!isVoice && !control && path !== `${base}api/command`) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
      // Image frames are a high-frequency read stream, not operator actions.
      // Defer Xiaomi tracing until its body distinguishes a frame from a control.
      if (control !== 'xiaomi') diagnostic = { traceId: randomUUID(), action: isVoice ? 'mobile.voice' : 'mobile.command', accountId: this.options.accountId }
      diagnosticStarted = performance.now()
      trace('start')
      let diagnosticFinished = false
      response.once('finish', () => { diagnosticFinished = true; trace(diagnosticCode ? 'error' : 'finish') })
      response.once('close', () => { if (!diagnosticFinished) { diagnosticCode = 'RESPONSE_ABANDONED'; trace('error') } })
      if (request.method !== 'POST') return send(405, failure('MOBILE_METHOD_NOT_ALLOWED', '请求方法无效'))
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, failure('MOBILE_CONTENT_TYPE', '请求格式须为JSON'))
      if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return send(413, failure('MOBILE_BODY_TOO_LARGE', '请求超过16KiB上限'))
      const body = await readJson(request)
      if (control === 'xiaomi' && !(body && typeof body === 'object' && (body as Record<string, unknown>).action === 'preview')) {
        diagnostic = { traceId: randomUUID(), action: 'mobile.xiaomi', accountId: this.options.accountId }
        diagnosticStarted = performance.now()
        trace('start')
      }
      if (control) {
        if (diagnostic) diagnostic.action = `mobile.${control}`
        if (!access.active || this.access !== access || request.aborted || response.destroyed) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
        // Every phone owns only its current read. Closing a preview must not abort
        // another viewer or an already accepted camera/lens write.
        const preview = control === 'xiaomi' && body && typeof body === 'object' && (body as Record<string, unknown>).action === 'preview'
        const controller = preview ? new AbortController() : undefined
        const abandoned = () => controller?.abort()
        if (controller) response.once('close', abandoned)
        let result: AssistantDeskResult
        try {
          result = await (control === 'camera' ? this.cameraCommand(body) : control === 'camera-recording' ? this.cameraRecordingCommand(body) : control === 'xiaomi' ? this.xiaomiCommand(body, controller?.signal) : this.studioMicCommand(body))
        } finally {
          if (controller) response.removeListener('close', abandoned)
        }
        if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
        return send(result.ok ? 200 : 400, result)
      }
      if (isVoice) {
        if (!this.options.voice) return send(400, failure('VOICE_SERVICE_UNAVAILABLE', SAFE_MESSAGES.VOICE_SERVICE_UNAVAILABLE))
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, failure('MOBILE_INVALID_COMMAND', '语音输入参数无效'))
        const input = body as Record<string, unknown>
        if (Object.keys(input).length !== 2 || Object.keys(input).some(key => !['action', 'rowId'].includes(key)) ||
          !['start', 'stop', 'cancel'].includes(input.action as string) || typeof input.rowId !== 'string' ||
          input.rowId.length < 1 || input.rowId.length > 256 || /[\s\u0000-\u001f\u007f]/.test(input.rowId))
          return send(400, failure('MOBILE_INVALID_COMMAND', '语音输入参数无效'))
        if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
        const voiceCommand: AssistantVoiceCommand = { action: input.action as AssistantVoiceCommand['action'], rowId: input.rowId, accountId: this.options.accountId }
        if (diagnostic) {
          diagnostic.rowId = voiceCommand.rowId
          diagnostic.action = `mobile.voice.${voiceCommand.action}`
        }
        let startDispatched = false, startSettled = false, startMayOwn = false, responseAbandoned = false
        let abandonedCleanup: Promise<void> | undefined
        const unavailable = () => responseAbandoned || response.destroyed || request.aborted || !access.active || this.access !== access
        const cleanAbandonedStart = async () => {
          if (voiceCommand.action !== 'start' || !startDispatched || !startSettled || !startMayOwn || !unavailable() || response.writableFinished) return
          // Wait for the attempted start to settle before cancelling its exact
          // bound owner. Shared promise prevents abort/revoke/post-state races
          // from issuing duplicate cancellation or touching another row.
          abandonedCleanup ??= Promise.resolve().then(() => this.options.voice!({ action: 'cancel', accountId: voiceCommand.accountId, rowId: voiceCommand.rowId })).then(() => {}, () => {})
          await abandonedCleanup
        }
        const detach = () => { response.removeListener('close', abandoned); request.removeListener('aborted', abandoned) }
        const abandoned = () => {
          if (!response.writableFinished) { responseAbandoned = true; void cleanAbandonedStart() }
          detach()
        }
        if (voiceCommand.action === 'start') {
          response.once('close', abandoned)
          request.once('aborted', abandoned)
          response.once('finish', detach)
        }
        let voiceSessionId: string | undefined
        const readVoiceScene = async () => this.options.voiceScene
          ? { ok: true as const, data: await this.options.voiceScene(this.options.accountId, voiceCommand.rowId) }
          : this.options.execute({ action: 'state', params: { accountId: this.options.accountId } })
        const currentRow = (state: AssistantDeskState, sessionId: string) => [...state.rows, ...(state.attention?.rows ?? [])]
          .some(row => row.id === voiceCommand.rowId && row.accountId === this.options.accountId && row.sessionId === sessionId)
        if (voiceCommand.action !== 'cancel') {
          const stateResult = await readVoiceScene()
          if (unavailable()) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
          if (!stateResult.ok) return send(400, publicFailure(stateResult))
          const state = stateResult.data as AssistantDeskState, session = state.activeSession
          if (session?.accountId !== this.options.accountId || session.status !== 'collecting') return send(400, failure('NO_ACTIVE_SESSION', SAFE_MESSAGES.NO_ACTIVE_SESSION))
          voiceSessionId = session.id
          if (!currentRow(state, session.id)) return send(400, failure('ROW_NOT_FOUND', SAFE_MESSAGES.ROW_NOT_FOUND))
        }
        startDispatched = voiceCommand.action === 'start'
        startMayOwn = startDispatched
        let result: AssistantVoiceResult
        try {
          result = await this.options.voice(voiceCommand)
          // These admissions never acquire recording ownership. A disconnected
          // rejected request must not cancel an existing recording of the same row.
          // Session changes and uncertain service failures can occur after start,
          // so they deliberately retain cleanup of the attempted owner.
          if (!result.ok && ['VOICE_INVALID_COMMAND', 'VOICE_ALREADY_RECORDING', 'VOICE_BUSY', 'VOICE_NOT_OWNED',
            'VOICE_SERVICE_BUSY', 'VOICE_NO_ACTIVE_SESSION', 'VOICE_ROW_NOT_FOUND', 'NO_ACTIVE_SESSION', 'ROW_NOT_FOUND', 'VOICE_MIC_BLOCKED', 'VOICE_START_NOT_STARTED'].includes(result.error.code)) startMayOwn = false
        }
        finally { startSettled = true; await cleanAbandonedStart() }
        if (unavailable()) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
        if (!result.ok) return send(400, publicFailure(result))
        const data = result.data
        const expected = voiceCommand.action === 'start' ? 'recording' : voiceCommand.action === 'stop' ? 'stopped' : 'cancelled'
        if (!data || data.rowId !== voiceCommand.rowId || data.status !== expected ||
          (expected === 'stopped' && (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1000)))
          return send(400, failure('VOICE_SERVICE_UNAVAILABLE', SAFE_MESSAGES.VOICE_SERVICE_UNAVAILABLE))
        if (voiceCommand.action !== 'cancel') {
          const after = await readVoiceScene()
          if (unavailable()) { await cleanAbandonedStart(); return send(404, failure('MOBILE_NOT_FOUND', '页面不存在')) }
          if (!after.ok) return send(400, publicFailure(after))
          const state = after.data as AssistantDeskState, session = state.activeSession
          if (session?.accountId !== this.options.accountId || session.status !== 'collecting' || session.id !== voiceSessionId || !currentRow(state, session.id))
            return send(400, failure('MOBILE_SESSION_CHANGED', SAFE_MESSAGES.MOBILE_SESSION_CHANGED))
        }
        return send(200, { ok: true, data: { status: data.status, rowId: data.rowId, ...(expected === 'stopped' ? { text: data.text } : {}),
          ...(data.micWarning ? { micWarning: '豆包录音已结束，直播麦克风恢复未确认；请重新读取麦克风状态' } : {}),
          ...(data.routeState && ['live', 'doubao', 'unknown'].includes(data.routeState) ? { routeState: data.routeState } : {}) } })
      }
      let command: AssistantDeskCommand
      try {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
        const input = body as Record<string, unknown>
        const params = input.params
        if (typeof input.action !== 'string' || !MOBILE_ASSISTANT_ACTIONS.includes(input.action as typeof MOBILE_ASSISTANT_ACTIONS[number]) || Object.keys(input).some(key => !['action', 'params'].includes(key))) throw new Error()
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.hasOwn(params, 'accountId')) throw new Error()
        if (input.action === 'segment-toggle' && !['requestId', 'sessionId', 'expectedOpenSegmentId'].every(key => Object.hasOwn(params, key))) throw new Error()
        command = validateDeskHttp('/assistant/command', { action: input.action, params: { ...params, accountId: this.options.accountId } }) as AssistantDeskCommand
      } catch { return send(400, failure('MOBILE_INVALID_COMMAND', '操作或参数无效')) }
      if (diagnostic) {
        diagnostic.action = `mobile.${command.action}`
        if ('rowId' in command.params) diagnostic.rowId = command.params.rowId
        if ('requestId' in command.params) diagnostic.requestId = command.params.requestId
      }
      if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
      let sessionId: string | undefined
      const rowId = 'rowId' in command.params ? command.params.rowId : undefined
      if (command.action !== 'attention-countdown') {
        // Native unpin and idempotent request replay can reach historical rows.
        // The phone only controls rows visible in its current collecting scene.
        const stateResult = await this.options.execute({ action: 'state', params: { accountId: this.options.accountId } })
        if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
        if (!stateResult.ok) return send(400, publicFailure(stateResult))
        const state = stateResult.data as AssistantDeskState
        const session = state.activeSession
        if (session?.accountId !== this.options.accountId || session.status !== 'collecting') return send(400, failure('NO_ACTIVE_SESSION', SAFE_MESSAGES.NO_ACTIVE_SESSION))
        sessionId = session.id
        if (command.action === 'translate-retry') {
          if (state.ai.used >= state.ai.limit || state.ai.pauseReason === 'request-limit') return send(400, failure('AI_REQUEST_LIMIT', SAFE_MESSAGES.AI_REQUEST_LIMIT))
          if (state.ai.paused) return send(400, failure('AI_PAUSED', SAFE_MESSAGES.AI_PAUSED))
        }
        if (command.action === 'segment-toggle') {
          if (command.params.sessionId !== sessionId) return send(400, failure('MOBILE_SESSION_CHANGED', SAFE_MESSAGES.MOBILE_SESSION_CHANGED))
        } else if (![...state.rows, ...(state.attention?.rows ?? [])].some(row => row.id === rowId && row.accountId === this.options.accountId && row.sessionId === sessionId))
          return send(400, failure('ROW_NOT_FOUND', SAFE_MESSAGES.ROW_NOT_FOUND))
      }
      const result = await this.options.execute(command)
      if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
      if (!result.ok) return send(400, publicFailure(result))
      const data = result.data as any
      if (command.action === 'attention-countdown') return send(200, { ok: true, data: projectWindow(data) })
      // A stop/start during the awaited operation must not return a row from the
      // previous scene, even if the native command itself reports success.
      const after = await this.options.execute({ action: 'state', params: { accountId: this.options.accountId } })
      if (!access.active || this.access !== access) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
      if (!after.ok) return send(400, publicFailure(after))
      const session = (after.data as AssistantDeskState).activeSession
      if (command.action === 'segment-toggle') {
        if (session?.accountId !== this.options.accountId || session.status !== 'collecting' || session.id !== sessionId ||
          data?.accountId !== this.options.accountId || data.sessionId !== sessionId || data.captureSessionId !== session.captureSessionId ||
          typeof data.id !== 'string' || typeof data.name !== 'string' || !Number.isSafeInteger(data.startedAt) ||
          (data.endedAt !== undefined && !Number.isSafeInteger(data.endedAt)))
          return send(400, failure('MOBILE_SESSION_CHANGED', SAFE_MESSAGES.MOBILE_SESSION_CHANGED))
        return send(200, { ok: true, data: { id: data.id, name: data.name, startedAt: data.startedAt, ...(data.endedAt === undefined ? {} : { endedAt: data.endedAt }) } })
      }
      const row: AssistantDeskRow | undefined = command.action === 'attention-pin' ? data?.row : data
      if (session?.accountId !== this.options.accountId || session.status !== 'collecting' || session.id !== sessionId ||
        row?.accountId !== this.options.accountId || row.sessionId !== sessionId || row.id !== rowId)
        return send(400, failure('MOBILE_SESSION_CHANGED', SAFE_MESSAGES.MOBILE_SESSION_CHANGED))
      return send(200, { ok: true, data: command.action === 'attention-pin' ? { rowId: command.params.rowId, pinned: command.params.pinned, row: projectRow(row) } : projectRow(row) })
    } catch (error) {
      if (error instanceof HttpFailure) return send(error.status, failure(error.code, error.message))
      return send(500, failure('MOBILE_ASSISTANT_FAILED'))
    }
  }
}
