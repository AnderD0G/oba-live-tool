import type { AssistantAudienceTriage, AudiencePolicyTier } from './assistantAudiencePolicy'
import type { AssistantDeskRow } from './assistantDesk'

export const ASSISTANT_REPLY_ACTIONS = ['comment', 'enter', 'follow', 'gift', 'like'] as const
export type AssistantReplyAction = typeof ASSISTANT_REPLY_ACTIONS[number]
export type AssistantReplyMode = 'off' | 'manual' | 'review' | 'auto'
export interface AssistantReplyRule {
  id: string
  enabled: boolean
  action: AssistantReplyAction
  mode: AssistantReplyMode
  /** Lower values are evaluated first, matching audience policy priority. */
  priority: number
  audienceRuleId?: string
  tier?: AudiencePolicyTier
  knowledge: string
  instructions: string
}
export interface AssistantReplyPolicy { revision: number; enabled: boolean; rules: AssistantReplyRule[] }

export function defaultAssistantReplyPolicy(): AssistantReplyPolicy {
  return { revision: 1, enabled: false, rules: ASSISTANT_REPLY_ACTIONS.map((action) => ({ id: `default-${action}`, enabled: true, action, mode: 'manual', priority: 1000, knowledge: '', instructions: '' })) }
}

function invalid(): never { throw new Error('INVALID_REPLY_POLICY') }
function boundedId(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) }
function boundedText(value: unknown) { return typeof value === 'string' && value.length <= 20000 && !/[\u0000]/.test(value) }

export function validateAssistantReplyPolicy(raw: unknown, revision: number): AssistantReplyPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isSafeInteger(revision) || revision < 1) invalid()
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some((key) => !['revision', 'enabled', 'rules'].includes(key)) || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 100) invalid()
  const ids = new Set<string>()
  const rules = input.rules.map((value: unknown): AssistantReplyRule => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
    const rule = value as AssistantReplyRule
    if (Object.keys(rule).some((key) => !['id', 'enabled', 'action', 'mode', 'priority', 'audienceRuleId', 'tier', 'knowledge', 'instructions'].includes(key)) || !boundedId(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean' || !ASSISTANT_REPLY_ACTIONS.includes(rule.action) || !['off', 'manual', 'review', 'auto'].includes(rule.mode) || !Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 10000 || !boundedText(rule.knowledge) || !boundedText(rule.instructions)) invalid()
    if (rule.audienceRuleId !== undefined && (!boundedId(rule.audienceRuleId) || rule.tier !== undefined) || rule.tier !== undefined && !['gold', 'silver', 'neutral'].includes(rule.tier)) invalid()
    ids.add(rule.id)
    return { id: rule.id, enabled: rule.enabled, action: rule.action, mode: rule.mode, priority: rule.priority,
      ...(rule.audienceRuleId === undefined ? {} : { audienceRuleId: rule.audienceRuleId }), ...(rule.tier === undefined ? {} : { tier: rule.tier }), knowledge: rule.knowledge, instructions: rule.instructions }
  })
  const policy = { revision, enabled: input.enabled, rules }
  if (new TextEncoder().encode(JSON.stringify(policy)).byteLength > 96000) invalid()
  return policy
}

export function resolveAssistantReplyRule(policy: AssistantReplyPolicy, action: AssistantDeskRow['kind'], triage: Pick<AssistantAudienceTriage, 'tier' | 'matchedRuleId'>): AssistantReplyRule | undefined {
  if (!policy.enabled) return
  return policy.rules.map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled && rule.action === action && (rule.audienceRuleId === undefined || rule.audienceRuleId === triage.matchedRuleId) && (rule.tier === undefined || rule.tier === triage.tier))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index)[0]?.rule
}

export function assistantReplyEligible(row: Pick<AssistantDeskRow, 'kind' | 'userId' | 'nickname' | 'gift'>): boolean {
  return ASSISTANT_REPLY_ACTIONS.includes(row.kind as AssistantReplyAction) && !!row.userId && !!row.nickname && row.nickname !== '未知昵称' &&
    (row.kind !== 'gift' || row.gift?.final === true && row.gift.contributed === true)
}
