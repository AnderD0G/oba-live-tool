import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Local Index2.5 adapter. HTTP and TCP share one noncancellable GPU scheduler. */
export interface IndexVoiceOptions {
  baseUrl?: string
  fetch?: typeof fetch
  diffusionSteps?: 10 | 15 | 25
  maxQueue?: number
  jobTimeoutMs?: number
  tcpPort?: number
  cacheDir?: string
  drainTimeoutMs?: number
  maxStreamBytes?: number
  /** Minimum punctuation split target in Unicode code points; default16, hard cap24. */
  clauseTargetChars?: number
}
interface Health {
  ok: boolean
  model: string
  version: string
  checkpoint: string
  voice_reference: string
}
interface Job {
  priority: number
  signal: AbortSignal
  run: () => Promise<void>
  reject: (error: unknown) => void
  cleanup: () => void
}
export class IndexVoiceClient {
  private base: string
  private transport: typeof fetch
  private queue: Job[] = []
  private pumping = false
  private idleWaiters: Array<() => void> = []
  private health?: Health
  private error?: string
  private uncertain = false
  constructor(private options: IndexVoiceOptions = {}) {
    const url = new URL(options.baseUrl ?? 'http://127.0.0.1:17898')
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Index 接口仅支持本机 127.0.0.1')
    for (const value of [options.maxQueue ?? 8, options.jobTimeoutMs ?? 30000])
      if (!Number.isFinite(value) || value <= 0) throw new Error('Index 队列限制无效')
    if (
      !Number.isInteger(options.tcpPort ?? 17897) ||
      (options.tcpPort ?? 17897) < 1 ||
      (options.tcpPort ?? 17897) > 65535
    )
      throw new Error('Index TCP 端口无效')
    const clauseTarget = options.clauseTargetChars ?? 16
    if (!Number.isInteger(clauseTarget) || clauseTarget < 1 || clauseTarget > 24)
      throw new Error('Index 分句目标需为 1～24 的整数')
    for (const value of [
      options.drainTimeoutMs ?? 120000,
      options.maxStreamBytes ?? 10 * 1024 * 1024,
    ])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Index 流限制无效')
    if (/^(?:\\\\|\/\/)/.test(resolve(options.cacheDir ?? join(tmpdir(), 'oba-index-stream'))))
      throw new Error('Index 缓存必须是本地目录')
    this.base = url.origin
    this.transport = options.fetch ?? fetch
  }
  get status() {
    return {
      state: this.error ? 'error' : this.pumping ? 'busy' : this.health ? 'ready' : 'idle',
      ready: !!this.health && !this.error,
      busy: this.pumping,
      queued: this.queue.length,
      error: this.error,
      health: this.health,
    }
  }
  /** Caller cancellation is not GPU cancellation: keep offline/live gates closed until drain. */
  waitForIdle(): Promise<void> {
    return this.pumping ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve()
  }
  async ensureReady() {
    try {
      if (this.uncertain) throw new Error('Index 上次请求状态不明，请确认服务空闲后重启本应用')
      const response = await this.transport(`${this.base}/status`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error('Index 服务未就绪，请先启动桌面 voice 中的 IndexTTS2.5')
      const health = (await response.json()) as Health
      if (
        health?.ok !== true ||
        health.model !== 'IndexTTS2.5' ||
        health.version !== '2.5' ||
        typeof health.checkpoint !== 'string' ||
        typeof health.voice_reference !== 'string'
      )
        throw new Error('Index 服务身份不匹配：需要 IndexTTS2.5 和有效参考音色')
      this.health = health
      this.error = undefined
      return health
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Index 服务不可用'
      throw error
    }
  }
  synthesize(
    _account: string,
    _id: string,
    text: string,
    signal: AbortSignal,
    options: { priority?: number; expiresAt?: number } = {},
  ): Promise<Uint8Array> {
    return this.enqueue(text, signal, options, bounded => this.synthesizeHttp(text.trim(), bounded))
  }
  /** One callback per validated whole clause. Progress counts Unicode code points; index is zero-based. */
  synthesizeStream(
    text: string,
    signal: AbortSignal,
    onPcm: (
      pcm: Buffer,
      progress?: { charsCompleted: number; totalChars: number; index: number },
    ) => void,
    options: { priority?: number; expiresAt?: number } = {},
  ): Promise<{ seconds: number; sampleRate: number }> {
    return this.enqueue(text, signal, options, async bounded => {
      const clauses = splitIndexClauses(text, this.options.clauseTargetChars ?? 16)
      const totalChars = Array.from(text).length
      let charsCompleted = 0
      let bytes = 0
      const root = resolve(this.options.cacheDir ?? join(tmpdir(), 'oba-index-stream'))
      await mkdir(root, { recursive: true })
      const canonicalRoot = await realpath(root)
      for (const [index, clause] of clauses.entries()) {
        bounded.throwIfAborted()
        const folder = await mkdtemp(join(canonicalRoot, 'clause-'))
        try {
          bounded.throwIfAborted()
          const pcm = await this.synthesizeClause(
            clause,
            folder,
            bounded,
            (this.options.maxStreamBytes ?? 10 * 1024 * 1024) - bytes,
          )
          bounded.throwIfAborted()
          charsCompleted += Array.from(clause).length
          bytes += pcm.length
          onPcm(pcm, { charsCompleted, totalChars, index })
        } finally {
          // Only a fresh mkdtemp child owned by this request is removed.
          await rm(folder, { recursive: true, force: true })
        }
      }
      return { seconds: bytes / 44100, sampleRate: 22050 }
    })
  }
  private enqueue<T>(
    text: string,
    signal: AbortSignal,
    options: { priority?: number; expiresAt?: number },
    execute: (bounded: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remaining = Math.min(
      this.options.jobTimeoutMs ?? 30000,
      (options.expiresAt ?? Number.POSITIVE_INFINITY) - Date.now(),
    )
    if (!text.trim() || [...text].length > 300)
      return Promise.reject(new Error('Index 文字需为 1～300 字'))
    if (signal.aborted) return Promise.reject(signal.reason)
    if (!Number.isFinite(remaining) || remaining <= 0)
      return Promise.reject(new Error('语音回复已过期'))
    if (!Number.isFinite(options.priority ?? 10))
      return Promise.reject(new Error('Index 优先级无效'))
    if (this.queue.length >= (this.options.maxQueue ?? 8))
      return Promise.reject(new Error('Index 语音队列已满'))
    return new Promise((resolve, reject) => {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(new Error('语音回复已过期')), remaining)
      const bounded = AbortSignal.any([signal, deadline.signal])
      const onAbort = () => {
        this.queue = this.queue.filter(value => value !== job)
        job.cleanup()
        reject(bounded.reason)
      }
      const job: Job = {
        priority: options.priority ?? 10,
        signal: bounded,
        run: async () => {
          const result = await execute(bounded)
          bounded.throwIfAborted()
          resolve(result)
        },
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
        this.queue.sort((a, b) => b.priority - a.priority)
        const job = this.queue.shift()
        if (!job) break
        try {
          job.signal.throwIfAborted()
          await this.ensureReady()
          job.signal.throwIfAborted()
          await job.run()
        } catch (error) {
          job.reject(error)
        } finally {
          job.cleanup()
        }
      }
    } finally {
      this.pumping = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
  private async synthesizeHttp(text: string, signal: AbortSignal): Promise<Uint8Array> {
    // The server cannot cancel synthesis. Drain it even if the caller expires;
    // releasing the scheduler on caller abort would accumulate GPU work.
    const drain = AbortSignal.timeout(this.options.drainTimeoutMs ?? 120000)
    let response: Response
    try {
      response = await this.transport(`${this.base}/synth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          diffusion_steps: this.options.diffusionSteps ?? 15,
          max_text_tokens_per_segment: 100,
        }),
        signal: drain,
        redirect: 'error',
      })
    } catch (error) {
      this.latchUncertain()
      throw error
    }
    if (!response.ok) throw new Error(`Index 合成失败 (${response.status})`)
    let result: { ok?: boolean; url?: string }
    try {
      result = await response.json()
    } catch (error) {
      this.latchUncertain()
      throw error
    }
    signal.throwIfAborted()
    if (result.ok !== true || typeof result.url !== 'string')
      throw new Error('Index 未返回完整音频')
    const url = new URL(result.url, this.base)
    if (
      url.origin !== this.base ||
      !/^\/audio\/[a-zA-Z0-9_.-]+\.wav$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('Index 音频地址无效')
    const audio = await this.transport(url.toString(), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      redirect: 'error',
    })
    if (!audio.ok) throw new Error('Index 音频下载失败')
    const reader = audio.body?.getReader()
    if (!reader) throw new Error('Index 音频为空')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 10 * 1024 * 1024) throw new Error('Index 音频过大')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const wav = Buffer.concat(chunks)
    validateIndexWav(wav)
    signal.throwIfAborted()
    return wav
  }
  private latchUncertain() {
    this.uncertain = true
    this.error = 'Index 上次请求状态不明，请确认服务空闲后重启本应用'
  }
  private async synthesizeClause(
    text: string,
    folder: string,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<Buffer> {
    const socket = createConnection({ host: '127.0.0.1', port: this.options.tcpPort ?? 17897 })
    let dispatched = false
    let terminal = false
    const timeout = setTimeout(
      () => socket.destroy(new Error('Index TCP 排空超时')),
      this.options.drainTimeoutMs ?? 120000,
    )
    socket.once('connect', () => {
      if (signal.aborted) {
        socket.destroy()
        return
      }
      dispatched = true
      socket.write(
        `${JSON.stringify({
          text,
          stream: true,
          chunk_dir: folder,
          diffusion_steps: this.options.diffusionSteps ?? 15,
          max_text_tokens_per_segment: 100,
        })}\n`,
      )
    })
    const chunks: Buffer[] = []
    const paths: string[] = []
    let bytes = 0
    let wireBytes = 0
    let pending = Buffer.alloc(0)
    try {
      for await (const data of socket) {
        wireBytes += data.length
        if (wireBytes > 256 * 1024) throw new Error('Index TCP 事件总量过大')
        pending = Buffer.concat([pending, data])
        let newline = pending.indexOf(10)
        while (newline >= 0) {
          if (terminal || newline > 65536) throw new Error('Index TCP 事件顺序或行长度无效')
          const line = pending.subarray(0, newline)
          pending = pending.subarray(newline + 1)
          const event = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(line),
          ) as Record<string, unknown>
          if (!event || typeof event !== 'object' || Array.isArray(event))
            throw new Error('Index TCP 事件无效')
          if (event.ok === false && event.event === undefined && typeof event.error === 'string') {
            terminal = true
            throw new Error(`Index 合成失败：${event.error.slice(0, 500)}`)
          }
          if (event.event === 'chunk') {
            const index = chunks.length
            if (event.index !== index || index >= 32) throw new Error('Index TCP 分块序号无效')
            const expected = join(folder, `chunk_${String(index).padStart(3, '0')}.wav`)
            if (
              typeof event.path !== 'string' ||
              !isAbsolute(event.path) ||
              resolve(event.path) !== expected ||
              event.path.split(/[\\/]/).includes('..')
            )
              throw new Error('Index 分块路径无效')
            const stat = await lstat(expected)
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              (await realpath(expected)) !== expected ||
              stat.size < 44 ||
              stat.size > maxBytes - bytes
            )
              throw new Error('Index 分块文件无效或过大')
            const file = await open(expected, 'r')
            let wav: Buffer
            try {
              const buffer = Buffer.alloc(stat.size + 1)
              const read = await file.read(buffer, 0, buffer.length, 0)
              if (read.bytesRead !== stat.size) throw new Error('Index 分块文件发生变化')
              wav = buffer.subarray(0, stat.size)
            } finally {
              await file.close()
            }
            const pcm = validateIndexWav(wav)
            if (
              typeof event.length_seconds !== 'number' ||
              !Number.isFinite(event.length_seconds) ||
              Math.abs(event.length_seconds - pcm.length / 44100) > 0.011
            )
              throw new Error('Index 分块时长无效')
            chunks.push(pcm)
            paths.push(expected)
            bytes += pcm.length
          } else if (event.event === 'done') {
            if (
              event.ok !== true ||
              event.model !== 'IndexTTS2.5' ||
              event.version !== '2.5' ||
              event.checkpoint !== this.health?.checkpoint ||
              event.diffusion_steps !== (this.options.diffusionSteps ?? 15) ||
              !chunks.length ||
              event.segments !== chunks.length ||
              !Array.isArray(event.marks) ||
              event.marks.length !== chunks.length ||
              typeof event.duration !== 'number' ||
              !Number.isFinite(event.duration) ||
              Math.abs(event.duration - bytes / 44100) > 0.011 ||
              !event.marks.every(
                (mark, index) =>
                  mark &&
                  mark.index === index &&
                  typeof mark.path === 'string' &&
                  resolve(mark.path) === paths[index],
              )
            )
              throw new Error('Index TCP 完成身份或分块清单无效')
            if (pending.length) throw new Error('Index TCP 完成后仍有事件')
            terminal = true
          } else throw new Error('Index TCP 未知事件')
          newline = pending.indexOf(10)
        }
        if (pending.length > 65536) throw new Error('Index TCP 事件行过大')
        if (terminal) return Buffer.concat(chunks, bytes)
      }
      signal.throwIfAborted()
      throw new Error('Index TCP 提前断流，缺少完整 done')
    } catch (error) {
      if (dispatched && !terminal) this.latchUncertain()
      throw new Error(`Index TCP: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
      socket.destroy()
    }
  }
}
function splitIndexClauses(text: string, target: number): string[] {
  const clauses: string[] = []
  let current: string[] = []
  for (const char of text) {
    current.push(char)
    if (
      current.length >= 24 ||
      (current.length >= target && /[，,。.!！?？;；:：\n]/u.test(char))
    ) {
      clauses.push(current.join(''))
      current = []
    }
  }
  if (current.length) {
    if (!current.join('').trim() && clauses.length) {
      const previous = Array.from(clauses.pop() ?? '')
      const combined = [...previous, ...current]
      if (combined.length > 24) {
        const split = Math.max(combined.length - 24, combined.findIndex(c => c.trim()) + 1)
        clauses.push(combined.slice(0, split).join(''))
        clauses.push(combined.slice(split).join(''))
      } else clauses.push(combined.join(''))
    } else clauses.push(current.join(''))
  }
  if (clauses.some(clause => !clause.trim() || Array.from(clause).length > 24))
    throw new Error('Index 文字空白段过长，无法构成完整短分句')
  return clauses
}
export function validateIndexWav(wav: Buffer) {
  const fail = () => {
    throw new Error('Index WAV 无效，需要 22050 Hz 单声道 PCM16')
  }
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    fail()
  let format = false
  let pcm: Buffer | undefined
  let offset = 12
  for (; offset + 8 <= wav.length; ) {
    const length = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    const name = wav.toString('ascii', offset, offset + 4)
    if (start + length > wav.length) fail()
    if (name === 'fmt ') {
      if (
        format ||
        length < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 22050 ||
        wav.readUInt32LE(start + 8) !== 44100 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        fail()
      format = true
    }
    if (name === 'data') {
      if (!format || pcm || !length || length % 2) fail()
      pcm = wav.subarray(start, start + length)
    }
    offset = start + length + (length % 2)
  }
  if (!format || !pcm || offset !== wav.length) return fail()
  return pcm
}
let singleton: IndexVoiceClient | undefined
export function getIndexVoiceClient() {
  singleton ??= new IndexVoiceClient()
  return singleton
}
