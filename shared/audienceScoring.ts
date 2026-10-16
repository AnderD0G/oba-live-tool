/** Observable behaviors only. A like is one received event, not an inferred lifetime count. */
export const AUDIENCE_BEHAVIORS = [
  'enter',
  'comment',
  'follow',
  'like',
  'subscription',
  'fanclub',
  'repeatComment',
] as const
export type AudienceBehavior = (typeof AUDIENCE_BEHAVIORS)[number]
export type AudienceBehaviorWeights = Partial<Record<AudienceBehavior, number>>
export type AudienceBehaviorCounts = Partial<Record<AudienceBehavior, number>>
export interface AudienceScorePolicy {
  weights?: AudienceBehaviorWeights
  revision: number
}
export interface AudienceScoreFact {
  id: string
  at: number
  sessionId: string
  sourceEventId?: string
  sourceType: string
  behavior: AudienceBehavior | 'manualAdjustment'
  source: 'observation' | 'manual'
  reason?: string
  quantity: number
  weight: number
  delta: number
  revision: number
}
export interface AudienceScoreAdjustment {
  platform: string
  userId: string
  delta: number
  source: 'manual'
  reason: string
  adjustmentId: string
}
export function validateScoreAdjustment(value: unknown): asserts value is AudienceScoreAdjustment {
  const v = value as AudienceScoreAdjustment
  const id = (s: unknown) =>
    typeof s === 'string' &&
    !!s.trim() &&
    s.length <= 200 &&
    !Array.from(s).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !id(v.platform) ||
    !id(v.userId) ||
    !id(v.adjustmentId) ||
    v.source !== 'manual' ||
    !finiteScore(v.delta) ||
    Math.abs(v.delta) > 100000 ||
    typeof v.reason !== 'string' ||
    !v.reason.trim() ||
    v.reason.length > 500
  )
    throw new Error(
      '人工评分需要平台、稳定用户 ID、有符号增量（绝对值≤100000）、source=manual、原因（1～500字符）和幂等编号',
    )
}
export interface AudienceScoreHistory {
  total: number
  /** Recent facts, with a checkpoint for older contributions; full new facts also enter the timeline. */
  facts: AudienceScoreFact[]
  checkpointTotal: number
  checkpointFacts: number
}
export const finiteScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function validateBehaviorWeights(
  weights: unknown,
): asserts weights is AudienceBehaviorWeights | undefined {
  if (weights === undefined) return
  if (
    !weights ||
    typeof weights !== 'object' ||
    Array.isArray(weights) ||
    Object.entries(weights).some(
      ([key, value]) =>
        !AUDIENCE_BEHAVIORS.includes(key as AudienceBehavior) ||
        !finiteScore(value) ||
        Math.abs(value) > 100000,
    )
  )
    throw new Error('行为分权重必须是已支持行为的有限有符号数（绝对值不超过 100000）')
}

/** Simulation only: unknown counters stay unknown; supplied signed totals take precedence in routing. */
export function scoreBehaviorCounts(
  counts: AudienceBehaviorCounts | undefined,
  weights: AudienceBehaviorWeights | undefined,
): number | undefined {
  if (!counts || !weights || typeof counts !== 'object' || Array.isArray(counts)) return undefined
  let total: number | undefined
  for (const behavior of AUDIENCE_BEHAVIORS) {
    const count = counts[behavior]
    const weight = weights[behavior]
    if (finiteScore(count) && Number.isSafeInteger(count) && count >= 0 && finiteScore(weight))
      total = (total ?? 0) + count * weight
  }
  return finiteScore(total) ? total : undefined
}
