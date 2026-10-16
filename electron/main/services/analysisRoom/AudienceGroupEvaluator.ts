import {
  AnalysisError,
  analysisInteger,
  analysisObject,
  analysisString,
  assertBoundedJson,
  validateMappingScope,
} from '../../../../shared/analysisRoom'
import type { PublishedAttributeDictionary } from '../../../../shared/audienceAttributes'
import type {
  AudienceGroupCondition,
  AudienceGroupsConfig,
  GroupEvaluation,
  GroupEvaluationInput,
} from '../../../../shared/audienceGroups'
import type { RoutingField } from '../../../../shared/interactionRouting'
import { interpretValue } from './AttributeMapper'

const builtinTypes: Record<RoutingField, 'string' | 'boolean' | 'number'> = {
  'user.id': 'string',
  'user.score': 'number',
  'user.sessionScore': 'number',
  'user.engagementScore': 'number',
  'user.sessionEngagementScore': 'number',
  'user.fansClubLevel': 'number',
  'user.payLevel': 'number',
  'user.purchaseCount': 'number',
  'user.isFirstSeen': 'boolean',
  'room.onlineCount': 'number',
}
interface ValidationOptions {
  dictionary?: (
    platform: LiveControlPlatform,
    source: 'control' | 'compass',
  ) => PublishedAttributeDictionary | undefined
  allowStale?: boolean
}
export function validateAudienceGroups(
  config: AudienceGroupsConfig,
  options: ValidationOptions = {},
): AudienceGroupsConfig {
  try {
    assertBoundedJson(config)
    analysisObject(config, ['enabled', 'items'])
    if (
      typeof config.enabled !== 'boolean' ||
      !Array.isArray(config.items) ||
      config.items.length > 100
    )
      throw new Error('groups bounds')
    const ids = new Set<string>()
    for (const group of config.items) {
      analysisObject(group, [
        'id',
        'name',
        'enabled',
        'platform',
        'source',
        'events',
        'all',
        'any',
        'manualIds',
        'priority',
        'fallback',
        'cooldownMs',
        'strategy',
      ])
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(group.id) || ids.has(group.id)) throw new Error('group id')
      ids.add(group.id)
      analysisString(group.name, 120)
      validateMappingScope(group)
      if (
        typeof group.enabled !== 'boolean' ||
        (group.fallback !== undefined && typeof group.fallback !== 'boolean')
      )
        throw new Error('enabled/fallback')
      analysisInteger(group.priority, -1000000, 1000000)
      if (group.cooldownMs !== undefined) analysisInteger(group.cooldownMs, 1000, 3600000)
      if (
        !Array.isArray(group.events) ||
        !group.events.length ||
        group.events.length > 2 ||
        !group.events.every(event => ['viewer.enter', 'viewer.comment'].includes(event)) ||
        new Set(group.events).size !== group.events.length
      )
        throw new Error('events')
      if (
        !Array.isArray(group.all) ||
        (group.any !== undefined && !Array.isArray(group.any)) ||
        group.all.length + (group.any?.length ?? 0) > 20
      )
        throw new Error('conditions')
      if (
        group.manualIds !== undefined &&
        (!Array.isArray(group.manualIds) || group.manualIds.length > 200)
      )
        throw new Error('manual ids')
      const manual = new Set<string>()
      for (const identity of group.manualIds ?? []) {
        analysisObject(identity, ['accountId', 'platform', 'userId'])
        analysisString(identity.accountId, 200)
        analysisString(identity.userId, 256)
        validateMappingScope({ platform: identity.platform, source: group.source })
        const key = JSON.stringify([identity.accountId, identity.platform, identity.userId])
        if (manual.has(key)) throw new Error('duplicate identity')
        manual.add(key)
      }
      if (!group.all.length && !group.any?.length && !group.manualIds?.length && !group.fallback)
        throw new Error('empty nonfallback')
      for (const condition of [...group.all, ...(group.any ?? [])]) {
        analysisObject(condition, ['field', 'op', 'value'])
        if (!['eq', 'gte', 'lte', 'exists', 'isUnknown'].includes(condition.op))
          throw new Error('condition operator')
        let type: string | undefined
        let enumValues: (string | number | boolean)[] | undefined
        if (condition.field.kind === 'builtin') {
          analysisObject(condition.field, ['kind', 'key'])
          if (!Object.hasOwn(builtinTypes, condition.field.key)) throw new Error('builtin field')
          type = builtinTypes[condition.field.key]
        } else if (condition.field.kind === 'attribute') {
          analysisObject(condition.field, ['kind', 'id'])
          analysisString(condition.field.id, 64)
          if (options.dictionary) {
            const attributeId = condition.field.id
            let dictionary: PublishedAttributeDictionary | undefined
            try {
              dictionary = options.dictionary(group.platform, group.source)
            } catch (error) {
              if (!options.allowStale) throw error
            }
            const definition = dictionary?.definitions.find(
              definition => definition.id === attributeId,
            )
            if (!definition && !options.allowStale) throw new Error('attribute missing')
            type = definition?.type
            enumValues = definition?.enumValues
            if (definition?.semantic === 'behavior-reserved' && condition.op !== 'isUnknown')
              throw new Error('behavior reserved')
          }
        } else throw new Error('field kind')
        if (['exists', 'isUnknown'].includes(condition.op)) {
          if (condition.value !== undefined) throw new Error('unary value')
          continue
        }
        if (
          !['string', 'number', 'boolean'].includes(typeof condition.value) ||
          (typeof condition.value === 'number' && !Number.isFinite(condition.value))
        )
          throw new Error('condition value')
        if (
          ['gte', 'lte'].includes(condition.op) &&
          ((type !== undefined && !['number', 'integer'].includes(type)) ||
            typeof condition.value !== 'number')
        )
          throw new Error('numeric comparison')
        if (
          type &&
          interpretValue(
            type as 'string' | 'number' | 'integer' | 'boolean' | 'enum',
            condition.value,
            undefined,
            enumValues,
          ).status !== 'known'
        )
          throw new Error('typed value')
      }
      analysisObject(group.strategy, ['channel', 'guidance', 'template', 'includeNickname'])
      if (
        !['text', 'voice-preferred'].includes(group.strategy.channel) ||
        typeof group.strategy.includeNickname !== 'boolean' ||
        typeof group.strategy.guidance !== 'string' ||
        group.strategy.guidance.length > 1000
      )
        throw new Error('strategy')
      if (group.strategy.template !== undefined) {
        analysisString(group.strategy.template, 1000)
        if (
          /[{}]/.test(group.strategy.template.replaceAll('{nickname}', '')) ||
          (group.strategy.template.includes('{nickname}') && !group.strategy.includeNickname)
        )
          throw new Error('template placeholders')
      }
      if (!group.strategy.guidance.trim() && !group.strategy.template)
        throw new Error('empty strategy')
    }
    return structuredClone(config)
  } catch {
    throw new AnalysisError(
      'GROUP_INVALID',
      '分组无效：检查范围、字段类型、条件、定向 ID、模板和上限',
    )
  }
}
function groupConditionValue(
  condition: AudienceGroupCondition,
  input: GroupEvaluationInput,
): { known: boolean; value?: string | number | boolean; reason: string } {
  if (condition.field.kind === 'builtin') {
    const [parent, key] = condition.field.key.split('.')
    const object = parent === 'room' ? input.context.room : input.context.user
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    const value = descriptor && 'value' in descriptor ? descriptor.value : undefined
    const parsed = interpretValue(builtinTypes[condition.field.key], value)
    const signed = ['user.engagementScore', 'user.sessionEngagementScore'].includes(
      condition.field.key,
    )
    if (
      parsed.status === 'known' &&
      (typeof parsed.value !== 'number' || signed || parsed.value >= 0)
    )
      return { known: true, value: parsed.value, reason: 'KNOWN' }
    return { known: false, reason: 'BUILTIN_UNKNOWN' }
  }
  const attributes = input.attributes
  if (
    !attributes ||
    input.dictionaryVersion === undefined ||
    attributes.scope.accountId !== input.scope.accountId ||
    attributes.scope.platform !== input.scope.platform ||
    attributes.scope.source !== input.scope.source ||
    attributes.userId !== input.userId ||
    attributes.mappingVersion !== input.dictionaryVersion
  )
    return { known: false, reason: 'ATTRIBUTE_SCOPE_OR_VERSION_UNKNOWN' }
  const fact = Object.getOwnPropertyDescriptor(attributes.values, condition.field.id)?.value
  if (
    fact?.status === 'known' &&
    fact.scope?.accountId === input.scope.accountId &&
    fact.scope?.platform === input.scope.platform &&
    fact.scope?.source === input.scope.source &&
    fact.mappingVersion === input.dictionaryVersion &&
    ['string', 'boolean', 'number'].includes(typeof fact.value) &&
    (typeof fact.value !== 'number' || Number.isFinite(fact.value)) &&
    ['string', 'boolean', 'number', 'integer', 'enum'].includes(fact.type) &&
    interpretValue(
      fact.type,
      fact.value,
      undefined,
      fact.type === 'enum' ? [fact.value] : undefined,
    ).status === 'known'
  )
    return { known: true, value: fact.value, reason: 'KNOWN' }
  return { known: false, reason: fact?.reason ?? 'ATTRIBUTE_UNKNOWN' }
}
export function evaluateAudienceGroups(
  config: AudienceGroupsConfig,
  input: GroupEvaluationInput,
): GroupEvaluation {
  validateAudienceGroups(config)
  const result: GroupEvaluation = {
    memberships: [],
    conditions: [],
    warnings: [],
    active: config.enabled && typeof input.userId === 'string' && !!input.userId.trim(),
  }
  const matching = [] as AudienceGroupsConfig['items']
  for (const group of config.items) {
    if (
      group.platform !== input.scope.platform ||
      group.source !== input.scope.source ||
      !group.events.includes(input.event)
    )
      continue
    const evaluate = (condition: AudienceGroupCondition) => {
      const value = groupConditionValue(condition, input)
      const matched =
        condition.op === 'isUnknown'
          ? !value.known
          : condition.op === 'exists'
            ? value.known
            : !value.known
              ? false
              : condition.op === 'eq'
                ? Object.is(value.value, condition.value)
                : typeof value.value === 'number' &&
                  typeof condition.value === 'number' &&
                  (condition.op === 'gte'
                    ? value.value >= condition.value
                    : value.value <= condition.value)
      result.conditions.push({
        groupId: group.id,
        field: condition.field,
        matched,
        known: value.known,
        reason: value.reason,
      })
      return matched
    }
    const all = group.all.map(evaluate)
    const any = group.any?.map(evaluate) ?? []
    const hasConditions = !!(all.length || any.length)
    const byRules =
      (hasConditions || group.fallback === true) &&
      all.every(Boolean) &&
      (!any.length || any.some(Boolean))
    const byManual =
      group.manualIds?.some(
        identity =>
          identity.accountId === input.scope.accountId &&
          identity.platform === input.scope.platform &&
          identity.userId === input.userId,
      ) ?? false
    if (group.manualIds?.length)
      result.conditions.push({
        groupId: group.id,
        field: { kind: 'builtin', key: 'user.id' },
        known: !!input.userId,
        matched: byManual,
        reason: 'SCOPED_MANUAL_ID',
      })
    if (byRules || byManual) matching.push(group)
  }
  matching.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  result.memberships = matching.map(group => group.id)
  if (result.active) result.winner = matching.find(group => group.enabled)
  if (!config.enabled) result.warnings.push('GROUPS_DISABLED')
  if (!input.userId) result.warnings.push('MISSING_STABLE_ID')
  if (result.winner && input.hooks?.some(hook => hook.enabled && hook.events.includes(input.event)))
    result.warnings.push('POSSIBLE_DUPLICATE_HOOK')
  if (result.winner?.strategy.channel === 'voice-preferred' && input.effectiveMode === 'focus')
    result.warnings.push('FOCUS_VOICE_DISABLED')
  return structuredClone(result)
}
