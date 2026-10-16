import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAccounts } from '@/hooks/useAccounts'
import { useAnalysisRoom } from '@/hooks/useAnalysisRoom'
import type { FieldEntry } from '../../../shared/analysisRoom'
import type { AnalysisTab } from './analysisState'
import DictionaryTab from './DictionaryTab'
import GroupsTab from './GroupsTab'
import RecordsTab from './RecordsTab'
import { captureTransportPresentation, sessionPresentation } from './sessionPresentation'

export default function AnalysisRoom() {
  const accountId = useAccounts(s => s.currentAccountId)
  const accountName = useAccounts(s => s.accounts.find(a => a.id === accountId)?.name ?? accountId)
  const room = useAnalysisRoom(accountId)
  const { state, request, dispatch } = room
  const [fieldContext, setFieldContext] = useState<{ generation: number; field: FieldEntry }>()
  const field = fieldContext?.generation === state.generation ? fieldContext.field : undefined
  const capturing = state.session?.status === 'collecting' || state.session?.status === 'stopping'
  const stopping = !!state.pending.stop || state.session?.status === 'stopping'
  const transportStatus = captureTransportPresentation(state.capabilities?.captureTransports)
  const startEnabled =
    state.capabilities?.connected &&
    state.capabilities.supported &&
    state.capabilities.sources.includes(state.scope.source)
  const toggle = async () => {
    if (capturing && state.session)
      await request({
        action: 'stop',
        params: { scope: state.scope, sessionId: state.session.id, requestId: crypto.randomUUID() },
      })
    else
      await request({
        action: 'start',
        params: { scope: state.scope, requestId: crypto.randomUUID() },
      })
    room.refresh()
  }
  return (
    <main aria-label="自动分析室" className="p-4 lg:p-6 space-y-4 overflow-y-auto h-full min-w-0">
      <header className="space-y-3">
        <p className="text-xs text-muted-foreground">
          使用顶部账号切换器；切换账号或来源会清除未保存的界面草稿，已保存配置不受影响。
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">自动分析室</h1>
          <Button variant="outline" onClick={room.refresh}>
            刷新状态
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="break-all">账号：{accountName}</span>
          <span>
            平台：{state.scope.platform === 'xiaohongshu' ? '小红书千帆' : state.scope.platform === 'tiktok' ? 'TikTok LIVE' : state.scope.platform}
          </span>
          <span>{state.capabilities?.connected ? '中控已连接' : '中控未连接'}</span>
          <label>
            来源{' '}
            <select
              aria-label="分析来源"
              className="border rounded p-1 bg-background"
              value={state.scope.source}
              disabled={capturing || stopping}
              onChange={e => room.setSource(e.target.value as 'control' | 'compass')}
            >
              <option value="control">{state.scope.platform === 'tiktok' ? '直播事件流（SDK／网页）' : '中控业务流'}</option>
              <option value="compass" disabled={state.scope.platform === 'tiktok'}>罗盘业务流</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={stopping || !!state.pending.start || (!capturing && !startEnabled)}
            onClick={() => void toggle()}
          >
            {stopping ? '正在保存…' : capturing ? '停止并保存' : '开始采集'}
          </Button>
          {!state.capabilities?.connected && (
            <Link to="/" className="text-sm text-primary underline">
              去中控台连接
            </Link>
          )}
          {state.session && (
            <span role="status" className="text-sm">
              {sessionPresentation(state.session).lifecycle} ·{' '}
              {sessionPresentation(state.session).integrity} ·{' '}
              {sessionPresentation(state.session).details}
            </span>
          )}
        </div>
        {state.scope.platform === 'tiktok' && (
          <section className="rounded-lg border p-3 space-y-2 text-sm" aria-label="TikTok 只读采集说明">
            {transportStatus && capturing && <p role="status" className={state.capabilities?.captureTransports?.sdk === 'unavailable' ? 'text-amber-700' : 'text-muted-foreground'}>{transportStatus}</p>}
            <p>先在“打开中控台”填写要监听的直播间网址或 @主播账号，可以是别人的直播间；登录的是你自己的 TikTok 账号。</p>
            <p>开始采集只监听和保存，不调用 AI、不发弹幕、不触发欢迎特效。SDK 事件保留解码后的 JSON；网页兜底记录会标为网页观察，不能代替原始事件。</p>
            <p>停止并保存后，在“分析记录”查看字段，再用“属性字典”定义等级、昵称和发言的含义。没有收到的字段保留为未知。</p>
            {state.session?.originals && <p className={state.session.originals.error || state.session.originals.dropped ? 'text-amber-700' : 'text-muted-foreground'}>原始存档：{state.session.originals.file}（本机采集目录内，独立于净化后的分析记录）</p>}
            <div className="flex gap-4"><Link to="/" className="text-primary underline">配置监听目标</Link><Link to="/hooks" className="text-primary underline">采集后配置欢迎钩子</Link></div>
          </section>
        )}
        {state.capabilities && !state.capabilities.supported && (
          <p className="text-sm text-amber-700">该平台暂不支持原始业务采集</p>
        )}
        {state.capabilities?.supported &&
          !state.capabilities.sources.includes(state.scope.source) && (
            <p className="text-sm text-amber-700">该来源暂不支持采集；请使用中控业务流。</p>
          )}
        {state.health && (!state.health.audit.healthy || !state.health.storage.healthy) && (
          <section role="alert" className="border border-amber-400 rounded p-3 text-sm">
            {!state.health.audit.healthy && (
              <p>
                审计写入异常，部分日志未保存。配置可能已经提交，请先重新读取，勿盲目重试；本次运行持续提示。
              </p>
            )}
            {!state.health.storage.healthy && (
              <p>
                分析证据恢复异常，已暂停相关写入并保留文件。
                {state.health.storage.errorCodes.join('、')}
              </p>
            )}
          </section>
        )}
        {state.error && (
          <div
            role="alert"
            className="border border-red-300 bg-red-50 dark:bg-red-950/30 rounded p-3 text-sm break-all"
          >
            <p>
              {state.error.error.message} · {state.error.error.code}
            </p>
            <p className="text-xs">
              审计编号：{state.error.traceId}；失败不代表已保存、发送或播放。
            </p>
            <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'dismiss-error' })}>
              关闭此错误提示
            </Button>
          </div>
        )}
      </header>
      <Tabs
        value={state.tab}
        onValueChange={tab => dispatch({ type: 'tab', tab: tab as AnalysisTab })}
        className="min-w-0"
      >
        <TabsList>
          <TabsTrigger value="records">分析记录</TabsTrigger>
          <TabsTrigger value="dictionary">属性字典</TabsTrigger>
          <TabsTrigger value="groups">分组与策略</TabsTrigger>
        </TabsList>
        <TabsContent value="records">
          <RecordsTab
            room={room}
            defineField={next => {
              setFieldContext({ generation: state.generation, field: next })
              dispatch({ type: 'tab', tab: 'dictionary' })
            }}
          />
        </TabsContent>
        <TabsContent value="dictionary">
          <DictionaryTab room={room} field={field} />
        </TabsContent>
        <TabsContent value="groups">
          <GroupsTab room={room} />
        </TabsContent>
      </Tabs>
    </main>
  )
}
