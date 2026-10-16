import { type ChildProcess, spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'

/**
 * 把千问流式吐出来的 PCM 变成 OBS 能边收边播的 MP3 流。
 *
 * ## 为什么要这么绕
 *
 * 实测了三种方式（都是拿真 OBS 跑的）：
 *
 *   · **往文件里追加** —— ffmpeg 读到 EOF 就结束，追加的部分完全被无视；
 *   · **WAV 走 HTTP** —— 游标一直卡在 0.00，压根不播；
 *   · **MP3 走 HTTP 分块流** —— 播完 2.52 秒只用了 2.9 秒（发完就要 2.4 秒），
 *     说明它是**边收边播**的。
 *
 * 所以走第三条：千问 PCM → ffmpeg 转 MP3 → 本地 HTTP 流 → OBS 媒体源。
 *
 * ## 为什么不用等合成完
 *
 * 千问首块 0.3 秒就出来了，整段要 1.2 秒。这个类把已经拿到的字节**立刻**
 * 挂到 URL 上，OBS 一连上就有声音，不必等整段生成完。
 *
 * 晚连也没关系：字节全缓存在内存里，OBS 后来才连就从头播一遍。
 */

/** OBS 连上来之前至少先攒一点，免得它一连就撞到空缓冲。 */
const PREBUFFER_BYTES = 4096
/** Per stream: cap total PCM accepted and MP3 retained independently. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024
const MAX_STREAMS = 32
/** Recorded OBS audio-queue drain is about 341ms; allow 500ms before EOF can trigger mute. */
const COMPLETION_TAIL_MS = 500

interface StreamState {
  id: string
  chunks: Buffer[]
  bytes: number
  inputBytes: number
  inputEnded: boolean
  sampleRate: number
  pacedCompletion: boolean
  playStarted?: number
  completionTimer?: ReturnType<typeof setTimeout>
  encoder?: ChildProcess
  error?: Error
  /** 攒够首块（或已结束）才让 OBS 连上来 —— 连太早它会撞到空数据判结束。 */
  ready: boolean
  /** 连上来但还没放行的响应。 */
  waiting?: ServerResponse
  /** 已经放行、正在跟着收的响应。 */
  sink?: { response: ServerResponse; nextChunk: number; blocked: boolean; attachedAt: number }
  finished: boolean
  disposed: boolean
  resolveFinished: () => void
  rejectFinished: (error: Error) => void
  finishedPromise: Promise<void>
}

export class LiveSpeechStreamer {
  private server?: Server
  private port = 0
  private streams = new Map<string, StreamState>()
  /** Keep disposed/replaced children here until their close event reaps them. */
  private encoders = new Map<ChildProcess, Promise<void>>()

  constructor(
    private ffmpeg = 'ffmpeg',
    /** Qwen default; Index supplies its native 22050 Hz to open(). */
    private sampleRate = 24000,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => this.serve(req.url || '', res))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      // 端口交给系统分配：URL 是每次开流现生成的，不需要固定端口，
      // 也就不会和别的服务抢。
      this.server?.listen(0, '127.0.0.1', () => {
        this.port = (this.server?.address() as { port: number }).port
        resolve()
      })
    })
  }

  private serve(path: string, res: ServerResponse) {
    // HTTP disconnects are local to this reader; a later reader may replay from zero.
    res.on('error', () => {})
    const match = /^\/speech\/([0-9a-f-]{36})\.mp3$/.exec(path)
    const state = match ? this.streams.get(match[1]) : undefined
    if (!state || state.disposed) {
      res.statusCode = 404
      res.end()
      return
    }
    if (state.error) {
      res.writeHead(503)
      res.end()
      return
    }
    // 还没攒够就先挂着 —— 放行太早，OBS 会读到空数据然后判「播完」。
    if (!state.ready) {
      state.waiting?.destroy()
      state.waiting = res
      res.once('close', () => { if (state.waiting === res) state.waiting = undefined })
      return
    }
    this.attach(state, res)
  }

  /** 放行：先把已经攒下的字节补齐，再跟着往后收。 */
  private attach(state: StreamState, res: ServerResponse) {
    if (res.destroyed) return
    this.clearCompletion(state)
    state.sink?.response.destroy()
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      Connection: 'close',
    })
    res.socket?.setNoDelay(true)
    const sink = { response: res, nextChunk: 0, blocked: false, attachedAt: performance.now() }
    state.sink = sink
    res.on('drain', () => {
      if (state.sink !== sink) return
      sink.blocked = false
      this.flush(state)
    })
    res.once('close', () => {
      if (state.sink !== sink) return
      this.clearCompletion(state)
      state.sink = undefined
    })
    this.flush(state)
  }

  /** One cursor serves both initial replay and live output, including the readiness chunk. */
  private flush(state: StreamState) {
    const sink = state.sink
    if (!sink || sink.blocked || sink.response.destroyed || sink.response.writableEnded) return
    try {
      while (sink.nextChunk < state.chunks.length) {
        // A false return still accepted the chunk. Resume at the NEXT chunk on drain.
        if (!sink.response.write(state.chunks[sink.nextChunk++])) {
          sink.blocked = true
          return
        }
      }
      if (state.finished) this.completeResponse(state)
    } catch {
      this.clearCompletion(state)
      sink.response.destroy()
      if (state.sink === sink) state.sink = undefined
    }
  }

  private clearCompletion(state: StreamState) {
    clearTimeout(state.completionTimer)
    state.completionTimer = undefined
  }

  /** Encode completion is independent of HTTP EOF: give the decoder time to consume the tail. */
  private completeResponse(state: StreamState) {
    const sink = state.sink
    if (!sink || state.error || state.disposed) return
    if (state.pacedCompletion) {
      if (state.playStarted === undefined) return
      const deadline = Math.max(state.playStarted, sink.attachedAt) +
        state.inputBytes / (state.sampleRate * 2) * 1000 + COMPLETION_TAIL_MS
      const remaining = deadline - performance.now()
      if (remaining > 0) {
        if (!state.completionTimer) {
          state.completionTimer = setTimeout(() => {
            state.completionTimer = undefined
            this.flush(state)
          }, Math.ceil(remaining))
          state.completionTimer.unref?.()
        }
        return
      }
    }
    this.clearCompletion(state)
    sink.response.end()
  }

  private markReady(state: StreamState) {
    if (state.ready) return
    state.ready = true
    const waiting = state.waiting
    state.waiting = undefined
    if (waiting) this.attach(state, waiting)
  }

  private fail(state: StreamState, error: Error) {
    if (state.error || state.finished) return
    this.clearCompletion(state)
    state.error = error
    state.finished = true
    state.chunks = []
    state.bytes = 0
    const waiting = state.waiting
    state.waiting = undefined
    if (waiting && !waiting.destroyed) {
      waiting.writeHead(503)
      waiting.end()
    }
    // Never turn an encoder failure into a clean HTTP EOF for a partial MP3.
    state.sink?.response.destroy()
    state.sink = undefined
    state.rejectFinished(error)
    this.kill(state.encoder)
  }

  private kill(encoder: ChildProcess | undefined) {
    if (!encoder) return
    encoder.stdin?.destroy()
    encoder.stdout?.destroy()
    encoder.stderr?.destroy()
    if (encoder.exitCode === null && encoder.signalCode === null) {
      try { encoder.kill('SIGKILL') } catch { /* Already exited. */ }
    }
  }

  private dispose(state: StreamState, reason = 'Speech stream disposed') {
    if (state.disposed) return
    state.disposed = true
    this.clearCompletion(state)
    this.fail(state, new Error(reason))
    state.waiting?.destroy()
    state.waiting = undefined
    state.sink?.response.destroy()
    state.sink = undefined
    state.chunks = []
    state.bytes = 0
    this.kill(state.encoder)
    if (this.streams.get(state.id) === state) this.streams.delete(state.id)
  }

  /**
   * 开一条流。返回的 `url` 直接给 OBS 用。
   * `write` 收到的是 **PCM16 单声道**，和 ffmpeg 参数里的格式一致。
   */
  open(id: string, options?: { sampleRate?: number; pacedCompletion?: boolean }): {
    url: string
    write: (pcm: Buffer) => void
    finish: () => Promise<void>
    dispose: () => void
    /** Starts the paced HTTP completion clock; repeated calls do not reset it. */
    start?: () => void
    readonly error?: Error
  } {
    /**
     * 端口还没拿到就别硬来 —— 那样 URL 会是 `:0/...`，OBS 连不上。
     * 抛出去让调用方退回「等整段合成完」的老路，而不是整条哑掉。
     */
    if (!this.server || !this.port) throw new Error('流式服务还没就绪')
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid speech stream id')
    const sampleRate = options?.sampleRate ?? this.sampleRate
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
      throw new Error('Invalid speech sample rate')
    // Include children still shutting down so rapid open/dispose cannot spawn without bound.
    if (this.encoders.size >= MAX_STREAMS || (!this.streams.has(id) && this.streams.size >= MAX_STREAMS))
      throw new Error('Speech stream capacity limit reached')
    const previous = this.streams.get(id)
    if (previous) this.dispose(previous, 'Speech stream replaced')
    let resolveFinished!: () => void
    let rejectFinished!: (error: Error) => void
    const state: StreamState = {
      id,
      chunks: [],
      bytes: 0,
      inputBytes: 0,
      inputEnded: false,
      sampleRate,
      pacedCompletion: options?.pacedCompletion ?? false,
      ready: false,
      finished: false,
      disposed: false,
      resolveFinished: () => resolveFinished(),
      rejectFinished: error => rejectFinished(error),
      finishedPromise: new Promise<void>((done, reject) => {
        resolveFinished = done
        rejectFinished = reject
      }),
    }
    // Failure may arrive before callers invoke finish(); keep the original promise observable.
    void state.finishedPromise.catch(() => {})
    this.streams.set(id, state)

    const encoder = spawn(
      this.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        String(sampleRate),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        // 64k 单声道：人声够用，帧短（约 48ms）所以起播快。
        '-f',
        'mp3',
        '-b:a',
        '64k',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    state.encoder = encoder
    let resolveClosed!: () => void
    this.encoders.set(encoder, new Promise<void>(resolve => { resolveClosed = resolve }))
    let stderr = ''
    encoder.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192)
    })
    encoder.stderr?.on('error', error => this.fail(state, error))
    encoder.stdin?.on('error', error => this.fail(state, error))
    encoder.stdout?.on('error', error => this.fail(state, error))
    encoder.stdin?.on('close', () => {
      if (!encoder.stdin?.writableFinished)
        this.fail(state, new Error('Speech encoder stdin closed before input finished'))
    })
    encoder.stdout?.on('close', () => {
      if (!encoder.stdout?.readableEnded)
        this.fail(state, new Error('Speech encoder stdout closed before EOF'))
    })
    encoder.stdout?.on('data', (chunk: Buffer) => {
      if (state.disposed || state.finished || !chunk.length) return
      if (state.bytes + chunk.length > MAX_STREAM_BYTES) {
        this.fail(state, new Error('Encoded speech output exceeds 10 MiB limit'))
        return
      }
      state.chunks.push(Buffer.from(chunk))
      state.bytes += chunk.length
      // 攒够一个缓冲就放行；放行之后**每一块都要跟发**，不能挑着发。
      if (state.bytes >= PREBUFFER_BYTES) this.markReady(state)
      this.flush(state)
    })
    encoder.on('close', (code, signal) => {
      this.encoders.delete(encoder)
      resolveClosed()
      if (state.error) return
      if (code !== 0 || signal) {
        this.fail(state, new Error(`Speech encoder exit ${code} (${signal || 'no signal'}): ${stderr.trim()}`))
        return
      }
      if (!state.inputEnded || !state.inputBytes || !state.bytes) {
        this.fail(state, new Error('Speech encoder exited before complete audio was finished'))
        return
      }
      state.finished = true
      this.markReady(state)
      this.flush(state)
      state.resolveFinished()
    })
    encoder.on('error', error => this.fail(state, error))

    return {
      url: `http://127.0.0.1:${this.port}/speech/${id}.mp3`,
      get error() { return state.error },
      start: () => {
        if (!state.pacedCompletion || state.disposed || state.error || state.playStarted !== undefined) return
        state.playStarted = performance.now()
        this.flush(state)
      },
      write: pcm => {
        if (state.error) throw state.error
        if (state.disposed || state.inputEnded || state.finished) throw new Error('Speech stream input is closed')
        if (pcm.length % 2 || state.inputBytes + pcm.length > MAX_STREAM_BYTES) {
          this.fail(state, new Error('PCM input must contain complete samples within the 10 MiB limit'))
          throw state.error
        }
        state.inputBytes += pcm.length
        try {
          encoder.stdin!.write(Buffer.from(pcm), error => { if (error) this.fail(state, error) })
        } catch (error) {
          this.fail(state, error instanceof Error ? error : new Error(String(error)))
          throw state.error
        }
      },
      finish: () => {
        if (!state.inputEnded && !state.finished) {
          state.inputEnded = true
          try { encoder.stdin!.end() } catch (error) {
            this.fail(state, error instanceof Error ? error : new Error(String(error)))
          }
        }
        return state.finishedPromise
      },
      dispose: () => this.dispose(state),
    }
  }

  async stop() {
    const server = this.server
    this.server = undefined
    this.port = 0
    for (const state of [...this.streams.values()]) this.dispose(state, 'Speech streamer stopped')
    const closed = [...this.encoders.values()]
    for (const encoder of this.encoders.keys()) this.kill(encoder)
    if (server) {
      const serverClosed = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await serverClosed
    }
    await Promise.all(closed)
  }
}

let singleton: LiveSpeechStreamer | undefined

export function getLiveSpeechStreamer(ffmpeg?: string) {
  singleton ??= new LiveSpeechStreamer(ffmpeg)
  return singleton
}

/** 停用时收摊：**不要顺手建一个** —— 没有就不管。 */
export async function stopLiveSpeechStreamer() {
  const streamer = singleton
  singleton = undefined
  if (streamer) await streamer.stop()
}
