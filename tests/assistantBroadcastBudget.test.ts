import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantDeskService } from '../electron/main/services/assistantDesk/AssistantDeskService'
import type { AssistantDeskState } from '../shared/assistantDesk'

test('freeform translations have a bounded manual budget without inventing a capture or viewer', async t => {
  let calls = 0
  const desk = new AssistantDeskService('/unused-memory', {
    interpret: async () => { throw Error('not interpretation') },
    translateDraft: async (_id, input) => { calls++; return input.chinese },
    send: async () => { throw Error('not a send') },
    startCapture: async () => { throw Error('not a capture') },
  }, { storage: 'memory' })
  t.after(() => desk.shutdown())
  const initial = await desk.execute({ action: 'state', params: { accountId: 'default' } })
  assert.ok(initial.ok)
  const state = initial.data as AssistantDeskState
  assert.ok((await desk.execute({ action: 'context-save', params: { accountId: 'default', expectedRevision: state.context.revision, context: { ...state.context, aiRequestLimit: 1 } } })).ok)
  assert.equal(await desk.translateFreeformDraft('default', { chinese: '补货中', targetLanguage: 'en' }, new AbortController().signal), '补货中')
  await assert.rejects(desk.translateFreeformDraft('default', { chinese: '再次翻译', targetLanguage: 'en' }, new AbortController().signal), /上限/)
  assert.equal(calls, 1)
  const after = await desk.execute({ action: 'state', params: { accountId: 'default' } })
  assert.ok(after.ok)
  const current = after.data as AssistantDeskState
  assert.equal(current.activeSession, undefined)
  assert.equal(current.sessions.length, 0)
  assert.equal(current.rows.length, 0)
})

test('a paused or aborted freeform translation never invokes a provider', async t => {
  let calls = 0
  const desk = new AssistantDeskService('/unused-memory', {
    interpret: async () => '', translateDraft: async () => { calls++; return 'x' },
    send: async () => {}, startCapture: async () => ({ release: async () => {} }),
  }, { storage: 'memory' })
  t.after(() => desk.shutdown())
  const first = await desk.execute({ action: 'state', params: { accountId: 'default' } })
  assert.ok(first.ok)
  const state = first.data as AssistantDeskState
  assert.ok((await desk.execute({ action: 'context-save', params: { accountId: 'default', expectedRevision: state.context.revision, context: { ...state.context, aiPaused: true } } })).ok)
  await assert.rejects(desk.translateFreeformDraft('default', { chinese: '你好', targetLanguage: 'en' }, new AbortController().signal), /暂停/)
  assert.equal(calls, 0)
})
