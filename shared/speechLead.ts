/**
 * 提前量（lead）的自校准 —— 两个维度分开算。
 *
 * 提前量的意思是：**从决定出声，到音频就绪，需要几秒**。预瞄必须至少提前这么多
 * 去找窗口，否则「这边刚写完字，那边窗口已经过去了」。
 *
 * 链路上有两段，都会抖，而且**互相独立**：
 *
 *   决定出声 ──[DeepSeek 写字]──> 文本就绪 ──[千问 合成]──> 音频就绪
 *
 * 所以必须分开量、分开算。合起来记成一笔的后果是：千问变慢了看不出来，
 * DeepSeek 变快了也看不出来，只有一个总数在动，谁也归不了因。
 *
 * 两段的耗时都能卡到时间戳（决策时刻 / onReply 入口 / reply 返回），
 * 所以**归因是量出来的，不是猜出来的**。
 *
 * 每段取最近一批的 75 分位当「典型值」—— 只跟最近一段时间，
 * 因为 API 高峰期和低谷期速度不一样，攒几百条再平均等于把早晚混在一起。
 *
 * **千问那一段记的是「首块就绪」而不是「整段合成完」**：流式播放只要首块
 * 就能出声，提前量要覆盖的是首块时间。记成整段的话，提前量会被虚高地
 * 卡在 1 秒以上，气口密的时候反而够不着近的气口 —— 流式的优势就白费了。
 *
 * 分位数之上再加一个**余量**，这个余量靠 AIMD 自己探：
 * 成功就往下压（越来越激进），超时就退回来（一次失败就回安全区）。
 * 前期偏激进 —— 宁可探到底再退，也不要一直保守。
 */

/**
 * 低于这个提前量就来不及了，别再无脑缩短。
 *
 * 定成 1.2 秒而不是 2 秒：流式播放只要**首块**就绪就能出声（千问实测 0.26~0.39 秒），
 * 不需要等整段合成完。气口密的时候，能不能赶上 1.5 秒外那个气口，全看这条线。
 * 定高了，流式白做。
 */
export const MIN_LEAD_SECONDS = 1.2
/** 高到这个程度说明链路本身有问题，不是提前量能救的。 */
export const MAX_LEAD_SECONDS = 20
/** 没攒够样本前的起始值。刻意偏短，让它在成功中慢慢长上去。 */
export const DEFAULT_LEAD_SECONDS = 3
/** 每段至少这么多条样本才敢用实测值。 */
export const MIN_LEAD_SAMPLES = 4
export const MAX_LEAD_SAMPLES = 100

/**
 * 某一段还没有样本时用的兜底值。
 *
 * **不能因为缺一段就整个放弃自校准** —— 实测踩过：ai 段因为量错了时刻一直是空的，
 * 于是 `fitLead` 每次都退回配置值 3 秒，余量涨到上限也没用，整整一轮自校准
 * 一次都没跑起来。缺的那段用实测默认值顶上，有的那段照常参与。
 */
export const DEFAULT_AI_SECONDS = 0.9
export const DEFAULT_TTS_SECONDS = 2.4

/**
 * 算分位数只看最近这么多条。
 *
 * DeepSeek 和千问的高峰期都会变慢，样本攒到几百条再平均等于把早上的速度
 * 和晚上的速度混在一起。只看最近 30 条才能跟上当前这段时间的实况。
 */
export const RECENT_LEAD_SAMPLES = 30

/**
 * 「余量」—— 两段实测之上再提前多少。
 *
 * 实测是物理下限：写字加合成要 2.4 秒，提前量就不可能是 2.0 秒。
 * 但余量可以探 —— 太大就只能瞄很远的窗口（出声晚、还容易超过队列存活期）；
 * 太小就会「差一点点没赶上」。让它自己找：成功往下探，超时退回来。
 */
export const DEFAULT_LEAD_MARGIN = 0.5
export const MIN_LEAD_MARGIN = 0.1
export const MAX_LEAD_MARGIN = 3
/** 成功一次往下探多少。小步，因为要的是「将将好」而不是「经常赶不上」。 */
export const MARGIN_STEP_DOWN = 0.2
/** 超时一次退回多少。大步，一次失败就该回到安全区。 */
export const MARGIN_STEP_UP = 0.8

const MIN_SAMPLE = 0.02
const MAX_SAMPLE = 60

/** 两段链路各自的实测样本。 */
export interface LeadState {
  /** DeepSeek 写字：决定出声 → 文本就绪。 */
  ai: number[]
  /** 千问合成：文本就绪 → 音频就绪。 */
  tts: number[]
  /** 两段实测之上再提前多少秒。 */
  margin: number
}

export function defaultLeadState(): LeadState {
  return { ai: [], tts: [], margin: DEFAULT_LEAD_MARGIN }
}

function clean(samples: number[]) {
  return samples.filter(
    value => Number.isFinite(value) && value >= MIN_SAMPLE && value <= MAX_SAMPLE,
  )
}

/**
 * 最近一批的分位数。样本不够就返回 undefined —— 不拿一两次慢请求定调。
 */
export function recentLatency(
  samples: number[],
  quantile = 0.75,
  minSamples = MIN_LEAD_SAMPLES,
) {
  const good = clean(samples).slice(-RECENT_LEAD_SAMPLES).sort((a, b) => a - b)
  if (good.length < minSamples) return undefined
  return good[Math.min(good.length - 1, Math.floor(good.length * quantile))]
}

/**
 * 两段的分位数之和 + 余量。**任一段有实测就用实测，缺的那段用默认值顶上** ——
 * 两段都缺才退回 `fallback`（配置里填的值）。
 */
export function fitLead(
  state: LeadState,
  fallback = DEFAULT_LEAD_SECONDS,
  margin = state.margin,
) {
  const ai = recentLatency(state.ai)
  const tts = recentLatency(state.tts)
  if (ai === undefined && tts === undefined) return fallback
  return Math.min(
    MAX_LEAD_SECONDS,
    Math.max(MIN_LEAD_SECONDS, (ai ?? DEFAULT_AI_SECONDS) + (tts ?? DEFAULT_TTS_SECONDS) + margin),
  )
}

/** 这一轮该用多少提前量。 */
export function leadOf(state: LeadState, fallback = DEFAULT_LEAD_SECONDS) {
  return fitLead(state, fallback, state.margin)
}

/** 播出去了 → 当前提前量够，下一轮再往下探一点。 */
export function afterPlayed(state: LeadState): LeadState {
  return {
    ...state,
    margin: Math.max(MIN_LEAD_MARGIN, Number((state.margin - MARGIN_STEP_DOWN).toFixed(3))),
  }
}

/** 没赶上窗口 → 退回来，一次失败就回到安全区。 */
export function afterMissed(state: LeadState): LeadState {
  return {
    ...state,
    margin: Math.min(MAX_LEAD_MARGIN, Number((state.margin + MARGIN_STEP_UP).toFixed(3))),
  }
}

export type LeadSegment = 'ai' | 'tts'

export function appendLeadSample(
  samples: number[],
  seconds: number,
  max = MAX_LEAD_SAMPLES,
): number[] {
  if (!Number.isFinite(seconds) || seconds < MIN_SAMPLE || seconds > MAX_SAMPLE) return samples
  return [...samples, seconds].slice(-max)
}

/** 「还差几秒开始」要落在 [提前量, 够得着的上限] 之间，这里统一裁一次。 */
export function clampLead(seconds: number) {
  if (!Number.isFinite(seconds)) return DEFAULT_LEAD_SECONDS
  return Math.min(MAX_LEAD_SECONDS, Math.max(MIN_LEAD_SECONDS, seconds))
}

/**
 * 归因报告：两段各自的典型值和最差值。
 *
 * 这是「到底是谁慢了」的答案 —— 典型值涨了就说明那段这段时间变慢了，
 * 最大值离典型值远就说明那段抖。日志和界面上直接读它。
 */
export function describeLead(state: LeadState, fallback = DEFAULT_LEAD_SECONDS) {
  const stat = (samples: number[]) => {
    const good = clean(samples).slice(-RECENT_LEAD_SAMPLES)
    if (!good.length) return '无样本'
    const p75 = recentLatency(samples)
    const max = Math.max(...good)
    return p75 === undefined
      ? `样本 ${good.length}/4`
      : `典型 ${p75.toFixed(2)}s 最差 ${max.toFixed(2)}s（${good.length} 条）`
  }
  return [
    `DeepSeek 写字 ${stat(state.ai)}`,
    `千问合成 ${stat(state.tts)}`,
    `余量 ${state.margin.toFixed(1)}s`,
    `合计提前量 ${leadOf(state, fallback).toFixed(1)}s`,
  ].join('；')
}
