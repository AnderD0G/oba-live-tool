import assert from 'node:assert/strict'
import test from 'node:test'
import { MockCaptureSource } from '../electron/main/services/mockAssistant/MockCaptureSource'
import type { MockBatch } from '../shared/mockAssistant'

const batch: MockBatch = {
  version: 1,
  accountId: 'account',
  metadataRevision: 'a'.repeat(64),
  batchId: 'batch',
  name: 'Test',
  durationMs: 1000,
  users: [
    {
      id: 'viewer',
      nickname: 'Synthetic',
      payLevel: 24,
      fansClubLevel: 3,
      followStatus: 2,
      manualCountry: 'TH',
    },
  ],
  events: [
    { id: 'one', userId: 'viewer', kind: 'comment', atMs: 0, text: 'hello' },
    {
      id: 'two',
      userId: 'viewer',
      kind: 'gift',
      atMs: 0,
      gift: { id: 'rose', groupId: 'streak', count: 3, final: true, unitCoins: 1 },
    },
  ],
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('mock source emits only through its lease, normalizes explicit profiles and serializes ingest', async () => {
  let unblock!: () => void
  const first = new Promise<void>(resolve => {
    unblock = resolve
  })
  const messages: (Record<string, unknown> & { metadata?: { provenance?: string } })[] = []
  let ingested = 0
  let emitted = 0
  const source = new MockCaptureSource({
    runId: 'run',
    afterEmit: async () => {
      if (++ingested === 1) await first
    },
    onEmitted: value => {
      emitted = value
    },
  })
  source.prepare(batch)
  const lease = await source.startCapture('account', 'scene', message => {
    messages.push(message as unknown as (typeof messages)[number])
  })
  assert.equal(messages.length, 0, 'capture acquisition must not race session persistence')
  source.play()
  await tick()
  assert.equal(messages.length, 1)
  assert.equal(emitted, 0, 'only committed ingest contributes to the playback count')
  assert.equal(messages[0].user_id, 'mock:run:viewer')
  assert.equal(messages[0].pay_level, 24)
  assert.deepEqual(messages[0].public_profile, { followStatus: 2 })
  assert.equal(messages[0].metadata?.provenance, 'mock')
  unblock()
  await tick()
  assert.equal(messages.length, 2)
  assert.equal(emitted, 2)
  assert.equal(messages[1].repeat_end, true)
  assert.equal(messages[1].gift_type, 1)
  assert.equal(messages[1].group_id, 'mock:run:streak')
  await lease.release()
})

test('releasing a mock capture cancels future events and cannot replay after release', async () => {
  const messages: LiveMessage[] = []
  const source = new MockCaptureSource({ runId: 'run' })
  source.prepare({ ...batch, events: [{ ...batch.events[0], atMs: 30 }] })
  const lease = await source.startCapture('account', 'scene', message => messages.push(message))
  source.play()
  await lease.release()
  await new Promise(resolve => setTimeout(resolve, 40))
  source.play()
  assert.equal(messages.length, 0)
})
