import { createHash, randomUUID } from 'node:crypto'
import type { AudienceEventKind } from '../../../shared/audienceEvents'
import {
  type AudienceBehavior,
  type AudienceScoreAdjustment,
  type AudienceScoreFact,
  type AudienceScoreHistory,
  type AudienceScorePolicy,
  validateBehaviorWeights,
  validateScoreAdjustment,
} from '../../../shared/audienceScoring'
import type { RoutingContext } from '../../../shared/interactionRouting'

export interface AudienceObservation extends Omit<RoutingContext, 'event'> {
  event: AudienceEventKind
  scoreFacts?: AudienceScoreFact[]
}

export interface AudienceProfile {
  accountId: string
  platform: string
  userId: string
  name?: string
  firstSeen: number
  lastSeen: number
  entryCount: number
  commentCount: number
  fansClubLevel?: number
  payLevel?: number
  engagement?: AudienceScoreHistory
  manualAdjustments?: Record<string, AudienceScoreFact>
}
export interface AudienceInteractionData {
  profiles?: Record<string, AudienceProfile>
  recentEventIds?: Record<string, string[]>
}
interface AudienceStore {
  data: AudienceInteractionData
  change(fn: (data: AudienceInteractionData) => void): void
  flush?(): void
}
const eventTypes: Record<string, AudienceEventKind> = {
  tiktok_member: 'viewer.enter',
  xiaohongshu_member: 'viewer.enter',
  room_enter: 'viewer.enter',
  tiktok_comment: 'viewer.comment',
  xiaohongshu_comment: 'viewer.comment',
  comment: 'viewer.comment',
  wechat_channel_live_msg: 'viewer.comment',
  taobao_comment: 'viewer.comment',
  tiktok_follow: 'viewer.follow',
  xiaohongshu_follow: 'viewer.follow',
  room_follow: 'viewer.follow',
  tiktok_like: 'viewer.like',
  tiktok_gift: 'viewer.gift',
  room_like: 'viewer.like',
  subscribe_merchant_brand_vip: 'viewer.subscription',
  ecom_fansclub_participate: 'viewer.fanclub',
  live_order: 'order.observed',
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
const behaviors: Partial<Record<AudienceEventKind, AudienceBehavior>> = {
  'viewer.enter': 'enter',
  'viewer.comment': 'comment',
  'viewer.follow': 'follow',
  'viewer.like': 'like',
  'viewer.subscription': 'subscription',
  'viewer.fanclub': 'fanclub',
}

/** Minimal local first-observed profiles. Never infer lifetime identity/purchases from a nickname. */
export class AudienceInteractionService {
  private latest = new Map<string, RoutingContext>()
  private sessions = new Map<
    string,
    { id: string; score?: number; commentHash?: string; commentAt?: number }
  >()
  constructor(
    private store: AudienceStore,
    private now = Date.now,
  ) {}

  observe(accountId: string, platform: string, message: LiveMessage): RoutingContext | null {
    const kind = Object.hasOwn(eventTypes, message.msg_type)
      ? eventTypes[message.msg_type]
      : undefined
    if (kind !== 'viewer.enter' && kind !== 'viewer.comment') return null
    const result = this.receive(accountId, platform, message)
    return result ? { ...result, event: kind } : null
  }

  receive(
    accountId: string,
    platform: string,
    message: LiveMessage,
    policy?: AudienceScorePolicy,
  ): AudienceObservation | null {
    const event = Object.hasOwn(eventTypes, message.msg_type)
      ? eventTypes[message.msg_type]
      : undefined
    if (!accountId || !platform || !event) return null
    validateBehaviorWeights(policy?.weights)
    if (policy && (!Number.isSafeInteger(policy.revision) || policy.revision < 0))
      throw new Error('行为分配置版本无效')
    const raw = message as unknown as Record<string, unknown>
    const scope = JSON.stringify([accountId, platform])
    const eventId =
      typeof message.msg_id === 'string' && message.msg_id
        ? JSON.stringify([message.msg_type, message.msg_id])
        : undefined
    if (eventId && this.store.data.recentEventIds?.[scope]?.includes(eventId)) return null
    const id =
      typeof raw.user_id === 'string' && raw.user_id.trim() ? raw.user_id.trim() : undefined
    const name = typeof message.nick_name === 'string' ? message.nick_name : undefined
    const key = id ? JSON.stringify([accountId, platform, id]) : undefined
    const prior = key ? this.store.data.profiles?.[key] : undefined
    const now = this.now()
    const profile: AudienceProfile | undefined = id
      ? {
          accountId,
          platform,
          userId: id,
          name,
          firstSeen: prior?.firstSeen ?? now,
          lastSeen: now,
          entryCount: (prior?.entryCount ?? 0) + (event === 'viewer.enter' ? 1 : 0),
          commentCount: (prior?.commentCount ?? 0) + (event === 'viewer.comment' ? 1 : 0),
          // TikTok currently normalizes absent levels to zero. Only a positive level proves knowledge.
          fansClubLevel: positive(raw.fans_club_level) ? raw.fans_club_level : prior?.fansClubLevel,
          payLevel: positive(raw.pay_level) ? raw.pay_level : prior?.payLevel,
          ...(prior?.engagement ? { engagement: structuredClone(prior.engagement) } : {}),
          ...(prior?.manualAdjustments ? { manualAdjustments: prior.manualAdjustments } : {}),
        }
      : undefined
    const scoreFacts: AudienceScoreFact[] = []
    const session = key ? { ...(this.sessions.get(key) ?? { id: randomUUID() }) } : undefined
    if (profile && session) {
      const behavior = behaviors[event]
      const observed: AudienceBehavior[] = behavior ? [behavior] : []
      // Exact repetition only, never semantic classification or purchase inference from speech.
      if (event === 'viewer.comment' && typeof raw.content === 'string' && raw.content.trim()) {
        const hash = createHash('sha256').update(raw.content.trim()).digest('hex')
        if (
          session.commentHash === hash &&
          session.commentAt !== undefined &&
          now >= session.commentAt &&
          now - session.commentAt <= 60000
        )
          observed.push('repeatComment')
        session.commentHash = hash
        session.commentAt = now
      }
      for (const behavior of observed) {
        const weight = policy?.weights?.[behavior]
        if (weight === undefined || !policy) continue
        const fact: AudienceScoreFact = {
          id: randomUUID(),
          at: now,
          sessionId: session.id,
          sourceEventId: message.msg_id,
          sourceType: message.msg_type,
          behavior,
          source: 'observation',
          quantity: 1,
          weight,
          delta: weight,
          revision: policy.revision,
        }
        profile.engagement ??= { total: 0, facts: [], checkpointTotal: 0, checkpointFacts: 0 }
        const history = profile.engagement
        history.total += fact.delta
        history.facts.push(fact)
        while (history.facts.length > 100) {
          const oldest = history.facts.shift()
          if (!oldest) break
          history.checkpointTotal += oldest.delta
          history.checkpointFacts++
        }
        session.score = (session.score ?? 0) + fact.delta
        scoreFacts.push(fact)
      }
    }
    const online =
      typeof raw.online_count === 'number' &&
      Number.isFinite(raw.online_count) &&
      raw.online_count >= 0
        ? raw.online_count
        : undefined
    const context: AudienceObservation = {
      event,
      user: {
        id,
        name,
        ...(profile
          ? {
              fansClubLevel: profile.fansClubLevel,
              payLevel: profile.payLevel,
              isFirstSeen: !prior,
              ...(profile.engagement ? { engagementScore: profile.engagement.total } : {}),
              ...(session?.score === undefined ? {} : { sessionEngagementScore: session.score }),
            }
          : {}),
      },
      room: online === undefined ? {} : { onlineCount: online, updatedAt: now },
      ...(scoreFacts.length ? { scoreFacts } : {}),
    }
    this.store.change(data => {
      data.profiles ??= {}
      if (profile && key) data.profiles[key] = profile
      if (eventId) {
        data.recentEventIds ??= {}
        data.recentEventIds[scope] = [...(data.recentEventIds[scope] ?? []), eventId].slice(-2000)
      }
    })
    if (key) {
      if (session) this.sessions.set(key, session)
      this.latest.set(key, {
        ...context,
        event: event === 'viewer.enter' ? event : 'viewer.comment',
      })
      if (this.latest.size > 10000) this.latest.delete(this.latest.keys().next().value ?? '')
    }
    return structuredClone(context)
  }

  context(accountId: string, userId: string, platform?: string): RoutingContext | undefined {
    const profiles = Object.values(this.store.data.profiles ?? {}).filter(
      p =>
        p.accountId === accountId && p.userId === userId && (!platform || p.platform === platform),
    )
    if (profiles.length !== 1) return undefined
    const p = profiles[0]
    const key = JSON.stringify([p.accountId, p.platform, p.userId])
    const cached = this.latest.get(key)
    if (cached) return structuredClone(cached)
    return {
      event: 'viewer.comment',
      user: {
        id: p.userId,
        name: p.name,
        fansClubLevel: p.fansClubLevel,
        payLevel: p.payLevel,
        isFirstSeen: false,
        ...(p.engagement ? { engagementScore: p.engagement.total } : {}),
        ...(this.sessions.get(key)?.score === undefined
          ? {}
          : { sessionEngagementScore: this.sessions.get(key)?.score }),
      },
      room: {},
    }
  }

  scoreHistory(
    accountId: string,
    userId: string,
    platform?: string,
  ): AudienceScoreHistory | undefined {
    const profiles = Object.values(this.store.data.profiles ?? {}).filter(
      p =>
        p.accountId === accountId && p.userId === userId && (!platform || p.platform === platform),
    )
    return profiles.length === 1 && profiles[0].engagement
      ? structuredClone(profiles[0].engagement)
      : undefined
  }

  /** Authenticated operator instruction only; never call based on raw viewer text. */
  adjustScore(accountId: string, adjustment: AudienceScoreAdjustment, revision: number) {
    validateScoreAdjustment(adjustment)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('评分版本无效')
    const key = JSON.stringify([accountId, adjustment.platform, adjustment.userId])
    const prior = this.store.data.profiles?.[key]
    if (!prior) throw new Error('未找到该账号和平台的稳定用户，请先查询已观察身份')
    const adjustmentKey = JSON.stringify(adjustment.adjustmentId)
    const duplicate = prior.manualAdjustments?.[adjustmentKey]
    if (duplicate) {
      if (duplicate.delta !== adjustment.delta || duplicate.reason !== adjustment.reason)
        throw new Error('幂等编号已用于不同的评分事实')
      this.store.flush?.()
      if (!prior.engagement) throw new Error('人工评分事实缺少累计记录，请检查观众档案')
      return {
        applied: false,
        fact: structuredClone(duplicate),
        scoring: structuredClone(prior.engagement),
      }
    }
    const session = { ...(this.sessions.get(key) ?? { id: randomUUID() }) }
    const fact: AudienceScoreFact = {
      id: adjustment.adjustmentId,
      at: this.now(),
      sessionId: session.id,
      source: 'manual',
      sourceType: 'operator.score.adjustment',
      behavior: 'manualAdjustment',
      reason: adjustment.reason,
      quantity: 1,
      weight: adjustment.delta,
      delta: adjustment.delta,
      revision,
    }
    const profile = structuredClone(prior)
    profile.engagement ??= { total: 0, facts: [], checkpointTotal: 0, checkpointFacts: 0 }
    profile.engagement.total += fact.delta
    profile.engagement.facts.push(fact)
    while (profile.engagement.facts.length > 100) {
      const oldest = profile.engagement.facts.shift()
      if (!oldest) break
      profile.engagement.checkpointTotal += oldest.delta
      profile.engagement.checkpointFacts++
    }
    profile.manualAdjustments ??= {}
    profile.manualAdjustments[adjustmentKey] = fact
    this.store.change(data => {
      data.profiles ??= {}
      data.profiles[key] = profile
    })
    this.store.flush?.()
    session.score = (session.score ?? 0) + fact.delta
    this.sessions.set(key, session)
    this.latest.delete(key)
    return {
      applied: true,
      fact: structuredClone(fact),
      scoring: structuredClone(profile.engagement),
    }
  }

  resetSession(accountId: string) {
    for (const key of this.latest.keys())
      if (JSON.parse(key)[0] === accountId) this.latest.delete(key)
    for (const key of this.sessions.keys())
      if (JSON.parse(key)[0] === accountId) this.sessions.delete(key)
  }
}
