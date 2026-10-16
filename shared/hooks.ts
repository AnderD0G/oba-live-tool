import type { ObsEffectRule, ObsSceneMetadata } from './obsEffect'

export type HookSource = 'tiktok' | 'xiaohongshu' | 'webhook'
export type HookEventType =
  | 'viewer.enter'
  | 'viewer.follow'
  | 'viewer.like'
  | 'viewer.gift'
  | 'webhook.received'
export type HookConditionOperator = 'eq' | 'gte'
export type TikTokLevelStrategy =
  | 'fan-club-first'
  | 'gift-first'
  | 'highest'
  | 'fan-club-only'
  | 'gift-only'

export interface HookCondition {
  /** Local audience.ruleId / audience.matchedRuleId references require eq plus an audience.accountId eq binding. The UI adds both. */
  field: string
  operator: HookConditionOperator
  value: string | number | boolean
}

export interface HookActionBase {
  id?: string
  dependsOn?: string[]
}

export interface ObsShowSourceAction {
  type: 'obs.show-source'
  id?: string
  dependsOn?: string[]
  target: Omit<ObsEffectRule, 'id' | 'enabled' | 'minFansLevel'>
  /** @deprecated Kept for saved rules created before text became an independent action. */
  text?: {
    inputName: string
    template: string
  }
}

export interface ObsPlayRandomGroupAction extends HookActionBase {
  type: 'obs.play-random-group'
  target: {
    sceneName: string
    groupName: string
    groupContainerName?: string
    durationMs: number
    avoidImmediateRepeat: boolean
  }
}

export interface ObsSetTextAction extends HookActionBase {
  type: 'obs.set-text'
  inputName: string
  template: string
}

export interface ObsArtTextAction extends HookActionBase {
  type: 'obs.art-text'
  inputName: string
  template: string
  style: 'rainbow' | 'gold' | 'arc' | 'random'
  holdMs: number
  priority?: number
  delivery?: 'immediate' | 'queued'
  presetId?: import('./obsWelcome').ObsWelcomePresetId
}

export interface AiGenerateTextAction extends HookActionBase {
  type: 'ai.generate-text'
  provider: string
  model: string
  apiKey: string
  customBaseURL?: string
  systemPrompt: string
  promptTemplate: string
}

export interface PlatformSendMessageAction extends HookActionBase {
  type: 'platform.send-message'
  template: string
  requireMention?: boolean
}

export interface DelayAction extends HookActionBase {
  type: 'delay'
  durationMs: number
}

export type HookAction =
  | ObsShowSourceAction
  | ObsPlayRandomGroupAction
  | ObsSetTextAction
  | ObsArtTextAction
  | AiGenerateTextAction
  | PlatformSendMessageAction
  | DelayAction

export interface HookRule {
  id: string
  name: string
  enabled: boolean
  cooldownMs?: number
  exclusiveGroup?: string
  priority?: number
  levelStrategy?: TikTokLevelStrategy
  source: HookSource
  eventType: HookEventType
  conditions: HookCondition[]
  actions: HookAction[]
}

export interface HookSettings {
  webhookPort: number
  migratedObsEffects: boolean
  rules: HookRule[]
}

export const defaultHookSettings: HookSettings = {
  webhookPort: 17890,
  migratedObsEffects: false,
  rules: [],
}

export interface HookEvent {
  id: string
  source: HookSource
  type: HookEventType
  occurredAt: number
  data: Record<string, unknown>
}

export type HookCommand =
  | { action: 'state' }
  | { action: 'save'; settings: HookSettings }
  | { action: 'discover-obs' }
  | { action: 'test'; rule: HookRule }

export type HookResponse =
  | {
      ok: true
      settings?: HookSettings
      scenes?: ObsSceneMetadata[]
      webhookUrl?: string
      message?: string
    }
  | { ok: false; error: string }
