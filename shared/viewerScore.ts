/**
 * 观众行为记分表。
 *
 * 「该不该理这个人」不写死在总纲里 —— 那是死规矩，正常人问声好也会被误伤。
 * 改成记分：某些行为扣分，累计到阈值就不再回他。分数怎么算、扣多少、多少分不理，
 * 全是**配置数据**，可以在界面上改，不用改代码。
 *
 * 归零时机：**每场直播重新开始**（分数只活在这一次会话里）。
 * 昨天刷屏的人，今天开播还是从 0 分开始 —— 不然一开播就有老观众被静音。
 */

/** 能自动数出来的行为。闭集合：加一种要同时加统计口径，不能只加一行数据。 */
export type ViewerScoreRule = 'duplicate' | 'ignored' | 'flood'

export interface ViewerScoreRuleConfig {
  when: ViewerScoreRule
  /** 每次扣几分 */
  delta: number
}

export interface ViewerScoreConfig {
  enabled: boolean
  /** 累计到这个分就不再回他 */
  muteAt: number
  /** 一分钟内超过几句算刷屏（`flood` 用） */
  floodPerMinute: number
  rules: ViewerScoreRuleConfig[]
}

/** 观众这一场的行为统计（由 LiveInteractionService 数出来）。 */
export interface ViewerBehavior {
  comments: number
  duplicated: number
  ignored: number
  answered: number
  demos: number
  minutesActive: number
  /** 最近一分钟说了几句 */
  lastMinute: number
}

export const VIEWER_SCORE_LABELS: Record<ViewerScoreRule, string> = {
  duplicate: '重复说同一句',
  ignored: '被忽略过一次',
  flood: '一分钟内说太多',
}

export const VIEWER_SCORE_ORDER: ViewerScoreRule[] = ['duplicate', 'ignored', 'flood']

export const DEFAULT_VIEWER_SCORE: ViewerScoreConfig = {
  enabled: true,
  muteAt: 6,
  floodPerMinute: 5,
  rules: [
    { when: 'duplicate', delta: 1 },
    { when: 'ignored', delta: 1 },
    { when: 'flood', delta: 2 },
  ],
}

export interface ViewerScoreResult {
  score: number
  /** 到阈值了 —— 不再回他（但取消/明确点播这类确定性动作照旧处理） */
  muted: boolean
  /** 人话的扣分理由，给界面和提示词看：`重复说同一句 ×3（+3）` */
  reasons: string[]
}

/** 取这条规则的扣分；表里没写的规则按 0 分（等于关掉）。 */
function deltaOf(config: ViewerScoreConfig, when: ViewerScoreRule) {
  return Math.max(0, config.rules.find(rule => rule.when === when)?.delta ?? 0)
}

/**
 * 算分。
 *
 * - `duplicate`：他每重复一次自己的话，扣一次
 * - `ignored`：他每被忽略一次，扣一次（说明前面已经没人理他了）
 * - `flood`：一分钟内**超出**上限的每一声，扣一次 —— 刷屏 20 句不是扣 2 分，
 *   是扣 (20-上限)×delta，这样刷屏的人会很快到阈值，而不是一直磨
 */
export function viewerScore(
  behavior: ViewerBehavior,
  config: ViewerScoreConfig = DEFAULT_VIEWER_SCORE,
): ViewerScoreResult {
  if (!config.enabled) return { score: 0, muted: false, reasons: [] }
  const reasons: string[] = []
  let score = 0
  const charge = (count: number, when: ViewerScoreRule) => {
    if (count <= 0) return
    const delta = deltaOf(config, when)
    if (!delta) return
    score += count * delta
    reasons.push(`${VIEWER_SCORE_LABELS[when]} ×${count}（+${count * delta}）`)
  }
  charge(behavior.duplicated, 'duplicate')
  charge(behavior.ignored, 'ignored')
  charge(Math.max(0, behavior.lastMinute - Math.max(1, config.floodPerMinute)), 'flood')
  return { score, muted: score >= Math.max(1, config.muteAt), reasons }
}
