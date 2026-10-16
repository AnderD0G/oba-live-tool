import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AudienceOutcome, AudienceTrace } from '../../../shared/audienceEvents'
import type { AssistantAudienceTriage } from '../../../shared/assistantAudiencePolicy'
import type { AuditDraft } from '../../../shared/audit'
import type {
  AiGenerateTextAction,
  HookAction,
  HookCondition,
  HookEvent,
  HookRule,
  HookSettings,
  TikTokLevelStrategy,
} from '../../../shared/hooks'
import type { ObsEffectRule } from '../../../shared/obsEffect'
import { OBS_INSTANT_INPUTS } from '../../../shared/obsEffect'
import { isWelcomePresetId } from '../../../shared/obsWelcome'
import type { ObsEnterEffectService } from './ObsEnterEffectService'

interface HookLogger {
  info(...data: unknown[]): void
  error(...data: unknown[]): void
}

export interface HookRuntime {
  generateText(action: AiGenerateTextAction, prompt: string): Promise<string>
  sendMessage(accountId: string | undefined, text: string): Promise<void>
}

interface HookExecutionContext {
  /** Optional disposable execution scope; real hooks retain their existing behavior. */
  signal?: AbortSignal
  current?: () => boolean
  /** Main-process classification of this event against this account's current saved policy. */
  audiencePolicy?: Pick<AssistantAudienceTriage, 'matchedRuleId' | 'label' | 'tier' | 'policyRevision'>
  welcomePolicy?: { tier: 'gold' | 'silver' | 'neutral'; welcomePresetId?: string }
  welcomeCurrent?: () => boolean
  trace?: AudienceTrace
  accountId?: string
  preview?: boolean
  suppressPublicReplies?: boolean
  localEffectsOnly?: boolean
  suppressObsEffects?: boolean
}

export class HookEngine {
  private readonly lastRun = new Map<string, number>()
  private readonly completedGifts = new Map<string, number>()
  private lastGiftClock = 0
  constructor(
    private settings: HookSettings,
    private readonly obs: ObsEnterEffectService,
    private readonly logger: HookLogger = console,
    private readonly runtime?: HookRuntime,
    private readonly audit?: (entry: AuditDraft) => void,
    private readonly onEvent?: (trace: AudienceTrace, outcome: AudienceOutcome) => void,
  ) {
    this.settings = normalizeHookSettings(settings)
  }

  configure(settings: HookSettings) {
    validateHookSettings(settings)
    this.settings = normalizeHookSettings(settings)
  }

  getSettings() {
    return structuredClone(this.settings)
  }

  private record(entry: AuditDraft, context: HookExecutionContext) {
    this.audit?.(entry)
    if (!context.trace || entry.phase === 'event') return
    const kind =
      entry.phase === 'decision'
        ? 'hook.decision'
        : entry.actionType === 'platform.send-message' && entry.status === 'sent'
          ? 'text.sent'
          : entry.actionType === 'platform.send-message' && entry.status === 'failed'
            ? 'text.failed'
            : entry.actionType === 'ai.generate-text' && entry.status === 'done'
              ? 'reply.generated'
              : 'hook.action'
    try {
      this.onEvent?.(context.trace, {
        kind,
        ruleId: entry.ruleId,
        text: entry.content,
        preview: entry.preview,
        detail:
          entry.status === 'failed'
            ? 'hook action failed; see local hook diagnostics'
            : entry.detail,
        facts: {
          actionId: entry.actionId,
          actionType: entry.actionType,
          actionStatus: entry.status,
          hookRevision: entry.ruleRevision,
        },
      })
    } catch {
      this.logger.error('记录钩子观众事件失败')
    }
  }

  fromLiveMessage(message: LiveMessage): HookEvent | null {
    if (message.msg_type === 'tiktok_gift') {
      const unitCoins = message.gift_unit_coins
      const knownUnit = Number.isSafeInteger(unitCoins) && (unitCoins as number) > 0
      const totalCoins = knownUnit ? (unitCoins as number) * message.repeat_count : undefined
      const event: HookEvent = {
        id: message.msg_id,
        source: 'tiktok',
        type: 'viewer.gift',
        occurredAt: message.time,
        data: {
          user: {
            id: message.user_id,
            name: message.nick_name,
            uniqueId: message.unique_id,
            mention: message.mention_handle || '',
            screenName: message.mention_handle || message.nick_name,
          },
          room: { id: message.room_id },
          gift: {
            id: message.gift_id,
            name: message.gift_name,
            type: message.gift_type,
            count: message.repeat_count,
            repeatEnd: message.repeat_end,
            ...(message.group_id ? { groupId: message.group_id } : {}),
            ...(knownUnit ? { unitCoins } : {}),
            ...(Number.isSafeInteger(totalCoins) && (totalCoins as number) > 0
              ? { totalCoins }
              : {}),
          },
        },
      }
      return giftDeliveryKey(event) ? event : null
    }
    if (message.msg_type === 'xiaohongshu_follow') {
      return {
        id: message.msg_id,
        source: 'xiaohongshu',
        type: 'viewer.follow',
        occurredAt: message.time,
        data: {
          user: {
            id: message.user_id,
            name: message.nick_name,
            followStatus: message.follow_status,
          },
          room: { id: message.room_id },
        },
      }
    }
    if (message.msg_type === 'xiaohongshu_member') {
      return {
        id: message.msg_id,
        source: 'xiaohongshu',
        type: 'viewer.enter',
        occurredAt: message.time,
        data: {
          user: {
            id: message.user_id,
            name: message.nick_name,
            followStatus: message.follow_status,
            role: message.role,
          },
          room: { id: message.room_id },
        },
      }
    }
    if (message.msg_type === 'tiktok_follow' || message.msg_type === 'tiktok_like') {
      return {
        id: message.msg_id,
        source: 'tiktok',
        type: message.msg_type === 'tiktok_follow' ? 'viewer.follow' : 'viewer.like',
        occurredAt: message.time,
        data: {
          user: {
            id: message.user_id,
            name: message.nick_name,
            uniqueId: message.unique_id,
            mention: message.mention_handle || '',
            screenName: message.mention_handle || message.nick_name,
          },
          ...(message.msg_type === 'tiktok_like' ? { likeCount: message.like_count || 1 } : {}),
        },
      }
    }
    if (message.msg_type !== 'tiktok_member') return null
    return {
      id: message.msg_id,
      source: 'tiktok',
      type: 'viewer.enter',
      occurredAt: message.time,
      data: {
        user: {
          id: message.user_id,
          name: message.nick_name,
          uniqueId: message.unique_id,
          mention: message.mention_handle || '',
          screenName: message.mention_handle || message.nick_name,
          fansClubLevel: message.fans_club_level,
          giftLevel: message.pay_level,
          isSubscriber: message.is_subscriber,
          followStatus: message.follow_status,
        },
      },
    }
  }

  fromWebhook(eventName: string, payload: Record<string, unknown>): HookEvent {
    return {
      id: randomUUID(),
      source: 'webhook',
      type: 'webhook.received',
      occurredAt: Date.now(),
      data: { eventName, payload },
    }
  }

  async dispatch(event: HookEvent, context: HookExecutionContext = {}) {
    // audience is reserved local evidence. SDK/webhook input can never supply a policy match.
    const { audience: _audience, audiencePolicy: _policy, ...eventData } = event.data
    const identity = (eventData.user as { id?: unknown } | undefined)?.id
    const policy = event.source !== 'webhook' && context.accountId && typeof identity === 'string'
      && identity.trim() && identity.trim() !== '0' && identity.length <= 300
      && !/[\u0000-\u001f\u007f]/.test(identity) ? context.audiencePolicy : undefined
    event = { ...event, data: {
      ...eventData,
      ...(policy ? { audiencePolicy: policy, audience: {
        accountId: context.accountId,
        ...(policy.matchedRuleId ? { ruleId: policy.matchedRuleId, matchedRuleId: policy.matchedRuleId } : {}),
        label: policy.label, tier: policy.tier, policyRevision: policy.policyRevision,
      } } : {}),
    } }
    const user = event.data.user as { id?: string; name?: string } | undefined
    const base: AuditDraft = {
      traceId: context.trace?.traceId || event.id || randomUUID(),
      origin: 'hook',
      phase: 'event',
      status: 'received',
      accountId: context.accountId,
      platform: event.source,
      eventType: event.type,
      userId: user?.id,
      userName: user?.name,
      preview: context.preview,
    }
    this.record(base, context)
    if (event.type === 'viewer.gift' && !this.claimGift(event, context.accountId)) {
      this.record(
        {
          ...base,
          phase: 'decision',
          status: 'skipped',
          detail: '礼物身份或结束信息不完整，或同一礼物已经处理',
        },
        context,
      )
      return 0
    }
    const candidates = selectExclusiveRules(
      this.settings.rules.filter(rule => this.matches(rule, event)),
    )
    const matched = candidates.filter(rule => {
      if (this.withinCooldown(rule, event)) return true
      this.record(
        {
          ...base,
          phase: 'decision',
          status: 'skipped',
          ruleId: rule.id,
          ruleName: rule.name,
          detail: '该观众仍在规则冷却时间内',
        },
        context,
      )
      return false
    })
    if (!matched.length && !candidates.length)
      this.record(
        {
          ...base,
          phase: 'decision',
          status: 'skipped',
          detail: '没有匹配的已启用规则',
        },
        context,
      )
    await Promise.all(
      matched.map(rule => {
        const revision = createHash('sha256')
          .update(
            JSON.stringify({
              ...rule,
              actions: rule.actions.map(action => {
                if (action.type === 'ai.generate-text') {
                  const { apiKey: _key, ...safe } = action
                  return safe
                }
                return action
              }),
            }),
          )
          .digest('hex')
          .slice(0, 12)
        const ruleBase = { ...base, ruleId: rule.id, ruleName: rule.name, ruleRevision: revision }
        this.record(
          {
            ...ruleBase,
            phase: 'decision',
            status: 'matched',
            detail: `条件 ${rule.conditions.length} 项；动作 ${rule.actions.length} 项`,
          },
          context,
        )
        return this.executeRule(rule, event.data, context, ruleBase).then(results => {
          const failed = results.filter(result => result.status === 'rejected').length
          this.logger.info(
            `钩子“${rule.name}”已执行，事件 ${event.source}:${event.type}，失败动作 ${failed} 个`,
          )
        })
      }),
    )
    return matched.length
  }

  async preview(rule: HookRule) {
    validateHookSettings({
      webhookPort: 17890,
      migratedObsEffects: true,
      rules: [rule],
    })
    const previewEvent = {
      id: randomUUID(),
      source: rule.source,
      type: rule.eventType,
      occurredAt: Date.now(),
      data: createPreviewData(rule),
    } satisfies HookEvent
    const results = await this.executeRule(
      rule,
      previewEvent.data,
      { preview: true },
      {
        traceId: previewEvent.id,
        origin: 'hook',
        phase: 'decision',
        status: 'matched',
        platform: rule.source,
        eventType: rule.eventType,
        ruleId: rule.id,
        ruleName: rule.name,
        preview: true,
      },
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure) {
      throw failure.reason
    }
  }

  private executeRule(
    rule: HookRule,
    eventData: Record<string, unknown>,
    context: HookExecutionContext,
    auditBase: AuditDraft,
  ) {
    const actions = normalizeActions(rule.actions)
    const byId = new Map(actions.map(action => [requireActionId(action), action]))
    const promises = new Map<string, Promise<unknown>>()
    const outputs: Record<string, unknown> = {}
    const run = (action: HookAction): Promise<unknown> => {
      const actionId = requireActionId(action)
      const existing = promises.get(actionId)
      if (existing) return existing
      const promise = Promise.all(
        (action.dependsOn || []).map(id => {
          const dependency = byId.get(id)
          if (!dependency) throw new Error(`找不到依赖动作“${id}”`)
          return run(dependency)
        }),
      )
        .then(() =>
          context.suppressObsEffects && action.type.startsWith('obs.')
            ? {skipped:true,reason:'HANDLED_BY_EFFECT_GROUP'}
            : context.localEffectsOnly && !action.type.startsWith('obs.') && action.type !== 'delay'
            ? { skipped: true, reason: '助播本地特效模式，仅执行OBS动作' }
            : context.suppressPublicReplies && action.type === 'platform.send-message'
            ? { skipped: true, reason: '进房回复已交给统一互动规则，避免文字和语音重复招呼' }
            : this.executeAction(action, eventData, outputs, context, rule.name, auditBase.eventType),
        )
        .then(output => {
          outputs[actionId] = output
          const value = output as
            | { text?: string; skipped?: boolean; reason?: string; sourceName?: string; detail?: string }
            | undefined
          this.record(
            {
              ...auditBase,
              phase: 'action',
              status: value?.skipped
                ? 'skipped'
                : action.type === 'platform.send-message'
                  ? 'sent'
                  : 'done',
              actionId,
              actionType: action.type,
              content: value?.text?.slice(0, 500),
              detail:
                value?.reason ||
                value?.detail ||
                value?.sourceName ||
                (action.type === 'platform.send-message' ? '平台已确认发送' : undefined),
            },
            context,
          )
          return output
        })
        .catch(error => {
          this.record(
            {
              ...auditBase,
              phase: 'action',
              status: 'failed',
              actionId,
              actionType: action.type,
              detail: error instanceof Error ? error.message : String(error),
            },
            context,
          )
          this.logger.error(
            `钩子“${rule.name}”动作“${action.id}”失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          throw error
        })
      promises.set(actionId, promise)
      return promise
    }
    return Promise.allSettled(actions.map(run))
  }

  private async executeAction(
    action: HookAction,
    eventData: Record<string, unknown>,
    outputs: Record<string, unknown>,
    context: HookExecutionContext,
    ruleName: string,
    eventType?: string,
  ) {
    if (context.signal?.aborted || context.current && !context.current())
      throw new Error('Hook execution was cancelled')
    const templateData = { ...eventData, actions: outputs }
    switch (action.type) {
      case 'obs.show-source': {
        const effect: ObsEffectRule = {
          ...action.target,
          id: requireActionId(action),
          enabled: true,
          minFansLevel: 0,
        }
        await this.obs.executeEffect(
          effect,
          ruleName,
          action.text
            ? {
                inputName: action.text.inputName,
                text: renderHookTemplate(action.text.template, templateData),
              }
            : undefined,
        )
        return { sourceName: action.target.sourceName }
      }
      case 'obs.play-random-group':
        return this.obs.playRandomGroup(action.target, ruleName)
      case 'obs.set-text': {
        const text = renderHookTemplate(action.template, templateData)
        await this.obs.setText(action.inputName, text)
        return { text }
      }
      case 'obs.art-text': {
        if (eventType === 'viewer.enter' && action.inputName === OBS_INSTANT_INPUTS[0] && context.welcomeCurrent && !context.welcomeCurrent())
          return { skipped: true, reason: '欢迎已被较新的进场事件替代' }
        const text = renderHookTemplate(action.template, templateData).trim()
        if (!text) throw new Error('艺术字内容为空')
        const presetId = eventType === 'viewer.enter' && action.inputName === OBS_INSTANT_INPUTS[0]
          ? context.welcomePolicy?.welcomePresetId ?? (context.welcomePolicy ? (context.welcomePolicy.tier === 'gold' ? 'gold' : 'pearl') : action.presetId)
          : undefined
        const delivery = presetId
          ? await this.obs.showWelcomePreset(action, text, presetId)
          : await this.obs.showArtText(action, text)
        if (delivery?.state === 'superseded')
          return { text, skipped: true, reason: '即时艺术字已被同一来源的新事件替代' }
        if (delivery?.state === 'started')
          return {
            text,
            detail: `OBS 即时艺术字指令已接收${delivery.supersededPrevious ? '（替换同一来源的上一事件）' : ''}`,
          }
        return { text }
      }
      case 'ai.generate-text': {
        if (!this.runtime) throw new Error('AI 动作运行环境未配置')
        const prompt = renderHookTemplate(action.promptTemplate, templateData)
        const text = await this.runtime.generateText(action, prompt)
        return { text }
      }
      case 'platform.send-message': {
        if (action.requireMention && !readPath(eventData, 'user.mention'))
          return { skipped: true, reason: '没有可用的 TikTok @用户名' }
        const text = renderHookTemplate(action.template, templateData).trim()
        if (!text) throw new Error('发送到公屏的文字为空')
        if (context.preview) return { text, skipped: true }
        if (!this.runtime) throw new Error('公屏发送运行环境未配置')
        await this.runtime.sendMessage(context.accountId, text)
        return { text }
      }
      case 'delay':
        await delay(action.durationMs, undefined, { signal: context.signal })
        return { durationMs: action.durationMs }
    }
  }

  private matches(rule: HookRule, event: HookEvent) {
    return (
      rule.enabled &&
      rule.source === event.source &&
      rule.eventType === event.type &&
      validAudienceReference(rule) &&
      rule.conditions.every(condition => matchesCondition(condition, event.data, rule))
    )
  }

  private claimGift(event: HookEvent, accountId?: string): boolean {
    const key = giftDeliveryKey(event, accountId)
    if (!key) return false
    const now = Date.now()
    if (now < this.lastGiftClock) this.completedGifts.clear()
    this.lastGiftClock = now
    for (const [oldKey, receivedAt] of this.completedGifts) {
      if (now - receivedAt < 600_000) break
      this.completedGifts.delete(oldKey)
    }
    if (this.completedGifts.has(key)) return false
    // Reserve before awaiting actions, so simultaneous final packets cannot execute twice.
    this.completedGifts.set(key, now)
    if (this.completedGifts.size > 2000)
      this.completedGifts.delete(this.completedGifts.keys().next().value || '')
    return true
  }

  private withinCooldown(rule: HookRule, event: HookEvent) {
    const cooldownMs = rule.cooldownMs || 0
    if (!cooldownMs) return true
    const user = event.data.user as { id?: string; uniqueId?: string } | undefined
    const identity = user?.id || user?.uniqueId
    if (!identity) return true
    const key = `${rule.id}\u0000${identity}`
    const now = Date.now()
    if (now - (this.lastRun.get(key) || 0) < cooldownMs) return false
    this.lastRun.set(key, now)
    if (this.lastRun.size > 10000) this.lastRun.delete(this.lastRun.keys().next().value || '')
    return true
  }
}

export function renderHookTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(data, path)
    return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : ''
  })
}

function createPreviewData(rule: HookRule): Record<string, unknown> {
  if (rule.source === 'webhook') {
    return { eventName: 'test.event', payload: { amount: 199, orderId: 'TEST-001' } }
  }
  const data: Record<string, unknown> = {
    user: {
      id: 'test-user',
      name: '测试观众',
      screenName: '@测试观众',
      fansClubLevel: 5,
      giftLevel: 10,
      followStatus: 0,
      role: 0,
    },
    room: { id: 'test-room' },
  }
  if (rule.eventType === 'viewer.gift') {
    const count = Math.max(
      1,
      ...rule.conditions
        .filter(condition => ['gift.count', 'gift.totalCoins'].includes(condition.field))
        .map(condition => Number(condition.value)),
    )
    Object.assign(data.user as object, { mention: '@test.viewer', screenName: '@test.viewer' })
    data.gift = {
      id: '5655',
      name: 'Rose',
      type: 1,
      count,
      unitCoins: 1,
      totalCoins: count,
      repeatEnd: true,
      groupId: 'test-gift-group',
    }
  }
  return data
}

/** Action identity only; never deduplicate the separately persisted SDK evidence. */
function giftDeliveryKey(event: HookEvent, accountId = ''): string | undefined {
  if (event.source !== 'tiktok' || event.type !== 'viewer.gift') return undefined
  const user = event.data.user as { id?: unknown } | undefined
  const room = event.data.room as { id?: unknown } | undefined
  const gift = event.data.gift as
    | { id?: unknown; type?: unknown; count?: unknown; repeatEnd?: unknown; groupId?: unknown }
    | undefined
  const id = (value: unknown): value is string =>
    typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value)
  if (
    !id(user?.id) ||
    !id(room?.id) ||
    !id(gift?.id) ||
    !Number.isSafeInteger(gift?.count) ||
    (gift?.count as number) <= 0 ||
    typeof gift?.repeatEnd !== 'boolean'
  )
    return undefined
  if (gift.type === 1) {
    if (gift.repeatEnd !== true || !id(gift.groupId)) return undefined
    return JSON.stringify([accountId, room.id, user.id, gift.id, 'group', gift.groupId])
  }
  if ((gift.type === 2 || gift.type === 4) && id(event.id))
    return JSON.stringify([accountId, room.id, user.id, gift.id, 'event', event.id])
  return undefined
}

function selectExclusiveRules(rules: HookRule[]) {
  // Select a single coin tier before checking cooldown; never downgrade a cooling tier.
  let coinTier: HookRule | undefined
  let highestMinimum = 0
  for (const rule of rules) {
    if (rule.eventType !== 'viewer.gift') continue
    for (const condition of rule.conditions) {
      if (
        condition.field === 'gift.totalCoins' &&
        condition.operator === 'gte' &&
        Number.isSafeInteger(condition.value) &&
        (condition.value as number) > highestMinimum
      ) {
        highestMinimum = condition.value as number
        coinTier = rule
      }
    }
  }
  if (coinTier) return [coinTier]
  const selected: HookRule[] = []
  const groups = new Map<string, HookRule>()
  for (const rule of rules) {
    if (!rule.exclusiveGroup) {
      selected.push(rule)
      continue
    }
    const current = groups.get(rule.exclusiveGroup)
    if (!current || (rule.priority || 0) > (current.priority || 0)) {
      groups.set(rule.exclusiveGroup, rule)
    }
  }
  return [...selected, ...groups.values()]
}

function matchesCondition(condition: HookCondition, data: Record<string, unknown>, rule: HookRule) {
  const actual =
    condition.field === 'user.effectiveLevel'
      ? selectTikTokLevel(data, rule.levelStrategy || 'fan-club-first')
      : readPath(data, condition.field)
  if (
    condition.field === 'gift.totalCoins' &&
    (!Number.isSafeInteger(actual) || (actual as number) < 1)
  )
    return false
  if (condition.operator === 'eq') return actual === condition.value
  if (condition.operator === 'gte') {
    return (
      typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value
    )
  }
  return false
}

function validAudienceReference(rule: HookRule): boolean {
  const references = rule.conditions.filter(condition => ['audience.matchedRuleId', 'audience.ruleId'].includes(condition.field))
  const accounts = rule.conditions.filter(condition => condition.field === 'audience.accountId')
  const nonblankEquality = (condition: HookCondition) => condition.operator === 'eq'
    && typeof condition.value === 'string' && !!condition.value.trim()
  return references.every(nonblankEquality) && accounts.every(nonblankEquality)
    && (!references.length || accounts.length > 0)
}

function selectTikTokLevel(data: Record<string, unknown>, strategy: TikTokLevelStrategy) {
  const fansClubLevel = readNumericPath(data, 'user.fansClubLevel')
  const giftLevel = readNumericPath(data, 'user.giftLevel')
  switch (strategy) {
    case 'gift-first':
      return giftLevel > 0 ? giftLevel : fansClubLevel
    case 'highest':
      return Math.max(fansClubLevel, giftLevel)
    case 'fan-club-only':
      return fansClubLevel
    case 'gift-only':
      return giftLevel
    default:
      return fansClubLevel > 0 ? fansClubLevel : giftLevel
  }
}

function readNumericPath(data: Record<string, unknown>, path: string) {
  const value = readPath(data, path)
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

export function validateHookSettings(settings: HookSettings) {
  if (
    !Number.isInteger(settings.webhookPort) ||
    settings.webhookPort < 1024 ||
    settings.webhookPort > 65535
  ) {
    throw new Error('Webhook 端口必须是 1024 到 65535 之间的整数')
  }
  const ids = new Set<string>()
  for (const rule of settings.rules) {
    if (!rule.id || ids.has(rule.id)) throw new Error('钩子 ID 无效或重复')
    ids.add(rule.id)
    if (!rule.name.trim()) throw new Error('钩子名称不能为空')
    if (!validAudienceReference(rule))
      throw new Error(`钩子“${rule.name}”的观众规则须使用非空 ID 等值条件，并绑定非空 audience.accountId 等值条件`)
    if (rule.eventType === 'viewer.gift') {
      if (rule.source !== 'tiktok') throw new Error('送礼钩子目前只支持 TikTok LIVE')
      for (const condition of rule.conditions) {
        if (
          condition.field === 'gift.id' &&
          (condition.operator !== 'eq' ||
            typeof condition.value !== 'string' ||
            !/^[1-9]\d{0,24}$/.test(condition.value))
        )
          throw new Error('礼物 ID 必须是非零数字字符串')
        if (
          condition.field === 'gift.count' &&
          (condition.operator !== 'gte' ||
            !Number.isSafeInteger(condition.value) ||
            (condition.value as number) < 1)
        )
          throw new Error('最低礼物数量必须是大于或等于 1 的整数')
        if (
          condition.field === 'gift.totalCoins' &&
          (condition.operator !== 'gte' ||
            !Number.isSafeInteger(condition.value) ||
            (condition.value as number) < 1)
        )
          throw new Error('最低总金币数必须是大于或等于 1 的安全整数')
      }
    }
    if (
      rule.cooldownMs !== undefined &&
      (!Number.isInteger(rule.cooldownMs) || rule.cooldownMs < 0 || rule.cooldownMs > 86_400_000)
    )
      throw new Error(`钩子“${rule.name}”的冷却时间无效`)
    if (
      rule.levelStrategy &&
      !['fan-club-first', 'gift-first', 'highest', 'fan-club-only', 'gift-only'].includes(
        rule.levelStrategy,
      )
    ) {
      throw new Error(`钩子“${rule.name}”的等级选择规则无效`)
    }
    validateActions(rule)
  }
}

function validateActions(rule: HookRule) {
  if (!rule.actions.length) throw new Error(`钩子“${rule.name}”至少需要一个动作`)
  const actions = normalizeActions(rule.actions)
  const ids = new Set(actions.map(requireActionId))
  if (ids.size !== actions.length) throw new Error(`钩子“${rule.name}”的动作 ID 重复`)
  for (const action of actions) {
    if ((action.dependsOn || []).some(id => !ids.has(id) || id === action.id)) {
      throw new Error(`钩子“${rule.name}”包含无效的动作依赖`)
    }
    switch (action.type) {
      case 'obs.show-source':
        if (!action.target.sceneName.trim() || !action.target.sourceName.trim()) {
          throw new Error(`钩子“${rule.name}”请选择 OBS 场景和来源`)
        }
        validateActionDuration(rule, action.target.durationMs)
        break
      case 'obs.play-random-group':
        if (!action.target.sceneName.trim() || !action.target.groupName.trim()) {
          throw new Error(`钩子“${rule.name}”请选择 OBS 场景和素材组`)
        }
        validateActionDuration(rule, action.target.durationMs)
        break
      case 'obs.set-text':
        if (!action.inputName.trim() || !action.template.trim()) {
          throw new Error(`钩子“${rule.name}”的文字来源和模板不能为空`)
        }
        break
      case 'obs.art-text':
        if (
          !action.inputName.trim() ||
          !action.template.trim() ||
          !['rainbow', 'gold', 'arc', 'random'].includes(action.style) ||
          !Number.isInteger(action.holdMs) ||
          action.holdMs < 500 ||
          action.holdMs > 10_000 ||
          (action.delivery !== undefined && !['immediate', 'queued'].includes(action.delivery)) ||
          (action.presetId !== undefined && (!isWelcomePresetId(action.presetId) || rule.eventType !== 'viewer.enter' || action.inputName !== OBS_INSTANT_INPUTS[0])) ||
          (action.priority !== undefined &&
            (!Number.isInteger(action.priority) || action.priority < 0 || action.priority > 100))
        )
          throw new Error(`钩子“${rule.name}”的艺术字配置无效`)
        break
      case 'ai.generate-text':
        if (
          !action.provider.trim() ||
          !action.model.trim() ||
          !action.apiKey.trim() ||
          !action.promptTemplate.trim()
        ) {
          throw new Error(`钩子“${rule.name}”的 AI 配置不完整`)
        }
        break
      case 'platform.send-message':
        if (!action.template.trim()) throw new Error(`钩子“${rule.name}”的公屏文字不能为空`)
        break
      case 'delay':
        validateActionDuration(rule, action.durationMs)
        break
      default:
        throw new Error('暂不支持该钩子动作')
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(actions.map(action => [requireActionId(action), action]))
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`钩子“${rule.name}”的动作依赖存在循环`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn || []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}

function validateActionDuration(rule: HookRule, durationMs: number) {
  if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 600_000) {
    throw new Error(`钩子“${rule.name}”的动作时长无效`)
  }
}

export function normalizeHookSettings(settings: HookSettings): HookSettings {
  const normalized = structuredClone(settings)
  for (const rule of normalized.rules) rule.actions = normalizeActions(rule.actions)
  return normalized
}

function normalizeActions(actions: HookAction[]): Array<HookAction & { id: string }> {
  return actions.map((action, index) => ({
    ...action,
    id: action.id || `action-${index + 1}`,
    dependsOn: [...(action.dependsOn || [])],
  }))
}

function requireActionId(action: HookAction) {
  if (!action.id) throw new Error('钩子动作缺少 ID')
  return action.id
}
