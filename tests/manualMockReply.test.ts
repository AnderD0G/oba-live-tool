import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ManualMockReplyGate,
  type MockReplyPermit,
} from '../electron/main/services/mockAssistant/ManualMockReplyGate'
import { matchesManualReplyTarget } from '../electron/main/services/mockAssistant/ManualReplyTarget'

const permit: MockReplyPermit = {
  accountId: 'a',
  runId: 'run',
  rowId: 'row',
  requestId: 'request',
  expectedText: 'hello',
  sessionId: 'browser',
  target: { username: 'myroom', url: 'https://www.tiktok.com/@myroom/live' },
}

test('manual target allows own or other selected room but rejects navigation, relogin and pending switches', () => {
  const state = {
    browserOpen: true,
    loginStatus: 'authenticated' as const,
    roomReady: true,
    sessionId: 'browser',
    target: permit.target,
  }
  assert.equal(matchesManualReplyTarget(state, permit), true)
  assert.equal(
    matchesManualReplyTarget(
      { ...state, target: { username: 'other', url: 'https://www.tiktok.com/@other/live' } },
      permit,
    ),
    false,
  )
  assert.equal(matchesManualReplyTarget({ ...state, sessionId: 'new-browser' }, permit), false)
  assert.equal(matchesManualReplyTarget({ ...state, busy: true }, permit), false)
  assert.equal(matchesManualReplyTarget({ ...state, roomReady: false }, permit), false)
  assert.equal(matchesManualReplyTarget({ ...state, loginStatus: 'required' }, permit), false)
})

test('mock send requires a direct approval and is one-shot even on unknown outcome', async () => {
  let sends = 0
  const gate = new ManualMockReplyGate({
    currentRun: () => 'run',
    send: async () => {
      sends++
      return false
    },
  })
  await assert.rejects(gate.send('a', '@viewer hello', new AbortController().signal))
  await gate.approve(permit, async () => {
    await assert.rejects(gate.send('a', '@viewer hello', new AbortController().signal))
    await assert.rejects(gate.send('a', '@viewer hello', new AbortController().signal))
  })
  assert.equal(sends, 1)
})

test('mock send rejects a changed run, account or draft without calling the platform', async () => {
  let run = 'run'
  let sends = 0
  const gate = new ManualMockReplyGate({
    currentRun: () => run,
    send: async () => {
      sends++
      return true
    },
  })
  await gate.approve(permit, async () => {
    await assert.rejects(gate.send('other', '@viewer hello', new AbortController().signal))
    await assert.rejects(gate.send('a', '@viewer changed', new AbortController().signal))
    run = 'new-run'
    await assert.rejects(gate.send('a', '@viewer hello', new AbortController().signal))
  })
  assert.equal(sends, 0)
})

test('concurrent approvals keep their selected real target and text separate', async () => {
  const sent: string[] = []
  const gate = new ManualMockReplyGate({
    currentRun: () => 'run',
    send: async (p, text) => {
      sent.push(`${p.target.username}:${text}`)
      return true
    },
  })
  await Promise.all([
    gate.approve(permit, async () => {
      await Promise.resolve()
      await gate.send('a', '@viewer hello', new AbortController().signal)
    }),
    gate.approve(
      {
        ...permit,
        expectedText: 'bye',
        target: { username: 'otherroom', url: 'https://www.tiktok.com/@otherroom/live' },
      },
      async () => gate.send('a', '@viewer bye', new AbortController().signal),
    ),
  ])
  assert.deepEqual(sent.sort(), ['myroom:@viewer hello', 'otherroom:@viewer bye'])
})
