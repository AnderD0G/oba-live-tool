import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { PrintState, TicketCommand } from 'shared/capturePrinting'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import '../CommentCatcher/style.css'

const statusName = {
  queued: '待打印',
  submitting: '正在提交',
  submitted: '已提交打印机',
  failed: '提交失败',
  uncertain: '出纸状态未确认',
}
export default function CapturePrinting() {
  const [state, setState] = useState<PrintState>()
  const [printers, setPrinters] = useState<{ name: string; displayName: string }[]>([])
  const [printer, setPrinter] = useState('')
  const [paper, setPaper] = useState<'40x30' | 'A4' | '80mm' | '58mm'>('40x30')
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  async function command(c: TicketCommand) {
    const r = await window.ipcRenderer.invoke(IPC_CHANNELS.tickets.request, c)
    if (!r.ok) throw new Error(r.error)
    if (r.state) setState(r.state)
    if (r.printers) setPrinters(r.printers)
    return r
  }
  async function run(fn: () => Promise<void>) {
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const r = await window.ipcRenderer.invoke(IPC_CHANNELS.tickets.request, { action: 'state' })
        if (alive) {
          if (r.ok && r.state) setState(r.state)
          else if (!r.ok) setNotice(r.error)
        }
      } catch (e) {
        if (alive) setNotice(String(e))
      }
    }
    void poll()
    void window.ipcRenderer
      .invoke(IPC_CHANNELS.tickets.request, { action: 'printers' })
      .then(r => {
        if (alive) {
          if (r.ok && r.printers) setPrinters(r.printers)
          else if (!r.ok) setNotice(r.error)
        }
      })
      .catch(e => {
        if (alive) setNotice(String(e))
      })
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const all = state?.tickets ?? []
  const filtered = all.filter(
    t =>
      !query ||
      [t.number, t.record.code, t.record.nickname, t.record.userId, t.record.batchName].some(s =>
        s.includes(query),
      ),
  )
  const visible = filtered.slice(-500).reverse()
  const chosen = all.filter(t => selected.includes(t.id))
  const sample = chosen[0]
  const queued = all.filter(t => t.status === 'queued')
  return (
    <div className="catcher-page">
      <header>
        <div>
          <h1>扣号打印</h1>
          <p>独立接收记录、生成单号、提交打印。默认 40 × 30 毫米标签。</p>
        </div>
        <Link to="/comment-catcher">返回弹幕捕手 →</Link>
      </header>
      {notice && (
        <div className="catcher-notice" role="status">
          {notice}
        </div>
      )}
      {state?.error && <div className="catcher-notice">{state.error}</div>}
      <div className="catcher-grid">
        <section className="catcher-panel">
          <div className="catcher-step">01 · 接收与打印</div>
          <h2>打印设置</h2>
          <div className="ticket-settings">
            <div>
              <label htmlFor="printer-select">系统打印机</label>
              <select
                id="printer-select"
                value={printer}
                disabled={!!state?.automatic}
                onChange={e => setPrinter(e.target.value)}
              >
                <option value="">请选择打印机</option>
                {printers.map(p => (
                  <option key={p.name} value={p.name}>
                    {p.displayName || p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="paper-size">纸张尺寸</label>
              <select
                id="paper-size"
                value={paper}
                disabled={!!state?.automatic}
                onChange={e => setPaper(e.target.value as typeof paper)}
              >
                <option value="40x30">标签 40 × 30 毫米</option>
                <option value="58mm">58 毫米小票 × 200 毫米</option>
                <option value="80mm">80 毫米小票 × 200 毫米</option>
                <option value="A4">A4</option>
              </select>
            </div>
          </div>
          <div className="catcher-actions">
            <Button
              variant="outline"
              onClick={() =>
                void run(async () => {
                  await command({ action: 'printers' })
                })
              }
            >
              刷新打印机列表
            </Button>
          </div>
          <label className="catcher-check">
            <input
              type="checkbox"
              checked={state?.autoQueue ?? false}
              onChange={e =>
                void run(async () => {
                  await command({ action: 'autoQueue', enabled: e.target.checked })
                })
              }
            />
            新捕获结果自动加入打印队列
          </label>
          <p className="catcher-muted">
            也可在弹幕捕手里手动选择记录后送入队列。相同捕获记录只生成一次单号。
          </p>
          <label className="catcher-check">
            <input
              type="checkbox"
              disabled={!printer && !state?.automatic}
              checked={!!state?.automatic}
              onChange={e => {
                const enabled = e.target.checked
                void run(async () => {
                  if (
                    enabled &&
                    !window.confirm(
                      '开启后，将向所选打印机自动提交现有待打印单及后续新单，每条一张。确认开启？',
                    )
                  )
                    return
                  await command({ action: 'automatic', enabled, printer, paper })
                })
              }}
            />
            自动打印待打印队列
          </label>
          <p className="catcher-muted">
            重启后自动入队、自动打印均关闭。停止自动打印不会撤回已提交的纸张。“已提交打印机”不等于确认纸张已打印。
          </p>
          <div className="catcher-status">
            {state?.automatic
              ? `● 自动打印已开启 · ${state.automatic.printer}`
              : '○ 自动打印未开启'}
            <br />
            待打印 {queued.length} · 已提交 {all.filter(t => t.status === 'submitted').length} ·
            需核对 {all.filter(t => t.status === 'uncertain').length}
          </div>
        </section>
        <section className="catcher-panel">
          <div className="catcher-step">02 · 核对单据</div>
          <h2>标签内容示意</h2>
          <p className="catcher-muted">
            选择记录后可打开按实际尺寸排版的预览。40×30
            标签保留关键字段，完整原文、完整昵称和批次在下方记录中。
          </p>
          <div className="label-demo">
            <small>
              扣号单 · 待核单{' '}
              <b style={{ float: 'right' }}>{sample?.number ?? 'K000001（示例）'}</b>
            </small>
            <h2>{sample?.record.code ?? '011'}</h2>
            <p>{sample?.record.nickname ?? '观众昵称'}</p>
            <p>ID {sample?.record.userId || '平台用户 ID'}</p>
            <small>
              {sample ? new Date(sample.record.time).toLocaleString() : '09/15 20:30:00'}
            </small>
          </div>
          <p className="catcher-muted">
            短单号可在下方搜索，查回完整记录。40×30 下扣号超过 24 字符或用户 ID 超过 40
            字符会要求改用大纸张。
          </p>
        </section>
      </div>
      <section className="catcher-panel">
        <div className="catcher-tablehead">
          <h2>打印队列与记录 · {all.length}</h2>
          <input
            aria-label="搜索打印记录"
            style={{ maxWidth: 300 }}
            placeholder="搜索单号、扣号、用户或批次"
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setSelected([])
            }}
          />
        </div>
        <div className="catcher-actions">
          <Button
            variant="outline"
            disabled={!selected.length || selected.length > 50 || busy}
            onClick={() =>
              void run(async () => {
                await command({ action: 'preview', ids: selected, paper })
              })
            }
          >
            预览选中标签
          </Button>
          <Button
            disabled={
              !selected.length ||
              selected.length > 50 ||
              !printer ||
              busy ||
              !!state?.automatic ||
              chosen.some(t => t.status !== 'queued')
            }
            onClick={() => {
              setBusy(true)
              void run(async () => {
                await command({ action: 'print', ids: selected, printer, paper })
                setSelected([])
                setNotice('选中单据已提交打印机，请核对实际出纸。')
              }).finally(() => setBusy(false))
            }}
          >
            {busy ? '正在提交…' : '打印选中项'}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setSelected(
                visible
                  .filter(t => t.status === 'queued')
                  .slice(0, 50)
                  .map(t => t.id),
              )
            }
          >
            选择最多 50 张待打印单
          </Button>
        </div>
        <div className="catcher-table">
          <table>
            <thead>
              <tr>
                <th>选择</th>
                <th>单号 / 扣号</th>
                <th>昵称 / 用户 ID</th>
                <th>原文 / 批次</th>
                <th>状态 / 操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(t => (
                <tr key={t.id}>
                  <td>
                    <input
                      aria-label={`选择单据 ${t.number}`}
                      type="checkbox"
                      checked={selected.includes(t.id)}
                      onChange={e =>
                        setSelected(
                          e.target.checked
                            ? [...selected, t.id]
                            : selected.filter(id => id !== t.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    {t.number}
                    <br />
                    <strong>{t.record.code}</strong>
                  </td>
                  <td>
                    {t.record.nickname}
                    <small>{t.record.userId || '未提供 ID'}</small>
                  </td>
                  <td>
                    {t.record.content}
                    <small>
                      {t.record.batchName} · {new Date(t.record.time).toLocaleString()}
                    </small>
                  </td>
                  <td>
                    {statusName[t.status]}
                    {t.error && <small>{t.error}</small>}
                    {['submitted', 'uncertain', 'failed'].includes(t.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!state?.automatic || busy}
                        onClick={() =>
                          void run(async () => {
                            if (window.confirm('重置后可以再次出纸。请先核对，确定需要补打一张？'))
                              await command({ action: 'reset', id: t.id })
                          })
                        }
                      >
                        核对后补打
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && <p className="catcher-empty">队列为空。先从弹幕捕手送入捕获结果。</p>}
        </div>
      </section>
    </div>
  )
}
