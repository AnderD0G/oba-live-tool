import { CheckCheck, ListTodo, Pause, PinOff, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantDeskRow, AssistantDeskState } from '../../../shared/assistantDesk'
import { compareAssistantAttentionRows } from '../../../shared/assistantAttentionOrder'
import type {
  AssistantAudiencePolicy,
} from '../../../shared/assistantAudiencePolicy'
import { AttentionWindowPanel } from './AudiencePolicyPanel'
import { AssistantMessageCard, type DeskRequest, type ManualTranslationContext } from './MessageCard'
import { assistantKindLabels, needsReplyAttention } from './presentation'
import { useScrollFollow } from './useScrollFollow'

type Attention = NonNullable<AssistantDeskState['attention']>
const completed = (row: AssistantDeskRow) => ['sent', 'dismissed'].includes(row.reply.status)
const oldestFirst = (a: AssistantDeskRow, b: AssistantDeskRow) =>
  a.receivedAt - b.receivedAt || a.id.localeCompare(b.id)

export function useReplyWorkspace(
  accountId: string,
  rows: AssistantDeskRow[],
  attention?: Attention,
  prioritize = true,
) {
  const [memory, setMemory] = useState(() => ({
    accountId,
    unresolved: attention
      ? attention.rows.filter(row => !completed(row))
      : rows.filter(needsReplyAttention),
    processed: [] as AssistantDeskRow[],
  }))
  useEffect(() => {
    setMemory(previous => {
      const current =
        previous.accountId === accountId
          ? previous
          : {
              accountId,
              unresolved: [],
              processed: [],
            }
      const latest = new Map([...rows, ...(attention?.rows ?? [])].map(row => [row.id, row]))
      const known = current.unresolved
      const processed = new Map(current.processed.map(row => [row.id, row]))
      for (const row of known) {
        const update = latest.get(row.id)
        if (update && completed(update)) processed.set(update.id, update)
      }
      const unresolved = attention
        ? [...new Map([
            ...attention.rows,
            ...current.unresolved.filter(row => attention.pinnedRowIds?.includes(row.id)).map(row => latest.get(row.id) ?? row),
          ].map(row => [row.id, row])).values()].filter(row => !completed(row))
        : [...new Map([...current.unresolved, ...rows].map(row => [row.id, row])).values()].filter(
            needsReplyAttention,
          )
      return {
        accountId,
        unresolved,
        processed: [...processed.values()].sort((a, b) => -oldestFirst(a, b)).slice(0, 100),
      }
    })
  }, [accountId, rows, attention])
  const current = memory.accountId === accountId ? memory : { unresolved: [], processed: [] }
  const pendingRows = [...current.unresolved].sort((a, b) => compareAssistantAttentionRows(a, b, prioritize))
  const pinnedIds = new Set(attention?.pinnedRowIds ?? [])
  const recordResult = (data: unknown) => {
    const row = data as AssistantDeskRow | undefined
    if (
      !row ||
      row.accountId !== accountId ||
      typeof row.id !== 'string' ||
      !row.reply ||
      !completed(row)
    )
      return
    setMemory(previous => ({
      ...previous,
      unresolved: previous.unresolved.filter(other => other.id !== row.id),
      processed: [row, ...previous.processed.filter(other => other.id !== row.id)].slice(0, 100),
    }))
  }
  return {
    pendingRows,
    processedRows: current.processed,
    pinnedIds,
    recordResult,
    totalPending: attention ? Math.max(attention.total, pendingRows.length) : current.unresolved.length,
    archivedTotal: attention?.archivedTotal ?? 0,
  }
}

export function ReplyWorkspace({
  accountId,
  rows,
  processedRows,
  total,
  archivedTotal = 0,
  maxAgeSeconds = 600,
  attentionWindow,
  policy,
  pinnedIds,
  onUnpin,
  busy,
  request,
  manualTranslation,
}: {
  accountId: string
  rows: AssistantDeskRow[]
  processedRows: AssistantDeskRow[]
  total: number
  archivedTotal?: number
  maxAgeSeconds?: number
  attentionWindow?: Attention['window']
  policy?: AssistantAudiencePolicy
  pinnedIds: Set<string>
  onUnpin: (row: AssistantDeskRow) => void
  busy: boolean
  request: DeskRequest
  manualTranslation?: ManualTranslationContext
}) {
  const [tab, setTab] = useState<'pending' | 'processed'>('pending')
  const [kind, setKind] = useState<AssistantDeskRow['kind'] | 'all'>('all')
  const [clearing, setClearing] = useState(false)
  const clearingPending = useRef(false)
  const [clearNotice, setClearNotice] = useState<{ error: boolean; text: string }>()
  const clearable = total > 0 || archivedTotal > 0
  const [actionNotice, setActionNotice] = useState<{ error: boolean; text: string }>()
  const actionPending = useRef(new Set<string>())
  const [actionRows, setActionRows] = useState(new Set<string>())
  const rowRequest: DeskRequest = async command => {
    const rowId = 'rowId' in command.params ? command.params.rowId : undefined
    const comment = rows.find(row => row.id === rowId)?.kind === 'comment'
    if (!['attention-defer', 'attention-pin'].includes(command.action) || !rowId) return request(command)
    if (actionPending.current.has(rowId))
      return { ok: false, error: { code: 'IN_PROGRESS', message: '这条消息正在处理，请稍候' } }
    actionPending.current.add(rowId)
    setActionRows(new Set(actionPending.current))
    setActionNotice(undefined)
    try {
      const result = await request(command)
      setActionNotice({
        error: !result.ok,
        text: result.ok
          ? command.action === 'attention-pin'
            ? comment ? '已钉住；原文、中文译文与草稿会持续留在工作区。' : '已钉住；本次动作会持续留在工作区。'
            : pinnedIds.has(rowId)
              ? comment ? '已稍后处理，120 秒后重新提醒；钉住状态保留，中文译文与草稿仍在工作区。' : '已稍后处理，120 秒后重新提醒；钉住状态保留，动作仍在工作区。'
              : '已稍后处理，120 秒后重新提醒；消息仍在历史记录中。'
          : result.error.message,
      })
      return result
    } catch {
      const error = { code: 'DESK_UNAVAILABLE', message: command.action === 'attention-pin' ? '钉住失败，请重试；消息仍保留' : '稍后处理失败，请重试；消息仍保留' }
      setActionNotice({ error: true, text: error.message })
      return { ok: false, error }
    } finally {
      actionPending.current.delete(rowId)
      setActionRows(new Set(actionPending.current))
    }
  }
  const clear = async () => {
    if (clearingPending.current || !clearable) return
    clearingPending.current = true
    setClearing(true)
    setClearNotice(undefined)
    try {
      const result = await request({
        action: 'attention-clear',
        params: { accountId, scope: 'all', requestId: crypto.randomUUID() },
      })
      if (!result.ok) setClearNotice({ error: true, text: result.error.message })
      else {
        const data = result.data as { cleared: number; skippedSending: number }
        setClearNotice({
          error: false,
          text: `已清空 ${data.cleared} 条待处理；${data.skippedSending} 条正在发送，仍保留。完整记录可在历史复盘查看。`,
        })
      }
    } catch {
      setClearNotice({ error: true, text: '清空待处理失败，请重试；记录仍保留' })
    } finally {
      clearingPending.current = false
      setClearing(false)
    }
  }
  const unfiltered = tab === 'pending' ? rows : processedRows
  const shown =
    kind === 'all'
      ? unfiltered
      : unfiltered.filter(row => row.kind === kind)
  const follow = useScrollFollow(shown, { enabled: tab === 'pending', preserveAnchor: true,
    resetKey: `${accountId}:${tab}:${kind}` })
  return (
    <section className="assistant-panel assistant-reply-workspace" aria-label="待处理工作区">
      <div className="assistant-section-heading">
        <div>
          <span className="assistant-step">03 · 留在这里处理</span>
          <h2>
            <ListTodo size={20} />
            待处理工作区 <span className="assistant-count">{total} 条</span>
          </h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={clearing || !clearable}
          onClick={() => void clear()}
        >
          清空待处理
        </Button>
      </div>
      <p className="assistant-muted">手动清空包括归档中尚未处理的消息；历史原文保留。</p>
      <AttentionWindowPanel
        accountId={accountId}
        window={attentionWindow}
        policy={policy}
        request={request}
        pinnedIds={pinnedIds}
        busy={busy}
      />
      <p className="assistant-workspace-hint">
        当前采集最近 {maxAgeSeconds / 60} 分钟的动作进入待处理。钉住会跨过时限和批次保留原始记录，
        评论的中文译文与草稿一并保留，直到取消钉住、已处理或结束采集。稍后处理仅延后提醒。
      </p>
      {(attentionWindow || archivedTotal > 0) && (
        <p className={`assistant-muted ${attentionWindow ? 'assistant-workspace-archived' : ''}`}>
          已归档 <span className="assistant-stable-number">{archivedTotal}</span>{' '}
          条当前采集的待处理动作，可从上方归档批次快速阅读并钉住。
        </p>
      )}
      {clearNotice && (
        <p
          role={clearNotice.error ? 'alert' : 'status'}
          className={clearNotice.error ? 'assistant-error-text' : 'assistant-muted'}
        >
          {clearNotice.text}
        </p>
      )}
      {actionNotice && (
        <p
          role={actionNotice.error ? 'alert' : 'status'}
          className={actionNotice.error ? 'assistant-error-text' : 'assistant-muted'}
        >
          {actionNotice.text}
        </p>
      )}
      <div className="assistant-history-tabs" role="tablist" aria-label="动作处理状态">
        <Button
          size="sm"
          variant={tab === 'pending' ? 'default' : 'outline'}
          role="tab"
          aria-selected={tab === 'pending'}
          onClick={() => setTab('pending')}
        >
          待处理 {total}
        </Button>
        <Button
          size="sm"
          variant={tab === 'processed' ? 'default' : 'outline'}
          role="tab"
          aria-selected={tab === 'processed'}
          onClick={() => setTab('processed')}
        >
          <CheckCheck />
          已处理 {processedRows.length}
        </Button>
      </div>
      <label className="assistant-queue-category">
        待处理动作类型
        <select
          aria-label="待处理动作类型"
          value={kind}
          onChange={event => setKind(event.target.value as AssistantDeskRow['kind'] | 'all')}
        >
          <option value="all">全部动作</option>
          {Object.entries(assistantKindLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <small>
          显示 {shown.length} / 当前载入 {unfiltered.length} 条
        </small>
      </label>
      {tab === 'pending' && <div className="assistant-pending-follow" aria-label="待处理跟随控制">
        <div className="assistant-actions">
          <Button size="sm" variant="outline" aria-label={follow.following ? '暂停待处理跟随' : '恢复待处理跟随'}
            aria-pressed={!follow.following} onClick={follow.following ? follow.pause : follow.resume}>
            {follow.following ? <Pause /> : <Play />}{follow.following ? '暂停跟随' : '恢复跟随'}
          </Button>
          <Button size="sm" aria-label="回到待处理队首" onClick={follow.returnStart}>回到队首</Button>
          <label className="assistant-speed">滚动速度
            <select aria-label="待处理滚动速度" value={follow.speed} onChange={event => follow.setSpeed(event.target.value as typeof follow.speed)}>
              <option value="slow">慢</option><option value="medium">中</option><option value="fast">快</option>
            </select>
          </label>
        </div>
        <p className="assistant-muted">{!follow.following ? '跟随已暂停 · 处理仍可继续' : follow.hovered ? '鼠标停留 · 移开继续' : '按优先级与时间从队首缓慢跟随'}</p>
      </div>}
      <div
        className="assistant-reply-queue"
        role="tabpanel"
        aria-label={tab === 'pending' ? '待处理动作' : '本次已处理动作'}
        ref={follow.viewport}
        style={{ overflowAnchor: 'none' }}
        tabIndex={0}
        onPointerEnter={follow.enter}
        onPointerLeave={follow.leave}
        onScroll={follow.onScroll}
        onWheel={event => { if (event.deltaY !== 0) follow.pause() }}
        onPointerDown={event => {
          if (event.target === event.currentTarget && event.clientX >= event.currentTarget.getBoundingClientRect().right - 18) follow.pause()
        }}
        onKeyDown={event => {
          if (event.target === event.currentTarget && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) follow.pause()
        }}
        onFocusCapture={event => {
          if (event.target instanceof HTMLElement && event.target.matches('textarea,input,select,[contenteditable="true"]')) follow.pause()
        }}
      >
        {shown.map(row => (
          <div key={row.id} className="assistant-queue-item">
            {tab === 'pending' && pinnedIds.has(row.id) && (
              <div className="assistant-manual-pin">
                <span title="保留到取消钉住、已处理或结束本次采集">已钉住</span>
                <Button size="sm" variant="ghost" disabled={busy} title="取消固定保留；按当前批次和时限决定是否归档" onClick={() => onUnpin(row)}>
                  <PinOff />
                  取消钉住
                </Button>
              </div>
            )}
            <AssistantMessageCard
              row={row}
              busy={busy || actionRows.has(row.id)}
              request={rowRequest}
              pinned={pinnedIds.has(row.id)}
              attentionActions={tab === 'pending'}
              pinLabel="钉住"
              onPin={tab === 'pending' && !pinnedIds.has(row.id) ? row => void rowRequest({
                action: 'attention-pin', params: { accountId, rowId: row.id, pinned: true },
              }) : undefined}
              manualTranslation={manualTranslation && {
                ...manualTranslation,
                busy: manualTranslation.busy || actionRows.has(row.id),
              }}
            />
          </div>
        ))}
        {!shown.length && (
          <div className="assistant-empty">
            <ListTodo size={28} />
            <strong>
              {unfiltered.length && kind !== 'all'
                ? '当前动作类型没有消息'
                : tab === 'pending'
                  ? '当前没有待处理消息'
                  : '本次还没有已处理动作'}
            </strong>
            <p>
              {unfiltered.length && kind !== 'all'
                ? '选择全部动作可查看当前载入的消息。'
                : tab === 'pending'
                  ? '可在现场把评论、点赞、关注、进入、礼物、离开或其他动作手动留待处理。'
                  : '完成处理或确认发送后的动作会保留在这里，完整记录可在历史复盘中查询。'}
            </p>
          </div>
        )}
      </div>
      {tab === 'pending' && (attentionWindow || total > rows.length) && (
        <p className={`assistant-muted ${attentionWindow ? 'assistant-queue-overflow-hint' : ''}`}>
          {total > rows.length
            ? `待处理共 ${total} 条，当前显示 ${rows.length} 条。处理后会自动补上后续消息。`
            : '本批载入的消息已完整显示。旧批次仍可从上方归档查询。'}
        </p>
      )}
      {tab === 'processed' && (
        <p className="assistant-muted">保留本次打开页面后处理的最近 100 条，完整记录已存档。</p>
      )}
    </section>
  )
}
