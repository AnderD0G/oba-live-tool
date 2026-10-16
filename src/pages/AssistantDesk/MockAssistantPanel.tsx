import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { MockMetadata } from '../../../electron/main/services/mockAssistant/MockMetadata'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { MOCK_LIMITS, type MockBatch } from '../../../shared/mockAssistant'
import type {
  MockAssistantCommand,
  MockAssistantControlState,
} from '../../../shared/mockAssistantControl'

type Action = MockAssistantCommand['action']
const phaseLabels = {
  idle: '尚未准备',
  prepared: '已准备，等待手动开始',
  running: '正在模拟',
  stopped: '模拟已停止',
}

export function MockAssistantPanel({
  accountId,
  realCaptureActive,
  onChanged,
}: {
  accountId: string
  realCaptureActive: boolean
  onChanged: (action: Action) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<MockAssistantControlState>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [playLocalEffects, setPlayLocalEffects] = useState(true)
  const alive = useRef(false)
  const operation = useRef(false)
  const reading = useRef(false)
  const sequence = useRef(0)
  const changed = useRef(onChanged)
  changed.current = onChanged
  useEffect(() => {
    alive.current = true
    const read = async () => {
      if (reading.current || operation.current) return
      reading.current = true
      const version = sequence.current
      try {
        const result = await window.ipcRenderer.invoke(IPC_CHANNELS.mockAssistant.request, {
          action: 'status',
          accountId,
        })
        if (
          alive.current &&
          version === sequence.current &&
          result.ok &&
          result.data &&
          'runtime' in result.data
        )
          setState(result.data)
      } catch {
        /* A control action reports errors; background reads retain the last observed state. */
      } finally {
        reading.current = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      alive.current = false
      sequence.current++
      clearInterval(timer)
    }
  }, [accountId])

  const perform = async (command: MockAssistantCommand) => {
    if (operation.current) return
    operation.current = true
    const version = ++sequence.current
    setBusy(command.action)
    setError('')
    setNotice('')
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.mockAssistant.request, command)
      if (!alive.current || version !== sequence.current) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.data && 'runtime' in result.data) setState(result.data)
      await changed.current(command.action)
      return result.data
    } catch {
      if (alive.current) setError('模拟操作结果未确认，请刷新状态后再决定是否重试')
    } finally {
      operation.current = false
      if (alive.current) setBusy('')
    }
  }
  const importFile = async (file?: File) => {
    if (!file || operation.current) return
    setError('')
    if (file.size > MOCK_LIMITS.maxBodyBytes) {
      setError('模拟 JSON 文件不能超过 2MB')
      return
    }
    const version = sequence.current
    let batch: MockBatch
    try {
      batch = JSON.parse(await file.text())
    } catch {
      if (alive.current) setError('JSON 格式无效，请检查后重新导入')
      return
    }
    if (!alive.current || version !== sequence.current) return
    await perform({ action: 'prepare', accountId, batch })
  }
  const exportJson = async (kind: 'metadata' | 'example') => {
    const data = (await perform({ action: 'metadata', accountId })) as MockMetadata | undefined
    if (!data) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(kind === 'example' ? data.example : data, null, 2)], {
        type: 'application/json',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `oba-mock-${kind}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice('已复制')
    } catch {
      setError('复制失败，请手动选取并复制')
    }
  }
  const runtime = state?.runtime
  const access = state?.access
  const accessToken = access?.token
  return (
    <details
      className="assistant-panel assistant-mock-panel"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary>模拟数据实验室</summary>
      {open && (
        <div className="assistant-mock-body">
          <p className="assistant-muted">
            模拟消息、草稿与历史仅在内存中，清空或退出应用后消失。回复始终由你手动发送；手机可以查看和处理，不能创建或播放模拟。
          </p>
          <div className="assistant-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={() => void exportJson('metadata')}
            >
              导出当前元数据 JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={() => void exportJson('example')}
            >
              导出示例 JSON
            </Button>
          </div>
          <label
            className="assistant-mock-drop"
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              if (event.dataTransfer.files.length !== 1) {
                setError('请一次导入一个 JSON 文件')
                return
              }
              void importFile(event.dataTransfer.files[0])
            }}
          >
            拖入 JSON，或选择文件（最大 2MB，仅准备，不自动播放）
            <input
              type="file"
              accept=".json,application/json"
              aria-label="导入模拟 JSON"
              disabled={!!busy}
              onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                void importFile(file)
              }}
            />
          </label>
          <p role="status">
            {runtime ? phaseLabels[runtime.phase] : '正在读取模拟状态…'}
            {runtime?.selected ? ' · 当前显示模拟数据' : ''}
          </p>
          {runtime?.batch && (
            <p>
              {runtime.batch.name} · {runtime.batch.userCount} 位观众 · {runtime.batch.eventCount}{' '}
              个事件 · {(runtime.batch.durationMs / 1000).toFixed(1)} 秒 · 已送入 {runtime.emitted}{' '}
              个事件
            </p>
          )}
          {runtime?.error && <p role="alert">{runtime.error.message}</p>}
          <label className="assistant-muted">
            <input
              type="checkbox"
              checked={playLocalEffects}
              disabled={!!busy || runtime?.phase === 'running'}
              onChange={event => setPlayLocalEffects(event.target.checked)}
            />
            模拟时播放 OBS 本地特效
          </label>
          <p className="assistant-muted">
            仅影响本次模拟。真实钩子为空时提供欢迎、点赞、关注测试模板；不发送公屏消息。
          </p>
          <div className="assistant-actions">
            <Button
              size="sm"
              disabled={
                !!busy || !runtime?.batch || runtime.phase === 'running' || realCaptureActive
              }
              onClick={() => void perform({ action: 'start', accountId, playLocalEffects })}
            >
              开始模拟
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || runtime?.phase !== 'running'}
              onClick={() => void perform({ action: 'stop', accountId })}
            >
              停止模拟
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !runtime?.batch}
              onClick={() => void perform({ action: 'clear', accountId })}
            >
              清空模拟数据
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !runtime?.selected}
              onClick={() => void perform({ action: 'leave', accountId })}
            >
              退出模拟
            </Button>
          </div>
          {realCaptureActive && <p className="assistant-warning">请先停止真实采集，再开始模拟。</p>}
          <div className="assistant-actions">
            <span>Worker API：{access?.active ? '已开启' : '已关闭'}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !state}
              onClick={() =>
                void perform({ action: access?.active ? 'api-stop' : 'api-start', accountId })
              }
            >
              {access?.active ? '关闭 Worker API' : '开启 Worker API'}
            </Button>
          </div>
          {access?.active && (
            <div className="assistant-mock-access">
              <p className="assistant-muted">
                API
                仅能查询规范、读取状态和准备批次；不能开始模拟或公开发送。只把下面的临时凭据交给你信任的本机或局域网
                Worker。
              </p>
              {access.urls.map(url => (
                <div key={url}>
                  <code>{url}</code>
                  <Button size="sm" variant="ghost" onClick={() => void copy(url)}>
                    复制 API 地址
                  </Button>
                </div>
              ))}
              {accessToken && (
                <div>
                  <code>{accessToken}</code>
                  <Button size="sm" variant="ghost" onClick={() => void copy(accessToken)}>
                    复制访问令牌
                  </Button>
                </div>
              )}
            </div>
          )}
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p role="alert" className="assistant-error-text">
              {error}
            </p>
          )}
        </div>
      )}
    </details>
  )
}
