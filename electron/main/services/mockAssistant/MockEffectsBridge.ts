import type { AssistantAudiencePolicy } from '../../../../shared/assistantAudiencePolicy'
import type { AssistantDeskRow } from '../../../../shared/assistantDesk'
import type {
  EffectActionKind,
  EffectGroupResource,
  EffectGroupsConfig,
} from '../../../../shared/effectGroups'
import type { HookSettings } from '../../../../shared/hooks'
import type { ObsEnterEffectSettings } from '../../../../shared/obsEffect'
import { EffectGroupService } from '../effectGroups/EffectGroupService'
import { EffectGroupStore } from '../effectGroups/EffectGroupStore'
import { ObsEffectGroupPlayer } from '../effectGroups/ObsEffectGroupPlayer'
import { HookEngine } from '../HookEngine'
import { ObsEnterEffectService } from '../ObsEnterEffectService'
import { ObsWebSocketClient } from '../ObsWebSocketClient'
import { MockObsTextClient } from './MockObsTextClient'

/** Reuse physical OBS resources with separate cooldowns, queues and RAM receipts. */
export class MockEffectsBridge {
  private readonly memory: EffectGroupStore
  private readonly legacy: HookEngine
  private readonly obs: ObsEnterEffectService
  private readonly textClient = new MockObsTextClient(new ObsWebSocketClient(undefined, false))
  private readonly groupClient = new ObsWebSocketClient(undefined, false)
  private readonly groups: EffectGroupService
  private sequence = 0
  private closed = false
  private closing?: Promise<void>
  private readonly controller = new AbortController()
  private pending = new Set<Promise<unknown>>()
  constructor(
    private readonly options: {
      accountId: string
      hooks: HookSettings
      obs: ObsEnterEffectSettings
      groupSnapshot: {
        config: EffectGroupsConfig
        resources: EffectGroupResource[]
        installId: string
      }
      policy: () => Promise<AssistantAudiencePolicy>
      overlayBaseUrl: () => string
    },
  ) {
    const silent = { info() {}, error() {} }
    this.obs = new ObsEnterEffectService(structuredClone(options.obs), this.textClient, silent)
    this.legacy = new HookEngine(structuredClone(options.hooks), this.obs, silent, {
      generateText: async () => {
        throw new Error('Mock hook text generation uses the assistant draft workflow')
      },
      sendMessage: async () => {
        throw new Error('Mock hooks cannot send public messages')
      },
    })
    this.memory = new EffectGroupStore(':memory:', { memoryOwner: options.groupSnapshot.installId })
    const initial = this.memory.get(options.accountId)
    this.memory.save(
      options.accountId,
      initial.revision,
      { ...structuredClone(options.groupSnapshot.config), revision: initial.revision },
      'mock-copy-config',
    )
    for (const resource of options.groupSnapshot.resources) {
      if (
        resource.state === 'ready' &&
        options.groupSnapshot.config.groups.some(group => group.groupId === resource.groupId)
      )
        this.memory.saveResource(structuredClone(resource))
    }
    const physical = new ObsEffectGroupPlayer({
      client: this.groupClient,
      installId: this.memory.installId,
      overlayBaseUrl: options.overlayBaseUrl,
      connect: () => this.groupClient.connect(options.obs.url, options.obs.password),
      onResource: resource => {
        this.memory.saveResource(resource)
      },
    })
    this.groups = new EffectGroupService({
      store: this.memory,
      getAudiencePolicy: () => options.policy(),
      player: {
        play: (...args) => physical.play(...args),
        stop: () => physical.stop(),
        catalog: scene => physical.catalog(scene),
        recover: async () => {},
        sync: async () => {
          throw new Error('Mock cannot create or sync OBS resources')
        },
        retire: async () => {
          throw new Error('Mock cannot retire OBS resources')
        },
      },
    })
  }

  async dispatch(
    message: LiveMessage,
    row: AssistantDeskRow,
    legacyEnabled: boolean,
  ): Promise<void> {
    if (this.closed || !row.triage || row.accountId !== this.options.accountId) return
    const task = this.dispatchCurrent(message, row, legacyEnabled)
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }
  private async dispatchCurrent(
    message: LiveMessage,
    row: AssistantDeskRow,
    legacyEnabled: boolean,
  ) {
    if (!row.triage) return
    const sequence = ++this.sequence
    let handled = false
    if (
      ['enter', 'follow', 'like', 'gift'].includes(row.kind) &&
      row.userId &&
      (row.kind !== 'gift' || (row.gift?.final && row.gift.contributed))
    ) {
      handled = (
        await this.groups.dispatchObserved({
          accountId: row.accountId,
          eventId: row.id,
          actionKind: row.kind as EffectActionKind,
          userId: row.userId,
          displayName: row.nickname,
          receivedAt: row.receivedAt,
          sequence,
          triage: row.triage,
          persisted: true,
          facts: { sourceEventId: row.sourceEventId, payLevel: row.payLevel, gift: row.gift },
        })
      ).handled
    }
    if (this.closed) return
    const event = this.legacy.fromLiveMessage(message)
    if (event)
      await this.legacy.dispatch(event, {
        accountId: row.accountId,
        localEffectsOnly: true,
        signal: this.controller.signal,
        current: () => !this.closed,
        suppressPublicReplies: true,
        suppressObsEffects: handled || !legacyEnabled,
        audiencePolicy: row.triage,
        welcomePolicy: event.type === 'viewer.enter' ? row.triage : undefined,
        welcomeCurrent: () => !this.closed,
      })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.controller.abort()
    this.textClient.seal()
    this.closing = (async () => {
      const cleanup = await Promise.allSettled([
        this.groups.stop(),
        this.obs.stop(),
        ...this.pending,
      ])
      const restored = await Promise.allSettled([this.textClient.restore()])
      const errors = [...cleanup, ...restored].filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (errors.length)
        throw new AggregateError(
          errors.map(result => result.reason),
          'Mock OBS cleanup failed',
        )
    })().finally(async () => {
      await Promise.allSettled([this.groupClient.disconnect(), this.textClient.disconnect()])
      this.memory.close()
    })
    return this.closing
  }
}
