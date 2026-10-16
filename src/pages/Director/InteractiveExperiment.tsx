import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type {
  DirectorExperimentCommand,
  DirectorExperimentResponse,
} from 'shared/directorExperiment'
import { IPC_CHANNELS } from 'shared/ipcChannels'

const buttonClass = 'rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40'
const experimentUrl = 'http://127.0.0.1:7789/'
const obsOverlayUrl = 'http://127.0.0.1:7789/overlay/welcome'
type ExperimentInvoker = (
  channel: typeof IPC_CHANNELS.directorExperiment.request,
  command: DirectorExperimentCommand,
) => Promise<DirectorExperimentResponse>

export function trustedExperimentUrl(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const response = result as Record<string, unknown>
  return response.ok === true &&
    response.ready === true &&
    response.mode === 'local-experiment' &&
    response.url === experimentUrl
    ? experimentUrl
    : undefined
}

export function requestInteractiveExperiment(
  action: DirectorExperimentCommand['action'],
  invoke: ExperimentInvoker = (channel, command) => window.ipcRenderer.invoke(channel, command),
) {
  return invoke(IPC_CHANNELS.directorExperiment.request, { action })
}

export default function InteractiveExperiment({ onOpenDirector }: { onOpenDirector: () => void }) {
  const [result, setResult] = useState<DirectorExperimentResponse>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [playerEnabled, setPlayerEnabled] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const playbackRequested = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const request = async (action: DirectorExperimentCommand['action']) => {
    if (inFlight.current) return
    inFlight.current = true
    if (action === 'start') playbackRequested.current = true
    setPending(true)
    setError('')
    try {
      const response = await requestInteractiveExperiment(action)
      if (!mounted.current) return
      setResult(response)
      const url = trustedExperimentUrl(response)
      setPlayerEnabled(Boolean(url && playbackRequested.current))
      if (!response.ok) setError(response.error || '本机互动实验暂不可用，请重试。')
      else if (response.ready && !url) setError('服务返回的地址不是已确认的本机实验播放器。')
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : '无法检查本机互动实验，请重试。')
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  const stopPlayer = () => {
    playbackRequested.current = false
    setPlayerEnabled(false)
  }
  const url = playerEnabled ? trustedExperimentUrl(result) : undefined

  return (
    <section aria-label="本机互动实验" className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
        <h2 className="text-lg font-semibold">互动实验 · 完整排练</h2>
        <p className="text-sm">
          顺序播放现有商品与步骤、IndexTTS2 原录音，使用千问即时回答和 B／D
          画面效果，测试观众进场与评论。
        </p>
        <p className="text-sm text-muted-foreground">
          这是本机实验，不会发送平台消息。本页排练不等于正式 OBS 输出；正式运行仍使用原导播台。
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
            disabled={pending}
            onClick={() => void request('start')}
          >
            {pending ? '正在检查服务…' : '加载互动实验'}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={pending}
            onClick={() => void request('status')}
          >
            重新检查
          </button>
          <button type="button" className={buttonClass} disabled={!url} onClick={stopPlayer}>
            停止实验播放器
          </button>
          <button type="button" className={buttonClass} onClick={onOpenDirector}>
            查看原导播台
          </button>
          <Link className={buttonClass} to="/analysis-room">
            打开分析室
          </Link>
        </div>
        <div className="space-y-1 pt-2">
          <label htmlFor="experiment-obs-overlay" className="block text-sm font-medium">
            OBS 欢迎叠层地址
          </label>
          <input
            id="experiment-obs-overlay"
            type="text"
            readOnly
            value={obsOverlayUrl}
            onFocus={event => event.currentTarget.select()}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            点击地址即可全选，复制到 OBS
            的“浏览器来源”。播放器里的打开按钮无法打开新窗口，请使用这里的地址。
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          切换标签会关闭此页播放器。本机服务继续保留；再次进入时点击加载，可复用已经启动的服务。
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600"
        >
          {error}
        </p>
      )}
      {!error && result && (
        <p role="status" className="text-sm text-muted-foreground">
          {result.ready
            ? result.modelReady === false
              ? '本机播放器已就绪；即时回答模型正在预热，已有原录音可先播放。'
              : result.modelReady === true
                ? '本机播放器和即时回答模型已就绪。'
                : '本机播放器已就绪，语音模型状态可在播放器内查看。'
            : '本机服务尚未就绪，请稍后点击重新检查。'}
        </p>
      )}
      {url ? (
        <iframe
          src={url}
          title="互动排练播放器"
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow="autoplay"
          className="w-full rounded-lg border bg-black"
          style={{ height: 900 }}
        />
      ) : (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          点击“加载互动实验”后，在这里进行完整排练。进入本页不会自动启动服务。
        </div>
      )}
    </section>
  )
}
