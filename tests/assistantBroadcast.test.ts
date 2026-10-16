import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantBroadcastService } from '../electron/main/services/AssistantBroadcastService'
import type { AssistantBroadcastRoom } from '../shared/assistantBroadcast'

function fixture() {
  let room: AssistantBroadcastRoom = { ready: true, browserSessionId: 'browser-1', target: { username: 'seller', url: 'https://www.tiktok.com/@seller/live' } }
  const sends: { text: string; browser: string }[] = []
  let translation = async () => 'Welcome everyone'
  let sending = async () => {}
  let translations = 0
  const service = new AssistantBroadcastService({
    room: () => room,
    translate: async () => { translations++; return translation() },
    send: async (_account, text, _signal, binding) => { sends.push({ text, browser: binding.browserSessionId }); await sending() },
  })
  return { service, sends, translations: () => translations,
    set room(value: AssistantBroadcastRoom) { room = value },
    set translation(value: typeof translation) { translation = value },
    set sending(value: typeof sending) { sending = value } }
}

test('standalone room-bound draft sends only the exact operator-approved original text without capture or mentions', async () => {
  const f = fixture()
  let draft = f.service.state('account')
  draft = f.service.edit('account', draft.draftId, draft.revision, { chinese: '欢迎大家，今天有新品', useOriginal: true })
  assert.equal(draft.chinese, '欢迎大家，今天有新品')
  assert.equal(draft.canSend, true)
  assert.equal(f.sends.length, 0)
  const sent = await f.service.send('account', draft.draftId, draft.revision, draft.finalText, 'send-1')
  assert.equal(sent.delivery.status, 'sent')
  assert.deepEqual(f.sends, [{ text: '欢迎大家，今天有新品', browser: 'browser-1' }])
  assert.equal(f.translations(), 0)
})

test('translation is explicit and preview becomes stale when source or independently selected language changes', async () => {
  const f = fixture()
  let draft = f.service.state('a')
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '欢迎', targetLanguage: 'th', useOriginal: false })
  assert.equal(draft.canSend, false)
  assert.equal(f.translations(), 0)
  draft = await f.service.translate('a', draft.draftId, draft.revision, 'translate-1')
  assert.equal(draft.translatedText, 'Welcome everyone')
  assert.equal(draft.finalText, 'Welcome everyone')
  assert.equal(draft.translatedRevision, draft.revision)
  assert.equal(draft.canSend, true)
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '稍后上新品' })
  assert.equal(draft.chinese, '稍后上新品')
  assert.equal(draft.translatedText, '')
  assert.equal(draft.canSend, false)
  draft = f.service.edit('a', draft.draftId, draft.revision, { translatedText: 'A new product is coming' })
  assert.equal(draft.canSend, true)
  draft = f.service.edit('a', draft.draftId, draft.revision, { targetLanguage: 'vi' })
  assert.equal(draft.translatedText, '')
  assert.equal(draft.canSend, false)
})

test('missing room and changed browser or target prevent old draft sends and voice ownership', async () => {
  const f = fixture()
  let draft = f.service.state('a')
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '欢迎' })
  const scope = f.service.voiceScope('a', draft.draftId)
  assert.ok(scope.sessionId)
  assert.equal(f.service.voiceScope('a', draft.draftId).sessionId, scope.sessionId)
  f.room = { ready: true, browserSessionId: 'browser-2', target: { username: 'other', url: 'https://www.tiktok.com/@other/live' } }
  assert.equal(f.service.state('a').canSend, false)
  await assert.rejects(f.service.send('a', draft.draftId, draft.revision, draft.finalText, 'wrong-room'))
  assert.throws(() => f.service.voiceScope('a', draft.draftId))
  const replacement = f.service.clear('a', draft.draftId, draft.revision)
  assert.notEqual(replacement.draftId, draft.draftId)
  assert.notEqual(f.service.voiceScope('a', replacement.draftId).sessionId, scope.sessionId)
  f.room = { ready: false }
  assert.throws(() => f.service.voiceScope('a', replacement.draftId))
  assert.equal(f.sends.length, 0)
})

test('revision and visible final text must match exactly before public sending', async () => {
  const f = fixture()
  const initial = f.service.state('a')
  const draft = f.service.edit('a', initial.draftId, initial.revision, { chinese: '新的公告' })
  assert.throws(() => f.service.edit('a', draft.draftId, initial.revision, { chinese: '旧的覆盖' }))
  await assert.rejects(f.service.send('a', draft.draftId, initial.revision, draft.finalText, 'stale-revision'))
  await assert.rejects(f.service.send('a', draft.draftId, draft.revision, '界面上的旧文字', 'stale-text'))
  assert.equal(f.sends.length, 0)
})

test('late translated text cannot overwrite a newer Chinese edit or a replacement draft', async () => {
  const f = fixture()
  let resolve!: (value: string) => void
  f.translation = () => new Promise<string>(done => { resolve = done })
  let draft = f.service.state('a')
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '旧中文', useOriginal: false })
  const pending = f.service.translate('a', draft.draftId, draft.revision, 'pending')
  const edited = f.service.edit('a', draft.draftId, draft.revision, { chinese: '新的中文' })
  resolve('outdated translation')
  await pending
  assert.equal(f.service.state('a').chinese, '新的中文')
  assert.equal(f.service.state('a').translatedText, '')
  assert.equal(f.service.state('a').revision, edited.revision)
})

test('room change while translating discards the preview and does not send', async () => {
  const f = fixture()
  let resolve!: (value: string) => void
  f.translation = () => new Promise<string>(done => { resolve = done })
  let draft = f.service.state('a')
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '欢迎', useOriginal: false })
  const pending = f.service.translate('a', draft.draftId, draft.revision, 'pending')
  f.room = { ready: false }
  resolve('Welcome')
  const translated = await pending
  assert.equal(translated.translation.status, 'failed')
  assert.equal(translated.translatedText, '')
  assert.equal(translated.canSend, false)
  assert.equal(f.sends.length, 0)
})

test('concurrent send and delivery timeout cannot repeat a one-shot public send', async () => {
  const f = fixture()
  let reject!: (error: Error) => void
  f.sending = () => new Promise<void>((_resolve, fail) => { reject = fail })
  let draft = f.service.state('a')
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '本场优惠' })
  const pending = f.service.send('a', draft.draftId, draft.revision, draft.finalText, 'send-once')
  const duplicate = f.service.send('a', draft.draftId, draft.revision, draft.finalText, 'send-once')
  assert.equal(f.sends.length, 1)
  reject(new Error('timeout after possible delivery'))
  const [first, second] = await Promise.all([pending, duplicate])
  assert.equal(first.delivery.status, 'unconfirmed')
  assert.equal(second.delivery.status, 'unconfirmed')
  await f.service.send('a', draft.draftId, draft.revision, draft.finalText, 'send-once')
  await assert.rejects(f.service.send('a', draft.draftId, draft.revision, draft.finalText, 'new-request-id'))
  assert.equal(f.sends.length, 1)
  assert.equal(f.service.state('a').canSend, false)
})

test('room changing during delivery cannot become a confirmed send or trigger a retry', async () => {
  const f = fixture()
  f.sending = async () => { f.room = { ready: false } }
  let draft = f.service.state('a')
  draft = f.service.edit('a', draft.draftId, draft.revision, { chinese: '正在发言' })
  const sent = await f.service.send('a', draft.draftId, draft.revision, draft.finalText, 'room-change')
  assert.equal(sent.delivery.status, 'unconfirmed')
  assert.equal(sent.canSend, false)
  assert.equal(f.sends.length, 1)
})

test('account drafts and voice scopes remain separate and raw invalid or empty input cannot send', async () => {
  const f = fixture()
  const first = f.service.state('a')
  const second = f.service.state('b')
  assert.notEqual(first.draftId, second.draftId)
  assert.notEqual(f.service.voiceScope('a', first.draftId).sessionId, f.service.voiceScope('b', second.draftId).sessionId)
  assert.throws(() => f.service.edit('b', first.draftId, first.revision, { chinese: '错账号' }))
  assert.throws(() => f.service.edit('a', first.draftId, first.revision, { chinese: 'a'.repeat(1001) }))
  await assert.rejects(f.service.send('a', first.draftId, first.revision, '', 'empty'))
  assert.equal(f.sends.length, 0)
})

test('omitting an expected revision cannot bypass the draft compare-and-set guard', async () => {
  const f = fixture()
  const draft = f.service.state('a')
  assert.throws(() => f.service.edit('a', draft.draftId, undefined as unknown as number, { chinese: '未经当前版本确认' }))
  assert.throws(() => f.service.clear('a', draft.draftId, undefined as unknown as number))
  await assert.rejects(f.service.translate('a', draft.draftId, undefined as unknown as number, 'bad-translate'))
  await assert.rejects(f.service.send('a', draft.draftId, undefined as unknown as number, '', 'bad-send'))
  assert.equal(f.service.state('a').chinese, '')
})

test('shutdown aborts and settles pending translation and send without repeating public delivery', async () => {
  const signals: AbortSignal[] = []
  let sends = 0
  const service = new AssistantBroadcastService({
    room: () => ({ ready: true, browserSessionId: 'browser', target: { username: 'seller', url: 'https://www.tiktok.com/@seller/live' } }),
    translate: async (_account, _input, signal) => { signals.push(signal); return new Promise<string>(() => {}) },
    send: async (_account, _text, signal) => { signals.push(signal); sends++; return new Promise<void>(() => {}) },
  })
  let translateDraft = service.state('translate-account')
  translateDraft = service.edit('translate-account', translateDraft.draftId, translateDraft.revision, { chinese: '待翻译' })
  let sendDraft = service.state('send-account')
  sendDraft = service.edit('send-account', sendDraft.draftId, sendDraft.revision, { chinese: '人工发送' })
  const translating = service.translate('translate-account', translateDraft.draftId, translateDraft.revision, 'translate')
  const sending = service.send('send-account', sendDraft.draftId, sendDraft.revision, sendDraft.finalText, 'send')
  await service.dispose()
  const [translated, sent] = await Promise.all([translating, sending])
  assert.equal(signals.length, 2)
  assert.equal(signals.every(signal => signal.aborted), true)
  assert.equal(translated.translation.status, 'failed')
  assert.equal(sent.delivery.status, 'unconfirmed')
  assert.equal(sends, 1)
  await service.dispose()
  assert.equal(sends, 1)
})

test('closed service rejects new draft, editing, translation, sending and voice ownership', async () => {
  const f = fixture()
  const draft = f.service.state('a')
  await f.service.dispose()
  assert.throws(() => f.service.state('a'), /关闭/)
  assert.throws(() => f.service.edit('a', draft.draftId, draft.revision, { chinese: '不应接受' }), /关闭/)
  assert.throws(() => f.service.clear('a', draft.draftId, draft.revision), /关闭/)
  assert.throws(() => f.service.voiceScope('a', draft.draftId), /关闭/)
  await assert.rejects(f.service.translate('a', draft.draftId, draft.revision, 'closed-translate'), /关闭/)
  await assert.rejects(f.service.send('a', draft.draftId, draft.revision, '', 'closed-send'), /关闭/)
  assert.equal(f.translations(), 0)
  assert.equal(f.sends.length, 0)
})
