import {
  AlertCircle,
  LogIn,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Users,
} from 'lucide-react'
import { type CSSProperties, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AssistantDeskController } from '@/hooks/useAssistantDesk'
import type { AssistantAudiencePolicy } from '../../../shared/assistantAudiencePolicy'
import type { AssistantReplyPolicy } from '../../../shared/assistantReplyPolicy'
import { parseTikTokLiveTarget } from '../../../shared/platformSession'
import { ContextPanel } from './ContextPanel'
import { CameraControls } from './CameraControls'
import { MobileDeskAccess } from './MobileDeskAccess'
import { AudiencePolicyPanel } from './AudiencePolicyPanel'
import { BrowserTranslationNotice } from './BrowserTranslationNotice'
import { LiveTimeline } from './LiveTimeline'
import { LocalTranslationNotice } from './LocalTranslationNotice'
import { MessageBatchReader } from './MessageBatchReader'
import { assistantKindLabels, displayTime, paymentTier } from './presentation'
import { ReviewPanel } from './ReviewPanel'
import { ReplyWorkspace, useReplyWorkspace } from './ReplyWorkspace'
import { ReplyPolicyContext, ReplyPolicyPanel, replyPolicySummary } from './ReplyPolicyPanel'
import { assistantSceneLabel } from './segmentPresentation'

const noRows: never[] = []
const eventLabels: Record<string, string> = assistantKindLabels

const loginLabels = {
  closed: '未打开登录浏览器',
  required: '等待登录',
  authenticated: '登录已确认',
}
const roomLabels = {
  unknown: '未收到人数',
  fresh: '实时人数',
  stale: '人数已过期',
  disconnected: '人数连接已断开',
}

export function AssistantDeskView({
  controller,
  accountName,
}: {
  controller: AssistantDeskController
  accountName: string
}) {
  const { accountId, state, platform, platformWarning, qr, pending, busy, request, platformRequest } = controller
  const policyOwner = useRef(accountId)
  policyOwner.current = accountId
  const [knownPolicy, setKnownPolicy] = useState<{ accountId: string; policy: AssistantAudiencePolicy }>()
  const [knownReplyPolicy, setKnownReplyPolicy] = useState<{ accountId: string; policy: AssistantReplyPolicy }>()
  const replyPolicy = knownReplyPolicy?.accountId === accountId && knownReplyPolicy.policy.revision >= (state?.replyPolicy?.revision ?? 0)
    ? knownReplyPolicy.policy : state?.replyPolicy
  const replyPolicyLoaded = (policy: AssistantReplyPolicy) => {
    if (policyOwner.current !== accountId) return
    setKnownReplyPolicy(current => current?.accountId === accountId && current.policy.revision >= policy.revision ? current : { accountId, policy })
  }
  const audiencePolicy = knownPolicy?.accountId === accountId && knownPolicy.policy.revision >= (state?.audiencePolicy?.revision ?? 0)
    ? knownPolicy.policy
    : state?.audiencePolicy
  const policyLoaded = (policy: AssistantAudiencePolicy) => {
    if (policyOwner.current !== accountId) return
    setKnownPolicy(current => current?.accountId === accountId && current.policy.revision >= policy.revision ? current : { accountId, policy })
  }
  const [target, setTarget] = useState('')
  const [notice, setNotice] = useState('')
  const connectExistingChrome = () => {
    let pageUrl: string
    try { pageUrl = parseTikTokLiveTarget(target).url }
    catch { setNotice('请先粘贴已登录 Chrome 中正在打开的 TikTok 直播间网址'); return }
    setNotice('')
    void platformRequest({ action: 'attach-existing-browser', accountId, pageUrl })
  }
  const [eventKinds, setEventKinds] = useState<Set<string>>()
  const [tier, setTier] = useState('all')
  const [minPayLevel, setMinPayLevel] = useState('')
  const [minFansClubLevel, setMinFansClubLevel] = useState('')
  const [minFollowers, setMinFollowers] = useState('')
  const [filterRevision, setFilterRevision] = useState(0)
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('assistant-desk:message-font-size'))
      return [18, 20, 22, 24].includes(saved) ? saved : 18
    } catch {
      return 18
    }
  })
  const workspace = useReplyWorkspace(accountId, state?.rows ?? noRows, state?.attention, audiencePolicy?.enabled ?? true)
  const workRequest: typeof request = async command => {
    const result = await request(command)
    if (result.ok) workspace.recordResult(result.data)
    return result
  }
  const captureStopping = !!pending.stop
  const captureActive = captureStopping || !!state?.activeSession && state.activeSession.endedAt === undefined
  const capturing = captureActive && state?.activeSession?.status === 'collecting'
  const captureStorageError = captureActive && state?.activeSession?.status === 'storage-error'
  const manualTranslation = state && ['browser', 'local'].includes(state.context.translationMode ?? 'ai')
    ? {
        sessionId: capturing ? state.activeSession?.id : undefined,
        maxAgeSeconds: state.context.attentionMaxAgeSeconds ?? 600,
        ai: state.ai,
        busy: Object.entries(pending).some(
          ([action, count]) => count > 0 && !['state', 'platform:state', 'translate-retry'].includes(action),
        ),
      }
    : undefined
  const displaySession = state?.activeSession ?? state?.sessions[0]
  const displaySessionId = displaySession?.id
  const liveSessionId = captureActive ? (state?.activeSession?.id ?? displaySession?.id) : undefined
  const liveRows = useMemo(
    () =>
      liveSessionId
        ? (state?.rows ?? noRows).filter(row => row.sessionId === liveSessionId)
        : noRows,
    [state?.rows, liveSessionId],
  )
  const authenticated = platform?.loginStatus === 'authenticated'
  const availableKinds = [
    ...new Set([...Object.keys(eventLabels), ...liveRows.map(row => row.kind)]),
  ]
  const filteredRows = liveRows.filter(
    row =>
      (!eventKinds || eventKinds.has(row.kind)) &&
      (tier === 'all' || (row.triage?.tier ?? paymentTier(row.payLevel)) === tier) &&
      (!minPayLevel ||
        (Number.isSafeInteger(row.payLevel) && (row.payLevel ?? -1) >= Number(minPayLevel))) &&
      (!minFansClubLevel ||
        (Number.isSafeInteger(row.fansClubLevel) &&
          (row.fansClubLevel ?? -1) >= Number(minFansClubLevel))) &&
      (!minFollowers ||
        (Number.isSafeInteger(row.followerCount) &&
          (row.followerCount ?? -1) >= Number(minFollowers))),
  )
  const changeFilter = (change: () => void) => {
    change()
    setFilterRevision(current => current + 1)
  }
  const clearFilters = () =>
    changeFilter(() => {
      setEventKinds(undefined)
      setTier('all')
      setMinPayLevel('')
      setMinFansClubLevel('')
      setMinFollowers('')
    })
  const startEnabled =
    platform?.captureReady && platform.roomReady && authenticated && !platform.busy
  const status = platform ? `${platformWarning ? '上次确认：' : ''}${loginLabels[platform.loginStatus]}` : '正在读取登录状态…'
  return (
    <ReplyPolicyContext.Provider value={{ policy: replyPolicy, ai: state?.ai }}>
    <main
      className="assistant-desk"
      aria-label="助播台"
      style={{ '--desk-message-size': `${fontSize}px` } as CSSProperties}
    >
      <header className="assistant-hero">
        <div>
          <div className="assistant-eyebrow">
            <Radio size={14} />
            LIVE ASSISTANT
          </div>
          <h1>助播台</h1>
          <p>看懂现场、核对回复、留下每一场的记录。</p>
        </div>
        <div className="assistant-account">
          <span>当前账号</span>
          <strong>{accountName}</strong>
          <label className="assistant-font-control">
            消息字号
            <select
              aria-label="消息字号"
              value={fontSize}
              onChange={event => {
                const size = Number(event.target.value)
                setFontSize(size)
                try {
                  localStorage.setItem('assistant-desk:message-font-size', String(size))
                } catch {
                  /* Keep the current selection usable. */
                }
              }}
            >
              {[18, 20, 22, 24].map(size => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="outline" onClick={() => void controller.refresh()}>
            <RefreshCw />
            刷新状态
          </Button>
        </div>
      </header>
      <MobileDeskAccess accountId={accountId} accountName={accountName} />
      <CameraControls />
      <div className="assistant-stat-grid">
        <div className="assistant-stat">
          <Users size={18} />
          <div>
            <span>在线人数</span>
            <strong>{state?.room.onlineCount ?? '—'}</strong>
            <small>
              {state ? roomLabels[state.room.status] : '等待读取'}
              {state?.room.ageMs !== undefined && ` · ${Math.floor(state.room.ageMs / 1000)}秒前`}
            </small>
            {state?.room.totalUser && <small>平台 totalUser：{state.room.totalUser}</small>}
          </div>
        </div>
        <div className="assistant-stat">
          <Sparkles size={18} />
          <div>
            <span>本场 AI 请求</span>
            <strong>{state ? `${state.ai.used} / ${state.ai.limit}` : '—'}</strong>
            <small>
              {state?.ai.paused
                ? state.ai.pauseReason === 'request-limit'
                  ? '已到上限 · 继续记录'
                  : state.ai.pauseReason === 'no-session'
                    ? '等待开始采集'
                    : 'AI 已暂停 · 继续记录'
                : `处理中 ${state?.ai.running ?? 0} · 排队 ${state?.ai.queued ?? 0}`}
            </small>
          </div>
        </div>
        <div className="assistant-stat">
          <Send size={18} />
          <div>
            <span>当前回复规则</span>
            <strong>
              {replyPolicySummary(replyPolicy)}
            </strong>
            <small>{replyPolicy && `v${replyPolicy.revision} · `}待处理 {workspace.totalPending} 条</small>
          </div>
        </div>
        <div className="assistant-stat">
          <Radio size={18} />
          <div>
            <span>当前场次</span>
            <strong>{captureStopping ? '正在停止并保存' : captureActive ? captureStorageError ? '采集中 · 保存异常' : '采集中' : '未采集'}</strong>
            <small>
              {displaySession
                ? assistantSceneLabel(displaySession)
                : '点击开始后创建新场次'}
            </small>
          </div>
        </div>
      </div>
      {controller.errors.map(error => (
        <div key={error.id} role="alert" className="assistant-error">
          <AlertCircle size={18} />
          <div>
            <strong>{error.message}</strong>
            <small>{error.code}</small>
          </div>
          <Button variant="ghost" size="sm" onClick={() => controller.dismissError(error.id)}>
            关闭提示
          </Button>
        </div>
      ))}
      {state &&
        (state.health.status === 'error' ||
          state.health.dropped > 0 ||
          state.health.recoveryWarnings > 0) && (
          <div role="alert" className="assistant-warning">
            存档状态：{state.health.error || '需要核对恢复记录'} · 丢弃 {state.health.dropped} ·
            恢复提醒 {state.health.recoveryWarnings} · 待写入 {state.health.pendingWrites}
          </div>
        )}
      <section className="assistant-panel assistant-session" aria-label="登录与直播间">
        <div className="assistant-section-heading">
          <div>
            <span className="assistant-step">01 · 接入现场</span>
            <h2>先登录，再选择直播间</h2>
          </div>
          <span className={`assistant-status-pill ${authenticated ? 'assistant-connected' : ''}`}>
            {status}
          </span>
        </div>
        {platformWarning && <p className="assistant-hint" role="status" aria-label="登录状态检查">{platformWarning}</p>}
        <div className="assistant-session-controls">
          <div className="assistant-login-actions">
            <Button
              variant="outline"
              disabled={busy || platform?.busy || captureActive || platform?.supported === false || !!platform?.browserOpen || !target.trim()}
              onClick={connectExistingChrome}
            >
              <RefreshCw />
              {pending['platform:attach-existing-browser'] ? '正在连接 Chrome…' : platform?.browserOpen ? '账号浏览器已连接' : '连接已登录 Chrome'}
            </Button>
            <Button
              variant="outline"
              disabled={
                busy ||
                platform?.busy ||
                captureActive ||
                platform?.supported === false ||
                !!platform?.browserOpen
              }
              onClick={() => void platformRequest({ action: 'open-login', accountId })}
            >
              <LogIn />
              {pending['platform:open-login'] ? '正在打开…' : '新建独立登录窗口'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !platform?.sessionId || authenticated}
              onClick={() =>
                platform?.sessionId &&
                void platformRequest({
                  action: 'qr-preview',
                  accountId,
                  sessionId: platform.sessionId,
                })
              }
            >
              <QrCode />
              显示实际登录二维码
            </Button>
          </div>
          <p className="assistant-hint">已有 Chrome 登录：先在原窗口打开直播间，粘贴下方网址后连接；首次连接可能需要允许远程调试。独立登录窗口是另一个入口。</p>
          <div className="assistant-target-form">
            <label htmlFor="assistant-target">直播间网址或 @账号</label>
            <div>
              <Input
                id="assistant-target"
                placeholder="https://www.tiktok.com/@主播/live 或 @主播"
                value={target}
                maxLength={512}
                disabled={captureActive || busy || platform?.busy}
                onChange={event => setTarget(event.target.value)}
              />
              <Button
                variant="outline"
                disabled={
                  !authenticated ||
                  !platform?.sessionId ||
                  !target.trim() ||
                  captureActive ||
                  busy ||
                  platform?.busy
                }
                onClick={() =>
                  platform?.sessionId &&
                  void platformRequest({
                    action: 'set-target',
                    accountId,
                    sessionId: platform.sessionId,
                    target: target.trim(),
                  })
                }
              >
                应用直播间
              </Button>
            </div>
          </div>
          <Button
            disabled={captureActive ? !!pending.stop : busy || !state || !startEnabled}
            variant={captureActive ? 'outline' : 'default'}
            onClick={() =>
              void request(
                captureActive
                  ? { action: 'stop', params: { accountId } }
                  : {
                      action: 'start',
                      params: {
                        accountId,
                        platform: platform?.platform,
                        requestId: crypto.randomUUID(),
                      },
                    },
              )
            }
          >
            {captureActive ? <Square /> : <Play />}
            {pending.stop
              ? '正在停止…'
              : pending.start
                ? '正在开始…'
                : captureActive
                  ? '停止并保存'
                  : '开始采集'}
          </Button>
        </div>
        <div className="assistant-session-footer">
          <p>
            同一浏览器保留登录，切换直播间前先停止采集。当前目标：
            <strong>{platform?.target ? `@${platform.target.username}` : '尚未设置'}</strong>
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !capturing || !authenticated}
            onClick={() =>
              void request({
                action: 'test-send',
                params: { accountId, requestId: crypto.randomUUID() },
              }).then(result => {
                if (result.ok) setNotice('测试弹幕发送请求成功')
              })
            }
          >
            <Send />
            发送一条明确测试弹幕
          </Button>
        </div>
        {platform?.supported === false && (
          <p className="assistant-warning">
            当前平台不支持登录先行；请在顶部账号的中控台选择 TikTok。
          </p>
        )}
        {qr && !authenticated && (
          <figure className="assistant-qr">
            <img
              src={qr.dataUrl}
              width={Math.min(qr.width, 220)}
              height={Math.min(qr.height, 220)}
              alt="浏览器页面实际显示的 TikTok 登录二维码"
            />
            <figcaption>
              实际页面截图 · {displayTime(qr.capturedAt)}
              <br />
              二维码可能过期，可重新获取。
            </figcaption>
          </figure>
        )}
        {notice && (
          <p role="status" className="assistant-muted">
            {notice}
          </p>
        )}
      </section>
      {state?.context.translationMode !== 'local' && (
        <BrowserTranslationNotice
          key={`browser-translation:${accountId}:${state?.activeSession?.id ?? 'no-session'}`}
          accountId={accountId}
          sessionId={capturing ? state?.activeSession?.id : undefined}
          health={state?.browserTranslationHealth}
        />
      )}
      {state?.context.translationMode === 'local' && (
        <LocalTranslationNotice health={state.localTranslationHealth} />
      )}
      <div className="assistant-work-grid">
        <ReplyWorkspace
          key={`workspace:${accountId}`}
          accountId={accountId}
          rows={workspace.pendingRows}
          processedRows={workspace.processedRows}
          total={workspace.totalPending}
          archivedTotal={workspace.archivedTotal}
          maxAgeSeconds={state?.context.attentionMaxAgeSeconds ?? 600}
          attentionWindow={state?.attention?.window}
          policy={audiencePolicy}
          pinnedIds={workspace.pinnedIds}
          onUnpin={row =>
            void workRequest({
              action: 'attention-pin',
              params: { accountId, rowId: row.id, pinned: false, ...(row.triage?.attention?.pinRevision ? { expectedPinRevision: row.triage.attention.pinRevision } : {}) },
            })
          }
          busy={busy}
          request={workRequest}
          manualTranslation={manualTranslation}
        />
        <div className="assistant-live-area">
          <section className="assistant-panel assistant-live-filters" aria-label="现场显示筛选">
            <div className="assistant-filter-presets">
              <strong>现场显示</strong>
              <Button
                size="sm"
                variant={!eventKinds ? 'default' : 'outline'}
                onClick={() => changeFilter(() => setEventKinds(undefined))}
              >
                全部事件
              </Button>
              <Button
                size="sm"
                variant={
                  eventKinds?.size === 1 && eventKinds.has('comment') ? 'default' : 'outline'
                }
                onClick={() => changeFilter(() => setEventKinds(new Set(['comment'])))}
              >
                仅评论
              </Button>
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                清除显示筛选
              </Button>
            </div>
            <div className="assistant-filter-kinds" aria-label="事件类型多选">
              {availableKinds.map(kind => (
                <Button
                  key={kind}
                  size="sm"
                  variant={!eventKinds || eventKinds.has(kind) ? 'outline' : 'ghost'}
                  aria-pressed={!eventKinds || eventKinds.has(kind)}
                  onClick={() =>
                    changeFilter(() =>
                      setEventKinds(previous => {
                        const next = new Set(previous ?? availableKinds)
                        if (next.has(kind)) next.delete(kind)
                        else next.add(kind)
                        return next
                      }),
                    )
                  }
                >
                  {eventLabels[kind] ?? kind}
                </Button>
              ))}
            </div>
            <details className="assistant-live-properties">
              <summary>更多属性筛选</summary>
              <div className="assistant-live-property-fields">
                <label>
                  现场优先级
                  <select
                    aria-label="现场优先级"
                    value={tier}
                    onChange={event => changeFilter(() => setTier(event.target.value))}
                  >
                    <option value="all">全部优先级</option>
                    <option value="gold">高优先级</option>
                    <option value="silver">中优先级</option>
                    <option value="neutral">常规 / 未知</option>
                  </select>
                </label>
                <label>
                  消费等级门槛（现场）
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    aria-label="消费等级门槛（现场）"
                    value={minPayLevel}
                    onChange={event => changeFilter(() => setMinPayLevel(event.target.value))}
                    placeholder="不限"
                  />
                </label>
                <label>
                  粉丝团等级门槛（现场）
                  <Input
                    type="number"
                    min="0"
                    max="10000"
                    step="1"
                    aria-label="粉丝团等级门槛（现场）"
                    value={minFansClubLevel}
                    onChange={event => changeFilter(() => setMinFansClubLevel(event.target.value))}
                    placeholder="不限"
                  />
                </label>
                <label>
                  粉丝数门槛（现场）
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    aria-label="粉丝数门槛（现场）"
                    value={minFollowers}
                    onChange={event => changeFilter(() => setMinFollowers(event.target.value))}
                    placeholder="不限"
                  />
                </label>
              </div>
            </details>
            <p className="assistant-muted">
              显示 {filteredRows.length} / 当前现场 {liveRows.length}{' '}
              条。现场筛选只影响实时显示；存档保存全量事实，并有独立筛选。
            </p>
          </section>
          <MessageBatchReader
            key={`batches:${accountId}:${displaySessionId ?? 'no-session'}`}
            accountId={accountId}
            sessionId={displaySessionId}
            batches={state?.messageBatches}
            currentBatches={state?.currentSessionMessageBatches}
            sessions={state?.sessions}
            collecting={captureActive}
            filters={{
              ...(eventKinds
                ? { kinds: [...eventKinds] as NonNullable<typeof state>['rows'][number]['kind'][] }
                : {}),
              ...(tier === 'all' ? {} : { tier: tier as 'gold' | 'silver' | 'neutral' }),
              ...(minPayLevel ? { minPayLevel: Number(minPayLevel) } : {}),
              ...(minFansClubLevel ? { minFansClubLevel: Number(minFansClubLevel) } : {}),
              ...(minFollowers ? { minFollowerCount: Number(minFollowers) } : {}),
            }}
            request={request}
          >
            <LiveTimeline
              key={`${accountId}:${displaySessionId ?? 'no-session'}:${filterRevision}`}
              rows={filteredRows}
              busy={busy}
              request={workRequest}
              manualTranslation={manualTranslation}
              manualTranslationRows={state?.attention?.rows}
              audiencePolicy={audiencePolicy}
              pinnedIds={workspace.pinnedIds}
              attentionSession={{
                id: capturing ? state?.activeSession?.id : undefined,
                maxAgeSeconds: state?.context.attentionMaxAgeSeconds ?? 600,
              }}
              onPin={row =>
                void workRequest({
                  action: 'attention-pin',
                  params: { accountId, rowId: row.id, pinned: !workspace.pinnedIds.has(row.id), ...(workspace.pinnedIds.has(row.id) && row.triage?.attention?.pinRevision ? { expectedPinRevision: row.triage.attention.pinRevision } : {}) },
                })
              }
            />
          </MessageBatchReader>
        </div>
      </div>
      <div className="assistant-settings-area">
        <ReplyPolicyPanel key={`reply-policy:${accountId}`} accountId={accountId} policy={replyPolicy}
          audiencePolicy={audiencePolicy} request={request} busy={busy} legacyContext={state?.context} onPolicyLoaded={replyPolicyLoaded} />
        <AudiencePolicyPanel
          key={`policy:${accountId}`}
          accountId={accountId}
          policy={audiencePolicy}
          request={request}
          onPolicyLoaded={policyLoaded}
        />
        {state ? (
          <ContextPanel
            key={accountId}
            accountId={accountId}
            context={state.context}
            audiencePolicy={audiencePolicy}
            replyPolicyConfigured={!!replyPolicy}
            busy={busy}
            saving={!!pending['context-save']}
            request={request}
          />
        ) : (
          <section className="assistant-panel assistant-empty" role="status">
            正在读取知识与回复设置…
          </section>
        )}
      </div>
      {state && (
        <ReviewPanel
          key={accountId}
          accountId={accountId}
          state={state}
          busy={busy}
          markPending={!!pending['segment-toggle']}
          request={request}
        />
      )}
    </main>
    </ReplyPolicyContext.Provider>
  )
}
