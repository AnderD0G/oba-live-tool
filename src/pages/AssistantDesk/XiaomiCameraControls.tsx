import { Camera, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import {
  DEFAULT_XIAOMI_CAMERA_BASE_URL,
  type XiaomiCameraCommand,
  type XiaomiCameraPreview,
  type XiaomiCameraResult,
  type XiaomiCameraSettings,
  type XiaomiCameraStatus,
  xiaomiCameraStateLabels,
  xiaomiPreviewFocusPoint,
} from '../../../shared/xiaomiCamera'

const request = (command: XiaomiCameraCommand): Promise<XiaomiCameraResult> =>
  window.ipcRenderer.invoke(IPC_CHANNELS.xiaomiCamera.request, command)

/** Device controls are independent of OBS scene selection. Unmounting never stops the camera. */
export function XiaomiCameraControls() {
  const [camera, setCamera] = useState<XiaomiCameraStatus>()
  const [settings, setSettings] = useState<XiaomiCameraSettings>()
  const [baseUrl, setBaseUrl] = useState(DEFAULT_XIAOMI_CAMERA_BASE_URL)
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')
  const [zoom, setZoom] = useState('1')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [previewEnabled, setPreviewEnabled] = useState(false)
  const [preview, setPreview] = useState<XiaomiCameraPreview>()
  const [clock, setClock] = useState(Date.now())
  const alive = useRef(false)
  const busyRef = useRef(false)
  const serial = useRef(0)
  const zoomDirty = useRef(false)
  const previewReading = useRef(false)
  const stateReading = useRef(false)
  const image = useRef<HTMLImageElement>(null)

  const apply = useCallback((result: XiaomiCameraResult, showError = true) => {
    if (!alive.current) return
    if (result.config) {
      setBaseUrl(result.config.baseUrl)
      setHasToken(result.config.hasToken)
    }
    if (result.camera) setCamera(result.camera)
    if (result.settings) {
      setSettings(result.settings)
      if (!zoomDirty.current && typeof result.settings.zoom === 'number')
        setZoom(String(result.settings.zoom))
    }
    if (result.message) setMessage(result.message)
    if (!result.ok && showError) setError(result.error?.message || '相机操作尚未确认，请刷新状态')
    if (result.error?.outcomeUnknown) {
      setCamera({ state: 'unknown', timestamp: new Date().toISOString() })
      setSettings(undefined)
      setPreview(undefined)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (stateReading.current) return
    stateReading.current = true
    const generation = serial.current
    try {
      const results = await Promise.all([
        request({ action: 'status' }),
        request({ action: 'settings' }),
      ])
      if (!alive.current || generation !== serial.current) return
      for (const result of results) apply(result)
      if (results.every(result => result.ok)) setError('')
    } catch {
      if (alive.current && generation === serial.current)
        setError('无法读取相机状态，请检查本机连接')
    } finally {
      stateReading.current = false
    }
  }, [apply])

  useEffect(() => {
    alive.current = true
    const generation = serial.current
    void request({ action: 'config-get' })
      .then(result => {
        if (!alive.current || generation !== serial.current) return
        apply(result)
        if (result.config?.hasToken) void refresh()
      })
      .catch(() => {
        if (alive.current) setError('无法读取相机连接配置')
      })
    return () => {
      alive.current = false
      serial.current++
    }
  }, [apply, refresh])

  const perform = async (command: XiaomiCameraCommand) => {
    if (busyRef.current) return
    busyRef.current = true
    serial.current++
    setBusy(command.action)
    setError('')
    setMessage('')
    if (!['config-save', 'config-get'].includes(command.action)) setPreview(undefined)
    try {
      const result = await request(command)
      if (!alive.current) return
      apply(result)
      if (command.action === 'config-save' && result.ok) {
        setToken('')
        setPreview(undefined)
        setSettings(undefined)
        setCamera(undefined)
      }
      if (command.action === 'zoom' && result.ok) {
        zoomDirty.current = false
        setZoom(String(command.ratio))
      }
      if (result.ok || result.error?.outcomeUnknown) void refresh()
    } catch {
      if (alive.current) {
        setError('请求结果未确认，请先刷新状态再决定是否重试')
        setCamera(undefined)
        setSettings(undefined)
        setPreview(undefined)
      }
    } finally {
      busyRef.current = false
      if (alive.current) setBusy('')
    }
  }

  useEffect(() => {
    if (!previewEnabled || !hasToken) return
    let stopped = false
    const update = async () => {
      if (previewReading.current || busyRef.current || document.visibilityState !== 'visible')
        return
      previewReading.current = true
      const generation = serial.current
      try {
        const controls = await request({ action: 'settings' })
        if (stopped || !alive.current || generation !== serial.current) return
        apply(controls, false)
        if (!controls.ok || !controls.settings?.available) {
          setPreview(undefined)
          return
        }
        const result = await request({ action: 'preview' })
        if (stopped || !alive.current || generation !== serial.current) return
        setPreview(result.ok ? result.preview : undefined)
        setClock(Date.now())
        if (!result.ok) setMessage(result.error?.message || '正在等待新鲜操作预览')
      } catch {
        if (!stopped && alive.current) {
          setPreview(undefined)
          setMessage('操作预览暂不可用，请刷新相机状态')
        }
      } finally {
        previewReading.current = false
      }
    }
    void update()
    const timer = setInterval(() => {
      void update()
    }, 1000)
    const clockTimer = setInterval(() => setClock(Date.now()), 250)
    return () => {
      stopped = true
      clearInterval(timer)
      clearInterval(clockTimer)
    }
  }, [previewEnabled, hasToken, apply])

  const fresh = !!preview && clock < preview.expiresAt
  const lensEnabled = hasToken && settings?.available === true && !busy
  const focusEnabled = lensEnabled && settings.focus_supported === true && fresh
  return (
    <section className="assistant-panel" aria-label="小米4K相机与镜头控制">
      <div className="assistant-actions">
        <strong>
          <Camera size={16} className="inline" /> 小米4K 相机
        </strong>
        <span role="status" className="assistant-muted">
          {camera ? xiaomiCameraStateLabels[camera.state] : '相机状态尚未确认'}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken || !!busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          刷新状态
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken || !!busy}
          onClick={() => void perform({ action: 'start' })}
        >
          开启小米相机
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken || !!busy}
          onClick={() => void perform({ action: 'stop' })}
        >
          停止小米相机
        </Button>
        {busy && (
          <span className="assistant-muted">
            <LoaderCircle size={14} className="inline animate-spin" /> 正在执行相机操作…
          </span>
        )}
      </div>
      <p className="assistant-muted">
        停止会中断小米画面；切换到 iPhone 或退出 OBA
        不会自动停止小米。就绪或连接消费者不代表视频画质已验证。
      </p>
      <div className="assistant-actions">
        <label className="assistant-muted" htmlFor="xiaomi-camera-zoom">
          变焦倍率
        </label>
        <Input
          id="xiaomi-camera-zoom"
          type="number"
          min={settings?.zoom_min || 1}
          max={settings?.zoom_max || 10}
          step="0.1"
          className="w-24"
          value={zoom}
          disabled={!lensEnabled}
          onChange={event => {
            zoomDirty.current = true
            setZoom(event.target.value)
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!lensEnabled || !Number.isFinite(Number(zoom))}
          onClick={() => void perform({ action: 'zoom', ratio: Number(zoom) })}
        >
          应用倍率
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!lensEnabled || settings?.focus_supported !== true}
          onClick={() => void perform({ action: 'autofocus' })}
        >
          恢复自动对焦
        </Button>
        <span className="assistant-muted">
          实际倍率：{settings?.observed_zoom ?? '未观测'}；下次启动：
          {settings?.saved_zoom ?? '未确认'}
        </span>
      </div>
      {settings?.available === false && (
        <p className="assistant-warning">镜头控制暂不可用，请核对手机连接和相机状态。</p>
      )}
      {settings?.focus_pending && <p className="assistant-muted">对焦已提交，正在等待手机结果。</p>}
      {settings?.last_focus_result && (
        <p className="assistant-muted">
          最近对焦结果：{settings.last_focus_result}（仍需观察主体是否清晰）
        </p>
      )}
      <div className="assistant-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken || !!busy}
          onClick={() => {
            setPreviewEnabled(value => !value)
            setPreview(undefined)
          }}
        >
          {previewEnabled ? '关闭操作预览' : '打开操作预览'}
        </Button>
        {previewEnabled && (
          <span className="assistant-muted">小型竖屏预览，每秒更新；点击新鲜图像选点对焦。</span>
        )}
      </div>
      {previewEnabled && (
        <div className="mt-2 flex items-start gap-3">
          {preview ? (
            <button
              type="button"
              aria-label="在小米新鲜预览中点按对焦"
              disabled={!focusEnabled}
              className="block w-[180px] max-w-full overflow-hidden rounded border p-0 disabled:cursor-default"
              onClick={event => {
                if (!preview || Date.now() >= preview.expiresAt || !image.current) {
                  setError('预览已过期，请等待新图后再对焦')
                  return
                }
                const rect = image.current.getBoundingClientRect()
                const point =
                  event.detail === 0
                    ? { x: 0.5, y: 0.5 }
                    : xiaomiPreviewFocusPoint(
                        { x: event.clientX, y: event.clientY },
                        {
                          left: rect.left,
                          top: rect.top,
                          width: rect.width,
                          height: rect.height,
                          naturalWidth: image.current.naturalWidth,
                          naturalHeight: image.current.naturalHeight,
                        },
                      )
                if (point) void perform({ action: 'focus', ...point, previewId: preview.id })
              }}
            >
              <img
                ref={image}
                src={preview.dataUrl}
                alt="小米相机竖屏操作预览"
                className="block h-auto w-full"
              />
            </button>
          ) : (
            <span className="assistant-muted">等待新鲜预览；这不代表主视频已经停止。</span>
          )}
          {preview && (
            <span className="assistant-muted">
              {fresh ? '可在图像内点按对焦' : '图像已过期，等待更新'}
              <br />
              变焦后先确认实际倍率，再使用新图选点。
            </span>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="assistant-muted">
          {message}
        </p>
      )}
      {error && (
        <div role="alert" className="assistant-error-text">
          {error}
        </div>
      )}
      <details className="mt-3">
        <summary>相机服务连接{hasToken ? '（密钥已保存）' : '（尚未配置密钥）'}</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            className="max-w-sm"
            aria-label="小米相机服务地址"
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
            disabled={!!busy}
          />
          <Input
            className="max-w-sm"
            aria-label="小米相机访问密钥"
            type="password"
            autoComplete="new-password"
            value={token}
            placeholder={hasToken ? '留空保留已保存密钥' : '输入单独提供的 Bearer 密钥'}
            onChange={event => setToken(event.target.value)}
            disabled={!!busy}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() =>
              void perform({
                action: 'config-save',
                config: { baseUrl, ...(token ? { token: token.trim() } : {}) },
              })
            }
          >
            安全保存连接
          </Button>
        </div>
      </details>
    </section>
  )
}
