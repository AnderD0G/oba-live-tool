import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import type { SetupAction, SetupStatus } from 'shared/setup'
import { Button } from '@/components/ui/button'
import { useAccounts } from '@/hooks/useAccounts'
import { useChromeConfigStore } from '@/hooks/useChromeConfig'
import '../CommentCatcher/style.css'

export default function Setup() {
  const [status, setStatus] = useState<SetupStatus>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const navigate = useNavigate()
  const { currentAccountId } = useAccounts()
  const run = useCallback(
    async (action: SetupAction) => {
      setBusy(true)
      setNotice('')
      try {
        const result = await window.ipcRenderer.invoke(IPC_CHANNELS.setup.request, action)
        if (!result.ok) throw new Error(result.error)
        if (result.status) {
          setStatus(result.status)
          if (result.status.browser) {
            const store = useChromeConfigStore.getState()
            if (!store.contexts[currentAccountId]?.path)
              store.setPath(currentAccountId, result.status.browser)
          }
        }
        if (result.message) setNotice(result.message)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '检测失败，请重试')
      } finally {
        setBusy(false)
      }
    },
    [currentAccountId],
  )
  useEffect(() => {
    void run('status')
  }, [run])
  function finish() {
    localStorage.setItem('oba-setup-v1', 'done')
    navigate('/')
  }
  return (
    <div className="catcher-page">
      <header>
        <div>
          <h1>安装与环境检查</h1>
          <p>
            弹幕、AI 规则助手和 40 × 30 mm 标签打印 · {status ? `v${status.version}` : '正在检查'}
          </p>
        </div>
        <Button disabled={busy} onClick={() => void run('status')}>
          {busy ? '请稍候…' : '重新检测'}
        </Button>
      </header>
      {notice && (
        <div className="catcher-notice" role="status">
          {notice}
        </div>
      )}
      <div className="catcher-grid">
        <section className="catcher-panel">
          <span className="catcher-step">01 / 连接直播间</span>
          <h2>浏览器</h2>
          <p>
            {status
              ? status.browser
                ? '已检测到浏览器，可打开中控台。'
                : status.browserError
              : '正在检测 Edge / Chrome…'}
          </p>
          {status?.browser && (
            <p className="catcher-muted" style={{ overflowWrap: 'anywhere' }}>
              {status.browser}
            </p>
          )}
          <p>首次连接时，在中控台登录这台电脑的小红书千帆账号，再开始监听弹幕。</p>
          <div className="catcher-actions">
            <Button disabled={busy} variant="outline" onClick={() => void run('browserDownload')}>
              安装 Edge
            </Button>
            <Link to="/settings">手动选择浏览器</Link>
          </div>
        </section>
        <section className="catcher-panel">
          <span className="catcher-step">02 / 可选 AI 功能</span>
          <h2>Codex 规则与回复助手</h2>
          <p>
            {status?.codex.available
              ? `${status.codex.bundled ? '内置组件已就绪，无须另外安装 CLI' : '已找到电脑上的 Codex CLI'} · ${status.codex.version}`
              : status
                ? 'Codex 组件尚未就绪'
                : '正在检测 Codex…'}
          </p>
          <p>
            {status?.codex.loggedIn
              ? '已检测到登录凭据。实际生成需要网络和可用额度。'
              : '尚未确认登录。使用 AI 助手前，请登录 ChatGPT。'}
          </p>
          {status?.codex.error && <p className="catcher-notice">{status.codex.error}</p>}
          <p className="catcher-muted">
            固定规则的筛选和打印不消耗 AI
            额度。内置组件不会替你购买额度，也不会带入另一台电脑的登录信息。
          </p>
          <div className="catcher-actions">
            <Button disabled={busy || !status?.codex.available} onClick={() => void run('login')}>
              登录 ChatGPT
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => void run('cancelLogin')}>
              取消登录
            </Button>
          </div>
        </section>
        <section className="catcher-panel">
          <span className="catcher-step">03 / 标签设备</span>
          <h2>打印机</h2>
          <p>
            {status?.printerError ??
              (status
                ? `Windows 已安装 ${status.printers.length} 台打印设备`
                : '正在读取打印设备…')}
          </p>
          {status?.printers.map(name => (
            <p key={name}>• {name}</p>
          ))}
          <p className="catcher-muted">
            请连接标签打印机并安装对应厂商驱动。PDF / OneNote
            是虚拟打印机，不能出实体标签。在“扣号打印”选择实际设备，纸张选 40 × 30 mm。
          </p>
          <div className="catcher-actions">
            <Button disabled={busy} variant="outline" onClick={() => void run('printers')}>
              添加 / 管理打印机
            </Button>
            <Link to="/capture-printing">前往扣号打印</Link>
          </div>
        </section>
        <section className="catcher-panel">
          <span className="catcher-step">04 / 开始使用</span>
          <h2>先监听，再捕获</h2>
          <p>
            ① 打开中控台，登录并连接直播间。
            <br />② 在自动回复页面开始监听。
            <br />③ 进入弹幕捕手，确认规则后开启捕获。
            <br />④ 在扣号打印里预览标签，再选择手动或自动打印。
          </p>
          <p className="catcher-muted">
            本安装包不含语音模型和虚拟声卡驱动。历史弹幕、打印队列和账号密码不会复制到新电脑。每次启动后，请自行开启监听、捕获和自动打印。
          </p>
        </section>
      </div>
      <div className="catcher-actions">
        <Button onClick={finish}>完成检查，进入中控台</Button>
        <Link to="/comment-catcher">先看看弹幕捕手</Link>
      </div>
      <p className="catcher-muted">
        之后可以随时从左侧“安装与环境检查”重新打开此页。支持 Windows 10 / 11 64 位。
      </p>
    </div>
  )
}
