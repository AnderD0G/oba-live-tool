import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ASSISTANT_MESSAGE_LANGUAGES } from '../../../shared/assistantLanguageCatalog'
import type { AssistantBroadcastCommand, AssistantBroadcastPatch, AssistantBroadcastResult, AssistantBroadcastState } from '../../../shared/assistantBroadcast'
import { VoiceDraftInput } from './VoiceDraftInput'

type Request = (command: AssistantBroadcastCommand) => Promise<AssistantBroadcastResult>
type Form = Pick<AssistantBroadcastState, 'chinese' | 'translatedText' | 'targetLanguage' | 'useOriginal'>
const invoke: Request = command => window.ipcRenderer.invoke('assistant-broadcast:request', command)
const empty: Form = { chinese: '', translatedText: '', targetLanguage: 'en', useOriginal: true }
const fields = ['chinese', 'translatedText', 'targetLanguage', 'useOriginal'] as const
const formOf = (state: AssistantBroadcastState): Form => ({ chinese: state.chinese, translatedText: state.translatedText, targetLanguage: state.targetLanguage, useOriginal: state.useOriginal })
const sameForm = (a: Form, b: Form) => fields.every(key => a[key] === b[key])
const lockedDelivery = (status?: string) => ['sending', 'sent', 'unconfirmed'].includes(status ?? '')

/** A separate operator draft. Translation and public delivery each require their own click. */
export function BroadcastComposer({ accountId, request = invoke }: { accountId: string; request?: Request }) {
  const [draft, setDraft] = useState<AssistantBroadcastState>()
  const [form, setForm] = useState<Form>(empty)
  const [dirty, setDirty] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [open, setOpen] = useState(false)
  const [operation, setOperation] = useState<string>()
  const [error, setError] = useState('')
  const [sendUnconfirmed, setSendUnconfirmed] = useState(false)
  const stateRef = useRef<AssistantBroadcastState | undefined>(undefined)
  const formRef = useRef<Form>(empty)
  const dirtyRef = useRef(false)
  const operationRef = useRef<string | undefined>(undefined)
  const mounted = useRef(false)
  const generation = useRef(0)
  const readSerial = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const valid = (state: AssistantBroadcastState | undefined) => !!state && state.accountId === accountId && typeof state.draftId === 'string' && Number.isSafeInteger(state.revision)
  const localForm = (value: Form) => { formRef.current = value; setForm(value) }
  const markDirty = (value: boolean) => { dirtyRef.current = value; setDirty(value) }
  const adopt = (state: AssistantBroadcastState, preserveLocal = false) => {
    stateRef.current = state
    setDraft(state)
    setFresh(true)
    if (!preserveLocal) localForm(formOf(state))
    markDirty(!sameForm(formRef.current, formOf(state)))
    if (state.delivery.status === 'sent' || state.delivery.status === 'failed') setSendUnconfirmed(false)
  }
  const read = async () => {
    if (operationRef.current) return
    const owner = generation.current
    const serial = ++readSerial.current
    setFresh(false)
    try {
      const result = await request({ action: 'state', accountId })
      if (!mounted.current || owner !== generation.current || serial !== readSerial.current) return
      if (!result.ok) throw Error(result.error.message)
      if (!valid(result.data)) throw Error('未取得当前自由发言草稿，请刷新')
      adopt(result.data, dirtyRef.current)
    } catch (cause) {
      if (mounted.current && owner === generation.current && serial === readSerial.current) {
        setFresh(false)
        setError(cause instanceof Error ? cause.message : '自由发言状态未确认')
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    generation.current++
    stateRef.current = undefined
    setDraft(undefined)
    localForm({ ...empty })
    markDirty(false)
    setFresh(false)
    setError('')
    setSendUnconfirmed(false)
    void read()
    return () => {
      mounted.current = false
      generation.current++
      clearTimeout(saveTimer.current)
    }
  }, [accountId, request])
  useEffect(() => {
    if (!open) return
    void read()
    const timer = setInterval(() => { if (!document.hidden) void read() }, 5000)
    return () => clearInterval(timer)
  }, [open, accountId, request])

  const save = async () => {
    const current = stateRef.current
    if (operationRef.current || !current || !dirtyRef.current || lockedDelivery(current.delivery.status)) return
    const owner = generation.current
    const submitted = { ...formRef.current }
    const patch: AssistantBroadcastPatch = {}
    for (const key of fields) if (submitted[key] !== current[key]) Object.assign(patch, { [key]: submitted[key] })
    if (!Object.keys(patch).length) { markDirty(false); return }
    operationRef.current = 'edit'
    readSerial.current++
    setOperation('edit')
    setError('')
    let continueSaving = false
    try {
      const result = await request({ action: 'edit', accountId, draftId: current.draftId, expectedRevision: current.revision, patch })
      if (!mounted.current || owner !== generation.current) return
      if (!result.ok) throw Error(result.error.message)
      if (!valid(result.data) || result.data.draftId !== current.draftId) throw Error('自由发言草稿已变化，请刷新后核对')
      adopt(result.data, !sameForm(formRef.current, submitted))
      continueSaving = dirtyRef.current
    } catch (cause) {
      if (mounted.current && owner === generation.current) {
        setFresh(false)
        setError(cause instanceof Error ? cause.message : '草稿保存未确认，文字已保留')
      }
    } finally {
      operationRef.current = undefined
      if (mounted.current && owner === generation.current) {
        setOperation(undefined)
        if (continueSaving) void save()
      }
    }
  }
  const update = (patch: AssistantBroadcastPatch) => {
    const current = stateRef.current
    if (!current || lockedDelivery(current.delivery.status) || sendUnconfirmed || operationRef.current && operationRef.current !== 'edit') return
    const next = { ...formRef.current, ...patch }
    readSerial.current++
    if (patch.chinese !== undefined && patch.chinese !== formRef.current.chinese || patch.targetLanguage !== undefined && patch.targetLanguage !== formRef.current.targetLanguage) next.translatedText = ''
    localForm(next)
    markDirty(!sameForm(next, formOf(current)))
    clearTimeout(saveTimer.current)
    if (dirtyRef.current) saveTimer.current = setTimeout(() => void save(), 150)
  }
  const run = async (action: 'translate' | 'send' | 'clear') => {
    const current = stateRef.current
    if (!current || operationRef.current || action !== 'clear' && dirtyRef.current) return
    if (action === 'send' && (sendUnconfirmed || !fresh || !current.canSend || lockedDelivery(current.delivery.status))) return
    clearTimeout(saveTimer.current)
    operationRef.current = action
    readSerial.current++
    setOperation(action)
    setError('')
    const owner = generation.current
    const command: AssistantBroadcastCommand = action === 'clear'
      ? { action, accountId, draftId: current.draftId, expectedRevision: current.revision }
      : action === 'translate'
        ? { action, accountId, draftId: current.draftId, expectedRevision: current.revision, requestId: crypto.randomUUID() }
        : { action, accountId, draftId: current.draftId, expectedRevision: current.revision, expectedText: current.finalText, requestId: crypto.randomUUID() }
    let refresh = false
    try {
      const result = await request(command)
      if (!mounted.current || owner !== generation.current) return
      if (!result.ok) throw Error(result.error.message)
      if (!valid(result.data) || action !== 'clear' && result.data.draftId !== current.draftId) throw Error('发言结果不属于当前草稿，请刷新后核对')
      adopt(result.data)
      if (action === 'clear') setSendUnconfirmed(false)
      if (action === 'send' && !['sent', 'unconfirmed', 'failed'].includes(result.data.delivery.status)) throw Error('发送结果待确认，请先核对直播间公屏')
    } catch (cause) {
      refresh = true
      if (mounted.current && owner === generation.current) {
        if (action === 'send') setSendUnconfirmed(true)
        setError(cause instanceof Error ? cause.message : action === 'send' ? '发送结果待确认，请先核对公屏，勿重复发送' : '操作未确认，草稿已保留')
      }
    } finally {
      operationRef.current = undefined
      if (mounted.current && owner === generation.current) {
        setOperation(undefined)
        if (refresh) void read()
      }
    }
  }

  const current = draft?.accountId === accountId ? draft : undefined
  const locked = sendUnconfirmed || lockedDelivery(current?.delivery.status)
  const roomChanged = !!current?.binding && !current.bindingCurrent
  const editingDisabled = !current || locked || roomChanged || !!operation && operation !== 'edit'
  const finalText = form.useOriginal ? form.chinese : form.translatedText
  const canSend = fresh && !!current?.roomReady && current.bindingCurrent && current.canSend && !dirty && !operation && !locked && !!finalText.trim() && finalText.trim() === current.finalText
  return <details className="assistant-panel" aria-label="自由发言" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>自由发言</summary>
    <div style={{ paddingTop: 8 }}>
      <p className="assistant-muted">独立中文草稿，核对预览后手动发送到直播间公屏。</p>
      <div className="assistant-actions">
        <span>当前直播间：{current?.binding && current.bindingCurrent ? <strong>@{current.binding.target.username}</strong> : '尚未确认'}</span>
        <Button size="sm" variant="ghost" disabled={!!operation} onClick={() => void read()}>刷新发言状态</Button>
        <Button size="sm" variant="outline" disabled={!current || !!operation} onClick={() => void run('clear')}>为当前直播间新建草稿</Button>
      </div>
      {roomChanged && <p role="alert" className="assistant-error-text">直播间已变化，原草稿已保留。请为当前直播间新建草稿后再发送。</p>}
      {current && !current.roomReady && <p className="assistant-muted">请先选择已登录的真实直播间，再核对发送位置。</p>}
      <textarea aria-label="自由发言中文草稿" placeholder="输入中文自由发言" rows={2} maxLength={1000} value={form.chinese} disabled={editingDisabled} onChange={event => update({ chinese: event.target.value })} style={{ width: '100%', marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }} />
      {current && <VoiceDraftInput key={`${accountId}:${current.draftId}`} accountId={accountId} rowId={`broadcast:${current.draftId}`} value={form.chinese} onChange={chinese => update({ chinese })} disabled={editingDisabled || !current.roomReady || !current.bindingCurrent} />}
      <div className="assistant-actions" style={{ marginTop: 8 }}>
        <label>发言语言 <select aria-label="自由发言语言" value={form.useOriginal ? 'original' : form.targetLanguage} disabled={editingDisabled} onChange={event => update(event.target.value === 'original' ? { useOriginal: true } : { useOriginal: false, targetLanguage: event.target.value })} style={{ minHeight: 32 }}>
          <option value="original">保持原文</option>
          {ASSISTANT_MESSAGE_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
        </select></label>
        <Button size="sm" variant="outline" disabled={editingDisabled || dirty || !!operation || form.useOriginal || !form.chinese.trim() || !current?.bindingCurrent} onClick={() => void run('translate')}>翻译并预览</Button>
        {dirty && error && <Button size="sm" variant="outline" disabled={!!operation} onClick={() => void save()}>重试保存草稿</Button>}
        {(dirty || operation === 'edit') && <span className="assistant-muted">正在保存草稿…</span>}
      </div>
      <textarea aria-label="自由发言发送预览" placeholder="发送预览（可编辑）" rows={2} maxLength={1000} value={finalText} disabled={editingDisabled} onChange={event => update(form.useOriginal ? { chinese: event.target.value } : { translatedText: event.target.value })} style={{ width: '100%', marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 6 }} />
      <div className="assistant-actions" style={{ marginTop: 6 }}>
        <Button size="sm" disabled={!canSend} onClick={() => void run('send')}>发送到当前直播间</Button>
        {operation === 'translate' && <span role="status" className="assistant-muted">正在翻译，完成后请核对预览。</span>}
        {operation === 'send' && <span role="status" className="assistant-muted">正在发送，请等待结果。</span>}
        {current?.delivery.status === 'sent' && <span role="status" className="assistant-muted">已发送到直播间；继续发言请新建草稿。</span>}
        {(sendUnconfirmed || current?.delivery.status === 'unconfirmed') && <span role="status" className="assistant-error-text">发送结果待确认，请核对公屏；不会自动重发。</span>}
      </div>
      {(error || current?.translation.error || current?.delivery.error) && <p role="alert" className="assistant-error-text">{error || current?.translation.error || current?.delivery.error}</p>}
    </div>
  </details>
}
