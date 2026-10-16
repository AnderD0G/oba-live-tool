import { createHash, randomUUID } from 'node:crypto'
import type { AssistantAudiencePolicy, AssistantAudienceTriage } from '../../../../shared/assistantAudiencePolicy'
import {
  applyEffectGroupsPatch, canonicalEffectGroupJson, EFFECT_ACTION_KINDS, EFFECT_PLACEMENTS, EFFECT_SLOTS,
  EffectGroupError, effectGroupId, effectGroupInteger, effectGroupObject, effectGroupString,
  type EffectActionKind, type EffectAsset, type EffectGroupCommand, type EffectGroupJob,
  type EffectGroupProofBinding, type EffectGroupResource, type EffectGroupsConfig, type EffectGroupSpec,
} from '../../../../shared/effectGroups'
import { EffectGroupScheduler, type EffectGroupEnqueueReceipt } from './EffectGroupScheduler'
import { EffectGroupStore } from './EffectGroupStore'

export interface EffectGroupPlayer {
  catalog(targetSceneName: string): Promise<EffectAsset[]>
  sync(group: EffectGroupSpec, label: string, previous?: EffectGroupResource,
    context?: { accountId: string; targetSceneName: string; generation?: number }): Promise<EffectGroupResource>
  retire(resource: EffectGroupResource): Promise<unknown>
  play(job: EffectGroupJob, resource: EffectGroupResource, signal: AbortSignal,
    onStarted: (detail?: Record<string, unknown>) => void | Promise<void>): Promise<void>
  recover(resources: EffectGroupResource[]): Promise<void>
  stop(): Promise<void>
}
export interface EffectGroupObservedEvent {
  accountId: string
  eventId: string
  actionKind: EffectActionKind
  userId: string
  displayName: string
  receivedAt: number
  sequence: number
  triage: Pick<AssistantAudienceTriage, 'policyRevision' | 'matchedRuleId'> & { facts?: Record<string, unknown> }
  facts?: Record<string, unknown>
  persisted: boolean
}
export interface EffectGroupServiceOptions {
  store: EffectGroupStore
  player: EffectGroupPlayer
  getAudiencePolicy: (accountId: string) => AssistantAudiencePolicy | Promise<AssistantAudiencePolicy>
  now?: () => number
  nextSequence?: () => number
  onError?: (error: unknown) => void
  resolveSample?: (accountId: string, reference: { rowId?: string; eventId?: string }) => Promise<EffectGroupObservedEvent>
}
const hash = (value: unknown) => createHash('sha256').update(canonicalEffectGroupJson(value)).digest('hex')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const PARAMS: Record<EffectGroupCommand['action'], string[]> = {
  get: ['accountId'], catalog: ['accountId', 'targetSceneName'],
  simulate: ['accountId', 'expectedRevision', 'patch', 'samples'],
  apply: ['accountId', 'expectedRevision', 'patch', 'proof', 'requestId'],
  sync: ['accountId', 'revision', 'requestId'], status: ['accountId', 'groupId'],
  preview: ['accountId', 'groupId', 'revision', 'viewer', 'requestId'],
}

/** One authority for rule references, proof-bound CAS, resource control, and physical playback admission. */
export class EffectGroupService {
  readonly scheduler: EffectGroupScheduler
  private readonly now: () => number
  private startWork?: Promise<void>
  private stopWork?: Promise<void>
  private stopping = false
  private controls = new Map<string, Promise<unknown>>()
  private controlCount = 0
  private syncWork = new Map<string, Promise<Record<string, unknown>>>()
  private retireWork = new Map<string, Promise<void>>()
  private admissions = new Map<string, EffectGroupJob>()
  private sequence = 0
  constructor(private readonly options: EffectGroupServiceOptions) {
    this.now = options.now ?? Date.now
    this.scheduler = new EffectGroupScheduler({ now: this.now,
      play: async (job, signal, onStarted) => {
        if (!job.resource) throw new EffectGroupError('RESOURCE_NOT_READY', 'Group resource is not ready')
        await options.player.play(job, job.resource, signal, onStarted)
      },
      onEvent: event => {
        options.store.appendRunEvent(event)
        if (['completed', 'failed', 'skipped', 'interrupted'].includes(event.status)) this.admissions.delete(event.runId)
      },
    })
    for (const accountId of options.store.accounts()) this.scheduler.configure(options.store.get(accountId))
  }
  private get store() { return this.options.store }
  private get player() { return this.options.player }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new EffectGroupError('EFFECT_GROUP_STOPPED', 'Effect group service is stopped'))
    if (this.startWork) return this.startWork
    const work = (async () => {
      const resources = this.store.listResources()
      if (resources.length) await this.player.recover(resources)
      for (const accountId of this.store.accounts()) {
        for (const event of this.store.listUnfinishedRuns(accountId)) {
          this.store.appendRunEvent({ ...event, at: this.now(), status: 'interrupted', reason: 'PROCESS_RESTART', detail: { previousStatus: event.status } })
        }
        this.scheduler.configure(this.store.get(accountId))
      }
      for (const resource of this.store.listResources()) {
        if (resource.state === 'retiring' && resource.ownedIdentities.length && resource.ownedIdentities.filter(identity => identity.kind !== 'filter').every(identity => identity.removed)) {
          this.store.removeResource(resource.accountId, resource.groupId, resource.generation)
        }
      }
    })()
    this.startWork = work
    void work.catch(() => { if (this.startWork === work) this.startWork = undefined })
    return work
  }
  private control<T>(accountId: string, work: () => Promise<T> | T): Promise<T> {
    if (this.stopping) return Promise.reject(new EffectGroupError('EFFECT_GROUP_STOPPED', 'Effect group service is stopped'))
    if (this.controlCount >= 32) return Promise.reject(new EffectGroupError('CONTROL_QUEUE_FULL', 'Effect group control queue is full'))
    this.controlCount++
    const task = (this.controls.get(accountId) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.stopping) throw new EffectGroupError('EFFECT_GROUP_STOPPED', 'Effect group service is stopped')
      return work()
    })
    this.controls.set(accountId, task)
    void task.finally(() => { this.controlCount--; if (this.controls.get(accountId) === task) this.controls.delete(accountId) }).catch(() => {})
    return task
  }
  async command(input: EffectGroupCommand): Promise<unknown> {
    const raw = effectGroupObject(input, ['action', 'params'], 'command')
    if (typeof raw.action !== 'string' || !Object.hasOwn(PARAMS, raw.action)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Unsupported effect group action')
    const action = raw.action as EffectGroupCommand['action'], params = effectGroupObject(raw.params, PARAMS[action], action)
    const accountId = effectGroupString(params.accountId, 'accountId')
    if (action === 'get') return { config: this.store.get(accountId), resources: this.store.listResources(accountId) }
    if (action === 'status') return this.status(accountId, params.groupId)
    if (action === 'catalog') return this.catalog(accountId, params.targetSceneName === undefined ? this.store.get(accountId).targetSceneName : effectGroupString(params.targetSceneName, 'targetSceneName', 256))
    if (action === 'simulate') return this.simulate(accountId, params)
    if (action === 'apply') return this.control(accountId, () => this.apply(accountId, params))
    if (action === 'sync') {
      const revision = effectGroupInteger(params.revision, 'revision'), requestId = effectGroupString(params.requestId, 'requestId')
      return this.sync(accountId, revision, requestId)
    }
    return this.control(accountId, () => this.preview(accountId, params))
  }
  private status(accountId: string, groupIdInput?: unknown) {
    const groupId = groupIdInput === undefined ? undefined : effectGroupString(groupIdInput, 'groupId')
    const scheduler = this.scheduler.status(accountId)
    return { accountId, revision: this.store.get(accountId).revision,
      resources: this.store.listResources(accountId, groupId), retirements: this.store.listRetirements(accountId).filter(item => !groupId || item.groupId === groupId),
      scheduler: { ...scheduler, queued: scheduler.queued.filter(job => !groupId || job.group.groupId === groupId), active: scheduler.active.filter(job => !groupId || job.group.groupId === groupId) },
      runs: this.store.listLatestRunEvents(accountId, { ...(groupId ? { groupId } : {}), limit: 100 }), controlPending: this.controlCount }
  }
  private async catalog(accountId: string, targetSceneName: string) {
    const policy = structuredClone(await this.options.getAudiencePolicy(accountId))
    const assets = await this.player.catalog(targetSceneName)
    const capabilities = { nestedScenes: true, animationCount: { min: 1, max: 3 }, durationMs: { min: 1000, max: 10000 }, mutedAnimations: true,
      preemptActive: false, synchronizedStart: 'requires-recording-verification', slots: [...EFFECT_SLOTS], placements: [...EFFECT_PLACEMENTS] }
    const revision = hash({ targetSceneName, assets, capabilities })
    return { accountId, targetSceneName, audienceRevision: policy.revision, policyEnabled: policy.enabled, revision,
      rules: [...policy.rules.map(rule => ({ ...rule, readOnly: false })), { id: '$fallback', label: '普通未匹配观众', enabled: policy.enabled, readOnly: true, meaning: 'Unmatched viewers; unknown levels remain unknown' }], assets, capabilities }
  }
  private async validateDesired(config: EffectGroupsConfig, policy: AssistantAudiencePolicy, assets: EffectAsset[]) {
    for (const group of config.groups) {
      const rule = policy.rules.find(item => item.id === group.audienceRuleId)
      if (group.audienceRuleId !== '$fallback' && !rule) throw new EffectGroupError('AUDIENCE_RULE_MISSING', 'Referenced audience rule does not exist')
      if (!config.enabled || !group.enabled) continue
      if (!policy.enabled || rule?.enabled === false) throw new EffectGroupError('AUDIENCE_RULE_DISABLED', 'The audience rule is paused')
      for (const animation of group.animations) {
        const asset = assets.find(item => item.id === animation.assetId)
        if (!asset?.available) throw new EffectGroupError('ASSET_UNAVAILABLE', `Animation asset ${animation.assetId} is unavailable`)
        if (!Number.isSafeInteger(asset.durationMs) || asset.durationMs < 1 || asset.durationMs > group.durationMs) throw new EffectGroupError('DURATION_TOO_SHORT', 'Configured duration would truncate the catalog asset')
      }
    }
  }
  private proofBinding(config: EffectGroupsConfig, expectedRevision: number, audienceRevision: number, catalogRevision: string): EffectGroupProofBinding {
    return { configHash: hash(config), expectedRevision, audienceRevision, catalogRevision, targetSceneName: config.targetSceneName }
  }
  private async samples(accountId: string, input: unknown) {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > 30) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'samples requires at most 30 items')
    const result: Record<string, unknown>[] = []
    for (const raw of input) {
      const sample = effectGroupObject(raw, ['fixture', 'userId', 'displayName', 'actionKind', 'matchedRuleId', 'rowId', 'eventId'], 'sample')
      if (sample.fixture === true) {
        effectGroupObject(raw, ['fixture', 'userId', 'displayName', 'actionKind', 'matchedRuleId'], 'sample fixture')
        effectGroupString(sample.userId, 'sample.userId'); effectGroupString(sample.displayName, 'sample.displayName', 256)
        if (!EFFECT_ACTION_KINDS.includes(sample.actionKind as EffectActionKind)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Unsupported sample actionKind')
        if (sample.matchedRuleId !== undefined) effectGroupString(sample.matchedRuleId, 'matchedRuleId')
        result.push({ ...sample })
      } else {
        effectGroupObject(raw, ['rowId', 'eventId'], 'sample reference')
        if (!this.options.resolveSample || (!sample.rowId && !sample.eventId)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'samples require explicit fixtures or resolvable original references')
        const reference = { ...(sample.rowId === undefined ? {} : { rowId: effectGroupString(sample.rowId, 'rowId') }), ...(sample.eventId === undefined ? {} : { eventId: effectGroupString(sample.eventId, 'eventId') }) }
        const observed = await this.options.resolveSample(accountId, reference)
        if (!observed.persisted || observed.accountId !== accountId) throw new EffectGroupError('ORIGINAL_NOT_PERSISTED', 'Sample does not refer to a persisted original in this account')
        result.push({ eventId: observed.eventId, actionKind: observed.actionKind, userId: observed.userId, displayName: observed.displayName, matchedRuleId: observed.triage.matchedRuleId })
      }
    }
    return result
  }
  private async simulate(accountId: string, params: Record<string, unknown>) {
    const expectedRevision = effectGroupInteger(params.expectedRevision, 'expectedRevision'), current = this.store.get(accountId)
    if (current.revision !== expectedRevision) throw new EffectGroupError('REVISION_CONFLICT', 'Effect groups revision changed')
    const config = applyEffectGroupsPatch(current, params.patch), samples = await this.samples(accountId, params.samples)
    const catalog = await this.catalog(accountId, config.targetSceneName), policy = await this.options.getAudiencePolicy(accountId)
    if (policy.revision !== catalog.audienceRevision) throw new EffectGroupError('AUDIENCE_REVISION_CHANGED', 'Audience policy changed during simulation')
    await this.validateDesired(config, policy, catalog.assets)
    const binding = this.proofBinding(config, expectedRevision, policy.revision, catalog.revision)
    const token = randomUUID(), expiresAt = this.now() + 15 * 60 * 1000
    this.store.saveProof({ ...binding, token, accountId, expiresAt })
    const existing = this.store.listResources(accountId)
    return { accountId, expectedRevision, config, proof: token, expiresAt, audienceRevision: policy.revision, catalogRevision: catalog.revision,
      resourcePlan: config.groups.map(group => ({ groupId: group.groupId, desired: config.enabled && group.enabled,
        action: existing.some(resource => resource.groupId === group.groupId && this.compatible(resource, group, config)) ? 'reuse' : 'prepare-generation' })),
      samples: samples.map(sample => ({ ...sample, groupId: config.groups.find(group => group.actionKind === sample.actionKind && group.audienceRuleId === (sample.matchedRuleId ?? '$fallback'))?.groupId,
        output: 'simulation-only' })) }
  }
  private async apply(accountId: string, params: Record<string, unknown>) {
    const expectedRevision = effectGroupInteger(params.expectedRevision, 'expectedRevision'), requestId = effectGroupString(params.requestId, 'requestId')
    effectGroupString(params.proof, 'proof')
    const contentHash = hash({ expectedRevision, patch: params.patch })
    const prior = this.store.getOperation(accountId, requestId)
    if (prior) {
      if (prior.kind !== 'apply' || prior.contentHash !== contentHash) throw new EffectGroupError('IDEMPOTENCY_CONFLICT', 'requestId content differs from the original apply')
      if (prior.response) return prior.response
      // A committed CAS is authoritative even if the process died before persisting its response.
      const desired = prior.detail?.config as EffectGroupsConfig | undefined
      const saved = desired && this.store.getSavedRequest(accountId, requestId, desired, expectedRevision)
      if (saved) {
        const response = { config: saved, revision: saved.revision, sync: { state: 'pending' } }
        this.store.saveOperation({ ...prior, state: 'completed', response })
        if (this.store.get(accountId).revision === saved.revision) { this.scheduler.configure(saved); this.backgroundSync(accountId, saved.revision) }
        return response
      }
    }
    const current = this.store.get(accountId)
    if (current.revision !== expectedRevision) throw new EffectGroupError('REVISION_CONFLICT', 'Effect groups revision changed')
    const desired = applyEffectGroupsPatch(current, params.patch)
    const catalog = await this.catalog(accountId, desired.targetSceneName), policy = await this.options.getAudiencePolicy(accountId)
    if (policy.revision !== catalog.audienceRevision) throw new EffectGroupError('INVALID_PROOF', 'Proof audience revision changed')
    await this.validateDesired(desired, policy, catalog.assets)
    const binding = this.proofBinding(desired, expectedRevision, policy.revision, catalog.revision)
    this.store.saveOperation({ accountId, requestId, kind: 'apply', contentHash, state: 'pending', detail: { config: desired } })
    const saved = this.store.save(accountId, expectedRevision, desired, requestId, { token: params.proof as string, binding, now: this.now() })
    this.configureChanged(current, saved)
    const response = { config: saved, revision: saved.revision, sync: { state: 'pending' } }
    this.store.saveOperation({ accountId, requestId, kind: 'apply', contentHash, state: 'completed', response })
    this.backgroundSync(accountId, saved.revision)
    return response
  }
  private configureChanged(previous: EffectGroupsConfig, next: EffectGroupsConfig) {
    for (const old of previous.groups) {
      const group = next.groups.find(item => item.groupId === old.groupId)
      const changed = !next.enabled || !group?.enabled || previous.targetSceneName !== next.targetSceneName || canonicalEffectGroupJson(group) !== canonicalEffectGroupJson(old)
      if (!changed) continue
      for (const resource of this.store.listResources(next.accountId, old.groupId)) if (resource.state !== 'retiring') this.store.saveResource({ ...resource, state: 'retiring' })
      // Mark retirement before configure so the new revision can release admission after resource readiness changes.
      const work = this.scheduler.retire(old.groupId)
      const key = `${next.accountId}/${old.groupId}`
      this.retireWork.set(key, work)
      void work.catch(error => this.options.onError?.(error))
    }
    this.scheduler.configure(next)
  }
  private backgroundSync(accountId: string, revision: number) {
    queueMicrotask(() => { if (!this.stopping) void this.sync(accountId, revision, `auto-${randomUUID()}`).catch(error => this.options.onError?.(error)) })
  }
  private compatible(resource: EffectGroupResource, group: EffectGroupSpec, config: EffectGroupsConfig) {
    return resource.state === 'ready' && resource.parentSceneName === config.targetSceneName && !!resource.snapshot
      && canonicalEffectGroupJson(resource.snapshot) === canonicalEffectGroupJson(group)
  }
  private async sync(accountId: string, revision: number, requestId: string): Promise<Record<string, unknown>> {
    const contentHash = hash({ revision }), prior = this.store.getOperation(accountId, requestId)
    if (prior) {
      if (prior.kind !== 'sync' || prior.contentHash !== contentHash) throw new EffectGroupError('IDEMPOTENCY_CONFLICT', 'requestId content differs from the original sync')
      if (prior.response && prior.state === 'completed') return prior.response
    }
    const key = `${accountId}/${revision}`
    const running = this.syncWork.get(key)
    if (running) {
      const response = await running
      this.store.saveOperation({ accountId, requestId, kind: 'sync', contentHash, state: 'completed', response })
      return response
    }
    const work = (async () => {
      await this.start()
      for (const [retireKey, promise] of this.retireWork) if (retireKey.startsWith(`${accountId}/`)) await promise
      return this.control(accountId, async () => {
        const config = this.store.get(accountId)
        if (config.revision !== revision) throw new EffectGroupError('REVISION_CONFLICT', 'Effect groups revision changed before resource sync')
        this.store.saveOperation({ accountId, requestId, kind: 'sync', contentHash, state: 'pending' })
        const policy = await this.options.getAudiencePolicy(accountId), desired = new Map(config.groups.filter(group => config.enabled && group.enabled && policy.enabled && (group.audienceRuleId === '$fallback' || policy.rules.some(rule => rule.id === group.audienceRuleId && rule.enabled))).map(group => [group.groupId, group]))
        const errors: { groupId: string; generation?: number; reason: string }[] = []
        for (const resource of this.store.listResources(accountId)) {
          const group = desired.get(resource.groupId)
          if (resource.state === 'conflict') { errors.push({ groupId: resource.groupId, generation: resource.generation, reason: resource.error ?? 'OWNERSHIP_CONFLICT' }); continue }
          if (group && this.compatible(resource, group, config)) continue
          const hasRetirement = this.store.listRetirements(accountId).some(item => item.groupId === resource.groupId && item.generation === resource.generation)
          if (group && !hasRetirement && ['pending', 'failed'].includes(resource.state) && resource.snapshot && canonicalEffectGroupJson(resource.snapshot) === canonicalEffectGroupJson(group) && resource.parentSceneName === config.targetSceneName) {
            if (resource.cleanupToken) {
              try {
                await this.player.recover([resource])
                const repaired = this.store.listResources(accountId, resource.groupId).find(item => item.generation === resource.generation)
                if (repaired?.state !== 'ready') throw new EffectGroupError('CLEANUP_FAILED', 'Resource recovery did not verify readiness')
                for (const blocker of this.scheduler.status().quarantinedSlots) if (blocker.groupId === resource.groupId && blocker.generation === resource.generation) this.scheduler.repair(resource.groupId, blocker.runId)
              } catch (error) { errors.push({ groupId: resource.groupId, generation: resource.generation, reason: message(error) }) }
            }
            continue
          }
          try {
            const blockers = this.scheduler.status().quarantinedSlots.filter(blocker => blocker.accountId === accountId && blocker.groupId === resource.groupId && blocker.generation === resource.generation)
            if (resource.state !== 'retiring') this.store.saveResource({ ...resource, state: 'retiring' })
            const retirement = this.retireWork.get(`${accountId}/${resource.groupId}`)
            if (retirement) await retirement; else await this.scheduler.retire(resource.groupId)
            await this.player.retire({ ...resource, state: 'retiring' })
            this.store.removeResource(accountId, resource.groupId, resource.generation)
            for (const blocker of blockers) this.scheduler.repair(resource.groupId, blocker.runId)
          } catch (error) { errors.push({ groupId: resource.groupId, generation: resource.generation, reason: message(error) }) }
        }
        for (const group of desired.values()) {
          if (errors.some(error => error.groupId === group.groupId)) continue
          const resources = this.store.listResources(accountId, group.groupId)
          const previous = resources.filter(resource => resource.state !== 'retiring').sort((a, b) => b.generation - a.generation)[0]
          try {
            const label = group.audienceRuleId === '$fallback' ? '普通未匹配观众' : policy.rules.find(rule => rule.id === group.audienceRuleId)!.label
            const resource = await this.player.sync(group, label, previous, { accountId, targetSceneName: config.targetSceneName, generation: this.store.nextGeneration(accountId, group.groupId) })
            this.store.saveResource(resource)
          } catch (error) { errors.push({ groupId: group.groupId, reason: message(error) }) }
        }
        this.scheduler.configure(config)
        const resources = this.store.listResources(accountId)
        const response = { accountId, revision, state: errors.length ? resources.some(resource => resource.state === 'ready') ? 'partial' : resources.some(resource => resource.state === 'conflict') ? 'conflict' : 'failed' : 'ready', resources, errors }
        this.store.saveOperation({ accountId, requestId, kind: 'sync', contentHash, state: 'completed', response })
        return response
      })
    })()
    this.syncWork.set(key, work)
    void work.finally(() => { if (this.syncWork.get(key) === work) this.syncWork.delete(key) }).catch(() => {})
    return work
  }
  private latestReady(accountId: string, group: EffectGroupSpec, config: EffectGroupsConfig) {
    return this.store.listResources(accountId, group.groupId).filter(resource => this.compatible(resource, group, config)).sort((a, b) => b.generation - a.generation)[0]
  }
  private admit(job: EffectGroupJob): EffectGroupEnqueueReceipt {
    this.store.appendRunEvent({ accountId: job.accountId, groupId: job.group.groupId, eventId: job.eventId, runId: job.runId, at: this.now(), status: 'queued', reason: 'ADMITTED',
      detail: { sequence: job.sequence, userId: job.userId, displayName: job.displayName, configRevision: job.configRevision, audienceRevision: job.audienceRevision,
        generation: job.generation, matchedRuleId: job.matchedRuleId, facts: job.facts ?? {}, preview: job.preview ?? false, group: job.group } })
    this.admissions.set(job.runId, job)
    return this.scheduler.enqueue(job)
  }
  private skipped(input: EffectGroupObservedEvent, group: EffectGroupSpec, reason: string, runId: string) {
    const receipt: EffectGroupEnqueueReceipt = { accepted: false, runId, status: 'skipped', reason }
    this.store.appendRunEvent({ runId, accountId: input.accountId, groupId: group.groupId, eventId: input.eventId, at: this.now(), status: 'skipped', reason,
      detail: { sequence: input.sequence, userId: input.userId, audienceRevision: input.triage.policyRevision, matchedRuleId: input.triage.matchedRuleId } })
    return { handled: true, receipt }
  }
  async dispatchObserved(input: EffectGroupObservedEvent): Promise<{ handled: boolean; receipt?: EffectGroupEnqueueReceipt }> {
    if (input.persisted !== true || this.stopping) return { handled: false }
    effectGroupString(input.accountId, 'accountId'); effectGroupString(input.eventId, 'eventId')
    effectGroupString(input.userId, 'userId'); effectGroupString(input.displayName, 'displayName', 256)
    effectGroupInteger(input.receivedAt, 'receivedAt'); effectGroupInteger(input.sequence, 'sequence')
    if (!EFFECT_ACTION_KINDS.includes(input.actionKind)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Unsupported observed action')
    const config = this.store.get(input.accountId)
    if (!config.enabled) return { handled: false }
    const configured = config.groups.filter(group => group.enabled && group.actionKind === input.actionKind)
    if (!configured.length) return { handled: false }
    const policy = await this.options.getAudiencePolicy(input.accountId)
    const ruleId = input.triage.matchedRuleId ?? '$fallback'
    const group = configured.find(candidate => candidate.audienceRuleId === ruleId)
    const runId = effectGroupId(input.accountId, `run-${hash([input.eventId, input.actionKind])}`, input.actionKind)
    if (this.store.hasRunEvent(input.accountId, runId) || this.admissions.has(runId)) return { handled: true, receipt: { accepted: false, runId, status: 'skipped', reason: 'DUPLICATE_EVENT' } }
    if (!policy.enabled) return this.skipped(input, group ?? configured[0], 'AUDIENCE_POLICY_DISABLED', runId)
    if (input.triage.policyRevision !== policy.revision) return this.skipped(input, group ?? configured[0], 'AUDIENCE_REVISION_CHANGED', runId)
    if (ruleId !== '$fallback' && !policy.rules.some(rule => rule.id === ruleId && rule.enabled)) return this.skipped(input, group ?? configured[0], 'AUDIENCE_RULE_DISABLED', runId)
    if (!group) return { handled: false }
    const resource = this.latestReady(input.accountId, group, config)
    if (!resource) return this.skipped(input, group, 'RESOURCE_NOT_READY', runId)
    await this.start()
    if (this.store.hasRunEvent(input.accountId, runId) || this.admissions.has(runId)) return { handled: true, receipt: { accepted: false, runId, status: 'skipped', reason: 'DUPLICATE_EVENT' } }
    this.scheduler.configure(config)
    this.sequence = Math.max(this.sequence, input.sequence)
    const job: EffectGroupJob = structuredClone({ runId, accountId: input.accountId, eventId: input.eventId, actionKind: input.actionKind,
      userId: input.userId, displayName: input.displayName, receivedAt: input.receivedAt, sequence: input.sequence, configRevision: config.revision,
      audienceRevision: policy.revision, matchedRuleId: input.triage.matchedRuleId, facts: input.facts ?? input.triage.facts ?? {}, group, resource, generation: resource.generation,
      ...(group.animations.some(animation => animation.placement === 'full-screen') ? { requiredSlots: [...EFFECT_SLOTS] } : {}) })
    return { handled: true, receipt: this.admit(job) }
  }
  private async preview(accountId: string, params: Record<string, unknown>) {
    const requestId = effectGroupString(params.requestId, 'requestId'), revision = effectGroupInteger(params.revision, 'revision'), groupId = effectGroupString(params.groupId, 'groupId')
    const viewer = effectGroupObject(params.viewer, ['userId', 'displayName', 'fixture'], 'preview.viewer')
    const userId = effectGroupString(viewer.userId, 'viewer.userId'), displayName = effectGroupString(viewer.displayName, 'viewer.displayName', 256)
    if (viewer.fixture !== undefined && viewer.fixture !== true) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Preview fixture flag must be explicit true')
    const contentHash = hash({ revision, groupId, viewer }), prior = this.store.getOperation(accountId, requestId)
    if (prior) {
      if (prior.kind !== 'preview' || prior.contentHash !== contentHash) throw new EffectGroupError('IDEMPOTENCY_CONFLICT', 'requestId content differs from the original preview')
      if (prior.response) return prior.response
      return { preview: true, runId: prior.detail?.runId, receipt: { accepted: false, status: 'skipped', reason: 'PREVIEW_INTERRUPTED' } }
    }
    const config = this.store.get(accountId)
    if (revision !== config.revision) throw new EffectGroupError('REVISION_CONFLICT', 'Effect groups revision changed')
    const group = config.groups.find(candidate => candidate.groupId === groupId)
    if (!config.enabled || !group?.enabled) throw new EffectGroupError('GROUP_DISABLED', 'The effect group is disabled')
    const resource = this.latestReady(accountId, group, config)
    if (!resource) throw new EffectGroupError('RESOURCE_NOT_READY', 'The effect group resource is not ready')
    await this.start()
    const runId = randomUUID(), eventId = `preview:${runId}`, sequence = this.options.nextSequence?.() ?? ++this.sequence
    const job: EffectGroupJob = { runId, accountId, eventId, actionKind: group.actionKind, userId, displayName, receivedAt: this.now(), sequence,
      configRevision: revision, group: structuredClone(group), generation: resource.generation, resource: structuredClone(resource), preview: true, facts: {},
      ...(group.animations.some(animation => animation.placement === 'full-screen') ? { requiredSlots: [...EFFECT_SLOTS] } : {}) }
    this.store.saveOperation({ accountId, requestId, kind: 'preview', contentHash, state: 'pending', detail: { runId } })
    const receipt = this.admit(job), response = { preview: true, runId, receipt }
    this.store.saveOperation({ accountId, requestId, kind: 'preview', contentHash, state: 'completed', response })
    return response
  }
  stop(reason = 'SERVICE_STOPPED'): Promise<void> {
    if (this.stopWork) return this.stopWork
    this.stopping = true
    const work = (async () => {
      const results = await Promise.allSettled([this.scheduler.stop(reason), this.player.stop(), ...this.controls.values(), ...this.syncWork.values()])
      if (results[1].status === 'fulfilled') {
        for (const blocker of this.scheduler.status().quarantinedSlots) {
          const resource = this.store.listResources(blocker.accountId, blocker.groupId).find(item => item.generation === blocker.generation)
          if (resource && ['ready', 'retiring'].includes(resource.state) && !resource.error && !resource.cleanupToken) this.scheduler.repair(blocker.groupId, blocker.runId)
        }
        if (!this.scheduler.status().quarantinedSlots.length) {
          await this.scheduler.stop(reason)
          if (results[0].status === 'rejected' && results[0].reason?.code === 'CLEANUP_FAILED') results[0] = { status: 'fulfilled', value: undefined }
        }
      }
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected' && result.reason?.code !== 'EFFECT_GROUP_STOPPED').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Effect group service cleanup failed')
    })()
    this.stopWork = work
    void work.catch(() => { if (this.stopWork === work) this.stopWork = undefined })
    return work
  }
}
