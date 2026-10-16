import { Keyboard, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { StudioMicHotkeyCommand, StudioMicHotkeyState } from '../../../shared/studioMicHotkey'
import { Button } from '@/components/ui/button'

/** The displayed route follows sent hotkeys; it is not a Studio mute-state probe. */
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
        setError('未能确认热键操作结果，请查看 TK Studio 麦克风状态；不要重复点击')
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
        {state?.linked && (
          <span role="status" className="assistant-muted">
            {state.routeState === 'doubao'
              ? '正在豆包说话'
              : state.routeState === 'unknown'
                ? '联动等待重新对齐'
                : '直播讲话'}
          </span>
        )}
        {state && !state.accessGranted && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void run('request-access')}
          >
            授权热键控制
          </Button>
        )}
      </div>
      <p className="assistant-muted">
        点击回复框的“语音输入”即可联动 TK 麦克风，结束或取消后切回直播讲话。
      </p>
      {state?.routeState === 'unknown' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void run('align-open')}
        >
          我已恢复 TK 开麦，重新对齐
        </Button>
      )}
      <details>
        <summary className="assistant-muted">热键设置和备用控制</summary>
        <p className="assistant-muted">
          首次验收后按热键发送结果保持联动，无需逐次检查。起始保持 TK 开麦；使用中在 TK
          手动改过静音时，请恢复开麦后重新对齐。
        </p>
        <p className="assistant-muted">TK Studio“输入设备静音／取消静音”：Control + Option + M。</p>
        <div className="assistant-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              pending || !state?.running || !state.accessGranted || state.routeState === 'doubao'
            }
            onClick={() => void run('toggle')}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Keyboard />}手动切换 TK 麦克风
          </Button>
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
        <p className="assistant-muted">
          备用按钮会改变联动起点；手动操作后恢复 TK 开麦并重新对齐。
        </p>
      </details>
      {(!state?.running || error) && (
        <p className="assistant-muted">
          {state
            ? '请先打开 TK Studio'
            : error
              ? '连接状态未确认，请重新检查'
              : '正在检查热键控制…'}
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
