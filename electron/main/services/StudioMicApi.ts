import type { StudioMicHotkeyResult, StudioMicHotkeyState } from '../../../shared/studioMicHotkey'

const ORIGIN = 'http://127.0.0.1:18766'
const MAX_BYTES = 64 * 1024
type ApiFetch = (url: string, init: RequestInit) => Promise<Response>
interface Options {
  platform?: string
  fetch?: ApiFetch
}
class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
function failure(code: string, message: string): StudioMicHotkeyResult {
  return { ok: false, error: { code, message } }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key))
}
function state(muted: boolean, beforeMuted?: boolean): StudioMicHotkeyState {
  return {
    supported: true,
    running: true,
    accessGranted: true,
    backend: 'api',
    hotkey: '',
    micState: muted ? 'muted' : 'unmuted',
    ...(beforeMuted === undefined ? {} : { beforeMuted }),
    message: muted ? 'TK Studio 麦克风已静音' : 'TK Studio 麦克风已开麦',
  }
}
function validStatus(value: unknown): value is { muted: boolean } {
  if (
    !record(value) ||
    !keys(value, ['muted', 'port', 'inputs']) ||
    typeof value.muted !== 'boolean'
  )
    return false
  if (
    value.port !== undefined &&
    value.port !== null &&
    !(Number.isInteger(value.port) && Number(value.port) >= 1 && Number(value.port) <= 65535)
  )
    return false
  if (value.inputs === undefined) return true
  if (!Array.isArray(value.inputs) || value.inputs.length > 64) return false
  for (const input of value.inputs) {
    if (
      !record(input) ||
      !keys(input, ['name', 'id', 'device', 'muted', 'volume']) ||
      typeof input.muted !== 'boolean'
    )
      return false
    for (const key of ['name', 'id', 'device'])
      if (
        input[key] !== undefined &&
        input[key] !== null &&
        (typeof input[key] !== 'string' || (input[key] as string).length > 1000)
      )
        return false
    if (
      input.volume !== undefined &&
      input.volume !== null &&
      (typeof input.volume !== 'number' || !Number.isFinite(input.volume) || input.volume < 0)
    )
      return false
  }
  return value.inputs.length === 0 || value.muted === value.inputs.every(input => input.muted)
}

/** Fixed local API only; it never executes native helpers, accepts endpoints or follows redirects. */
export class StudioMicApi {
  private writing = false
  private readonly fetch: ApiFetch
  constructor(private readonly options: Options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private async request(
    path: '/v1/mic' | '/v1/mic/toggle',
    method: 'GET' | 'PUT' | 'POST',
    muted?: boolean,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), method === 'GET' ? 5000 : 10000)
    try {
      const response = await this.fetch(`${ORIGIN}${path}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(muted === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(muted === undefined ? {} : { body: JSON.stringify({ muted }) }),
      })
      if (!response.ok)
        throw new ApiError(
          'STUDIO_MIC_API_UNAVAILABLE',
          'TK Studio 麦克风接口未就绪，请检查服务连接',
        )
      if (
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
          'application/json' ||
        Number(response.headers.get('content-length')) > MAX_BYTES ||
        !response.body
      )
        throw new ApiError('STUDIO_MIC_API_INVALID_RESPONSE', '麦克风接口返回了无效状态')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          length += next.value.byteLength
          if (length > MAX_BYTES) {
            controller.abort()
            throw new ApiError('STUDIO_MIC_API_INVALID_RESPONSE', '麦克风接口响应超过上限')
          }
          chunks.push(next.value)
        }
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } finally {
      clearTimeout(timer)
    }
  }

  private error(error: unknown): StudioMicHotkeyResult {
    if (error instanceof ApiError) return failure(error.code, error.message)
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      return failure(
        'STUDIO_MIC_API_TIMEOUT',
        '麦克风操作超时，结果未确认；请重新读取状态，不要重复切换',
      )
    return failure(
      'STUDIO_MIC_API_UNAVAILABLE',
      '麦克风接口未连接或状态无效，请检查本机 18766 服务',
    )
  }
  private supported() {
    return (this.options.platform ?? process.platform) === 'darwin'
  }
  async execute(command: unknown): Promise<StudioMicHotkeyResult> {
    if (
      !record(command) ||
      Object.keys(command).length !== 1 ||
      !['status', 'toggle'].includes(command.action as string)
    )
      return failure('STUDIO_MIC_API_INVALID_COMMAND', '麦克风接口操作参数无效')
    if (!this.supported())
      return command.action === 'status'
        ? {
            ok: true,
            data: {
              supported: false,
              running: false,
              accessGranted: false,
              backend: 'api',
              hotkey: '',
              micState: 'unknown',
              message: '此本地麦克风接口当前仅在 Mac 启用',
            },
          }
        : failure('STUDIO_MIC_UNSUPPORTED_PLATFORM', '此本地麦克风接口当前仅在 Mac 启用')
    if (command.action === 'toggle') return this.write(undefined)
    try {
      const value = await this.request('/v1/mic', 'GET')
      if (!validStatus(value))
        return failure('STUDIO_MIC_API_INVALID_RESPONSE', '麦克风接口返回了无效或不一致的状态')
      return { ok: true, data: state(value.muted) }
    } catch (error) {
      return this.error(error)
    }
  }
  async setMuted(muted: boolean): Promise<StudioMicHotkeyResult> {
    if (typeof muted !== 'boolean')
      return failure('STUDIO_MIC_API_INVALID_COMMAND', '静音目标须为布尔值')
    if (!this.supported())
      return failure('STUDIO_MIC_UNSUPPORTED_PLATFORM', '此本地麦克风接口当前仅在 Mac 启用')
    return this.write(muted)
  }
  private async write(muted: boolean | undefined): Promise<StudioMicHotkeyResult> {
    if (this.writing) return failure('STUDIO_MIC_API_BUSY', '麦克风操作正在进行，请稍候')
    this.writing = true
    try {
      const value = await this.request(
        muted === undefined ? '/v1/mic/toggle' : '/v1/mic',
        muted === undefined ? 'POST' : 'PUT',
        muted,
      )
      if (
        !record(value) ||
        !keys(value, ['changed', 'before', 'after', 'result_code']) ||
        typeof value.changed !== 'boolean' ||
        typeof value.before !== 'boolean' ||
        typeof value.after !== 'boolean' ||
        value.changed !== (value.before !== value.after) ||
        (value.changed
          ? value.result_code !== 0
          : ![null, 0].includes(value.result_code as null | number))
      )
        return failure('STUDIO_MIC_API_UNCONFIRMED', '麦克风接口未确认操作成功，请重新读取状态')
      if (muted === undefined ? !value.changed : value.after !== muted)
        return failure('STUDIO_MIC_API_UNCONFIRMED', '麦克风状态未达到目标，豆包录音不会开始')
      return { ok: true, data: state(value.after, value.before) }
    } catch (error) {
      return this.error(error)
    } finally {
      this.writing = false
    }
  }
}
