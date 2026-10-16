import { Archive, Check, MessageSquare } from 'lucide-react'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type {
  AssistantDeskPage,
  AssistantDeskRow,
  AssistantDeskSession,
  AssistantMessageBatch,
  AssistantMessageBatchFilter,
  AssistantMessageBatchSummary,
} from '../../../shared/assistantDesk'
import { AssistantMessageCard, type DeskRequest } from './MessageCard'
import { assistantKindLabels, displayTime } from './presentation'
import { assistantSceneLabel } from './segmentPresentation'

type DisplayFilters = Omit<
  AssistantMessageBatchFilter,
  'accountId' | 'batchId' | 'cursor' | 'limit'
>

export function MessageBatchReader({
  accountId,
  sessionId,
  batches: allBatches,
  currentBatches,
  sessions = [],
  collecting,
  filters: _realtimeFilters,
  request,
  children,
}: {
  accountId: string
  sessionId?: string
  batches?: AssistantMessageBatchSummary
  currentBatches?: AssistantMessageBatchSummary
  sessions?: AssistantDeskSession[]
  collecting: boolean
  filters: DisplayFilters
  request: DeskRequest
  children: ReactNode
}) {
  const [sliceSeconds, setSliceSeconds] = useState(300)
  const [archiveFilters, setArchiveFilters] = useState<DisplayFilters>({})
  const batches = currentBatches ?? {
    batchSize: 1000,
    totalRows: undefined,
    archivedTotal: undefined,
    unreadTotal: undefined,
    current: allBatches?.current && allBatches.current.sessionId === sessionId ? allBatches.current : undefined,
    recent: sessionId ? allBatches?.recent.filter(batch => batch.sessionId === sessionId) ?? [] : [],
  }
  const requestRef = useRef(request)
  requestRef.current = request
  // Realtime display controls never change the recorded archive or its query.
  const filterKey = JSON.stringify(archiveFilters)
  const appliedFilters = useMemo(() => JSON.parse(filterKey) as DisplayFilters, [filterKey])
  const owner = `${accountId}:${sessionId ?? ''}:${sliceSeconds}`
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const filterRef = useRef(filterKey)
  filterRef.current = filterKey
  const [selected, setSelected] = useState<AssistantMessageBatch>()
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [items, setItems] = useState<AssistantDeskRow[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [pageIndex, setPageIndex] = useState(0)
  const pageCache = useRef(new Map<number, AssistantDeskPage<AssistantDeskRow>>())
  const pageCursors = useRef(new Map<number, string | undefined>())
  const requestedPage = useRef<{ index: number; cursor?: string }>({ index: 0 })
  const streamRef = useRef<HTMLDivElement>(null)
  const directoryRef = useRef<HTMLDetailsElement>(null)
  const [querying, setQuerying] = useState(false)
  const [queryError, setQueryError] = useState('')
  const rowSerial = useRef(0)
  const rowPending = useRef<string | undefined>(undefined)
  const [older, setOlder] = useState<AssistantMessageBatch[]>([])
  const readMetadata = useRef(new Map<string, AssistantMessageBatch>())
  const rememberBatch = useCallback((batch: AssistantMessageBatch, replaceEqual = true) => {
    const known = readMetadata.current.get(batch.id)
    const revision = batch.readRevision ?? 0
    if (
      known &&
      ((known.readRevision ?? 0) > revision ||
        (!replaceEqual && (known.readRevision ?? 0) === revision))
    )
      return known
    readMetadata.current.set(batch.id, batch)
    return batch
  }, [])
  const [listCursor, setListCursor] = useState<string>()
  const continuationAfter = useRef<string | undefined>(undefined)
  const [listLoaded, setListLoaded] = useState(false)
  const [listing, setListing] = useState(false)
  const listPending = useRef(false)
  const listSerial = useRef(0)
  const directoryEnabled = useRef(false)
  const [clock, setClock] = useState(Date.now)
  const sessionStartedAt = sessions.find(session => session.id === sessionId && session.accountId === accountId)?.startedAt
  useEffect(() => {
    if (!collecting || !sliceSeconds) return
    const timer = setInterval(() => {
      const now = Date.now()
      setClock(previous =>
        sessionStartedAt === undefined ||
        Math.floor((now - sessionStartedAt) / (sliceSeconds * 1000)) ===
          Math.floor((previous - sessionStartedAt) / (sliceSeconds * 1000))
          ? previous : now,
      )
    }, 1000)
    return () => clearInterval(timer)
  }, [collecting, sessionStartedAt, sliceSeconds])
  const closedSlice = !sliceSeconds || sessionStartedAt === undefined ? 0 : Math.max(0, Math.floor((clock - sessionStartedAt) / (sliceSeconds * 1000)))
  const legacyHead = `${batches?.archivedTotal ?? 0}:${(batches?.recent ?? []).map(batch => batch.id).join('|')}`
  const directoryHead = sliceSeconds
    ? `${sliceSeconds}:${closedSlice}:${collecting}:${collecting ? '' : batches?.totalRows ?? 0}`
    : legacyHead
  const directoryHeadRef = useRef(directoryHead)
  directoryHeadRef.current = directoryHead
  const listedHeadRef = useRef<string | undefined>(undefined)
  const listRequestRef = useRef<{ head: string; cursor?: string } | undefined>(undefined)
  const rebasePending = useRef(false)
  const [listError, setListError] = useState('')
  const [marking, setMarking] = useState(false)
  const markSerial = useRef(0)
  const markPending = useRef(false)
  const [markError, setMarkError] = useState('')

  const readRows = useCallback(
    async (batch: AssistantMessageBatch, targetPage = 0, cursor?: string) => {
      const scope = `${owner}:${batch.id}:${filterKey}`
      if (rowPending.current === scope) return
      requestedPage.current = { index: targetPage, cursor }
      setQueryError('')
      const cached = pageCache.current.get(targetPage)
      if (cached) {
        setItems(cached.items)
        setNextCursor(cached.nextCursor)
        setPageIndex(targetPage)
        if (streamRef.current) streamRef.current.scrollTop = 0
        return
      }
      const serial = ++rowSerial.current
      rowPending.current = scope
      setQuerying(true)
      setQueryError('')
      if (targetPage === 0) {
        setItems([])
        setNextCursor(undefined)
      }
      const current = () =>
        ownerRef.current === owner &&
        filterRef.current === filterKey &&
        selectedRef.current?.id === batch.id &&
        serial === rowSerial.current
      try {
        const result = await requestRef.current({
          action: 'message-batch',
          params: {
            accountId,
            batchId: batch.id,
            limit: 200,
            ...appliedFilters,
            ...(cursor ? { cursor } : {}),
          },
        })
        if (!current()) return
        if (!result.ok) setQueryError(result.error.message)
        else {
          const page = result.data as AssistantDeskPage<AssistantDeskRow>
          // A page replaces its predecessor. Never grow a 1000-card reading DOM.
          const previousIds = new Set(pageCache.current.get(targetPage - 1)?.items.map(row => row.id))
          const cachedPage = { ...page, items: [...new Map(page.items.filter(row => !previousIds.has(row.id)).map(row => [row.id, row])).values()].slice(0, 200) }
          pageCache.current.set(targetPage, cachedPage)
          // Retain five pages (at most 1000 facts); immediate back/forward is local.
          if (pageCache.current.size > 5) {
            const furthest = [...pageCache.current.keys()].sort((a, b) => Math.abs(b - targetPage) - Math.abs(a - targetPage))[0]
            pageCache.current.delete(furthest)
          }
          pageCursors.current.set(targetPage, cursor)
          if (page.nextCursor) pageCursors.current.set(targetPage + 1, page.nextCursor)
          setItems(cachedPage.items)
          setNextCursor(page.nextCursor)
          setPageIndex(targetPage)
          if (streamRef.current) streamRef.current.scrollTop = 0
        }
      } catch {
        if (current()) setQueryError('消息批次读取失败，请重试')
      } finally {
        if (current()) {
          rowPending.current = undefined
          setQuerying(false)
        }
      }
    },
    [accountId, appliedFilters, filterKey, owner],
  )

  const selectedId = selected?.id
  useEffect(() => {
    const batch = selectedRef.current
    pageCache.current.clear()
    pageCursors.current.clear()
    setPageIndex(0)
    if (batch && batch.id === selectedId) void readRows(batch)
  }, [selectedId, readRows])

  const rawRecent = sliceSeconds ? undefined : batches?.recent
  const recent = useMemo(
    () => rawRecent?.map(batch => rememberBatch(batch)),
    [rawRecent, rememberBatch],
  )
  useEffect(() => {
    const batch = selectedRef.current
    const canonical = (sliceSeconds ? older : recent)?.find(item => item.id === selectedId)
    if (
      batch &&
      canonical &&
      (batch.readAt !== canonical.readAt || batch.readRevision !== canonical.readRevision)
    ) {
      // Metadata from a fresh poll may change; the selected row snapshot stays untouched.
      setSelected(current =>
        current?.id === canonical.id && (canonical.readRevision ?? 0) >= (current.readRevision ?? 0)
          ? { ...current, readAt: canonical.readAt, readRevision: canonical.readRevision }
          : current,
      )
    }
  }, [older, recent, selectedId, sliceSeconds])

  const selectBatch = (batch: AssistantMessageBatch) => {
    if (selectedRef.current?.id === batch.id) return
    ++rowSerial.current
    ++markSerial.current
    rowPending.current = undefined
    markPending.current = false
    selectedRef.current = batch
    setSelected(batch)
    pageCache.current.clear()
    pageCursors.current.clear()
    setPageIndex(0)
    setItems([])
    setNextCursor(undefined)
    setQueryError('')
    setMarking(false)
    setMarkError('')
  }
  const returnRealtime = () => {
    ++rowSerial.current
    ++markSerial.current
    selectedRef.current = undefined
    rowPending.current = undefined
    markPending.current = false
    setSelected(undefined)
    pageCache.current.clear()
    pageCursors.current.clear()
    setPageIndex(0)
    setItems([])
    setNextCursor(undefined)
    setQueryError('')
    setMarking(false)
    setMarkError('')
  }
  const readList = useCallback(
    async function readDirectory(cursor?: string) {
      if (!sessionId) {
        setOlder([])
        setListLoaded(true)
        return
      }
      if (listPending.current) {
        if (
          !cursor &&
          (listRequestRef.current?.cursor ||
            listRequestRef.current?.head !== directoryHeadRef.current)
        ) {
          rebasePending.current = true
        }
        return
      }
      const requestedHead = directoryHeadRef.current
      const afterId = cursor ? continuationAfter.current : undefined
      const serial = ++listSerial.current
      const current = () => ownerRef.current === owner && listSerial.current === serial
      listPending.current = true
      listRequestRef.current = { head: requestedHead, cursor }
      setListing(true)
      setListError('')
      try {
        const result = await requestRef.current({
          action: 'message-batches',
          params: {
            accountId,
            limit: 20,
            ...(sliceSeconds ? { sliceSeconds } : {}),
            sessionId,
            ...(cursor ? { cursor } : {}),
          },
        })
        if (!current()) return
        if (!result.ok) setListError(result.error.message)
        else {
          const page = result.data as AssistantDeskPage<AssistantMessageBatch>
          const pageItems = page.items
            .filter(batch => batch.accountId === accountId && batch.sessionId === sessionId)
            .map(batch => rememberBatch(batch, false))
          setOlder(previous => {
            const anchor = afterId ? previous.findIndex(batch => batch.id === afterId) : -1
            const order = cursor
              ? anchor < 0
                ? [...previous, ...pageItems]
                : [...previous.slice(0, anchor + 1), ...pageItems, ...previous.slice(anchor + 1)]
              : [...pageItems, ...previous]
            const seen = new Set<string>()
            return order
              .filter(batch => {
                if (seen.has(batch.id)) return false
                seen.add(batch.id)
                return true
              })
              .map(batch => readMetadata.current.get(batch.id) ?? batch)
          })
          if (!cursor) listedHeadRef.current = requestedHead
          continuationAfter.current = page.items.at(-1)?.id
          setListCursor(page.nextCursor)
          setListLoaded(true)
        }
      } catch {
        if (current()) setListError('批次目录读取失败，请重试')
      } finally {
        if (current()) {
          listPending.current = false
          listRequestRef.current = undefined
          setListing(false)
          const refresh =
            directoryEnabled.current &&
            (rebasePending.current || directoryHeadRef.current !== requestedHead)
          rebasePending.current = false
          if (refresh) void readDirectory()
        }
      }
    },
    [accountId, owner, rememberBatch, sessionId, sliceSeconds],
  )
  useEffect(() => {
    if (directoryEnabled.current && directoryHead !== listedHeadRef.current) void readList()
  }, [directoryHead, readList])
  const markRead = async () => {
    const batch = selectedRef.current
    if (!batch || markPending.current) return
    const serial = ++markSerial.current
    markPending.current = true
    setMarking(true)
    setMarkError('')
    const current = () =>
      ownerRef.current === owner &&
      selectedRef.current?.id === batch.id &&
      markSerial.current === serial
    try {
      const result = await requestRef.current({
        action: 'message-batch-read',
        params: { accountId, batchId: batch.id, read: batch.readAt === undefined },
      })
      if (!current()) return
      if (!result.ok) setMarkError(result.error.message)
      else {
        const updated = rememberBatch(result.data as AssistantMessageBatch, false)
        selectedRef.current = updated
        setSelected(updated)
        setOlder(previous => previous.map(item => (item.id === updated.id ? updated : item)))
      }
    } catch {
      if (current()) setMarkError('已看状态保存失败，请重试')
    } finally {
      if (current()) {
        markPending.current = false
        setMarking(false)
      }
    }
  }
  const listedIds = new Set<string>()
  const archived = [...(recent ?? []), ...older]
    .filter(batch => {
      if (batch.accountId !== accountId || batch.sessionId !== sessionId) return false
      if (listedIds.has(batch.id)) return false
      listedIds.add(batch.id)
      return true
    })
    .map(batch => readMetadata.current.get(batch.id) ?? batch)
  const resetDirectory = () => {
    returnRealtime()
    setOlder([])
    setListCursor(undefined)
    setListLoaded(false)
    setListing(false)
    setListError('')
    listPending.current = false
    ++listSerial.current
    listRequestRef.current = undefined
    listedHeadRef.current = undefined
    continuationAfter.current = undefined
    rebasePending.current = false
  }
  const changeGrouping = (seconds: number) => {
    if (seconds === sliceSeconds) return
    resetDirectory()
    setSliceSeconds(seconds)
  }
  const updateFilter = <K extends keyof DisplayFilters>(key: K, value: DisplayFilters[K]) => {
    ++rowSerial.current
    rowPending.current = undefined
    setArchiveFilters(previous => {
      const updated = { ...previous }
      if (value === undefined) delete updated[key]
      else updated[key] = value
      return updated
    })
  }
  const sceneLabel = (id: string) => assistantSceneLabel(sessions.find(session => session.accountId === accountId && session.id === id))

  return (
    <div className="assistant-message-batches">
      <div className="assistant-batch-background" role="status">
        <span>
          {collecting ? '后台持续采集' : '采集已停止'} · 累计{' '}
          <span className="assistant-stable-number">{batches?.totalRows ?? '—'}</span> 条
        </span>
        <small>
          {sliceSeconds
            ? `按 ${sliceSeconds / 60} 分钟收起；时间切片结束后可读。`
            : batches?.current
            ? `当前第 ${batches.current.index} 批 · ${batches.current.total} / ${batches.batchSize} 条`
            : '每 1000 条收起为一个批次；场次结束后保留尾批。'}
        </small>
      </div>
      <div className="assistant-batch-layout">
        <div className="assistant-batch-main">
          {selected ? (
            <section
              className="assistant-panel assistant-live assistant-batch-reader"
              aria-label="消息批次归档"
            >
              <div className="assistant-section-heading">
                <div>
                  <span className="assistant-step">04 · 存档阅读</span>
                  <h2>
                    <MessageSquare size={18} />{selected.sliceSeconds ? '时间切片' : `第 ${selected.index} 批`} · 存档阅读
                  </h2>
                </div>
                <div className="assistant-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={marking}
                    onClick={() => void markRead()}
                  >
                    {selected.readAt === undefined ? '标记已看过' : '标记未看'}
                  </Button>
                  <Button size="sm" onClick={returnRealtime}>
                    返回实时
                  </Button>
                </div>
              </div>
              <p className="assistant-scene-caption assistant-muted">{sceneLabel(selected.sessionId)}</p>
              <p className="assistant-batch-read-status assistant-muted">
                {displayTime(selected.from)}–{displayTime(selected.to)} · 全量 {selected.total} 条 ·
                本页 {items.length} 条 · {selected.readAt === undefined ? '待查看' : '已看过'}
              </p>
              <fieldset style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                <legend>存档筛选 · 仅影响阅读，不改变全量记录</legend>
                <label>动作类型<select aria-label="存档动作类型" value={archiveFilters.kinds?.[0] ?? 'all'}
                  onChange={event => updateFilter('kinds', event.target.value === 'all' ? undefined : [event.target.value as AssistantDeskRow['kind']])}>
                  <option value="all">全部动作</option>
                  {Object.entries(assistantKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                </select></label>
                <label>处理优先级<select aria-label="存档优先级" value={archiveFilters.tier ?? 'all'}
                  onChange={event => updateFilter('tier', event.target.value === 'all' ? undefined : event.target.value as DisplayFilters['tier'])}>
                  <option value="all">全部优先级</option><option value="gold">高优先</option><option value="silver">中优先</option><option value="neutral">常规</option>
                </select></label>
                {([
                  ['minPayLevel', '消费等级门槛（存档）'],
                  ['minFansClubLevel', '粉丝团等级门槛（存档）'],
                  ['minFollowerCount', '粉丝数门槛（存档）'],
                ] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min="0" step="1"
                  style={{ width: 80 }} value={archiveFilters[key] ?? ''} onChange={event => {
                    const value = event.target.value === '' ? undefined : Number(event.target.value)
                    updateFilter(key, value !== undefined && (!Number.isSafeInteger(value) || value < 0) ? undefined : value)
                  }} /></label>)}
                <Button size="sm" variant="outline" onClick={() => {
                  ++rowSerial.current
                  rowPending.current = undefined
                  setArchiveFilters({})
                }}>清除存档筛选</Button>
              </fieldset>
              <div className="assistant-batch-query-status">
                {querying && <span role="status">正在读取消息批次…</span>}
                {queryError && (
                  <span role="alert" className="assistant-error-text">
                    {queryError}
                  </span>
                )}
                {markError && (
                  <span role="alert" className="assistant-error-text">
                    {markError}
                  </span>
                )}
                {queryError && (
                  <Button size="sm" variant="outline" onClick={() => void readRows(selected, requestedPage.current.index, requestedPage.current.cursor)}>
                    重试读取
                  </Button>
                )}
              </div>
              <div
                className="assistant-message-stream"
                ref={streamRef}
                role="log"
                aria-label="归档消息列表"
                aria-live="off"
                aria-busy={querying}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable archive needs keyboard access.
                tabIndex={0}
                style={{ overflowAnchor: 'none' }}
              >
                {items.map(row => (
                  <AssistantMessageCard
                    key={row.id}
                    row={row}
                    busy={false}
                    request={request}
                    interactive={false}
                  />
                ))}
                {!querying && !queryError && !items.length && (
                  <div className="assistant-empty">
                    <Archive size={28} />
                    <strong>本批没有符合筛选的消息</strong>
                    <p>可清除存档筛选查看完整记录。</p>
                  </div>
                )}
              </div>
              <div className="assistant-batch-page-actions">
                <Button size="sm" variant="outline" disabled={querying || pageIndex === 0}
                  onClick={() => void readRows(selected, pageIndex - 1, pageCursors.current.get(pageIndex - 1))}>上一页</Button>
                <span className="assistant-muted">第 {pageIndex + 1} 页 · 每页最多 200 条</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={querying || !nextCursor}
                    onClick={() => void readRows(selected, pageIndex + 1, nextCursor)}
                  >
                    下一页
                  </Button>
                <span className="assistant-muted">
                  阅读位置保持不动；后台消息继续进入新的批次。
                </span>
              </div>
            </section>
          ) : !collecting && sessionId ? (
            <section className="assistant-panel assistant-live" aria-label="采集已结束">
              <div className="assistant-section-heading">
                <div>
                  <span className="assistant-step">04 · 采集已结束</span>
                  <h2><Archive size={18} />采集已结束</h2>
                </div>
              </div>
              <p className="assistant-muted">本次消息已保存，最后未满一批的记录也可在采集切片中查看。</p>
              <Button size="sm" variant="outline" onClick={() => {
                if (directoryRef.current) directoryRef.current.open = true
              }}>
                查看采集切片 / 最后一批
              </Button>
            </section>
          ) : (
            children
          )}
        </div>
        <details
          ref={directoryRef}
          className="assistant-panel assistant-batch-rail"
          aria-label="消息批次存档"
          onToggle={event => {
            directoryEnabled.current = event.currentTarget.open
            if (event.currentTarget.open) {
              if (!listLoaded || directoryHead !== listedHeadRef.current) void readList()
            }
          }}
        >
          <summary>
            <Archive size={15} />
            {sliceSeconds ? `时间存档 · 已载入 ${archived.length} 个` : `批次存档 ${batches?.archivedTotal ?? archived.length}`} · 未看{' '}
            {(sliceSeconds ? undefined : batches?.unreadTotal) ?? archived.filter(batch => batch.readAt === undefined).length}
          </summary>
          <label className="assistant-batch-scope">存档分组
            <select aria-label="存档分组" value={sliceSeconds} onChange={event => changeGrouping(Number(event.target.value))}>
              <option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={600}>10 分钟</option>
              <option value={0}>每 1000 条</option>
            </select>
          </label>
          <p className="assistant-muted">固定显示本次采集；全部历史可在历史复盘中查看。</p>
          {!!sliceSeconds && <p className="assistant-muted">仅显示有消息的切片；无消息时段不生成切片，起止时间保持实际时间。</p>}
          <div className="assistant-batch-directory">
            {archived.map((batch, index) => (
              <Fragment key={batch.id}>
              {(index === 0 || archived[index - 1].sessionId !== batch.sessionId) && (
                <p className="assistant-scene-caption assistant-muted" data-scene-id={batch.sessionId}>{sceneLabel(batch.sessionId)}</p>
              )}
              <button
                type="button"
                data-batch-id={batch.id}
                aria-label={batch.sliceSeconds ? `查看时间切片 ${displayTime(batch.from)}–${displayTime(batch.to)}，${batch.total} 条` : `查看第 ${batch.index} 批，${batch.total} 条`}
                aria-pressed={selected?.id === batch.id}
                onClick={() => selectBatch(batch)}
              >
                <strong>
                  {batch.sliceSeconds ? `${displayTime(batch.from)}–${displayTime(batch.to)}` : `第 ${batch.index} 批`} <span>{batch.total} 条</span>
                </strong>
                <small>
                  {batch.sliceSeconds ? '采集切片' : `${displayTime(batch.from)}–${displayTime(batch.to)}`}
                </small>
                <span className="assistant-batch-reviewed">
                  {batch.readAt === undefined ? (
                    '待查看'
                  ) : (
                    <>
                      <Check size={12} />
                      已看过
                    </>
                  )}
                </span>
              </button>
              </Fragment>
            ))}
            {!archived.length && !listing && (
              <p className="assistant-muted">{sliceSeconds ? '时间切片结束后可读；停止采集后保留末尾切片。' : '满 1000 条后收起；采集继续。'}</p>
            )}
          </div>
          <div className="assistant-batch-list-status">
            {listing && <span role="status">正在读取批次目录…</span>}
            {listError && (
              <span role="alert" className="assistant-error-text">
                {listError}
              </span>
            )}
          </div>
          {(listCursor || !listLoaded || listError) && (
            <Button
              size="sm"
              variant="outline"
              disabled={listing}
              onClick={() => void readList(listCursor)}
            >
              加载更早批次
            </Button>
          )}
        </details>
      </div>
    </div>
  )
}
