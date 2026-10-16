import type { AnalysisScope, BusinessObservation } from '../../../../shared/analysisRoom'
import type { PublishedAttributeDictionary } from '../../../../shared/audienceAttributes'
import type {
  AudienceGroupsConfig,
  GroupEvaluation,
  GroupEvaluationInput,
} from '../../../../shared/audienceGroups'
import type {
  RoutingContext,
  RoutingDecision,
  RoutingMode,
} from '../../../../shared/interactionRouting'
import { mapObservation } from './AttributeMapper'
import { AttributeSnapshotCache } from './AttributeSnapshotCache'
import { evaluateAudienceGroups } from './AudienceGroupEvaluator'
import { buildGroupReplyContext } from './AudienceGroupReplyContext'
import type { AudienceGroupService } from './AudienceGroupService'

interface RuntimeOptions {
  groups: AudienceGroupService
  dictionary: (
    platform: LiveControlPlatform,
    source: AnalysisScope['source'],
  ) => PublishedAttributeDictionary | undefined
  scope: (accountId: string) => AnalysisScope | undefined
  capture: { observe(observation: BusinessObservation): void }
  cache?: AttributeSnapshotCache
  now?: () => number
  hooks?: (accountId: string) => GroupEvaluationInput['hooks']
  onError?: (code: 'MAPPING_FAILED' | 'CAPTURE_FAILED') => void
  onDecision?: (
    accountId: string,
    context: RoutingContext,
    evaluation: GroupEvaluation,
    observationId?: string,
    metadata?: { scope: AnalysisScope; revision: number; mappingVersion?: number },
  ) => void
}
export class AnalysisRoomRuntime {
  readonly cache: AttributeSnapshotCache
  constructor(private options: RuntimeOptions) {
    this.cache = options.cache ?? new AttributeSnapshotCache()
  }
  observeBusiness(observation: BusinessObservation): void {
    try {
      const scope = this.options.scope(observation.scope.accountId)
      if (
        scope?.platform === observation.scope.platform &&
        scope.source === observation.scope.source
      ) {
        const dictionary = this.options.dictionary(scope.platform, scope.source)
        if (dictionary) this.cache.observe(mapObservation(observation, dictionary))
      }
    } catch {
      this.error('MAPPING_FAILED')
    }
    try {
      this.options.capture.observe(observation)
    } catch {
      this.error('CAPTURE_FAILED')
    }
  }
  private error(code: 'MAPPING_FAILED' | 'CAPTURE_FAILED') {
    try {
      this.options.onError?.(code)
    } catch {}
  }
  groupInput(
    accountId: string,
    context: RoutingContext,
    effectiveMode: RoutingMode,
  ): GroupEvaluationInput | undefined {
    const scope = this.options.scope(accountId)
    if (!scope) return undefined
    const dictionaryVersion = this.options.dictionary(scope.platform, scope.source)?.version
    const attributes =
      context.user.id && dictionaryVersion !== undefined
        ? this.cache.snapshot(
            scope,
            context.user.id,
            dictionaryVersion,
            (this.options.now ?? Date.now)(),
          )
        : undefined
    return {
      scope,
      event: context.event,
      context,
      effectiveMode,
      ...(context.user.id ? { userId: context.user.id } : {}),
      ...(dictionaryVersion === undefined ? {} : { dictionaryVersion }),
      ...(attributes ? { attributes } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks(accountId) } : {}),
    }
  }
  decide(
    accountId: string,
    context: RoutingContext,
    legacy: RoutingDecision,
    config: AudienceGroupsConfig,
    audit = false,
  ): RoutingDecision {
    if (!config.enabled) return legacy
    try {
      const input = this.groupInput(accountId, context, legacy.mode)
      if (!input) return legacy
      const evaluation = evaluateAudienceGroups(config, input)
      if (audit)
        this.options.onDecision?.(accountId, context, evaluation, input.attributes?.observationId, {
          scope: input.scope,
          revision: this.options.groups.read(accountId).revision,
          mappingVersion: input.dictionaryVersion,
        })
      const winner = evaluation.winner
      if (!winner) return legacy
      const attributes: NonNullable<RoutingDecision['group']>['attributes'] = {}
      for (const condition of [...winner.all, ...(winner.any ?? [])]) {
        if (condition.field.kind !== 'attribute') continue
        const fact = input.attributes?.values[condition.field.id]
        if (fact?.status === 'known') attributes[condition.field.id] = fact.value
      }
      const group = {
        groupId: winner.id,
        mappingVersion: input.dictionaryVersion,
        observationId: input.attributes?.observationId,
        channel: winner.strategy.channel,
        guidance: winner.strategy.guidance,
        template: winner.strategy.template,
        includeNickname: winner.strategy.includeNickname,
        attributes,
      }
      const voice = legacy.mode !== 'focus' && winner.strategy.channel === 'voice-preferred'
      const text = legacy.mode === 'focus' ? context.event === 'viewer.comment' : !voice
      const decision: RoutingDecision = {
        mode: legacy.mode,
        voice,
        text,
        reason: `group:${winner.id}`,
        ruleId: winner.id,
        guidance: winner.strategy.guidance,
        group,
      }
      const safe = buildGroupReplyContext(decision, context.user.name)
      if (safe) group.attributes = safe.attributes
      return decision
    } catch {
      this.error('MAPPING_FAILED')
      return legacy
    }
  }
  disconnect(accountId: string): void {
    this.cache.clearAccount(accountId)
    this.options.groups.clearAccount(accountId)
  }
  reserveReply(
    accountId: string,
    context: RoutingContext,
    decision: RoutingDecision,
  ): { accepted: boolean; reason: string } {
    if (!context.user.id || !decision.group)
      return { accepted: false, reason: 'GROUP_IDENTITY_UNKNOWN' }
    const result = this.options.groups.tryReserveGroupReply(
      accountId,
      context.user.id,
      decision.group.groupId,
      (this.options.now ?? Date.now)(),
    )
    return { accepted: result.accepted, reason: result.accepted ? '' : 'GROUP_COOLDOWN' }
  }
}
