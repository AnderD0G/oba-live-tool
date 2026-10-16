import type { AudienceTrace } from './audienceEvents'
import type { AudienceGroupsConfig, GroupDecisionContext } from './audienceGroups'
import {
  type AudienceBehaviorCounts,
  type AudienceBehaviorWeights,
  finiteScore,
  scoreBehaviorCounts,
  validateBehaviorWeights,
} from './audienceScoring'
export type RoutingMode = 'focus' | 'selective' | 'all'
export type RoutingEvent = 'viewer.enter' | 'viewer.comment'
export type RoutingField =
  | 'user.id'
  | 'user.score'
  | 'user.sessionScore'
  | 'user.engagementScore'
  | 'user.sessionEngagementScore'
  | 'user.fansClubLevel'
  | 'user.payLevel'
  | 'user.purchaseCount'
  | 'user.isFirstSeen'
  | 'room.onlineCount'
export interface RoutingCondition {
  field: RoutingField
  op: 'eq' | 'gte' | 'lte' | 'exists'
  value: string | number | boolean | null
}
export interface RoutingRule {
  id: string
  name: string
  enabled: boolean
  priority: number
  events: RoutingEvent[]
  all: RoutingCondition[]
  any?: RoutingCondition[]
  voice: boolean
  text: boolean
  guidance?: string
}
export interface InteractionRoutingConfig {
  groups?: AudienceGroupsConfig
  mode: RoutingMode
  rules: RoutingRule[]
  autoFocus: { enabled: boolean; enterAt: number; exitBelow: number; holdMs: number }
  scoreWeights: {
    fansClubLevel: number
    payLevel: number
    purchaseCount: number
    behavior?: AudienceBehaviorWeights
  }
}
export interface RoutingContext {
  trace?: AudienceTrace
  event: RoutingEvent
  user: {
    id?: string
    name?: string
    score?: number
    sessionScore?: number
    engagementScore?: number
    sessionEngagementScore?: number
    /** Hypothetical known event counters for side-effect-free simulation. */
    behaviorCounts?: AudienceBehaviorCounts
    fansClubLevel?: number
    payLevel?: number
    purchaseCount?: number
    isFirstSeen?: boolean
  }
  room: { onlineCount?: number; updatedAt?: number }
}
export interface RoutingDecision {
  group?: GroupDecisionContext
  voice: boolean
  text: boolean
  reason: string
  mode: RoutingMode
  ruleId?: string
  guidance?: string
}

/** Availability describes fields consumed by current adapters, not platform-wide promises. */
export const INTERACTION_ROUTING_CAPABILITIES = {
  tiktok: {
    events: ['viewer.enter', 'viewer.comment'],
    fansClubLevel: 'known-positive-on-entry',
    payLevel: 'known-positive-on-entry',
    purchaseCount: 'unknown',
    onlineCount: 'unknown',
  },
  xiaohongshu: {
    events: ['viewer.enter', 'viewer.comment'],
    fansClubLevel: 'unknown',
    payLevel: 'unknown',
    purchaseCount: 'unknown',
    onlineCount: 'unknown',
  },
  douyin: {
    events: ['viewer.enter', 'viewer.comment'],
    fansClubLevel: 'unknown',
    payLevel: 'unknown',
    purchaseCount: 'unknown',
    onlineCount: 'unknown',
    commentIdentity: 'may-be-missing',
  },
} as const

export function defaultInteractionRoutingConfig(): InteractionRoutingConfig {
  return {
    mode: 'focus',
    autoFocus: { enabled: false, enterAt: 50, exitBelow: 40, holdMs: 30000 },
    scoreWeights: { fansClubLevel: 10, payLevel: 1, purchaseCount: 20 },
    rules: [
      {
        id: 'known-levels',
        name: '粉丝团 6 级或消费等级 30 级',
        enabled: true,
        priority: 100,
        events: ['viewer.enter', 'viewer.comment'],
        all: [],
        any: [
          { field: 'user.fansClubLevel', op: 'gte', value: 6 },
          { field: 'user.payLevel', op: 'gte', value: 30 },
        ],
        voice: true,
        text: false,
      },
      {
        id: 'confirmed-new-viewer',
        name: '新观众且确认无购买（需要可信购买资料）',
        enabled: false,
        priority: 50,
        events: ['viewer.enter'],
        all: [
          { field: 'user.isFirstSeen', op: 'eq', value: true },
          { field: 'user.purchaseCount', op: 'eq', value: 0 },
        ],
        voice: true,
        text: false,
      },
    ],
  }
}

const modes = new Set<unknown>(['focus', 'selective', 'all'])
const fields = new Set<unknown>([
  'user.id',
  'user.score',
  'user.sessionScore',
  'user.engagementScore',
  'user.sessionEngagementScore',
  'user.fansClubLevel',
  'user.payLevel',
  'user.purchaseCount',
  'user.isFirstSeen',
  'room.onlineCount',
])
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const validUserId = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= 200 &&
  !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const signedField = (field: RoutingField) =>
  field === 'user.engagementScore' || field === 'user.sessionEngagementScore'
function conditionValid(value: RoutingCondition) {
  if (!value || !fields.has(value.field) || !['eq', 'gte', 'lte', 'exists'].includes(value.op))
    return false
  if (value.op === 'exists') return typeof value.value === 'boolean'
  if (value.field === 'user.id') return value.op === 'eq' && validUserId(value.value)
  if (signedField(value.field)) return finiteScore(value.value)
  if (value.field === 'user.isFirstSeen')
    return value.op === 'eq' && typeof value.value === 'boolean'
  return nonnegative(value.value)
}

export function validateInteractionRoutingConfig(config: InteractionRoutingConfig): void {
  if (
    !config ||
    !modes.has(config.mode) ||
    !Array.isArray(config.rules) ||
    config.rules.length > 100
  )
    throw new Error('互动模式或规则数量无效')
  const auto = config.autoFocus
  const weights = config.scoreWeights
  if (
    !auto ||
    typeof auto.enabled !== 'boolean' ||
    !nonnegative(auto.enterAt) ||
    !nonnegative(auto.exitBelow) ||
    auto.exitBelow >= auto.enterAt ||
    auto.enterAt > 10000000 ||
    !nonnegative(auto.holdMs) ||
    auto.holdMs > 3600000
  )
    throw new Error('自动专注阈值或恢复等待无效')
  if (
    !weights ||
    ![weights.fansClubLevel, weights.payLevel, weights.purchaseCount].every(
      v => nonnegative(v) && v <= 100000,
    )
  )
    throw new Error('互动分数权重无效')
  validateBehaviorWeights(weights.behavior)
  const ids = new Set<string>()
  for (const rule of config.rules) {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) ||
      ids.has(rule.id) ||
      typeof rule.name !== 'string' ||
      !rule.name.trim() ||
      rule.name.length > 120 ||
      typeof rule.enabled !== 'boolean' ||
      typeof rule.voice !== 'boolean' ||
      typeof rule.text !== 'boolean' ||
      (rule.guidance !== undefined &&
        (typeof rule.guidance !== 'string' || rule.guidance.length > 1000)) ||
      !Number.isFinite(rule.priority) ||
      Math.abs(rule.priority) > 1000000 ||
      !Array.isArray(rule.events) ||
      !rule.events.length ||
      rule.events.length > 2 ||
      !rule.events.every(e => e === 'viewer.enter' || e === 'viewer.comment') ||
      !Array.isArray(rule.all) ||
      rule.all.length > 20 ||
      !rule.all.every(conditionValid) ||
      (rule.any !== undefined &&
        (!Array.isArray(rule.any) || rule.any.length > 20 || !rule.any.every(conditionValid)))
    )
      throw new Error('互动规则字段、条件或编号无效')
    ids.add(rule.id)
  }
}

function matches(condition: RoutingCondition, context: RoutingContext) {
  let value: unknown
  switch (condition.field) {
    case 'user.id':
      value = context.user.id
      break
    case 'user.engagementScore':
      value = context.user.engagementScore
      break
    case 'user.sessionEngagementScore':
      value = context.user.sessionEngagementScore
      break
    case 'room.onlineCount':
      value = context.room.onlineCount
      break
    case 'user.score':
      value = context.user.score
      break
    case 'user.sessionScore':
      value = context.user.sessionScore
      break
    case 'user.fansClubLevel':
      value = context.user.fansClubLevel
      break
    case 'user.payLevel':
      value = context.user.payLevel
      break
    case 'user.purchaseCount':
      value = context.user.purchaseCount
      break
    case 'user.isFirstSeen':
      value = context.user.isFirstSeen
      break
  }
  const known =
    condition.field === 'user.id'
      ? validUserId(value)
      : signedField(condition.field)
        ? finiteScore(value)
        : condition.field === 'user.isFirstSeen'
          ? typeof value === 'boolean'
          : nonnegative(value)
  if (condition.op === 'exists') return known === condition.value
  if (!known) return false
  if (condition.op === 'eq') return value === condition.value
  if (typeof value !== 'number' || typeof condition.value !== 'number') return false
  return condition.op === 'gte' ? value >= condition.value : value <= condition.value
}

/** Pure eligibility only: quotas, public-send permission and safe playback remain separate gates. */
export function evaluateInteractionRouting(
  config: InteractionRoutingConfig,
  context: RoutingContext,
  effectiveMode: RoutingMode = config.mode,
): RoutingDecision {
  validateInteractionRoutingConfig(config)
  if (
    !context ||
    !['viewer.enter', 'viewer.comment'].includes(context.event) ||
    !context.user ||
    typeof context.user !== 'object' ||
    Array.isArray(context.user) ||
    !context.room ||
    typeof context.room !== 'object' ||
    Array.isArray(context.room)
  )
    throw new Error('互动模拟事件或观众上下文无效')
  if (!modes.has(effectiveMode)) throw new Error('互动有效模式无效')
  if (effectiveMode === 'focus')
    return {
      mode: effectiveMode,
      voice: false,
      text: context.event === 'viewer.comment',
      reason: '专注模式：保留原讲解，评论使用文字',
    }
  if (effectiveMode === 'all')
    return {
      mode: effectiveMode,
      voice: true,
      text: false,
      reason: '全员语音候选：仍需通过额度、去重和播放条件',
    }
  let derived = context
  if (!finiteScore(context.user.engagementScore)) {
    const engagementScore = scoreBehaviorCounts(
      context.user.behaviorCounts,
      config.scoreWeights.behavior,
    )
    if (engagementScore !== undefined)
      derived = { ...derived, user: { ...derived.user, engagementScore } }
  }
  let scoreReason = ''
  if (!nonnegative(context.user.score)) {
    const attrs = ['fansClubLevel', 'payLevel', 'purchaseCount'] as const
    const known = attrs.filter(key => nonnegative(context.user[key]))
    if (known.length) {
      const score = known.reduce(
        (sum, key) => sum + (context.user[key] as number) * config.scoreWeights[key],
        0,
      )
      derived = { ...derived, user: { ...derived.user, score } }
      scoreReason = `；当前已知属性${known.length < attrs.length ? '部分' : ''}分 ${score}，非长期积分`
    }
  }
  const rule = [...config.rules]
    .sort((a, b) => b.priority - a.priority)
    .find(
      rule =>
        rule.enabled &&
        rule.events.includes(context.event) &&
        rule.all.every(c => matches(c, derived)) &&
        (!rule.any?.length || rule.any.some(c => matches(c, derived))),
    )
  return rule
    ? {
        mode: effectiveMode,
        voice: rule.voice,
        text: rule.text,
        ruleId: rule.id,
        ...(rule.guidance === undefined ? {} : { guidance: rule.guidance }),
        reason: `命中规则：${rule.name}${scoreReason}`,
      }
    : {
        mode: effectiveMode,
        voice: false,
        text: context.event === 'viewer.comment',
        reason: `未命中语音规则，未知字段不视为零${scoreReason}`,
      }
}

/** Missing/stale counts revert to the configured manual mode; they never imply zero viewers. */
export class RoutingModeController {
  private config: InteractionRoutingConfig
  private focused = false
  private lowSince?: number
  constructor(
    config: InteractionRoutingConfig,
    private now = Date.now,
  ) {
    validateInteractionRoutingConfig(config)
    this.config = structuredClone(config)
  }
  configure(config: InteractionRoutingConfig) {
    validateInteractionRoutingConfig(config)
    this.config = structuredClone(config)
    this.focused = false
    this.lowSince = undefined
  }
  current(): RoutingMode {
    return this.focused ? 'focus' : this.config.mode
  }
  update(room: RoutingContext['room']): RoutingMode {
    const now = this.now()
    const auto = this.config.autoFocus
    if (
      !auto.enabled ||
      !nonnegative(room.onlineCount) ||
      (room.updatedAt !== undefined &&
        (!nonnegative(room.updatedAt) || now - room.updatedAt > 30000 || room.updatedAt > now))
    ) {
      this.focused = false
      this.lowSince = undefined
      return this.config.mode
    }
    if (room.onlineCount >= auto.enterAt) {
      this.focused = true
      this.lowSince = undefined
    } else if (this.focused && room.onlineCount < auto.exitBelow) {
      this.lowSince ??= now
      if (now - this.lowSince >= auto.holdMs) {
        this.focused = false
        this.lowSince = undefined
      }
    } else this.lowSince = undefined
    return this.focused ? 'focus' : this.config.mode
  }
}
