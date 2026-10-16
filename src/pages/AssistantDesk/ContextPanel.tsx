import { BookOpen, Pause, Play, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AssistantDeskContext } from '../../../shared/assistantDesk'
import type { AssistantAudiencePolicy } from '../../../shared/assistantAudiencePolicy'
import type { DeskRequest } from './MessageCard'

export function ContextPanel({
  accountId,
  context,
  busy,
  saving = false,
  request,
  audiencePolicy,
  replyPolicyConfigured = false,
}: {
  accountId: string
  context: AssistantDeskContext
  busy: boolean
  saving?: boolean
  request: DeskRequest
  audiencePolicy?: AssistantAudiencePolicy
  replyPolicyConfigured?: boolean
}) {
  const [base, setBase] = useState(context)
  const [draft, setDraft] = useState(context)
  const [notice, setNotice] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  const conflict = context.revision > base.revision
  useEffect(() => {
    if (!dirty && context.revision > base.revision) {
      setBase(context)
      setDraft(context)
    }
  }, [context, dirty, base.revision])
  const change = <K extends keyof AssistantDeskContext>(key: K, value: AssistantDeskContext[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
    setNotice('')
  }
  const save = async () => {
    const result = await request({
      action: 'context-save',
      params: { accountId, expectedRevision: base.revision, context: draft },
    })
    if (result.ok) {
      const saved = result.data as AssistantDeskContext
      if (typeof saved?.revision === 'number') {
        setBase(saved)
        setDraft(saved)
      }
      setNotice('知识与回复设置已保存')
    }
  }
  return (
    <section className="assistant-panel assistant-context" aria-label="知识与回复设置">
      <div className="assistant-section-heading">
        <div>
          <span className="assistant-step">02 · 助手设置</span>
          <h2>
            <BookOpen size={18} />
            知识与回复
          </h2>
        </div>
        <span className="assistant-muted">v{base.revision}</span>
      </div>
      <label className="assistant-field" htmlFor="assistant-translation-mode">
        翻译来源
        <select id="assistant-translation-mode" aria-label="翻译来源" value={draft.translationMode ?? 'ai'} onChange={event => change('translationMode', event.target.value as AssistantDeskContext['translationMode'])}>
          <option value="ai">AI翻译</option>
          <option value="browser">浏览器网页译文</option>
          <option value="local">Chrome 本地翻译</option>
        </select>
      </label>
      {draft.translationMode === 'browser' && <p className="assistant-muted">使用当前浏览器网页译文补充中文；未找到或无法唯一对应时保留原文，不自动请求 AI。AI 暂停仍控制回复与 AI 请求，网页译文继续接收。</p>}
      {draft.translationMode === 'local' && <p className="assistant-muted">使用当前 Chrome 实际支持的语言进行本地翻译，首次使用可能下载语言包并等待数秒。本地翻译无按次付费，不占用 AI 请求额度，也不受 AI 暂停影响。不支持或语言识别不确定时保留原文及原因，可手动选择 DeepSeek 翻译；手动翻译计入 AI 额度。</p>}
      <label className="assistant-field" htmlFor="assistant-attention-age">
        待处理保留时长（分钟）
        <Input
          id="assistant-attention-age"
          type="number"
          min={0.5}
          max={1440}
          step="any"
          value={(draft.attentionMaxAgeSeconds ?? 600) / 60}
          onChange={event => change('attentionMaxAgeSeconds', Number(event.target.value) * 60)}
        />
      </label>
      <p className="assistant-muted">
        只保留当前直播时限内的待处理消息；过期和上一场的记录可在历史复盘查看。
      </p>
      <p className="assistant-muted">回复模式、每个动作的知识与要求统一在「AI 回复规则」配置。下方旧资料仅用于查看和复制迁移。</p>
      <details open={!replyPolicyConfigured}>
      <summary>旧版知识与回复资料</summary>
      <label className="assistant-field" htmlFor="assistant-knowledge">
        知识库
        <Textarea
          id="assistant-knowledge"
          rows={6}
          value={draft.knowledge}
          maxLength={20000}
          onChange={event => change('knowledge', event.target.value)}
          placeholder="填写商品事实、价格、尺寸、售后规则；未提供的信息交给你确认。"
        />
      </label>
      <label className="assistant-field" htmlFor="assistant-instructions">
        回复要求
        <Textarea
          id="assistant-instructions"
          rows={3}
          value={draft.instructions}
          maxLength={20000}
          onChange={event => change('instructions', event.target.value)}
          placeholder="例如：按观众语言简短回复；不了解的信息先确认。"
        />
      </label>
      </details>
      <div className="assistant-config-row">
        <label className="assistant-field" htmlFor="assistant-limit">
          每场 AI 请求上限
          <Input
            id="assistant-limit"
            type="number"
            min={0}
            max={1000}
            step={1}
            value={draft.aiRequestLimit}
            onChange={event => change('aiRequestLimit', Number(event.target.value))}
          />
        </label>
        <label className="assistant-checkbox">
          <input
            type="checkbox"
            checked={draft.translationEnabled}
            onChange={event => change('translationEnabled', event.target.checked)}
          />
          中文翻译
        </label>
      </div>
      <details>
        <summary>AI 自动任务排队</summary>
        <p className="assistant-muted">
          这里只调整已排队 AI 任务的先后。观众颜色和待处理规则统一见「观众规则列表」。
          {audiencePolicy?.enabled && '当前观众规则已启用。'}
        </p>
        <p className="assistant-muted">
          已保存排队设置：{context.priorityGold ? `优先处理消费等级 ≥ ${context.goldLevel} 的 AI 任务` : '按进入队列的顺序处理'}
        </p>
        <label className="assistant-checkbox">
          <input
            type="checkbox"
            checked={draft.priorityGold}
            onChange={event => change('priorityGold', event.target.checked)}
          />
          优先处理消费等级 ≥ {draft.goldLevel} 的 AI 任务
        </label>
        {draft.priorityGold !== base.priorityGold && <p role="status" className="assistant-muted">AI 排队草稿未保存，当前仍使用已保存排队设置。</p>}
      </details>
      <label className="assistant-checkbox">
        <input
          type="checkbox"
          checked={draft.localEffectsEnabled}
          onChange={event => change('localEffectsEnabled', event.target.checked)}
        />
        本地 OBS 欢迎/礼物特效
      </label>
      <p className="assistant-muted">本地特效不发送公屏回复，也不额外调用 AI。</p>
      <p className="assistant-muted">失败和重试也计入限额。达到上限暂停 AI，采集与保存继续。</p>
      {conflict && dirty && (
        <div role="alert" className="assistant-warning">
          设置已在其他窗口更新；当前草稿已保留。请核对最新版本后重新编辑。
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setBase(context)
              setDraft(context)
              setNotice('已读取最新设置')
            }}
          >
            放弃草稿并读取最新设置
          </Button>
        </div>
      )}
      <div className="assistant-actions">
        <Button
          disabled={
            busy ||
            !dirty ||
            !Number.isSafeInteger(draft.aiRequestLimit) ||
            draft.aiRequestLimit < 0 ||
            draft.aiRequestLimit > 1000 ||
            !Number.isSafeInteger(draft.attentionMaxAgeSeconds ?? 600) ||
            (draft.attentionMaxAgeSeconds ?? 600) < 30 ||
            (draft.attentionMaxAgeSeconds ?? 600) > 86400
          }
          onClick={() => void save()}
        >
          <Save />
          保存知识与回复设置
        </Button>
        <Button
          variant="outline"
          disabled={context.aiPaused ? busy || dirty : saving}
          onClick={() =>
            void request({
              action: 'context-save',
              params: {
                accountId,
                expectedRevision: context.revision,
                context: { ...context, aiPaused: !context.aiPaused },
              },
            })
          }
        >
          {context.aiPaused ? <Play /> : <Pause />}
          {context.aiPaused ? '恢复 AI' : '暂停 AI'}
        </Button>
      </div>
      <p role="status" className="assistant-muted">
        {notice || (dirty ? '有未保存设置，当前运行仍使用已保存版本' : '设置已同步')}
        {dirty && ' · 暂停 AI 会保留当前知识草稿'}
      </p>
    </section>
  )
}
