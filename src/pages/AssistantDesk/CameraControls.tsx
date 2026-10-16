import { Camera, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { ObsCameraConfig, ObsCameraStatus, ObsCameraTarget } from '../../../shared/obsCamera'
import type { ObsEffectCommand, ObsEffectResponse } from '../../../shared/obsEffect'
import { XiaomiCameraControls } from './XiaomiCameraControls'

const labels: Record<ObsCameraTarget, string> = { android: '小米4K', iphone: 'iPhone' }
function selectedLabel(status?: ObsCameraStatus): string {
  if (!status?.ok) return '尚未确认'
  if (status.selected === 'android' || status.selected === 'iphone') return labels[status.selected]
  return status.selected === 'both'
    ? '两个机位同时显示'
    : status.selected === 'none'
      ? '当前节目未选中机位'
      : '尚未确认'
}
const request = async (command: ObsEffectCommand): Promise<ObsEffectResponse> =>
  window.ipcRenderer.invoke(IPC_CHANNELS.obsEffect.request, command)

/** Explicit camera commands; selection changes only after OBS acknowledges the actual source state. */
export function CameraControls() {
  const [status, setStatus] = useState<ObsCameraStatus>()
  const [config, setConfig] = useState<ObsCameraConfig>()
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState<ObsCameraTarget>()
  const [error, setError] = useState('')
  const switchingRef = useRef(false)
  const mounted = useRef(false)
  const readSerial = useRef(0)
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      if (switchingRef.current) return
      const serial = ++readSerial.current
      void request({ action: 'camera-status' })
        .then(response => {
          if (!mounted.current || serial !== readSerial.current) return
          if (!response.ok) {
            setStatus(undefined)
            setError(response.error)
            return
          }
          setConfig(response.cameraConfig)
          if (response.cameraStatus?.ok) {
            setStatus(response.cameraStatus)
            setError('')
          } else {
            setStatus(undefined)
            setError(response.cameraStatus?.error || 'OBS 尚未确认机位，请检查连接')
          }
        })
        .catch(cause => {
          if (mounted.current && serial === readSerial.current)
            setError(cause instanceof Error ? cause.message : '读取 OBS 机位失败')
        })
        .finally(() => {
          if (mounted.current && serial === readSerial.current) setLoading(false)
        })
    }
    refresh()
    const onFocus = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      readSerial.current++
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  const switchTo = async (target: ObsCameraTarget) => {
    if (switchingRef.current || loading) return
    switchingRef.current = true
    readSerial.current++
    setSwitching(target)
    setError('')
    try {
      const response = await request({ action: 'camera-switch', target })
      if (!mounted.current) return
      if (!response.ok) {
        setError(response.error)
        return
      }
      if (!response.cameraStatus?.ok) {
        setError(response.cameraStatus?.error || 'OBS 未确认切换结果，请检查机位')
        return
      }
      setStatus(response.cameraStatus)
      window.dispatchEvent(new CustomEvent('oba:obs-camera-changed'))
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : '切换机位失败，请检查 OBS 连接')
    } finally {
      switchingRef.current = false
      if (mounted.current) setSwitching(undefined)
    }
  }
  return (
    <>
      <section className="assistant-panel" aria-label="手动机位切换">
        <div className="assistant-actions">
          <strong>
            <Camera size={16} className="inline" /> 手动机位
          </strong>
          {(['android', 'iphone'] as const).map(target => (
            <Button
              key={target}
              size="sm"
              variant={status?.ok && status.selected === target ? 'default' : 'outline'}
              aria-pressed={!!status?.ok && status.selected === target}
              disabled={loading || !!switching}
              title={
                config?.switchMode === 'scene'
                  ? target === 'android'
                    ? config.androidSceneName
                    : config.iphoneSceneName
                  : target === 'android'
                    ? config?.androidSource
                    : config?.iphoneSource
              }
              onClick={() => void switchTo(target)}
            >
              {switching === target && <LoaderCircle size={14} className="animate-spin" />}
              {labels[target]}
            </Button>
          ))}
          <span role="status" className="assistant-muted">
            当前机位：{selectedLabel(status)}
          </span>
          {loading && <span className="assistant-muted">正在读取 OBS…</span>}
          {switching && <span className="assistant-muted">正在切到{labels[switching]}…</span>}
        </div>
        {status?.ok && status.onProgram === false && (
          <p className="assistant-warning">
            当前节目输出为「{status.programScene || '未知场景'}」，
            {config?.switchMode === 'scene'
              ? '小米4K / iPhone 机位场景尚未出现在节目输出中。'
              : `机位场景「${config?.sceneName || '双机位'}」尚未出现在节目输出中。`}
          </p>
        )}
        {status?.ok && status.onProgram === undefined && (
          <p className="assistant-muted">节目输出场景尚未确认。</p>
        )}
        {error && (
          <div role="alert" className="assistant-error-text">
            {error}
          </div>
        )}
      </section>
      <XiaomiCameraControls />
    </>
  )
}
