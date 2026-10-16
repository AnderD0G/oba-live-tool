/**
 * 按步骤配置的互动话术。
 *
 * 核心是把两件事**分开**：
 *   · **步骤决定「引导什么」** —— 讲板材时引导报编号，讲试戴时引导评论试戴
 *   · **窗口决定「说多长」** —— 预瞄到 3.7 秒就说 15 字，1.5 秒就说 3 字
 *
 * 这张表只管前者。后者由预瞄 + 字数预算负责，AI 把两者揉成一句自然的话。
 * 话术本身**交给 AI 写**，不用模板 —— 模板说几十遍观众听得出来。
 */

import { DEFAULT_LEAD_SECONDS } from './speechLead'

/** 引导目标。数组顺序就是优先级：装不下就砍后面的。 */
export type InteractionGoal = 'greet' | 'comment' | 'like' | 'order' | 'share' | 'ask'

export const INTERACTION_GOAL_ORDER: InteractionGoal[] = [
  'greet',
  'comment',
  'like',
  'order',
  'share',
  'ask',
]

export const INTERACTION_GOAL_LABELS: Record<InteractionGoal, string> = {
  greet: '点名回应',
  comment: '引导评论',
  like: '引导点赞',
  order: '引导下单',
  share: '引导分享',
  ask: '引导提问',
}

/**
 * 每一档的说明 —— 直接拼进 prompt，告诉 AI 这一级该干什么。
 * 写得具体一点，AI 才好挑措辞。
 */
export const INTERACTION_GOAL_HINTS: Record<InteractionGoal, string> = {
  greet: '先叫出这位观众的名字（宝宝），让他知道被看见了',
  comment:
    '请他在评论区打字。评论会触发画面展示，所以这是最值钱的引导 —— 能说就一定说',
  like: '请他点点赞，一句带过就行',
  order: '想要的话点下方小黄车',
  share: '把直播间分享给需要的朋友',
  ask: '问他想看哪一款 / 哪个颜色，把话头递回去',
}

export interface InteractionScript {
  /** 步骤名，精确匹配。空字符串 = 默认行（没配到的步骤都走它） */
  step: string
  /** 按优先级排列的引导目标 */
  goals: InteractionGoal[]
  /** 给 AI 的附加指引，比如「评论报编号我给你看颜色」。可留空 */
  hint: string
}

export interface InteractionScriptConfig {
  enabled: boolean
  /**
   * 预瞄提前量（秒）：只瞄准「还有这么久才开始」的窗口。
   *
   * 实测生成耗时：DeepSeek ~0.85s + 千问 0.79~2.76s + 导播预载 0.5s
   * ≈ 1.4~4.1 秒。默认 6 秒是留了 1.5~2 倍余量 —— 宁可少插一次，
   * 也不要「这边辛辛苦苦生成完，那边窗口已经过了」。
   */
  leadSeconds: number
  scripts: InteractionScript[]
}

export const MAX_GOALS = 6
export const MAX_HINT_CHARS = 120
export const MAX_SCRIPTS = 200
export const MIN_LEAD_SECONDS = 2
export const MAX_LEAD_SECONDS = 20

/** 默认一条：点名 → 评论 → 点赞。没单独配的步骤都走它。 */
export const DEFAULT_INTERACTION_SCRIPT: InteractionScriptConfig = {
  enabled: true,
  /**
   * 起始提前量，刻意取短（3 秒）。它只是**没攒够实测样本前的起点** ——
   * 攒够之后由 SpeechLeadModel 按实测的「决定出声 → 音频就绪」自动接管。
   */
  leadSeconds: DEFAULT_LEAD_SECONDS,
  scripts: [{ step: '', goals: ['greet', 'comment', 'like'], hint: '' }],
}

export function defaultInteractionScript(): InteractionScriptConfig {
  return structuredClone(DEFAULT_INTERACTION_SCRIPT)
}

function isGoal(value: unknown): value is InteractionGoal {
  return typeof value === 'string' && INTERACTION_GOAL_ORDER.includes(value as InteractionGoal)
}

export function validateInteractionScript(value: unknown): InteractionScriptConfig {
  if (!value || typeof value !== 'object') throw new Error('互动话术配置必须是对象')
  const config = value as Partial<InteractionScriptConfig>
  if (typeof config.enabled !== 'boolean') throw new Error('互动话术 enabled 必须是布尔值')

  const lead = config.leadSeconds
  if (
    typeof lead !== 'number' ||
    !Number.isFinite(lead) ||
    lead < MIN_LEAD_SECONDS ||
    lead > MAX_LEAD_SECONDS
  )
    throw new Error(`预瞄提前量必须在 ${MIN_LEAD_SECONDS}..${MAX_LEAD_SECONDS} 秒之间`)

  if (!Array.isArray(config.scripts)) throw new Error('互动话术 scripts 必须是数组')
  if (config.scripts.length > MAX_SCRIPTS)
    throw new Error(`互动话术最多 ${MAX_SCRIPTS} 条`)

  const seen = new Set<string>()
  const scripts: InteractionScript[] = []
  for (const [index, raw] of config.scripts.entries()) {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 条互动话术格式错误`)
    const item = raw as Partial<InteractionScript>
    if (typeof item.step !== 'string') throw new Error(`第 ${index + 1} 条的步骤名必须是字符串`)
    const step = item.step.trim()
    if (seen.has(step)) throw new Error(`步骤「${step || '默认'}」配了不止一条`)
    seen.add(step)

    if (!Array.isArray(item.goals) || !item.goals.length)
      throw new Error(`步骤「${step || '默认'}」至少要选一个引导目标`)
    if (item.goals.length > MAX_GOALS) throw new Error(`引导目标最多 ${MAX_GOALS} 个`)
    if (!item.goals.every(isGoal)) throw new Error(`步骤「${step || '默认'}」有无法识别的引导目标`)
    if (new Set(item.goals).size !== item.goals.length)
      throw new Error(`步骤「${step || '默认'}」的引导目标有重复`)

    const hint = typeof item.hint === 'string' ? item.hint.trim() : ''
    if (hint.length > MAX_HINT_CHARS)
      throw new Error(`步骤「${step || '默认'}」的附加指引最多 ${MAX_HINT_CHARS} 字`)

    scripts.push({ step, goals: [...item.goals], hint })
  }

  return { enabled: config.enabled, leadSeconds: lead, scripts }
}

/**
 * 取某个步骤该用哪条。**先找精确匹配的，没有就用默认行。**
 * 一条都没有时返回 undefined —— 调用方据此判断「这一步不插话术」。
 */
export function scriptForStep(
  config: InteractionScriptConfig,
  stepName: string,
): InteractionScript | undefined {
  const name = stepName.trim()
  return config.scripts.find(item => item.step && item.step === name) ?? config.scripts.find(item => !item.step)
}

/** 把步骤配置翻译成给 AI 的**参考**（不是死规定）。 */
export function describeScript(script: InteractionScript): string {
  const lines = script.goals.map(
    (goal, index) => `${index + 1}. ${INTERACTION_GOAL_LABELS[goal]} —— ${INTERACTION_GOAL_HINTS[goal]}`,
  )
  const head =
    '下面几个引导目标的先后只是**参考**，不是死规定。' +
    '你自己判断这一次说到哪一级 —— 观众刚问了问题就先答他，刚进房就先欢迎，别机械地挨个念。' +
    '窗口装不下时，宁可少说一级，也不要硬挤。'
  const tail = script.hint ? `这一步可以这样说：${script.hint}` : ''
  return [head, ...lines, tail].filter(Boolean).join('\n')
}

export interface AimCandidate {
  kind?: 'sentence' | 'silence'
  /** Exact approved original sentence. Missing for silent insertion / legacy windows. */
  originalText?: string
  context?: {
    stepId: string
    video: string
    audio: string
    start: number
    end: number
    reason: string
    variantId?: string
  }
  start: number
  end: number
  /**
   * 还有几秒开始。**已经开始的窗口是负数**（已经开始了多少秒），不要夹到 0 ——
   * `usable` 靠 `inSeconds + duration` 推剩余时间，一夹就会把它算多。
   */
  inSeconds: number
  duration: number
}

/** 挑中的窗口，外加「从能开播那一刻算起还剩多少秒」。 */
export interface AimTarget extends AimCandidate {
  /**
   * **实际可用时长** —— 和 `duration` 不是一回事。
   *
   * 窗口已经开始时，能用的只剩后半段：要在 `now + 提前量` 那一刻才可能开播，
   * 所以可用 = `窗口结束 − max(窗口开始, now + 提前量)`。
   * 字数预算要按它算，不然会按整段长度写一句塞不进剩余空间的话。
   */
  usable: number
}

/**
 * 挑第一个来得及且装得下完整回复的窗口。
 * 整句替换（含旧的无类型窗口）必须在句首前就绪；仅显式静音窗口允许中途进入。
 * 静音窗口按剩余时间计算预算；无法安全进入时返回 undefined。
 */
export function aimWindow(
  windows: AimCandidate[],
  leadSeconds: number,
  /** 装得下一句完整话的最短**可用**时长。低于这个数只当兜底。 */
  minSeconds = MIN_USEFUL_WINDOW,
  /**
   * 最远够得着的窗口。队列存活期上限 30 秒，减去合成和轮询的余量，
   * 超过这个距离的窗口**等不到**——瞄它等于注定过期。
   */
  maxSeconds = MAX_AIM_SECONDS,
): AimTarget | undefined {
  return windows
    .filter(window => window.kind === 'silence' || window.inSeconds >= Math.max(0, leadSeconds))
    .filter(window => window.inSeconds <= maxSeconds)
    .map(window => {
      // 最早能开播的时刻（相对现在）：窗口还没到就等它，已经到了就等音频就绪。
      const startDelay = Math.max(leadSeconds, window.inSeconds)
      return { ...window, usable: window.inSeconds + window.duration - startDelay }
    })
    /**
     * **一个门槛：可用时长够不够。**
     *
     * 不设「退回到最短的那个」—— 实测那样更糟：可用只剩 0.2 秒时，
     * 字数预算会被压到下限 2 个字（约 0.85 秒），写出来照样塞不进，
     * 白合成一遍、白等一轮，最后还是退回文字。**不够就干脆别说。**
     */
    .find(window => window.usable >= minSeconds)
}

/** 能说出一句完整短话的最短窗口。低于这个长度只当兜底。 */
export const MIN_USEFUL_WINDOW = 1.2

/** 瞄得到的最远距离（秒）。再远就超过队列存活期了。 */
export const MAX_AIM_SECONDS = 24
