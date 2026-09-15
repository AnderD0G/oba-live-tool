import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  type CaptureState,
  type CatcherCommand,
  describePolicy,
  matchCapture,
  type RuleDraft,
  type RuleTurn,
} from 'shared/commentCatcher'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import { useAccounts } from '@/hooks/useAccounts'
import { useAutoReply } from '@/hooks/useAutoReply'
import './style.css'

export default function CommentCatcher() {
  const { currentAccountId } = useAccounts()
  const { isListening } = useAutoReply()
  const [state, setState] = useState<CaptureState>()
  const [draft, setDraft] = useState<RuleDraft>()
  const [turns, setTurns] = useState<RuleTurn[]>([])
  const [input, setInput] = useState('')
  const [renameName, setRenameName] = useState('')
  const [name, setName] = useState('纯数字扣号')
  const [samples, setSamples] = useState('011\n零一一\n１２３\n我要011\n0 11\n十')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [ruleId, setRuleId] = useState('')
  const [dedupe, setDedupe] = useState<'message' | 'userCode'>('message')
  const [maxPerUser, setMaxPerUser] = useState(0)
  const [batchName, setBatchName] = useState(`扣号 ${new Date().toLocaleDateString()}`)
  const [includeRecent, setIncludeRecent] = useState(false)
  const [batchFilter, setBatchFilter] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  async function refresh() {
    const r = await window.ipcRenderer.invoke(IPC_CHANNELS.catcher.request, {
      action: 'state',
      accountId: currentAccountId,
    })
    if (r.ok && r.state) setState(r.state)
    else if (!r.ok) setNotice(r.error)
  }
  useEffect(() => {
    let alive = true
    setSelected([])
    setState(undefined)
    async function poll() {
      try {
        const r = await window.ipcRenderer.invoke(IPC_CHANNELS.catcher.request, {
          action: 'state',
          accountId: currentAccountId,
        })
        if (alive) {
          if (r.ok && r.state) setState(r.state)
          else if (!r.ok) setNotice(r.error)
        }
      } catch (e) {
        if (alive) setNotice(String(e))
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [currentAccountId])
  useEffect(() => {
    if (ruleId && ruleId !== 'all' && state?.rules && !state.rules.some(r => r.id === ruleId))
      setRuleId('all')
  }, [state?.rules, ruleId])
  const quotaDefault = state?.rules.find(r => r.id === ruleId)?.policy.maxPerUser ?? 0
  useEffect(() => setMaxPerUser(quotaDefault), [quotaDefault])
  async function command(c: CatcherCommand) {
    const r = await window.ipcRenderer.invoke(IPC_CHANNELS.catcher.request, c)
    if (!r.ok) throw new Error(r.error)
    await refresh()
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
  async function discuss() {
    if (!input.trim() || busy) return
    const next: RuleTurn[] = [...turns, { role: 'user', text: input.trim() }]
    setTurns(next)
    setInput('')
    setDraft(undefined)
    setBusy(true)
    await run(async () => {
      const r = await command({ action: 'discuss', turns: next })
      if (r.draft) {
        setDraft(r.draft)
        setTurns([
          ...next,
          {
            role: 'assistant',
            text: r.draft.message + (r.draft.policy ? `\n${describePolicy(r.draft.policy)}` : ''),
          },
        ])
      }
    })
    setBusy(false)
  }
  const rule = state?.rules.find(r => r.id === ruleId)
  const records = (state?.records ?? []).filter(
    r =>
      (!ruleId || ruleId === 'all' || r.ruleId === ruleId) &&
      (!batchFilter || r.batchId === batchFilter),
  )
  const batches = [...new Map((state?.records ?? []).map(r => [r.batchId, r.batchName])).entries()]
  const visible = records.slice(-500).reverse()
  const active = state?.active
  return (
    <div className="catcher-page">
      <header>
        <div>
          <h1>弹幕捕手</h1>
          <p>把口头需求变成固定规则，让每一次扣号都有记录。</p>
        </div>
        <Link to="/capture-printing">前往扣号打印 →</Link>
      </header>
      {notice && (
        <div className="catcher-notice" role="status">
          {notice}
        </div>
      )}
      {state?.error && <div className="catcher-notice">{state.error}</div>}
      <div className="catcher-grid">
        <section className="catcher-panel">
          <div className="catcher-step">01 · 制定规则</div>
          <h2>用自然语言说清楚</h2>
          <p className="catcher-muted">
            仅制定规则时调用常驻 Codex CLI；确认后的弹幕匹配不调用 AI。
          </p>
          <div className="catcher-conversation">
            {turns.length ? (
              turns.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Conversation is append-only within one draft.
                <div className={`turn ${t.role}`} key={i}>
                  <b>{t.role === 'user' ? '我' : '规则助手'}</b>
                  <p>{t.text}</p>
                </div>
              ))
            ) : (
              <p>例如：“捕获纯数字，支持零一一，也支持 011，位数不限但不超过 32 位。”</p>
            )}
          </div>
          <label htmlFor="rule-input">规则描述或补充回答</label>
          <textarea
            id="rule-input"
            value={input}
            maxLength={2000}
            rows={3}
            onChange={e => setInput(e.target.value)}
            placeholder="描述你想捕捉的弹幕…"
            disabled={busy}
          />
          <div className="catcher-actions">
            <Button disabled={busy || !input.trim()} onClick={() => void discuss()}>
              {busy ? '正在与常驻 CLI 确认…' : '发送给规则助手'}
            </Button>
            {busy && (
              <Button
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    await command({ action: 'cancel' })
                  })
                }
              >
                取消
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await command({ action: 'preset' })
                  setDraft(r.draft)
                  setTurns([])
                })
              }
            >
              使用纯数字预设
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(undefined)
                setTurns([])
                setNotice('')
              }}
            >
              新对话
            </Button>
          </div>
          {draft?.policy && (
            <div className="catcher-draft">
              <h3>待确认的固定规则</h3>
              <p>{describePolicy(draft.policy)}</p>
              <label htmlFor="rule-samples">试几条弹幕（每行一条）</label>
              <textarea
                id="rule-samples"
                value={samples}
                rows={4}
                maxLength={4000}
                onChange={e => setSamples(e.target.value)}
              />
              <div className="sample-results">
                {samples
                  .split('\n')
                  .filter(Boolean)
                  .slice(0, 30)
                  .map((s, i) => {
                    const hit = matchCapture(s, draft.policy!)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Stateless sample rows are rebuilt on every edit.
                      <div key={i}>
                        <code>{s}</code>
                        <span className={hit !== null ? 'hit' : 'miss'}>
                          {hit !== null ? `命中 → ${hit}` : '不命中'}
                        </span>
                      </div>
                    )
                  })}
              </div>
              <label htmlFor="rule-name">自定义规则名称</label>
              <input
                id="rule-name"
                value={name}
                maxLength={80}
                onChange={e => setName(e.target.value)}
              />
              <Button
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(async () => {
                    await command({ action: 'confirm', draftId: draft.id, name })
                    setDraft(undefined)
                    setNotice('规则已保存，可以在右侧选择并开始筛选')
                  })
                }
              >
                确认无误，保存规则
              </Button>
            </div>
          )}
        </section>
        <section className="catcher-panel">
          <div className="catcher-step">02 · 筛选与捕获</div>
          <h2>选择规则，开始一个批次</h2>
          <p className="catcher-muted">
            监听状态：{isListening === 'listening' ? '正在监听' : '尚未监听'} · 本次打开已缓存{' '}
            {state?.recentCount ?? 0} 条弹幕
          </p>
          <Link to="/auto-reply">去评论列表连接并开始监听 →</Link>
          <label htmlFor="saved-rule">已保存规则</label>
          <select
            id="saved-rule"
            value={ruleId}
            onChange={e => {
              setRuleId(e.target.value)
              setMaxPerUser(state?.rules.find(r => r.id === e.target.value)?.policy.maxPerUser ?? 0)
              setSelected([])
            }}
          >
            <option value="">选择规则</option>
            <option value="all">所有规则（查看历史）</option>
            {state?.rules.map(r => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {rule && (
            <>
              <p className="catcher-muted">{describePolicy(rule.policy)}</p>
              <div className="catcher-actions">
                <input
                  aria-label="规则新名称"
                  placeholder="输入新名称"
                  maxLength={80}
                  value={renameName}
                  onChange={e => setRenameName(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!renameName.trim()}
                  onClick={() =>
                    void run(async () => {
                      await command({ action: 'rename', ruleId: rule.id, name: renameName })
                      setRenameName('')
                    })
                  }
                >
                  重命名
                </Button>
                <Button
                  variant="ghost"
                  disabled={active?.ruleId === rule.id}
                  onClick={() =>
                    void run(async () => {
                      if (window.confirm('删除此规则？历史捕获记录仍会保留。'))
                        await command({ action: 'delete', ruleId: rule.id })
                    })
                  }
                >
                  删除规则
                </Button>
              </div>
            </>
          )}
          <label htmlFor="batch-name">批次名称（每次开始创建新批次）</label>
          <input
            id="batch-name"
            value={batchName}
            maxLength={80}
            onChange={e => setBatchName(e.target.value)}
          />
          <label htmlFor="dedupe-mode">重复扣号处理</label>
          <select
            id="dedupe-mode"
            value={dedupe}
            onChange={e => setDedupe(e.target.value as typeof dedupe)}
          >
            <option value="message">每条新弹幕都出一张（同一人重复也保留）</option>
            <option value="userCode">本批次同一用户 ID＋相同号码只捕获一次</option>
          </select>
          <label htmlFor="user-limit">每位观众本批次最多出几张单（0 = 不限）</label>
          <input
            id="user-limit"
            type="number"
            min={0}
            max={10000}
            value={maxPerUser}
            onChange={e => setMaxPerUser(Number(e.target.value))}
          />
          <p className="catcher-muted">
            按用户 ID 合计本批次所有号码。开启限额时，缺少用户 ID 的弹幕会跳过。
          </p>
          <label className="catcher-check">
            <input
              type="checkbox"
              checked={includeRecent}
              onChange={e => setIncludeRecent(e.target.checked)}
            />
            同时筛选本次打开已缓存的弹幕（最多 5000 条）
          </label>
          <p className="catcher-muted">
            不勾选时仅捕获开启之后的新弹幕。平台重复投递同一消息不会重复入单。缺少用户 ID
            时按消息区分。
          </p>
          <div className="catcher-actions">
            <Button
              disabled={!!active || !rule || isListening !== 'listening'}
              onClick={() =>
                void run(async () => {
                  await command({
                    action: 'start',
                    accountId: currentAccountId,
                    ruleId,
                    dedupe,
                    batchName,
                    includeRecent,
                    maxPerUser,
                  })
                  setNotice('捕获已开始；请到打印模块选择是否自动入队、自动打印')
                })
              }
            >
              开始筛选并持续捕获
            </Button>
            <Button
              variant="outline"
              disabled={!active}
              onClick={() =>
                void run(async () => {
                  await command({ action: 'stop' })
                })
              }
            >
              停止捕获
            </Button>
          </div>
          <div className="catcher-status">
            {active
              ? '● 正在捕获：' +
                active.batchName +
                ' · ' +
                (active.accountId === currentAccountId ? '当前账号' : '其他账号')
              : '○ 捕获未开启'}
          </div>
        </section>
      </div>
      <section className="catcher-panel">
        <div className="catcher-tablehead">
          <div>
            <h2>
              捕获结果 <span>{records.length}</span>
            </h2>
            <p className="catcher-muted">
              昵称与用户 ID 分开保留；扣号记录不代表付款订单。显示最近 500 条。
            </p>
          </div>
          <select
            aria-label="结果批次"
            value={batchFilter}
            onChange={e => {
              setBatchFilter(e.target.value)
              setSelected([])
            }}
          >
            <option value="">所有批次</option>
            {batches.map(([id, n]) => (
              <option key={id} value={id}>
                {n}
              </option>
            ))}
          </select>
          <Button
            disabled={!selected.length}
            onClick={() =>
              void run(async () => {
                const r = await window.ipcRenderer.invoke(IPC_CHANNELS.tickets.request, {
                  action: 'enqueue',
                  records: records.filter(r => selected.includes(r.id)),
                })
                if (!r.ok) throw new Error(r.error)
                setSelected([])
                setNotice('已加入独立打印队列。同一捕获记录不会重复入队。')
              })
            }
          >
            将选中项送入打印队列
          </Button>
        </div>
        <div className="catcher-table">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    aria-label="选择显示的记录"
                    type="checkbox"
                    checked={visible.length > 0 && visible.every(r => selected.includes(r.id))}
                    onChange={e => setSelected(e.target.checked ? visible.map(r => r.id) : [])}
                  />
                </th>
                <th>扣号</th>
                <th>观众 / 用户 ID</th>
                <th>弹幕原文</th>
                <th>时间 / 批次</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id}>
                  <td>
                    <input
                      aria-label={`选择 ${r.nickname} ${r.code}`}
                      type="checkbox"
                      checked={selected.includes(r.id)}
                      onChange={e =>
                        setSelected(
                          e.target.checked
                            ? [...selected, r.id]
                            : selected.filter(id => id !== r.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <strong>{r.code}</strong>
                  </td>
                  <td>
                    {r.nickname}
                    <small>{r.userId || '平台未提供 ID'}</small>
                  </td>
                  <td>{r.content}</td>
                  <td>
                    {new Date(r.time).toLocaleTimeString()}
                    <small>{r.batchName}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <p className="catcher-empty">还没有捕获结果。先确认规则，再开始筛选。</p>
          )}
        </div>
      </section>
    </div>
  )
}
