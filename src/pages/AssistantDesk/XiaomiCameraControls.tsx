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
import { LatestXiaomiZoom } from './LatestXiaomiZoom'

const request = (command: XiaomiCameraCommand): Promise<XiaomiCameraResult> =>
  window.ipcRenderer.invoke(IPC_CHANNELS.xiaomiCamera.request, command)

type FocusPhase =
  | 'submitting'
  | 'submitted'
  | 'pending'
  | 'focused'
  | 'not_focused'
  | 'timeout'
  | 'failed'
  | 'unconfirmed'
  | 'cancelled'
interface FocusPoint {
  x: number
  y: number
  phase: FocusPhase
  generation: number
  acknowledged: boolean
  sawPending: boolean
  width: number
  height: number
  deadline?: number
}
const focusLabels: Record<FocusPhase, string> = {
  submitting: '正在提交选点对焦…',
  submitted: '对焦点已提交，等待手机结果…',
  pending: '正在对焦，等待手机结果…',
  focused: '手机已确认合焦，仍请观察主体清晰度',
  not_focused: '手机报告未合焦，请重新选点',
  timeout: '手机对焦超时，请重新选点',
  failed: '对焦请求失败，请刷新状态后重试',
  unconfirmed: '对焦结果未确认，请刷新状态',
  cancelled: '本次对焦已取消',
}
const ratioLabel = (value: number | null | undefined) =>
  typeof value === 'number' ? value.toFixed(2) : '未确认'

/** Device controls are independent of OBS scene selection. Unmounting never stops the camera. */
export function XiaomiCameraControls() {
  const [camera, setCamera] = useState<XiaomiCameraStatus>()
  const [settings, setSettings] = useState<XiaomiCameraSettings>()
  const [baseUrl, setBaseUrl] = useState(DEFAULT_XIAOMI_CAMERA_BASE_URL)
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')
  const [zoom, setZoom] = useState('1.00')
  const [zoomPending, setZoomPending] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [previewEnabled, setPreviewEnabled] = useState(false)
  const [preview, setPreview] = useState<XiaomiCameraPreview>()
  const [previewUsable, setPreviewUsable] = useState(false)
  const [previewPaused, setPreviewPaused] = useState(false)
  const [previewFps, setPreviewFps] = useState(0)
  const [previewMessage, setPreviewMessage] = useState('')
  const [focusPoint, setFocusPoint] = useState<FocusPoint>()
  const [clock, setClock] = useState(Date.now())
  const alive = useRef(false)
  const busyRef = useRef(false)
  const busyAction = useRef('')
  const lastDeviceWriteAt = useRef(Number.NEGATIVE_INFINITY)
  const observedZoom = useRef<number | undefined>(undefined)
  const focusRef = useRef<FocusPoint | undefined>(undefined)
  const zoomPendingRef = useRef(false)
  const zoomDesired = useRef<number | undefined>(undefined)
  const zoomQueue = useRef<LatestXiaomiZoom | undefined>(undefined)
  const zoomSubmit = useRef<(ratio: number) => Promise<boolean>>(async () => false)
  const serial = useRef(0)
  const zoomDirty = useRef(false)
  const previewReading = useRef(false)
  const previewSettingsReading = useRef(false)
  const previewView = useRef(0)
  const stateReading = useRef(false)
  const stateRefreshQueued = useRef(false)
  const image = useRef<HTMLImageElement>(null)

  const updateFocus = useCallback((value: FocusPoint | undefined) => {
    focusRef.current = value
    setFocusPoint(value)
  }, [])

  const apply = useCallback(
    (result: XiaomiCameraResult, showError = true, retainImage = false) => {
      if (!alive.current) return
      if (result.config) {
        setBaseUrl(result.config.baseUrl)
        setHasToken(result.config.hasToken)
      }
      if (result.camera) setCamera(result.camera)
      if (result.settings) {
        const observed = result.settings.observed_zoom
        if (typeof observed === 'number') {
          if (
            observedZoom.current !== undefined &&
            Math.abs(observed - observedZoom.current) > 0.0001
          ) {
            previewView.current++
            updateFocus(undefined)
            setPreviewUsable(false)
          }
          observedZoom.current = observed
        }
        setSettings(result.settings)
        if (!zoomDirty.current && typeof result.settings.zoom === 'number')
          setZoom(result.settings.zoom.toFixed(2))
      }
      let point = focusRef.current
      if (
        point &&
        point.generation === serial.current &&
        ['submitting', 'submitted', 'pending', 'unconfirmed'].includes(point.phase)
      ) {
        if (!point.acknowledged && result.operation?.focus_submitted === true)
          point = { ...point, acknowledged: true, phase: 'submitted', deadline: Date.now() + 6000 }
        if (
          point.acknowledged &&
          result.settings?.focus_pending === true &&
          point.phase !== 'unconfirmed'
        )
          point = { ...point, sawPending: true, phase: 'pending' }
        else if (
          point.acknowledged &&
          point.sawPending &&
          result.settings?.focus_pending === false
        ) {
          const outcome = result.settings.last_focus_result
          if (['focused', 'not_focused', 'timeout', 'failed', 'cancelled'].includes(outcome || ''))
            point = { ...point, phase: outcome as FocusPhase }
        }
        if (point !== focusRef.current) updateFocus(point)
      }
      if (result.message) setMessage(result.message)
      if (!result.ok && showError) setError(result.error?.message || '相机操作尚未确认，请刷新状态')
      if (result.error?.outcomeUnknown) {
        setCamera({ state: 'unknown', timestamp: new Date().toISOString() })
        setSettings(undefined)
        setPreviewUsable(false)
        if (!retainImage) setPreview(undefined)
      }
    },
    [updateFocus],
  )

  useEffect(() => {
    const point = focusRef.current
    if (
      point?.deadline &&
      clock >= point.deadline &&
      ['submitted', 'pending'].includes(point.phase)
    )
      updateFocus({ ...point, phase: 'unconfirmed' })
  }, [clock, updateFocus])

  const refresh = useCallback(async () => {
    if (stateReading.current) {
      stateRefreshQueued.current = true
      return
    }
    stateReading.current = true
    try {
      do {
        stateRefreshQueued.current = false
        const generation = serial.current
        try {
          const results = await Promise.all([
            request({ action: 'status' }),
            request({ action: 'settings' }),
          ])
          if (alive.current && generation === serial.current) {
            for (const result of results) apply(result)
            if (results.every(result => result.ok)) setError('')
          }
        } catch {
          if (alive.current && generation === serial.current)
            setError('无法读取相机状态，请检查本机连接')
        }
        // A mutation can invalidate a pending read. Coalesce its refresh with
        // manual clicks and read again using the latest generation; never replay writes.
      } while (alive.current && stateRefreshQueued.current)
    } finally {
      stateReading.current = false
      stateRefreshQueued.current = false
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

  const perform = async (command: XiaomiCameraCommand): Promise<boolean> => {
    if (busyRef.current || (zoomPendingRef.current && command.action !== 'zoom')) return false
    busyRef.current = true
    busyAction.current = command.action
    serial.current++
    setBusy(command.action)
    setError('')
    setMessage('')
    const retainImage = command.action === 'focus' || command.action === 'zoom'
    setPreviewUsable(false)
    if (command.action === 'focus')
      updateFocus({
        x: command.x,
        y: command.y,
        phase: 'submitting',
        generation: serial.current,
        acknowledged: false,
        sawPending: false,
        width: image.current?.naturalWidth || 0,
        height: image.current?.naturalHeight || 0,
      })
    else updateFocus(undefined)
    if (!retainImage && !['config-save', 'config-get'].includes(command.action))
      setPreview(undefined)
    try {
      if (['start', 'stop', 'zoom', 'focus', 'autofocus'].includes(command.action)) {
        const remaining = Math.max(0, 300 - (Date.now() - lastDeviceWriteAt.current))
        if (remaining) await new Promise(resolve => setTimeout(resolve, remaining))
        if (!alive.current) return false
        lastDeviceWriteAt.current = Date.now()
      }
      const result = await request(command)
      if (!alive.current) return false
      apply(result, true, retainImage)
      if (command.action === 'focus' && !result.ok && focusRef.current)
        updateFocus({
          ...focusRef.current,
          phase: result.error?.outcomeUnknown ? 'unconfirmed' : 'failed',
        })
      if (command.action === 'config-save' && result.ok) {
        setToken('')
        setPreview(undefined)
        setSettings(undefined)
        setCamera(undefined)
      }
      if (command.action === 'zoom' && result.ok) {
        if (zoomDesired.current === command.ratio) {
          zoomDirty.current = false
          setZoom(command.ratio.toFixed(2))
        }
      }
      if (result.ok || result.error?.outcomeUnknown) void refresh()
      return result.ok
    } catch {
      if (alive.current) {
        setError('请求结果未确认，请先刷新状态再决定是否重试')
        setCamera(undefined)
        setSettings(undefined)
        if (!retainImage) setPreview(undefined)
        if (command.action === 'focus' && focusRef.current)
          updateFocus({ ...focusRef.current, phase: 'unconfirmed' })
      }
      return false
    } finally {
      busyRef.current = false
      busyAction.current = ''
      if (alive.current) setBusy('')
    }
  }

  zoomSubmit.current = ratio => perform({ action: 'zoom', ratio })
  useEffect(() => {
    const queue = new LatestXiaomiZoom({
      submit: ratio => zoomSubmit.current(ratio),
      onPending: pending => {
        zoomPendingRef.current = pending
        if (alive.current) setZoomPending(pending)
      },
    })
    zoomQueue.current = queue
    return () => {
      queue.dispose()
      if (zoomQueue.current === queue) zoomQueue.current = undefined
    }
  }, [])

  const queueZoom = (ratio: number) => {
    if (
      !Number.isFinite(ratio) ||
      ratio < (settings?.zoom_min || 1) ||
      ratio > (settings?.zoom_max || 10)
    )
      return
    zoomDesired.current = ratio
    zoomDirty.current = true
    setZoom(ratio.toFixed(2))
    setPreviewUsable(false)
    updateFocus(undefined)
    zoomQueue.current?.request(ratio)
  }

  useEffect(() => {
    if (!previewEnabled || !hasToken) return
    let active = false
    let epoch = 0
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    let settingsTimer: ReturnType<typeof setTimeout> | undefined
    let decoder: HTMLImageElement | undefined
    let frames = 0
    let fpsStartedAt = performance.now()
    const current = (run: number) => active && run === epoch && alive.current
    const writeBlocksPreview = () =>
      busyRef.current && !['zoom', 'focus'].includes(busyAction.current)
    const updateFrame = async (run: number) => {
      if (!current(run)) return
      const startedAt = performance.now()
      let retryMs = 1000 / 30
      if (previewReading.current || writeBlocksPreview()) {
        frameTimer = setTimeout(() => void updateFrame(run), retryMs)
        return
      }
      previewReading.current = true
      const generation = serial.current
      const view = previewView.current
      const writingAtStart = busyRef.current || zoomPendingRef.current
      try {
        const result = await request({ action: 'preview' })
        if (!current(run) || generation !== serial.current || view !== previewView.current) return
        if (result.ok && result.preview) {
          // Decode this JPEG before asking for another frame. No request or
          // image decoding queue may build up behind a slow renderer.
          const nextImage = new Image()
          decoder = nextImage
          nextImage.src = result.preview.dataUrl
          await nextImage.decode()
          if (decoder === nextImage) decoder = undefined
          if (!current(run) || generation !== serial.current || view !== previewView.current) return
          setPreview(result.preview)
          setPreviewUsable(!writingAtStart && !busyRef.current && !zoomPendingRef.current)
          setPreviewMessage('')
          frames++
        } else {
          setPreviewUsable(false)
          setPreviewMessage(result.error?.message || '正在等待新鲜操作预览')
          retryMs = 250
        }
      } catch {
        if (current(run)) {
          setPreviewUsable(false)
          setPreviewMessage('操作预览暂不可用，请刷新相机状态')
        }
        retryMs = 250
      } finally {
        previewReading.current = false
        if (current(run))
          frameTimer = setTimeout(
            () => void updateFrame(run),
            Math.max(0, retryMs - (performance.now() - startedAt)),
          )
      }
    }
    const updateSettings = async (run: number) => {
      if (!current(run)) return
      const startedAt = performance.now()
      if (!previewSettingsReading.current && !writeBlocksPreview()) {
        previewSettingsReading.current = true
        const generation = serial.current
        try {
          const controls = await request({ action: 'settings' })
          if (current(run) && generation === serial.current) {
            apply(controls, false, true)
            if (!controls.ok || !controls.settings?.available) setPreviewUsable(false)
          }
        } catch {
          if (current(run)) setPreviewUsable(false)
        } finally {
          previewSettingsReading.current = false
        }
      }
      if (current(run))
        settingsTimer = setTimeout(
          () => void updateSettings(run),
          Math.max(0, 500 - (performance.now() - startedAt)),
        )
    }
    const pause = () => {
      const wasActive = active
      active = false
      epoch++
      clearTimeout(frameTimer)
      clearTimeout(settingsTimer)
      if (decoder) {
        decoder.src = ''
        decoder = undefined
      }
      setPreview(undefined)
      setPreviewUsable(false)
      setPreviewFps(0)
      setPreviewMessage('')
      updateFocus(undefined)
      if (wasActive) void request({ action: 'preview-cancel' }).catch(() => {})
    }
    const visibilityChanged = () => {
      const hidden = document.visibilityState !== 'visible'
      setPreviewPaused(hidden)
      if (hidden) {
        pause()
        return
      }
      if (active) return
      active = true
      const run = ++epoch
      frames = 0
      fpsStartedAt = performance.now()
      void updateFrame(run)
      void updateSettings(run)
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    visibilityChanged()
    const clockTimer = setInterval(() => {
      if (!active) return
      setClock(Date.now())
      const elapsed = performance.now() - fpsStartedAt
      if (elapsed >= 1000) {
        setPreviewFps((frames * 1000) / elapsed)
        frames = 0
        fpsStartedAt = performance.now()
      }
    }, 250)
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged)
      pause()
      clearInterval(clockTimer)
    }
  }, [previewEnabled, hasToken, apply, updateFocus])

  const fresh = previewUsable && !!preview && clock < preview.expiresAt
  const deviceBusy = !!busy || zoomPending
  const lensEnabled = hasToken && settings?.available === true && !deviceBusy
  const zoomEnabled = hasToken && settings?.available === true && (!busy || busy === 'zoom')
  const focusEnabled = lensEnabled && settings.focus_supported === true && fresh
  const focusColor =
    focusPoint?.phase === 'focused'
      ? '#22c55e'
      : focusPoint && ['not_focused', 'timeout', 'failed'].includes(focusPoint.phase)
        ? '#ef4444'
        : '#facc15'
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
          disabled={!hasToken || deviceBusy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          刷新状态
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken || deviceBusy}
          onClick={() => void perform({ action: 'start' })}
        >
          开启小米相机
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken || deviceBusy}
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
        <label className="assistant-muted" htmlFor="xiaomi-camera-zoom-slider">
          连续变焦
        </label>
        <input
          id="xiaomi-camera-zoom-slider"
          type="range"
          aria-label="连续变焦倍率"
          min={settings?.zoom_min || 1}
          max={settings?.zoom_max || 10}
          step="0.01"
          value={Number(zoom) || settings?.zoom_min || 1}
          disabled={!zoomEnabled}
          className="w-64 max-w-full"
          onChange={event => queueZoom(Number(event.target.value))}
        />
        <output aria-live="polite">
          {Number.isFinite(Number(zoom)) ? Number(zoom).toFixed(2) : '—'}×
        </output>
        <label className="assistant-muted" htmlFor="xiaomi-camera-zoom">
          变焦倍率
        </label>
        <Input
          id="xiaomi-camera-zoom"
          type="number"
          min={settings?.zoom_min || 1}
          max={settings?.zoom_max || 10}
          step="0.01"
          className="w-24"
          value={zoom}
          disabled={!zoomEnabled}
          onChange={event => {
            zoomDirty.current = true
            setZoom(event.target.value)
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!zoomEnabled || !Number.isFinite(Number(zoom))}
          onClick={() => queueZoom(Number(zoom))}
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
          实际倍率：
          {settings?.observed_zoom == null ? '未观测' : ratioLabel(settings.observed_zoom)}
          ；下次启动：
          {ratioLabel(settings?.saved_zoom)}
        </span>
      </div>
      {settings?.available === false && (
        <p className="assistant-warning">镜头控制暂不可用，请核对手机连接和相机状态。</p>
      )}
      {focusPoint && (
        <p role="status" aria-live="polite" className="assistant-muted">
          {focusLabels[focusPoint.phase]}
        </p>
      )}
      {!focusPoint && settings?.focus_pending && (
        <p className="assistant-muted">手机正在处理对焦。</p>
      )}
      {!focusPoint && settings?.last_focus_result && (
        <p className="assistant-muted">
          最近对焦结果：{settings.last_focus_result}（仍需观察主体是否清晰）
        </p>
      )}
      <div className="assistant-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={!hasToken}
          onClick={() => {
            setPreviewEnabled(value => !value)
            setPreview(undefined)
            setPreviewUsable(false)
            updateFocus(undefined)
          }}
        >
          {previewEnabled ? '关闭操作预览' : '打开操作预览'}
        </Button>
        {previewEnabled && (
          <span className="assistant-muted">
            小型竖屏预览，目标 30 帧/秒；实际 {previewFps.toFixed(1)} 帧/秒
            {previewPaused ? '（页面隐藏，已暂停）' : '；点击新鲜图像选点对焦。'}
          </span>
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
              style={{ position: 'relative' }}
              onClick={event => {
                if (
                  !previewUsable ||
                  !preview ||
                  Date.now() >= preview.expiresAt ||
                  !image.current
                ) {
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
                onLoad={event => {
                  const point = focusRef.current
                  if (
                    point &&
                    (point.width !== event.currentTarget.naturalWidth ||
                      point.height !== event.currentTarget.naturalHeight)
                  )
                    updateFocus(undefined)
                }}
              />
              {focusPoint && (
                <span
                  role="img"
                  aria-label="点按对焦位置"
                  style={{
                    position: 'absolute',
                    left: `${focusPoint.x * 100}%`,
                    top: `${focusPoint.y * 100}%`,
                    width: 36,
                    height: 36,
                    transform: 'translate(-50%, -50%)',
                    pointerEvents: 'none',
                    borderWidth: 2,
                    borderStyle: 'solid',
                    borderColor: focusColor,
                    boxShadow: '0 0 2px #000',
                    borderRadius: 4,
                  }}
                />
              )}
            </button>
          ) : (
            <span className="assistant-muted">等待新鲜预览；这不代表主视频已经停止。</span>
          )}
          {preview && (
            <span className="assistant-muted">
              {fresh ? '可在图像内点按对焦' : '图像仅供查看，等待新鲜预览后可再次对焦'}
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
      {previewEnabled && previewMessage && (
        <p role="status" className="assistant-muted">
          {previewMessage}
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
            disabled={deviceBusy}
          />
          <Input
            className="max-w-sm"
            aria-label="小米相机访问密钥"
            type="password"
            autoComplete="new-password"
            value={token}
            placeholder={hasToken ? '留空保留已保存密钥' : '输入单独提供的 Bearer 密钥'}
            onChange={event => setToken(event.target.value)}
            disabled={deviceBusy}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={deviceBusy}
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
