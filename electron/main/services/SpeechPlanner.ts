import { charsForWindow, type DurationModel } from '../../../shared/speechBudget'
import {
  MAX_AIM_SECONDS,
  MIN_USEFUL_WINDOW,
  type AimCandidate,
  aimWindow,
} from '../../../shared/interactionScript'
import { speechWindows } from './SpeechWindows'
import {sentencePaddingAllowance} from '../../../shared/directorNarration'
import {OBS_STREAM_RESERVE_SECONDS} from '../../../shared/speechPlayback'

/** 只出声不发文字时，给窗口留的余量系数。 */
export const VOICE_BUDGET_RATIO = 0.85

export interface SpeechPlan {
  ok: true
  originalText?: string
  context?: AimCandidate['context']
  /** 瞄准的窗口。 */
  start: number
  end: number
  inSeconds: number
  duration: number
  /** 这一轮用的提前量（两本账算出来的）。 */
  leadSeconds: number
  /** 这句话最多能说几秒。 */
  maxSpeechSeconds: number
  /** 这句话最多几个字。 */
  maxChars: number
  /** Advisory lower copy bound for sentence recovery; actual PCM still decides admission. */
  minChars?:number
  /** 队列该活多久 —— 必须覆盖到窗口开始，否则「差一秒过期」。 */
  lifetimeMs: number
  /** 这一步还剩多少秒额度，可以超窗口。 */
  slackSeconds: number
}

export interface SpeechRefusal {
  ok: false
  /** 给时间线看的一句话，直接写明是哪一条卡的。 */
  detail: string
  /** 结构化原因，方便统计。 */
  code: 'no-window' | 'no-reachable-window'
}

/**
 * 这一轮该不该出声、能说多久 ——**唯一**的判断出口。
 *
 * 以前这段逻辑散在三处（路由决策、评论回复、进房问候），各算各的
 * `aimWindow`。三处只要有一处参数不一样，就会出现「路由说能说、真去合成时
 * 又没窗口」，而且永远查不出是哪一处不一致。集中成一个函数之后，
 * 决策和取预算读的是同一份结果，不可能再打架。
 */
export function planSpeech(
  leadSeconds: number,
  model?: DurationModel,
  /** 装得下一句完整话的最短窗口。默认跟着 `MIN_USEFUL_WINDOW` 走 —— 别再写死一个数。 */
  minSeconds: number = MIN_USEFUL_WINDOW,
): SpeechPlan | SpeechRefusal {
  const candidates = speechWindows.upcoming()
  if (!candidates.length) {
    return {
      ok: false,
      code: speechWindows.active ? 'no-reachable-window' : 'no-window',
      detail: speechWindows.active
        ? `这段配音的插入点都已经播过了（共 ${speechWindows.snapshot().total} 个）`
        : '当前步骤没有配插入点，语音无处可插',
    }
  }
  const nearest = speechWindows.aim(leadSeconds, minSeconds, MAX_AIM_SECONDS)
  const sentence = aimWindow(candidates.filter(candidate=>candidate.kind==='sentence'),leadSeconds,minSeconds,MAX_AIM_SECONDS)
  // A short authored gap should not force every reply into a tiny greeting when
  // a complete replaceable sentence begins immediately after it.
  const target = nearest?.kind==='silence'&&sentence&&sentence.inSeconds<=nearest.inSeconds+2?sentence:nearest
  if (!target) {
    const nearest = candidates[0]
    return {
      ok: false,
      code: 'no-reachable-window',
      detail: `没瞄到来得及的窗口（等 ${leadSeconds.toFixed(1)} 秒，共 ${candidates.length} 个候选，最近一个${nearest.inSeconds < 0 ? `已经开始了 ${(-nearest.inSeconds).toFixed(1)} 秒` : `还差 ${nearest.inSeconds.toFixed(1)} 秒`}${nearest.inSeconds > MAX_AIM_SECONDS ? `，超过最远 ${MAX_AIM_SECONDS} 秒` : ''}）`,
    }
  }
  /**
   * 按**实际可用时长**算字数，不是窗口整段长度。
   *
   * 窗口已经开始时只剩后半段能用（见 `aimWindow`）—— 按整段算会写出一句
   * 塞不进剩余空间的话，白合成一遍还得退回文字。
   */
  const maxSpeechSeconds = target.kind==='sentence'
    ?Math.round(Math.max(.1,target.usable-OBS_STREAM_RESERVE_SECONDS)*1e6)/1e6
    :target.usable * VOICE_BUDGET_RATIO
  // Aim for natural delivery; bounded acceleration is recovery headroom, not a reason to solicit extra copy.
  const maxChars=charsForWindow(target.kind==='sentence'?Math.max(.1,target.usable-.25):maxSpeechSeconds,model)
  const minChars=target.kind==='sentence'
    ?Math.min(maxChars,charsForWindow(Math.max(0,target.usable-sentencePaddingAllowance(target,candidates)),model)+1):undefined
  return {
    ok: true,
    ...target,
    leadSeconds,
    maxSpeechSeconds,
    maxChars,
    ...(minChars?{minChars}:{}),
    /**
     * 队列该活多久。
     *
     * 不能只算到「瞄准的那个窗口开始」——**实测合成会比预估长**（7 个字预测
     * 1.8 秒、实出 2.7 秒），于是它塞不进瞄的那个窗口，只能等后面一个更大的。
     * 只给 `inSeconds + 5` 的话，还没滑到那个窗口就过期了（实测连续四条
     * 全是 `queue expired`）。给足时间让它自己滑过去。
     */
    lifetimeMs: Math.max(MIN_SPEECH_LIFETIME_MS, (target.inSeconds + 6) * 1000),
    slackSeconds: speechWindows.slackSeconds(),
  }
}

/**
 * 队列存活期下限。
 *
 * 音频偶尔会明显长于预估（实测 6 个字出过 6.4 秒），要靠队列滑到后面更大的
 * 窗口去 —— 存活期太短就滑不到。上限在 `LiveVoiceService` 那边统一夹。
 */
export const MIN_SPEECH_LIFETIME_MS = 22000
