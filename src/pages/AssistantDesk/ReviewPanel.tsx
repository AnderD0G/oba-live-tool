import {
  Bookmark,
  Link2,
  MessageSquare,
  Play,
  Search,
  Square,
  Unlink,
  Users,
  Video,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type {
  AssistantDeskAudience,
  AssistantDeskPage,
  AssistantDeskRow,
  AssistantDeskSegment,
  AssistantDeskSegmentSummary,
  AssistantDeskState,
} from '../../../shared/assistantDesk'
import { AssistantMessageCard, type DeskRequest } from './MessageCard'
import {
  buildHistoryFilter,
  displayDuration,
  displayTime,
  type HistoryFilterDraft,
  paymentTier,
} from './presentation'
import { captureRoomLabel, currentCaptureRun, groupSegmentsByCapture } from './segmentPresentation'

function RecordingLink({ path }: { path: string }) {
  const [error, setError] = useState('')
  // Only locally recorded absolute paths are eligible; unknown values stay plain text.
  const normalized = path.replace(/\\/g, '/')
  const href = /^[A-Za-z]:\//.test(normalized)
    ? `file:///${normalized.split('/').map(part => encodeURIComponent(part)).join('/')}`.replace(/%3A/i, ':')
    : normalized.startsWith('/') ? `file://${normalized.split('/').map(part => encodeURIComponent(part)).join('/')}` : undefined
  return (
    <div>
      <p className="assistant-record-path">场次录像：{href ? <a href={href} onClick={event => {
        event.preventDefault()
        setError('')
        void window.ipcRenderer.invoke(IPC_CHANNELS.app.openExternal, href).catch(() => setError('录像打开失败，请核对文件是否仍在原位置。'))
      }}>{path}</a> : path}</p>
      {error && <p role="alert" className="assistant-error-text">{error}</p>}
    </div>
  )
}

function SegmentRow({
  segment,
  accountId,
  busy,
  request,
}: {
  segment: AssistantDeskSegment
  accountId: string
  busy: boolean
  request: DeskRequest
}) {
  const [summary, setSummary] = useState<AssistantDeskSegmentSummary>()
  return (
    <div className="assistant-segment">
      <div className="assistant-segment-title">
        <strong>{segment.name}</strong>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void request({
              action: 'segment-summary',
              params: { accountId, segmentId: segment.id },
            }).then(result => {
              if (result.ok) setSummary(result.data as AssistantDeskSegmentSummary)
            })
          }
        >
          查看片段摘要
        </Button>
      </div>
      <p className="assistant-muted">
        {displayTime(segment.startedAt, true)} →{' '}
        {segment.endedAt ? displayTime(segment.endedAt) : '进行中'} ·{' '}
        {displayDuration(segment.startedAt, segment.endedAt)}
      </p>
      {summary && (
        <dl className="assistant-summary">
          <div>
            <dt>发言</dt>
            <dd>{summary.comments}</dd>
          </div>
          <div>
            <dt>关注</dt>
            <dd>{summary.follows}</dd>
          </div>
          <div>
            <dt>进入 / 离开</dt>
            <dd>
              {summary.enters} / {summary.leaves}
            </dd>
          </div>
          <div>
            <dt>礼物金币</dt>
            <dd>
              {summary.knownGiftCoins}
              <small>未知币值 {summary.unknownGiftGroups} 组</small>
            </dd>
          </div>
          <div>
            <dt>在线人数变化</dt>
            <dd>
              {summary.onlineChange === undefined
                ? '未知'
                : `${summary.onlineChange > 0 ? '+' : ''}${summary.onlineChange}`}
              <small>
                {summary.onlineStart ?? '未知'} → {summary.onlineEnd ?? '未知'}
              </small>
            </dd>
          </div>
        </dl>
      )}
    </div>
  )
}

function recordingPresentation(value: unknown) {
  if (!value || typeof value !== 'object') return { label: '录像命令已完成', path: undefined }
  const data = value as Record<string, unknown>
  const label =
    typeof data.active === 'boolean'
      ? data.active
        ? 'OBS 正在录像'
        : 'OBS 未在录像'
      : typeof data.outputActive === 'boolean'
        ? data.outputActive
          ? 'OBS 正在录像'
          : 'OBS 未在录像'
        : typeof data.recording === 'boolean'
          ? data.recording
            ? 'OBS 正在录像'
            : 'OBS 未在录像'
          : '录像命令已完成'
  const output = data.outputPath ?? data.recordingPath ?? data.path
  return { label, path: typeof output === 'string' ? output : undefined }
}

export function AssistantAudienceTable({
  audience,
  busy,
  onSelectLink,
  onUnlink,
}: {
  audience: AssistantDeskAudience[]
  busy: boolean
  onSelectLink: (uuid: string) => void
  onUnlink: (uuid: string) => void
}) {
  return (
    <div className="assistant-audience-table">
      <table>
        <caption className="assistant-muted">粉丝数显示最近一次观测；悬停查看观测时间。</caption>
        <thead>
          <tr>
            <th>观众 / 来源身份</th>
            <th>等级</th>
            <th>粉丝数</th>
            <th>发言 / 进场 / 离场 / 关注</th>
            <th>礼物贡献</th>
            <th>身份关联</th>
          </tr>
        </thead>
        <tbody>
          {audience.map(person => {
            const followerCount =
              typeof person.followerCount === 'number' &&
              Number.isSafeInteger(person.followerCount) &&
              person.followerCount > 0
                ? person.followerCount
                : undefined
            return (
              <tr key={person.uuid} className={`assistant-tier-${paymentTier(person.payLevel)}`}>
                <td>
                  <strong>{person.nickname}</strong>
                  <small>{person.mentionHandle ? `用户名 @${person.mentionHandle}` : '用户名未提供'}</small>
                  <small>
                    {person.platform} · {person.userId}
                  </small>
                  <small>UUID {person.uuid}</small>
                  <small>最近出现 {displayTime(person.lastSeenAt, true)}</small>
                </td>
                <td>
                  消费 {person.payLevel ?? '未知'}
                  <small>粉丝团 {person.fansClubLevel ?? '未知'}</small>
                </td>
                <td
                  title={
                    followerCount === undefined
                      ? '平台未提供有效粉丝数'
                      : `观测时间：${displayTime(person.followerCountObservedAt, true)}`
                  }
                >
                  {followerCount === undefined ? '粉丝数未知' : `粉丝 ${followerCount}`}
                </td>
                <td>
                  {person.comments} / {person.enters} / {person.leaves} / {person.follows}
                </td>
                <td>
                  {person.knownGiftCoins} 金币<small>最终礼物 {person.finalGiftGroups} 组</small>
                  <small>币值未知 {person.unknownGiftGroups} 组</small>
                </td>
                <td>
                  {person.linkedUuid ? (
                    <>
                      <small>关联 UUID {person.linkedUuid}</small>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onUnlink(person.uuid)}
                      >
                        <Unlink />
                        解除关联
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => onSelectLink(person.uuid)}>
                      <Link2 />
                      选择关联来源
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function ReviewPanel({
  accountId,
  state,
  busy,
  request,
}: {
  accountId: string
  state: AssistantDeskState
  busy: boolean
  markPending?: boolean
  request: DeskRequest
}) {
  const emptyFilter = (): HistoryFilterDraft => ({
    sessionId: '',
    audienceUuid: '',
    userId: '',
    mentionHandle: '',
    nickname: '',
    from: '',
    to: '',
    minPayLevel: '',
  })
  const [filter, setFilter] = useState<HistoryFilterDraft>(emptyFilter)
  const [tab, setTab] = useState<'timeline' | 'audience'>('timeline')
  const [history, setHistory] = useState<AssistantDeskRow[]>([])
  const [audience, setAudience] = useState<AssistantDeskAudience[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [queried, setQueried] = useState(false)
  const [applied, setApplied] = useState<ReturnType<typeof buildHistoryFilter>>()
  const [appliedDraft, setAppliedDraft] = useState<HistoryFilterDraft>()
  const [querying, setQuerying] = useState<'timeline' | 'audience'>()
  const queryingRef = useRef(false)
  const [localError, setLocalError] = useState('')
  const [linkSource, setLinkSource] = useState('')
  const [linkTarget, setLinkTarget] = useState('')
  const [notice, setNotice] = useState('')
  const [recording, setRecording] = useState<ReturnType<typeof recordingPresentation>>()
  const serial = useRef(0)
  const capturing = state.activeSession?.status === 'collecting'
  const query = async (nextTab = tab, cursor?: string, draftOverride?: HistoryFilterDraft) => {
    if (queryingRef.current) return
    queryingRef.current = true
    setQuerying(nextTab)
    const currentSerial = ++serial.current
    try {
      const queryDraft = cursor && appliedDraft ? appliedDraft : (draftOverride ?? filter)
      const params = cursor && applied ? applied : buildHistoryFilter(queryDraft)
      setLocalError('')
      const result = await request({
        action: nextTab,
        params: { accountId, ...params, limit: 50, ...(cursor ? { cursor } : {}) },
      })
      if (currentSerial !== serial.current) return
      if (!result.ok) {
        setLocalError(`查询失败：${result.error.message}`)
        return
      }
      const page = result.data as AssistantDeskPage<AssistantDeskRow | AssistantDeskAudience>
      setTab(nextTab)
      setApplied(params)
      if (!cursor) setAppliedDraft(queryDraft)
      setNextCursor(page.nextCursor)
      setQueried(true)
      if (nextTab === 'timeline')
        setHistory(current =>
          cursor
            ? [...current, ...(page.items as AssistantDeskRow[])]
            : (page.items as AssistantDeskRow[]),
        )
      else
        setAudience(current =>
          cursor
            ? [...current, ...(page.items as AssistantDeskAudience[])]
            : (page.items as AssistantDeskAudience[]),
        )
    } catch (error) {
      if (currentSerial === serial.current)
        setLocalError(`查询失败：${error instanceof Error ? error.message : '查询条件无效'}`)
    } finally {
      if (currentSerial === serial.current) {
        queryingRef.current = false
        setQuerying(undefined)
      }
    }
  }
  const viewAll = () => {
    if (queryingRef.current) return
    const cleared = emptyFilter()
    setFilter(cleared)
    setApplied(undefined)
    setAppliedDraft(undefined)
    setNextCursor(undefined)
    setHistory([])
    setAudience([])
    setQueried(false)
    setTab('timeline')
    void query('timeline', undefined, cleared)
  }
  const filterChanged = queried && JSON.stringify(filter) !== JSON.stringify(appliedDraft)
  const appliedSummary = applied
    ? [
        applied.sessionId ? `场次 ${applied.sessionId}` : '全部场次',
        applied.minPayLevel === undefined ? '所有等级' : `消费等级 ≥${applied.minPayLevel}`,
        ...(applied.audienceUuid ? [`观众 UUID ${applied.audienceUuid}`] : []),
        ...(applied.userId ? [`平台 ID ${applied.userId}`] : []),
        ...(applied.mentionHandle ? [`完整用户名 @${applied.mentionHandle}`] : []),
        ...(applied.nickname ? [`完整昵称 ${applied.nickname}`] : []),
        ...(!applied.audienceUuid && !applied.userId && !applied.mentionHandle && !applied.nickname ? ['所有观众'] : []),
        ...(applied.from === undefined ? [] : [`从 ${displayTime(applied.from, true)}`]),
        ...(applied.to === undefined ? [] : [`至 ${displayTime(applied.to, true)}`]),
        ...(applied.from === undefined && applied.to === undefined ? ['全部时间'] : []),
      ].join(' · ')
    : undefined
  const change = (key: keyof HistoryFilterDraft, value: string) => {
    setFilter(current => ({ ...current, [key]: value }))
    setLocalError('')
  }
  const segments = state.segments.filter(
    segment => !filter.sessionId || segment.sessionId === filter.sessionId,
  )
  const segmentGroups = groupSegmentsByCapture(state.sessions, segments, accountId)
  return (
    <section className="assistant-panel assistant-review" aria-label="历史与片段复盘">
      <div className="assistant-section-heading">
        <div>
          <span className="assistant-step">04 · 留下证据</span>
          <h2>
            <Bookmark size={18} />
            历史录像与复盘
          </h2>
        </div>
        <span className="assistant-muted">稳定 UUID · 跨场次记录</span>
      </div>
      <div className="assistant-review-tools">
        <div className="assistant-mark-block">
          <h3>历史片段范围</h3>
          <p className="assistant-muted">
            已有片段保留供复盘。当前打点请使用上方“双路独立录像”，章节只记到实际节目机位。
          </p>
        </div>
        <details className="assistant-record-block">
          <summary>
            <Video size={16} />
            主画面录像（可选）
          </summary>
          <p className="assistant-muted">
            只录制节目合成画面；双机位各录一份请使用上方“双路独立录像”。录像路径关联到当前场次。本地欢迎/礼物特效
            {state.context.localEffectsEnabled ? '已开启' : '已关闭'}，可在助手设置中修改。
          </p>
          <div className="assistant-actions">
            {(['status', 'start', 'stop'] as const).map(action => (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={busy || (action === 'start' && !capturing)}
                onClick={() =>
                  void request({
                    action: 'recording',
                    params: { accountId, recordingAction: action },
                  }).then(result => {
                    if (result.ok) setRecording(recordingPresentation(result.data))
                  })
                }
              >
                {action === 'start' ? <Play /> : action === 'stop' ? <Square /> : <Video />}
                {action === 'start' ? '开始录像' : action === 'stop' ? '停止录像' : '查看录像状态'}
              </Button>
            ))}
          </div>
          {recording && (
            <p role="status" className="assistant-muted">
              {recording.label}
              {recording.path && (
                <span className="assistant-record-path">保存路径：{recording.path}</span>
              )}
            </p>
          )}
        </details>
      </div>
      <form
        className="assistant-history-filters"
        onSubmit={event => {
          event.preventDefault()
          void query()
        }}
      >
        <label>
          场次
          <select
            aria-label="复盘场次"
            value={filter.sessionId}
            onChange={event => change('sessionId', event.target.value)}
          >
            <option value="">全部场次</option>
            {state.sessions.map(session => (
              <option key={session.id} value={session.id}>
                {captureRoomLabel(currentCaptureRun(session))} · {displayTime(session.startedAt, true)} · 场次 {session.id.slice(0, 8)} ·{' '}
                {session.status === 'collecting'
                  ? '采集中'
                  : session.status === 'completed'
                    ? '已完成'
                    : '已中断'}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="assistant-history-handle">
          完整用户名（@账号）
          <Input id="assistant-history-handle" aria-label="完整用户名（@账号）"
            value={filter.mentionHandle ?? ''} maxLength={201} placeholder="@lthymy608.89"
            onChange={event => change('mentionHandle', event.target.value)} />
        </label>
        <label htmlFor="assistant-history-nickname">
          完整昵称
          <Input id="assistant-history-nickname" aria-label="完整昵称"
            value={filter.nickname ?? ''} maxLength={100} placeholder="Nguyễn Trung Kiên"
            onChange={event => change('nickname', event.target.value)} />
        </label>
        <label htmlFor="assistant-history-uuid">
          观众 UUID
          <Input
            id="assistant-history-uuid"
            aria-label="观众 UUID"
            value={filter.audienceUuid}
            placeholder="稳定 UUID"
            onChange={event => change('audienceUuid', event.target.value)}
          />
        </label>
        <label htmlFor="assistant-history-user">
          平台用户 ID
          <Input
            id="assistant-history-user"
            aria-label="平台用户 ID"
            value={filter.userId}
            placeholder="来源 ID"
            onChange={event => change('userId', event.target.value)}
          />
        </label>
        <label htmlFor="assistant-history-from">
          开始时间
          <Input
            id="assistant-history-from"
            aria-label="复盘开始时间"
            type="datetime-local"
            value={filter.from}
            onChange={event => change('from', event.target.value)}
          />
        </label>
        <label htmlFor="assistant-history-to">
          结束时间
          <Input
            id="assistant-history-to"
            aria-label="复盘结束时间"
            type="datetime-local"
            value={filter.to}
            onChange={event => change('to', event.target.value)}
          />
        </label>
        <label htmlFor="assistant-history-level">
          最低消费等级
          <Input
            id="assistant-history-level"
            aria-label="最低消费等级"
            type="number"
            min={0}
            step={1}
            value={filter.minPayLevel}
            placeholder="不限"
            onChange={event => change('minPayLevel', event.target.value)}
          />
        </label>
        <Button type="submit" disabled={!!querying}>
          <Search />
          查询历史
        </Button>
        <Button type="button" variant="outline" disabled={!!querying} onClick={viewAll}>
          查看全部历史
        </Button>
      </form>
      <p className="assistant-muted">完整用户名或昵称精确匹配；同名不会自动合并身份。两个条件同时填写时须同时匹配。</p>
      {querying && (
        <p role="status" className="assistant-muted">
          正在查询{querying === 'timeline' ? '历史事件' : '观众档案'}…
        </p>
      )}
      {appliedSummary && <p className="assistant-muted">当前查询条件：{appliedSummary}</p>}
      {filterChanged && (
        <p role="status" className="assistant-warning">
          筛选已变化；当前结果仍使用上次查询条件，点击查询历史后更新。
        </p>
      )}
      {localError && (
        <p role="alert" className="assistant-error-text">
          {localError}
        </p>
      )}
      {!!segments.length && (
        <details className="assistant-segments">
          <summary>片段记录 · {segments.length}</summary>
          {segmentGroups.map(group => (
            <section key={group.key} data-capture-group={group.key} className="assistant-segment" aria-label={`采集片段 ${group.key}`}>
              <h3>{captureRoomLabel(group.run)} · {group.segments.length} 个片段</h3>
              <p className="assistant-muted">采集开始：{displayTime(group.run?.startedAt, true)} · 场次 {group.sessionId.slice(0, 8)}</p>
              <p className="assistant-muted">
                {group.run?.roomId ? `房间 ID ${group.run.roomId} · ` : ''}
                {group.captureSessionId ? `采集 ID ${group.captureSessionId}` : '采集关联未知'}
              </p>
              {group.run?.target && <p className="assistant-muted"><a href={group.run.target.url} target="_blank" rel="noreferrer">{group.run.target.url}</a></p>}
              {group.run?.recordingPaths?.length
                ? group.run.recordingPaths.map(path => <RecordingLink key={path} path={path} />)
                : <p className="assistant-muted">录像关联未知</p>}
              {group.segments.map(segment => (
                <SegmentRow key={segment.id} segment={segment} accountId={accountId} busy={busy} request={request} />
              ))}
            </section>
          ))}
        </details>
      )}
      {filter.sessionId &&
        state.sessions
          .find(session => session.id === filter.sessionId)
          ?.recordingPaths?.map(recordingPath => (
            <RecordingLink key={recordingPath} path={recordingPath} />
          ))}
      <div className="assistant-history-tabs" role="tablist" aria-label="历史类型">
        <Button
          size="sm"
          variant={tab === 'timeline' ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={tab === 'timeline'}
          onClick={() => void query('timeline')}
          disabled={!!querying}
        >
          <MessageSquare />
          历史事件
        </Button>
        <Button
          size="sm"
          variant={tab === 'audience' ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={tab === 'audience'}
          onClick={() => void query('audience')}
          disabled={!!querying}
        >
          <Users />
          观众档案
        </Button>
        <span className="assistant-muted">最低等级过滤只匹配真实已知等级</span>
      </div>
      <div
        className="assistant-history-results"
        role="tabpanel"
        aria-label={tab === 'timeline' ? '历史事件' : '观众档案'}
      >
        {!queried ? (
          <div className="assistant-empty">
            <Search size={24} />
            <p>选择场次、时间或观众，查询完整存档。</p>
          </div>
        ) : tab === 'timeline' ? (
          history.length ? (
            history.map(row => (
              <AssistantMessageCard key={row.id} row={row} busy={busy} request={request} />
            ))
          ) : (
            <p className="assistant-empty">没有匹配的历史事件</p>
          )
        ) : audience.length ? (
          <AssistantAudienceTable
            audience={audience}
            busy={busy}
            onSelectLink={setLinkSource}
            onUnlink={uuid =>
              void request({
                action: 'identity-unlink',
                params: { accountId, audienceUuid: uuid },
              }).then(result => {
                if (result.ok) {
                  setNotice('身份关联已解除')
                  void query('audience')
                }
              })
            }
          />
        ) : (
          <p className="assistant-empty">没有匹配的观众档案</p>
        )}
      </div>
      {nextCursor && (
        <Button variant="outline" disabled={!!querying} onClick={() => void query(tab, nextCursor)}>
          加载下一页
        </Button>
      )}
      {tab === 'audience' && (
        <form
          className="assistant-link-form"
          onSubmit={event => {
            event.preventDefault()
            void request({
              action: 'identity-link',
              params: { accountId, audienceUuid: linkSource.trim(), targetUuid: linkTarget.trim() },
            }).then(result => {
              if (result.ok) {
                setNotice('跨平台身份关联已保存')
                void query('audience')
              }
            })
          }}
        >
          <div>
            <h3>手工关联跨平台身份</h3>
            <p className="assistant-muted">
              按稳定 UUID 关联，历史来源 ID 保留；相同昵称不会自动合并。
            </p>
          </div>
          <Input
            aria-label="关联来源 UUID"
            value={linkSource}
            onChange={event => setLinkSource(event.target.value)}
            placeholder="来源 UUID"
          />
          <Input
            aria-label="关联目标 UUID"
            value={linkTarget}
            onChange={event => setLinkTarget(event.target.value)}
            placeholder="另一平台的 UUID"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={
              busy ||
              !linkSource.trim() ||
              !linkTarget.trim() ||
              linkSource.trim() === linkTarget.trim()
            }
          >
            <Link2 />
            关联身份
          </Button>
        </form>
      )}
      {notice && (
        <p role="status" className="assistant-muted">
          {notice}
        </p>
      )}
    </section>
  )
}
