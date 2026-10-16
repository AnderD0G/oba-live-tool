import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMockMetadata } from '../electron/main/services/mockAssistant/MockMetadata'
import { defaultAudiencePolicy } from '../shared/assistantAudiencePolicy'
import { validateMockBatch } from '../shared/mockAssistant'

const revision = 'a'.repeat(64)
const batch = () => ({
  version: 1,
  accountId: 'default',
  metadataRevision: revision,
  batchId: 'batch-1',
  name: '多语言边界',
  durationMs: 1000,
  users: [{ id: 'person-1', nickname: '模拟观众', payLevel: 15, manualCountry: 'TH' }],
  events: [{ id: 'event-1', userId: 'person-1', atMs: 10, kind: 'comment', text: 'ราคาเท่าไหร่?' }],
})

test('mock batches preserve multilingual originals and validate references without mutating their input', () => {
  const input = batch()
  const value = validateMockBatch(input, 'default', revision)
  assert.deepEqual(value, input)
  value.users[0].nickname = 'changed'
  assert.equal(input.users[0].nickname, '模拟观众')
})

test('unknown fields, duplicate identities, orphan events, invalid kinds and excessive batches fail closed', () => {
  for (const invalid of [
    { ...batch(), start: true },
    { ...batch(), constructor: { start: true } },
    JSON.parse(`${JSON.stringify(batch()).slice(0, -1)},"__proto__":{"start":true}}`),
    { ...batch(), users: [{ ...batch().users[0], apiKey: 'must-not-be-stored' }] },
    { ...batch(), users: [batch().users[0], batch().users[0]] },
    { ...batch(), events: [batch().events[0], batch().events[0]] },
    { ...batch(), events: [{ ...batch().events[0], userId: 'not-a-user' }] },
    { ...batch(), events: [{ ...batch().events[0], kind: 'send' }] },
    { ...batch(), events: [{ ...batch().events[0], kind: 'enter' }] },
    { ...batch(), events: [{ ...batch().events[0], text: 'x'.repeat(2001) }] },
    { ...batch(), events: [{ ...batch().events[0], atMs: 1001 }] },
    {
      ...batch(),
      events: [
        {
          id: 'gift-1',
          userId: 'person-1',
          atMs: 0,
          kind: 'gift',
          gift: { count: 2, final: true, unitCoins: 3, totalCoins: 99 },
        },
      ],
    },
    { ...batch(), durationMs: 1800001 },
    {
      ...batch(),
      users: Array.from({ length: 1001 }, (_, index) => ({ id: `u${index}`, nickname: 'mock' })),
    },
    {
      ...batch(),
      events: Array.from({ length: 5001 }, (_, index) => ({
        ...batch().events[0],
        id: `e${index}`,
      })),
    },
  ])
    assert.throws(() => validateMockBatch(invalid), { code: 'MOCK_INVALID_BATCH' })
  assert.throws(() => validateMockBatch(batch(), 'other'), { code: 'MOCK_ACCOUNT_MISMATCH' })
  assert.throws(() => validateMockBatch(batch(), 'default', 'b'.repeat(64)), {
    code: 'MOCK_METADATA_STALE',
  })
})

test('metadata projects only the current policy and public catalog and revisions change with that policy', () => {
  const policy = defaultAudiencePolicy()
  const input = {
    accountId: 'default',
    policy,
    audience: [{ nickname: 'REAL-VIEWER' }],
    apiKey: 'PRIVATE-KEY',
    knowledge: 'PRIVATE-KNOWLEDGE',
  }
  const metadata = buildMockMetadata(input)
  assert.equal(metadata.accountId, 'default')
  assert.equal(metadata.scope, 'mock')
  assert.ok(metadata.catalog.fields.some(field => field.field === 'payLevel'))
  assert.ok(metadata.catalog.languages?.some(language => language.code === 'th'))
  assert.deepEqual(metadata.policy, policy)
  assert.match(metadata.metadataRevision, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(metadata), /REAL-VIEWER|PRIVATE-KEY|PRIVATE-KNOWLEDGE/)
  assert.equal(
    buildMockMetadata({ accountId: 'default', policy }).metadataRevision,
    metadata.metadataRevision,
  )
  const copied = buildMockMetadata({
    accountId: 'default',
    policy: { ...policy, revision: policy.revision + 1 },
  })
  assert.equal(copied.metadataRevision, metadata.metadataRevision)
  assert.equal(copied.policy.revision, policy.revision + 1)
  const changed = structuredClone(policy)
  changed.rules[0].conditions[0].value = 16
  assert.notEqual(
    buildMockMetadata({ accountId: 'default', policy: changed }).metadataRevision,
    metadata.metadataRevision,
  )
  assert.notEqual(
    buildMockMetadata({ accountId: 'other', policy }).metadataRevision,
    metadata.metadataRevision,
  )
  assert.equal(
    validateMockBatch(metadata.example, 'default', metadata.metadataRevision).events.length,
    1,
  )
})

test('the RAM contract enforces the UTF-8 byte cap even when every original fits its own text limit', () => {
  const input = {
    ...batch(),
    durationMs: 1000,
    events: Array.from({ length: 500 }, (_, index) => ({
      id: `e${index}`,
      userId: 'person-1',
      atMs: 0,
      kind: 'comment',
      text: 'ก'.repeat(2000),
    })),
  }
  assert.throws(() => validateMockBatch(input), { code: 'MOCK_BATCH_TOO_LARGE' })
})
