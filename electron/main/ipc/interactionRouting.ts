import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { emitter } from '#/event/eventBus'
import type {
  AudienceEventQuery,
  AudienceOutcome,
  AudienceTrace,
} from '../../../shared/audienceEvents'
import { AUDIENCE_EVENT_KINDS, AUDIENCE_FACT_KEYS } from '../../../shared/audienceEvents'
import { preserveSavedAudienceGroups } from '../../../shared/audienceGroups'
import { AUDIENCE_BEHAVIORS, validateScoreAdjustment } from '../../../shared/audienceScoring'
import {
  defaultInteractionRoutingConfig,
  evaluateInteractionRouting,
  INTERACTION_ROUTING_CAPABILITIES,
  type InteractionRoutingConfig,
  type RoutingContext,
  RoutingModeController,
  validateInteractionRoutingConfig,
} from '../../../shared/interactionRouting'
import { accountManager } from '../managers/AccountManager'
import { AudienceEventStore } from '../services/AudienceEventStore'
import {
  AudienceInteractionService,
  type AudienceObservation,
} from '../services/AudienceInteractionService'
import { AudienceTimeline } from '../services/AudienceTimeline'
import type { AnalysisRoomRuntime } from '../services/analysisRoom/AnalysisRoomRuntime'
import type { GroupConfigurationRepository } from '../services/analysisRoom/AudienceGroupService'
import { JsonLedger } from '../services/JsonLedger'
import { InteractionRoutingDatabase } from '../services/InteractionRoutingDatabase'
import { recordAudit } from './audit'

type Saved = { revision: number; config: InteractionRoutingConfig }
let routingDatabase: InteractionRoutingDatabase | undefined
let routingClosing = false
let analysisRuntime: AnalysisRoomRuntime | undefined
let checkAnalysisReady: (() => unknown) | undefined
let analysisReady = () => !!analysisRuntime
export function setAnalysisReadinessGate(check: () => unknown, ready: () => boolean): void {
  checkAnalysisReady = check
  analysisReady = ready
}
export function setAnalysisInteractionRuntime(value: AnalysisRoomRuntime | undefined): void {
  analysisRuntime = value
}
export function currentInteractionMode(accountId: string) {
  return controller(accountId).current()
}
export function groupInteractionCurrent(
  account: string,
  context: RoutingContext,
  decision: import('../../../shared/interactionRouting').RoutingDecision,
  revision: number,
): boolean {
  if (saved(account).revision !== revision || !decision.group) return false
  const fresh = decideInteraction(account, context)
  return (
    fresh.group?.groupId === decision.group.groupId &&
    fresh.group?.mappingVersion === decision.group.mappingVersion
  )
}
export function reserveInteractionGroupReply(
  account: string,
  context: RoutingContext,
  decision: import('../../../shared/interactionRouting').RoutingDecision,
  revision: number,
): { accepted: boolean; reason: string } {
  if (!groupInteractionCurrent(account, context, decision, revision))
    return { accepted: false, reason: 'GROUP_PREVIEW_STALE' }
  return (
    analysisRuntime?.reserveReply(account, context, decision) ?? {
      accepted: false,
      reason: 'GROUP_CHANNEL_UNAVAILABLE',
    }
  )
}
let audience: AudienceInteractionService
let eventStore: AudienceEventStore
let timeline: AudienceTimeline
const modes = new Map<string, RoutingModeController>()
const observations = new WeakMap<object, Map<string, AudienceObservation | null>>()
const recent = new Map<
  string,
  { at: number; user: string; event: string; voice: boolean; text: boolean; reason: string }[]
>()
let runtime: (account: string) => Record<string, unknown> = () => ({})
export function setInteractionRuntime(read: typeof runtime) {
  runtime = read
}
function stores() {
  if (routingClosing) throw new Error('互动配置存储正在关闭')
  if (!routingDatabase) {
    routingDatabase = new InteractionRoutingDatabase(
      join(app.getPath('userData'), 'interaction-routing.sqlite'),
    )
    app.on('before-quit', closeInteractionRoutingDatabase)
  }
}
function audienceStores() {
  stores()
  if (!audience) {
    eventStore = new AudienceEventStore(join(app.getPath('userData'), 'audience-events'))
    timeline = new AudienceTimeline(eventStore)
    const endSession = ({ accountId }: { accountId: string }) => {
      timeline.end(accountId)
      audience.resetSession(accountId)
    }
    emitter.on('comment-listener-stopped', endSession)
    emitter.on('page-closed', endSession)
    let quitting = false
    app.on('before-quit', event => {
      if (quitting) return
      timeline.end()
      if (eventStore.status.pending) {
        event.preventDefault()
        quitting = true
        void eventStore.flush().finally(() => app.quit())
      }
    })
    const profileLedger = new JsonLedger(
      join(app.getPath('userData'), 'interaction-audience.json'),
      { profiles: {}, recentEventIds: {} },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      try {
        profileLedger.change(() => {})
      } catch {
        console.error('观众资料暂存失败，请检查数据目录权限')
      }
    }
    audience = new AudienceInteractionService({
      get data() {
        return profileLedger.data
      },
      change(fn) {
        fn(profileLedger.data)
        timer ??= setTimeout(flush, 500)
        timer.unref()
      },
      flush() {
        if (timer) clearTimeout(timer)
        timer = undefined
        profileLedger.change(() => {})
      },
    })
    app.on('before-quit', () => {
      if (timer) flush()
    })
  }
}
function saved(account: string): Saved {
  if (
    typeof account !== 'string' ||
    !account.trim() ||
    account.length > 200 ||
    ['__proto__', 'constructor', 'prototype'].includes(account)
  )
    throw new Error('账号标识无效')
  stores()
  return routingDatabase!.read(account)
}
function commitInteractionConfig(account: string, next: Saved): void {
  stores()
  routingDatabase!.write(account, next.revision - 1, next.config)
}
/** Closing an unused configuration store never initializes Analysis or SQLite. */
export function closeInteractionRoutingDatabase(): void {
  routingClosing = true
  routingDatabase?.close()
  routingDatabase = undefined
}
function controller(account: string) {
  let value = modes.get(account)
  if (!value) {
    value = new RoutingModeController(saved(account).config)
    modes.set(account, value)
  }
  return value
}
export function observeInteraction(account: string, message: LiveMessage) {
  const context = observeAudience(account, message)
  return context && (context.event === 'viewer.enter' || context.event === 'viewer.comment')
    ? { ...context, event: context.event }
    : null
}
export function observeAudience(account: string, message: LiveMessage) {
  const known = observations.get(message)
  if (known?.has(account)) return known.get(account)!
  audienceStores()
  const platform =
    accountManager.accountSessions.get(account)?.getPlatformName() || message.msg_type.split('_')[0]
  const current = saved(account)
  const context = audience.receive(account, platform, message, {
    weights: current.config.scoreWeights.behavior,
    revision: current.revision,
  })
  if (context) {
    context.trace = timeline.receive(account, platform, message, context.event)
    for (const fact of context.scoreFacts ?? []) {
      timeline.record(context.trace, {
        kind: 'profile.changed',
        ruleRevision: fact.revision,
        detail: JSON.stringify({
          type: 'engagement.score',
          ...fact,
          total: context.user.engagementScore,
          sessionTotal: context.user.sessionEngagementScore,
        }),
      })
    }
  }
  const map = known || new Map()
  map.set(account, context)
  observations.set(message, map)
  return context
}
export function interactionContext(
  account: string,
  user: string,
  event: RoutingContext['event'] = 'viewer.comment',
): RoutingContext {
  audienceStores()
  const platform = accountManager.accountSessions.get(account)?.getPlatformName()
  const context = audience.context(account, user, platform)
  return context ? { ...context, event } : { event, user: {}, room: {} }
}
export function recordInteractionEvent(trace: AudienceTrace | undefined, outcome: AudienceOutcome) {
  audienceStores()
  timeline.record(trace, outcome)
}
export async function getInteractionTimeline(filter: AudienceEventQuery) {
  audienceStores()
  return {
    ...(await eventStore.query(filter)),
    storage: eventStore.status,
    sessionMeaning: 'local observation session, not platform broadcast ID',
  }
}
export function decideInteraction(account: string, context: RoutingContext, audit = false) {
  const current = saved(account)
  const legacy = evaluateInteractionRouting(
    current.config,
    context,
    controller(account).update(context.room),
  )
  const decision =
    current.config.groups?.enabled
      ? analysisRuntime && analysisReady()
        ? analysisRuntime.decide(account, context, legacy, current.config.groups, audit)
        : { ...legacy, voice: false, text: false, reason: 'analysis-unavailable' }
      : legacy
  if (audit) {
    recordInteractionEvent(context.trace, {
      kind: 'routing.decision',
      ruleId: decision.ruleId,
      ruleRevision: current.revision,
      detail: JSON.stringify({
        mode: decision.mode,
        reason: decision.reason,
        voice: decision.voice,
        text: decision.text,
        guidance: decision.guidance,
        group: decision.group,
        engagementScore: context.user.engagementScore,
        sessionEngagementScore: context.user.sessionEngagementScore,
      }),
    })
    const entry = {
      at: Date.now(),
      user: context.user.name || context.user.id || '身份未知',
      event: context.event,
      ...decision,
    }
    recent.set(account, [entry, ...(recent.get(account) || [])].slice(0, 20))
    recordAudit({
      traceId: context.trace?.traceId || randomUUID(),
      origin: 'hook',
      phase: 'decision',
      status: decision.voice || decision.text ? 'matched' : 'skipped',
      accountId: account,
      eventType: context.event,
      userId: context.user.id,
      userName: context.user.name,
      ruleRevision: String(current.revision),
      ruleId: decision.ruleId,
      detail: JSON.stringify({
        mode: decision.mode,
        reason: decision.reason,
        voice: decision.voice,
        text: decision.text,
        guidance: decision.guidance,
        group: decision.group,
        engagementScore: context.user.engagementScore,
        sessionEngagementScore: context.user.sessionEngagementScore,
      }),
    })
  }
  return decision
}
export function getInteractionRouting(account: string) {
  const current = saved(account)
  return {
    ...structuredClone(current),
    runtime: runtime(account),
    recent: recent.get(account) || [],
    capabilities: getInteractionCapabilities(),
  }
}
export function interactionRevision(account: string) {
  return saved(account).revision
}
export async function adjustInteractionScore(
  account: string,
  revision: number,
  adjustment: unknown,
) {
  const current = saved(account)
  if (!Number.isSafeInteger(revision) || revision !== current.revision)
    throw new Error('规则版本已变化，请重新读取后再记录评分')
  validateScoreAdjustment(adjustment)
  audienceStores()
  const result = audience.adjustScore(account, adjustment, revision)
  if (result.applied) {
    await eventStore.append({
      accountId: account,
      platform: adjustment.platform,
      userId: adjustment.userId,
      traceId: randomUUID(),
      sessionId: result.fact.sessionId,
      kind: 'profile.changed',
      ruleRevision: revision,
      detail: JSON.stringify({
        type: 'engagement.score',
        ...result.fact,
        total: result.scoring.total,
      }),
    })
    recordAudit({
      traceId: randomUUID(),
      origin: 'hook',
      phase: 'action',
      status: 'done',
      accountId: account,
      userId: adjustment.userId,
      actionType: 'interaction.score.adjust',
      ruleRevision: String(revision),
      detail: JSON.stringify(result.fact),
    })
  }
  return {
    ...result,
    revision,
    context: audience.context(account, adjustment.userId, adjustment.platform),
  }
}
export function applyInteractionRouting(account: string, revision: number, config: unknown) {
  const current = saved(account)
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    throw new Error('互动配置版本无效')
  if (revision !== current.revision) throw new Error('规则版本已变化，请重新读取后再保存')
  validateInteractionRoutingConfig(config as InteractionRoutingConfig)
  const next = preserveSavedAudienceGroups(current.config, config as InteractionRoutingConfig)
  commitInteractionConfig(account, {
    revision: revision + 1,
    config: next,
  })
  modes.delete(account)
  recordAudit({
    traceId: randomUUID(),
    origin: 'hook',
    phase: 'action',
    status: 'done',
    accountId: account,
    actionType: 'interaction.configure',
    ruleRevision: String(revision + 1),
    detail: `接话模式 ${(config as InteractionRoutingConfig).mode}`,
  })
  return getInteractionRouting(account)
}
export function interactionGroupRepository(): GroupConfigurationRepository {
  return {
    attachStore(store) {
      stores()
      // Configuration has its own SQLite capacity; Raw evidence budgets are independent.
      void store
    },
    read(accountId) {
      const current = saved(accountId)
      return structuredClone(current)
    },
    all() {
      stores()
      return routingDatabase!.all()
    },
    applyGroups(accountId, revision, groups) {
      checkAnalysisReady?.()
      const current = saved(accountId)
      if (revision !== current.revision) throw new Error('互动配置版本已变化')
      commitInteractionConfig(accountId, {
        revision: revision + 1,
        config: { ...current.config, groups: structuredClone(groups) },
      })
      modes.delete(accountId)
      recordAudit({
        traceId: randomUUID(),
        origin: 'hook',
        phase: 'action',
        status: 'done',
        accountId,
        actionType: 'interaction.groups.apply',
        ruleRevision: String(revision + 1),
        detail: `分组策略 ${groups.enabled ? '启用' : '关闭'}；${groups.items.length} 组`,
      })
      return structuredClone(saved(accountId))
    },
  }
}
export function simulateInteractionRouting(account: string, context: unknown, config?: unknown) {
  const value = config === undefined ? saved(account).config : (config as InteractionRoutingConfig)
  validateInteractionRoutingConfig(value)
  const c = context as RoutingContext
  if (!c || !['viewer.enter', 'viewer.comment'].includes(c.event) || !c.user || !c.room)
    throw new Error('模拟需要 event、user、room；缺失属性请省略，不能填零冒充已知')
  return {
    decision: evaluateInteractionRouting(value, c, new RoutingModeController(value).update(c.room)),
    preview: true,
    sideEffects: false,
  }
}
export function getInteractionAudience(account: string, user?: string, requestedPlatform?: string) {
  audienceStores()
  const platform =
    requestedPlatform || accountManager.accountSessions.get(account)?.getPlatformName()
  if (user)
    return {
      context: audience.context(account, user, platform) || null,
      scoring: audience.scoreHistory(account, user, platform) || null,
    }
  return {
    recent: recent.get(account) || [],
    note: '使用当前平台用户 ID 查询；近期决策不是完整历史或购买档案',
  }
}
export function getInteractionCapabilities() {
  stores()
  return {
    modes: ['focus', 'selective', 'all'],
    events: ['viewer.enter', 'viewer.comment'],
    scoring: {
      behaviors: AUDIENCE_BEHAVIORS,
      weights: 'scoreWeights.behavior (optional, signed, absolute maximum 100000)',
      semantics:
        'event-time deltas; configuration changes affect future observations only; no purchase inference',
      repeatComment:
        'consecutive identical trimmed comments by a stable user within 60000ms in the current local session',
      session: 'local observation session; reset on listener stop, page close or app restart',
      audit:
        'audience.scoring retains latest 100 facts and older checkpoint totals; timeline profile.changed stores new engagement.score facts subject to timeline retention',
      simulation:
        'user.behaviorCounts supplies hypothetical counters; explicit user.engagementScore takes precedence',
      manual:
        'interaction_adjust_score requires explicit operator instruction, stable observed account/platform/user, source=manual, signed delta, reason, unique adjustmentId and current config revision; no automatic malicious-text classification',
    },
    timeline: {
      eventKinds: AUDIENCE_EVENT_KINDS,
      factKeys: AUDIENCE_FACT_KEYS,
      note: '时间线类型不是自动回复触发器。关注、点赞、粉丝团/会员和订单提示仅记录真实已监听消息；当前没有礼物事件入口，订单缺买家 ID 不归属到昵称。',
    },
    platforms: INTERACTION_ROUTING_CAPABILITIES,
    fields: [
      {
        field: 'user.id',
        availability: '当前账号和平台稳定用户 ID；eq 精确匹配，可用高优先级规则覆盖',
      },
      {
        field: 'user.engagementScore',
        availability: '启用行为权重后的本地持久有符号积分，独立于惩罚分及属性分；无评分事实则未知',
      },
      {
        field: 'user.sessionEngagementScore',
        availability: '当前本地观察会话内已计分行为之和；新会话无事实则未知',
      },
      {
        field: 'user.fansClubLevel',
        availability: 'TikTok 进房事件的已知粉丝团等级；其他来源或缺字段为未知',
      },
      {
        field: 'user.payLevel',
        availability: 'TikTok 进房事件的已知送礼等级；其他来源或缺字段为未知',
      },
      {
        field: 'user.isFirstSeen',
        availability: '有稳定平台用户 ID 时，本工具首次观察，不代表平台首次到访',
      },
      {
        field: 'user.score',
        availability: '按已知属性和 scoreWeights 推导的当前分，非历史消费价值分',
      },
      {
        field: 'user.sessionScore',
        availability: '尚无真实数据源，仅保留模拟扩展；不可依赖上线筛选',
      },
      { field: 'user.purchaseCount', availability: '当前无可靠买家归属数据源，未知，不等于零次' },
      {
        field: 'room.onlineCount',
        availability: '当前评论事件未提供可靠实时人数，自动人数切换暂不可依赖',
      },
    ],
    accounts: [
      ...new Set([...accountManager.accountNames.keys(), ...routingDatabase!.accountIds()]),
    ].map(id => ({
      id,
      name: accountManager.getAccountName(id),
      platform: accountManager.accountSessions.get(id)?.getPlatformName(),
      ...runtime(id),
    })),
    constraints: [
      '默认一次决策选择文字或语音；显式规则允许两者',
      '公开文字和语音总开关仍需在应用开启，规则不会自行开播',
      '独立语音直接在当前 OBS 场景播放，不需要气口；导播语音才需批准的气口。两者均受生成队列、过期、每人额度和闲聊限制',
      '缺失值不等于 0；不得虚构购买记录和在线人数',
      '修改配置不打断正在说完的一句；待播回复随规则版本失效',
      'selective 首条命中规则返回可选 guidance（最多 1000 字符）；focus/all 不应用规则指导',
    ],
  }
}
