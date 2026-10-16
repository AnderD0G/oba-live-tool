/**
 * 互动语音的三本账：时长模型、字数换算、阶段额度。
 *
 * 背景：运行时要先告诉 AI「这句话最多说几个字」，AI 才写得进窗口。而这个
 * 换算依赖「字数 → 音频时长」。硬编码一个系数是不行的 —— 换音色、换语速、
 * 换模型都会漂。所以这里做自校准：每次合成完顺手记一笔（字数, 实测时长），
 * 够样本就回归一次，下一次预估就更准。记录是异步的，永不挡实时链路。
 */

export interface DurationModel {
  /** 固定开销（秒）：起音、收尾，与字数无关。 */
  intercept: number
  /** 每字增量（秒/字）。 */
  perChar: number
}

/**
 * 实测初值：千问 Qwen3-TTS-12Hz-0.6B（RTF≈0.5）。
 * 3/9/15/26 字 → 1.04/2.48/3.52/5.60 秒，最小二乘得 a≈0.45、b≈0.198。
 */
export const DEFAULT_DURATION_MODEL: DurationModel = { intercept: 0.45, perChar: 0.198 }

export interface DurationSample {
  chars: number
  seconds: number
}

/** 少于这些样本就别回归 —— 两三条算出来的系数会把预算带飞。 */
export const MIN_DURATION_SAMPLES = 8

/** 系数必须落在物理上说得通的范围内；坏样本不能把所有人的插话都拒掉。 */
const INTERCEPT_RANGE = { min: 0.15, max: 1.5 }
const PER_CHAR_RANGE = { min: 0.1, max: 0.4 }

function clamp(value: number, range: { min: number; max: number }) {
  if (!Number.isFinite(value)) return undefined
  return Math.min(range.max, Math.max(range.min, value))
}

/**
 * 用实测样本做最小二乘。样本不足、或拟合结果跑出合理范围时，退回默认模型 ——
 * 宁可用一个已知靠谱的估计，也不要让几条坏样本把所有插话都拒掉。
 */
export function fitDurationModel(samples: DurationSample[]): DurationModel {
  const usable = samples.filter(
    sample =>
      Number.isFinite(sample.chars) &&
      Number.isFinite(sample.seconds) &&
      sample.chars > 0 &&
      sample.seconds > 0,
  )
  if (usable.length < MIN_DURATION_SAMPLES) return DEFAULT_DURATION_MODEL

  const count = usable.length
  const meanX = usable.reduce((sum, s) => sum + s.chars, 0) / count
  const meanY = usable.reduce((sum, s) => sum + s.seconds, 0) / count
  let cov = 0
  let variance = 0
  for (const sample of usable) {
    cov += (sample.chars - meanX) * (sample.seconds - meanY)
    variance += (sample.chars - meanX) ** 2
  }
  if (variance <= 1e-9) return DEFAULT_DURATION_MODEL

  const perChar = clamp(cov / variance, PER_CHAR_RANGE)
  if (perChar === undefined) return DEFAULT_DURATION_MODEL
  const intercept = clamp(meanY - perChar * meanX, INTERCEPT_RANGE)
  if (intercept === undefined) return DEFAULT_DURATION_MODEL
  return { intercept, perChar }
}

/** 往模型里塞新样本，保留最近若干条 —— 音色换了，旧样本要自然淡出。 */
export const MAX_DURATION_SAMPLES = 200
export function appendSample(samples: DurationSample[], sample: DurationSample) {
  const next = [...samples, sample]
  return next.length > MAX_DURATION_SAMPLES ? next.slice(next.length - MAX_DURATION_SAMPLES) : next
}

/**
 * 一个窗口能说几个字。
 *
 * 减去固定开销后再按每字增量折算；下限 2 字 —— 比「两个字的短答」更短的
 * 建议没有意义，会让 AI 写出「嗯」这种没信息量的回复。
 */
export function charsForWindow(seconds: number, model: DurationModel = DEFAULT_DURATION_MODEL) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.max(2, Math.floor((seconds - model.intercept) / model.perChar))
}

/** 反过来：这句字数大概要说多久。预瞄判断「来不来得及」时用。 */
export function secondsForChars(chars: number, model: DurationModel = DEFAULT_DURATION_MODEL) {
  return model.intercept + model.perChar * Math.max(0, chars)
}

/** 断句优先的标点，从最靠后的一个往回找。 */
const TRIM_BREAKS = '。！？；，、：,.!?;:'

/**
 * 给一句「只出声、不发文字」的话留的余量系数。
 *
 * 不留满是因为实测合成会比公式略长，而且不同字的发音长度本来就不是线性的。
 */
export const VOICE_BUDGET_RATIO = 0.85

/**
 * 把一句话砍到能在 `seconds` 内说完。
 *
 * 为什么必须砍：字数预算是**建议**给 AI 的，不保证遵守 —— 实测让写 13 个字
 * 它写了 15 个，合成出来 4.4 秒，塞不进 3.7 秒的窗口，于是整句被丢掉、
 * 降级成文字。与其指望它每次都听话，不如按上限硬砍：**说得短一点也比
 * 说不出来强**。
 *
 * 优先在标点处断（听感自然），找不到标点才硬截；砍不出内容就返回空串，
 * 由调用方决定是整条不发还是原样发。
 */
export function trimToSeconds(
  text: string,
  seconds: number,
  model: DurationModel = DEFAULT_DURATION_MODEL,
) {
  const clean = text.replace(/\s+/g, '')
  const max = charsForWindow(seconds, model)
  const chars = [...clean]
  if (chars.length <= max) return clean
  const cut = chars.slice(0, max)
  for (let index = cut.length - 1; index >= 0; index--)
    if (TRIM_BREAKS.includes(cut[index]) && index >= 1) return cut.slice(0, index).join('')
  return max >= 2 ? cut.join('') : ''
}

/**
 * 阶段额度账本 —— 动态资源池。
 *
 * 讲解词本身有余量（很多配音比画面短），所以某次插话超出它那个窗口是可以
 * 容忍的，只要**总账不透支**。注意 charge 是带符号的：插一句比窗口短的话
 * 会把时间**退还**给后面，越省越能插。
 */
export class SpeechBudgetLedger {
  private usedMs = 0
  private spareMs: number

  constructor(spareMs = 0) {
    this.spareMs = SpeechBudgetLedger.normalize(spareMs)
  }

  /** 余量永远是 0 或正数：负的静态余量只是「这一步已经超了」，不是「可以倒扣」。 */
  private static normalize(value: number) {
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  /** 这个阶段还剩多少可透支的时间（毫秒，可为负）。 */
  get remainingMs() {
    return this.spareMs - this.usedMs
  }

  get spare() {
    return this.spareMs
  }

  get used() {
    return this.usedMs
  }

  /** 换阶段（A→B→C）时重置，并给出新阶段的静态余量。 */
  reset(spareMs: number) {
    this.spareMs = SpeechBudgetLedger.normalize(spareMs)
    this.usedMs = 0
  }

  /**
   * 攒余量：某一步的配音比画面短，省下的时间进池子，供后面的插话透支。
   *
   * 配音比画面长时不倒扣 —— 那种情况导播本来就会停末帧等它说完，
   * 池子记成负数只会让后面的插话全被拒，反而更糟。
   */
  addSpare(spareMs: number) {
    if (!Number.isFinite(spareMs) || spareMs <= 0) return
    this.spareMs += spareMs
  }

  /**
   * 这句能不能插：语音时长 ≤ 窗口时长 + 剩余额度。
   *
   * 总账要爆的时候这里返回 false —— 宁可这条不接话（回退成文字），
   * 也不要让整段讲解被顶穿、后面的画面和配音全错位。
   */
  allows(windowMs: number, speechMs: number) {
    if (!Number.isFinite(windowMs) || !Number.isFinite(speechMs)) return false
    return speechMs <= windowMs + this.remainingMs
  }

  /** 记账。语音比窗口短时 usedMs 变小（退还时间）。 */
  charge(windowMs: number, speechMs: number) {
    if (!Number.isFinite(windowMs) || !Number.isFinite(speechMs)) return
    this.usedMs += speechMs - windowMs
  }

  snapshot() {
    return { spareMs: Math.round(this.spareMs), usedMs: Math.round(this.usedMs) }
  }
}
