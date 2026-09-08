import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAutoReplyService } from '../electron/main/services/CodexAutoReplyService'
import type { CodexDraftResult } from '../shared/codexDraft'

const settings = { accountId: 'a', enabled: true, instructions: '友好回复' }
const comment = {
  msg_id: '1',
  msg_type: 'xiaohongshu_comment',
  nick_name: '观众',
  user_id: 'viewer',
  content: '你好',
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}
function fixture() {
  const sent: string[] = []
  let ready = true
  let confirmed = true
  let generate: () => Promise<CodexDraftResult> = async () => ({ ok: true, text: '欢迎你！' })
  const engine = new CodexAutoReplyService({
    ready: () => ready,
    hostName: () => '主播',
    busy: () => false,
    generate: () => generate(),
    cancel: () => {},
    send: async (_id, text, signal) => {
      assert.equal(signal.aborted, false)
      sent.push(text)
      return confirmed
    },
    changed: () => {},
    intervalMs: 0,
  })
  return {
    engine,
    sent,
    setReady: (value: boolean) => {
      ready = value
    },
    setConfirmed: (value: boolean) => {
      confirmed = value
    },
    setGenerate: (fn: typeof generate) => {
      generate = fn
    },
  }
}

test('auto sends only new viewer text, deduplicates and suppresses its own echo', async () => {
  const { engine, sent } = fixture()
  engine.comment('a', comment)
  engine.enable(settings)
  engine.comment('a', comment)
  engine.comment('b', { ...comment, msg_id: 'other-account' })
  engine.comment('a', { ...comment, msg_id: 'host', nick_name: '主播' })
  engine.comment('a', { ...comment, msg_id: 'event', msg_type: 'room_enter' })
  assert.equal(sent.length, 0)
  engine.comment('a', { ...comment, msg_id: '2' })
  await until(() => engine.snapshot().records[0]?.phase === 'sent')
  engine.comment('a', { ...comment, msg_id: 'echo', nick_name: '未知主播名', content: '欢迎你！' })
  engine.comment('a', { ...comment, msg_id: 'self', is_self: true, user_id: 'host-id' })
  engine.comment('a', { ...comment, msg_id: 'self-ws', user_id: 'host-id' })
  assert.equal(sent.length, 1)
  assert.equal(engine.snapshot().records.length, 1)
  engine.disable()
})

test('disabling during generation drops the pending send and queued comments', async () => {
  const { engine, sent, setGenerate } = fixture()
  let finish!: (result: CodexDraftResult) => void
  setGenerate(
    () =>
      new Promise(resolve => {
        finish = resolve
      }),
  )
  engine.enable(settings)
  engine.comment('a', comment)
  engine.comment('a', { ...comment, msg_id: '2' })
  engine.disable()
  finish({ ok: true, text: '不能发送' })
  await until(() => engine.snapshot().records.every(r => r.phase === 'cancelled'))
  assert.deepEqual(sent, [])
})

test('unconfirmed sends stop automatic processing without retrying or claiming success', async () => {
  const { engine, sent, setConfirmed } = fixture()
  setConfirmed(false)
  engine.enable(settings)
  engine.comment('a', comment)
  engine.comment('a', { ...comment, msg_id: '2' })
  await until(() => !engine.snapshot().enabled)
  assert.equal(sent.length, 1)
  assert.equal(engine.snapshot().records.find(r => r.id === '1')?.phase, 'failed')
  assert.equal(engine.snapshot().records.find(r => r.id === '2')?.phase, 'cancelled')
})

test('disconnection cancels pending work; overlong model text is never sent', async () => {
  const { engine, sent, setGenerate } = fixture()
  engine.enable(settings)
  engine.disconnected('a')
  engine.comment('a', comment)
  assert.equal(sent.length, 0)
  setGenerate(async () => ({ ok: true, text: '长'.repeat(101) }))
  engine.enable(settings)
  engine.comment('a', { ...comment, msg_id: 'new' })
  await until(() => !engine.snapshot().enabled)
  assert.equal(sent.length, 0)
})
