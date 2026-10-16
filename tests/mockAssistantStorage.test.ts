import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AssistantDeskDerivedIndex } from '../electron/main/services/assistantDesk/AssistantDeskDerivedIndex'
import { AssistantDeskService } from '../electron/main/services/assistantDesk/AssistantDeskService'
import { MemoryAssistantDeskJournal } from '../electron/main/services/assistantDesk/MemoryAssistantDeskJournal'
import type {
  AssistantDeskCommand,
  AssistantDeskContext,
  AssistantDeskResult,
  AssistantDeskState,
} from '../shared/assistantDesk'

const accountId = 'account'
const value = <T>(result: AssistantDeskResult): T => {
  assert.ok(result.ok)
  return result.data as T
}

test('RAM journal snapshots records, filters history and enforces guards without an export or backup', async () => {
  const journal = new MemoryAssistantDeskJournal()
  const record = { type: 'row', accountId, at: 10, data: { id: 'row', text: 'first' } }
  await journal.append(record)
  record.data.text = 'mutated outside'
  await journal.append({
    type: 'row',
    accountId: 'other',
    at: 11,
    data: { id: 'row', text: 'other' },
  })
  await assert.rejects(
    journal.append({ ...record, at: 12 }, () => false),
    { code: 'REPLY_CHANGED' },
  )
  const rows = []
  for await (const row of journal.read(true, { accountId })) rows.push(row)
  assert.equal(rows.length, 1)
  assert.equal((rows[0].data as typeof record.data).text, 'first')
  assert.equal((await journal.latest('row', accountId, 'row'))?.at, 10)
  await journal.metadata({ private: 'not exported' })
  const status = await journal.status()
  assert.equal(status.engine, 'memory')
  assert.equal(status.recordCount, 2)
  assert.equal(journal.dropped, 0)
  await assert.rejects(journal.backup(), { code: 'MOCK_VOLATILE_STORAGE' })
  await journal.close()
  await assert.rejects(journal.append(record))
})

test('RAM derived indexes retain exact values after cache eviction and never create their folder', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'oba-mock-derived-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const folder = join(parent, 'never-created')
  const index = new AssistantDeskDerivedIndex(folder, { memory: true })
  try {
    const map = index.map<{ accountIds: string[]; lastSeenAt: number }>('audiences', 1, {
      audience: true,
    })
    map.set('one', { accountIds: [accountId], lastSeenAt: 1 })
    map.set('two', { accountIds: [accountId], lastSeenAt: 2 })
    assert.equal(map.get('one')?.lastSeenAt, 1)
    assert.equal(index.recentAudiences(accountId, 5).length, 2)
    assert.equal(existsSync(folder), false)
  } finally {
    index.close()
  }
  assert.deepEqual(await readdir(parent), [])
})

test('ephemeral assistant stores sessions and history in RAM with explicit provenance', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'oba-mock-service-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  let receive!: (message: LiveMessage) => void
  const service = new AssistantDeskService(
    join(parent, 'never-created'),
    {
      interpret: async () => JSON.stringify({ language: 'en', chinese: '你好' }),
      send: async () => {},
      startCapture: async (_a, _s, listener) => {
        receive = listener
        return { captureSessionId: 'mock-capture', release: async () => {} }
      },
    },
    { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId: 'mock-run' } },
  )
  try {
    assert.ok((await service.execute({ action: 'start', params: { accountId } })).ok)
    receive({
      msg_type: 'tiktok_comment',
      msg_id: 'event',
      user_id: 'mock-user',
      unique_id: 'mock-user',
      nick_name: 'Mock',
      content: 'hello',
      time: Date.now(),
    } as LiveMessage)
    let state!: AssistantDeskState
    for (let i = 0; i < 30; i++) {
      state = value(await service.execute({ action: 'state', params: { accountId } }))
      if (state.rows.length) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(state.rows.length, 1)
    assert.equal(state.database?.engine, 'memory')
    assert.equal(state.provenance?.mode, 'mock')
    assert.equal(state.rows[0].provenance?.runId, 'mock-run')
    await service.execute({ action: 'stop', params: { accountId } })
    const history = value<{ items: unknown[] }>(
      await service.execute({ action: 'timeline', params: { accountId } }),
    )
    assert.equal(history.items.length, 1)
  } finally {
    await service.shutdown()
  }
  assert.deepEqual(await readdir(parent), [])
})

test('mock manualOnly converts uploaded auto policies to review and never calls send before explicit approval', async () => {
  let receive!: (message: LiveMessage) => void
  let sends = 0
  const service = new AssistantDeskService(
    '',
    {
      interpret: async () =>
        JSON.stringify({
          language: 'en',
          chinese: '你好',
          reply: 'Hello',
          replyChinese: '你好',
          needsReview: false,
          evidence: ['hello'],
        }),
      send: async () => {
        sends++
      },
      startCapture: async (_a, _s, callback) => {
        receive = callback
        return { release: async () => {} }
      },
    },
    { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId: 'manual' } },
  )
  const command = (action: AssistantDeskCommand['action'], params: Record<string, unknown> = {}) =>
    service.execute({ action, params: { accountId, ...params } } as AssistantDeskCommand)
  try {
    const initial = value<AssistantDeskState>(await command('state'))
    const context = value<AssistantDeskContext>(
      await command('context-save', {
        expectedRevision: initial.context.revision,
        context: { ...initial.context, replyMode: 'auto' },
      }),
    )
    assert.equal(context.replyMode, 'review')
    const policy = value<{ rules: { mode: string }[] }>(
      await command('reply-policy-save', {
        expectedRevision: 1,
        policy: {
          enabled: true,
          rules: [
            {
              id: 'reply',
              enabled: true,
              action: 'comment',
              mode: 'auto',
              priority: 1,
              knowledge: 'hello',
              instructions: '',
            },
          ],
        },
      }),
    )
    assert.equal(policy.rules[0].mode, 'review')
    await command('start')
    receive({
      msg_type: 'tiktok_comment',
      msg_id: 'auto',
      user_id: 'user',
      unique_id: 'user',
      nick_name: 'Mock',
      pay_level: 30,
      follower_count: 200,
      content: 'hello',
      time: Date.now(),
    } as LiveMessage)
    let current!: AssistantDeskState
    for (let i = 0; i < 100; i++) {
      current = value(await command('state'))
      if (current.rows[0]?.reply.status === 'review') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(current.rows[0]?.reply.status, 'review')
    assert.equal(sends, 0)
    assert.ok(
      (
        await command('reply-approve', {
          rowId: current.rows[0].id,
          expectedText: 'Hello',
          requestId: 'human-click',
        })
      ).ok,
    )
    assert.equal(sends, 1)
  } finally {
    await service.shutdown()
  }
})

test('mock audience seed contributes levels and explicit manual country to the first event classification', async () => {
  let receive!: (message: LiveMessage) => void
  const service = new AssistantDeskService(
    '',
    {
      interpret: async () => '{}',
      send: async () => {},
      startCapture: async (_a, _s, callback) => {
        receive = callback
        return { release: async () => {} }
      },
    },
    { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId: 'seed' } },
  )
  const command = (action: AssistantDeskCommand['action'], params: Record<string, unknown> = {}) =>
    service.execute({ action, params: { accountId, ...params } } as AssistantDeskCommand)
  try {
    const initial = value<AssistantDeskState>(await command('state'))
    await command('context-save', {
      expectedRevision: initial.context.revision,
      context: { ...initial.context, translationEnabled: false },
    })
    await command('policy-save', {
      expectedRevision: 1,
      policy: {
        enabled: true,
        rules: [
          {
            id: 'manual-th',
            label: 'Thai test',
            enabled: true,
            priority: 1,
            conditions: [
              { field: 'manualCountry', operator: 'eq', value: 'TH' },
              { field: 'payLevel', operator: 'gte', value: 20 },
            ],
            result: { tier: 'gold', label: '重点', autoAttention: true },
          },
        ],
      },
    })
    await service.seedMockAudience(accountId, [
      {
        userId: 'mock-user',
        nickname: 'Mock',
        payLevel: 25,
        fansClubLevel: 3,
        manualCountry: 'TH',
      },
    ])
    await command('start')
    receive({
      msg_type: 'tiktok_comment',
      msg_id: 'seeded',
      user_id: 'mock-user',
      unique_id: 'mock-user',
      nick_name: 'Mock',
      content: 'hello',
      time: Date.now(),
    } as LiveMessage)
    let current!: AssistantDeskState
    for (let i = 0; i < 50; i++) {
      current = value(await command('state'))
      if (current.rows.length) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(current.rows[0]?.payLevel, 25)
    assert.equal(current.rows[0]?.triage?.matchedRuleId, 'manual-th')
    assert.equal(current.audience[0]?.enters, 0)
    assert.equal(current.audience[0]?.comments, 1)
  } finally {
    await service.shutdown()
  }
})
