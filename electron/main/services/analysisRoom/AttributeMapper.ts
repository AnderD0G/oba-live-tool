import {
  AnalysisError,
  analysisInteger,
  analysisObject,
  analysisString,
  assertBoundedJson,
  type BusinessObservation,
  type JsonValue,
} from '../../../../shared/analysisRoom'
import type {
  AttributeCandidate,
  AttributeDefinition,
  AttributeDictionaryDraft,
  AttributeFact,
  AttributeSnapshot,
  AttributeType,
  AttributeValue,
  DeclaredConversion,
  ParsedAttributeValue,
  PublishedAttributeDictionary,
} from '../../../../shared/audienceAttributes'

const types = ['string', 'number', 'integer', 'boolean', 'enum']
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const unknown = (reason: string): ParsedAttributeValue => ({ status: 'unknown', reason })
function validScalar(value: unknown): value is AttributeValue {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0 && value.length <= 1024)
  )
}
export function attributePointer(path: string): string[] {
  analysisString(path, 2048)
  if (!path.startsWith('/') || /~(?![01])/.test(path)) throw new Error('invalid pointer')
  const parts = path
    .slice(1)
    .split('/')
    .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (parts.length > 16 || parts.some(part => unsafe.has(part) || part.includes('*')))
    throw new Error('unsafe pointer')
  return parts
}
export function validateAttributeDraft(input: AttributeDictionaryDraft): AttributeDictionaryDraft {
  try {
    assertBoundedJson(input)
    const draft = structuredClone(input)
    if (!Array.isArray(draft.definitions) || draft.definitions.length > 256)
      throw new Error('definitions limit')
    analysisObject(draft.identity, ['userIdPath', 'nicknamePath'])
    attributePointer(draft.identity.userIdPath)
    if (draft.identity.nicknamePath !== undefined) attributePointer(draft.identity.nicknamePath)
    if (
      !Array.isArray(draft.acceptedFormatVersions) ||
      !draft.acceptedFormatVersions.length ||
      draft.acceptedFormatVersions.length > 16 ||
      new Set(draft.acceptedFormatVersions).size !== draft.acceptedFormatVersions.length
    )
      throw new Error('format versions')
    for (const format of draft.acceptedFormatVersions) analysisInteger(format, 1)
    const ids = new Set<string>()
    for (const definition of draft.definitions) {
      analysisObject(definition, [
        'id',
        'name',
        'type',
        'ttlMs',
        'candidates',
        'conversion',
        'enumValues',
        'semantic',
      ])
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(definition.id) ||
        unsafe.has(definition.id) ||
        ids.has(definition.id)
      )
        throw new Error('attribute id')
      ids.add(definition.id)
      analysisString(definition.name, 128)
      if (
        !types.includes(definition.type) ||
        !['basic', 'follow', 'behavior-reserved'].includes(definition.semantic)
      )
        throw new Error('attribute type')
      if (
        ['purchaseCount', 'refundCount', 'orderOwnership'].includes(definition.id) &&
        definition.semantic !== 'behavior-reserved'
      )
        throw new Error('reserved behavior')
      if (definition.ttlMs !== undefined) analysisInteger(definition.ttlMs, 1000, 30 * 86400000)
      if (
        !Array.isArray(definition.candidates) ||
        !definition.candidates.length ||
        definition.candidates.length > 4
      )
        throw new Error('candidate limit')
      const candidates = new Set<string>()
      for (const candidate of definition.candidates) {
        analysisObject(candidate, ['path', 'priority', 'businessType'])
        attributePointer(candidate.path)
        analysisInteger(candidate.priority, Number.MIN_SAFE_INTEGER)
        if (candidate.businessType !== undefined) analysisString(candidate.businessType, 128)
        const key = JSON.stringify([candidate.path, candidate.businessType ?? null])
        if (candidates.has(key)) throw new Error('duplicate candidate')
        candidates.add(key)
      }
      if (
        definition.type === 'enum' &&
        (!Array.isArray(definition.enumValues) ||
          !definition.enumValues.length ||
          definition.enumValues.length > 256 ||
          definition.enumValues.some(value => !validScalar(value)))
      )
        throw new Error('enum values')
      if (definition.type !== 'enum' && definition.enumValues !== undefined)
        throw new Error('enum on other type')
      if (definition.conversion !== undefined) {
        const conversion = definition.conversion
        if (conversion.kind === 'decimal') {
          analysisObject(conversion, ['kind'])
          if (!['number', 'integer'].includes(definition.type)) throw new Error('decimal target')
        } else if (conversion.kind === 'table') {
          analysisObject(conversion, ['kind', 'entries'])
          if (
            !Array.isArray(conversion.entries) ||
            !conversion.entries.length ||
            conversion.entries.length > 256
          )
            throw new Error('table limit')
          const keys = new Set<string>()
          for (const entry of conversion.entries) {
            analysisObject(entry, ['from', 'to'])
            const key = JSON.stringify(entry.from)
            if (
              !validScalar(entry.from) ||
              !validScalar(entry.to) ||
              keys.has(key) ||
              interpretValue(definition.type, entry.to, undefined, definition.enumValues).status !==
                'known'
            )
              throw new Error('table values')
            keys.add(key)
          }
        } else throw new Error('conversion kind')
      }
    }
    return {
      definitions: draft.definitions,
      identity: draft.identity,
      acceptedFormatVersions: draft.acceptedFormatVersions,
    }
  } catch {
    throw new AnalysisError(
      'MAPPING_INVALID',
      '属性字典无效：检查类型、路径、枚举、候选上限及有效期',
    )
  }
}
export function interpretValue(
  type: AttributeType,
  input: JsonValue | undefined,
  conversion?: DeclaredConversion,
  enumValues?: AttributeValue[],
): ParsedAttributeValue {
  if (input === undefined) return unknown('MISSING')
  if (input === null) return unknown('NULL')
  let value = input
  if (conversion?.kind === 'decimal') {
    if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value))
      return unknown('CONVERSION_FAILED')
    value = Number(value)
  } else if (conversion?.kind === 'table') {
    const entry = conversion.entries.find(entry => Object.is(entry.from, value))
    if (!entry) return unknown('CONVERSION_FAILED')
    value = entry.to
  }
  if (type === 'enum')
    return enumValues?.some(entry => Object.is(entry, value)) && validScalar(value)
      ? { status: 'known', value }
      : unknown('ENUM_UNDECLARED')
  if (type === 'string' && typeof value === 'string' && value.trim() && value.length <= 1024)
    return { status: 'known', value }
  if (type === 'boolean' && typeof value === 'boolean') return { status: 'known', value }
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value))
    return { status: 'known', value }
  if (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value))
    return { status: 'known', value }
  return unknown('TYPE_MISMATCH')
}
function readPath(data: JsonValue, path: string): JsonValue | undefined {
  let value: unknown = data
  for (const part of attributePointer(path)) {
    if (!value || typeof value !== 'object') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, part)
    if (!descriptor || !('value' in descriptor)) return undefined
    value = descriptor.value
  }
  return value as JsonValue | undefined
}
function blocked(observation: BusinessObservation, path: string): string | undefined {
  if (observation.removedPaths.some(removed => path === removed || path.startsWith(`${removed}/`)))
    return 'REMOVED'
  if (
    observation.truncatedPaths.some(
      truncated => path === truncated || path.startsWith(`${truncated}/`),
    )
  )
    return 'TRUNCATED'
  return observation.complete ? undefined : 'INCOMPLETE_PAYLOAD'
}
function candidateValue(
  observation: BusinessObservation,
  definition: AttributeDefinition,
  candidate: AttributeCandidate,
): ParsedAttributeValue {
  const reason = blocked(observation, candidate.path)
  return reason
    ? unknown(reason)
    : interpretValue(
        definition.type,
        readPath(observation.data, candidate.path),
        definition.conversion,
        definition.enumValues,
      )
}
export function mapObservation(
  observation: BusinessObservation,
  version: PublishedAttributeDictionary,
): AttributeSnapshot {
  const draft = validateAttributeDraft(version)
  const compatible =
    version.platform === observation.scope.platform &&
    version.source === observation.scope.source &&
    draft.acceptedFormatVersions.includes(observation.formatVersion)
  const identity =
    compatible && !blocked(observation, draft.identity.userIdPath)
      ? readPath(observation.data, draft.identity.userIdPath)
      : undefined
  const userId =
    typeof identity === 'string' &&
    identity.trim() &&
    identity.length <= 256 &&
    !Array.from(identity).some(character => character.charCodeAt(0) < 32)
      ? identity
      : typeof identity === 'number' && Number.isSafeInteger(identity) && identity >= 0
        ? String(identity)
        : undefined
  const rawNickname =
    compatible && draft.identity.nicknamePath && !blocked(observation, draft.identity.nicknamePath)
      ? readPath(observation.data, draft.identity.nicknamePath)
      : undefined
  const nickname =
    typeof rawNickname === 'string' && rawNickname.trim() && rawNickname.length <= 128
      ? rawNickname
      : undefined
  const values: Record<string, AttributeFact> = {}
  for (const definition of draft.definitions) {
    let result: ParsedAttributeValue | { status: 'conflict'; reason: string } = unknown('MISSING')
    let selectedPath: string | undefined
    if (!compatible) result = unknown('FORMAT_INCOMPATIBLE')
    else if (definition.semantic === 'behavior-reserved') result = unknown('BEHAVIOR_RESERVED')
    else {
      const candidates = definition.candidates
        .filter(
          candidate =>
            candidate.businessType === undefined ||
            candidate.businessType === observation.businessType,
        )
        .sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path))
      if (!candidates.length) result = unknown('BUSINESS_TYPE_MISMATCH')
      for (let i = 0; i < candidates.length; ) {
        const priority = candidates[i].priority
        const group: Array<{ path: string; parsed: ParsedAttributeValue }> = []
        while (i < candidates.length && candidates[i].priority === priority) {
          const candidate = candidates[i++]
          const parsed = candidateValue(observation, definition, candidate)
          if (!(parsed.status === 'unknown' && parsed.reason === 'MISSING'))
            group.push({ path: candidate.path, parsed })
        }
        if (!group.length) continue
        selectedPath = group[0].path
        result = group[0].parsed
        if (
          group.some(
            item =>
              item.parsed.status !== result.status ||
              (item.parsed.status === 'known' &&
                result.status === 'known' &&
                !Object.is(item.parsed.value, result.value)),
          )
        )
          result = { status: 'conflict', reason: 'CANDIDATE_CONFLICT' }
        break
      }
    }
    const ttlMs = definition.ttlMs ?? (definition.semantic === 'follow' ? 300000 : 86400000)
    values[definition.id] = {
      scope: { ...observation.scope },
      observationId: observation.observationId,
      sequence: observation.sequence,
      streamId: observation.streamId,
      observedAt: observation.receivedAt,
      ...(observation.platformTime === undefined ? {} : { platformTime: observation.platformTime }),
      timeBasis: observation.platformTime === undefined ? 'local-sequence' : 'platform',
      mappingVersion: version.version,
      expiresAt: observation.receivedAt + ttlMs,
      ...(selectedPath ? { path: selectedPath } : {}),
      type: definition.type,
      ...result,
    }
  }
  return {
    origin: 'live',
    scope: { ...observation.scope },
    ...(userId === undefined ? {} : { userId }),
    ...(nickname === undefined ? {} : { nickname }),
    mappingVersion: version.version,
    observationId: observation.observationId,
    sequence: observation.sequence,
    streamId: observation.streamId,
    observedAt: observation.receivedAt,
    ...(observation.platformTime === undefined ? {} : { platformTime: observation.platformTime }),
    values,
  }
}
