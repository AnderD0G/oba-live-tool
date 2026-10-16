import { createContext, useEffect, useRef, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AssistantAudiencePolicy } from '../../../shared/assistantAudiencePolicy'
import { ASSISTANT_REPLY_ACTIONS, defaultAssistantReplyPolicy, validateAssistantReplyPolicy, type AssistantReplyAction,
  type AssistantReplyMode, type AssistantReplyPolicy, type AssistantReplyRule } from '../../../shared/assistantReplyPolicy'
import type { DeskRequest } from './MessageCard'

export const ReplyPolicyContext = createContext<{ policy?: AssistantReplyPolicy; ai?: { used: number; limit: number; paused?: boolean; pauseReason?: string } }>({})
const labels: Record<AssistantReplyAction, string> = { comment: '发言', enter: '进场', follow: '关注', gift: '送礼', like: '点赞' }
export const replyModeLabels: Record<AssistantReplyMode, string> = { off: '关闭', manual: '手动 AI', review: '生成待确认', auto: '自动发送' }
export function replyPolicySummary(policy?: AssistantReplyPolicy): string {
  if (!policy?.enabled) return '已关闭'
  const modes = [...new Set(policy.rules.filter(rule => rule.enabled && rule.mode !== 'off').map(rule => rule.mode))]
  return modes.length ? modes.map(mode => replyModeLabels[mode]).join(' / ') : '动作均已关闭'
}

export function ReplyPolicyPanel({ accountId, policy, audiencePolicy, request, legacyContext, onPolicyLoaded, busy = false }: {
  accountId: string; policy?: AssistantReplyPolicy; audiencePolicy?: AssistantAudiencePolicy; request: DeskRequest
  legacyContext?: { knowledge: string; instructions: string }; onPolicyLoaded?: (policy: AssistantReplyPolicy) => void; busy?: boolean
}) {
  const initial = policy ?? defaultAssistantReplyPolicy()
  const [base, setBase] = useState(initial), [draft, setDraft] = useState(initial)
  const [action, setAction] = useState<AssistantReplyAction>('comment')
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const savingRef = useRef(false), loadingRef = useRef(false)
  const [available, setAvailable] = useState(!!policy)
  const dirty = JSON.stringify(base) !== JSON.stringify(draft)
  const conflict = !!policy && policy.revision > base.revision
  useEffect(() => {
    if (policy && !dirty && (!available || policy.revision > base.revision)) { setBase(policy); setDraft(policy); setAvailable(true) }
  }, [policy, dirty, base.revision, available])
  const load = async () => {
    if (loadingRef.current) return
    loadingRef.current = true; setError('')
    try {
      const result = await request({ action: 'reply-policy-get', params: { accountId } })
      if (!result.ok) { setError(result.error.message); return }
      const loaded = result.data as AssistantReplyPolicy
      if (!Number.isSafeInteger(loaded?.revision) || !Array.isArray(loaded.rules)) { setError('回复规则尚未读取，请重试'); return }
      setBase(loaded); setDraft(loaded); setAvailable(true); onPolicyLoaded?.(loaded)
    } catch { setError('读取回复规则失败，请稍后重试') }
    finally { loadingRef.current = false }
  }
  const update = (id: string, change: Partial<AssistantReplyRule>) => {
    setDraft(current => ({ ...current, rules: current.rules.map(rule => rule.id === id ? { ...rule, ...change } : rule) }))
    setNotice(''); setError('')
  }
  const save = async () => {
    if (savingRef.current || busy || conflict) return
    let validated: AssistantReplyPolicy
    try { validated = validateAssistantReplyPolicy(draft, base.revision) }
    catch { setError('请检查规则优先级、适用观众和文字长度'); return }
    savingRef.current = true; setSaving(true); setError('')
    try {
      const result = await request({ action: 'reply-policy-save', params: { accountId, expectedRevision: base.revision, policy: validated, requestId: crypto.randomUUID() } })
      if (!result.ok) { setError(result.error.message); return }
      const saved = result.data as AssistantReplyPolicy
      if (!Number.isSafeInteger(saved?.revision) || !Array.isArray(saved.rules)) { setError('保存回执缺少规则版本，请重新读取'); return }
      setBase(saved); setDraft(saved); onPolicyLoaded?.(saved); setNotice(`已保存回复规则 v${saved.revision}`)
    } catch { setError('保存失败；规则草稿已保留，请重试') }
    finally { savingRef.current = false; setSaving(false) }
  }
  const shown = draft.rules.filter(rule => rule.action === action)
  if (!policy && !available) return <details className="assistant-panel assistant-context" aria-label="AI 回复规则设置">
    <summary><strong>AI 回复规则</strong> · 等待读取</summary>
    <p className="assistant-muted">等待账户状态同步；也可手动读取回复规则。</p>
    <Button size="sm" variant="outline" onClick={() => void load()}>读取回复规则</Button>
    {error && <p role="alert" className="assistant-error-text">{error}</p>}
  </details>
  return <details className="assistant-panel assistant-context" aria-label="AI 回复规则设置">
    <summary><strong>AI 回复规则</strong> · {replyPolicySummary(base)} · v{base.revision}</summary>
    <p className="assistant-muted">发言、进场、关注、送礼和点赞分别配置。草稿与 AI 操作统一在待处理工作区；自动发送按已保存规则执行。</p>
    <label className="assistant-checkbox"><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={event => { setDraft(current => ({ ...current, enabled: event.target.checked })); setNotice('') }} />启用 AI 回复规则</label>
    <label className="assistant-field">配置动作<select aria-label="配置动作" value={action} onChange={event => setAction(event.target.value as AssistantReplyAction)}>
      {ASSISTANT_REPLY_ACTIONS.map(value => <option key={value} value={value}>{labels[value]}</option>)}
    </select></label>
    {shown.map((rule, index) => {
      const scope = rule.audienceRuleId ? `rule:${rule.audienceRuleId}` : rule.tier ? `tier:${rule.tier}` : 'all'
      const missing = rule.audienceRuleId && !audiencePolicy?.rules.some(item => item.id === rule.audienceRuleId)
      return <fieldset key={rule.id} className="assistant-panel" disabled={saving}>
        <legend>{labels[rule.action]}{shown.length > 1 ? ` · 规则 ${index + 1}` : ''}</legend>
        <div className="assistant-config-row">
          <label className="assistant-checkbox"><input type="checkbox" checked={rule.enabled} onChange={event => update(rule.id, { enabled: event.target.checked })} />启用此规则</label>
          <label className="assistant-field">回复模式<select aria-label={`${labels[action]}回复模式${index ? ` ${index + 1}` : ''}`} value={rule.mode} onChange={event => update(rule.id, { mode: event.target.value as AssistantReplyMode })}>
            {Object.entries(replyModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="assistant-field">适用观众<select aria-label={`${labels[action]}适用观众${index ? ` ${index + 1}` : ''}`} value={scope} onChange={event => {
            const value = event.target.value
            update(rule.id, { audienceRuleId: value.startsWith('rule:') ? value.slice(5) : undefined, tier: value.startsWith('tier:') ? value.slice(5) as AssistantReplyRule['tier'] : undefined })
          }}><option value="all">所有观众</option>{audiencePolicy?.rules.map(item => <option key={item.id} value={`rule:${item.id}`}>{item.label}{item.enabled ? '' : '（已暂停）'}</option>)}
            {missing && <option value={`rule:${rule.audienceRuleId}`}>{rule.audienceRuleId}（规则未找到）</option>}
            <option value="tier:gold">重点观众档</option><option value="tier:silver">关注观众档</option><option value="tier:neutral">普通 / 未知档</option>
          </select></label>
          <label className="assistant-field">优先级<Input aria-label={`${labels[action]}规则优先级${index ? ` ${index + 1}` : ''}`} type="number" min={0} max={10000} step={1} value={rule.priority} onChange={event => update(rule.id, { priority: Number(event.target.value) })} /></label>
        </div>
        <p className="assistant-muted">优先级数字越小越先匹配；每个动作只采用第一条匹配规则。</p>
        <label className="assistant-field">知识库<Textarea aria-label={`${labels[action]}知识库${index ? ` ${index + 1}` : ''}`} rows={4} maxLength={20000} value={rule.knowledge} onChange={event => update(rule.id, { knowledge: event.target.value })} placeholder="填写已经核实的商品、价格、尺寸和售后事实" /></label>
        <label className="assistant-field">回复要求<Textarea aria-label={`${labels[action]}回复要求${index ? ` ${index + 1}` : ''}`} rows={2} maxLength={20000} value={rule.instructions} onChange={event => update(rule.id, { instructions: event.target.value })} placeholder="例如：用观众语言简短欢迎；没有资料的信息先确认" /></label>
        <div className="assistant-actions">
          <Button size="sm" variant="outline" disabled={!legacyContext || (!legacyContext.knowledge && !legacyContext.instructions)} onClick={() => { update(rule.id, { knowledge: legacyContext?.knowledge ?? '', instructions: legacyContext?.instructions ?? '' }); setNotice('旧版资料已复制到此规则草稿，请检查后保存') }}>复制旧版资料</Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(current => ({ ...current, rules: current.rules.filter(item => item.id !== rule.id) }))}><Trash2 size={14} />删除此规则</Button>
        </div>
        {rule.mode === 'auto' && <p className="assistant-warning">保存并启用后，此动作会自动公开发送；资料不明的回复仍需确认。</p>}
        <small className="assistant-muted">规则 ID {rule.id}</small>
      </fieldset>
    })}
    <Button size="sm" variant="outline" disabled={saving || draft.rules.length >= 100} onClick={() => setDraft(current => ({ ...current, rules: [...current.rules,
      { id: `reply-${crypto.randomUUID()}`, enabled: true, action, mode: 'manual', priority: 100, knowledge: '', instructions: '' }] }))}><Plus size={14} />添加{labels[action]}规则</Button>
    {conflict && dirty && <div role="alert" className="assistant-warning">回复规则已在其他窗口更新；当前草稿已保留。<Button size="sm" variant="outline" onClick={() => { setBase(policy!); setDraft(policy!); setError(''); setNotice('已读取最新规则') }}>放弃草稿并读取最新规则</Button></div>}
    <div className="assistant-actions"><Button disabled={busy || saving || !dirty || conflict} onClick={() => void save()}><Save size={16} />{saving ? '保存中…' : '保存 AI 回复规则'}</Button></div>
    {error && <p role="alert" className="assistant-error-text">{error}</p>}
    <p role="status" className="assistant-muted">{notice || (dirty ? '回复规则草稿未保存，当前仍使用已保存版本' : `已保存回复规则 v${base.revision}`)}</p>
  </details>
}
