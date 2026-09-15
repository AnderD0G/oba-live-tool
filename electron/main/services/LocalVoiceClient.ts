import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface VoiceState {
  model_status: string
  model_error?: string
  reference_ready: boolean
  armed: boolean
  output: number | null
  jobs: Array<{ id: string; status: string; error?: string }>
}

/** Loopback-only bridge; credentials stay in the Electron main process. */
export class LocalVoiceClient {
  private active = new Set<string>()

  async cancelActive() {
    await Promise.all(
      [...this.active].map(request_id => this.request('/v1/cancel', { request_id })),
    )
  }

  get isActive() {
    return this.active.size > 0
  }
  constructor(
    private tokenPath: () => Promise<string>,
    private baseUrl = 'http://127.0.0.1:17863',
    private pollMs = 400,
  ) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('语音接口仅支持本机 127.0.0.1')
  }

  private async request(path: string, body?: object, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const token = (await readFile(await this.tokenPath(), 'utf8')).trim()
    signal?.throwIfAborted()
    const response = await fetch(this.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Voice-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { detail?: string }
      throw new Error(
        typeof data.detail === 'string' ? data.detail : `语音台返回 ${response.status}`,
      )
    }
    return response.json()
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    try {
      const state = (await this.request('/v1/status')) as VoiceState
      if (state.model_status !== '就绪') throw new Error(state.model_error || '语音模型还未就绪')
      if (!state.reference_ready) throw new Error('请先在语音台保存参考录音')
      if (!state.armed || state.output === null) throw new Error('请先在语音台开启声卡播报')
      return { ok: true, message: '语音台已连接，音色与声卡播报均已就绪' }
    } catch (error) {
      return { ok: false, message: this.describe(error) }
    }
  }

  private describe(error: unknown) {
    if (error instanceof Error && !/ENOENT|fetch failed/.test(error.message)) return error.message
    return '无法连接本地语音台，请启动 127.0.0.1:17863 并检查连接配置'
  }

  async speak(
    accountId: string,
    commentId: string,
    text: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) {
    const requestId =
      'oba-' +
      createHash('sha256')
        .update(JSON.stringify([accountId, commentId]))
        .digest('hex')
    signal.throwIfAborted()
    this.active.add(requestId)
    try {
      const job = (await this.request(
        '/v1/speak',
        { text, mode: 'broadcast', request_id: requestId },
        signal,
      )) as { id: string }
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const state = (await this.request('/v1/status', undefined, signal)) as VoiceState
        const item = state.jobs.find(j => j.id === job.id)
        if (!item) throw new Error('语音任务已丢失，可能服务已重启；不会自动重发')
        progress(`语音台：${item.status}`)
        if (item.status === '声卡播放完成') {
          return
        }
        if (item.status === '失败' || item.status === '已取消')
          throw new Error(item.error || `语音任务${item.status}`)
        await delay(this.pollMs, undefined, { signal })
      }
      throw new Error('语音任务超时，已停止自动语音回复')
    } catch (error) {
      // A tombstone also cancels a submitted job whose HTTP response was lost.
      try {
        await this.request('/v1/cancel', { request_id: requestId })
      } catch {
        throw new Error('无法确认取消语音，请在语音台点击“立即停止”')
      }
      throw new Error(signal.aborted ? '自动语音已关闭，已请求取消本条播报' : this.describe(error))
    } finally {
      this.active.delete(requestId)
    }
  }
}

export async function configuredVoiceTokenPath(userData: string): Promise<string> {
  const configured =
    process.env.OBA_VOICE_TOKEN_FILE ||
    (
      JSON.parse(await readFile(join(userData, 'voice-connection.json'), 'utf8')) as {
        tokenFile?: string
      }
    ).tokenFile
  if (!configured || !isAbsolute(configured))
    throw new Error('请配置本地语音台连接文件 voice-connection.json')
  return configured
}
