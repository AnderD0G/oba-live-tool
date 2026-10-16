import { randomUUID } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import { isIP } from 'node:net'
import {
  XIAOMI_PREVIEW_MAX_AGE_MS,
  type XiaomiCameraCommand,
  type XiaomiCameraOperation,
  type XiaomiCameraResult,
  type XiaomiCameraSettings,
  type XiaomiCameraStatus,
} from '../../../shared/xiaomiCamera'

export interface XiaomiCameraPrivateConfig {
  baseUrl: string
  token: string
}
export interface XiaomiCameraConfigStore {
  load(): XiaomiCameraPrivateConfig
  save(config: XiaomiCameraPrivateConfig): void
}
export interface XiaomiCameraHttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  maxBytes: number
}
export interface XiaomiCameraHttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}
export type XiaomiCameraTransport = (
  request: XiaomiCameraHttpRequest,
) => Promise<XiaomiCameraHttpResponse>

class CameraError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message)
  }
}
const fail = (code: string, message: string, outcomeUnknown = false): never => {
  throw new CameraError(code, message, outcomeUnknown)
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function validateXiaomiCameraBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200)
    return fail('XIAOMI_INVALID_CONFIG', '相机地址必须是私网 IPv4 HTTP 地址')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail('XIAOMI_INVALID_CONFIG', '相机地址无效')
  }
  const octets = url.hostname.split('.').map(Number)
  const privateIp =
    isIP(url.hostname) === 4 &&
    (octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !privateIp ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return fail('XIAOMI_INVALID_CONFIG', '只允许私网 IPv4 服务地址，不能包含账号、路径或查询参数')
  }
  return url.origin
}

export function validateXiaomiCameraToken(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || (value && !/^[!-~]+$/.test(value)))
    return fail('XIAOMI_INVALID_CONFIG', '相机密钥格式无效')
  return value
}

function command(value: unknown): XiaomiCameraCommand {
  if (!record(value) || typeof value.action !== 'string')
    return fail('XIAOMI_INVALID_COMMAND', '相机操作参数无效')
  const keys = ['action']
  if (value.action === 'zoom') {
    keys.push('ratio')
    if (!number(value.ratio, 1, 10))
      return fail('XIAOMI_INVALID_COMMAND', '变焦倍率必须在 1～10 之间')
  } else if (value.action === 'focus') {
    keys.push('x', 'y', 'previewId')
    if (
      !number(value.x, 0, 1) ||
      !number(value.y, 0, 1) ||
      typeof value.previewId !== 'string' ||
      value.previewId.length < 1 ||
      value.previewId.length > 100
    ) {
      return fail('XIAOMI_INVALID_COMMAND', '请在新鲜预览图像内选点对焦')
    }
  } else if (value.action === 'config-save') {
    keys.push('config')
    if (
      !record(value.config) ||
      Object.keys(value.config).some(key => !['baseUrl', 'token'].includes(key)) ||
      typeof value.config.baseUrl !== 'string' ||
      (value.config.token !== undefined && typeof value.config.token !== 'string')
    ) {
      return fail('XIAOMI_INVALID_COMMAND', '相机配置参数无效')
    }
  } else if (
    !['config-get', 'status', 'settings', 'start', 'stop', 'autofocus', 'preview'].includes(
      value.action,
    )
  ) {
    return fail('XIAOMI_INVALID_COMMAND', '不支持的相机操作')
  }
  if (Object.keys(value).some(key => !keys.includes(key)))
    return fail('XIAOMI_INVALID_COMMAND', '相机操作包含不支持的参数')
  return value as unknown as XiaomiCameraCommand
}

const safeCodes = new Set([
  'probe_failed',
  'device_offline',
  'identity_mismatch',
  'ambiguous_device',
  'operation_failed',
  'operation_timeout',
  'operation_busy',
  'verification_failed',
  'backend_failed',
  'state_unavailable',
  'unauthorized',
  'invalid_parameters',
  'controls_unavailable',
  'control_unavailable',
  'preview_unavailable',
  'preview_stale',
  'focus_unsupported',
  'not_ready',
  'zoom_failed',
  'focus_failed',
])
const safeCode = (value: unknown) =>
  typeof value === 'string' && safeCodes.has(value) ? value : undefined
const focusValues = new Set([
  'continuous_video',
  'continuous_picture',
  'auto',
  'off',
  'unknown',
  'none',
  'focused',
  'not_focused',
  'timeout',
  'cancelled',
  'failed',
  'passive_scan',
  'passive_focused',
  'active_scan',
  'focused_locked',
  'not_focused_locked',
  'passive_unfocused',
  'inactive',
  'pending',
])

function status(value: Record<string, unknown>): XiaomiCameraStatus | undefined {
  if (
    !['off', 'ready', 'capturing', 'offline', 'unknown'].includes(String(value.state)) ||
    typeof value.timestamp !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp))
  )
    return undefined
  return {
    state: value.state as XiaomiCameraStatus['state'],
    timestamp: value.timestamp,
    ...(safeCode(value.error) ? { error: safeCode(value.error) } : {}),
  }
}

function settings(value: Record<string, unknown>): XiaomiCameraSettings | undefined {
  if (typeof value.available !== 'boolean') return undefined
  const output: XiaomiCameraSettings = { available: value.available }
  for (const key of ['ready', 'focus_supported', 'focus_pending'] as const)
    if (typeof value[key] === 'boolean') output[key] = value[key]
  for (const key of ['zoom', 'zoom_min', 'zoom_max', 'saved_zoom'] as const)
    if (number(value[key], 1, 10)) output[key] = value[key]
  if (value.observed_zoom === null || number(value.observed_zoom, 1, 10))
    output.observed_zoom = value.observed_zoom
  for (const key of [
    'focus_mode',
    'observed_focus_mode',
    'focus_state',
    'last_focus_result',
  ] as const) {
    if (value[key] === null && key === 'observed_focus_mode') output.observed_focus_mode = null
    else if (typeof value[key] === 'string' && focusValues.has(value[key])) output[key] = value[key]
  }
  if (value.last_control_error === null) output.last_control_error = null
  else if (safeCode(value.last_control_error))
    output.last_control_error = safeCode(value.last_control_error)
  if (number(value.timestamp_ms, 0, Number.MAX_SAFE_INTEGER))
    output.timestamp_ms = value.timestamp_ms
  if (safeCode(value.error)) output.error = safeCode(value.error)
  return output
}

function operation(value: Record<string, unknown>): XiaomiCameraOperation {
  const output: XiaomiCameraOperation = { success: value.success === true }
  for (const key of ['changed', 'applied', 'saved', 'focus_submitted'] as const)
    if (typeof value[key] === 'boolean') output[key] = value[key]
  return output
}

/** No environment proxy and no redirect handling. Credentials stay on the configured LAN host. */
export const xiaomiCameraHttpTransport: XiaomiCameraTransport = request =>
  new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const failRequest = (error: unknown) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    }
    const target = new URL(request.url)
    const client = target.protocol === 'https:' ? https : http
    const outgoing = client.request(
      target,
      { method: request.method, headers: request.headers },
      response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > request.maxBytes) {
            // Reject before destroying streams: a fully buffered response can emit
            // end before ClientRequest propagates a destroy(error) asynchronously.
            failRequest(
              Object.assign(new Error('Response too large'), { code: 'XIAOMI_RESPONSE_TOO_LARGE' }),
            )
            response.destroy()
            outgoing.destroy()
          } else chunks.push(chunk)
        })
        response.on('end', () => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers))
            if (typeof value === 'string') headers[key] = value
          resolve({ status: response.statusCode || 0, headers, body: Buffer.concat(chunks) })
        })
        response.on('error', failRequest)
        response.on('close', () => {
          if (!response.complete) failRequest(new Error('Incomplete camera response'))
        })
      },
    )
    timer = setTimeout(() => {
      failRequest(Object.assign(new Error('Camera request timed out'), { code: 'ETIMEDOUT' }))
      outgoing.destroy()
    }, request.timeoutMs)
    outgoing.on('error', failRequest)
    if (request.body !== undefined) outgoing.write(request.body)
    outgoing.end()
  })

export class XiaomiCameraService {
  private readonly transport: XiaomiCameraTransport
  private readonly now: () => number
  private busy = false
  private lastWrite = Number.NEGATIVE_INFINITY
  private revision = 0
  private pendingZoom?: number
  private latestSettings?: XiaomiCameraSettings
  private previews = new Map<string, { expiresAt: number; revision: number }>()

  constructor(
    private options: {
      store: XiaomiCameraConfigStore
      transport?: XiaomiCameraTransport
      now?: () => number
    },
  ) {
    this.transport = options.transport || xiaomiCameraHttpTransport
    this.now = options.now || Date.now
  }

  private invalidatePreview() {
    this.revision++
    this.previews.clear()
  }

  async execute(input: unknown): Promise<XiaomiCameraResult> {
    let writing = false
    try {
      const value = command(input)
      const stored = this.options.store.load()
      const config = {
        baseUrl: validateXiaomiCameraBaseUrl(stored.baseUrl),
        token: validateXiaomiCameraToken(stored.token),
      }
      if (value.action === 'config-get')
        return { ok: true, config: { baseUrl: config.baseUrl, hasToken: !!config.token } }
      if (value.action === 'config-save') {
        if (this.busy) return fail('XIAOMI_BUSY', '相机操作正在执行，请完成后再保存配置')
        const next = {
          baseUrl: validateXiaomiCameraBaseUrl(value.config.baseUrl),
          token:
            value.config.token === undefined
              ? config.token
              : validateXiaomiCameraToken(value.config.token),
        }
        this.options.store.save(next)
        this.invalidatePreview()
        this.pendingZoom = undefined
        this.latestSettings = undefined
        return {
          ok: true,
          config: { baseUrl: next.baseUrl, hasToken: !!next.token },
          message: '小米相机连接配置已安全保存',
        }
      }
      if (!config.token) return fail('XIAOMI_TOKEN_REQUIRED', '请先在电脑上保存小米相机访问密钥')
      const write = ['start', 'stop', 'zoom', 'focus', 'autofocus'].includes(value.action)
      if (value.action === 'focus') {
        const preview = this.previews.get(value.previewId)
        if (!preview || preview.revision !== this.revision || preview.expiresAt <= this.now())
          return fail('XIAOMI_PREVIEW_STALE', '预览已过期或取景已改变，请刷新图像后再对焦')
      }
      if (value.action === 'preview' && this.pendingZoom !== undefined)
        return fail('XIAOMI_ZOOM_PENDING', '请先刷新镜头设置，等待实际倍率确认后再获取预览')
      if (write) {
        if (this.busy) return fail('XIAOMI_BUSY', '已有相机操作正在执行，请勿重复操作')
        if (this.now() - this.lastWrite < 200)
          return fail('XIAOMI_RATE_LIMITED', '相机操作过于频繁，请稍后再试')
        if (
          ['zoom', 'focus', 'autofocus'].includes(value.action) &&
          this.latestSettings?.available === false
        )
          return fail('XIAOMI_CONTROLS_UNAVAILABLE', '镜头控制暂不可用，请刷新相机状态和设置')
        if (
          value.action === 'zoom' &&
          !number(
            value.ratio,
            this.latestSettings?.zoom_min || 1,
            this.latestSettings?.zoom_max || 10,
          )
        )
          return fail('XIAOMI_INVALID_COMMAND', '倍率超出相机当前支持范围')
        this.busy = true
        writing = true
        this.lastWrite = this.now()
        this.invalidatePreview()
      }
      const revision = this.revision
      const requestStartedAt = this.now()
      const suffix =
        value.action === 'status'
          ? ''
          : value.action === 'preview'
            ? '/preview.jpg'
            : `/${value.action}`
      const body =
        value.action === 'zoom'
          ? { ratio: value.ratio }
          : value.action === 'focus'
            ? { x: value.x, y: value.y }
            : {}
      const request: XiaomiCameraHttpRequest = {
        url: `${config.baseUrl}/v1/camera${suffix}`,
        method: write ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: value.action === 'preview' ? 'image/jpeg' : 'application/json',
        },
        timeoutMs: value.action === 'start' || value.action === 'stop' ? 180000 : 30000,
        maxBytes: value.action === 'preview' ? 512 * 1024 : 65536,
      }
      if (write) {
        request.body = JSON.stringify(body)
        request.headers['Content-Type'] = 'application/json'
        request.headers['Content-Length'] = String(Buffer.byteLength(request.body))
      }
      const response = await this.transport(request)
      if (response.status >= 300 && response.status < 400)
        return fail('XIAOMI_REDIRECT_BLOCKED', '相机服务返回重定向，已拒绝转发密钥')
      if (response.body.length > request.maxBytes)
        return fail('XIAOMI_INVALID_RESPONSE', '相机响应超出允许大小')
      if (value.action === 'preview' && response.status === 200) {
        const bytes = Buffer.from(response.body)
        const age = Number(response.headers['x-preview-age-ms'])
        const capturedAt = requestStartedAt - age
        const expiresAt = capturedAt + XIAOMI_PREVIEW_MAX_AGE_MS
        if (
          !response.headers['content-type']?.toLowerCase().startsWith('image/jpeg') ||
          bytes.length < 4 ||
          bytes[0] !== 255 ||
          bytes[1] !== 216 ||
          bytes.at(-2) !== 255 ||
          bytes.at(-1) !== 217
        )
          return fail('XIAOMI_INVALID_RESPONSE', '相机没有返回有效 JPEG 预览')
        if (
          !Number.isInteger(age) ||
          age < 0 ||
          age > 2000 ||
          expiresAt <= this.now() ||
          revision !== this.revision
        )
          return fail('XIAOMI_PREVIEW_STALE', '没有可用于选点的新鲜预览，请稍后刷新')
        for (const [id, preview] of this.previews)
          if (preview.expiresAt <= this.now()) this.previews.delete(id)
        while (this.previews.size >= 4) {
          const oldest = this.previews.keys().next()
          if (oldest.done) break
          this.previews.delete(oldest.value)
        }
        const id = randomUUID()
        this.previews.set(id, { expiresAt, revision })
        return {
          ok: true,
          preview: {
            id,
            dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
            capturedAt,
            expiresAt,
          },
        }
      }
      let raw: unknown
      try {
        raw = JSON.parse(Buffer.from(response.body).toString('utf8'))
      } catch {
        return fail('XIAOMI_INVALID_RESPONSE', '相机服务返回格式无效')
      }
      if (!record(raw)) return fail('XIAOMI_INVALID_RESPONSE', '相机服务返回格式无效')
      const camera = status(raw)
      const controls = settings(raw)
      if (response.status !== 200)
        return {
          ok: false,
          ...(camera ? { camera } : {}),
          ...(controls ? { settings: controls } : {}),
          error: {
            code: `XIAOMI_HTTP_${response.status}`,
            message:
              response.status === 401
                ? '相机服务鉴权失败，请在电脑上核对密钥'
                : response.status === 409
                  ? '相机服务正在执行另一操作，请先查询状态'
                  : value.action === 'preview'
                    ? '暂时没有新鲜预览，请稍后刷新'
                    : '相机服务未确认操作，请重新查询状态和设置',
            ...(write ? { outcomeUnknown: true } : {}),
          },
        }
      if (value.action === 'status') {
        if (!camera) return fail('XIAOMI_INVALID_RESPONSE', '相机状态响应无效')
        return { ok: true, camera }
      }
      if (value.action === 'settings') {
        if (!controls) return fail('XIAOMI_INVALID_RESPONSE', '相机镜头设置响应无效')
        if (revision === this.revision) {
          this.latestSettings = controls
          if (
            this.pendingZoom !== undefined &&
            typeof controls.observed_zoom === 'number' &&
            Math.abs(controls.observed_zoom - this.pendingZoom) <= 0.05
          )
            this.pendingZoom = undefined
        }
        return { ok: true, settings: controls }
      }
      const applied = operation(raw)
      const result: XiaomiCameraResult = {
        ok: false,
        ...(camera ? { camera } : {}),
        ...(controls ? { settings: controls } : {}),
        operation: applied,
      }
      const targetReached =
        value.action === 'start'
          ? camera && ['ready', 'capturing'].includes(camera.state)
          : value.action === 'stop'
            ? camera?.state === 'off'
            : applied.applied === true
      if (
        !applied.success ||
        !targetReached ||
        (['start', 'stop'].includes(value.action) && typeof applied.changed !== 'boolean')
      ) {
        return {
          ...result,
          error: {
            code: 'XIAOMI_NOT_CONFIRMED',
            message: '相机没有确认该操作已生效，请刷新状态和设置',
          },
        }
      }
      if (value.action === 'zoom') this.pendingZoom = value.ratio
      return {
        ...result,
        ok: true,
        message:
          value.action === 'zoom'
            ? applied.saved === true
              ? '倍率已应用并保存，等待实际倍率观测确认'
              : applied.saved === false
                ? '倍率已应用，但未保存到下次启动'
                : '倍率已应用，保存状态尚未确认'
            : value.action === 'focus'
              ? applied.focus_submitted === true
                ? '对焦请求已提交，请观察画面；不代表主体已清晰'
                : '对焦操作已接受，手机提交状态尚未确认，请观察画面'
              : value.action === 'autofocus'
                ? '连续自动对焦请求已接受，请观察画面'
                : value.action === 'stop'
                  ? '已核验小米相机关闭'
                  : '已核验小米相机就绪；视频效果以实际画面为准',
      }
    } catch (error) {
      if (error instanceof CameraError)
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
          },
        }
      const code = record(error) ? error.code : undefined
      if (code === 'XIAOMI_CONFIG_UNREADABLE')
        return {
          ok: false,
          error: { code, message: '小米相机私有配置不可用，请在电脑上检查配置和权限' },
        }
      return {
        ok: false,
        error: {
          code: code === 'ETIMEDOUT' ? 'XIAOMI_TIMEOUT' : 'XIAOMI_CONNECTION_FAILED',
          message: writing
            ? '请求结果未确认；请先刷新相机状态和设置，不要据此认定相机已停止'
            : '无法读取相机服务，请核对局域网连接和服务配置',
          ...(writing ? { outcomeUnknown: true } : {}),
        },
      }
    } finally {
      if (writing) this.busy = false
    }
  }
}
