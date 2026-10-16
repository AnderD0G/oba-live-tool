import type { AnalysisScope, PreviewProof } from './analysisRoom'
import { assertBoundedJson } from './analysisRoom'
import type { AttributeSnapshot, AttributeValue } from './audienceAttributes'
import type {
  InteractionRoutingConfig,
  RoutingContext,
  RoutingEvent,
  RoutingField,
  RoutingMode,
} from './interactionRouting'

export function preserveSavedAudienceGroups(
  current: InteractionRoutingConfig,
  incoming: InteractionRoutingConfig,
): InteractionRoutingConfig {
  if (incoming.groups !== undefined) {
    assertBoundedJson(incoming.groups)
    const canonical = (value: unknown): string =>
      value && typeof value === 'object'
        ? Array.isArray(value)
          ? `[${value.map(canonical).join(',')}]`
          : `{${Object.keys(value)
              .sort()
              .map(
                key =>
                  `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
              )
              .join(',')}}`
        : JSON.stringify(value)
    if (canonical(incoming.groups) !== canonical(current.groups ?? { enabled: false, items: [] }))
      throw new Error(
        '分组更改需要使用 /interaction/groups/simulate 与 apply，不能经旧配置入口绕过预览',
      )
  }
  const next = structuredClone(incoming)
  if (current.groups === undefined) delete next.groups
  else next.groups = structuredClone(current.groups)
  return next
}

export interface AudienceGroupCondition {
  field: { kind: 'builtin'; key: RoutingField } | { kind: 'attribute'; id: string }
  op: 'eq' | 'gte' | 'lte' | 'exists' | 'isUnknown'
  value?: AttributeValue
}
export interface AudienceGroupStrategy {
  channel: 'text' | 'voice-preferred'
  guidance: string
  template?: string
  includeNickname: boolean
}
export interface AudienceGroup {
  id: string
  name: string
  enabled: boolean
  platform: LiveControlPlatform
  source: AnalysisScope['source']
  events: RoutingEvent[]
  all: AudienceGroupCondition[]
  any?: AudienceGroupCondition[]
  manualIds?: Array<{ accountId: string; platform: LiveControlPlatform; userId: string }>
  priority: number
  fallback?: boolean
  cooldownMs?: number
  strategy: AudienceGroupStrategy
}
export interface AudienceGroupsConfig {
  enabled: boolean
  items: AudienceGroup[]
}
export interface GroupEvaluationInput {
  scope: AnalysisScope
  event: RoutingEvent
  userId?: string
  context: RoutingContext
  attributes?: AttributeSnapshot
  dictionaryVersion?: number
  effectiveMode: RoutingMode
  hooks?: Array<{ id: string; enabled: boolean; events: RoutingEvent[] }>
}
export interface GroupConditionResult {
  groupId: string
  field: AudienceGroupCondition['field']
  matched: boolean
  known: boolean
  reason: string
}
export interface GroupEvaluation {
  memberships: string[]
  winner?: AudienceGroup
  conditions: GroupConditionResult[]
  warnings: string[]
  active: boolean
}
export interface GroupState {
  revision: number
  config: AudienceGroupsConfig
}
export interface GroupPreview extends PreviewProof {
  revision: number
  evaluation: GroupEvaluation
  dictionaryVersion?: number
  simulationContext?: {
    effectiveMode: RoutingMode
    modeSource: 'current-runtime' | 'configured-manual'
    hooksSource: 'current-runtime' | 'unavailable'
  }
}
export interface GroupDecisionContext {
  groupId: string
  observationId?: string
  mappingVersion?: number
  channel: AudienceGroupStrategy['channel']
  guidance: string
  template?: string
  includeNickname: boolean
  attributes: Record<string, AttributeValue>
}
export interface GroupReplyContext {
  guidance: string
  fixedText?: string
  includeNickname: boolean
  attributes: Record<string, AttributeValue>
}
export interface GroupCooldownResult {
  accepted: boolean
  nextAllowedAt: number
}
