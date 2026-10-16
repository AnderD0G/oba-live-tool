import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudienceOutcome, AudienceTrace } from '../../../shared/audienceEvents'
import { fitSpeech, needsSpeedChange } from '../../../shared/speechSpeed'
import {
  AdaptiveSpeechStream,
  type EncodedSpeechStream,
  type SpeechProgress,
} from './AdaptiveSpeechStream'
import { pcmWav } from './DirectorAuthoring'
import type { DirectorSpeechQueue } from './DirectorSpeechQueue'

interface GeneratedSpeech {
  file: string
  duration: number
  text: string
  dispose?: () => void
  streaming?: AdaptiveSpeechStream
  generated?: Promise<void>
  materialize?: (budgetSeconds: number) => Promise<{ file: string; duration: number }>
}

interface Dependencies {
  /** Provider-specific playback speed; omitted preserves the existing Qwen defaults. */
  speedPolicy?: { base: number; max: number }
  /** False only warms the provider connection, without generating cached greetings. */
  prewarmGreetings?: boolean
  onEvent?: (trace: AudienceTrace | undefined, outcome: AudienceOutcome) => void
  account: string
  cache: string
  client: {
    ensureReady?(): Promise<unknown>
    synthesize(
      account: string,
      id: string,
      text: string,
      signal: AbortSignal,
      options?: { priority?: number; expiresAt?: number },
    ): Promise<Uint8Array>
    /** 有流式就优先走它 —— 首块一到就能播。 */
    synthesizeStream?(
      text: string,
      signal: AbortSignal,
      onPcm: (pcm: Buffer, progress?: SpeechProgress) => void,
      options?: { priority?: number; expiresAt?: number },
    ): Promise<{ seconds: number; sampleRate: number }>
  }
  allowVoice?: (user: string) => boolean
  /**
   * 这一条最终有没有播出去 —— 提前量自校准要拿它做反馈：
   * 播成了说明当前提前量够（下一轮往下探），超时说明不够（退回来）。
   */
  onOutcome?: (outcome: 'played' | 'expired' | 'failed') => void
  /** 问候节流：两条之间至少隔几毫秒（全局）。0 = 不限。 */
  greetingGlobalMs?: () => number
  /** 问候节流：同一个人多久内只问候一次（毫秒）。0 = 不限。 */
  greetingPerViewerMs?: () => number
  queue: DirectorSpeechQueue
  duration: (file: string, signal: AbortSignal) => Promise<number>
  /**
   * 按倍速重做一份音频（变速不变调）。给了才会走「装不下就调速」那条路。
   *
   * 为什么需要：原来按字数估时长再裁文本，而实测**字数根本不是时长的函数**
   * （同样 9 个字 1.76~4.24 秒，差 2.4 倍）。合成又是确定性的，所以时长量得出来；
   * 量出来装不下时，调速比裁内容好 —— 快 3% 听不出来，字一个不丢。
   */
  retime?: (file: string, speed: number) => Promise<{ file: string; duration: number }>
  /**
   * 记一笔实测：字数 → 音频时长。样本攒够了时长模型就自己变准，
   * 下一次写给 AI 的字数预算跟着变准。生成完才记，不在实时链路上。
   */
  recordDuration?: (chars: number, seconds: number) => void
  /**
   * 只记**千问合成**那一段的耗时，不含写盘和 ffprobe。
   * 两条线分开归因靠它 —— 混在一起就永远分不清是谁慢。
   */
  recordTts?: (seconds: number) => void
  /**
   * 流式播放服务。给了就走「首块一到就入队」，不给就退回「等整段合成完」。
   */
  streamer?: {
    open(id: string): {
      url: string
      write(pcm: Buffer): void
      finish(): Promise<void>
      dispose(): void
    }
  }
  /** 估算这句话大概要说几秒（流式早入队时用，真实时长还没出来）。 */
  estimateSeconds?: (text: string) => number
  adaptiveStreaming?: {
    open(id: string): EncodedSpeechStream
    retime(pcm: Buffer, speed: number): Promise<Buffer>
  }
  contextKey: (user: string) => string
  valid: () => boolean
  canSpeak: () => boolean
  spoken: (user: string, text: string) => void
}
/**
 * 预生成的问候语。**长度必须分档** —— 插入点窗口只有 1.2~3.7 秒。
 *
 * 原来只有两条：8 字（≈2.0s）和 24 字（≈5.2s）。实测在 A 段的 11 个窗口里
 * 几乎全军覆没（入队条件是「语音时长 + 0.25 ≤ 窗口时长」），语音一句都没
 * 播出来，而路由又把文字通道关掉了 —— 观众什么都收不到。
 *
 * 调度器会把这几条一起排进队列，挑当前窗口装得下的那条播。
 */
const WELCOME = [
  '你好呀', // 3 字 ≈ 1.0s → 1.2~2.5s 的窗口
  '你好呀，想看哪款？', // 9 字 ≈ 2.2s → 2.5~3.7s
  '你好，喜欢哪款报编号就行。', // 12 字 ≈ 2.8s → 3.1~4.3s
]

/** 队列存活期下限。低于这个数，正常速度的窗口都等不到。 */
const DEFAULT_SPEECH_LIFETIME_MS = 15000
/** 上限：再久就成「半分钟前那句话突然冒出来」了。 */
const MAX_SPEECH_LIFETIME_MS = 30000
/** 千问固定 24000 Hz 单声道 —— 流式路径按这个把字节数折成秒数。 */
const STREAM_SAMPLE_RATE = 24000

/** 等到条件成立或超时。用于「等首块音频，但别死等」。 */
function once(ready: () => boolean, timeoutMs: number) {
  return new Promise<void>(resolve => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (ready() || Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
}

/** Prewarm reusable greetings; generate contextual responses off the playback thread. */
export class LiveVoiceService {
  private controller = new AbortController()
  private cached: { file: string; duration: number; text: string }[] = []
  private lastGreeting = 0
  private viewers = new Map<string, number>()
  private pending = 0
  private logs: string[] = []
  private files = new Set<string>()
  constructor(private deps: Dependencies) {}
  private event(trace: AudienceTrace | undefined, outcome: AudienceOutcome) {
    try {
      this.deps.onEvent?.(trace, outcome)
    } catch {
      console.error('记录语音事件失败')
    }
  }
  get snapshot() {
    return { ready: this.cached.length, pending: this.pending, logs: [...this.logs] }
  }
  private log(text: string) {
    this.logs = [text, ...this.logs].slice(0, 20)
  }
  stop() {
    this.controller.abort()
    this.deps.queue.clear()
    for (const file of this.files) void unlink(file).catch(() => {})
    this.files.clear()
  }
  private active() {
    return !this.controller.signal.aborted && this.deps.valid()
  }
  /**
   * 流式那条路：**首块一到就入队**，不等整段生成完。
   *
   * 千问首块 0.3 秒、整段 1 秒左右 —— 等的这段短时间本身不致命，
   * 但千问偶尔会慢到好几秒，那时「等整段」就直接过期、观众只剩文字；
   * 早入队能让音频一到就播，救得回来。
   *
   * 代价是入队时只能用**估算时长**（整段还没生成完），真实时长要等 `done`。
   * 估算偏差由步骤额度账本兜底。
   */
  private async generateStreaming(
    stream: {
      url: string
      write(pcm: Buffer): void
      finish(): Promise<void>
      dispose(): void
    },
    text: string,
    synthStarted: number,
  ) {
    const synthesizeStream = this.deps.client.synthesizeStream
    if (!synthesizeStream) throw new Error('没有流式合成能力')
    let produced = 0
    let settled = false
    let firstChunkAt = 0
    const synth = synthesizeStream.call(this.deps.client, text, this.controller.signal, pcm => {
      /**
       * 记的是**首块就绪**，不是整段合成完。
       *
       * 流式只要首块就能出声，提前量要覆盖的就是这一段。记成整段的话，
       * 提前量会被虚高地卡在 1 秒以上，气口密的时候够不着近的气口 ——
       * 那流式就白做了。
       */
      if (!firstChunkAt) {
        firstChunkAt = Date.now()
        this.deps.recordTts?.((firstChunkAt - synthStarted) / 1000)
      }
      produced += pcm.length / 2 / STREAM_SAMPLE_RATE
      stream.write(pcm)
    })
    const finished = synth.then(
      async (result: { seconds: number }) => {
        // 整段时长是给时长模型学的，和提前量无关。
        this.deps.recordDuration?.(text.length, result.seconds)
        await stream.finish()
        settled = true
        return result
      },
      (error: unknown) => {
        stream.dispose()
        throw error
      },
    )
    // 首块还没到就先放行去入队；整段先好了（只有一块）就直接用真实的。
    await Promise.race([finished, once(() => produced > 0, 3000)])
    this.controller.signal.throwIfAborted()
    if (!settled && produced <= 0) {
      // 三秒一块都没等到，别再挂着 —— 让兜底文字接管
      stream.dispose()
      throw new Error('千问三秒内没有吐出声')
    }
    const estimated = settled ? produced : (this.deps.estimateSeconds?.(text) ?? produced)
    void finished.catch(() => {})
    return { file: stream.url, duration: estimated, text, dispose: stream.dispose }
  }
  private async generate(
    text: string,
    priority = 10,
    expiresAt?: number,
    /** 这次最多能用多少秒。给了才会在合成后按真实时长决定要不要调速。 */
    maxSeconds?: number,
  ): Promise<GeneratedSpeech> {
    const id = randomUUID()
    /**
     * 只量**千问那一段**。
     *
     * 不能把整个 `generate` 都算成「合成」—— 后面还有写盘和一次 ffprobe
     * 子进程（实测几百毫秒到几秒），混进来就归错因了：明明是 ffprobe 慢，
     * 却去调千问的参数。
     */
    const synthStarted = Date.now()
    if (this.deps.adaptiveStreaming && this.deps.client.synthesizeStream) {
      const output = this.deps.adaptiveStreaming.open(id)
      const streaming = new AdaptiveSpeechStream(output, {
        sampleRate: 22050,
        guardSeconds: 0.12,
        estimateSeconds: this.deps.estimateSeconds?.(text) ?? [...text].length * 0.24,
        retime: this.deps.adaptiveStreaming.retime,
      })
      const generated = this.deps.client
        .synthesizeStream(
          text,
          this.controller.signal,
          (pcm, progress) => {
            if (!progress) throw new Error('Index 流式接口未提供分句进度')
            streaming.receive(pcm, progress)
          },
          { priority, expiresAt },
        )
        .then(async result => {
          if (result.sampleRate !== 22050) throw new Error('Index 流式采样率不匹配')
          this.deps.recordDuration?.([...text].length, result.seconds)
          await streaming.seal()
        })
        .catch(error => {
          streaming.fail(error)
          throw error
        })
      void generated.catch(() => {})
      try {
        // Admission only needs a useful buffer. The queue checks each actual sentence budget,
        // including larger later windows; the first target must not prevent early enqueueing.
        while (!streaming.canStart(19.4)) {
          this.controller.signal.throwIfAborted()
          streaming.check()
          if (Date.now() >= (expiresAt ?? synthStarted + 30000)) throw new Error('流式回复已过期')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        // This is the useful prebuffer latency, not merely the first server notification.
        this.deps.recordTts?.((Date.now() - synthStarted) / 1000)
        const clip: GeneratedSpeech = {
          file: output.url,
          duration: streaming.duration,
          text,
          dispose: streaming.dispose,
          streaming,
          generated,
        }
        let materialized: Promise<{ file: string; duration: number }> | undefined
        clip.materialize = budget =>
          (materialized ??= (async () => {
            if (!streaming.generationComplete) throw new Error('尚未完整生成，不等待整段转文件')
            await generated
            this.controller.signal.throwIfAborted()
            await streaming.prepare(budget)
            const pcm = await streaming.completedPcm()
            const file = join(this.deps.cache, `${id}.wav`)
            await mkdir(this.deps.cache, { recursive: true })
            this.files.add(file)
            try {
              await writeFile(file, pcmWav(pcm), { flag: 'wx' })
              this.controller.signal.throwIfAborted()
              clip.file = file
              clip.duration = pcm.length / 44100
              clip.streaming = undefined
              clip.dispose = undefined
              streaming.dispose()
              return { file, duration: clip.duration }
            } catch (error) {
              await unlink(file).catch(() => {})
              this.files.delete(file)
              throw error
            }
          })())
        return clip
      } catch (error) {
        streaming.fail(error)
        throw error
      }
    }
    /**
     * 有流式服务就走流式：**首块一到就入队**，不等整段生成完。
     *
     * 千问首块 0.3 秒、整段 1.2 秒 —— 等的这 0.9 秒是白等的：这一步要的是
     * 「窗口到来时音频已经就绪」，而窗口至少也在 1.5 秒开外。早入队还能让
     * 提前量压得更低，从而够得着更近的气口。
     *
     * 代价是入队时只能用**估算时长**（整段还没生成完），真实时长要等 `done`。
     * 估算偏差由步骤额度账本兜底。
     */
    if (this.deps.streamer && this.deps.client.synthesizeStream) {
      /**
       * 流式服务没就绪（端口还没拿到）就退回老路 —— **不能因为流式没起来
       * 就让这一句整个哑掉**，观众宁可晚一点听到，也不能什么都听不到。
       */
      let stream: ReturnType<NonNullable<typeof this.deps.streamer>['open']> | undefined
      try {
        stream = this.deps.streamer.open(id)
      } catch {
        stream = undefined
      }
      /**
       * 流式这条路**没有文件可以调速**（产出的是 HTTP 流地址），所以不传 `maxSeconds`。
       * 生产上虚拟声卡开着时会按 `speechTransportFor` 强制关流式，
       * 走的就是下面那条「量出真时长、装不下就调速」的路。
       */
      if (stream)
        return {
          ...(await this.generateStreaming(stream, text, synthStarted)),
          streaming: undefined,
          generated: undefined,
        }
    }
    const audio = await this.deps.client.synthesize(
      this.deps.account,
      id,
      text,
      this.controller.signal,
      { priority, expiresAt },
    )
    this.deps.recordTts?.((Date.now() - synthStarted) / 1000)
    this.controller.signal.throwIfAborted()
    await mkdir(this.deps.cache, { recursive: true })
    const file = join(this.deps.cache, `${id}.wav`)
    this.files.add(file)
    try {
      await writeFile(file, audio)
      let duration = await this.deps.duration(file, this.controller.signal)
      if (!Number.isFinite(duration) || duration <= 0 || duration > 20)
        throw new Error('生成的回复时长不合适')
      // 缓存问候语也是真实合成，同样记进样本。
      this.deps.recordDuration?.(text.length, duration)

      /**
       * **量出来装不下就调速，不裁内容。**
       *
       * 到这里时长是**量出来的**，不是估的 —— 千问是确定性的（同一句合 6 遍
       * 一个采样都不差），所以这个数就是准确值。
       *
       * 为什么不在上游按字数裁：实测`字数`根本不是时长的函数 ——
       * 同样 9 个字，1.76 秒到 4.24 秒都有（差 2.4 倍），一个逗号就值 1.04 秒。
       * 按 `0.198 秒/字` 去裁，等于拿一把歪尺子量。
       *
       * 调速的代价：`≤1.10×` 听不出来，`1.10~1.25×` 略快但自然。
       * 仍然装不下就**不硬加速**，交给队列去等更晚的气口（实在没有就走文字兜底）。
       */
      let playFile = file
      if (maxSeconds && this.deps.retime) {
        const fit = fitSpeech(duration, maxSeconds, this.deps.speedPolicy)
        if (needsSpeedChange(fit)) {
          try {
            const faster = await this.deps.retime(file, fit.speed)
            playFile = faster.file
            this.files.add(faster.file)
            this.log(
              `语音装不下，调速 ${fit.speed.toFixed(2)}×：${duration.toFixed(2)}s → ` +
                `${faster.duration.toFixed(2)}s（可用 ${maxSeconds.toFixed(2)}s）`,
            )
            duration = faster.duration
          } catch (error) {
            // 调速失败不能把这句话整个弄没 —— 保持原速，让队列去等更大的气口。
            this.log(`调速失败，改用原速：${String(error)}`)
          }
        } else if (fit.overflow) {
          this.log(
            `语音 ${duration.toFixed(2)}s 超过可用 ${maxSeconds.toFixed(2)}s，` +
              '即使封顶倍速也不够，交给队列等更晚的气口',
          )
        }
      }

      return {
        file: playFile,
        duration,
        text,
        // 这条路落的是文件，没有流要关；留个空位让类型统一。
        dispose: undefined as (() => void) | undefined,
        streaming: undefined,
        generated: undefined,
      }
    } catch (error) {
      await unlink(file).catch(() => {})
      this.files.delete(file)
      throw error
    }
  }
  async prepare() {
    this.pending++
    try {
      await this.deps.client.ensureReady?.()
      if (this.deps.prewarmGreetings === false) return
      for (const text of WELCOME) {
        if (!this.active()) return
        const clip = await this.generate(text, 0)
        if (this.active()) this.cached.push(clip)
      }
      this.log('快速问候已准备，由当前语音播放模式调度')
    } catch {
      if (this.active()) this.log('本地语音预热失败，请检查语音服务状态；文字回复继续')
    } finally {
      this.pending--
    }
  }
  greet(user: string, trace?: AudienceTrace) {
    const now = Date.now()
    const globalMs = this.deps.greetingGlobalMs?.() ?? 8000
    const perViewerMs = this.deps.greetingPerViewerMs?.() ?? 60000
    if (
      !this.active() ||
      !this.deps.canSpeak() ||
      !this.cached.length ||
      (globalMs > 0 && now - this.lastGreeting < globalMs) ||
      (perViewerMs > 0 && now - (this.viewers.get(user) || 0) < perViewerMs)
    ) {
      this.event(trace, { kind: 'voice.skipped', detail: 'greeting unavailable or cooling down' })
      return false
    }
    if (this.deps.allowVoice && !this.deps.allowVoice(user)) {
      this.event(trace, { kind: 'voice.skipped', detail: 'voice quota' })
      return false
    }
    // 冷却**不在这里**占用 —— 见下面 done 回调：只有真的播出去了才算数。
    // 以前一排队就 lastGreeting=now，结果「排进去但没播成」的问候把冷却
    // 吃掉了，5 秒后观众自己发评论反而被判 cooling down（实测踩过）。
    const group = randomUUID()
    let greeted = false
    let failed = false
    let remaining = this.cached.length
    this.event(trace, { kind: 'voice.requested', detail: 'cached greeting' })
    this.event(trace, { kind: 'voice.ready', detail: 'cached greeting alternatives' })
    const context = this.deps.contextKey(user)
    // Offer both lengths to the scheduler; it picks the one fitting this slot. Only one may play.
    for (const [index, clip] of this.cached.entries())
      this.deps.queue.add({
        ...clip,
        id: `${group}-${index}`,
        priority: 1,
        /**
         * 存活 30 秒，不是 8 秒。
         *
         * 窗口只在**旁白正在播**的时候才出现，而旁白通常比画面短（那些省下来的
         * 时间就是额度池）。旁白放完到下一步开始之间可能空 10~20 秒，8 秒的
         * 存活期根本等不到下一个窗口 —— 实测问候就是在空档里过期丢弃的。
         */
        expiresAt: now + 30000,
        valid: () =>
          this.active() &&
          this.deps.canSpeak() &&
          this.deps.contextKey(user) === context &&
          !greeted,
        done: status => {
          remaining--
          if (status === 'played' && !greeted)
            this.event(trace, { kind: 'voice.played', text: clip.text })
          if (status === 'played') {
            greeted = true
            // 只有真的播出去了才占用冷却。排进去没播成的不该罚后面的尝试。
            this.lastGreeting = Date.now()
            this.viewers.set(user, Date.now())
            if (this.viewers.size > 500) this.viewers.delete(this.viewers.keys().next().value ?? '')
          }
          if (status === 'failed') {
            failed = true
            this.event(trace, {
              kind: 'voice.failed',
              text: clip.text,
              detail: 'cached greeting playback failed',
            })
          }
          if (!remaining && !greeted && !failed)
            this.event(trace, {
              kind: 'voice.skipped',
              detail: 'greeting expired or invalidated',
            })
          if (status === 'played') this.deps.spoken(user, clip.text)
          this.log(status === 'played' ? '快速问候已播放' : '问候已过期或未能播放，保留原讲解')
        },
      })
    return true
  }
  /**
   * `onFallback` 是「这一轮话没能用声音说出来」的兜底出口。
   *
   * 语音通道被选中时文字通道是关着的，所以**只要语音没落地，观众就什么都收不到**。
   * 合成长度是动态算的（实测有 3.3 秒瞄、4.0 秒出的情况），算不准是常态，
   * 因此每一条走不通的路径都要把这个出口叫上，让调用方补一条文字。
   *
   * `lifetimeMs` 是这条语音在队列里能等多久。**不能写死** —— 瞄准的窗口可能
   * 在 21 秒后（A 段话术密，前几个窗口装不下 2.8 秒的话，只能等那个大的），
   * 写死 15 秒就会「差一秒过期」。调用方按瞄准的窗口算，这里只负责不要更短。
   */
  async reply(
    user: string,
    text: string,
    trace?: AudienceTrace,
    onFallback?: (reason: string) => void,
    lifetimeMs = DEFAULT_SPEECH_LIFETIME_MS,
    /**
     * 这次最多能用多少秒（**已扣掉安全余量**）。
     *
     * 调用方按瞄准的气口给 —— 但要给**这一步最大的那个气口**，不是最近的那个：
     * 语音会被队列拿到更晚的气口去放，按最近的小气口调速会把话不必要地读快。
     */
    maxSeconds?: number,
    current?: () => boolean,
  ) {
    const contextCurrent = () => {
      try {
        return current?.() !== false
      } catch {
        return false
      }
    }
    const lifetime = Math.max(
      DEFAULT_SPEECH_LIFETIME_MS,
      Math.min(lifetimeMs, MAX_SPEECH_LIFETIME_MS),
    )
    let completed = false
    const fallback = (reason: string) => {
      if (completed) return
      completed = true
      try {
        onFallback?.(reason)
      } catch {
        // 兜底本身失败就保持沉默，不能再往上抛打断导播
      }
    }
    if (
      !this.active() ||
      !this.deps.canSpeak() ||
      !contextCurrent() ||
      this.pending >= 2 ||
      text.length > 120
    ) {
      this.event(trace, { kind: 'voice.skipped', text, detail: 'unavailable, busy or too long' })
      fallback('unavailable')
      return
    }
    if (this.deps.allowVoice && !this.deps.allowVoice(user)) {
      this.log('该观众本分钟语音额度已用完，改发文字')
      this.event(trace, { kind: 'voice.skipped', text, detail: 'voice quota' })
      fallback('voice quota')
      return
    }
    const started = Date.now()
    const key = this.deps.contextKey(user)
    this.pending++
    this.event(trace, { kind: 'voice.requested', text })
    try {
      const clip = await this.generate(text, 10, started + lifetime, maxSeconds)
      const valid = () =>
        this.active() &&
        this.deps.canSpeak() &&
        this.deps.contextKey(user) === key &&
        contextCurrent()
      const release = () => {
        // 流式那条路的「file」是个 URL，要关的是转码进程和 HTTP 流，不是删文件。
        if (clip.dispose) {
          clip.dispose()
          return
        }
        this.files.delete(clip.file)
        void unlink(clip.file).catch(() => {})
      }
      if (!valid() || Date.now() >= started + lifetime) {
        release()
        this.log('回复生成后已过期，改发文字')
        this.event(trace, {
          kind: 'voice.skipped',
          text,
          detail: 'expired or context changed after synthesis',
        })
        fallback('expired after synthesis')
        return
      }
      const queued = this.deps.queue.add({
        ...clip,
        get duration() {
          return clip.streaming?.duration ?? clip.duration
        },
        get streaming() {
          return clip.streaming
        },
        id: randomUUID(),
        priority: 2,
        expiresAt: started + lifetime,
        valid: () => {
          try {
            clip.streaming?.check()
            return valid() && !completed
          } catch {
            return false
          }
        },
        done: status => {
          if (completed) return
          // Claim the terminal outcome before any external callback can re-enter.
          completed = true
          this.event(trace, {
            kind:
              status === 'played'
                ? 'voice.played'
                : status === 'failed'
                  ? 'voice.failed'
                  : 'voice.skipped',
            text,
            detail: status,
          })
          if (status === 'played') {
            try {
              this.deps.spoken(user, text)
            } catch {
              this.log('语音已播放，但记忆记录失败')
            }
          }
          this.log(
            status === 'played'
              ? '互动回答已播放'
              : '互动回答未播放（窗口不足或状态变化），改发文字',
          )
          // 排进去但没播成（窗口装不下、过期、播放失败）—— 这条话还欠着观众
          try {
            this.deps.onOutcome?.(status)
          } catch {
            // 反馈失败不该影响播放流程
          }
          if (status !== 'played') {
            try {
              onFallback?.(`queue ${status}`)
            } catch {
              // A failing observer must not prevent releasing the audio.
            }
          }
          release()
        },
      })
      if (clip.generated)
        void clip.generated.catch(error => {
          if (completed) return
          completed = true
          this.event(trace, {
            kind: 'voice.failed',
            text,
            detail: error instanceof Error ? error.message : 'stream generation failed',
          })
          try {
            this.deps.onOutcome?.('failed')
          } catch {}
          try {
            onFallback?.('stream generation failed')
          } catch {
          } finally {
            release()
          }
        })
      if (!queued) {
        release()
        fallback('queue rejected')
      }
      this.event(trace, {
        kind: queued ? 'voice.ready' : 'voice.skipped',
        text,
        detail: queued ? `duration=${clip.duration}` : 'queue rejected',
      })
      this.log(
        `回复已生成，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒，音频 ${clip.duration.toFixed(1)} 秒`,
      )
    } catch {
      this.event(trace, {
        kind: this.active() ? 'voice.failed' : 'voice.skipped',
        text,
        detail: 'synthesis failed or cancelled',
      })
      if (this.active()) this.log('本地语音生成失败，改发文字')
      fallback('synthesis failed')
    } finally {
      this.pending--
    }
  }
}
