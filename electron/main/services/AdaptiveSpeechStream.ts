import {OBS_STREAM_RESERVE_SECONDS} from '../../../shared/speechPlayback'

export interface SpeechProgress {
  charsCompleted: number
  totalChars: number
  index: number
}
export interface EncodedSpeechStream {
  url: string
  write(pcm: Buffer): void
  finish(): Promise<void>
  dispose(): void
  readonly error?: Error
  start?(): void
}

/** Estimates are admission hints. Actual playback still has a strict wall-clock deadline. */
export class AdaptiveSpeechStream {
  private pending: Buffer[] = []
  private produced = 0
  private encoded = 0
  private consumedRaw = 0
  private chars = 0
  private totalChars = 0
  private receivedAt = 0
  private lastGenerationSeconds = 0
  private createdAt: number
  private generated = false
  private prepared = false
  private speed = 1
  private budget = Infinity
  private startedAt?: number
  private deadline = Infinity
  private processing = Promise.resolve()
  private finishing?: Promise<void>
  private failure?: Error
  private disposed = false
  private headWritten = false
  private tailWritten = false
  private completeParts:Buffer[]=[]
  finished = false
  private now: () => number
  constructor(
    private stream: EncodedSpeechStream,
    private options: {
      sampleRate: number
      estimateSeconds: number
      guardSeconds?: number
      now?: () => number
      retime(pcm: Buffer, speed: number): Promise<Buffer>
    },
  ) {
    this.now = options.now ?? Date.now
    this.createdAt = this.now()
    if (!Number.isFinite(options.guardSeconds ?? 0) || (options.guardSeconds ?? 0) < 0 || (options.guardSeconds ?? 0) > 0.2)
      throw new Error('音频编解码余量无效')
  }
  private get guardSeconds() {
    return Math.round((this.options.guardSeconds ?? 0) * this.options.sampleRate) / this.options.sampleRate
  }
  private retimeSpeed(requested:number){
    // atempo has small sample-count variance; final PCM is still rechecked.
    return requested>1.005?Math.min(1.25,requested*1.02):1
  }
  get url() { return this.stream.url }
  get preloadGuardSeconds(){return this.guardSeconds}
  get generationComplete() { return this.generated||Boolean(this.totalChars&&this.chars===this.totalChars) }
  /** Received PCM only: predictions cannot justify replacing a long spoken slot. */
  get minimumDuration() {
    if(this.generationComplete)return this.duration
    return this.encoded+Math.max(0,this.produced-this.consumedRaw)/1.25+
      (this.headWritten?0:this.guardSeconds)+(this.tailWritten?0:this.guardSeconds)
  }
  private get rawEstimate() {
    if (this.generated || (this.totalChars && this.chars === this.totalChars)) return this.produced
    if (!this.chars) return Math.max(this.produced, this.options.estimateSeconds)
    // Leave headroom for later clauses whose prosody is slower than the first clause.
    const perChar = Math.max(this.produced / this.chars, this.options.estimateSeconds / this.totalChars)
    return this.produced + Math.max(0, this.totalChars - this.chars) * perChar * 1.12
  }
  get duration() {
    return this.encoded + Math.max(0, this.rawEstimate - this.consumedRaw) / this.speed +
      (this.headWritten ? 0 : this.guardSeconds) + (this.tailWritten ? 0 : this.guardSeconds)
  }
  receive(pcm: Buffer, progress: SpeechProgress) {
    this.check()
    if (this.generated || !pcm.length || pcm.length % 2 ||
      !Number.isInteger(progress.charsCompleted) || progress.charsCompleted <= this.chars ||
      !Number.isInteger(progress.totalChars) || progress.totalChars < progress.charsCompleted ||
      (this.totalChars && this.totalChars !== progress.totalChars))
      throw new Error('Index 流式音频或进度无效')
    this.produced += pcm.length / (2 * this.options.sampleRate)
    if (this.produced > 20) throw new Error('回复音频超过 20 秒')
    this.chars = progress.charsCompleted
    this.totalChars = progress.totalChars
    const received = this.now()
    this.lastGenerationSeconds = (received - (this.receivedAt || this.createdAt)) / 1000
    this.receivedAt = received
    this.pending.push(pcm)
    if (this.prepared) this.schedule()
  }
  canStart(budgetSeconds: number) {
    if (this.failure || this.disposed || this.stream.error || !this.produced ||
      !Number.isFinite(budgetSeconds) || budgetSeconds <= 0) return false
    if (this.prepared) return this.duration <= budgetSeconds
    const speed = Math.max(1, this.rawEstimate / (budgetSeconds - this.guardSeconds * 2))
    if (budgetSeconds <= this.guardSeconds * 2) return false
    if (speed > 1.25) return false
    if (this.generated || this.chars === this.totalChars) return true
    const remaining = this.rawEstimate - this.produced
    const rtf = Math.max(0, (this.receivedAt - this.createdAt) / 1000 / this.produced) + 0.15
    const age = Math.max(0, (this.now() - this.receivedAt) / 1000)
    // Index emits entire clauses. Average RTF alone misses a long wait for the very next clause.
    const atomicGap = Math.max(0.4, this.lastGenerationSeconds * 1.2 + 0.3)
    const neededBuffer = Math.max(remaining * Math.max(0, rtf - 1 / speed) - age,
      atomicGap - age) + 0.35
    return this.produced / speed >= Math.max(0.6, neededBuffer)
  }
  async prepare(budgetSeconds: number) {
    this.check()
    if (!this.canStart(budgetSeconds)) throw new Error('流式缓冲或窗口时长不足')
    if (!this.prepared) {
      this.budget = budgetSeconds
      this.speed = this.retimeSpeed(Math.max(1, this.rawEstimate / (budgetSeconds - this.guardSeconds * 2)))
      this.prepared = true
      this.schedule()
    }
    await this.processing
    this.check()
    if (this.generated) await this.finishOutput()
    return this.url
  }
  start(deadline: number) {
    this.check()
    if (!this.prepared || !Number.isFinite(deadline) || deadline <= this.now())
      throw new Error('流式播放窗口已过期')
    this.startedAt = this.now()
    this.deadline = deadline
    this.stream.start?.()
  }
  private schedule() {
    this.processing = this.processing.then(async () => {
      if (!this.headWritten) {
        this.writeGuard()
        this.headWritten = true
      }
      while (this.pending.length) {
        this.check()
        const chunk = this.pending.shift()!
        const rawSeconds = chunk.length / (2 * this.options.sampleRate)
        let speed = this.speed
        if (this.startedAt !== undefined) {
          const elapsed = (this.now() - this.startedAt) / 1000
          const queued = Math.max(0, this.encoded - elapsed)
          const available = (this.deadline - this.now()) / 1000 - queued - OBS_STREAM_RESERVE_SECONDS - this.guardSeconds
          const rawRemaining = Math.max(rawSeconds, this.rawEstimate - this.consumedRaw)
          if (available <= 0 || rawRemaining / 1.25 > available)
            throw new Error('后续语音无法放入剩余窗口，改发文字')
          speed = this.retimeSpeed(Math.max(1, rawRemaining / available))
        } else if (this.rawEstimate / 1.25 + this.guardSeconds * 2 > this.budget) {
          throw new Error('生成时长超过窗口，改发文字')
        }
        speed = Math.min(1.25, speed)
        const pcm = speed > 1.005 ? await this.options.retime(chunk, speed) : chunk
        this.check()
        if (!pcm.length || pcm.length % 2) throw new Error('流式变速音频无效')
        this.write(pcm)
        this.encoded += pcm.length / (2 * this.options.sampleRate)
        this.consumedRaw += rawSeconds
      }
    }).catch(error => { this.fail(error) })
  }
  async seal() {
    this.check()
    if (!this.totalChars || this.chars !== this.totalChars) {
      this.fail(new Error('Index 音频没有完整生成'))
      this.check()
    }
    this.generated = true
    await this.processing
    this.check()
    if (this.prepared) await this.finishOutput()
  }
  private finishOutput() {
    return this.finishing ??= (async () => {
      try {
        await this.processing
        this.check()
        if (!this.tailWritten) { this.writeGuard(); this.tailWritten = true }
        await this.stream.finish()
        this.check()
        this.finished = true
      } catch (error) {
        this.fail(error)
        throw error
      }
    })()
  }
  private writeGuard() {
    if (!this.guardSeconds) return
    const pcm = Buffer.alloc(Math.round(this.guardSeconds * this.options.sampleRate) * 2)
    this.write(pcm)
    this.encoded += pcm.length / (2 * this.options.sampleRate)
  }
  private write(pcm:Buffer){this.stream.write(pcm);this.completeParts.push(pcm)}
  async completedPcm(){
    this.check()
    if(!this.generated||!this.prepared)throw new Error('完整PCM尚未就绪')
    await this.finishOutput();this.check()
    return Buffer.concat(this.completeParts)
  }
  check() {
    if (this.failure) throw this.failure
    if (this.stream.error) { this.fail(this.stream.error); throw this.stream.error }
    if (this.disposed) throw new Error('流式回复已关闭')
    if (this.startedAt !== undefined && this.now() >= this.deadline && !this.finished) {
      this.fail(new Error('流式播放超过窗口截止时间'))
      throw this.failure
    }
  }
  fail(error: unknown) {
    this.failure ??= error instanceof Error ? error : new Error(String(error))
    this.finished = false
    this.dispose()
  }
  dispose = () => {
    if (this.disposed) return
    this.disposed = true
    this.pending = []
    this.completeParts=[]
    this.stream.dispose()
  }
}
