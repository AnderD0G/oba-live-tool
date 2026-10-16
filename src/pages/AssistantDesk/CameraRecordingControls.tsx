import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { ObsCameraRecordingState } from '../../../shared/obsCameraRecording'
import type { ObsEffectCommand, ObsEffectResponse } from '../../../shared/obsEffect'

type Request = (command: ObsEffectCommand) => Promise<ObsEffectResponse>
const invoke: Request = command =>
  window.ipcRenderer.invoke(IPC_CHANNELS.obsEffect.request, command)
const labels = { iphone: 'iPhone', android: '小米4K' }
const markStatus = {
  pending: '正在提交',
  confirmed: 'OBS 已接受章节',
  unconfirmed: '结果待确认',
  failed: '提交失败',
}

function offset(value: number) {
  const milliseconds = Math.max(0, Math.floor(value))
  return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}`
}
function isState(value: unknown): value is ObsCameraRecordingState {
  if (!value || typeof value !== 'object') return false
  const state = value as ObsCameraRecordingState
  return (
    typeof state.ok === 'boolean' &&
    typeof state.ready === 'boolean' &&
    typeof state.running === 'boolean' &&
    Array.isArray(state.cameras) &&
    Array.isArray(state.marks)
  )
}

/** A click owns one run and one request. State refreshes never repeat recording writes. */
export function CameraRecordingControls({ request = invoke }: { request?: Request }) {
  const [recording, setRecording] = useState<ObsCameraRecordingState>()
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const [label, setLabel] = useState('')
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const readingRef = useRef(false)
  const serial = useRef(0)

  const refresh = useCallback(
    async (preserveError = false) => {
      if (busyRef.current || readingRef.current) return
      readingRef.current = true
      const version = ++serial.current
      let receivedState = false
      if (!preserveError) setError('')
      try {
        const result = await request({ action: 'camera-recording-status' })
        if (!mounted.current || version !== serial.current) return
        if (isState(result.recording)) {
          receivedState = true
          setRecording(result.recording)
          setFresh(true)
        }
        if (!result.ok) throw Error(result.error)
        if (!isState(result.recording)) throw Error('OBS 未返回可核对的录像状态')
        if (!result.recording.ok) setError(result.recording.error || '录像状态尚未确认，请检查 OBS')
      } catch (cause) {
        if (mounted.current && version === serial.current) {
          if (!receivedState) setFresh(false)
          setError(cause instanceof Error ? cause.message : '读取录像状态失败')
        }
      } finally {
        readingRef.current = false
      }
    },
    [request],
  )

  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('oba:obs-camera-changed', onFocus)
    return () => {
      mounted.current = false
      serial.current++
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('oba:obs-camera-changed', onFocus)
    }
  }, [refresh])
  useEffect(() => {
    if (!recording?.running) return
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(true)
    }, 5000)
    return () => clearInterval(timer)
  }, [recording?.running, refresh])

  const mutate = async (action: 'start' | 'stop' | 'mark') => {
    if (busyRef.current) return
    const runId = recording?.runId
    if (action !== 'start' && !runId) return
    const requestId = crypto.randomUUID()
    const command: ObsEffectCommand =
      action === 'start'
        ? { action: 'camera-recording-start', requestId }
        : action === 'stop'
          ? { action: 'camera-recording-stop', runId: runId!, requestId }
          : {
              action: 'camera-recording-mark',
              runId: runId!,
              requestId,
              ...(label.trim() ? { label: label.trim() } : {}),
            }
    busyRef.current = true
    serial.current++
    setBusy(action)
    setFresh(false)
    setError('')
    let needsRefresh = false
    try {
      const result = await request(command)
      if (!mounted.current) return
      if (isState(result.recording)) {
        setRecording(result.recording)
        setFresh(true)
      }
      if (!result.ok) throw Error(result.error)
      if (!isState(result.recording)) throw Error('OBS 未返回可核对的录像结果，请刷新状态')
      const state = result.recording
      if (!state.ok) throw Error(state.error || '录像操作结果尚未确认')
      if (action === 'mark') {
        const receipt = state.marks.find(
          mark => mark.runId === runId && mark.requestId === requestId,
        )
        if (receipt?.status !== 'confirmed')
          throw Error(receipt?.error || '章节结果未确认，请刷新状态后核对')
        setLabel('')
      }
    } catch (cause) {
      needsRefresh = true
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : '操作结果未确认，请刷新状态后核对')
    } finally {
      busyRef.current = false
      if (mounted.current) {
        setBusy(undefined)
        if (needsRefresh) void refresh(true)
      }
    }
  }
  const active = !!recording?.running
  const canStart =
    fresh &&
    recording?.ok &&
    recording.ready &&
    !active &&
    !recording.cameras.some(camera => camera.active)
  const canMark =
    fresh &&
    active &&
    !!recording?.runId &&
    recording.cameras.some(camera => camera.active && camera.owned)
  return (
    <section className="assistant-panel" aria-label="双路独立录像">
      <div className="assistant-actions">
        <strong>双路独立录像</strong>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void refresh()}>
          刷新录像状态
        </Button>
        <span role="status" className="assistant-muted">
          {!recording
            ? '正在读取录像状态…'
            : !fresh
              ? '录像状态待确认'
              : active
                ? '独立录像进行中'
                : '独立录像未开始'}
        </span>
      </div>
      <p className="assistant-muted">
        iPhone、小米各录一个文件，切换节目持续录制。章节只写到打点时实际节目中的机位。
      </p>
      <div className="assistant-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy || !canStart}
          onClick={() => void mutate('start')}
        >
          开始两路录像
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy || !active || !recording?.runId}
          onClick={() => void mutate('stop')}
        >
          停止两路录像
        </Button>
        <input
          aria-label="章节标题"
          placeholder="标题（可选：补货、观众问题）"
          value={label}
          maxLength={100}
          disabled={!!busy}
          onChange={event => setLabel(event.target.value)}
          style={{
            minWidth: 160,
            minHeight: 32,
            maxWidth: '100%',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 8px',
          }}
        />
        <Button size="sm" disabled={!!busy || !canMark} onClick={() => void mutate('mark')}>
          打点当前机位
        </Button>
      </div>
      <p className="assistant-muted">
        录像中可按 ⌘⇧M / Ctrl⇧M 打章节，OBS 在前台也可用。以下时间为采样估计，以文件内章节为准。
      </p>
      {busy && (
        <p role="status" className="assistant-muted">
          {busy === 'start'
            ? '正在启动两路录像…'
            : busy === 'stop'
              ? '正在停止并核对文件…'
              : '正在核对节目机位并写入章节…'}
        </p>
      )}
      {error && (
        <p role="alert" className="assistant-error-text">
          {error}
        </p>
      )}
      {!error && recording?.error && (
        <p role="alert" className="assistant-error-text">
          {recording.error}
        </p>
      )}
      {recording?.cameras.map(camera => (
        <div
          key={camera.target}
          className="assistant-muted"
          style={{ marginTop: 6, overflowWrap: 'anywhere' }}
        >
          <strong>{labels[camera.target]}</strong> ·{' '}
          {camera.active ? (camera.owned ? '独立录像中' : '已在外部录像') : '未录像'}
          {camera.outputPath && <div>{camera.outputPath}</div>}
          {camera.error && <div className="assistant-error-text">{camera.error}</div>}
        </div>
      ))}
      {recording?.indexPath && (
        <p className="assistant-muted" style={{ overflowWrap: 'anywhere' }}>
          章节索引：<span>{recording.indexPath}</span>
        </p>
      )}
      {recording?.manifestPath && (
        <p className="assistant-muted" style={{ overflowWrap: 'anywhere' }}>
          录像记录：<span>{recording.manifestPath}</span>
        </p>
      )}
      {!!recording?.marks.length && (
        <details open>
          <summary>录像章节 · {recording.marks.length}</summary>
          <ol style={{ maxHeight: 210, overflowY: 'auto', paddingLeft: 22 }}>
            {[...recording.marks].reverse().map(mark => (
              <li
                key={`${mark.runId}:${mark.requestId}`}
                style={{ marginTop: 8, overflowWrap: 'anywhere' }}
              >
                <strong>{mark.chapterName}</strong> · {labels[mark.target]} · 约
                {offset(mark.offsetMs)} · {markStatus[mark.status]}
                <div className="assistant-muted">{mark.outputPath}</div>
                {mark.error && <div className="assistant-error-text">{mark.error}</div>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
