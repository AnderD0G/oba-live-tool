import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { AssistantDeskService } from '../electron/main/services/assistantDesk/AssistantDeskService'
import { interpretAssistantPrompt } from '../electron/main/services/assistantDesk/interpretAssistant'
import type {
  AssistantDeskCommand,
  AssistantDeskDependencies,
  AssistantDeskResult,
  AssistantDeskRow,
  AssistantDeskState,
} from '../shared/assistantDesk'

const ambiguous = '@BeefBroccoli 1q1q'
function data<T>(result: AssistantDeskResult): T {
  assert.ok(result.ok)
  return result.data as T
}
function prompt(original: string) {
  return `Translate the comment.\nCONTROLLED_CONTEXT=${JSON.stringify({ knowledge: '', instructions: '', translationEnabled: true, replyMode: 'off' })}\nUNTRUSTED_COMMENT=${JSON.stringify({ text: original, nickname: 'Viewer' })}`
}
function modelResponse(sourceLanguage: string, translatedCommentChinese: string) {
  return JSON.stringify({
    sourceLanguage,
    translatedCommentChinese,
    replyText: '',
    translatedReplyChinese: '',
    needsReview: true,
    knowledgeEvidence: [],
  })
}

async function fixture(
  t: TestContext,
  options: {
    mode?: 'local' | 'ai'
    interpret?: (prompt: string) => Promise<string>
    local?: string
    localUnavailable?: boolean
  } = {},
) {
  const folder = await mkdtemp(path.join(tmpdir(), 'oba-translation-'))
  let receive!: Parameters<AssistantDeskDependencies['startCapture']>[2]
  let requests = 0
  let localRequests = 0
  let sends = 0
  let event = 0
  const service = new AssistantDeskService(folder, {
    interpret: async (_accountId, value) => {
      requests++
      return options.interpret
        ? options.interpret(value)
        : JSON.stringify({ language: 'en', chinese: '你好' })
    },
    localTranslate: async () => {
      localRequests++
      return options.localUnavailable
        ? { status: 'uncertain', error: 'LOCAL_TRANSLATION_LANGUAGE_UNCERTAIN' }
        : {
            status: 'ready',
            method: 'chrome',
            language: 'en',
            confidence: 0.99,
            chinese: options.local ?? '本地中文译文',
          }
    },
    send: async () => {
      sends++
    },
    startCapture: async (_account, _session, listener) => {
      receive = listener
      return { captureSessionId: 'test-capture', release: async () => {} }
    },
  })
  t.after(async () => {
    await service.shutdown()
    await rm(folder, { recursive: true, force: true })
  })
  const command = (action: AssistantDeskCommand['action'], params: Record<string, unknown> = {}) =>
    service.execute({ action, params: { accountId: 'default', ...params } } as AssistantDeskCommand)
  const state = async (): Promise<AssistantDeskState> => {
    const result = await command('state')
    assert.equal(result.ok, true)
    return data<AssistantDeskState>(result)
  }
  const initial = await state()
  await command('context-save', {
    expectedRevision: initial.context.revision,
    context: { ...initial.context, translationMode: options.mode ?? 'local', aiRequestLimit: 50 },
  })
  assert.equal((await command('start')).ok, true)
  const wait = async (condition: (state: AssistantDeskState) => boolean) => {
    for (let index = 0; index < 100; index++) {
      const current = await state()
      if (condition(current)) return current
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('translation fixture did not settle')
  }
  const comment = async (original = 'Hello world') => {
    const sourceEventId = `message-${++event}`
    receive({
      msg_type: 'tiktok_comment',
      msg_id: sourceEventId,
      user_id: 'viewer',
      nick_name: 'Viewer',
      content: original,
    })
    const ready = await wait(
      value =>
        !!value.rows.find(
          row => row.sourceEventId === sourceEventId && row.translation.status !== 'pending',
        ),
    )
    const row = ready.rows.find(row => row.sourceEventId === sourceEventId)
    assert.ok(row)
    return row
  }
  return {
    command,
    state,
    wait,
    comment,
    requests: () => requests,
    localRequests: () => localRequests,
    sends: () => sends,
  }
}

test('manual unknown supplements keep the usable local translation and report ambiguity', async t => {
  const f = await fixture(t, {
    interpret: async () => JSON.stringify({ language: 'und', chinese: ambiguous }),
  })
  const row = await f.comment(ambiguous)
  const missing = await f.command('translate-retry', { rowId: row.id })
  assert.equal(missing.ok, true)
  const translated = data<AssistantDeskRow>(missing)
  assert.equal(translated.translation.manualAttempt?.status, 'skipped')
  assert.equal(translated.translation.manualAttempt?.message, '含义不明确，保留原文')
  assert.equal(translated.translation.status, 'ready')
  assert.equal(translated.translation.source, 'local')
  assert.equal(translated.translation.chinese, '本地中文译文')
  assert.equal(f.sends(), 0)
})

test('manual unknown interpretation without a local result explicitly retains the original', async t => {
  const f = await fixture(t, {
    localUnavailable: true,
    interpret: async () => JSON.stringify({ language: 'und', chinese: ambiguous }),
  })
  const row = await f.comment(ambiguous)
  const result = await f.command('translate-retry', { rowId: row.id })
  assert.equal(result.ok, true)
  const value = data<AssistantDeskRow>(result)
  assert.equal(value.translation.status, 'skipped')
  assert.equal(value.translation.source, 'ai')
  assert.equal(value.translation.language, 'und')
  assert.equal(value.translation.chinese, ambiguous)
  assert.equal(value.translation.error, '含义不明确，保留原文')
})

test('unknown automatic interpretations are skipped with original text and no inferred language', async t => {
  const f = await fixture(t, {
    mode: 'ai',
    interpret: async () => JSON.stringify({ language: 'und', chinese: ambiguous }),
  })
  const row = await f.comment(ambiguous)
  assert.equal(row.translation.status, 'skipped')
  assert.equal(row.translation.language, 'und')
  assert.equal(row.translation.chinese, ambiguous)
  assert.equal(row.translation.error, '含义不明确，保留原文')
  assert.equal(row.reply.status, 'none')
})

test('an explicit unknown source cannot turn a guessed Chinese explanation into a translation', async t => {
  const f = await fixture(t, {
    mode: 'ai',
    interpret: async () => JSON.stringify({ language: 'und', chinese: '模型猜测的解释' }),
  })
  const row = await f.comment(ambiguous)
  assert.equal(row.translation.status, 'skipped')
  assert.equal(row.translation.language, 'und')
  assert.equal(row.translation.chinese, ambiguous)
  assert.equal(row.translation.error, '含义不明确，保留原文')
})

test('untranslated known-English output and actual language labels have distinct errors', async t => {
  for (const [chinese, message] of [
    ['Hello world', 'AI未返回中文译文，原文已保留；请重试。'],
    ['英语', 'AI把语言名称当作译文，未翻译这条评论；请重试。'],
  ]) {
    const f = await fixture(t, {
      mode: 'ai',
      interpret: async () => JSON.stringify({ language: 'en', chinese }),
    })
    const row = await f.comment()
    assert.equal(row.translation.status, 'failed')
    assert.equal(row.translation.error, message)
  }
})

test('interpretation preserves explicit unknown data and reports specific bad-translation errors', async () => {
  const und = JSON.parse(
    await interpretAssistantPrompt(prompt(ambiguous), async () => modelResponse('und', ambiguous)),
  )
  assert.deepEqual(
    { language: und.language, chinese: und.chinese, reply: und.reply },
    { language: 'und', chinese: ambiguous, reply: '' },
  )
  await assert.rejects(
    interpretAssistantPrompt(prompt('Hello world'), async () => modelResponse('en', 'Hello world')),
    /AI未返回中文译文/,
  )
  await assert.rejects(
    interpretAssistantPrompt(prompt('Hello world'), async () => modelResponse('en', '英语')),
    /AI把语言名称当作译文/,
  )
})

test('manual DeepSeek is one explicit request; later comments keep Chrome local mode', async t => {
  let resolveModel!: (value: string) => void
  const f = await fixture(t, {
    interpret: async () =>
      new Promise(resolve => {
        resolveModel = resolve
      }),
  })
  const row = await f.comment()
  assert.equal(f.requests(), 0)
  const before = await f.state()
  const translating = f.command('translate-retry', { rowId: row.id })
  const pending = await f.wait(
    value =>
      f.requests() === 1 &&
      value.rows.some(value => value.id === row.id && value.translation.status === 'pending'),
  )
  assert.equal(
    pending.rows.find(value => value.id === row.id)?.translation.fallback?.chinese,
    '本地中文译文',
  )
  const duplicate = f.command('translate-retry', { rowId: row.id })
  resolveModel(JSON.stringify({ language: 'en', chinese: 'DeepSeek 中文译文' }))
  const [first, second] = await Promise.all([translating, duplicate])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(data<AssistantDeskRow>(first).translation.source, 'ai')
  assert.equal(data<AssistantDeskRow>(first).translation.chinese, 'DeepSeek 中文译文')
  await f.comment('Another comment')
  const after = await f.state()
  assert.equal(after.context.translationMode, 'local')
  assert.equal(after.context.revision, before.context.revision)
  assert.equal(f.requests(), 1)
  assert.equal(f.localRequests(), 2)
  assert.equal(after.ai.used, before.ai.used + 1)
  assert.equal(f.sends(), 0)
})

test('a failed manual supplement retains the usable Chrome translation and an honest failure notice', async t => {
  const f = await fixture(t, {
    interpret: async () => JSON.stringify({ language: 'en', chinese: 'Hello world' }),
  })
  const row = await f.comment()
  const result = await f.command('translate-retry', { rowId: row.id })
  assert.equal(result.ok, true)
  const value = data<AssistantDeskRow>(result)
  assert.equal(value.translation.status, 'ready')
  assert.equal(value.translation.source, 'local')
  assert.equal(value.translation.chinese, '本地中文译文')
  assert.equal(value.translation.manualAttempt?.status, 'failed')
  assert.equal(value.translation.manualAttempt?.message, 'AI未返回中文译文，原文已保留；请重试。')
  assert.equal(value.translation.fallback, undefined)
  assert.equal((await f.state()).context.translationMode, 'local')
})

test('stopping capture during a manual supplement preserves the existing local translation', async t => {
  const f = await fixture(t, { interpret: async () => new Promise(() => {}) })
  const row = await f.comment()
  const translating = f.command('translate-retry', { rowId: row.id })
  await f.wait(
    value =>
      f.requests() === 1 &&
      value.rows.some(value => value.id === row.id && value.translation.status === 'pending'),
  )
  await f.command('stop')
  await translating
  const stopped = await f.state()
  const value = stopped.rows.find(value => value.id === row.id)
  assert.ok(value)
  assert.equal(value.translation.status, 'ready')
  assert.equal(value.translation.source, 'local')
  assert.equal(value.translation.chinese, '本地中文译文')
  assert.equal(value.translation.manualAttempt?.status, 'interrupted')
  assert.equal(f.sends(), 0)
})

test('late manual results cannot replace translations after switching capture sessions', async t => {
  let finish!: (value: string) => void
  const f = await fixture(t, {
    interpret: async () =>
      new Promise(resolve => {
        finish = resolve
      }),
  })
  const previous = await f.comment()
  const translating = f.command('translate-retry', { rowId: previous.id })
  await f.wait(
    value =>
      f.requests() === 1 &&
      value.rows.some(value => value.id === previous.id && value.translation.status === 'pending'),
  )
  await f.command('stop')
  await f.command('start')
  const current = await f.comment('A new scene')
  finish(JSON.stringify({ language: 'en', chinese: '过期结果不应覆盖' }))
  await translating
  const after = await f.state()
  const latest = after.rows.find(value => value.id === current.id)
  assert.ok(latest)
  assert.notEqual(latest.sessionId, previous.sessionId)
  assert.equal(latest.translation.source, 'local')
  assert.equal(latest.translation.chinese, '本地中文译文')
  assert.equal(f.requests(), 1)
  assert.equal(f.sends(), 0)
})
