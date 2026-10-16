import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AnalysisRoomController } from '@/hooks/useAnalysisRoom'
import { validateAnalysisTool } from '../../../shared/analysisRoomContract.mjs'
import type { AudienceGroup, AudienceGroupCondition } from '../../../shared/audienceGroups'
import type { RoutingField } from '../../../shared/interactionRouting'

export default function GroupsTab({ room }: { room: AnalysisRoomController }) {
  const { state, dispatch, request } = room
  const config = state.groupsDraft
  const [userId, setUserId] = useState('')
  const [nickname, setNickname] = useState('')
  const [score, setScore] = useState('')
  const [event, setEvent] = useState<'viewer.enter' | 'viewer.comment'>('viewer.enter')
  const [advancedError, setAdvancedError] = useState('')
  const update = (items: AudienceGroup[]) =>
    dispatch({ type: 'groups-draft', config: { enabled: config!.enabled, items } })
  const patch = (id: string, delta: Partial<AudienceGroup>) =>
    update(config!.items.map(group => (group.id === id ? { ...group, ...delta } : group)))
  if (!config || !state.groups) return <p role="status">正在读取分组配置…</p>
  return (
    <section className="space-y-4 min-w-0" aria-label="分组策略内容">
      <p className="text-sm text-muted-foreground">
        分组与发布字典是独立动作。默认关闭；模拟不发送消息，应用只保存配置，启用后仍受原有回复模式、冷却与发送权限约束。
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={e =>
            dispatch({ type: 'groups-draft', config: { ...config, enabled: e.target.checked } })
          }
        />
        启用分组策略
      </label>
      {state.groupsStale && (
        <section role="alert" className="border rounded p-3 space-y-2">
          <p>
            服务端分组已更新；本地草稿仍基于修订 {state.groupsBaseRevision}。请先比较，再明确选择。
          </p>
          <pre className="text-xs whitespace-pre-wrap break-all max-h-56 overflow-auto">
            {JSON.stringify(state.groups.config, null, 2)}
          </pre>
          <Button
            variant="outline"
            onClick={() =>
              dispatch({ type: 'groups-draft', config: state.groups!.config, reconcile: true })
            }
          >
            采用服务端分组
          </Button>
          <Button
            variant="outline"
            onClick={() => dispatch({ type: 'groups-draft', config, reconcile: true })}
          >
            已比较，继续使用本地分组
          </Button>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        服务修订：{state.groups.revision} ·
        购买/退款缺数据时保持未知，不能用等级替代。指定用户与条件为“或”关系，不是白名单。
      </p>
      <Button
        variant="outline"
        disabled={config.items.length >= 100}
        onClick={() =>
          update([
            ...config.items,
            {
              id: `group-${crypto.randomUUID()}`,
              name: '新分组',
              enabled: false,
              platform: state.scope.platform,
              source: state.scope.source,
              priority: 0,
              events: ['viewer.enter', 'viewer.comment'],
              all: [{ field: { kind: 'builtin', key: 'user.score' }, op: 'gte', value: 20 }],
              cooldownMs: 60000,
              strategy: {
                channel: 'text',
                guidance: '根据已知用户属性自然问候，邀请在评论区留言，不承诺未确认的优惠。',
                includeNickname: true,
              },
            },
          ])
        }
      >
        添加分组
      </Button>
      {config.items.map(group => (
        <fieldset key={group.id} className="border rounded-lg p-3 space-y-3 min-w-0">
          <legend className="px-1 text-sm">{group.name}</legend>
          <div className="grid sm:grid-cols-2 gap-3">
            <label htmlFor={`analysis-group-name-${group.id}`} className="text-sm">
              分组名称
              <Input
                id={`analysis-group-name-${group.id}`}
                value={group.name}
                maxLength={128}
                onChange={e => patch(group.id, { name: e.target.value })}
              />
            </label>
            <label htmlFor={`analysis-group-priority-${group.id}`} className="text-sm">
              优先级
              <Input
                id={`analysis-group-priority-${group.id}`}
                type="number"
                value={group.priority}
                onChange={e => patch(group.id, { priority: Number(e.target.value) })}
              />
            </label>
            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={group.enabled}
                onChange={e => patch(group.id, { enabled: e.target.checked })}
              />
              此组参与匹配
            </label>
            <label className="text-sm">
              回复渠道
              <select
                className="w-full border rounded p-2 bg-background"
                value={group.strategy.channel}
                onChange={e =>
                  patch(group.id, {
                    strategy: {
                      ...group.strategy,
                      channel: e.target.value as 'text' | 'voice-preferred',
                    },
                  })
                }
              >
                <option value="text">文字</option>
                <option value="voice-preferred">优先语音，塞不下则文字反馈</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {(['viewer.enter', 'viewer.comment'] as const).map(kind => (
              <label key={kind} className="flex gap-2">
                <input
                  type="checkbox"
                  checked={group.events.includes(kind)}
                  onChange={e =>
                    patch(group.id, {
                      events: e.target.checked
                        ? [...group.events, kind]
                        : group.events.filter(v => v !== kind),
                    })
                  }
                />
                {kind === 'viewer.enter' ? '进入直播间' : '发表评论'}
              </label>
            ))}
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={group.strategy.includeNickname}
                onChange={e =>
                  patch(group.id, {
                    strategy: { ...group.strategy, includeNickname: e.target.checked },
                  })
                }
              />
              带用户昵称
            </label>
          </div>
          <div className="space-y-2">
            <p className="text-sm">全部满足的条件</p>
            {group.all.map((condition, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Rows are fully controlled; conditions have no stable protocol ID and editing their values must not remount focused inputs.
              <div key={`${group.id}-${index}`} className="flex flex-wrap gap-2 items-center">
                <select
                  aria-label={`条件字段 ${group.name} ${index + 1}`}
                  className="border rounded p-2 bg-background min-w-0 max-w-full text-sm"
                  value={
                    condition.field.kind === 'builtin'
                      ? condition.field.key
                      : `attribute:${condition.field.id}`
                  }
                  onChange={e => {
                    const field: AudienceGroupCondition['field'] = e.target.value.startsWith(
                      'attribute:',
                    )
                      ? { kind: 'attribute', id: e.target.value.slice(10) }
                      : { kind: 'builtin', key: e.target.value as RoutingField }
                    patch(group.id, {
                      all: group.all.map((c, i) => (i === index ? { ...c, field } : c)),
                    })
                  }}
                >
                  <option value="user.score">用户积分</option>
                  <option value="user.sessionScore">本场积分</option>
                  <option value="user.id">用户 ID</option>
                  <option value="user.fansClubLevel">粉丝团等级</option>
                  <option value="user.payLevel">消费等级</option>
                  <option value="user.purchaseCount">已确认购买次数</option>
                  <option value="user.isFirstSeen">已确认新用户</option>
                  <option value="room.onlineCount">已知在线人数</option>
                  {state.dictionaryDraft?.definitions.map(d => (
                    <option key={d.id} value={`attribute:${d.id}`}>
                      {d.name}（属性）
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`条件运算 ${group.name} ${index + 1}`}
                  className="border rounded p-2 bg-background text-sm"
                  value={condition.op}
                  onChange={e =>
                    patch(group.id, {
                      all: group.all.map((c, i) =>
                        i === index
                          ? {
                              ...c,
                              op: e.target.value as AudienceGroupCondition['op'],
                              value: ['exists', 'isUnknown'].includes(e.target.value)
                                ? undefined
                                : c.value,
                            }
                          : c,
                      ),
                    })
                  }
                >
                  {['eq', 'gte', 'lte', 'exists', 'isUnknown'].map(op => (
                    <option value={op} key={op}>
                      {
                        {
                          eq: '等于',
                          gte: '大于等于',
                          lte: '小于等于',
                          exists: '已知',
                          isUnknown: '未知',
                        }[op]
                      }
                    </option>
                  ))}
                </select>
                {!['exists', 'isUnknown'].includes(condition.op) && (
                  <Input
                    className="w-32"
                    aria-label={`条件值 ${group.name} ${index + 1}`}
                    value={String(condition.value ?? '')}
                    onChange={e => {
                      const text = e.target.value
                      const conditionField = condition.field
                      const type =
                        conditionField.kind === 'attribute'
                          ? state.dictionaryDraft?.definitions.find(d => d.id === conditionField.id)
                              ?.type
                          : conditionField.key === 'user.id'
                            ? 'string'
                            : conditionField.key === 'user.isFirstSeen'
                              ? 'boolean'
                              : 'number'
                      const value =
                        type === 'boolean'
                          ? text === 'true'
                            ? true
                            : text === 'false'
                              ? false
                              : text
                          : ['number', 'integer'].includes(type ?? '')
                            ? text.trim() && Number.isFinite(Number(text))
                              ? Number(text)
                              : text
                            : text
                      patch(group.id, {
                        all: group.all.map((c, i) => (i === index ? { ...c, value } : c)),
                      })
                    }}
                  />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => patch(group.id, { all: group.all.filter((_, i) => i !== index) })}
                >
                  移除条件
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch(group.id, {
                  all: [
                    ...group.all,
                    { field: { kind: 'builtin', key: 'user.score' }, op: 'gte', value: 20 },
                  ],
                })
              }
            >
              添加条件
            </Button>
          </div>
          <label htmlFor={`analysis-group-guidance-${group.id}`} className="block text-sm">
            引导与营销策略
            <Textarea
              id={`analysis-group-guidance-${group.id}`}
              value={group.strategy.guidance}
              maxLength={1000}
              onChange={e =>
                patch(group.id, { strategy: { ...group.strategy, guidance: e.target.value } })
              }
            />
          </label>
          <label htmlFor={`analysis-group-template-${group.id}`} className="block text-sm">
            固定话术（可留空让 AI 生成，支持 {'{nickname}'}）
            <Textarea
              id={`analysis-group-template-${group.id}`}
              value={group.strategy.template ?? ''}
              maxLength={1000}
              onChange={e =>
                patch(group.id, {
                  strategy: { ...group.strategy, template: e.target.value || undefined },
                })
              }
            />
          </label>
          <details>
            <summary className="cursor-pointer text-sm">
              高级分组编辑：任一条件、指定 ID、冷却、兜底、来源
            </summary>
            <GroupJsonEditor
              group={group}
              apply={next => {
                if (next.id !== group.id) {
                  setAdvancedError('高级编辑不能改变分组 ID')
                  return
                }
                update(config.items.map(g => (g.id === group.id ? next : g)))
                setAdvancedError('')
              }}
              error={setAdvancedError}
            />
          </details>
          <Button
            variant="outline"
            size="sm"
            onClick={() => update(config.items.filter(g => g.id !== group.id))}
          >
            移出配置草稿
          </Button>
        </fieldset>
      ))}
      {advancedError && (
        <p role="alert" className="text-sm text-red-700">
          {advancedError}
        </p>
      )}
      <fieldset className="border rounded-lg p-3 space-y-3">
        <legend className="px-1 font-medium">只读模拟</legend>
        <p className="text-xs text-muted-foreground">
          空值表示未知。这里的假设不会更新真实用户积分或画像；高级属性条件请通过 MCP
          或历史样本预览验证。
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <label htmlFor="analysis-simulate-id" className="text-sm">
            模拟用户 ID
            <Input
              id="analysis-simulate-id"
              value={userId}
              onChange={e => setUserId(e.target.value)}
            />
          </label>
          <label htmlFor="analysis-simulate-nickname" className="text-sm">
            模拟昵称
            <Input
              id="analysis-simulate-nickname"
              value={nickname}
              maxLength={256}
              onChange={e => setNickname(e.target.value)}
            />
          </label>
          <label htmlFor="analysis-simulate-score" className="text-sm">
            模拟积分（空为未知）
            <Input
              id="analysis-simulate-score"
              value={score}
              onChange={e => setScore(e.target.value)}
            />
          </label>
          <label className="text-sm">
            模拟事件
            <select
              className="w-full border rounded p-2 bg-background"
              value={event}
              onChange={e => setEvent(e.target.value as typeof event)}
            >
              <option value="viewer.enter">进入直播间</option>
              <option value="viewer.comment">发表评论</option>
            </select>
          </label>
        </div>
        <Button
          variant="outline"
          disabled={state.groupsStale || !!state.pending['groups-simulate']}
          onClick={() =>
            void request({
              action: 'groups-simulate',
              params: {
                accountId: state.scope.accountId,
                revision: state.groupsBaseRevision ?? state.groups!.revision,
                config,
                input: {
                  scope: state.scope,
                  event,
                  ...(userId ? { userId } : {}),
                  context: {
                    event,
                    user: {
                      ...(userId ? { id: userId } : {}),
                      ...(nickname ? { name: nickname } : {}),
                      ...(score.trim() && Number.isFinite(Number(score))
                        ? { score: Number(score) }
                        : {}),
                    },
                    room: {},
                  },
                  effectiveMode: 'focus',
                },
              },
            })
          }
        >
          模拟匹配
        </Button>
      </fieldset>
      {state.groupsPreview && (
        <section className="border rounded-lg p-3 text-sm space-y-2">
          {state.groupsPreview.simulationContext && (
            <p>
              模式：{state.groupsPreview.simulationContext.effectiveMode}（
              {state.groupsPreview.simulationContext.modeSource === 'current-runtime'
                ? '当前实际模式'
                : '已保存手动模式，未接入实时模式'}
              ） · 旧规则：
              {state.groupsPreview.simulationContext.hooksSource === 'current-runtime'
                ? '已检查当前启用规则'
                : '未接入，需人工检查重复欢迎'}
            </p>
          )}
          <p>
            命中分组：{state.groupsPreview.evaluation.memberships.join('、') || '无'} · 策略
            {state.groupsPreview.evaluation.active ? '可参与现有回复链路' : '未启用或未命中'}
            ；尚未发送或播放。
          </p>
          {state.groupsPreview.evaluation.warnings.map(w => (
            <p key={w} className="text-amber-700">
              {w}
            </p>
          ))}
          {state.groupsPreview.evaluation.conditions.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Immutable read-only preview; duplicate conditions are valid and have no individual IDs.
            <p key={`${c.groupId}-${i}`}>
              {c.groupId} · {c.known ? '已知' : '未知'} · {c.matched ? '匹配' : '不匹配'} ·{' '}
              {c.reason}
            </p>
          ))}
        </section>
      )}
      <Button
        disabled={
          !state.groupsPreview ||
          state.groupsStale ||
          state.groupsPreview.expiresAt <= Date.now() ||
          !!state.pending['groups-apply']
        }
        onClick={() =>
          void request({
            action: 'groups-apply',
            params: {
              accountId: state.scope.accountId,
              revision: state.groupsBaseRevision ?? state.groups!.revision,
              config,
              previewToken: state.groupsPreview!.token,
            },
          })
        }
      >
        应用分组配置
      </Button>
      <p className="text-xs text-muted-foreground">
        仅勾选不会立即启用；每次改动都必须重新模拟后应用。声音继续使用现有 Index
        2.5，不在此切换模型。
      </p>
    </section>
  )
}
function GroupJsonEditor({
  group,
  apply,
  error,
}: {
  group: AudienceGroup
  apply: (group: AudienceGroup) => void
  error: (message: string) => void
}) {
  const [value, setValue] = useState(() => JSON.stringify(group, null, 2))
  useEffect(() => {
    setValue(JSON.stringify(group, null, 2))
  }, [group])
  return (
    <>
      <Textarea
        className="text-xs font-mono mt-2 min-h-40"
        aria-label={`分组高级 JSON ${group.name}`}
        value={value}
        maxLength={131072}
        onChange={e => setValue(e.target.value)}
      />
      <Button
        className="mt-2"
        variant="outline"
        onClick={() => {
          try {
            const next = JSON.parse(value)
            validateAnalysisTool('interaction_groups_simulate', {
              accountId: 'editor',
              revision: 0,
              config: { enabled: false, items: [next] },
              input: {
                scope: { accountId: 'editor', platform: next.platform, source: next.source },
                event: 'viewer.enter',
                context: { event: 'viewer.enter', user: {}, room: {} },
                effectiveMode: 'focus',
              },
            })
            apply(next)
          } catch {
            error('分组 JSON 无效，当前草稿未替换')
          }
        }}
      >
        更新本地分组草稿
      </Button>
    </>
  )
}
