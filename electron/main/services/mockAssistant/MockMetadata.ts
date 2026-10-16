import { createHash } from 'node:crypto'
import {
  type AssistantAudiencePolicy,
  type AudiencePolicyCatalog,
  audiencePolicyCatalog,
  validateAudiencePolicy,
} from '../../../../shared/assistantAudiencePolicy'
import { MOCK_EVENT_KINDS, MOCK_LIMITS, type MockBatch } from '../../../../shared/mockAssistant'

export interface MockMetadata {
  version: 1
  scope: 'mock'
  accountId: string
  metadataRevision: string
  catalog: AudiencePolicyCatalog
  policy: AssistantAudiencePolicy
  example: MockBatch
  limits: typeof MOCK_LIMITS
  eventKinds: typeof MOCK_EVENT_KINDS
}
export function buildMockMetadata(input: {
  accountId: string
  policy: AssistantAudiencePolicy
}): MockMetadata {
  if (
    typeof input.accountId !== 'string' ||
    !/^[^\s\p{Cc}]{1,256}$/u.test(input.accountId) ||
    !Number.isSafeInteger(input.policy?.revision) ||
    input.policy.revision < 0
  )
    throw new Error('Mock metadata scope is invalid')
  // Accept only policy fields; never project an AssistantDeskState or its context/audience.
  const policy = validateAudiencePolicy(
    {
      revision: input.policy.revision,
      enabled: input.policy.enabled,
      attentionWindowSeconds: input.policy.attentionWindowSeconds,
      rules: input.policy.rules.map(rule => ({
        id: rule.id,
        label: rule.label,
        enabled: rule.enabled,
        priority: rule.priority,
        conditions: rule.conditions.map(condition => ({
          field: condition.field,
          operator: condition.operator,
          value: condition.value,
        })),
        result: {
          tier: rule.result.tier,
          label: rule.result.label,
          autoAttention: rule.result.autoAttention,
          ...(rule.result.welcomePresetId === undefined
            ? {}
            : { welcomePresetId: rule.result.welcomePresetId }),
          ...(rule.result.cardColor === undefined ? {} : { cardColor: rule.result.cardColor }),
        },
      })),
    },
    input.policy.revision,
  )
  const catalog = audiencePolicyCatalog()
  const base = {
    version: 1 as const,
    scope: 'mock' as const,
    accountId: input.accountId,
    catalog,
    policy,
    limits: { ...MOCK_LIMITS },
    eventKinds: [...MOCK_EVENT_KINDS] as unknown as typeof MOCK_EVENT_KINDS,
  }
  // Copying a policy into the RAM CAS store increments its local counter, not its meaning.
  const metadataRevision = createHash('sha256')
    .update(
      JSON.stringify({
        ...base,
        policy: {
          enabled: policy.enabled,
          attentionWindowSeconds: policy.attentionWindowSeconds,
          rules: policy.rules,
        },
      }),
    )
    .digest('hex')
  return {
    ...base,
    metadataRevision,
    example: {
      version: 1,
      accountId: input.accountId,
      metadataRevision,
      batchId: 'sample-1',
      name: '模拟多语言评论',
      durationMs: 1000,
      users: [{ id: 'mock-viewer-1', nickname: '模拟观众', payLevel: 15, followerCount: 100 }],
      events: [
        {
          id: 'mock-event-1',
          userId: 'mock-viewer-1',
          atMs: 0,
          kind: 'comment',
          text: 'ราคาเท่าไหร่?',
        },
      ],
    },
  }
}
