import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  audiencePolicyCatalog,
  isAudienceCardColor,
  validateAudiencePolicy,
  type AssistantAudiencePolicy,
  type AudiencePolicyCatalog,
  type AudiencePolicyCondition,
  type AudiencePolicyFieldDefinition,
  type AudiencePolicyRule,
} from '../../../shared/assistantAudiencePolicy'
import { OBS_WELCOME_PRESETS } from '../../../shared/obsWelcome'

const operatorLabels = { eq: '等于', gte: '大于或等于', lte: '小于或等于', in: '属于（多选）' }
const categoryLabels = { greeting: '问候', emoji: '表情', question: '提问', purchase: '购买意向', other: '其他' }
const tierLabels = { gold: '高优先', silver: '中优先', neutral: '常规' }
const legacyColorLabels = { gold: '金色', silver: '银色', neutral: '常规' }
const legacyColors = { gold: '#D9A441', silver: '#94A3B8', neutral: '#94A3B8' }
const colorPresets = [
  { id: 'gold', label: '金色', value: '#D4AF37' }, { id: 'silver', label: '银色', value: '#A8B3C7' },
  { id: 'blue', label: '蓝色', value: '#3B82F6' }, { id: 'purple', label: '紫色', value: '#8B5CF6' },
  { id: 'green', label: '绿色', value: '#22C55E' }, { id: 'pink', label: '粉色', value: '#EC4899' },
  { id: 'cyan', label: '青色', value: '#06B6D4' }, { id: 'orange', label: '橙色', value: '#F97316' },
  { id: 'red', label: '红色', value: '#EF4444' }, { id: 'teal', label: '蓝绿色', value: '#14B8A6' },
  { id: 'indigo', label: '靛蓝色', value: '#6366F1' }, { id: 'amber', label: '琥珀色', value: '#F59E0B' },
] as const
const validRgb = (values: string[]) => values.every(value => /^\d+$/.test(value) && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 255)
const rgbValues = (color: string) => [1, 3, 5].map(offset => String(parseInt(color.slice(offset, offset + 2), 16)))
const selectStyle = { width: '100%', minWidth: 0, padding: 6, borderRadius: 6, border: '1px solid var(--desk-border)', background: 'var(--background)', color: 'var(--foreground)' }
const knownFields = new Set(audiencePolicyCatalog().fields.map(field => field.field))
const editableFields = (catalog: AudiencePolicyCatalog) => catalog.fields.filter(field => knownFields.has(field.field))
const valueOptions = (field: AudiencePolicyFieldDefinition, catalog: AudiencePolicyCatalog) =>
  field.type === 'country' ? catalog.countries.map(country => ({ value: country.code, label: country.label }))
    : field.type === 'language' ? (catalog.languages ?? []).map(language => ({ value: language.code, label: language.label }))
    : field.type === 'category' ? catalog.categories.map(category => ({ value: category, label: categoryLabels[category] }))
      : field.type === 'script' ? (catalog.scripts ?? []).map(script => ({ value: script.code, label: script.label }))
        : []

function editableCondition(condition: AudiencePolicyCondition, catalog: AudiencePolicyCatalog) {
  const field = editableFields(catalog).find(field => field.field === condition.field)
  if (!field || !field.operators.includes(condition.operator)) return false
  if (field.type === 'number') return typeof condition.value === 'number' || condition.value === ''
  if (field.type === 'boolean') return typeof condition.value === 'boolean'
  return condition.operator === 'in'
    ? Array.isArray(condition.value) && condition.value.every(value => typeof value === 'string')
    : typeof condition.value === 'string'
}

export function audienceRuleDraftError(policy: AssistantAudiencePolicy, catalog: AudiencePolicyCatalog) {
  if (policy.rules.some(rule => rule.conditions.some(condition => !editableCondition(condition, catalog))))
    return '包含暂不支持编辑的条件；原条件已保留，当前草稿不能安全保存。'
  try { validateAudiencePolicy(policy, policy.revision); return undefined } catch {
    return '请核对规则名称、匹配顺序和条件值；每条规则需要 1～10 个有效条件。'
  }
}

function firstCondition(field: AudiencePolicyFieldDefinition, catalog: AudiencePolicyCatalog): AudiencePolicyCondition {
  return {
    field: field.field,
    operator: field.operators.includes('gte') ? 'gte' : field.operators[0],
    value: field.type === 'number' ? 0 : field.type === 'boolean' ? true : field.type === 'language' || field.type === 'country' ? '' : valueOptions(field, catalog)[0]?.value ?? '',
  }
}

export function AudiencePolicyRuleEditor({
  draft, baseRevision, catalog, dirty, saving, conflict, error, onChange, onSave, onCancel,
}: {
  draft: AssistantAudiencePolicy
  baseRevision: number
  catalog: AudiencePolicyCatalog
  dirty: boolean
  saving: boolean
  conflict: boolean
  error?: string
  onChange: (policy: AssistantAudiencePolicy) => void
  onSave: () => Promise<void>
  onCancel: () => void
}) {
  const [rgbDrafts, setRgbDrafts] = useState<Record<string, string[]>>({})
  const fields = editableFields(catalog)
  const newConditionFields = ['messageLanguage', 'manualCountry'].flatMap(name => fields.filter(field => field.field === name))
  const invalidRgb = draft.rules.some(rule => rgbDrafts[rule.id] && !validRgb(rgbDrafts[rule.id]))
  const validationError = invalidRgb ? 'RGB 每个分量需要 0～255 的整数；请完成颜色输入后保存。' : audienceRuleDraftError(draft, catalog)
  const changeRule = (index: number, patch: Partial<AudiencePolicyRule>) =>
    onChange({ ...draft, rules: draft.rules.map((rule, offset) => offset === index ? { ...rule, ...patch } : rule) })
  const changeCondition = (ruleIndex: number, conditionIndex: number, condition: AudiencePolicyCondition) =>
    changeRule(ruleIndex, { conditions: draft.rules[ruleIndex].conditions.map((current, index) => index === conditionIndex ? condition : current) })
  const changeColor = (ruleIndex: number, cardColor: string) => {
    const rule = draft.rules[ruleIndex]
    setRgbDrafts(current => { const { [rule.id]: _removed, ...rest } = current; return rest })
    changeRule(ruleIndex, { result: { ...rule.result, cardColor: cardColor.toUpperCase() } })
  }
  const changeRgb = (ruleIndex: number, channelIndex: number, value: string) => {
    const rule = draft.rules[ruleIndex]
    const color = isAudienceCardColor(rule.result.cardColor) ? rule.result.cardColor : legacyColors[rule.result.tier]
    const values = (rgbDrafts[rule.id] ?? rgbValues(color)).map((current, index) => index === channelIndex ? value : current)
    if (validRgb(values)) changeColor(ruleIndex, `#${values.map(value => Number(value).toString(16).padStart(2, '0')).join('')}`)
    else setRgbDrafts(current => ({ ...current, [rule.id]: values }))
  }
  const addRule = () => {
    const rule: AudiencePolicyRule = { id: `rule-${crypto.randomUUID()}`, label: '新规则', enabled: true,
      priority: Math.min(10000, Math.max(0, ...draft.rules.map(rule => rule.priority)) + 100),
      conditions: [firstCondition(newConditionFields[0], catalog)], result: { tier: 'neutral', label: '待核对观众', autoAttention: false, cardColor: '#94A3B8' } }
    onChange({ ...draft, rules: [...draft.rules, rule] })
  }
  return (
    <div role="group" aria-label="观众规则编辑草稿">
      <p role="status" className="assistant-muted">{dirty ? '待保存草稿' : '编辑草稿'} · 基于已保存 v{baseRevision}；实时区仍使用已保存规则。</p>
      <p className="assistant-muted">同一规则的所有条件同时满足才命中。匹配顺序数字越小越先，采用第一条命中的已启用规则。</p>
      <fieldset disabled={saving} style={{ minWidth: 0 }}>
        <label className="assistant-checkbox">
          <input type="checkbox" aria-label="启用观众规则" checked={draft.enabled} onChange={event => onChange({ ...draft, enabled: event.target.checked })} />
          启用观众规则（草稿）
        </label>
        <div className="assistant-policy-rules">
          {draft.rules.map((rule, ruleIndex) => (
            <article key={rule.id} data-editor-rule-id={rule.id} className="assistant-policy-rule">
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
                <label className="assistant-field">规则名称<Input aria-label="规则名称" maxLength={60} value={rule.label} onChange={event => changeRule(ruleIndex, { label: event.target.value })} /></label>
                <label className="assistant-field">匹配顺序<Input aria-label="匹配顺序" type="number" min={0} max={10000} step={1} value={Number.isFinite(rule.priority) ? rule.priority : ''} onChange={event => changeRule(ruleIndex, { priority: event.target.value === '' ? NaN : Number(event.target.value) })} /></label>
              </div>
              <label className="assistant-checkbox"><input type="checkbox" aria-label="启用此规则" checked={rule.enabled} onChange={event => changeRule(ruleIndex, { enabled: event.target.checked })} />启用此规则（草稿）</label>
              {rule.conditions.map((condition, conditionIndex) => {
                const field = fields.find(field => field.field === condition.field)
                if (!field || !editableCondition(condition, catalog)) return (
                  <p key={conditionIndex} data-condition-index={conditionIndex} className="assistant-muted">只读复合条件：{field?.label ?? condition.field}；原条件完整保留，暂不支持编辑。</p>
                )
                const options = valueOptions(field, catalog)
                return (
                  <fieldset key={conditionIndex} data-condition-index={conditionIndex} style={{ minWidth: 0, margin: '10px 0' }}>
                    <legend>条件 {conditionIndex + 1}{conditionIndex > 0 ? '（且）' : ''}</legend>
                    <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
                      <label className="assistant-field">条件属性
                        <select aria-label="条件属性" style={selectStyle} value={condition.field} onChange={event => changeCondition(ruleIndex, conditionIndex, firstCondition(fields.find(field => field.field === event.target.value)!, catalog))}>
                          {fields.filter(field => newConditionFields.includes(field) || field.field === condition.field).map(field => <option key={field.field} value={field.field}>{field.label}</option>)}
                        </select>
                      </label>
                      <label className="assistant-field">条件关系
                        <select aria-label="条件关系" style={selectStyle} value={condition.operator} onChange={event => {
                          const operator = event.target.value as AudiencePolicyCondition['operator']
                          const value = operator === 'in' ? Array.isArray(condition.value) ? condition.value : [String(condition.value)] : Array.isArray(condition.value) ? condition.value[0] ?? '' : condition.value
                          changeCondition(ruleIndex, conditionIndex, { ...condition, operator, value })
                        }}>
                          {field.operators.map(operator => <option key={operator} value={operator}>{operatorLabels[operator]}</option>)}
                        </select>
                      </label>
                      <label className="assistant-field">{condition.operator === 'in' ? '条件值（可多选）' : '条件值'}
                        {field.type === 'number' ? <Input aria-label="条件值" type="number" min={0} step={1} value={condition.value as number | string} onChange={event => changeCondition(ruleIndex, conditionIndex, { ...condition, value: event.target.value === '' ? '' : Number(event.target.value) })} />
                          : field.type === 'boolean' ? <select aria-label="条件值" style={selectStyle} value={String(condition.value)} onChange={event => changeCondition(ruleIndex, conditionIndex, { ...condition, value: event.target.value === 'true' })}><option value="true">已观测到</option><option value="false">否（未知值不会按否匹配）</option></select>
                            : <select aria-label={condition.operator === 'in' ? '条件值（可多选）' : '条件值'} style={selectStyle} multiple={condition.operator === 'in'} value={condition.value as string | string[]} onChange={event => changeCondition(ruleIndex, conditionIndex, { ...condition, value: condition.operator === 'in' ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value })}>
                              {condition.value === '' && <option value="" disabled>请选择{field.label}</option>}
                              {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>}
                      </label>
                    </div>
                    <Button size="sm" variant="ghost" disabled={rule.conditions.length <= 1} onClick={() => changeRule(ruleIndex, { conditions: rule.conditions.filter((_, index) => index !== conditionIndex) })}>删除条件</Button>
                  </fieldset>
                )
              })}
              <Button size="sm" variant="outline" disabled={rule.conditions.length >= catalog.limits.conditionsPerRule || !newConditionFields.length} onClick={() => changeRule(ruleIndex, { conditions: [...rule.conditions, firstCondition(newConditionFields[0], catalog)] })}>添加条件</Button>
              <fieldset style={{ minWidth: 0, margin: '12px 0' }}>
                <legend>颜色与处理设置</legend>
                <p className="assistant-muted">颜色、处理优先级和自动进入待处理分别设置；选择颜色只改变显示。</p>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
                  <label className="assistant-field">显示颜色<select aria-label="显示颜色" style={selectStyle} value={rule.result.cardColor === undefined ? 'legacy' : colorPresets.find(preset => preset.value === rule.result.cardColor?.toUpperCase())?.id ?? 'custom'} onChange={event => {
                    const preset = colorPresets.find(preset => preset.id === event.target.value)
                    if (preset) changeColor(ruleIndex, preset.value)
                  }}>
                    {rule.result.cardColor === undefined && <option value="legacy" disabled>原默认颜色（{legacyColorLabels[rule.result.tier]}）</option>}
                    {colorPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                    <option value="custom" disabled>自定义 RGB</option>
                  </select></label>
                  <label className="assistant-field">处理优先级<select aria-label="处理优先级" style={selectStyle} value={rule.result.tier} onChange={event => changeRule(ruleIndex, { result: { ...rule.result,
                    ...(rule.result.cardColor === undefined ? { cardColor: legacyColors[rule.result.tier] } : {}), tier: event.target.value as AudiencePolicyRule['result']['tier'] } })}>
                    {Object.entries(tierLabels).map(([tier, label]) => <option key={tier} value={tier}>{label}</option>)}
                  </select></label>
                  <label className="assistant-field">欢迎特效<select aria-label="欢迎特效" style={selectStyle} value={rule.result.welcomePresetId ?? ''} onChange={event => {
                    if (event.target.value) changeRule(ruleIndex, { result: { ...rule.result, welcomePresetId: event.target.value } })
                    else {
                      const { welcomePresetId: _removed, ...result } = rule.result
                      changeRule(ruleIndex, { result })
                    }
                  }}>
                    <option value="">默认（未指定）</option>
                    {OBS_WELCOME_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label} · {preset.kind === 'html' ? '轻量动画' : '视频素材'}</option>)}
                  </select></label>
                  <label className="assistant-field">显示标签<Input aria-label="显示标签" maxLength={60} value={rule.result.label} onChange={event => changeRule(ruleIndex, { result: { ...rule.result, label: event.target.value } })} /></label>
                </div>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(85px, 1fr))', marginTop: 8 }}>
                  <label className="assistant-field">自定义颜色<input aria-label="自定义颜色" type="color" value={isAudienceCardColor(rule.result.cardColor) ? rule.result.cardColor : legacyColors[rule.result.tier]} style={{ ...selectStyle, height: 36, padding: 3 }} onChange={event => changeColor(ruleIndex, event.target.value)} /></label>
                  {['R', 'G', 'B'].map((channel, channelIndex) => <label key={channel} className="assistant-field">RGB {channel}<Input aria-label={`RGB ${channel}`} type="number" min={0} max={255} step={1} value={(rgbDrafts[rule.id] ?? rgbValues(isAudienceCardColor(rule.result.cardColor) ? rule.result.cardColor : legacyColors[rule.result.tier]))[channelIndex]} onChange={event => changeRgb(ruleIndex, channelIndex, event.target.value)} /></label>)}
                </div>
                <label className="assistant-checkbox"><input type="checkbox" aria-label="自动进入待处理" checked={rule.result.autoAttention} onChange={event => changeRule(ruleIndex, { result: { ...rule.result, autoAttention: event.target.checked } })} />自动进入待处理</label>
                <p className="assistant-muted">素材是否可用取决于当前 OBS 场景；未指定时，高优先使用金币微雨，其他观众使用轻光欢迎。</p>
              </fieldset>
              <Button size="sm" variant="ghost" onClick={() => onChange({ ...draft, rules: draft.rules.filter((_, index) => index !== ruleIndex) })}>删除规则</Button>
            </article>
          ))}
        </div>
        <Button size="sm" variant="outline" disabled={draft.rules.length >= catalog.limits.rules || !newConditionFields.length} onClick={addRule}>添加规则</Button>
      </fieldset>
      {conflict && <p role="alert" className="assistant-error-text">已保存规则已在其他窗口更新；草稿保留。请取消编辑后从最新版本重新编辑。</p>}
      {(error || validationError) && <p role="alert" className="assistant-error-text">{error || validationError}</p>}
      <div className="assistant-actions">
        <Button disabled={saving || !dirty || conflict || !!validationError} onClick={() => void onSave()}>{saving ? '正在保存观众规则' : '保存观众规则'}</Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>取消编辑</Button>
      </div>
    </div>
  )
}
