import { useEffect, useMemo, useState } from 'react'
import type { AuditEntry } from 'shared/audit'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'

const statusLabel: Record<AuditEntry['status'], string> = {
  received: '收到',
  matched: '命中',
  skipped: '跳过',
  pending: '待处理',
  sent: '已发送',
  done: '已执行',
  failed: '失败',
}

export default function Audit() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [allAccounts, setAllAccounts] = useState(false)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      try {
        const rows = await window.ipcRenderer.invoke(
          IPC_CHANNELS.audit.list,
          allAccounts ? undefined : accountId,
        )
        if (mounted) {
          setEntries(rows)
          setError('')
        }
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : '读取日志失败')
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [accountId, allAccounts])

  const groups = useMemo(() => {
    const map = new Map<string, AuditEntry[]>()
    for (const row of entries) {
      const key = `${row.accountId || ''}:${row.origin}:${row.traceId}`
      map.set(key, [...(map.get(key) || []), row])
    }
    return [...map.entries()]
      .map(([key, rows]) => ({ key, rows: rows.reverse().sort((a, b) => a.at - b.at) }))
      .filter(({ rows }) => {
        const query = search.trim().toLowerCase()
        return (
          !query ||
          rows.some(row =>
            [
              row.userName,
              row.userId,
              row.message,
              row.content,
              row.ruleName,
              row.ruleId,
              row.actionType,
              row.detail,
            ].some(value => value?.toLowerCase().includes(query)),
          )
        )
      })
  }, [entries, search])

  return (
    <main className="p-6 space-y-4 overflow-y-auto h-full">
      <div>
        <h1 className="text-xl font-semibold">互动审查日志</h1>
        <p className="text-sm text-muted-foreground">
          按原始事件串起命中规则、AI 判断和实际动作。保留最近 30 天；页面最多读取最近 300 条记录。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label>
          <input
            type="checkbox"
            checked={allAccounts}
            onChange={event => setAllAccounts(event.target.checked)}
          />{' '}
          查看所有账号
        </label>
        <input
          className="rounded border bg-background px-3 py-2 min-w-60"
          placeholder="搜索观众、弹幕、规则或动作"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {!groups.length && (
        <p className="text-sm text-muted-foreground">
          暂无符合条件的记录。直播事件发生后会自动出现。
        </p>
      )}
      <div className="space-y-2">
        {groups.map(({ key, rows }) => {
          const event = rows.find(row => row.phase === 'event') || rows[0]
          const latest = rows[rows.length - 1]
          return (
            <section key={key} className="rounded border">
              <button
                type="button"
                className="w-full text-left p-3 flex flex-wrap gap-x-4 gap-y-1 items-center"
                onClick={() => setOpen(open === key ? null : key)}
              >
                <span className="text-xs text-muted-foreground">
                  {new Date(event.at).toLocaleString()}
                </span>
                <span className="font-medium">
                  {event.userName || event.userId || event.eventType || '系统事件'}
                </span>
                <span className="text-sm truncate max-w-80">
                  {event.message || event.eventType}
                </span>
                <span className="text-xs">
                  {latest.actionType || latest.ruleName || latest.detail}
                </span>
                <span className="ml-auto text-xs">
                  {statusLabel[latest.status]} {open === key ? '▲' : '▼'}
                </span>
              </button>
              {open === key && (
                <div className="border-t p-3 space-y-2 text-sm">
                  <p className="text-xs text-muted-foreground">
                    账号 {event.accountId || '—'} · 平台 {event.platform || '—'} · 用户 ID{' '}
                    {event.userId || '—'} · 事件 ID {event.traceId}
                  </p>
                  {rows.map(row => (
                    <div
                      key={row.id}
                      className="rounded bg-muted/40 p-2 grid gap-1 sm:grid-cols-[90px_90px_1fr]"
                    >
                      <span>{new Date(row.at).toLocaleTimeString()}</span>
                      <span>
                        {row.phase === 'event'
                          ? '事件'
                          : row.phase === 'decision'
                            ? '判断'
                            : '动作'}{' '}
                        · {statusLabel[row.status]}
                      </span>
                      <div className="break-words">
                        <b>{row.ruleName || row.actionType || row.eventType}</b>
                        {row.ruleId && (
                          <span className="text-xs text-muted-foreground">
                            {' '}
                            ({row.ruleId}
                            {row.ruleRevision ? ` @${row.ruleRevision}` : ''})
                          </span>
                        )}
                        {row.detail && <p>{row.detail}</p>}
                        {row.content && <p>内容：{row.content}</p>}
                        {row.preview && <p>试播记录</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </main>
  )
}
