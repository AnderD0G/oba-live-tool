export interface MockUser {
  id: string
  nickname: string
  payLevel?: number
  fansClubLevel?: number
  followerCount?: number
  followingCount?: number
  followStatus?: number
  subscriptionActive?: true
  manualCountry?: string
}
export interface MockGift {
  id?: string
  name?: string
  groupId?: string
  count: number
  final: boolean
  unitCoins?: number
  totalCoins?: number
}
export interface MockEvent {
  id: string
  userId: string
  atMs: number
  kind: 'comment' | 'enter' | 'leave' | 'follow' | 'like' | 'gift' | 'event'
  text?: string
  likeCount?: number
  gift?: MockGift
}
export interface MockBatch {
  version: 1
  accountId: string
  metadataRevision: string
  batchId: string
  name: string
  durationMs: number
  users: MockUser[]
  events: MockEvent[]
}
export interface MockRuntimeStatus {
  accountId: string
  selected: boolean
  phase: 'idle' | 'prepared' | 'running' | 'stopped'
  volatile: true
  batch?: {
    batchId: string
    name: string
    metadataRevision: string
    userCount: number
    eventCount: number
    durationMs: number
  }
  runId?: string
  emitted: number
  error?: { code: string; message: string }
}
export interface MockApiAccessStatus {
  active: boolean
  accountId: string
  urls: string[]
  token?: string
}

import { isCountryCode } from './assistantAudiencePolicy'

export const MOCK_LIMITS = Object.freeze({
  maxBodyBytes: 2 * 1024 * 1024,
  maxUsers: 1000,
  maxEvents: 5000,
  maxDurationMs: 30 * 60 * 1000,
  maxTextLength: 2000,
  maxNicknameLength: 100,
})
export const MOCK_EVENT_KINDS = [
  'comment',
  'enter',
  'leave',
  'follow',
  'like',
  'gift',
  'event',
] as const

export interface MockJsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean'
  properties?: Record<string, MockJsonSchema>
  required?: readonly string[]
  additionalProperties?: false
  items?: MockJsonSchema
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
  enum?: readonly unknown[]
  const?: unknown
  oneOf?: readonly MockJsonSchema[]
}
const object = (
  properties: Record<string, MockJsonSchema>,
  required: string[],
): MockJsonSchema => ({ type: 'object', additionalProperties: false, properties, required })
const integer = (minimum: number, maximum = 1_000_000_000): MockJsonSchema => ({
  type: 'integer',
  minimum,
  maximum,
})
const id: MockJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
}
const label: MockJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
}
const text: MockJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MOCK_LIMITS.maxTextLength,
  pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$',
}
export const MOCK_USER_SCHEMA = object(
  {
    id,
    nickname: label,
    payLevel: integer(0, 10000),
    fansClubLevel: integer(0, 10000),
    followerCount: integer(0),
    followingCount: integer(0),
    followStatus: { type: 'integer', enum: [1, 2] },
    subscriptionActive: { type: 'boolean', const: true },
    manualCountry: { type: 'string', pattern: '^[A-Z]{2}$' },
  },
  ['id', 'nickname'],
)
export const MOCK_GIFT_SCHEMA = object(
  {
    id,
    name: label,
    groupId: id,
    count: integer(1, 1_000_000),
    final: { type: 'boolean' },
    unitCoins: integer(0, 1_000_000_000_000),
    totalCoins: integer(0, 1_000_000_000_000),
  },
  ['count', 'final'],
)
export const MOCK_EVENT_SCHEMA: MockJsonSchema = {
  oneOf: MOCK_EVENT_KINDS.map(kind =>
    object(
      {
        id,
        userId: id,
        atMs: integer(0, MOCK_LIMITS.maxDurationMs),
        kind: { type: 'string', const: kind },
        ...(['comment', 'event'].includes(kind) ? { text } : {}),
        ...(kind === 'like' ? { likeCount: integer(1) } : {}),
        ...(kind === 'gift' ? { gift: MOCK_GIFT_SCHEMA } : {}),
      },
      [
        'id',
        'userId',
        'atMs',
        'kind',
        ...(['comment', 'event'].includes(kind) ? ['text'] : []),
        ...(kind === 'gift' ? ['gift'] : []),
      ],
    ),
  ),
}
export const MOCK_BATCH_SCHEMA = object(
  {
    version: { type: 'integer', const: 1 },
    accountId: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
    },
    metadataRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    batchId: id,
    name: label,
    durationMs: integer(1, MOCK_LIMITS.maxDurationMs),
    users: { type: 'array', minItems: 1, maxItems: MOCK_LIMITS.maxUsers, items: MOCK_USER_SCHEMA },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: MOCK_LIMITS.maxEvents,
      items: MOCK_EVENT_SCHEMA,
    },
  },
  ['version', 'accountId', 'metadataRevision', 'batchId', 'name', 'durationMs', 'users', 'events'],
)

function matches(value: unknown, schema: MockJsonSchema): boolean {
  if (schema.oneOf && schema.oneOf.filter(choice => matches(value, choice)).length !== 1)
    return false
  if ('const' in schema && value !== schema.const) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (schema.type === 'string')
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Number.POSITIVE_INFINITY) &&
      (!schema.pattern || new RegExp(schema.pattern).test(value))
    )
  if (schema.type === 'integer')
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= (schema.minimum ?? Number.NEGATIVE_INFINITY) &&
      value <= (schema.maximum ?? Number.POSITIVE_INFINITY)
    )
  if (schema.type === 'boolean') return typeof value === 'boolean'
  if (schema.type === 'array')
    return (
      Array.isArray(value) &&
      value.length >= (schema.minItems ?? 0) &&
      value.length <= (schema.maxItems ?? Number.POSITIVE_INFINITY) &&
      value.every(item => !schema.items || matches(item, schema.items))
    )
  if (schema.type === 'object') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return false
    const fields = value as Record<string, unknown>
    return (
      (schema.required ?? []).every(key => Object.hasOwn(fields, key)) &&
      Object.keys(fields).every(
        key =>
          !!schema.properties &&
          Object.hasOwn(schema.properties, key) &&
          matches(fields[key], schema.properties[key]),
      )
    )
  }
  return true
}

export class MockBatchValidationError extends Error {
  constructor(
    readonly code:
      | 'MOCK_INVALID_BATCH'
      | 'MOCK_BATCH_TOO_LARGE'
      | 'MOCK_ACCOUNT_MISMATCH'
      | 'MOCK_METADATA_STALE',
  ) {
    super(
      {
        MOCK_INVALID_BATCH: '模拟批次不符合契约，请核对字段、范围和用户引用',
        MOCK_BATCH_TOO_LARGE: '模拟批次超过2MB上限',
        MOCK_ACCOUNT_MISMATCH: '模拟批次账号与当前入口不一致',
        MOCK_METADATA_STALE: '生成依据已变化，请重新导出元数据后生成批次',
      }[code],
    )
  }
}
export function validateMockBatch(
  input: unknown,
  accountId?: string,
  metadataRevision?: string,
): MockBatch {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new MockBatchValidationError('MOCK_INVALID_BATCH')
  }
  if (serialized === undefined) throw new MockBatchValidationError('MOCK_INVALID_BATCH')
  if (new TextEncoder().encode(serialized).byteLength > MOCK_LIMITS.maxBodyBytes)
    throw new MockBatchValidationError('MOCK_BATCH_TOO_LARGE')
  if (!matches(input, MOCK_BATCH_SCHEMA)) throw new MockBatchValidationError('MOCK_INVALID_BATCH')
  const batch = input as MockBatch
  const users = new Set(batch.users.map(user => user.id))
  if (
    users.size !== batch.users.length ||
    new Set(batch.events.map(event => event.id)).size !== batch.events.length ||
    batch.users.some(
      user => user.manualCountry !== undefined && !isCountryCode(user.manualCountry),
    ) ||
    batch.events.some(
      event =>
        !users.has(event.userId) ||
        event.atMs > batch.durationMs ||
        (event.gift?.unitCoins !== undefined &&
          event.gift.totalCoins !== undefined &&
          (!Number.isSafeInteger(event.gift.unitCoins * event.gift.count) ||
            event.gift.totalCoins !== event.gift.unitCoins * event.gift.count)),
    )
  )
    throw new MockBatchValidationError('MOCK_INVALID_BATCH')
  if (accountId !== undefined && batch.accountId !== accountId)
    throw new MockBatchValidationError('MOCK_ACCOUNT_MISMATCH')
  if (metadataRevision !== undefined && batch.metadataRevision !== metadataRevision)
    throw new MockBatchValidationError('MOCK_METADATA_STALE')
  return JSON.parse(serialized)
}
