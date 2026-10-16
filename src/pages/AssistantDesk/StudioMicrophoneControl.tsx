import { LoaderCircle, Mic, MicOff, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { StudioMicHotkeyCommand, StudioMicHotkeyState } from '../../../shared/studioMicHotkey'
import { Button } from '@/components/ui/button'

/** Desktop and phone use the same fixed local Studio microphone API and recording owner. */
export function StudioMicrophoneControl() {
  const [state, setState] = useState<StudioMicHotkeyState>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const busy = useRef(false)
  const mounted = useRef(false)

  const run = async (action: StudioMicHotkeyCommand['action']) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.studioMicHotkey.request, {
        action,
      })
      if (!mounted.current) return
      if (!result.ok) {
        setState(undefined)
        setError(result.error.message)
        return
      }
      setState(result.data)
      if (action !== 'status') setNotice(result.data.message)
    } catch {
      if (mounted.current) {
        setState(undefined)
        setError('麦克风控制结果未确认，请重新读取状态后再操作')
      }
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void run('status')
    const refreshRoute = () => {
      void run('status')
    }
    window.addEventListener('oba:voice-route-changed', refreshRoute)
    return () => {
      mounted.current = false
      window.removeEventListener('oba:voice-route-changed', refreshRoute)
    }
  }, [])

  if (state?.supported === false) return null
  return (
    <section className="assistant-panel" aria-label="直播与豆包讲话切换">
      <div className="assistant-actions">
        <strong>讲话切换</strong>
        <Button type="button" size="sm" variant={state?.micState === 'muted' ? 'outline' : 'default'}
          disabled={pending || !state?.running || !state.accessGranted || state.routeState !== 'live' || state.micState === 'unknown'}
          onClick={() => void run(state?.micState === 'muted' ? 'unmute' : 'mute')}>
          {pending ? <LoaderCircle className="animate-spin" /> : state?.micState === 'muted' ? <Mic /> : <MicOff />}
          {state?.micState === 'muted' ? '恢复开麦' : '闭麦 TK'}
        </Button>
        {state && (
          <span role="status" className="assistant-muted">
            {state.routeState === 'unknown'
              ? '等待重新读取状态'
              : state.micState === 'muted'
                ? state.routeState === 'doubao'
                  ? '豆包说话 · TK 已闭麦'
                  : 'TK 已闭麦'
                : state.micState === 'unmuted'
                  ? '直播讲话 · TK 已开麦'
                  : '麦克风状态待确认'}
          </span>
        )}
      </div>
      <p className="assistant-muted">
        点击回复框的“语音输入”，先闭麦 TK 再开始豆包识别；结束或取消后恢复录音前的麦克风状态。
        手动闭麦后可照常交谈；再次点击“恢复开麦”才恢复直播收音。
      </p>
      {state?.routeState === 'unknown' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void run('align-open')}
        >
          重新读取麦克风状态
        </Button>
      )}
      <details>
        <summary className="assistant-muted">麦克风连接和备用控制</summary>
        <p className="assistant-muted">
          使用本机 TK 麦克风控制服务，无需键盘授权，也无需逐次检查界面。TK Studio
          和本机控制服务须保持运行。
        </p>
        <div className="assistant-actions">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void run('status')}
          >
            <RefreshCw />
            检查连接
          </Button>
        </div>
        <p className="assistant-muted">豆包录音期间会锁住备用按钮，避免两端同时切换。</p>
      </details>
      {(!state?.running || error) && (
        <p className="assistant-muted">
          {state
            ? '请先打开 TK Studio'
            : error
              ? '连接状态未确认，请重新检查'
              : '正在连接麦克风控制服务…'}
        </p>
      )}
      {notice && (
        <p role="status" className="assistant-muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="assistant-error-text">
          {error}
        </p>
      )}
    </section>
  )
}
