import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = 'C:\\Users\\luizs\\Desktop\\voice'
const CHECKPOINT = `${ROOT}\\outputs\\qwen_training\\zhubo_v1_100steps\\checkpoint-step-100`
const STARTUP_TIMEOUT = 12 * 60 * 1000

export interface QwenHealth {
  model: string
  backend: string
  speaker: string | null
  checkpoint: string
  ready: boolean
  loaded_on_gpu: boolean
  busy: boolean
  state: string
  error?: string | null
  pid?: number
}

export interface QwenVoiceOptions {
  baseUrl?: string
  fetch?: typeof fetch
  launcher?: () => Promise<void>
  pollMs?: number
  startupTimeoutMs?: number
  retryCooldownMs?: number
  maxQueue?: number
  maxAudioBytes?: number
  jobTimeoutMs?: number
}

export interface QwenSynthesisOptions {
  /** Higher values run first. Use 0 for warmups and 10 for formal replies. */
  priority?: number
  expiresAt?: number
}

interface Job {
  text: string
  priority: number
  signal: AbortSignal
  resolve: (audio: Uint8Array) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

class IdentityError extends Error {}
class BusyError extends Error {}

function launchQwen(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      `${ROOT}\\runtime\\qwen06-env\\Scripts\\python.exe`,
      [`${ROOT}\\scripts\\qwen_start.py`],
      { windowsHide: true, timeout: STARTUP_TIMEOUT, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        // Never include subprocess output in errors: only consume the documented JSON result.
        if (error) {
          reject(new Error('千问启动失败，请检查本地服务日志'))
          return
        }
        try {
          const result = JSON.parse(stdout.trim())
          if (result.ok !== true || result.ready !== true) throw new Error('not ready')
          resolve()
        } catch {
          reject(new Error('千问启动器未确认服务就绪'))
        }
      },
    )
  })
}

/** One process-wide scheduler for the shared GPU; no service shutdown or remote cancellation. */
export class QwenVoiceClient {
  private readonly base: string
  private readonly transport: typeof fetch
  private readonly launcher: () => Promise<void>
  private readonly pollMs: number
  private readonly startupTimeoutMs: number
  private readonly retryCooldownMs: number
  private readonly maxQueue: number
  private readonly maxAudioBytes: number
  private readonly jobTimeoutMs: number
  private queue: Job[] = []
  private pumping = false
  private active = false
  private health?: QwenHealth
  private startup?: Promise<QwenHealth>
  private starting = false
  private lastFailure = 0
  private error?: string

  constructor(options: QwenVoiceOptions = {}) {
    const url = new URL(options.baseUrl ?? 'http://127.0.0.1:17899')
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('千问语音接口仅支持本机 127.0.0.1')
    this.base = url.origin
    this.transport = options.fetch ?? fetch
    this.launcher = options.launcher ?? launchQwen
    this.pollMs = options.pollMs ?? 250
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT
    this.retryCooldownMs = options.retryCooldownMs ?? 30000
    this.maxQueue = options.maxQueue ?? 16
    this.maxAudioBytes = options.maxAudioBytes ?? 10 * 1024 * 1024
    this.jobTimeoutMs = options.jobTimeoutMs ?? 60000
    for (const value of [
      this.pollMs,
      this.startupTimeoutMs,
      this.retryCooldownMs,
      this.maxQueue,
      this.maxAudioBytes,
      this.jobTimeoutMs,
    ])
      if (!Number.isFinite(value) || value <= 0) throw new Error('千问语音限制参数必须为正数')
  }

  get status() {
    const ready = this.health?.ready === true && this.health.loaded_on_gpu === true
    const busy = this.active || this.health?.busy === true
    const state: 'idle' | 'starting' | 'ready' | 'busy' | 'error' = this.starting
      ? 'starting'
      : this.error
        ? 'error'
        : busy
          ? 'busy'
          : ready
            ? 'ready'
            : 'idle'
    return {
      state,
      ready,
      busy,
      queued: this.queue.length,
      error: this.error,
      health: this.health ? { ...this.health } : undefined,
    }
  }

  private async readHealth(): Promise<QwenHealth> {
    const response = await this.transport(`${this.base}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`千问健康检查失败 (${response.status})`)
    const data = (await response.json()) as QwenHealth
    const normalize = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    if (
      data?.model !== 'qwen06' ||
      data.backend !== 'cuda-graphs' ||
      (data.speaker !== 'xiaodong_qwen_01' &&
        !(
          data.speaker === null &&
          data.state === 'loading' &&
          data.ready === false &&
          data.loaded_on_gpu === false
        )) ||
      typeof data.checkpoint !== 'string' ||
      normalize(data.checkpoint) !== normalize(CHECKPOINT)
    )
      throw new IdentityError('千问服务身份不匹配：需指定模型、音色、后端和 checkpoint')
    if (
      typeof data.ready !== 'boolean' ||
      typeof data.loaded_on_gpu !== 'boolean' ||
      typeof data.busy !== 'boolean'
    )
      throw new IdentityError('千问健康响应字段无效')
    this.health = data
    return data
  }

  ensureReady(): Promise<QwenHealth> {
    if (this.startup) return this.startup
    this.startup = this.prepareService().finally(() => {
      this.startup = undefined
    })
    return this.startup
  }

  private async prepareService(): Promise<QwenHealth> {
    try {
      let health: QwenHealth | undefined
      try {
        health = await this.readHealth()
      } catch (error) {
        if (error instanceof IdentityError) throw error
      }
      if (health?.ready && health.loaded_on_gpu) {
        this.error = undefined
        return health
      }
      if (this.lastFailure && Date.now() - this.lastFailure < this.retryCooldownMs)
        throw new Error(this.error ?? '千问启动重试过于频繁，请稍后重试')
      this.starting = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.launcher(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('千问启动超时')), this.startupTimeoutMs)
          }),
        ])
        health = await this.readHealth()
        if (!health.ready || !health.loaded_on_gpu) throw new Error('千问模型尚未装载 GPU')
        this.error = undefined
        return health
      } catch (error) {
        this.lastFailure = Date.now()
        throw error
      } finally {
        clearTimeout(timer)
        this.starting = false
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : '无法连接千问服务'
      this.health = undefined
      throw error
    }
  }

  synthesize(
    _accountId: string,
    _id: string,
    text: string,
    signal: AbortSignal,
    options: QwenSynthesisOptions = {},
  ): Promise<Uint8Array> {
    const trimmed = text.trim()
    if (!trimmed || [...trimmed].length > 300)
      return Promise.reject(new Error('语音文字需为 1～300 字'))
    if (signal.aborted) return Promise.reject(signal.reason)
    const remaining = (options.expiresAt ?? Date.now() + this.jobTimeoutMs) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0)
      return Promise.reject(new Error('语音回复已过期'))
    if (!Number.isFinite(options.priority ?? 10)) return Promise.reject(new Error('语音优先级无效'))
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('千问语音队列已满'))
    return new Promise((resolve, reject) => {
      const deadline = new AbortController()
      const timer = setTimeout(
        () => deadline.abort(new Error('语音回复已过期')),
        Math.min(remaining, this.jobTimeoutMs),
      )
      const bounded = AbortSignal.any([signal, deadline.signal])
      const onAbort = () => {
        this.queue = this.queue.filter(item => item !== job)
        job.cleanup()
        reject(bounded.reason)
      }
      const job: Job = {
        text: trimmed,
        priority: options.priority ?? 10,
        signal: bounded,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          bounded.removeEventListener('abort', onAbort)
        },
      }
      bounded.addEventListener('abort', onAbort, { once: true })
      this.queue.push(job)
      void this.pump()
    })
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length) {
        try {
          const health = await this.ensureReady()
          if (!this.queue.length) break
          if (health.busy) {
            await delay(this.pollMs)
            continue
          }
        } catch (error) {
          for (const job of this.queue.splice(0)) {
            job.cleanup()
            job.reject(error)
          }
          break
        }
        // Select only after GPU is idle: a waiting warmup cannot reserve the next slot.
        this.queue.sort((a, b) => b.priority - a.priority)
        const job = this.queue.shift()
        if (!job) continue
        this.active = true
        let requeued = false
        try {
          const audio = await this.generate(job)
          job.signal.throwIfAborted()
          this.error = undefined
          job.resolve(audio)
        } catch (error) {
          if (error instanceof BusyError && !job.signal.aborted) {
            this.queue.push(job)
            requeued = true
            await delay(this.pollMs)
          } else {
            if (!job.signal.aborted)
              this.error = error instanceof Error ? error.message : '千问合成失败'
            job.reject(error)
          }
        } finally {
          if (!requeued) job.cleanup()
          this.active = false
        }
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * 流式合成：每收到一块 PCM16 就回调一次，**不等整段生成完**。
   *
   * 千问首块 0.3 秒就出来、整段要 1.2 秒 —— 差的那 0.9 秒就是「等到能播」
   * 和「立刻能播」的距离。回调收到的是 **PCM16 单声道**（已经把 float32 转好、
   * 乘好固定增益并夹过幅），可以直接喂给 ffmpeg。
   *
   * 返回整段的秒数。
   */
  async synthesizeStream(
    text: string,
    signal: AbortSignal,
    onPcm: (pcm: Buffer) => void,
  ): Promise<{ seconds: number; sampleRate: number }> {
    const trimmed = text.trim()
    if (!trimmed || [...trimmed].length > 300) throw new Error('语音文字需为 1～300 字')
    if (signal.aborted) throw signal.reason
    await this.ensureReady()
    const job: Job = {
      text: trimmed,
      priority: 10,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      resolve: () => {},
      reject: () => {},
      cleanup: () => {},
    }
    const result = await this.consume(job, onPcm)
    return { seconds: result.seconds, sampleRate: result.sampleRate }
  }

  /**
   * 走 `/stream` 而不是 `/synthesize`。
   *
   * 实测同一句 9 个字的话：`/synthesize` 要 **10~12 秒**，`/stream` 完成只要
   * **0.8~2.2 秒**、首块 0.3 秒 —— 快 5~15 倍。慢的不是模型，是那条端点的路径
   * （`/stream` 会走 `worker.submit` 并带上 emit 回调）。
   *
   * 流式返回的是**已归一化到 [-1,1] 的 float32**（实测峰值 0.63~0.83），
   * 24000 Hz 单声道。
   */
  private async consume(
    job: Job,
    /** 有回调就边收边给，没有就攒成完整 WAV。 */
    onPcm?: (pcm: Buffer) => void,
  ): Promise<{ seconds: number; sampleRate: number; wav?: Buffer }> {
    const response = await this.transport(`${this.base}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: job.text }),
      redirect: 'error',
      signal: job.signal,
    })
    if (response.status === 409) {
      await response.body?.cancel()
      throw new BusyError('千问正在处理其他请求')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`千问合成失败 (${response.status})`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('千问音频为空')
    const decoder = new TextDecoder()
    const parts: Float32Array[] = []
    let total = 0
    let pending = ''
    let sampleRate = 24000
    let sawDone = false
    let size = 0
    try {
      for (;;) {
        job.signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > this.maxAudioBytes * 8) throw new Error('千问音频文件过大')
        pending += decoder.decode(value, { stream: true })
        let breakAt: number
        while ((breakAt = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, breakAt).trim()
          pending = pending.slice(breakAt + 1)
          if (!line) continue
          const event = JSON.parse(line) as {
            event?: string
            data?: string
            sample_rate?: number
            error?: string
          }
          if (event.event === 'audio' && typeof event.data === 'string') {
            if (typeof event.sample_rate === 'number' && event.sample_rate > 0)
              sampleRate = event.sample_rate
            const chunk = Buffer.from(event.data, 'base64')
            const frame = new Float32Array(chunk.length >> 2)
            for (let offset = 0; offset < frame.length; offset++)
              frame[offset] = chunk.readFloatLE(offset * 4)
            total += frame.length
            if (onPcm) onPcm(pcm16(frame))
            else parts.push(frame)
          } else if (event.event === 'done') {
            sawDone = true
          } else if (event.event === 'error') {
            throw new Error(event.error || '千问流式合成失败')
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (!sawDone) throw new Error('千问流式响应未正常结束')
    if (!total) throw new Error('千问没有返回音频')
    const wav = onPcm
      ? undefined
      : encodeQwenWav(
          levelQwen((() => {
            const merged = new Float32Array(total)
            let at = 0
            for (const part of parts) {
              merged.set(part, at)
              at += part.length
            }
            return merged
          })()),
          sampleRate,
        )
    return { seconds: total / sampleRate, sampleRate, wav }
  }

  private async generate(job: Job): Promise<Uint8Array> {
    const { wav } = await this.consume(job)
    if (!wav) throw new Error('千问没有返回音频')
    this.validateWav(wav)
    return wav
  }

  private validateWav(bytes: Buffer) {
    const invalid = () => new Error('千问返回的 WAV 无效，需单声道 PCM16 24000 Hz')
    if (
      bytes.length < 44 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      throw invalid()
    let format = false
    let samples = false
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const name = bytes.toString('ascii', offset, offset + 4)
      const length = bytes.readUInt32LE(offset + 4)
      const start = offset + 8
      if (start + length > bytes.length) throw invalid()
      if (name === 'fmt ') {
        if (
          length < 16 ||
          bytes.readUInt16LE(start) !== 1 ||
          bytes.readUInt16LE(start + 2) !== 1 ||
          bytes.readUInt32LE(start + 4) !== 24000 ||
          bytes.readUInt32LE(start + 8) !== 48000 ||
          bytes.readUInt16LE(start + 12) !== 2 ||
          bytes.readUInt16LE(start + 14) !== 16
        )
          throw invalid()
        format = true
      }
      if (name === 'data') {
        if (!length || length % 2) throw invalid()
        samples = true
      }
      offset = start + length + (length % 2)
    }
    if (!format || !samples) throw invalid()
  }
}

let singleton: QwenVoiceClient | undefined
export function getQwenVoiceClient(): QwenVoiceClient {
  singleton ??= new QwenVoiceClient()
  return singleton
}

/** 目标响度（dBFS RMS）。 */
const TARGET_RMS_DBFS = -17
/** 峰值天花板，留一点余量避免削波。 */
const PEAK_CEILING_DBFS = -1

/**
 * 流式路径的固定增益。
 *
 * 边收边播就**没法整段归一化** —— 第一块到达时还不知道整段峰值是多少。
 * 所以用一个固定增益：实测千问输出的峰值在 0.63~0.83，乘 1.15 之后落在
 * 0.72~0.95，既不削波也不发虚。整段归一化那条路（`levelQwen`）照旧。
 */
const STREAM_GAIN = 1.15

/** float32 样本 → PCM16 字节。超范围的夹住，不绕回反相（那是杂音的来源）。 */
export function pcm16(samples: Float32Array, gain = STREAM_GAIN) {
  const bytes = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index] * gain))
    bytes.writeInt16LE(
      value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff),
      index * 2,
    )
  }
  return bytes
}

/**
 * 响度对齐。
 *
 * 流式返回的是原始 float，不同句子天生有大有小（实测峰值 0.63~0.83）。
 * 不对齐的话，观众听到的是一句响一句轻 —— 之前就因为这个被说过「有点糊」。
 * 先按 RMS 拉到目标响度，再夹住峰值不超过天花板。
 */
export function levelQwen(samples: Float32Array) {
  let sum = 0
  let peak = 0
  for (const value of samples) {
    sum += value * value
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }
  if (!samples.length || peak === 0) return samples
  const rms = Math.sqrt(sum / samples.length)
  const targetRms = 10 ** (TARGET_RMS_DBFS / 20)
  const targetPeak = 10 ** (PEAK_CEILING_DBFS / 20)
  let gain = rms > 0 ? targetRms / rms : 1
  if (peak * gain > targetPeak) gain = targetPeak / peak
  if (Math.abs(gain - 1) < 0.01) return samples
  const out = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index++) out[index] = samples[index] * gain
  return out
}

/** float [-1,1] → 单声道 PCM16 WAV。`validateWav` 会再校验一遍。 */
export function encodeQwenWav(samples: Float32Array, sampleRate: number) {  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    buffer.writeInt16LE(
      value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff),
      44 + index * 2,
    )
  }
  return buffer
}
