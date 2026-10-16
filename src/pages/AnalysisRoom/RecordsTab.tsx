import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AnalysisRoomController } from '@/hooks/useAnalysisRoom'
import type { FieldEntry } from '../../../shared/analysisRoom'
import { sessionPresentation } from './sessionPresentation'

export default function RecordsTab({
  room,
  defineField,
}: {
  room: AnalysisRoomController
  defineField: (field: FieldEntry) => void
}) {
  const { state, request, dispatch } = room
  const [search, setSearch] = useState('')
  const [mappingVersion, setMappingVersion] = useState('')
  const selected = state.sessions?.items.find(s => s.id === state.selectedSessionId)
  const view = (sessionId: string) => {
    dispatch({ type: 'select-session', sessionId })
    void request({ action: 'records', params: { scope: state.scope, sessionId, limit: 10 } })
    void request({ action: 'fields', params: { scope: state.scope, sessionId } })
  }
  const fields =
    state.fields?.fields.filter(f =>
      f.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) ?? []
  return (
    <section className="space-y-4 min-w-0" aria-label="分析记录内容">
      <p className="text-sm text-muted-foreground">
        记录的是脱敏业务消息，不是录像或录音。采集不会启动自动回复，也不会停止原有弹幕监测。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!!state.pending.sessions} onClick={room.refresh}>
          刷新记录
        </Button>
        {state.sessions?.nextCursor && (
          <Button
            variant="outline"
            onClick={() =>
              void request({
                action: 'sessions',
                params: { scope: state.scope, limit: 20, cursor: state.sessions?.nextCursor },
              })
            }
          >
            下一页记录
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          每页最多 20 场；原始样本每页最多 10 条
        </span>
      </div>
      {!state.sessions?.items.length && <p>暂无分析记录；连接中控后点击开始分析。</p>}
      <div className="space-y-2">
        {state.sessions?.items.map(session => (
          <div
            key={session.id}
            className="border rounded-lg p-3 flex flex-wrap items-center gap-3 min-w-0"
          >
            <div className="flex-1 min-w-0 text-sm">
              <p>
                {new Date(session.createdAt).toLocaleString()} ·{' '}
                {sessionPresentation(session).lifecycle} · {sessionPresentation(session).integrity}
              </p>
              <p className="text-muted-foreground break-all">
                {session.id} · {sessionPresentation(session).details} · 格式 {session.formatVersion}{' '}
                · 字典 {session.mappingVersion ?? '未发布'}
              </p>
              {session.reason && <p className="text-amber-700 break-all">{session.reason}</p>}
            </div>
            <Button
              variant={session.id === state.selectedSessionId ? 'default' : 'outline'}
              onClick={() => view(session.id)}
            >
              查看记录
            </Button>
          </div>
        ))}
      </div>
      {state.selectedSessionId && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="min-w-0 space-y-2">
            <h2 className="font-medium">脱敏样本</h2>
            {state.pending.records && <p role="status">正在读取样本…</p>}
            {state.records && !state.records.items.length && (
              <p>暂无样本；先开始分析并接收直播业务消息</p>
            )}
            {state.records?.items.map(record => (
              <details key={record.recordSequence} className="border rounded p-2 min-w-0">
                <summary className="cursor-pointer text-sm break-all">
                  #{record.recordSequence} · {record.businessType ?? '未分类业务'} ·{' '}
                  {record.complete ? '完整' : '截断或脱敏'} · {record.observationId}
                </summary>
                <pre className="text-xs whitespace-pre-wrap break-all max-h-72 overflow-y-auto mt-2">
                  {JSON.stringify(record.data, null, 2)}
                </pre>
                {(record.removedPaths.length > 0 || record.truncatedPaths.length > 0) && (
                  <p className="text-xs break-all">
                    移除：{record.removedPaths.slice(0, 20).join(', ') || '无'}；截断：
                    {record.truncatedPaths.slice(0, 20).join(', ') || '无'}
                  </p>
                )}
              </details>
            ))}
            {state.records?.nextCursor && (
              <Button
                variant="outline"
                disabled={!!state.pending.records}
                onClick={() =>
                  void request({
                    action: 'records',
                    params: {
                      scope: state.scope,
                      sessionId: state.selectedSessionId!,
                      cursor: state.records?.nextCursor,
                      limit: 10,
                    },
                  })
                }
              >
                下一页样本
              </Button>
            )}
          </section>
          <section className="min-w-0 space-y-2">
            <h2 className="font-medium">字段摘要 · 点击定义属性</h2>
            <Input
              aria-label="搜索字段路径"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索 /user/level"
            />
            {state.fields && (!state.fields.complete || fields.length > 100) && (
              <p className="text-xs text-amber-700">字段过多或数据被截断；当前只显示有限摘要</p>
            )}
            <p className="text-xs text-muted-foreground">
              匹配 {fields.length} 个路径，当前最多显示 100 个；未知不等于 false 或 0。
            </p>
            <div className="max-h-96 overflow-y-auto space-y-2">
              {fields.slice(0, 100).map(field => (
                <div className="border rounded p-2 text-xs min-w-0" key={field.path}>
                  <p className="break-all">
                    {field.path} · {field.types.join('/')} · {field.count} 次
                  </p>
                  <p className="break-all text-muted-foreground">
                    {JSON.stringify(field.examples).slice(0, 768)}
                  </p>
                  <Button
                    className="mt-1 max-w-full whitespace-normal break-all h-auto py-1"
                    size="sm"
                    variant="outline"
                    aria-label={`定义 ${field.path}`}
                    onClick={() => defineField(field)}
                  >
                    定义属性
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {selected && state.dictionary?.activeVersion && (
        <section className="border rounded-lg p-3 space-y-2 text-sm">
          <p>历史重分析只生成分析结果，不回写实时用户画像，不触发回复。</p>
          <label htmlFor="analysis-reanalysis-version">重分析字典版本（默认最新发布版）</label>
          <Input
            id="analysis-reanalysis-version"
            type="number"
            min={1}
            value={mappingVersion || state.dictionary.activeVersion}
            onChange={e => setMappingVersion(e.target.value)}
            className="max-w-40"
          />
          <Button
            variant="outline"
            disabled={
              !!state.pending.reanalyze ||
              state.reanalysis?.status === 'running' ||
              !['completed', 'interrupted', 'storage-error'].includes(selected.status) ||
              !Number.isSafeInteger(Number(mappingVersion || state.dictionary.activeVersion)) ||
              Number(mappingVersion || state.dictionary.activeVersion) < 1
            }
            onClick={() =>
              void request({
                action: 'reanalyze',
                params: {
                  scope: state.scope,
                  sessionId: selected.id,
                  mappingVersion: Number(mappingVersion || state.dictionary!.activeVersion!),
                  requestId: crypto.randomUUID(),
                },
              })
            }
          >
            重分析此记录
          </Button>
          {state.reanalysis && (
            <>
              <span className="ml-2">
                {state.reanalysis.status} · {state.reanalysis.saved}/{state.reanalysis.received}
              </span>
              <Button
                variant="outline"
                onClick={() =>
                  void request({
                    action: 'results',
                    params: { scope: state.scope, jobId: state.reanalysis!.id, limit: 10 },
                  })
                }
              >
                读取分析结果
              </Button>
            </>
          )}
          {state.results && (
            <pre className="text-xs whitespace-pre-wrap break-all max-h-72 overflow-auto">
              {JSON.stringify(state.results.items, null, 2)}
            </pre>
          )}
          {state.results?.nextCursor && (
            <Button
              variant="outline"
              onClick={() =>
                void request({
                  action: 'results',
                  params: {
                    scope: state.scope,
                    jobId: state.results!.job.id,
                    limit: 10,
                    cursor: state.results?.nextCursor,
                  },
                })
              }
            >
              下一页分析结果
            </Button>
          )}
        </section>
      )}
      {state.samples.length > 0 && (
        <details>
          <summary className="text-sm">实时状态摘要（非原始消息）</summary>
          <pre className="text-xs whitespace-pre-wrap break-all">{state.samples.join('\n')}</pre>
        </details>
      )}
    </section>
  )
}
