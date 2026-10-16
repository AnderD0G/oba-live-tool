import { createHash, randomUUID } from 'node:crypto'
import type { AssistantBroadcastBinding, AssistantBroadcastDependencies, AssistantBroadcastPatch, AssistantBroadcastState } from '../../../shared/assistantBroadcast'

const MAX_TEXT = 1000
const MAX_ACCOUNTS = 64
const MAX_REQUESTS = 128
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value)
const validText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const sameBinding = (a?: AssistantBroadcastBinding, b?: AssistantBroadcastBinding) => !!a && !!b && a.browserSessionId === b.browserSessionId && a.target.username === b.target.username && a.target.url === b.target.url
export class AssistantBroadcastError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AssistantBroadcastError' }
}
const fail = (code: string, message: string): never => { throw new AssistantBroadcastError(code, message) }
type Request = { revision: number; text?: string; promise: Promise<AssistantBroadcastState> }
type Draft = { state: AssistantBroadcastState; translations: Map<string, Request>; sends: Map<string, Request>; translating?: AbortController }

/** RAM-only operator drafts. This service never creates captured comments or audience records. */
export class AssistantBroadcastService {
  private drafts = new Map<string, Draft>()
  private closing = false
  private disposal?: Promise<void>
  private controllers = new Set<AbortController>()
  private pending = new Set<Promise<AssistantBroadcastState>>()
  constructor(private readonly dependencies: AssistantBroadcastDependencies) {}

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closing = true
    for (const controller of this.controllers) controller.abort()
    this.disposal = Promise.allSettled([...this.pending]).then(() => { this.drafts.clear() })
    return this.disposal
  }
  private requireOpen() { if (this.closing) return fail('BROADCAST_CLOSED', '自由发言服务已关闭') }
  private track(promise: Promise<AssistantBroadcastState>) {
    this.pending.add(promise)
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
  }

  private room(accountId: string): AssistantBroadcastBinding | undefined {
    const room = this.dependencies.room(accountId)
    if (!room?.ready || !validId(room.browserSessionId) || !room.target || typeof room.target.username !== 'string' || !room.target.username ||
      room.target.username.length > 100 || typeof room.target.url !== 'string' || !room.target.url || room.target.url.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(room.target.username + room.target.url)) return undefined
    return structuredClone({ browserSessionId: room.browserSessionId, target: room.target })
  }
  private create(accountId: string): Draft {
    return { state: { accountId, draftId: randomUUID(), revision: 0, chinese: '', targetLanguage: 'en', translatedText: '', useOriginal: true,
      finalText: '', roomReady: false, bindingCurrent: false, binding: this.room(accountId), translation: { status: 'idle' }, delivery: { status: 'idle' }, canSend: false },
      translations: new Map(), sends: new Map() }
  }
  private get(accountId: string) {
    if (!validId(accountId)) return fail('BROADCAST_INVALID_ACCOUNT', '账号编号无效')
    let draft = this.drafts.get(accountId)
    if (!draft) {
      if (this.drafts.size >= MAX_ACCOUNTS) return fail('BROADCAST_LIMIT', '自由发言草稿数量已达上限')
      draft = this.create(accountId)
      this.drafts.set(accountId, draft)
    }
    return draft
  }
  private expected(accountId: string, draftId: string, revision?: number, requireRevision = true) {
    const draft = this.get(accountId)
    if (!validId(draftId) || draft.state.draftId !== draftId) return fail('BROADCAST_DRAFT_CHANGED', '自由发言草稿已变化，请刷新后操作')
    if (requireRevision && (!Number.isSafeInteger(revision) || revision === undefined || revision < 0 || revision !== draft.state.revision)) return fail('BROADCAST_REVISION_CHANGED', '草稿已修改，请确认当前预览后操作')
    return draft
  }
  private requireRoom(draft: Draft) {
    if (!sameBinding(draft.state.binding, this.room(draft.state.accountId))) return fail('BROADCAST_ROOM_CHANGED', '直播间未就绪或已变化，请新建自由发言草稿')
  }
  private maximum(accountId: string) {
    const limit = this.dependencies.limit?.(accountId) ?? MAX_TEXT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TEXT) return fail('BROADCAST_INVALID_LIMIT', '自由发言长度限制无效')
    return limit
  }
  state(accountId: string): AssistantBroadcastState {
    this.requireOpen()
    return this.snapshot(accountId)
  }
  private snapshot(accountId: string): AssistantBroadcastState {
    const draft = this.get(accountId)
    const state = draft.state
    const room = this.room(accountId)
    state.roomReady = !!room
    state.bindingCurrent = sameBinding(state.binding, room)
    state.finalText = state.useOriginal ? state.chinese.trim() : state.translatedRevision === state.revision && state.translation.status === 'ready' ? state.translatedText.trim() : ''
    state.canSend = state.bindingCurrent && !!state.finalText && state.finalText.length <= this.maximum(accountId) && state.delivery.status === 'idle' &&
      (state.useOriginal || state.translation.status === 'ready')
    return structuredClone(state)
  }
  edit(accountId: string, draftId: string, expectedRevision: number, patch: AssistantBroadcastPatch): AssistantBroadcastState {
    this.requireOpen()
    const draft = this.expected(accountId, draftId, expectedRevision)
    if (draft.state.delivery.status === 'sending') return fail('BROADCAST_BUSY', '自由发言正在发送，请等待结果')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['chinese', 'translatedText', 'targetLanguage', 'useOriginal'].includes(key)) ||
      (patch.chinese !== undefined && !validText(patch.chinese)) || (patch.translatedText !== undefined && !validText(patch.translatedText)) ||
      (patch.targetLanguage !== undefined && (typeof patch.targetLanguage !== 'string' || !patch.targetLanguage.trim() || patch.targetLanguage.length > 100 || /[\u0000-\u001f\u007f]/.test(patch.targetLanguage))) ||
      (patch.useOriginal !== undefined && typeof patch.useOriginal !== 'boolean')) return fail('BROADCAST_INVALID_PATCH', '自由发言文字或语言无效，最多 1000 字')
    const state = draft.state
    if (!Object.entries(patch).some(([key, value]) => value !== undefined && value !== state[key as keyof AssistantBroadcastState])) return this.state(accountId)
    draft.translating?.abort()
    draft.translating = undefined
    const invalidates = (patch.chinese !== undefined && patch.chinese !== state.chinese) || (patch.targetLanguage !== undefined && patch.targetLanguage !== state.targetLanguage)
    const hadPreview = state.translation.status === 'ready' && state.translatedRevision === state.revision
    state.revision++
    if (!state.binding) state.binding = this.room(accountId)
    if (patch.chinese !== undefined) state.chinese = patch.chinese
    if (patch.targetLanguage !== undefined) state.targetLanguage = patch.targetLanguage
    if (patch.useOriginal !== undefined) state.useOriginal = patch.useOriginal
    if (invalidates) { state.translatedText = ''; delete state.translatedRevision; state.translation = { status: 'idle' } }
    else if (hadPreview) state.translatedRevision = state.revision
    else if (state.translation.status === 'pending') { state.translation = { status: 'idle' }; delete state.translatedRevision }
    if (patch.translatedText !== undefined) {
      state.translatedText = patch.translatedText
      state.translation = { status: patch.translatedText.trim() ? 'ready' : 'idle' }
      state.translatedRevision = patch.translatedText.trim() ? state.revision : undefined
    }
    // An uncertain public send remains locked even after edits; clear starts a visibly new draft.
    if (state.delivery.status === 'sent' || state.delivery.status === 'failed') state.delivery = { status: 'idle' }
    return this.state(accountId)
  }
  translate(accountId: string, draftId: string, expectedRevision: number, requestId: string): Promise<AssistantBroadcastState> {
    try {
      this.requireOpen()
      const draft = this.expected(accountId, draftId, expectedRevision)
      if (!validId(requestId)) return Promise.reject(new AssistantBroadcastError('BROADCAST_INVALID_REQUEST', '翻译请求编号无效'))
      const previous = draft.translations.get(requestId)
      if (previous) return previous.revision === expectedRevision ? previous.promise : Promise.reject(new AssistantBroadcastError('BROADCAST_REQUEST_CHANGED', '翻译请求编号已用于其他版本'))
      this.requireRoom(draft)
      if (!draft.state.chinese.trim()) return Promise.reject(new AssistantBroadcastError('BROADCAST_EMPTY', '请先填写中文草稿'))
      if (draft.state.delivery.status === 'sending') return Promise.reject(new AssistantBroadcastError('BROADCAST_BUSY', '自由发言正在发送'))
      if (draft.translations.size >= MAX_REQUESTS) return Promise.reject(new AssistantBroadcastError('BROADCAST_LIMIT', '本草稿翻译次数已达上限，请新建草稿'))
      draft.translating?.abort()
      const controller = new AbortController()
      draft.translating = controller
      draft.state.translation = { status: 'pending', requestId }
      draft.state.translatedText = ''
      delete draft.state.translatedRevision
      const input = { chinese: draft.state.chinese, targetLanguage: draft.state.targetLanguage, requestId }
      const promise = this.operation(signal => this.dependencies.translate(accountId, input, signal), controller).then(text => {
        if (!this.current(draft, expectedRevision, requestId)) return this.snapshot(accountId)
        this.requireRoom(draft)
        if (!validText(text) || !text.trim()) return fail('BROADCAST_TRANSLATION_INVALID', '翻译未返回有效文字')
        draft.state.revision++
        draft.state.translatedText = text.trim()
        draft.state.translatedRevision = draft.state.revision
        draft.state.translation = { status: 'ready', requestId }
        return this.snapshot(accountId)
      }).catch(error => {
        if (this.current(draft, expectedRevision, requestId)) {
          draft.state.translation = { status: 'failed', requestId, error: error instanceof AssistantBroadcastError ? error.message : '翻译失败或未确认，请检查后重试' }
          draft.state.translatedText = ''
          delete draft.state.translatedRevision
        }
        return this.snapshot(accountId)
      }).finally(() => { if (draft.translating === controller) draft.translating = undefined })
      draft.translations.set(requestId, { revision: expectedRevision, promise })
      this.track(promise)
      return promise
    } catch (error) { return Promise.reject(error) }
  }
  private current(draft: Draft, revision: number, requestId: string) {
    return this.drafts.get(draft.state.accountId) === draft && draft.state.revision === revision && draft.state.translation.requestId === requestId
  }
  send(accountId: string, draftId: string, expectedRevision: number, expectedText: string, requestId: string): Promise<AssistantBroadcastState> {
    try {
      this.requireOpen()
      const draft = this.expected(accountId, draftId, expectedRevision)
      if (!validId(requestId)) return Promise.reject(new AssistantBroadcastError('BROADCAST_INVALID_REQUEST', '发送请求编号无效'))
      const previous = draft.sends.get(requestId)
      if (previous) return previous.revision === expectedRevision && previous.text === expectedText ? previous.promise : Promise.reject(new AssistantBroadcastError('BROADCAST_REQUEST_CHANGED', '发送请求编号已用于其他文字'))
      this.requireRoom(draft)
      const state = this.state(accountId)
      if (!validText(expectedText) || !state.canSend || expectedText !== state.finalText) return Promise.reject(new AssistantBroadcastError('BROADCAST_SEND_BLOCKED', state.delivery.status === 'unconfirmed' ? '上次发送结果未确认，不会重复发送；请在公屏核实' : '请确认当前草稿、翻译预览与直播间后再发送'))
      if (draft.sends.size >= MAX_REQUESTS) return Promise.reject(new AssistantBroadcastError('BROADCAST_LIMIT', '本草稿发送次数已达上限，请新建草稿'))
      const binding = structuredClone(draft.state.binding!)
      draft.state.delivery = { status: 'sending', requestId }
      const controller = new AbortController()
      const promise = this.operation(signal => {
        this.requireRoom(draft)
        return this.dependencies.send(accountId, expectedText, signal, binding)
      }, controller).then(() => {
        this.requireRoom(draft)
        draft.state.delivery = { status: 'sent', requestId, sentAt: Date.now() }
        return this.snapshot(accountId)
      }).catch(() => {
        draft.state.delivery = { status: 'unconfirmed', requestId, error: '发送结果未确认，请查看直播间公屏；不会自动重发' }
        return this.snapshot(accountId)
      })
      draft.sends.set(requestId, { revision: expectedRevision, text: expectedText, promise })
      this.track(promise)
      return promise
    } catch (error) { return Promise.reject(error) }
  }
  clear(accountId: string, draftId: string, expectedRevision: number): AssistantBroadcastState {
    this.requireOpen()
    const draft = this.expected(accountId, draftId, expectedRevision)
    if (draft.state.delivery.status === 'sending') return fail('BROADCAST_BUSY', '正在发送，请等待结果后再新建草稿')
    draft.translating?.abort()
    this.drafts.set(accountId, this.create(accountId))
    return this.state(accountId)
  }
  voiceScope(accountId: string, draftId: string): { sessionId: string } {
    this.requireOpen()
    const draft = this.expected(accountId, draftId, undefined, false)
    this.requireRoom(draft)
    const fingerprint = createHash('sha256').update(JSON.stringify(draft.state.binding)).digest('hex').slice(0, 24)
    return { sessionId: `broadcast:${draft.state.draftId}:${fingerprint}` }
  }
  private operation<T>(task: (signal: AbortSignal) => Promise<T>, controller: AbortController): Promise<T> {
    this.controllers.add(controller)
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted) }
      const aborted = () => { cleanup(); reject(new Error('Broadcast operation aborted')) }
      const timer = setTimeout(() => controller.abort(), 45_000)
      controller.signal.addEventListener('abort', aborted, { once: true })
      try { task(controller.signal).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) }) }
      catch (error) { cleanup(); reject(error) }
    }).finally(() => { this.controllers.delete(controller) })
  }
}
