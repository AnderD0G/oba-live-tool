import { timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { AUDIENCE_EVENT_KINDS, type AudienceEventQuery } from '../../../shared/audienceEvents'
import { validateScoreAdjustment } from '../../../shared/audienceScoring'
import {
  type DirectorConfig,
  type DirectorSnapshot,
  directorStepRewinds,
} from '../../../shared/director'
import {
  applyDirectorOps,
  type DirectorOp,
  summarizeDirectorConfig,
} from '../../../shared/directorOps'
import { validateObsCameraConfig, type ObsCameraConfig } from '../../../shared/obsCamera'
import type { ObsEffectCommand, ObsEffectResponse, ObsSceneMetadata } from '../../../shared/obsEffect'
import type { PlatformPageDiagnostics } from '../../../shared/platformPageDiagnostics'
import type { SpeechAnalysisInput, SpeechSelection } from './DirectorSpeechAnalysis'
import type { DirectorCommand,DirectorResponse } from '../../../shared/director'
import type { DirectorExperimentResponse } from '../../../shared/directorExperiment'
import { LiveVoiceConfigError } from './LiveVoiceConfiguration'
import { AnalysisError, ANALYSIS_HTTP_ROUTES, type AnalysisCommand, type AnalysisResponse } from '../../../shared/analysisRoom'
import { analysisHttpCommand, isAnalysisPath } from './analysisRoom/AnalysisHttpAdapter'
import { analysisFailure, analysisHttpStatus } from './analysisRoom/AnalysisResponses'
import { validateDeskHttp } from '../../../shared/assistantDeskContract.mjs'
import {validateEffectGroupHttp} from '../../../shared/effectGroupsContract.mjs'
import type {EffectGroupCommand} from '../../../shared/effectGroups'
import type { AssistantDeskCommand, AssistantDeskResult } from '../../../shared/assistantDesk'
import type { PlatformSessionCommand, PlatformSessionResult } from '../../../shared/platformSession'
import type { HookCommand, HookResponse, HookRule, HookSettings } from '../../../shared/hooks'
import { validateHookSettings } from './HookEngine'

/**
 * 互动导播的本地 HTTP API。
 *
 * 只监听回环地址，并要求令牌；配置的唯一写入口仍然是主进程里的 JsonLedger，
 * 这里不另开一条写路径，避免和界面互相覆盖。
 */

export interface DirectorApiFacade {
  assistantDesk?(command:AssistantDeskCommand):Promise<AssistantDeskResult>
  effectGroups?(command:EffectGroupCommand):Promise<AssistantDeskResult>
  platformSession?(command:PlatformSessionCommand):Promise<PlatformSessionResult>
  experimentStatus?(): Promise<DirectorExperimentResponse>
  experimentStart?(): Promise<DirectorExperimentResponse>
  analysisRoom?(command:AnalysisCommand):Promise<AnalysisResponse>
  authoring?(command:Extract<DirectorCommand,{action:`authoring-${string}`}>):Promise<DirectorResponse>
  getConfig(): DirectorConfig
  getState(): DirectorSnapshot | undefined
  isRunning(): boolean
  /** 走和界面同一套校验与互斥，保存整份配置 */
  saveConfig(config: DirectorConfig): void
  /** 只校验，不落盘 */
  validateConfig(config: DirectorConfig): void
  discoverObs(): Promise<ObsSceneMetadata[]>
  obsControl?(command: ObsEffectCommand): Promise<ObsEffectResponse>
  hooksControl?(command: HookCommand): Promise<HookResponse>
  pageDiagnostics?(accountId: string, marker?: string): Promise<PlatformPageDiagnostics>
  analyzeSpeech?(input: SpeechAnalysisInput): Promise<unknown>
  planSpeech?(analysisId: string, selections: SpeechSelection[]): Promise<DirectorOp[]>
  getInteraction?(accountId: string): unknown
  getVoiceConfig?(accountId: string): unknown
  applyVoiceConfig?(accountId: string, revision: string, patch: unknown): unknown
  checkVoice?(accountId: string): Promise<unknown>
  getInteractionCapabilities?(): unknown
  applyInteraction?(accountId: string, revision: number, config: unknown): unknown
  simulateInteraction?(accountId: string, context: unknown, config?: unknown): unknown
  getAudience?(accountId: string, userId?: string, platform?: string): unknown
  adjustAudienceScore?(accountId: string, revision: number, adjustment: unknown): unknown
  getTimeline?(filter: AudienceEventQuery): Promise<unknown>
}

export interface DirectorApiOptions {
  facade: DirectorApiFacade
  token: string
  host?: string
  port?: number
  log?: (message: string) => void
  /** Fixed directory containing the six public, transparent OBS browser assets. */
  obsOverlayDirectory?: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 17892
const MAX_BODY_BYTES = 4 * 1024 * 1024
const BODY_TIMEOUT_MS = 30_000
const OBS_INSTANT_PREFIX = '/obs/instant/'
const OBS_INSTANT_PRESENTATION = `${OBS_INSTANT_PREFIX}presentation`
const OBS_INSTANT_ASSETS: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'welcome.html': 'text/html; charset=utf-8',
  'like.html': 'text/html; charset=utf-8',
  'follow.html': 'text/html; charset=utf-8',
  'effects.css': 'text/css; charset=utf-8',
  'effects.js': 'text/javascript; charset=utf-8',
}
const OBS_INSTANT_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

interface Handler {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  summary: string
  /** 请求体形状说明，供 MCP 与人工查阅 */
  body?: string
}

const ENDPOINTS: Handler[] = [
  { method: 'GET', path: '/obs/welcome/presets', summary: '读取精选欢迎样式及当前场景已验证的本地素材，不触发动作' },
  { method: 'GET', path: '/hooks/config', summary: '读取共享钩子配置，不触发动作' },
  {method:'POST',path:'/effect-groups/command',summary:'规则效果组：get/catalog/simulate/apply/sync/status/preview，SQLite与OBS资源分开对账'},
  { method: 'PUT', path: '/hooks/config', summary: '校验并保存共享钩子配置', body: '{settings:HookSettings}' },
  { method: 'POST', path: '/hooks/preview', summary: '仅预览1～3个OBS艺术字动作，不调用AI或公屏发送', body: '{rule:HookRule}' },
  {method:'POST',path:'/assistant/command',summary:'助播台：采集、原文译文、三档回复、用户礼物审计、打点与OBS录像；同一主进程写者',body:'{action,params:{accountId,...}}'},
  {method:'POST',path:'/platform/session/command',summary:'先登录后选直播间，或接入本机已登录Chrome；复用现有页面，不返回凭据',body:'{action:"state|open-login|attach-browser|set-target|qr-preview",accountId,sessionId?,target?,endpoint?,pageUrl?}'},
  ...ANALYSIS_HTTP_ROUTES,
  { method: 'GET', path: '/director/experiment/status', summary: '只读本机互动实验状态，不加载模型，不自动开播或发送公开消息' },
  { method: 'POST', path: '/director/experiment/start', summary: '加载或复用本机互动实验服务，不自动开播、启动平台监听或发送公开消息', body: '{}' },
  { method: 'GET', path: '/interaction/voice-config', summary: '只读所选语音后端、播放模式、流式开关和版本；query: accountId；不返回密钥' },
  { method: 'PUT', path: '/interaction/voice-config', summary: '按版本局部保存语音选项；自动回复关闭后可修改；不启用或开播', body: '{accountId,revision:SHA256,patch:{voiceBackend?,voicePlayback?,streamingPlayback?}}' },
  { method: 'POST', path: '/interaction/voice-check', summary: '检查所选语音及 OBS 连接，不生成、不发声、不切场景', body: '{accountId}' },
  {method:'POST',path:'/director/authoring',summary:'离线素材目标模式：三图、文案、配音、状态和候选配置；不保存或开播',body:'{action:"authoring-prepare|status|render|cancel|candidate|images|audio",...对应参数}'},
  {
    method: 'POST',
    path: '/interaction/score/adjust',
    summary: '显式人工有符号评分事实，稳定身份、原因和幂等编号必填',
    body: '{accountId,revision,platform,userId,source:"manual",delta,reason,adjustmentId}',
  },
  {
    method: 'GET',
    path: '/interaction/timeline',
    summary:
      '只读分页观众事件；accountId 必填，platform/userId/sessionId/traceId/kind/limit/cursor 可选',
  },
  {
    method: 'GET',
    path: '/interaction/capabilities',
    summary: '无需账号参数，发现实际账号、可用平台字段、模式与限制',
  },
  {
    method: 'GET',
    path: '/interaction/config',
    summary: '读取账号互动分流配置、版本与可用能力；query: accountId',
  },
  {
    method: 'PUT',
    path: '/interaction/config',
    summary: '按版本校验并保存账号互动分流配置',
    body: '{accountId,revision,config}',
  },
  {
    method: 'POST',
    path: '/interaction/simulate',
    summary: '模拟互动分流，不保存、不调用模型、不发送或播音',
    body: '{accountId,context,config?}',
  },
  {
    method: 'GET',
    path: '/interaction/audience',
    summary: '读取账号已知观众属性；query: accountId,userId?',
  },
  {
    method: 'POST',
    path: '/director/speech/analyze',
    summary: '逐字稿与音频气口对齐，只返回候选，不改配置',
    body: '{stepId,audio,transcript:[{start,end,text}]}（秒）',
  },
  {
    method: 'POST',
    path: '/director/speech/plan',
    summary: '验证 AI 逐句标注并生成配置操作，apply=true 时保存；导播必须停止',
    body: '{analysisId,selections:[{candidateId,replaceable,reason}],apply?:boolean}',
  },
  { method: 'GET', path: '/health', summary: '服务是否在运行' },
  { method: 'GET', path: '/director/config', summary: '读取导播配置，view=summary 返回紧凑视图' },
  {
    method: 'PUT',
    path: '/director/config',
    summary: '整份覆盖保存配置（会先校验，导播运行中会被拒绝）',
    body: '{ config: DirectorConfig }',
  },
  {
    method: 'POST',
    path: '/director/ops',
    summary: '应用一组结构化操作后保存，适合按人话增量配置',
    body: '{ ops: DirectorOp[] }',
  },
  {
    method: 'POST',
    path: '/director/validate',
    summary: '只校验不保存；传 ops 或 config 均可',
    body: '{ ops?: DirectorOp[], config?: DirectorConfig }',
  },
  { method: 'GET', path: '/director/state', summary: '导播运行状态、队列与日志' },
  { method: 'GET', path: '/obs/scenes', summary: '读取 OBS 场景与素材组，供配置时选择' },
  {
    method: 'GET',
    path: '/platform/page-diagnostics',
    summary:
      '只读现有 TikTok 页面 URL、固定选择器计数、最多5条聊天结构和25条公开可见评论；query: accountId,marker?',
  },
  { method: 'GET', path: '/obs/camera', summary: '读取双机位配置、实际可见状态及是否位于节目场景' },
  { method: 'GET', path: OBS_INSTANT_PRESENTATION, summary: '读取即时互动展示模式和跟随机位设置，不触发互动' },
  { method: 'PUT', path: OBS_INSTANT_PRESENTATION, summary: '保存即时互动宽景或聚焦模式及跟随机位开关', body: '{mode:"wide"|"focus",followCamera:boolean}' },
  { method: 'PUT', path: '/obs/camera', summary: '校验并保存双机位场景、来源与过渡配置', body: '{config:{sceneName,androidSource,iphoneSource,transitionMethod?,transitionMs?}}' },
  { method: 'POST', path: '/obs/camera/switch', summary: '切换到已配置的安卓或 iPhone 机位，返回实际执行结果', body: '{target:"android"|"iphone"}' },
]

class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function tokenMatches(expected: string, provided: string) {
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readJsonBody(request: IncomingMessage) {
  const contentType = String(request.headers['content-type'] || '')
  if (!contentType.includes('application/json'))
    throw new ApiError('请求必须使用 application/json；这同时可以挡住网页发起的跨站请求', 415)
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError('读取请求体超时', 408)), BODY_TIMEOUT_MS)
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer)
        reject(new ApiError('请求体过大', 413))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      clearTimeout(timer)
      resolve()
    })
    request.on('error', error => {
      clearTimeout(timer)
      reject(new ApiError(`读取请求体失败：${error.message}`))
    })
  })
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError('请求体不是合法 JSON')
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ApiError(`${label}必须是对象`)
  return value as Record<string, unknown>
}

function requireHookRule(value: unknown): HookRule {
  const rule = requireObject(value, 'rule')
  const keys = ['id', 'name', 'enabled', 'cooldownMs', 'exclusiveGroup', 'priority', 'levelStrategy', 'source', 'eventType', 'conditions', 'actions']
  if (Object.keys(rule).some(key => !keys.includes(key)) || typeof rule.id !== 'string' || typeof rule.name !== 'string' ||
      typeof rule.enabled !== 'boolean' || !['tiktok', 'xiaohongshu', 'webhook'].includes(rule.source as string) ||
      !['viewer.enter', 'viewer.follow', 'viewer.like', 'viewer.gift', 'webhook.received'].includes(rule.eventType as string) ||
      !Array.isArray(rule.conditions) || !Array.isArray(rule.actions))
    throw new ApiError('钩子规则结构无效或包含未知字段')
  for (const value of rule.conditions) {
    const condition = requireObject(value, 'condition')
    if (Object.keys(condition).length !== 3 || Object.keys(condition).some(key => !['field', 'operator', 'value'].includes(key)) ||
        typeof condition.field !== 'string' || !['eq', 'gte'].includes(condition.operator as string) ||
        !['string', 'number', 'boolean'].includes(typeof condition.value))
      throw new ApiError('钩子条件结构无效')
  }
  for (const action of rule.actions) requireObject(action, 'action')
  return rule as unknown as HookRule
}

function requireHookSettings(value: unknown): HookSettings {
  const settings = requireObject(value, 'settings')
  if (Object.keys(settings).length !== 3 || Object.keys(settings).some(key => !['webhookPort', 'migratedObsEffects', 'rules'].includes(key)) ||
      typeof settings.migratedObsEffects !== 'boolean' || !Array.isArray(settings.rules))
    throw new ApiError('钩子设置结构无效或包含未知字段')
  for (const rule of settings.rules) requireHookRule(rule)
  try { validateHookSettings(settings as unknown as HookSettings) }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : '钩子设置无效') }
  return settings as unknown as HookSettings
}

function requireInteractionId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject control characters in external identifiers.
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new ApiError(`${label}必须是不含控制字符的 1～200 字符标识`)
  return value
}

export class DirectorApiServer {
  private server: Server | null = null
  private boundPort = 0
  private readonly host: string
  private readonly log: (message: string) => void

  constructor(private readonly options: DirectorApiOptions) {
    this.host = options.host || DEFAULT_HOST
    this.log = options.log || (() => {})
  }

  get port() {
    return this.boundPort
  }

  get url() {
    return this.boundPort ? `http://${this.host}:${this.boundPort}` : ''
  }

  /** 监听失败时抛错，由调用方决定是否降级 */
  listen(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this.server) {
        resolve(this.boundPort)
        return
      }
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })
      server.on('error', error => {
        this.server = null
        reject(error)
      })
      const preferred = this.options.port ?? DEFAULT_PORT
      server.listen(preferred, this.host, () => {
        const address = server.address()
        this.boundPort = typeof address === 'object' && address ? address.port : preferred
        this.server = server
        resolve(this.boundPort)
      })
    })
  }

  async close() {
    const server = this.server
    this.server = null
    this.boundPort = 0
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      // 任何情况下都不发 CORS 头：浏览器页面无法读取响应，也无法带自定义头
      const url = new URL(request.url || '/', `http://${this.host}`)
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const method = (request.method || 'GET').toUpperCase()
      const rawPath = (request.url || '/').split('?')[0]
      let decodedPath = rawPath
      try { decodedPath = decodeURIComponent(rawPath) } catch { /* Malformed assets remain unknown paths. */ }
      const instantPath = [rawPath, decodedPath, path].some(value => value === '/obs/instant' || value.startsWith(OBS_INSTANT_PREFIX))
      if (instantPath && rawPath !== OBS_INSTANT_PRESENTATION) {
        // Match the raw path so URL normalization cannot turn a traversal into a different public route.
        response.setHeader('x-content-type-options', 'nosniff')
        response.setHeader('content-security-policy', OBS_INSTANT_CSP)
        const filename = rawPath.startsWith(OBS_INSTANT_PREFIX) ? rawPath.slice(OBS_INSTANT_PREFIX.length) : ''
        if (!Object.hasOwn(OBS_INSTANT_ASSETS, filename)) throw new ApiError('没有这个 OBS 素材', 404)
        if (method !== 'GET') {
          response.setHeader('allow', 'GET')
          throw new ApiError('OBS 素材只接受 GET', 405)
        }
        const directory = this.options.obsOverlayDirectory
        if (!directory) throw new ApiError('OBS 素材尚未部署', 404)
        let body: Buffer
        try {
          const root = await realpath(directory)
          const file = await realpath(join(root, filename))
          if (dirname(file) !== root) throw new Error('asset-outside-root')
          body = await readFile(file)
        } catch {
          throw new ApiError('OBS 素材不可用', 404)
        }
        response.writeHead(200, {
          'content-type': OBS_INSTANT_ASSETS[filename],
          'content-length': body.length,
          'cache-control': 'no-store',
        })
        response.end(body)
        return
      }
      if(isAnalysisPath(path)){
        let result:AnalysisResponse
        try{
          const provided=String(request.headers['x-oba-token']||(String(request.headers.authorization||'').startsWith('Bearer ')?String(request.headers.authorization).slice(7):''))
          if(!provided||!tokenMatches(this.options.token,provided))throw new AnalysisError('ANALYSIS_UNAUTHENTICATED','缺少或错误的访问令牌')
          const command=await analysisHttpCommand(path,method,url,request)
          if(!this.options.facade.analysisRoom)throw new AnalysisError('ANALYSIS_UNAVAILABLE','分析服务未装配')
          result=await this.options.facade.analysisRoom(command)
        }catch(error){result=analysisFailure(error)}
        sendJson(response,analysisHttpStatus(result),result)
        return
      }

      if (path === '/health') {
        sendJson(response, 200, {
          ok: true,
          name: 'oba-director-api',
          version: 1,
          running: this.options.facade.isRunning(),
        })
        return
      }

      if (path === '/' && method === 'GET') {
        sendJson(response, 200, {
          ok: true,
          name: 'oba-director-api',
          endpoints: ENDPOINTS,
          ops: DIRECTOR_OP_HELP,
        })
        return
      }

      const provided = String(
        request.headers['x-oba-token'] ||
          (String(request.headers.authorization || '').startsWith('Bearer ')
            ? String(request.headers.authorization).slice(7)
            : ''),
      )
      if (!provided || !tokenMatches(this.options.token, provided))
        throw new ApiError('缺少或错误的访问令牌：请在请求头带上 x-oba-token', 401)

      // 同一个路径可能有多个方法（例如 /director/config 的 GET 与 PUT），必须同时匹配
      const route = ENDPOINTS.find(item => item.path === path && item.method === method)
      if (!route) {
        const knownPath = ENDPOINTS.some(item => item.path === path)
        throw knownPath
          ? new ApiError(`${path} 不支持 ${method}`, 405)
          : new ApiError(`没有这个接口：${method} ${path}`, 404)
      }

      switch (path) {
        case '/obs/welcome/presets': {
          if (url.search || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)
            throw new ApiError('欢迎样式目录不接受查询参数或请求体')
          if (!this.options.facade.obsControl) throw new ApiError('OBS 欢迎样式 API 未启用', 503)
          let result: ObsEffectResponse
          try { result = await this.options.facade.obsControl({ action: 'welcome-presets' }) }
          catch (error) { throw new ApiError(error instanceof Error ? error.message : String(error), 502) }
          sendJson(response, result.ok ? 200 : 502, result)
          return
        }
        case '/hooks/config':
        case '/hooks/preview': {
          if (url.search) throw new ApiError('钩子控制接口不接受查询参数')
          let command: HookCommand
          if (method === 'GET') {
            if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)
              throw new ApiError('读取钩子配置不接受请求体')
            command = { action: 'state' }
          } else {
            const body = requireObject(await readJsonBody(request), '请求体')
            const field = path === '/hooks/config' ? 'settings' : 'rule'
            if (Object.keys(body).length !== 1 || Object.keys(body)[0] !== field)
              throw new ApiError(`钩子控制请求只接受 ${field}`)
            if (field === 'settings') command = { action: 'save', settings: requireHookSettings(body.settings) }
            else {
              const rule = requireHookRule(body.rule)
              if (rule.actions.length < 1 || rule.actions.length > 3 || rule.actions.some(action => action.type !== 'obs.art-text'))
                throw new ApiError('钩子预览只允许1～3个 OBS 艺术字动作')
              const allowed = ['type', 'id', 'dependsOn', 'inputName', 'template', 'style', 'holdMs', 'priority', 'delivery', 'presetId']
              if (rule.actions.some(action => Object.keys(action).some(key => !allowed.includes(key))))
                throw new ApiError('艺术字预览动作包含未知字段')
              requireHookSettings({webhookPort: 17890, migratedObsEffects: false, rules: [rule]})
              command = { action: 'test', rule }
            }
          }
          if (!this.options.facade.hooksControl) throw new ApiError('钩子控制 API 未启用', 503)
          let result: HookResponse
          try { result = await this.options.facade.hooksControl(command) }
          catch (error) { throw new ApiError(error instanceof Error ? error.message : String(error), 502) }
          sendJson(response, result.ok ? 200 : 502, result)
          return
        }
        case OBS_INSTANT_PRESENTATION: {
          if (url.search) throw new ApiError('即时互动展示设置不接受查询参数')
          let command: ObsEffectCommand
          if (method === 'GET') {
            if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)
              throw new ApiError('读取即时互动展示设置不接受请求体')
            command = { action: 'instant-presentation-state' }
          } else {
            const body = requireObject(await readJsonBody(request), '请求体')
            if (Object.keys(body).length !== 2 || Object.keys(body).some(key => !['mode', 'followCamera'].includes(key)) ||
                !['wide', 'focus'].includes(body.mode as string) || typeof body.followCamera !== 'boolean')
              throw new ApiError('展示设置只接受 mode:"wide"|"focus" 和 followCamera:boolean')
            command = { action: 'instant-presentation-save', mode: body.mode as 'wide' | 'focus', followCamera: body.followCamera }
          }
          if (!this.options.facade.obsControl) throw new ApiError('即时互动展示 API 未启用', 503)
          let result: ObsEffectResponse
          try { result = await this.options.facade.obsControl(command) }
          catch (error) { throw new ApiError(error instanceof Error ? error.message : String(error), 502) }
          sendJson(response, result.ok ? 200 : 502, result)
          return
        }
        case '/effect-groups/command': {
          if(url.search)throw new ApiError('效果组命令不接受查询参数')
          let command:EffectGroupCommand
          try{command=validateEffectGroupHttp(await readJsonBody(request)) as EffectGroupCommand}catch(error){throw new ApiError(error instanceof Error?error.message:'效果组命令无效')}
          if(!this.options.facade.effectGroups)throw new ApiError('效果组服务尚未装配',503)
          const result=await this.options.facade.effectGroups(command)
          sendJson(response,result.ok?200:400,result);return
        }
        case '/assistant/command':
        case '/platform/session/command': {
          if(url.search)throw new ApiError('命令接口不接受查询参数')
          let command:unknown
          try {command=validateDeskHttp(path,await readJsonBody(request))}
          catch(error){throw new ApiError(error instanceof Error?error.message:'命令无效')}
          const dispatch=path==='/assistant/command'?this.options.facade.assistantDesk:this.options.facade.platformSession
          if(!dispatch)throw new ApiError('该服务尚未装配',503)
          const result=path==='/assistant/command'
            ?await this.options.facade.assistantDesk!(command as AssistantDeskCommand)
            :await this.options.facade.platformSession!(command as PlatformSessionCommand)
          sendJson(response,result.ok?200:400,result)
          return
        }
        case '/platform/page-diagnostics': {
          for (const key of url.searchParams.keys()) {
            if (!['accountId', 'marker'].includes(key))
              throw new ApiError('页面诊断不接受额外查询参数')
            if (url.searchParams.getAll(key).length !== 1)
              throw new ApiError('页面诊断不接受重复查询参数')
          }
          const accountId = requireInteractionId(url.searchParams.get('accountId'), 'accountId')
          const marker = url.searchParams.get('marker') ?? undefined
          if (
            marker !== undefined &&
            ([...marker].length < 1 || [...marker].length > 128 || Buffer.byteLength(marker) > 512)
          )
            throw new ApiError('marker 必须为1～128个 Unicode 字符且不超过512字节')
          if (!this.options.facade.pageDiagnostics)
            throw new ApiError('只读页面诊断 API 未启用', 503)
          let diagnostics: PlatformPageDiagnostics
          try {
            diagnostics = await this.options.facade.pageDiagnostics(accountId, marker)
          } catch (error) {
            throw new ApiError(error instanceof Error ? error.message : String(error), 502)
          }
          sendJson(response, 200, { ok: true, diagnostics })
          return
        }
        case '/obs/camera':
        case '/obs/camera/switch': {
          if (url.search) throw new ApiError('OBS 机位接口不接受查询参数')
          let command: ObsEffectCommand
          if (method === 'GET') {
            if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) > 0)
              throw new ApiError('读取 OBS 机位不接受请求体')
            command = { action: 'camera-state' }
          } else {
            const body = requireObject(await readJsonBody(request), '请求体')
            if (path === '/obs/camera/switch') {
              if (Object.keys(body).some(key => key !== 'target') || typeof body.target !== 'string' || !['android', 'iphone'].includes(body.target))
                throw new ApiError('机位切换只接受 target:"android" 或 "iphone"')
              command = { action: 'camera-switch', target: body.target as 'android' | 'iphone' }
            } else {
              if (Object.keys(body).some(key => key !== 'config'))
                throw new ApiError('机位保存只接受 config')
              const config = requireObject(body.config, 'config')
              if (Object.keys(config).some(key => !['sceneName', 'androidSource', 'iphoneSource', 'transitionMethod', 'transitionMs'].includes(key)))
                throw new ApiError('机位配置包含未知字段')
              validateObsCameraConfig(config as unknown as ObsCameraConfig)
              command = { action: 'camera-save', config: config as unknown as ObsCameraConfig }
            }
          }
          if (!this.options.facade.obsControl) throw new ApiError('OBS 机位 API 未启用', 503)
          let result: ObsEffectResponse
          try {
            result = await this.options.facade.obsControl(command)
          } catch (error) {
            throw new ApiError(error instanceof Error ? error.message : String(error), 502)
          }
          sendJson(response, result.ok ? 200 : 502, result)
          return
        }
        case '/director/experiment/status': {
          if (url.search) throw new ApiError('实验状态不接受查询参数')
          if (!this.options.facade.experimentStatus) throw new ApiError('本机互动实验 API 未启用', 503)
          sendJson(response, 200, await this.options.facade.experimentStatus())
          return
        }
        case '/director/experiment/start': {
          if (url.search) throw new ApiError('实验启动不接受查询参数')
          const body = requireObject(await readJsonBody(request), '请求体')
          if (Object.keys(body).length) throw new ApiError('实验启动只接受空对象，不支持开播、平台监听或公开回复控制')
          if (!this.options.facade.experimentStart) throw new ApiError('本机互动实验 API 未启用', 503)
          sendJson(response, 200, await this.options.facade.experimentStart())
          return
        }
        case '/interaction/voice-config': {
          if (method === 'GET') {
            const accountId = requireInteractionId(url.searchParams.get('accountId'), 'accountId')
            if (!this.options.facade.getVoiceConfig) throw new ApiError('语音配置 API 未启用', 503)
            sendJson(response, 200, { ok: true, result: this.options.facade.getVoiceConfig(accountId) })
            return
          }
          const body = requireObject(await readJsonBody(request), '请求体')
          if (Object.keys(body).some(key => !['accountId', 'revision', 'patch'].includes(key)))
            throw new ApiError('语音配置请求只允许 accountId、revision、patch')
          const accountId = requireInteractionId(body.accountId, 'accountId')
          if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))
            throw new ApiError('revision 必须为当前配置的 SHA256；请先读取')
          const patch = requireObject(body.patch, 'patch')
          if (!this.options.facade.applyVoiceConfig) throw new ApiError('语音配置 API 未启用', 503)
          const result = this.options.facade.applyVoiceConfig(accountId, body.revision, patch)
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/interaction/voice-check': {
          const body = requireObject(await readJsonBody(request), '请求体')
          if (Object.keys(body).some(key => key !== 'accountId')) throw new ApiError('语音检查只接受 accountId，不支持播音')
          const accountId = requireInteractionId(body.accountId, 'accountId')
          if (!this.options.facade.checkVoice) throw new ApiError('语音检查 API 未启用', 503)
          const result = await this.options.facade.checkVoice(accountId)
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/interaction/timeline': {
          if (!this.options.facade.getTimeline) throw new ApiError('观众时间线未启用', 503)
          const filter: AudienceEventQuery = {
            accountId: requireInteractionId(url.searchParams.get('accountId'), 'accountId'),
          }
          for (const key of ['platform', 'userId', 'sessionId', 'traceId'] as const)
            if (url.searchParams.has(key))
              filter[key] = requireInteractionId(url.searchParams.get(key), key)
          if (url.searchParams.has('kind')) {
            const kind = url.searchParams.get('kind') as AudienceEventQuery['kind']
            if (!kind || !AUDIENCE_EVENT_KINDS.includes(kind)) throw new ApiError('事件类型无效')
            filter.kind = kind
          }
          if (url.searchParams.has('limit')) {
            filter.limit = Number(url.searchParams.get('limit'))
            if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 200)
              throw new ApiError('limit 须为 1～200')
          }
          if (url.searchParams.has('cursor')) {
            filter.cursor = url.searchParams.get('cursor') || ''
            if (!filter.cursor || filter.cursor.length > 400) throw new ApiError('游标无效')
          }
          sendJson(response, 200, {
            ok: true,
            result: await this.options.facade.getTimeline(filter),
          })
          return
        }
        case '/interaction/capabilities': {
          if (!this.options.facade.getInteractionCapabilities)
            throw new ApiError('互动分流能力发现未启用', 503)
          const result = await this.options.facade.getInteractionCapabilities()
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/interaction/config': {
          if (method === 'GET') {
            const accountId = requireInteractionId(url.searchParams.get('accountId'), 'accountId')
            if (!this.options.facade.getInteraction)
              throw new ApiError('互动分流配置能力未启用', 503)
            const result = await this.options.facade.getInteraction(accountId)
            sendJson(response, 200, { ok: true, result })
            return
          }
          const body = requireObject(await readJsonBody(request), '请求体')
          const accountId = requireInteractionId(body.accountId, 'accountId')
          if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0)
            throw new ApiError('revision 必须是非负安全整数；请先读取当前配置版本')
          const config = requireObject(body.config, 'config')
          if (!this.options.facade.applyInteraction)
            throw new ApiError('互动分流保存能力未启用', 503)
          const result = await this.options.facade.applyInteraction(
            accountId,
            body.revision as number,
            config,
          )
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/interaction/simulate': {
          const body = requireObject(await readJsonBody(request), '请求体')
          const accountId = requireInteractionId(body.accountId, 'accountId')
          const context = requireObject(body.context, 'context')
          const config =
            body.config === undefined ? undefined : requireObject(body.config, 'config')
          if (!this.options.facade.simulateInteraction)
            throw new ApiError('互动分流模拟能力未启用', 503)
          const result = await this.options.facade.simulateInteraction(accountId, context, config)
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/interaction/score/adjust': {
          const body = requireObject(await readJsonBody(request), '请求体')
          const accountId = requireInteractionId(body.accountId, 'accountId')
          if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0)
            throw new ApiError('revision 必须是非负安全整数')
          validateScoreAdjustment(body)
          if (!this.options.facade.adjustAudienceScore)
            throw new ApiError('人工评分能力未启用', 503)
          const result = await this.options.facade.adjustAudienceScore(
            accountId,
            body.revision as number,
            body,
          )
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/interaction/audience': {
          const accountId = requireInteractionId(url.searchParams.get('accountId'), 'accountId')
          const userId = url.searchParams.has('userId')
            ? requireInteractionId(url.searchParams.get('userId'), 'userId')
            : undefined
          const platform = url.searchParams.has('platform')
            ? requireInteractionId(url.searchParams.get('platform'), 'platform')
            : undefined
          if (!this.options.facade.getAudience) throw new ApiError('互动观众读取能力未启用', 503)
          const result = await this.options.facade.getAudience(accountId, userId, platform)
          sendJson(response, 200, { ok: true, result })
          return
        }
        case '/director/speech/analyze': {
          if (this.options.facade.isRunning()) throw new ApiError('请先停止导播再分析配音', 409)
          const body = requireObject(await readJsonBody(request), '请求体')
          if (!this.options.facade.analyzeSpeech) throw new ApiError('配音分析未启用', 503)
          const analysis = await this.options.facade.analyzeSpeech(
            body as unknown as SpeechAnalysisInput,
          )
          sendJson(response, 200, { ok: true, analysis })
          return
        }
        case '/director/authoring': {
          const body=requireObject(await readJsonBody(request),'请求体')
          if(!['authoring-prepare','authoring-status','authoring-render','authoring-cancel','authoring-candidate','authoring-images','authoring-audio'].includes(String(body.action)))
            throw new ApiError('目标模式只支持离线素材动作，不支持开播或保存',400)
          if(!this.options.facade.authoring)throw new ApiError('目标模式未启用',503)
          const result=await this.options.facade.authoring(body as unknown as Extract<DirectorCommand,{action:`authoring-${string}`}>)
          sendJson(response,200,result);return
        }
        case '/director/speech/plan': {
          if (this.options.facade.isRunning()) throw new ApiError('请先停止导播再保存气口', 409)
          const body = requireObject(await readJsonBody(request), '请求体')
          if (!this.options.facade.planSpeech) throw new ApiError('配音分析未启用', 503)
          if (
            typeof body.analysisId !== 'string' ||
            !Array.isArray(body.selections) ||
            (body.apply !== undefined && typeof body.apply !== 'boolean')
          )
            throw new ApiError('分析 id、逐句标注或 apply 无效')
          const ops = await this.options.facade.planSpeech(
            body.analysisId,
            body.selections as SpeechSelection[],
          )
          const result = applyDirectorOps(this.options.facade.getConfig(), ops)
          this.options.facade.validateConfig(result.config)
          if (body.apply === true) this.options.facade.saveConfig(result.config)
          sendJson(response, 200, { ok: true, ops, saved: body.apply === true })
          return
        }
        case '/director/config': {
          if (method === 'GET') {
            const view = url.searchParams.get('view') || 'summary'
            const config = this.options.facade.getConfig()
            sendJson(response, 200, {
              ok: true,
              view,
              config: view === 'full' ? config : summarizeDirectorConfig(config),
              running: this.options.facade.isRunning(),
            })
            return
          }
          const body = requireObject(await readJsonBody(request), '请求体')
          const config = requireObject(body.config, 'config') as unknown as DirectorConfig
          this.options.facade.validateConfig(config)
          this.options.facade.saveConfig(config)
          sendJson(response, 200, {
            ok: true,
            message: '配置已保存',
            config: summarizeDirectorConfig(this.options.facade.getConfig()),
            warnings: directorStepRewinds(this.options.facade.getConfig()),
          })
          return
        }
        case '/director/ops': {
          const body = requireObject(await readJsonBody(request), '请求体')
          const ops = body.ops
          if (!Array.isArray(ops)) throw new ApiError('ops 必须是数组')
          const result = this.applyAndSave(ops as DirectorOp[])
          sendJson(response, 200, {
            ok: true,
            applied: result.applied,
            message: `已应用 ${result.applied.length} 条操作`,
            config: summarizeDirectorConfig(result.config),
            warnings: directorStepRewinds(result.config),
          })
          return
        }
        case '/director/validate': {
          const body = requireObject(await readJsonBody(request), '请求体')
          if (body.ops !== undefined) {
            if (!Array.isArray(body.ops)) throw new ApiError('ops 必须是数组')
            const result = applyDirectorOps(
              this.options.facade.getConfig(),
              body.ops as DirectorOp[],
            )
            this.options.facade.validateConfig(result.config)
            sendJson(response, 200, {
              ok: true,
              applied: result.applied,
              saved: false,
              warnings: directorStepRewinds(result.config),
            })
            return
          }
          if (body.config !== undefined) {
            const config = requireObject(body.config, 'config') as unknown as DirectorConfig
            this.options.facade.validateConfig(config)
            sendJson(response, 200, {
              ok: true,
              saved: false,
              warnings: directorStepRewinds(config),
            })
            return
          }
          throw new ApiError('请提供 ops 或 config')
        }
        case '/director/state': {
          sendJson(response, 200, {
            ok: true,
            state: this.options.facade.getState() ?? null,
            running: this.options.facade.isRunning(),
          })
          return
        }
        case '/obs/scenes': {
          const scenes = await this.options.facade.discoverObs()
          sendJson(response, 200, { ok: true, scenes })
          return
        }
        default:
          throw new ApiError(`没有这个接口：${method} ${path}`, 404)
      }
    } catch (error) {
      if (error instanceof AnalysisError) {
        const result = analysisFailure(error)
        // Preserve the generic contract for unknown/malformed error codes.
        if (!result.ok && result.error.code === error.code) {
          if (!response.headersSent) sendJson(response, analysisHttpStatus(result), result)
          else response.end()
          return
        }
      }
      const status = error instanceof ApiError || error instanceof LiveVoiceConfigError ? error.status : 400
      const message = error instanceof Error ? error.message : String(error)
      if (status >= 500) this.log(`接口出错：${message}`)
      if (!response.headersSent) sendJson(response, status, { ok: false, error: message })
      else response.end()
    }
  }

  /** 应用操作 → 校验 → 保存，任何一步失败都不会写入 */
  private applyAndSave(ops: DirectorOp[]) {
    const result = applyDirectorOps(this.options.facade.getConfig(), ops)
    this.options.facade.validateConfig(result.config)
    this.options.facade.saveConfig(result.config)
    return result
  }
}

const DIRECTOR_OP_HELP = [
  {
    op: 'setConfig',
    fields:
      'patch：scene、canvasWidth/Height、transitionMs、normalSeconds、requestSeconds、interruptAOnRequest、queueSkipsOverview、maxQueue、cooldownSeconds、popup、listen、aiPolicy、interaction、transition、ffmpeg、ffprobe',
  },
  {
    op: 'upsertTray',
    fields:
      'tray：{id?, name, summary?, stateGroup?, transitionIn?, transitionOut?}（按 id 或同名合并，不存在则新建）',
  },
  { op: 'deleteTray', fields: 'trayId（id 或托盘名称）' },
  {
    op: 'upsertProduct',
    fields:
      'trayId + product：{id（观众用的编号）, name, aliases?, goodsId?, stateGroups?, facts?}',
  },
  { op: 'deleteProduct', fields: 'trayId + productId' },
  {
    op: 'upsertStep',
    fields:
      'path：{trayId, productId?, mode:A|B|C} + step：{id?, name?, kind?, file?, start?, end?, audio?, audioOverflow?, speechSlot?, speechWindows?:[{audio,start,end}], cues?, goodsId?, overlayGroup?, overlayVariants?, stepGroup?, duration?, caption?, optional?}',
  },
  { op: 'deleteStep', fields: 'path + stepId' },
  { op: 'moveStep', fields: 'path + stepId + toIndex' },
]
