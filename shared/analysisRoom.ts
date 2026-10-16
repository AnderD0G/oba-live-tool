import { ANALYSIS_COMMAND_ROUTES } from './analysisRoomContract.mjs'
import type {
  AttributeDictionaryDraft,
  AttributeSnapshot,
  DictionaryPreview,
  DictionaryState,
} from './audienceAttributes'
import type {
  AudienceGroupsConfig,
  GroupEvaluationInput,
  GroupPreview,
  GroupState,
} from './audienceGroups'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export interface AnalysisScope {
  accountId: string
  platform: LiveControlPlatform
  source: 'control' | 'compass'
}
export interface PayloadLimits {
  maxBytes: number
  maxDepth: number
}
export interface SanitizedPayload {
  data: JsonValue
  complete: boolean
  removedPaths: string[]
  truncatedPaths: string[]
}
/** Local evidence only: never included in sanitized records, IPC responses or UI notifications. */
export interface OriginalBusinessEvidence {
  format: 'tiktok-decoded-v1'
  provenance: 'sdk-decoded' | 'cdp-websocket-decoded' | 'cdp-http-decoded'
  complete: boolean
  json: string
  protobufBase64?: string
  removedPaths?: string[]
}
export interface BusinessObservation extends SanitizedPayload {
  scope: AnalysisScope
  observationId: string
  streamId: string
  sequence: number
  receivedAt: number
  platformTime?: number
  sourceMessageId?: string
  roomId?: string
  businessType?: string
  formatVersion: number
  failureCode?: 'PARSE_FAILED' | 'PAYLOAD_LIMIT'
  provenance?: 'sdk-decoded' | 'cdp-websocket-decoded' | 'cdp-http-decoded' | 'dom-observation'
  original?: OriginalBusinessEvidence
  originalFailureCode?: 'PAYLOAD_LIMIT' | 'SERIALIZE_FAILED'
}
export interface AnalysisRecord extends Omit<BusinessObservation, 'original' | 'originalFailureCode'> {
  sessionId: string
  recordSequence: number
  mappingVersion?: number
}
export interface OriginalEvidenceSummary {
  file: 'originals.jsonl'
  received: number
  saved: number
  dropped: number
  pending: number
  bytes: number
  redacted: number
  error?: string
}
export interface AnalysisCounters {
  received: number
  saved: number
  dropped: number
  pending: number
  parseFailed: number
  redacted: number
}
export interface AnalysisSession {
  id: string
  scope: AnalysisScope
  status: 'collecting' | 'stopping' | 'completed' | 'interrupted' | 'storage-error'
  complete: boolean
  createdAt: number
  stoppedAt?: number
  roomId?: string
  formatVersion: number
  mappingVersion?: number
  counters: AnalysisCounters
  bytes: number
  reason?: string
  originals?: OriginalEvidenceSummary
}
export interface AnalysisPage<T> {
  items: T[]
  nextCursor?: string
}
export interface AnalysisPageFilter {
  scope: AnalysisScope
  cursor?: string
  limit?: number
}
export interface AnalysisRecordFilter extends AnalysisPageFilter {
  sessionId: string
}
export interface CaptureLimits {
  maxRecordBytes: number
  maxDepth: number
  maxPendingRecords: number
  maxPendingBytes: number
  maxShardBytes: number
  maxSessionBytes: number
  maxStorageBytes: number
  maxMetadataBytes: number
  maxIdempotencyRequests: number
}
export interface AppendReceipt {
  accepted: boolean
  recordSequence?: number
  reason?: string
}
export interface RecoverySummary {
  interruptedSessionIds: string[]
  badLines: Array<{ sessionId: string; shard: string; line: number }>
  errors: Array<{ sessionId?: string; code: string }>
}
export interface FieldEntry {
  path: string
  count: number
  types: string[]
  examples: JsonValue[]
}
export interface FieldSummary {
  fields: FieldEntry[]
  complete: boolean
  badLines: number
}
export interface PreviewProof {
  token: string
  expiresAt: number
  digest: string
}
export interface CaptureTransports {
  sdk: 'idle' | 'connecting' | 'connected' | 'unavailable'
  webpage: 'idle' | 'active' | 'unavailable'
  browserNetwork?: 'idle' | 'connecting' | 'active' | 'unavailable'
  reason?: 'SDK_CONNECT_FAILED' | 'SDK_DISCONNECTED' | 'WEBPAGE_LISTENER_FAILED' | 'CAPTURE_TRANSPORTS_UNAVAILABLE' | 'PAGE_CLOSED' | 'PAGE_CHANGED'
}
export interface AnalysisCapabilities {
  scope: AnalysisScope
  connected: boolean
  supported: boolean
  sources: Array<'control' | 'compass'>
  formatVersion?: number
  captureTransports?: CaptureTransports
  activeSession?: AnalysisSession
  limits: PayloadLimits
  reason?: string
}
export interface ReanalysisJob {
  id: string
  scope: AnalysisScope
  sessionId: string
  mappingVersion: number
  status: 'running' | 'completed' | 'failed'
  received: number
  saved: number
  createdAt: number
  finishedAt?: number
  error?: string
}
export interface ReanalysisPage extends AnalysisPage<AttributeSnapshot> {
  job: ReanalysisJob
}
export interface MappingScope {
  platform: LiveControlPlatform
  source: AnalysisScope['source']
}
export interface SampleRange {
  start?: number
  end?: number
}
export interface AnalysisParameters {
  capabilities: { scope: AnalysisScope }
  start: { scope: AnalysisScope; requestId: string }
  stop: { scope: AnalysisScope; sessionId: string; requestId: string }
  sessions: AnalysisPageFilter
  records: AnalysisRecordFilter
  fields: { scope: AnalysisScope; sessionId: string }
  mappings: MappingScope & { version?: number }
  'mapping-draft': MappingScope & { revision: number; draft: AttributeDictionaryDraft }
  'mapping-preview': MappingScope & {
    accountId: string
    revision: number
    sessionId: string
    sampleRange?: SampleRange
  }
  'mapping-publish': MappingScope & {
    revision: number
    previewToken: string
    rollbackFromVersion?: number
  }
  reanalyze: { scope: AnalysisScope; sessionId: string; mappingVersion: number; requestId: string }
  results: AnalysisPageFilter & { jobId: string }
  'groups-get': { accountId: string }
  'groups-simulate': {
    accountId: string
    revision: number
    config: AudienceGroupsConfig
    input: GroupEvaluationInput
  }
  'groups-apply': {
    accountId: string
    revision: number
    config: AudienceGroupsConfig
    previewToken: string
  }
}
export type AnalysisAction = keyof AnalysisParameters
export const ANALYSIS_HTTP_ROUTES = ANALYSIS_COMMAND_ROUTES
export type AnalysisCommand = {
  [K in AnalysisAction]: { action: K; params: AnalysisParameters[K] }
}[AnalysisAction]
export type AnalysisCommandResult =
  | AnalysisCapabilities
  | AnalysisSession
  | AnalysisPage<AnalysisSession>
  | AnalysisPage<AnalysisRecord>
  | FieldSummary
  | DictionaryState
  | DictionaryPreview
  | ReanalysisJob
  | ReanalysisPage
  | GroupState
  | GroupPreview
export type AnalysisErrorCode =
  | 'ANALYSIS_INVALID_INPUT'
  | 'ANALYSIS_UNAUTHENTICATED'
  | 'ANALYSIS_NOT_CONNECTED'
  | 'ANALYSIS_SOURCE_UNSUPPORTED'
  | 'ANALYSIS_SOURCE_CONFLICT'
  | 'ANALYSIS_NOT_FOUND'
  | 'ANALYSIS_INCOMPLETE'
  | 'ANALYSIS_STORAGE_FAILED'
  | 'ANALYSIS_LIMIT'
  | 'ANALYSIS_REQUEST_CONFLICT'
  | 'ANALYSIS_UNAVAILABLE'
  | 'ANALYSIS_METHOD_NOT_ALLOWED'
  | 'ANALYSIS_INTERNAL'
  | 'MAPPING_INVALID'
  | 'MAPPING_REVISION_CONFLICT'
  | 'MAPPING_PREVIEW_STALE'
  | 'MAPPING_GROUP_DEPENDENCY'
  | 'GROUP_INVALID'
  | 'GROUP_REVISION_CONFLICT'
  | 'GROUP_PREVIEW_STALE'
export type AnalysisResponse<T = AnalysisCommandResult> =
  | { ok: true; data: T; traceId: string; health?: AnalysisHealth }
  | {
      ok: false
      error: { code: AnalysisErrorCode; message: string; retryable: boolean }
      traceId: string
      health?: AnalysisHealth
    }
export interface AnalysisHealth {
  storage: { healthy: boolean; errorCodes: string[] }
  audit: { healthy: boolean; errorCodes: string[] }
}
export interface AnalysisChanged {
  accountId: string
  scope?: AnalysisScope
  session?: AnalysisSession
  samples: string[]
  error?: AnalysisErrorCode
  health?: AnalysisHealth
  reanalysis?: ReanalysisJob
  interactionRevision?: number
  dictionaryRevision?: number
}

export class AnalysisError extends Error {
  constructor(
    public readonly code: AnalysisErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
  }
}
const platforms = [
  'douyin',
  'buyin',
  'eos',
  'xiaohongshu',
  'pgy',
  'wxchannel',
  'kuaishou',
  'taobao',
  'tiktok',
  'dev',
]
const parameterKeys: Record<AnalysisAction, string[]> = {
  capabilities: ['scope'],
  start: ['scope', 'requestId'],
  stop: ['scope', 'sessionId', 'requestId'],
  sessions: ['scope', 'cursor', 'limit'],
  records: ['scope', 'sessionId', 'cursor', 'limit'],
  fields: ['scope', 'sessionId'],
  mappings: ['platform', 'source', 'version'],
  'mapping-draft': ['platform', 'source', 'revision', 'draft'],
  'mapping-preview': ['accountId', 'platform', 'source', 'revision', 'sessionId', 'sampleRange'],
  'mapping-publish': ['platform', 'source', 'revision', 'previewToken', 'rollbackFromVersion'],
  reanalyze: ['scope', 'sessionId', 'mappingVersion', 'requestId'],
  results: ['scope', 'jobId', 'cursor', 'limit'],
  'groups-get': ['accountId'],
  'groups-simulate': ['accountId', 'revision', 'config', 'input'],
  'groups-apply': ['accountId', 'revision', 'config', 'previewToken'],
}
export const ANALYSIS_ACTIONS = Object.freeze(Object.keys(parameterKeys) as AnalysisAction[])
function invalid(): never {
  throw new AnalysisError('ANALYSIS_INVALID_INPUT', '分析请求参数无效')
}
export function analysisObject(
  input: unknown,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return invalid()
  if (allowed && Object.keys(input).some(k => !allowed.includes(k))) return invalid()
  return input as Record<string, unknown>
}
export function analysisString(value: unknown, maxLength = 256): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    Array.from(value).some(character => character.charCodeAt(0) < 32)
  )
    return invalid()
  return value
}
export function analysisInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid()
  return value
}
export function validateMappingScope(input: unknown): MappingScope {
  const value = analysisObject(input)
  if (
    !platforms.includes(value.platform as string) ||
    !['control', 'compass'].includes(value.source as string)
  )
    return invalid()
  return {
    platform: value.platform as LiveControlPlatform,
    source: value.source as AnalysisScope['source'],
  }
}
export function validateAnalysisScope(input: unknown): AnalysisScope {
  const value = analysisObject(input, ['accountId', 'platform', 'source'])
  return { accountId: analysisString(value.accountId), ...validateMappingScope(value) }
}
export function analysisId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    return invalid()
  return value
}
/** Validate IPC objects before lookup: no getters or prototype keys are executed. */
export function assertBoundedJson(input: unknown): void {
  const stack = [{ value: input, depth: 0 }]
  const seen = new Set<object>()
  let budget = 4 * 1024 * 1024
  let nodes = 0
  while (stack.length) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number }
    if (++nodes > 100000 || depth > 16) invalid()
    if (value === null || typeof value === 'boolean') {
      budget -= 5
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid()
      budget -= 24
      continue
    }
    if (typeof value === 'string') {
      budget -= value.length * 3 + 2
      if (budget < 0) invalid()
      continue
    }
    if (!value || typeof value !== 'object' || seen.has(value)) invalid()
    seen.add(value)
    if (!Array.isArray(value)) analysisObject(value)
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid()
      budget -= key.length * 3 + 4
      if (budget < 0 || stack.length > 100000) invalid()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) invalid()
      stack.push({ value: descriptor.value, depth: depth + 1 })
    }
  }
}
export function validateAnalysisCommand(input: unknown): AnalysisCommand {
  assertBoundedJson(input)
  const root = analysisObject(input, ['action', 'params'])
  if (typeof root.action !== 'string' || !Object.hasOwn(parameterKeys, root.action)) invalid()
  const action = root.action as AnalysisAction
  const p = analysisObject(root.params, parameterKeys[action])
  if (parameterKeys[action].includes('scope')) validateAnalysisScope(p.scope)
  if (parameterKeys[action].includes('accountId')) analysisString(p.accountId)
  if (parameterKeys[action].includes('platform')) validateMappingScope(p)
  for (const key of ['sessionId', 'jobId'])
    if (parameterKeys[action].includes(key)) analysisId(p[key])
  if (parameterKeys[action].includes('requestId')) analysisString(p.requestId, 128)
  if (parameterKeys[action].includes('revision')) analysisInteger(p.revision)
  if (action === 'reanalyze') analysisInteger(p.mappingVersion, 1)
  if (action === 'mappings' && p.version !== undefined) analysisInteger(p.version, 1)
  if (p.rollbackFromVersion !== undefined) analysisInteger(p.rollbackFromVersion, 1)
  if (parameterKeys[action].includes('previewToken')) analysisString(p.previewToken, 128)
  if (p.limit !== undefined) analysisInteger(p.limit, 1, 100)
  if (p.cursor !== undefined) analysisString(p.cursor, 2048)
  if (p.sampleRange !== undefined) {
    const range = analysisObject(p.sampleRange, ['start', 'end'])
    if (range.start !== undefined) analysisInteger(range.start, 1)
    if (range.end !== undefined) analysisInteger(range.end, 1)
    if (
      range.start !== undefined &&
      range.end !== undefined &&
      Number(range.end) < Number(range.start)
    )
      invalid()
  }
  if (action === 'mapping-draft')
    analysisObject(p.draft, ['definitions', 'identity', 'acceptedFormatVersions'])
  if (action === 'groups-apply' || action === 'groups-simulate') {
    const config = analysisObject(p.config, ['enabled', 'items'])
    if (
      typeof config.enabled !== 'boolean' ||
      !Array.isArray(config.items) ||
      config.items.length > 100
    )
      invalid()
  }
  if (action === 'groups-simulate') {
    const groupInput = analysisObject(p.input)
    validateAnalysisScope(groupInput.scope)
    if (groupInput.userId !== undefined) analysisString(groupInput.userId)
  }
  return JSON.parse(JSON.stringify(input)) as AnalysisCommand
}
