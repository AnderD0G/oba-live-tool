import {
  AnalysisError,
  type AnalysisParameters,
  analysisInteger,
  analysisString,
  assertBoundedJson,
  validateAnalysisScope,
} from '../../../../shared/analysisRoom'
import type { PublishedAttributeDictionary } from '../../../../shared/audienceAttributes'
import type {
  AudienceGroupsConfig,
  GroupCooldownResult,
  GroupEvaluationInput,
  GroupPreview,
  GroupState,
} from '../../../../shared/audienceGroups'
import type { InteractionRoutingConfig } from '../../../../shared/interactionRouting'
import type { AnalysisCaptureStore } from './AnalysisCaptureStore'
import { evaluateAudienceGroups, validateAudienceGroups } from './AudienceGroupEvaluator'
import { type PreviewBinding, PreviewProofStore, previewDigest } from './PreviewProofStore'

export interface GroupConfigurationRepository {
  read(accountId: string): { revision: number; config: InteractionRoutingConfig }
  all(): Record<string, { revision: number; config: InteractionRoutingConfig }>
  applyGroups(
    accountId: string,
    revision: number,
    groups: AudienceGroupsConfig,
  ):
    | { revision: number; config: InteractionRoutingConfig }
    | Promise<{ revision: number; config: InteractionRoutingConfig }>
  attachStore?(store: AnalysisCaptureStore): void
}
interface GroupOptions {
  store: AnalysisCaptureStore
  repository: GroupConfigurationRepository
  dictionary: (
    platform: LiveControlPlatform,
    source: 'control' | 'compass',
  ) => PublishedAttributeDictionary | undefined
  proofs?: PreviewProofStore
  hooks?: (accountId: string) => GroupEvaluationInput['hooks']
  effectiveMode?: (accountId: string) => GroupEvaluationInput['effectiveMode']
}
export class AudienceGroupService {
  private proofs: PreviewProofStore
  private cooldowns = new Map<string, number>()
  constructor(private options: GroupOptions) {
    this.proofs = options.proofs ?? new PreviewProofStore()
    options.repository.attachStore?.(options.store)
  }
  read(accountId: string): GroupState {
    analysisString(accountId, 200)
    const current = this.options.repository.read(accountId)
    return {
      revision: current.revision,
      config: structuredClone(current.config.groups ?? { enabled: false, items: [] }),
    }
  }
  private current(accountId: string, revision: number): GroupState {
    analysisInteger(revision)
    const current = this.read(accountId)
    if (current.revision !== revision)
      throw new AnalysisError('GROUP_REVISION_CONFLICT', '互动配置已变化，请重新读取')
    return current
  }
  private narrowDisable(accountId: string, config: AudienceGroupsConfig): boolean {
    const saved = this.read(accountId).config
    return !config.enabled && previewDigest(config) === previewDigest({ ...saved, enabled: false })
  }
  private validate(accountId: string, config: AudienceGroupsConfig): AudienceGroupsConfig {
    return validateAudienceGroups(config, {
      dictionary: this.options.dictionary,
      allowStale: this.narrowDisable(accountId, config),
    })
  }
  private versions(config: AudienceGroupsConfig, closing: boolean) {
    const scopes = new Map<string, number | null>()
    for (const group of config.items) {
      const key = `${group.platform}-${group.source}`
      try {
        scopes.set(key, this.options.dictionary(group.platform, group.source)?.version ?? null)
      } catch (error) {
        if (!closing) throw error
        scopes.set(key, null)
      }
    }
    return Object.fromEntries(
      [...scopes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
  }
  private binding(
    accountId: string,
    revision: number,
    config: AudienceGroupsConfig,
    inputDigest: string,
  ): PreviewBinding {
    return {
      kind: 'groups',
      accountId,
      revision,
      contentDigest: previewDigest(config),
      inputDigest,
      dictionaryVersions: this.versions(config, this.narrowDisable(accountId, config)),
    }
  }
  async simulate(input: AnalysisParameters['groups-simulate']): Promise<GroupPreview> {
    this.current(input.accountId, input.revision)
    assertBoundedJson(input.input)
    const scope = validateAnalysisScope(input.input.scope)
    if (
      scope.accountId !== input.accountId ||
      !['viewer.enter', 'viewer.comment'].includes(input.input.event) ||
      input.input.context.event !== input.input.event ||
      !['focus', 'selective', 'all'].includes(input.input.effectiveMode)
    )
      throw new AnalysisError('GROUP_INVALID', '模拟账号或事件范围不一致')
    if (input.input.userId !== undefined) analysisString(input.input.userId, 256)
    if (
      input.input.context.user.id !== undefined &&
      input.input.context.user.id !== input.input.userId
    )
      throw new AnalysisError('GROUP_INVALID', '模拟身份不一致')
    const config = this.validate(input.accountId, input.config)
    const closing = this.narrowDisable(input.accountId, config)
    let dictionaryVersion: number | undefined
    try {
      dictionaryVersion = this.options.dictionary(scope.platform, scope.source)?.version
    } catch (error) {
      if (!closing) throw error
    }
    if (
      input.input.dictionaryVersion !== undefined &&
      input.input.dictionaryVersion !== dictionaryVersion
    )
      throw new AnalysisError('GROUP_PREVIEW_STALE', '样本字典版本已变化，请重新模拟')
    const simulationContext: NonNullable<GroupPreview['simulationContext']> = {
      effectiveMode:
        this.options.effectiveMode?.(input.accountId) ??
        this.options.repository.read(input.accountId).config.mode,
      modeSource: this.options.effectiveMode ? 'current-runtime' : 'configured-manual',
      hooksSource: this.options.hooks ? 'current-runtime' : 'unavailable',
    }
    const sample: GroupEvaluationInput = {
      ...input.input,
      dictionaryVersion,
      effectiveMode: simulationContext.effectiveMode,
      hooks: this.options.hooks?.(input.accountId),
    }
    const evaluation = evaluateAudienceGroups(config, sample)
    return {
      ...this.proofs.issue(
        this.binding(input.accountId, input.revision, config, previewDigest(input.input)),
      ),
      revision: input.revision,
      simulationContext,
      evaluation,
      ...(dictionaryVersion === undefined ? {} : { dictionaryVersion }),
    }
  }
  async apply(input: AnalysisParameters['groups-apply']): Promise<GroupState> {
    return this.options.store.mutateConfiguration(async () => {
      this.current(input.accountId, input.revision)
      const config = this.validate(input.accountId, input.config)
      try {
        const binding = this.proofs.binding(input.previewToken)
        this.proofs.assertCurrent(
          input.previewToken,
          this.binding(input.accountId, input.revision, config, String(binding.inputDigest)),
        )
      } catch {
        throw new AnalysisError('GROUP_PREVIEW_STALE', '分组预览内容、字典或凭据已变化，请重新模拟')
      }
      await this.options.repository.applyGroups(input.accountId, input.revision, config)
      return this.read(input.accountId)
    })
  }
  enabledReferences(
    platform: LiveControlPlatform,
    source: 'control' | 'compass',
  ): { revision: string; accountIds: string[] } {
    const referenced = Object.entries(this.options.repository.all()).filter(([, saved]) =>
      saved.config.groups?.items.some(
        group => group.platform === platform && group.source === source,
      ),
    )
    referenced.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return {
      revision: previewDigest(
        referenced.map(([id, saved]) => [
          id,
          saved.revision,
          saved.config.groups?.enabled ?? false,
        ]),
      ),
      accountIds: referenced
        .filter(
          ([, saved]) =>
            saved.config.groups?.enabled &&
            saved.config.groups.items.some(
              group => group.enabled && group.platform === platform && group.source === source,
            ),
        )
        .map(([id]) => id),
    }
  }
  tryReserveGroupReply(
    accountId: string,
    userId: string,
    groupId: string,
    now: number,
  ): GroupCooldownResult {
    const config = this.read(accountId).config
    const group = config.items.find(group => group.id === groupId && group.enabled)
    if (!config.enabled || !group || !userId?.trim() || !Number.isFinite(now))
      return { accepted: false, nextAllowedAt: 0 }
    const key = JSON.stringify([accountId, userId, groupId])
    for (const [id, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(id)
    const next = this.cooldowns.get(key)
    if (next !== undefined) return { accepted: false, nextAllowedAt: next }
    // Do not evict an unexpired reservation to admit another viewer.
    if (this.cooldowns.size >= 10000) return { accepted: false, nextAllowedAt: now + 1000 }
    const nextAllowedAt = now + (group.cooldownMs ?? 60000)
    this.cooldowns.set(key, nextAllowedAt)
    return { accepted: true, nextAllowedAt }
  }
  clearAccount(accountId: string): void {
    for (const id of this.cooldowns.keys())
      if (JSON.parse(id)[0] === accountId) this.cooldowns.delete(id)
  }
}
