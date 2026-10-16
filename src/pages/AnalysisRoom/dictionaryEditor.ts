import type {
  AttributeDefinition,
  AttributeDictionaryDraft,
} from '../../../shared/audienceAttributes'
export interface BasicDefinitionEdit {
  id: string
  name: string
  path: string
  type: AttributeDefinition['type']
  semantic: AttributeDefinition['semantic']
  ttlMs: number
}
export function editBasicDefinition(
  draft: AttributeDictionaryDraft,
  input: BasicDefinitionEdit,
): AttributeDictionaryDraft {
  const previous = draft.definitions.find(item => item.id === input.id)
  if (
    previous &&
    (input.path !== previous.candidates[0]?.path || input.type !== previous.type) &&
    (previous.candidates.length > 1 ||
      previous.conversion ||
      previous.enumValues ||
      previous.candidates.some(item => item.businessType))
  ) {
    throw new Error('此属性含高级映射；修改路径或类型请使用高级编辑，避免丢失配置')
  }
  const definition: AttributeDefinition = {
    ...previous,
    id: input.id,
    name: input.name,
    type: input.type,
    semantic: input.semantic,
    ttlMs: input.ttlMs,
    candidates:
      previous && input.path === previous.candidates[0]?.path
        ? structuredClone(previous.candidates)
        : [{ path: input.path, priority: 0 }],
  }
  return {
    ...draft,
    definitions: previous
      ? draft.definitions.map(item => (item.id === input.id ? definition : item))
      : [...draft.definitions, definition],
  }
}
