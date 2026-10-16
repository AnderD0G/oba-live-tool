import type { AnalysisScope, JsonValue, MappingScope, PreviewProof } from './analysisRoom'

export type AttributeType = 'string' | 'number' | 'integer' | 'boolean' | 'enum'
export type AttributeValue = string | number | boolean
export type ParsedAttributeValue =
  | { status: 'known'; value: AttributeValue }
  | { status: 'unknown'; reason: string }
export type DeclaredConversion =
  | { kind: 'decimal' }
  | { kind: 'table'; entries: Array<{ from: JsonValue; to: AttributeValue }> }
export interface AttributeCandidate {
  path: string
  priority: number
  businessType?: string
}
export interface AttributeDefinition {
  id: string
  name: string
  type: AttributeType
  ttlMs?: number
  candidates: AttributeCandidate[]
  conversion?: DeclaredConversion
  enumValues?: AttributeValue[]
  semantic: 'basic' | 'follow' | 'behavior-reserved'
}
export interface AttributeDictionaryDraft {
  definitions: AttributeDefinition[]
  identity: { userIdPath: string; nicknamePath?: string }
  acceptedFormatVersions: number[]
}
export interface PublishedAttributeDictionary extends AttributeDictionaryDraft, MappingScope {
  version: number
  publishedAt: number
}
export interface DictionaryState {
  revision: number
  draft: AttributeDictionaryDraft
  activeVersion?: number
  selectedVersion?: PublishedAttributeDictionary
  versions: Array<{ version: number; publishedAt: number; acceptedFormatVersions: number[] }>
}
export interface DictionaryPreview extends PreviewProof {
  revision: number
  scope: AnalysisScope
  sessionId: string
  counts: {
    known: number
    unknown: number
    conflict: number
    removed: number
    conversionFailed: number
  }
  samples: AttributeSnapshot[]
  warnings: string[]
}
export interface AttributeProvenance {
  scope: AnalysisScope
  observationId: string
  sequence: number
  streamId: string
  observedAt: number
  platformTime?: number
  timeBasis: 'platform' | 'local-sequence'
  mappingVersion: number
  expiresAt: number
  path?: string
}
export type AttributeFact = AttributeProvenance &
  (
    | { status: 'known'; type: AttributeType; value: AttributeValue }
    | { status: 'unknown' | 'conflict'; type: AttributeType; reason: string }
  )
export interface AttributeSnapshot {
  origin?: 'live' | 'history'
  scope: AnalysisScope
  userId?: string
  nickname?: string
  mappingVersion: number
  observationId: string
  sequence: number
  streamId: string
  observedAt: number
  platformTime?: number
  values: Record<string, AttributeFact>
}
