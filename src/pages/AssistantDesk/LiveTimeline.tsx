import { MessageSquare, Pause, Play } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssistantDeskRow } from '../../../shared/assistantDesk'
import type { AssistantAudiencePolicy } from '../../../shared/assistantAudiencePolicy'
import { AudiencePolicyActiveSummary } from './AudiencePolicyPanel'
import { AssistantMessageCard, type DeskRequest, type ManualTranslationContext } from './MessageCard'
import { useScrollFollow } from './useScrollFollow'

const displayLimit = 200

export function LiveTimeline({
  rows,
  busy,
  request,
  pinnedIds,
  onPin,
  attentionSession,
  manualTranslation,
  manualTranslationRows,
  audiencePolicy,
}: {
  rows: AssistantDeskRow[]
  busy: boolean
  request: DeskRequest
  pinnedIds?: Set<string>
  onPin?: (row: AssistantDeskRow) => void
  attentionSession?: { id?: string; maxAgeSeconds: number }
  manualTranslation?: ManualTranslationContext
  manualTranslationRows?: AssistantDeskRow[]
  audiencePolicy?: AssistantAudiencePolicy
}) {
  const [displayedRows, setDisplayedRows] = useState(() =>
    rows.length > displayLimit ? rows.slice(0, displayLimit) : rows,
  )
  const { viewport, following, hovered, followingRef, activeFollowing, speed, setSpeed,
    pause, resume, enter, leave } = useScrollFollow(displayedRows)
  const displayedRowsRef = useRef(displayedRows)
  const observedIds = useRef(new Set(rows.map(row => row.id)))
  useLayoutEffect(() => {
    displayedRowsRef.current = displayedRows
  }, [displayedRows])
  const pendingLatest = useRef(false)
  const [latestRequest, setLatestRequest] = useState(0)
  const readingAnchor = useRef<{ id: string; top: number; rows: AssistantDeskRow[] } | undefined>(
    undefined,
  )
  const returnLatest = () => {
    pendingLatest.current = true
    readingAnchor.current = undefined
    setLatestRequest(current => current + 1)
    resume()
  }
  useLayoutEffect(() => {
    if (!activeFollowing || !followingRef.current) return
    if (pendingLatest.current) {
      observedIds.current = new Set(rows.map(row => row.id))
      setDisplayedRows(rows.length > displayLimit ? rows.slice(0, displayLimit) : rows)
      return
    }
    const element = viewport.current
    const bounds = element?.getBoundingClientRect()
    const passed = new Set<string>()
    const protectedIds = new Set<string>()
    let anchor: { id: string; top: number } | undefined
    for (const card of element?.querySelectorAll<HTMLElement>('[data-row-id]') ?? []) {
      const rect = card.getBoundingClientRect()
      if (bounds && rect.bottom < bounds.top - 100) passed.add(card.dataset.rowId!)
      if (bounds && rect.top < bounds.bottom + 100) protectedIds.add(card.dataset.rowId!)
      if (!anchor && bounds && rect.bottom > bounds.top)
        anchor = { id: card.dataset.rowId!, top: rect.top }
    }
    const current = displayedRowsRef.current
    const currentIds = new Set(current.map(row => row.id))
    const latestById = new Map(rows.map(row => [row.id, row]))
    const arrivals = rows.filter(row => !currentIds.has(row.id) && !observedIds.current.has(row.id))
    const retained = current
      .filter(row => !passed.has(row.id))
      .map(row => (protectedIds.has(row.id) ? row : (latestById.get(row.id) ?? row)))
    let next = [...arrivals, ...retained]
    if (next.length > displayLimit) {
      // Keep the cards around the reading anchor while releasing older offscreen cards.
      const protectedRows = retained.filter(row => protectedIds.has(row.id))
      const protectedSet = new Set(protectedRows.map(row => row.id))
      next = [
        ...next
          .filter(row => !protectedSet.has(row.id))
          .slice(0, displayLimit - protectedRows.length),
        ...protectedRows,
      ]
    }
    observedIds.current = new Set(rows.map(row => row.id))
    if (next.length !== current.length || next.some((row, index) => row !== current[index])) {
      readingAnchor.current = anchor ? { ...anchor, rows: next } : undefined
      setDisplayedRows(next)
    }
  }, [rows, activeFollowing, latestRequest])
  useLayoutEffect(() => {
    const element = viewport.current
    const anchor = readingAnchor.current
    if (
      activeFollowing &&
      followingRef.current &&
      element &&
      anchor &&
      anchor.rows === displayedRows
    ) {
      const card = [...element.querySelectorAll<HTMLElement>('[data-row-id]')].find(
        card => card.dataset.rowId === anchor.id,
      )
      if (card) element.scrollTop += card.getBoundingClientRect().top - anchor.top
      readingAnchor.current = undefined
    }
    if (
      !activeFollowing ||
      !followingRef.current ||
      !pendingLatest.current ||
      displayedRows !== rows
    )
      return
    if (element) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    }
    pendingLatest.current = false
  }, [activeFollowing, displayedRows, rows, latestRequest])
  const displayedIds = new Set(displayedRows.map(row => row.id))
  const latestTranslations = manualTranslation
    ? new Map([...rows, ...(manualTranslationRows ?? [])].map(row => [row.id, row]))
    : undefined
  const newMessageCount = activeFollowing ? 0 : rows.filter(row => !displayedIds.has(row.id)).length
  return (
    <section className="assistant-panel assistant-live" aria-label="实时消息">
      <div className="assistant-section-heading">
        <div>
          <span className="assistant-step">04 · 持续采集现场</span>
          <h2>
            <MessageSquare size={18} />
            实时观众消息 <span className="assistant-count">{displayedRows.length}</span>
          </h2>
        </div>
        <div className="assistant-actions">
          <Button
            size="sm"
            variant="outline"
            aria-pressed={!following}
            onClick={following ? pause : resume}
          >
            {following ? <Pause /> : <Play />}
            {following ? '暂停跟随' : '恢复跟随'}
          </Button>
          <Button size="sm" onClick={returnLatest}>
            回到最新
          </Button>
          <label className="assistant-speed">
            滚动速度
            <select
              aria-label="滚动速度"
              value={speed}
              onChange={event => setSpeed(event.target.value as typeof speed)}
            >
              <option value="slow">慢</option>
              <option value="medium">中</option>
              <option value="fast">快</option>
            </select>
          </label>
        </div>
      </div>
      <div className="assistant-live-legend">
        <AudiencePolicyActiveSummary policy={audiencePolicy} />
        <span className="assistant-muted" style={{ minWidth: '19em' }}>
          {!following
            ? '跟随已暂停 · 采集仍继续'
            : hovered
              ? '鼠标停留 · 移开继续'
              : '正在跟随最新消息'}
        </span>
        {
          <span className="assistant-muted" style={{ whiteSpace: 'nowrap' }}>
            最新窗口有{' '}
            <span
              style={{
                display: 'inline-block',
                width: '3ch',
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
              }}
            >
              {newMessageCount}
            </span>{' '}
            条新消息
          </span>
        }
      </div>
      <div
        className="assistant-message-stream"
        role="log"
        ref={viewport}
        aria-label="观众消息列表"
        aria-live="off"
        style={{ overflowAnchor: 'none' }}
        tabIndex={0}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onWheel={event => {
          if (event.deltaY < 0) pause()
        }}
        onKeyDown={event => {
          if (
            event.target === event.currentTarget &&
            ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
          )
            pause()
        }}
      >
        {!displayedRows.length && (
          <div className="assistant-empty">
            <MessageSquare size={28} />
            <strong>等待第一条现场消息</strong>
            <p>登录、选择直播间，然后点击开始采集。</p>
          </div>
        )}
        {[...displayedRows].reverse().map(row => (
          <AssistantMessageCard
            key={row.id}
            row={row}
            busy={busy}
            request={request}
            interactive={false}
            pinned={pinnedIds?.has(row.id)}
            onPin={onPin}
            attentionSession={attentionSession}
            manualTranslation={manualTranslation}
            manualTranslationActions={!!manualTranslation}
            manualTranslationUpdate={latestTranslations?.get(row.id)}
          />
        ))}
      </div>
      <p className="assistant-muted">
        鼠标停在消息区时临时停住，移开自动继续。暂停按钮或向上回看会保持暂停；
        恢复跟随从原位置继续，回到最新会跳到最新消息。新消息连续追加，已看完的消息移出显示；
        现场最多显示 200 条；完整记录可在旁边的存档或历史复盘中回看。
      </p>
    </section>
  )
}
