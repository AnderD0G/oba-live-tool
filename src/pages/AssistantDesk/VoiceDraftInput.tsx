import { LoaderCircle, Mic, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantVoiceCommand } from '../../../shared/assistantVoice'

const noOwnerErrors = new Set(['VOICE_INVALID_COMMAND', 'VOICE_BUSY', 'VOICE_SERVICE_BUSY', 'VOICE_ALREADY_RECORDING', 'VOICE_NOT_OWNED', 'VOICE_NO_ACTIVE_SESSION', 'VOICE_ROW_NOT_FOUND', 'VOICE_NO_TEXT', 'VOICE_MIC_BLOCKED', 'VOICE_START_NOT_STARTED'])

/** Dictation owns only its selected message and never saves or sends a reply. */
export function VoiceDraftInput({ accountId, rowId, value, onChange, disabled = false }: {
  accountId: string
  rowId: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'uncertain'>('idle')
  const [pending, setPending] = useState<AssistantVoiceCommand['action']>()
  const [notice, setNotice] = useState<{ error: boolean; text: string }>()
  const [recognized, setRecognized] = useState('')
  const mounted = useRef(false)
  const pendingRef = useRef<AssistantVoiceCommand['action'] | undefined>(undefined)
  const owned = useRef(false)
  const cleanupStarted = useRef(false)
  const baseline = useRef(value)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }

  const cleanupOwned = () => {
    if (!owned.current || pendingRef.current || cleanupStarted.current) return
    cleanupStarted.current = true
    owned.current = false
    // A start/stop already in flight settles before cleanup, avoiding a busy
    // cancellation that would otherwise leave this message's microphone open.
    void Promise.resolve().then(() => window.ipcRenderer.invoke('assistant-voice:request', { action: 'cancel', accountId, rowId })).catch(() => {})
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; cleanupOwned() }
  }, [accountId, rowId])

  const run = async (action: AssistantVoiceCommand['action']) => {
    if (pendingRef.current || (action === 'start' && (disabled || owned.current))) return
    pendingRef.current = action
    cleanupStarted.current = false
    setPending(action)
    setNotice(undefined)
    if (action === 'start') { baseline.current = latest.current.value; setRecognized('') }
    try {
      const result = await window.ipcRenderer.invoke('assistant-voice:request', { action, accountId, rowId })
      if (!result.ok) {
        // A failed start can still have opened the mic. Keep its cancellation
        // available unless the backend explicitly confirms no ownership.
        if (action === 'start') owned.current = !noOwnerErrors.has(result.error.code)
        else if (['VOICE_NOT_OWNED', 'VOICE_NO_TEXT'].includes(result.error.code)) owned.current = false
        if (!mounted.current) return
        setState(owned.current ? 'uncertain' : 'idle')
        setNotice({ error: true, text: result.error.message })
        return
      }
      owned.current = result.data?.status === 'recording'
      if (!mounted.current) return
      if (result.data?.rowId !== rowId || result.data.status !== ({ start: 'recording', stop: 'stopped', cancel: 'cancelled' } as const)[action]) {
        setState(owned.current ? 'uncertain' : 'idle')
        setNotice({ error: true, text: '语音结果与当前消息不一致，中文草稿已保留' })
        return
      }
      if (action === 'start') { setState('recording'); return }
      setState('idle')
      if (action === 'cancel') { setNotice({ error: !!result.data.micWarning, text: result.data.micWarning ?? '已取消录音，中文草稿未改动' }); return }
      const text = result.data.text?.trim()
      if (!text || text.length > 1000) { setNotice({ error: true, text: '未取得有效识别文字，中文草稿已保留' }); return }
      if (latest.current.value === baseline.current) {
        latest.current.onChange(text)
        setNotice({ error: !!result.data.micWarning, text: result.data.micWarning ? `识别文字已填入中文草稿；${result.data.micWarning}` : '识别文字已填入中文草稿；核对后再翻译和发送' })
      } else {
        setRecognized(text)
        setNotice({ error: false, text: '录音期间草稿已修改，识别文字保留在下方，可追加到草稿' })
      }
    } catch {
      owned.current = true
      if (mounted.current) {
        setState('uncertain')
        setNotice({ error: true, text: '语音操作结果尚未确认，中文草稿已保留；请取消本次录音后重试' })
      }
    } finally {
      window.dispatchEvent(new CustomEvent('oba:voice-route-changed'))
      pendingRef.current = undefined
      if (mounted.current) setPending(undefined)
      else if (action !== 'cancel') cleanupOwned()
    }
  }
  const appended = `${value}${value && !value.endsWith('\n') ? '\n' : ''}${recognized}`
  return <div className="assistant-voice-input">
    <div className="assistant-actions">
      {state === 'idle' && !pending ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => void run('start')}>
        <Mic />语音输入
      </Button> : <>
        <Button type="button" size="sm" variant="outline" disabled={!!pending} onClick={() => void run('stop')}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Square />}结束并填入草稿
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!!pending} onClick={() => void run('cancel')}><X />取消录音</Button>
      </>}
      <Button type="button" size="sm" variant="ghost" disabled={disabled || state !== 'idle' || !!pending || !value} onClick={() => {
        if (disabled || state !== 'idle' || pendingRef.current || !value) return
        onChange('')
      }}>清空中文草稿</Button>
      <span className="assistant-muted">使用服务电脑麦克风；仅输入中文草稿</span>
    </div>
    <div aria-live="polite">
      {pending && <p className="assistant-muted">{pending === 'start' ? '正在开启麦克风…' : pending === 'stop' ? '正在识别，最长约 30 秒…' : '正在取消录音…'}</p>}
      {!pending && state === 'recording' && <p role="status" className="assistant-voice-recording">正在录音，说完后点击“结束并填入草稿”</p>}
      {!pending && state === 'uncertain' && <p className="assistant-muted">本次录音状态待确认，可点击“取消录音”清理</p>}
      {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'assistant-error-text' : 'assistant-muted'}>{notice.text}</p>}
    </div>
    {recognized && <div className="assistant-voice-recognized">
      <p className="assistant-muted">本次识别文字</p>
      <p className="assistant-voice-transcript">{recognized}</p>
      <div className="assistant-actions">
        <Button type="button" size="sm" variant="outline" disabled={appended.length > 1000} onClick={() => {
          if (appended.length > 1000) return
          latest.current.onChange(appended)
          setRecognized('')
          setNotice({ error: false, text: '已追加到中文草稿；核对后再翻译和发送' })
        }}>追加识别文字</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setRecognized('')}>放弃识别文字</Button>
      </div>
      {appended.length > 1000 && <p className="assistant-error-text">追加后超过 1000 字，请先精简草稿；识别文字已保留，可选中复制。</p>}
    </div>}
  </div>
}
