import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AssistantDeskService } from '../electron/main/services/assistantDesk/AssistantDeskService'
import { MockRuntime } from '../electron/main/services/mockAssistant/MockRuntime'
import type { AssistantDeskState } from '../shared/assistantDesk'
import type { MockBatch } from '../shared/mockAssistant'

const accountId = 'account'
const revision = 'a'.repeat(64)
const batch = (): MockBatch => ({
  version: 1,
  accountId,
  metadataRevision: revision,
  batchId: 'batch',
  name: 'Lab',
  durationMs: 1000,
  users: [{ id: 'viewer', nickname: 'Synthetic', payLevel: 25, manualCountry: 'TH' }],
  events: [{ id: 'comment', userId: 'viewer', atMs: 0, kind: 'comment', text: 'hello' }],
})
const state = async (service: AssistantDeskService) => {
  const result = await service.execute({ action: 'state', params: { accountId } })
  assert.ok(result.ok)
  return result.data as AssistantDeskState
}
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition did not settle')
}

test('prepare stages validated data without selecting or creating a service; metadata is checked again at start', async () => {
  let creates = 0
  let currentRevision = revision
  const runtime = new MockRuntime({
    getMetadataRevision: async () => currentRevision,
    createDesk: () => {
      creates++
      throw new Error('must not create')
    },
  })
  const input = batch()
  assert.equal((await runtime.prepare(accountId, input)).phase, 'prepared')
  input.name = 'mutated'
  assert.equal(runtime.status(accountId).batch?.name, 'Lab')
  assert.equal(runtime.isSelected(accountId), false)
  assert.equal(runtime.peekService(accountId), undefined)
  assert.equal(creates, 0)
  currentRevision = 'b'.repeat(64)
  await assert.rejects(runtime.start(accountId), { code: 'MOCK_METADATA_STALE' })
  assert.equal(creates, 0)
  await assert.rejects(runtime.prepare('other', batch()), { code: 'MOCK_ACCOUNT_MISMATCH' })
  await runtime.clear(accountId)
  assert.equal(
    runtime.isSelected(accountId),
    false,
    'clearing an unselected prepared batch must preserve the real source',
  )
  assert.equal(runtime.status(accountId).phase, 'idle')
  assert.equal(creates, 0)
})

test('mock lifecycle keeps replay and query history in RAM, retains an active review scene, and clears by replacing the service', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'oba-mock-runtime-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  let creates = 0
  let sends = 0
  const runtime = new MockRuntime({
    getMetadataRevision: () => revision,
    createDesk: async (_account, startCapture, { runId }) => {
      creates++
      const service = new AssistantDeskService(
        join(parent, 'not-created'),
        {
          startCapture,
          send: async () => {
            sends++
          },
          interpret: async () => '{}',
        },
        { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId } },
      )
      const initial = await state(service)
      await service.execute({
        action: 'context-save',
        params: {
          accountId,
          expectedRevision: initial.context.revision,
          context: { ...initial.context, translationEnabled: false },
        },
      })
      return service
    },
  })
  try {
    await runtime.prepare(accountId, batch())
    assert.equal((await runtime.start(accountId)).selected, true)
    await waitFor(() => runtime.status(accountId).emitted === 1)
    const first = await runtime.serviceFor(accountId)
    assert.equal(runtime.peekService(accountId), first)
    const live = await state(first)
    assert.equal(live.activeSession?.status, 'collecting')
    assert.equal(live.rows[0]?.payLevel, 25)
    assert.equal(live.rows[0]?.provenance?.runId, runtime.status(accountId).runId)
    assert.equal(runtime.status(accountId).phase, 'running')
    await runtime.stop(accountId)
    assert.equal(runtime.isSelected(accountId), true)
    assert.equal(await runtime.serviceFor(accountId), first)
    const history = await first.execute({ action: 'timeline', params: { accountId } })
    assert.ok(history.ok)
    assert.equal((history.data as { items: unknown[] }).items.length, 1)
    await runtime.start(accountId)
    await waitFor(() => runtime.status(accountId).emitted === 1)
    await runtime.stop(accountId)
    const secondHistory = await first.execute({ action: 'timeline', params: { accountId } })
    assert.ok(secondHistory.ok)
    assert.equal((secondHistory.data as { items: unknown[] }).items.length, 2)
    await runtime.clear(accountId)
    assert.equal(runtime.peekService(accountId), undefined)
    assert.equal(runtime.status(accountId).batch, undefined)
    assert.equal(runtime.isSelected(accountId), true)
    const blank = await runtime.serviceFor(accountId)
    assert.notEqual(blank, first)
    assert.equal((await state(blank)).rows.length, 0)
    assert.equal(creates, 2)
    assert.equal((await first.execute({ action: 'state', params: { accountId } })).ok, false)
    await runtime.leave(accountId)
    assert.equal(runtime.isSelected(accountId), false)
    await assert.rejects(runtime.serviceFor(accountId), { code: 'MOCK_NOT_SELECTED' })
    assert.equal(sends, 0)
    assert.deepEqual(await readdir(parent), [])
  } finally {
    await runtime.leave(accountId)
  }
})

test('stop cancels delayed mock events and clear invalidates an asynchronous factory before playback', async () => {
  let finishFactory!: () => void
  let delay = false
  let started = false
  const gate = new Promise<void>(resolve => {
    finishFactory = resolve
  })
  const runtime = new MockRuntime({
    getMetadataRevision: () => revision,
    createDesk: async (_account, startCapture, { runId }) => {
      started = true
      if (delay) await gate
      return new AssistantDeskService(
        '',
        { startCapture, send: async () => {}, interpret: async () => '{}' },
        { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId } },
      )
    },
  })
  const input = batch()
  input.events[0].atMs = 500
  await runtime.prepare(accountId, input)
  await runtime.start(accountId)
  await runtime.stop(accountId)
  assert.equal(runtime.status(accountId).emitted, 0)
  assert.equal((await state(await runtime.serviceFor(accountId))).rows.length, 0)
  await runtime.leave(accountId)
  delay = true
  started = false
  await runtime.prepare(accountId, batch())
  const start = runtime.start(accountId)
  await waitFor(() => started)
  const clear = runtime.clear(accountId)
  finishFactory()
  await assert.rejects(start, { code: 'MOCK_CANCELLED' })
  await clear
  assert.equal(runtime.status(accountId).phase, 'idle')
  assert.equal(runtime.status(accountId).emitted, 0)
  await runtime.leave(accountId)
})

test('runtime rejects a durable or automatic-send factory rather than accepting mock writes to the real store', async () => {
  let service!: AssistantDeskService
  const runtime = new MockRuntime({
    getMetadataRevision: () => revision,
    createDesk: (_account, startCapture, { runId }) => {
      service = new AssistantDeskService(
        '',
        { startCapture, send: async () => {}, interpret: async () => '{}' },
        { storage: 'memory', provenance: { mode: 'mock', runId } },
      )
      return service
    },
  })
  await runtime.prepare(accountId, batch())
  await assert.rejects(runtime.start(accountId), { code: 'MOCK_UNSAFE_FACTORY' })
  assert.equal((await service.execute({ action: 'state', params: { accountId } })).ok, false)
  await runtime.leave(accountId)
})

test('a zero-offset batch larger than the ingest queue preserves every event and explicit gift totals across replays', async () => {
  const input = batch()
  input.events = Array.from({ length: 300 }, (_, index) => ({
    id: `event-${index}`,
    userId: 'viewer',
    atMs: 0,
    kind: 'like' as const,
    likeCount: 2,
  }))
  input.events.push({
    id: 'gift',
    userId: 'viewer',
    atMs: 0,
    kind: 'gift',
    gift: { groupId: 'group', count: 3, final: true, totalCoins: 10 },
  })
  const runtime = new MockRuntime({
    getMetadataRevision: () => revision,
    createDesk: (_account, startCapture, { runId }) =>
      new AssistantDeskService(
        '',
        { startCapture, send: async () => {}, interpret: async () => '{}' },
        { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId } },
      ),
  })
  try {
    await runtime.prepare(accountId, input)
    for (let replay = 1; replay <= 2; replay++) {
      await runtime.start(accountId)
      await waitFor(() => runtime.status(accountId).emitted === input.events.length)
      const current = await state(await runtime.serviceFor(accountId))
      assert.equal(current.health.dropped, 0)
      assert.equal(current.audience[0]?.finalGiftGroups, replay)
      assert.equal(current.audience[0]?.knownGiftCoins, replay * 10)
      await runtime.stop(accountId)
    }
  } finally {
    await runtime.leave(accountId)
  }
})

test('clear cancels model ownership and a late ignored-abort result cannot change a new blank RAM service', async () => {
  let resolveModel!: (value: string) => void
  let modelSignal: AbortSignal | undefined
  const model = new Promise<string>(resolve => {
    resolveModel = resolve
  })
  const runtime = new MockRuntime({
    getMetadataRevision: () => revision,
    createDesk: (_account, startCapture, { runId }) =>
      new AssistantDeskService(
        '',
        {
          startCapture,
          send: async () => {
            assert.fail('no automatic send')
          },
          interpret: async (_a, _prompt, signal) => {
            modelSignal = signal
            return model
          },
        },
        { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId } },
      ),
  })
  try {
    await runtime.prepare(accountId, batch())
    await runtime.start(accountId)
    await waitFor(() => !!modelSignal)
    const previous = await runtime.serviceFor(accountId)
    await runtime.clear(accountId)
    assert.equal(modelSignal?.aborted, true)
    const blank = await runtime.serviceFor(accountId)
    resolveModel(JSON.stringify({ language: 'en', chinese: '迟到译文' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((await state(blank)).rows.length, 0)
    assert.equal((await previous.execute({ action: 'state', params: { accountId } })).ok, false)
  } finally {
    resolveModel('{}')
    await runtime.leave(accountId)
  }
})

test('shutdown closes admission immediately and disposes a late factory without allowing playback', async () => {
  let releaseFactory!: () => void
  let entered = false
  let created: AssistantDeskService | undefined
  const gate = new Promise<void>(resolve => {
    releaseFactory = resolve
  })
  const runtime = new MockRuntime({
    getMetadataRevision: () => revision,
    createDesk: async (_account, startCapture, { runId }) => {
      entered = true
      await gate
      created = new AssistantDeskService(
        '',
        {
          startCapture,
          send: async () => {
            assert.fail('no send')
          },
          interpret: async () => {
            assert.fail('no model call')
          },
        },
        { storage: 'memory', manualOnly: true, provenance: { mode: 'mock', runId } },
      )
      return created
    },
  })
  await runtime.prepare(accountId, batch())
  const starting = runtime.start(accountId)
  await waitFor(() => entered)
  const clearing = runtime.clear(accountId)
  const shutdown = runtime.shutdown()
  await assert.rejects(runtime.prepare(accountId, batch()), { code: 'MOCK_SHUTDOWN' })
  await assert.rejects(runtime.start(accountId), { code: 'MOCK_SHUTDOWN' })
  await assert.rejects(runtime.serviceFor(accountId), { code: 'MOCK_SHUTDOWN' })
  releaseFactory()
  await assert.rejects(starting, { code: 'MOCK_CANCELLED' })
  await clearing
  await shutdown
  await runtime.shutdown()
  assert.equal(runtime.isSelected(accountId), false)
  assert.equal(runtime.status(accountId).emitted, 0)
  assert.equal(runtime.peekService(accountId), undefined)
  assert.ok(created)
  assert.equal((await created.execute({ action: 'state', params: { accountId } })).ok, false)
})
