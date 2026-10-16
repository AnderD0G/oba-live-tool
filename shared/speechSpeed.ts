/**
 * 语速：**基础语速 + 装不下再加**。
 *
 * ## 为什么要有「基础语速」
 *
 * 2026-09-29 实测：千问这个音色**本身就慢** —— 实测 0.28~0.55 秒/字，
 * 而正常中文说话大约 0.2 秒/字。用户听下来「1.25 倍都慢」。
 *
 * 一开始只有「装不下才加速」这一条，所以**装得下的时候照样慢**。
 * 基础语速是**每句话都乘**的，跟装不装得下无关 —— 它修的是音色，不是窗口。
 *
 * ## 为什么需要调速（而不是裁内容）
 *
 * 时长是**量得出来**的：千问确定性，同一句合 6 遍一个采样都不差。
 * 而**字数不是时长的函数** —— 同样 9 个字，1.76 秒到 4.24 秒都有（差 2.4 倍），
 * 因为输出按 0.08 秒量化（模型 12Hz），**一个逗号就值 1.04 秒**。
 * 所以按 `0.198 秒/字` 裁文本等于拿歪尺子量；调速则一个字不丢。
 *
 * | 倍速 | 听感 |
 * |---|---|
 * | ≤ 1.10× | 听不出来 |
 * | 1.10 ~ 1.45× | 略快但自然 |
 * | > 1.60× | 开始像快进 |
 *
 * 上述区间是**基于正常语速**的经验值；这个音色本身偏慢，所以基础语速默认取得比 1 高。
 * 两个值都做成设置项，用户能按耳朵调。
 */

export interface SpeechSpeedSettings {
  /** 每句话都乘的基础语速。修的是「音色读得慢」，跟窗口够不够无关。 */
  base: number
  /** 绝对上限。基础语速之上还能再快多少，用来救「装不下」的那些句子。 */
  max: number
}

/**
 * 默认值。
 *
 * `base` 取 **1.25**：2026-09-29 让用户听 1.25/1.40/1.55/1.70/1.85/2.00 六档对照，
 * 他选的是 1.25×（"比较可以的"）。这个音色本身比正常说话慢，所以基础语速不为 1。
 * `max` 取 1.8：留给「装不下」的余量，再高就像快进。
 */
export const DEFAULT_SPEECH_SPEED: SpeechSpeedSettings = { base: 1.25, max: 1.8 }

/** 低于这个倍速听不出来。 */
const INAUDIBLE_SPEED = 1.1
/** 超过这个倍速开始像快进。 */
const FAST_FORWARD_SPEED = 1.6

export interface SpeechFit {
  /** 要用的倍速。**至少是基础语速**，不会是 1。 */
  speed: number
  /** 调完之后的时长（秒）。 */
  seconds: number
  /** 按上限调完还装不下 —— 调用方这时才该考虑裁文本。 */
  overflow: boolean
  /** 给日志用的一句话，说清楚发生了什么。 */
  reason: string
}

function clampSettings(settings: SpeechSpeedSettings): SpeechSpeedSettings {
  const base = Number.isFinite(settings.base) ? Math.min(2, Math.max(1, settings.base)) : 1
  const max = Number.isFinite(settings.max) ? Math.min(2, Math.max(base, settings.max)) : base
  return { base, max }
}

/**
 * 算出让这段语音装进 `availableSeconds` 所需的倍速。
 *
 * `availableSeconds` 是**真正能用的秒数**（已扣掉安全余量），
 * 不是气口的原始长度 —— 调用方负责扣。
 */
export function fitSpeech(
  durationSeconds: number,
  availableSeconds: number,
  settings: SpeechSpeedSettings = DEFAULT_SPEECH_SPEED,
): SpeechFit {
  const { base, max } = clampSettings(settings)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    return { speed: base, seconds: durationSeconds, overflow: true, reason: '时长读不出来' }

  // 基础语速先乘上 —— 这一步和窗口无关，是修音色。
  const atBase = durationSeconds / base
  if (!Number.isFinite(availableSeconds) || availableSeconds <= 0)
    return { speed: base, seconds: atBase, overflow: true, reason: '没有可用时间' }
  if (atBase <= availableSeconds)
    return {
      speed: base,
      seconds: atBase,
      overflow: false,
      reason: `基础语速 ${base.toFixed(2)}×（${durationSeconds.toFixed(2)}s → ${atBase.toFixed(2)}s，可用 ${availableSeconds.toFixed(2)}s）`,
    }

  const needed = durationSeconds / availableSeconds
  const speed = Math.min(needed, max)
  const seconds = durationSeconds / speed
  /**
   * 注意这里**不能**用浮点直接比大小：`4.24 / (4.24/4.12)` 未必正好等于 4.12，
   * 差一个 ulp 就会把「刚刚好装得下」判成「还差一点」，于是白白去裁文本。
   */
  const overflow = seconds > availableSeconds + 0.005
  return {
    speed,
    seconds,
    overflow,
    reason: overflow
      ? `即使 ${max.toFixed(2)}× 也只到 ${seconds.toFixed(2)}s，仍超过 ${availableSeconds.toFixed(2)}s，需要裁文本`
      : `装不下 → 加速到 ${speed.toFixed(2)}×（${durationSeconds.toFixed(2)}s → ${seconds.toFixed(2)}s）` +
        (speed > FAST_FORWARD_SPEED
          ? '，偏快'
          : speed > INAUDIBLE_SPEED
            ? '，略快但自然'
            : '，听不出来'),
  }
}

/**
 * 需不需要动 ffmpeg。现在**基础语速不为 1，所以几乎总要跑一次** ——
 * 实测一次约 100~300ms，而合成本身 1.5~2 秒，这点开销在入队之前、不在气口里。
 */
export function needsSpeedChange(fit: SpeechFit) {
  return fit.speed > 1.0001
}
