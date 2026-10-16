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
import { MOBILE_ASSISTANT_ACTIONS, type MobileAssistantAccessStatus, type MobileAssistantDeskSnapshot } from '../../../shared/mobileAssistantDesk'
import type { AssistantDiagnosticContext, AssistantDiagnosticTrace } from './AssistantDiagnostics'

export interface MobileAssistantDeskServerOptions {
  accountId: string
  accountName: string
  assetDirectory: string
  execute: (command: AssistantDeskCommand) => Promise<AssistantDeskResult>
  voice?: (command: AssistantVoiceCommand) => Promise<AssistantVoiceResult>
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
  for (const key of ['source', 'method', 'language', 'chinese'] as const) {
    if (row.translation[key] !== undefined) Object.assign(output.translation, { [key]: row.translation[key] })
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
}

function failure(code: string, message = '操作未完成，请刷新后重试'): AssistantDeskResult {
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
      if (!isVoice && path !== `${base}api/command`) return send(404, failure('MOBILE_NOT_FOUND', '页面不存在'))
      diagnostic = { traceId: randomUUID(), action: isVoice ? 'mobile.voice' : 'mobile.command', accountId: this.options.accountId }
      diagnosticStarted = performance.now()
      trace('start')
      let diagnosticFinished = false
      response.once('finish', () => { diagnosticFinished = true; trace(diagnosticCode ? 'error' : 'finish') })
      response.once('close', () => { if (!diagnosticFinished) { diagnosticCode = 'RESPONSE_ABANDONED'; trace('error') } })
      if (request.method !== 'POST') return send(405, failure('MOBILE_METHOD_NOT_ALLOWED', '请求方法无效'))
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, failure('MOBILE_CONTENT_TYPE', '请求格式须为JSON'))
      if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return send(413, failure('MOBILE_BODY_TOO_LARGE', '请求超过16KiB上限'))
      const body = await readJson(request)
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
        diagnostic.rowId = voiceCommand.rowId
        diagnostic.action = `mobile.voice.${voiceCommand.action}`
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
            'VOICE_SERVICE_BUSY', 'VOICE_NO_ACTIVE_SESSION', 'VOICE_ROW_NOT_FOUND', 'NO_ACTIVE_SESSION', 'ROW_NOT_FOUND'].includes(result.error.code)) startMayOwn = false
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
        return send(200, { ok: true, data: { status: data.status, rowId: data.rowId, ...(expected === 'stopped' ? { text: data.text } : {}) } })
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
      diagnostic.action = `mobile.${command.action}`
      if ('rowId' in command.params) diagnostic.rowId = command.params.rowId
      if ('requestId' in command.params) diagnostic.requestId = command.params.requestId
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
