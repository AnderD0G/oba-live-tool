import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type {
  AssistantAudiencePolicy,
  AssistantAudienceTriage,
  AudienceCountryTagResult,
  AudienceMessageCategory,
  AudiencePolicyCatalog,
  AudiencePolicyCondition,
} from '../../../shared/assistantAudiencePolicy'
import { audiencePolicyCatalog } from '../../../shared/assistantAudiencePolicy'
import type {
  AssistantDeskAudience,
  AssistantDeskPage,
  AssistantDeskRow,
  AssistantDeskState,
} from '../../../shared/assistantDesk'
import { OBS_WELCOME_PRESETS } from '../../../shared/obsWelcome'
import { AssistantMessageCard, type DeskRequest } from './MessageCard'
import { AudiencePolicyRuleEditor, audienceRuleDraftError } from './AudiencePolicyRuleEditor'
import { displayLanguage, displayRuleColor, displayTime } from './presentation'

export const messageCategoryLabels: Record<AudienceMessageCategory, string> = {
  greeting: '问候',
  emoji: '表情',
  question: '提问',
  purchase: '购买意向',
  other: '其他',
}
const countries = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
export const countryLabel = (code: string) => countries.of(code) ?? code
const tierLabels = { gold: '金色优先', silver: '银色优先', neutral: '常规' }
const customTierLabels = { gold: '高优先', silver: '中优先', neutral: '常规' }

function RuleColorSwatch({ color }: { color?: string }) {
  const safe = displayRuleColor(color)
  return safe ? <span className="assistant-rule-color-swatch" aria-label="规则显示颜色"
    title={`显示颜色 ${safe}`} style={{ backgroundColor: safe }} /> : null
}

export function AudienceLanguageBadge({ language, hasMessage }: {
  language?: string
  hasMessage: boolean
}) {
  if (!hasMessage) return null
  const languageLabel = displayLanguage(language)
  return <span className={languageLabel ? 'assistant-language-badge' : 'assistant-language-unknown'}
    title="本条发言记录的识别语言；不代表昵称语言、观众国籍或居住地">
    {languageLabel ? `语言 · ${languageLabel}` : '语言未确定'}
  </span>
}

export function AudienceTriageBadges({
  triage,
  language,
  country,
  hasMessage = true,
}: {
  triage: AssistantAudienceTriage
  language?: string
  country?: AssistantAudienceTriage['country']
  hasMessage?: boolean
}) {
  const region = country ?? triage.country
  const ruleColor = displayRuleColor(triage.cardColor)
  const regionTitle =
    region.source === 'manual'
      ? `来源：手动标记；版本 ${region.tagRevision}；${region.manualTag?.note ?? '无备注'}；${displayTime(region.manualTag?.updatedAt, true)}`
      : '人工地区标签尚未设置'
  return (
    <>
      <span
        className={`assistant-priority-badge assistant-priority-${triage.tier}${ruleColor ? ' assistant-priority-custom' : ''}`}
        title={`规则版本 ${triage.policyRevision}；${triage.label || '未匹配已保存规则'}`}
      >
        {(ruleColor ? customTierLabels : tierLabels)[triage.tier]}
        {triage.label && ` · ${triage.label}`}
      </span>
      <span
        className={`assistant-country-badge assistant-country-${region.source === 'manual' ? 'manual' : 'unknown'}`}
        title={regionTitle}
      >
        {region.source === 'manual' && region.code
          ? `${countryLabel(region.code)} · 手动`
          : '地区未标记'}
      </span>
      <AudienceLanguageBadge language={language} hasMessage={hasMessage} />
    </>
  )
}

export function AudienceCountryEditor({
  row,
  request,
  onConfirmed,
}: {
  row: AssistantDeskRow
  request: DeskRequest
  onConfirmed: (result: AudienceCountryTagResult) => void
}) {
  const [catalog, setCatalog] = useState<AudiencePolicyCatalog>()
  const [confirmed, setConfirmed] = useState<AudienceCountryTagResult>()
  const country = row.triage?.country
  const current =
    confirmed && confirmed.revision >= (country?.tagRevision ?? 0)
      ? confirmed
      : { revision: country?.tagRevision ?? 0, tag: country?.manualTag }
  const [draft, setDraft] = useState<{ code: string; note: string }>()
  const code = draft?.code ?? current.tag?.countryCode ?? ''
  const note = draft?.note ?? current.tag?.note ?? ''
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string }>()
  const load = async () => {
    if (catalog || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setNotice(undefined)
    try {
      const result = await request({
        action: 'policy-fields',
        params: { accountId: row.accountId },
      })
      if (result.ok) setCatalog(result.data as AudiencePolicyCatalog)
      else setNotice({ error: true, text: result.error.message })
    } catch {
      setNotice({ error: true, text: '国家目录读取失败，请重试' })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  const save = async (clear: boolean) => {
    if (!row.audienceUuid || inFlight.current || (!clear && !code)) return
    inFlight.current = true
    setPending(true)
    setNotice(undefined)
    const submitted = draft
    try {
      const result = await request({
        action: 'audience-tag',
        params: {
          accountId: row.accountId,
          audienceUuid: row.audienceUuid,
          expectedRevision: current.revision,
          countryCode: clear ? null : code,
          ...(!clear && note.trim() ? { note: note.trim() } : {}),
        },
      })
      if (!result.ok) setNotice({ error: true, text: result.error.message })
      else {
        const data = result.data as AudienceCountryTagResult
        setConfirmed(data)
        onConfirmed(data)
        setDraft(latest => (latest === submitted ? undefined : latest))
        setNotice({ error: false, text: clear ? '国家标记已清除' : '国家标记已保存' })
      }
    } catch {
      setNotice({ error: true, text: '国家标记保存失败；输入已保留，请重试' })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  const refreshCountry = async () => {
    if (!row.audienceUuid || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setNotice(undefined)
    try {
      const result = await request({
        action: 'audience',
        params: { accountId: row.accountId, audienceUuid: row.audienceUuid, limit: 1 },
      })
      if (!result.ok) setNotice({ error: true, text: result.error.message })
      else {
        const person = (result.data as AssistantDeskPage<AssistantDeskAudience>).items.find(
          item => item.uuid === row.audienceUuid,
        )
        if (!person?.triage)
          setNotice({ error: true, text: '未找到这位观众的最新标记，请重新查询观众' })
        else {
          const data = {
            audienceUuid: row.audienceUuid,
            revision: person.triage.country.tagRevision,
            tag: person.triage.country.manualTag,
          }
          setConfirmed(data)
          onConfirmed(data)
          setNotice({ error: false, text: '国家标记已刷新；当前输入已保留' })
        }
      }
    } catch {
      setNotice({ error: true, text: '最新国家标记读取失败；输入已保留，请重试' })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return (
    <details
      className="assistant-country-editor"
      onToggle={event => {
        if (event.currentTarget.open) void load()
      }}
    >
      <summary>国家标记</summary>
      <p className="assistant-muted">
        手动标记只绑定这位观众的 UUID，不按同名昵称合并。版本 {current.revision}
      </p>
      <div className="assistant-tag-fields">
        <label className="assistant-field">
          手动国家
          <select
            aria-label="手动国家"
            value={code}
            disabled={!catalog || pending}
            onChange={event => setDraft({ code: event.target.value, note })}
          >
            <option value="">请选择国家</option>
            {catalog?.countries.map(item => (
              <option key={item.code} value={item.code}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="assistant-field">
          标记备注
          <Input
            aria-label="标记备注"
            value={note}
            maxLength={300}
            onChange={event => setDraft({ code, note: event.target.value })}
            placeholder="例如：观众明确说明"
          />
        </label>
      </div>
      <div className="assistant-actions">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void refreshCountry()}>
          刷新国家标记
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !catalog || !code}
          onClick={() => void save(false)}
        >
          保存国家标记
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || !current.tag}
          onClick={() => void save(true)}
        >
          清除国家标记
        </Button>
        {!catalog && !pending && (
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            重试读取国家目录
          </Button>
        )}
      </div>
      {notice && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'assistant-error-text' : 'assistant-muted'}
        >
          {notice.text}
        </p>
      )}
    </details>
  )
}

const operatorLabels = { eq: '=', gte: '≥', lte: '≤', in: '属于' }
const fallbackPolicyCatalog = audiencePolicyCatalog()
function conditionLabel(condition: AudiencePolicyCondition, catalog?: AudiencePolicyCatalog) {
  const definitions = catalog ?? fallbackPolicyCatalog
  const field = definitions.fields.find(item => item.field === condition.field)
  const values = Array.isArray(condition.value) ? condition.value : [condition.value]
  if (values.some(value => !['string', 'number', 'boolean'].includes(typeof value)))
    return `${field?.label ?? condition.field} · 复合条件（只读保留）`
  const value = values
    .map(item =>
      condition.field === 'messageLanguage' && typeof item === 'string'
        ? (definitions.languages?.find(language => language.code === item)?.label ?? displayLanguage(item) ?? '语言未确定')
        : field?.type === 'country' && typeof item === 'string'
        ? countryLabel(item)
        : field?.type === 'category' && typeof item === 'string'
          ? (messageCategoryLabels[item as AudienceMessageCategory] ?? item)
          : field?.type === 'script' && typeof item === 'string'
            ? (definitions.scripts?.find(script => script.code === item)?.label ?? item)
            : String(item),
    )
    .join('、')
  return `${field?.label ?? condition.field} ${operatorLabels[condition.operator] ?? '暂不支持的关系'} ${value}`
}

export function AudiencePolicyActiveSummary({ policy }: { policy?: AssistantAudiencePolicy }) {
  const activeRules = policy?.enabled
    ? policy.rules.filter(rule => rule.enabled).sort((a, b) => a.priority - b.priority)
    : []
  return (
    <div aria-label="当前生效观众规则" style={{ flexBasis: '100%', minWidth: 0 }}>
      {!policy ? <p>观众规则尚未读取</p> : (
        <>
          <p>观众规则列表 · 已保存 v{policy.revision} · {policy.enabled ? '已启用' : '已暂停'}</p>
          {activeRules.map(rule => (
            <p key={rule.id} data-active-rule-id={rule.id}>
              {rule.label}：{rule.conditions.map(condition => conditionLabel(condition)).join('，且 ')}
              {' → '}{displayRuleColor(rule.result.cardColor) ? customTierLabels[rule.result.tier] : rule.result.tier === 'gold' ? '金色' : rule.result.tier === 'silver' ? '银色' : '常规'}
              <RuleColorSwatch color={rule.result.cardColor} />
              {' · '}{rule.result.label} · {rule.result.autoAttention ? '自动进入待处理' : '仅标识'}
            </p>
          ))}
          {policy.enabled && !activeRules.length && <p>当前没有生效规则</p>}
          <p>
            {policy.enabled ? '常规：未命中生效规则；未知属性保持未知。' : '观众规则已暂停；当前不按这些规则标记颜色或自动进入待处理。'}
          </p>
        </>
      )}
    </div>
  )
}

export function AudiencePolicyPanel({
  accountId,
  policy,
  request,
  onPolicyLoaded,
}: {
  accountId: string
  policy?: AssistantAudiencePolicy
  request: DeskRequest
  onPolicyLoaded?: (policy: AssistantAudiencePolicy) => void
}) {
  const [loaded, setLoaded] = useState<AssistantAudiencePolicy>()
  const [catalog, setCatalog] = useState<AudiencePolicyCatalog>()
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const current = loaded && loaded.revision >= (policy?.revision ?? 0) ? loaded : policy
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const [editing, setEditing] = useState<{ base: AssistantAudiencePolicy; draft: AssistantAudiencePolicy }>()
  const [saving, setSaving] = useState(false)
  const savePending = useRef(false)
  const [editError, setEditError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')
  const dirty = !!editing && JSON.stringify(editing.draft) !== JSON.stringify(editing.base)
  const beginEdit = () => {
    if (!current || editing) return
    setEditing({ base: structuredClone(current), draft: structuredClone(current) })
    setEditError('')
    setSaveNotice('')
    if (detailsRef.current) detailsRef.current.open = true
  }
  const save = async () => {
    if (!editing || savePending.current || !dirty || audienceRuleDraftError(editing.draft, catalog ?? fallbackPolicyCatalog)) return
    savePending.current = true
    setSaving(true)
    setEditError('')
    try {
      const result = await request({ action: 'policy-save', params: { accountId, expectedRevision: editing.base.revision, policy: editing.draft } })
      if (!result.ok) { setEditError(result.error.message); return }
      const readback = await request({ action: 'policy-get', params: { accountId } })
      if (!readback.ok) { setEditError('保存请求已提交，但未读取到确认版本；草稿已保留，请刷新规则目录核对。'); return }
      const saved = readback.data as AssistantAudiencePolicy
      if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision <= editing.base.revision) {
        setEditError('尚未读取到新的保存版本；草稿已保留，请刷新规则目录核对。'); return
      }
      setLoaded(saved)
      onPolicyLoaded?.(saved)
      setEditing(undefined)
      setSaveNotice(`观众规则已保存 · 已确认 v${saved.revision}`)
    } catch {
      setEditError('观众规则保存失败；草稿已保留，请重试。')
    } finally {
      savePending.current = false
      setSaving(false)
    }
  }
  const load = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      const [rules, fields] = await Promise.all([
        request({ action: 'policy-get', params: { accountId } }),
        request({ action: 'policy-fields', params: { accountId } }),
      ])
      if (rules.ok) {
        const saved = rules.data as AssistantAudiencePolicy
        setLoaded(saved)
        onPolicyLoaded?.(saved)
      }
      else setError(rules.error.message)
      if (fields.ok) setCatalog(fields.data as AudiencePolicyCatalog)
      else setError(fields.error.message)
    } catch {
      setError('观众规则读取失败，请重试')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return (
    <section className="assistant-panel assistant-policy" aria-label="观众规则列表">
      <Button size="sm" variant="outline" disabled={!current || pending || !!editing} onClick={beginEdit}>编辑规则</Button>
      <details
        ref={detailsRef}
        onToggle={event => {
          if (event.currentTarget.open && !catalog) void load()
        }}
      >
        <summary>观众规则列表 · 已保存 v{current?.revision ?? '—'}</summary>
        <p className="assistant-muted">
          {current ? current.enabled ? '已保存规则当前已启用' : '已保存规则当前已暂停' : '观众规则尚未读取'} ·{' '}
          {current?.enabled ? current.rules.filter(rule => rule.enabled).length : 0}{' '}
          条当前生效规则。颜色由命中的已保存规则决定；国家与文字线索单独显示。
        </p>
        <p className="assistant-muted">
          API 版本 {catalog?.version ?? '—'} · 规则版本 {current?.revision ?? '—'}
        </p>
        <p className="assistant-muted">
          点击“编辑规则”，在每条规则的“颜色与处理设置”中选择欢迎特效；保存后生效。
        </p>
        {pending && <p role="status">正在读取观众规则…</p>}
        {error && (
          <p role="alert" className="assistant-error-text">
            {error}
          </p>
        )}
        {saveNotice && <p role="status" className="assistant-muted">{saveNotice}</p>}
        <Button size="sm" variant="outline" disabled={pending || saving} onClick={() => void load()}>
          刷新规则目录
        </Button>
        {editing && <AudiencePolicyRuleEditor
          draft={editing.draft}
          baseRevision={editing.base.revision}
          catalog={catalog ?? fallbackPolicyCatalog}
          dirty={dirty}
          saving={saving}
          conflict={(current?.revision ?? 0) > editing.base.revision}
          error={editError}
          onChange={draft => { setEditing(current => current ? { ...current, draft } : undefined); setEditError('') }}
          onSave={save}
          onCancel={() => { setEditing(undefined); setEditError('') }}
        />}
        <div className="assistant-policy-rules">
          {current?.rules.map(rule => (
            <article key={rule.id} className="assistant-policy-rule" data-rule-id={rule.id}>
              <strong>
                {rule.label} · 已保存 · {rule.enabled ? current.enabled ? '当前生效' : '当前暂停' : '已停用'}
              </strong>
              <p>
                {rule.conditions
                  .map(condition => conditionLabel(condition, catalog))
                  .join('，且 ') || '所有观众'}
              </p>
              <small>
                {(displayRuleColor(rule.result.cardColor) ? customTierLabels : tierLabels)[rule.result.tier]}
                <RuleColorSwatch color={rule.result.cardColor} /> · {rule.result.label} ·{' '}
                {rule.result.autoAttention ? '自动进入待处理' : '仅标识'} · 顺序 {rule.priority}
                {rule.result.welcomePresetId &&
                  ` · 欢迎样式：${OBS_WELCOME_PRESETS.find(preset => preset.id === rule.result.welcomePresetId)?.label ?? rule.result.welcomePresetId}`}
              </small>
            </article>
          ))}
          {!current?.rules.length && (
            <p className="assistant-muted">尚未配置筛选规则。未知属性不会自动匹配数值条件。</p>
          )}
        </div>
        <details className="assistant-policy-catalog">
          <summary>可用属性目录</summary>
          {catalog?.fields.map(field => (
            <p key={field.field}>
              <strong>{field.label}</strong> · {field.source}
              <br />
              <small>
                {field.description} · {field.field}
              </small>
            </p>
          ))}
        </details>
        <details className="assistant-policy-catalog">
          <summary>欢迎样式目录</summary>
          <p>
            在“编辑规则”的“颜色与处理设置”中选择欢迎特效。素材是否可用取决于当前 OBS 场景。
          </p>
          {OBS_WELCOME_PRESETS.map(preset => (
            <p key={preset.id}>
              <strong>{preset.label}</strong> ·{' '}
              {preset.kind === 'html' ? '轻量动画' : '视频素材'}
              <br />
              <small>
                {preset.description} · {preset.id}
              </small>
            </p>
          ))}
        </details>
        <p className="assistant-muted">
          文字线索仅表示证据强度：昵称文字 10，仅本条发言文字 25，昵称与本条发言文字吻合
          50。不是概率，不能确认实际 IP、国籍或居住地；不推断性别。
        </p>
      </details>
    </section>
  )
}

type AttentionWindow = NonNullable<NonNullable<AssistantDeskState['attention']>['window']>
type SelectedBatch = { id: string; from: number; to: number; current: boolean }
export function AttentionWindowPanel({
  accountId,
  window: currentWindow,
  policy,
  request,
  pinnedIds = new Set<string>(),
  busy = false,
}: {
  accountId: string
  window?: AttentionWindow
  policy?: AssistantAudiencePolicy
  request: DeskRequest
  pinnedIds?: Set<string>
  busy?: boolean
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000)
    return () => globalThis.clearInterval(timer)
  }, [])
  const [saving, setSaving] = useState(false)
  const savePending = useRef(false)
  const [saveNotice, setSaveNotice] = useState<{ error: boolean; text: string }>()
  const clockSerial = useRef(0)
  const clockPending = useRef<{ key: string; serial: number } | undefined>(undefined)
  const [clockSaving, setClockSaving] = useState<{ key: string; serial: number }>()
  const [clockNotice, setClockNotice] = useState<{ key: string; error: boolean; text: string }>()
  const clockKey = `${accountId}:${currentWindow?.id ?? ''}`
  const clockOwner = useRef(clockKey)
  clockOwner.current = clockKey
  const clockBusy = clockSaving?.key === clockKey
  const toggleCountdown = async () => {
    if (!currentWindow || currentWindow.active === false || busy || saving || clockPending.current?.key === clockKey) return
    const serial = ++clockSerial.current, key = clockKey
    clockPending.current = { key, serial }
    setClockSaving({ key, serial })
    setClockNotice(undefined)
    try {
      const result = await request({ action: 'attention-countdown', params: { accountId, windowId: currentWindow.id, paused: !currentWindow.paused } })
      if (clockOwner.current !== key) return
      if (result.ok) {
        const confirmed = result.data as AttentionWindow | undefined
        if (confirmed?.id !== currentWindow.id || confirmed.paused !== !currentWindow.paused) {
          setClockNotice({ key, error: true, text: '未能确认倒计时状态，请刷新后重试。' })
          return
        }
      }
      setClockNotice({ key, error: !result.ok, text: result.ok
        ? currentWindow.paused ? '倒计时已继续。' : '本批倒计时已暂停，消息继续采集。'
        : result.error.message })
    } catch {
      if (clockOwner.current === key) setClockNotice({ key, error: true, text: '倒计时设置失败，请重试。' })
    } finally {
      if (clockPending.current?.serial === serial) {
        clockPending.current = undefined
        setClockSaving(undefined)
      }
    }
  }
  const [selected, setSelected] = useState<SelectedBatch>()
  const [items, setItems] = useState<AssistantDeskRow[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [querying, setQuerying] = useState(false)
  const queryPending = useRef(false)
  const [queryError, setQueryError] = useState('')
  const [pinNotice, setPinNotice] = useState<{ error: boolean; text: string }>()
  const pinPending = useRef(new Set<string>())
  const [pinningIds, setPinningIds] = useState(new Set<string>())
  const [reclaimedIds, setReclaimedIds] = useState(new Set<string>())
  useEffect(() => {
    setReclaimedIds(previous => [...previous].some(id => pinnedIds.has(id))
      ? new Set([...previous].filter(id => !pinnedIds.has(id)))
      : previous)
  }, [pinnedIds])
  const queryRevision = useRef(0)
  const availableIds = new Set(currentWindow ? [currentWindow.id, ...currentWindow.archivedWindows.map(batch => batch.id)] : [])
  const scope = useRef({ accountId, availableIds })
  scope.current = { accountId, availableIds }
  useEffect(() => {
    if (!selected || availableIds.has(selected.id)) return
    queryRevision.current++
    queryPending.current = false
    setQuerying(false)
    setSelected(undefined)
    setItems([])
    setNextCursor(undefined)
    setQueryError('')
    setPinNotice(undefined)
    setReclaimedIds(new Set())
  }, [accountId, currentWindow, selected])
  const pin = async (row: AssistantDeskRow) => {
    if (busy || pinPending.current.has(row.id) || pinnedIds.has(row.id) || reclaimedIds.has(row.id)) return
    pinPending.current.add(row.id)
    setPinningIds(new Set(pinPending.current))
    setPinNotice(undefined)
    const batchId = selected?.id
    try {
      const result = await request({ action: 'attention-pin', params: { accountId, rowId: row.id, pinned: true } })
      if (scope.current.accountId !== accountId || !batchId || !scope.current.availableIds.has(batchId)) return
      if (result.ok) {
        setReclaimedIds(previous => new Set([...previous, row.id]))
        setPinNotice({ error: false, text: '已钉住到待处理工作区；本次动作记录会持续保留，评论的中文译文与草稿也会留在工作区。' })
      } else setPinNotice({ error: true, text: result.error.message })
    } catch {
      setPinNotice({ error: true, text: '钉住失败，请重试；存档原文仍保留。' })
    } finally {
      pinPending.current.delete(row.id)
      setPinningIds(new Set(pinPending.current))
    }
  }
  const saveInterval = async (seconds: number) => {
    if (!policy || savePending.current) return
    savePending.current = true
    setSaving(true)
    setSaveNotice(undefined)
    const { revision, ...configuration } = policy
    try {
      const result = await request({
        action: 'policy-save',
        params: {
          accountId,
          expectedRevision: revision,
          policy: { ...configuration, attentionWindowSeconds: seconds },
        },
      })
      setSaveNotice({
        error: !result.ok,
        text: result.ok ? '批次间隔已更新；旧批次仍可查询。' : result.error.message,
      })
    } catch {
      setSaveNotice({ error: true, text: '批次间隔保存失败，请重试' })
    } finally {
      savePending.current = false
      setSaving(false)
    }
  }
  const read = async (batch: SelectedBatch, cursor?: string) => {
    if (queryPending.current) return
    queryPending.current = true
    const revision = ++queryRevision.current
    setQuerying(true)
    setQueryError('')
    setSelected(batch)
    if (!cursor) {
      setItems([])
      setNextCursor(undefined)
    }
    try {
      const result = await request({
        action: 'attention-window',
        params: { accountId, windowId: batch.id, limit: 50, ...(cursor ? { cursor } : {}) },
      })
      if (revision !== queryRevision.current || scope.current.accountId !== accountId || !scope.current.availableIds.has(batch.id)) return
      if (!result.ok) setQueryError(result.error.message)
      else {
        const page = result.data as AssistantDeskPage<AssistantDeskRow>
        setItems(previous =>
          cursor
            ? [...new Map([...previous, ...page.items].map(row => [row.id, row])).values()]
            : page.items,
        )
        setNextCursor(page.nextCursor)
      }
    } catch {
      if (revision === queryRevision.current) setQueryError('待处理批次读取失败，请重试；历史记录仍可查询')
    } finally {
      if (revision === queryRevision.current) {
        queryPending.current = false
        setQuerying(false)
      }
    }
  }
  const remaining = currentWindow ? Math.max(0, Math.ceil((currentWindow.paused ? currentWindow.remainingMs ?? 0 : currentWindow.endsAt - Math.max(now, Date.now())) / 1000)) : 0
  const countdown = `${Math.floor(remaining / 60)
    .toString()
    .padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`
  const progress = currentWindow
    ? Math.max(0, Math.min(1, remaining / currentWindow.intervalSeconds))
    : 0
  const interval = policy?.attentionWindowSeconds ?? 300
  if (!policy && !currentWindow) return null
  return (
    <div className="assistant-attention-window">
      <div className="assistant-window-controls">
        {currentWindow && (
          <button
            type="button"
            className="assistant-window-ring"
            aria-label="当前待处理批次"
            disabled={querying}
            onClick={() =>
              void read({
                id: currentWindow.id,
                from: currentWindow.startedAt,
                to: currentWindow.endsAt,
                current: true,
              })
            }
            title="点击读取本批待处理；批次结束后仍可从归档查询"
          >
            <svg width="48" height="48" viewBox="0 0 40 40" aria-hidden="true">
              <circle
                className="assistant-ring-track"
                cx="20"
                cy="20"
                r="16"
                fill="none"
                strokeWidth="3"
              />
              <circle
                className="assistant-ring-progress"
                cx="20"
                cy="20"
                r="16"
                fill="none"
                strokeWidth="3"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={(1 - progress) * 100}
              />
            </svg>
            <span>
              本批倒计时{currentWindow.paused && '（已暂停）'} <strong>{countdown}</strong>
            </span>
          </button>
        )}
        {currentWindow && currentWindow.active !== false && (
          <Button size="sm" variant="outline" disabled={busy || saving || clockBusy} onClick={() => void toggleCountdown()}>
            {currentWindow.paused ? '继续本批倒计时' : '暂停本批倒计时'}
          </Button>
        )}
        {policy && (
          <label className="assistant-window-interval">
            批次间隔
            <select
              aria-label="批次间隔"
              value={interval}
              disabled={saving}
              onChange={event => void saveInterval(Number(event.target.value))}
            >
              {![60, 300, 600].includes(interval) && (
                <option value={interval}>{interval / 60} 分钟（当前）</option>
              )}
              <option value="60">1 分钟 · 忙碌场次</option>
              <option value="300">5 分钟 · 默认</option>
              <option value="600">10 分钟</option>
            </select>
          </label>
        )}
      </div>
      <p className="assistant-muted">
        {currentWindow?.paused ? '倒计时已暂停，当前待处理保留，新消息仍继续采集。' : '未钉住的待处理动作在批次结束后转入归档。'}钉住会持续保留；稍后处理仅延后提醒。
      </p>
      {clockNotice?.key === clockKey && <p role={clockNotice.error ? 'alert' : 'status'} className={clockNotice.error ? 'assistant-error-text' : 'assistant-muted'}>{clockNotice.text}</p>}
      {saveNotice && (
        <p
          role={saveNotice.error ? 'alert' : 'status'}
          className={saveNotice.error ? 'assistant-error-text' : 'assistant-muted'}
        >
          {saveNotice.text}
        </p>
      )}
      {currentWindow && (
        <details className="assistant-window-archive-fold" aria-label="当前采集归档批次">
          <summary>
            <strong>当前采集归档</strong>
            <span>{currentWindow.archivedWindows.length} 批 · {currentWindow.archivedWindows.reduce((total, batch) => total + batch.total, 0)} 条</span>
            <small>展开快速阅读</small>
          </summary>
          <p className="assistant-muted">仅列本次采集尚未处理的动作。其他采集记录可在历史复盘按场次查询。</p>
          <div className="assistant-window-archives" aria-label="已归档待处理批次">
          {!currentWindow.archivedWindows.length && (
            <span className="assistant-muted">已结束的批次会留在这里供查询。</span>
          )}
          {currentWindow.archivedWindows.map(batch => (
            <Button
              key={batch.id}
              size="sm"
              variant="outline"
              disabled={querying}
              aria-label={`查看归档批次 ${displayTime(batch.from)}，${batch.total} 条`}
              onClick={() =>
                void read({ id: batch.id, from: batch.from, to: batch.to, current: false })
              }
            >
              {displayTime(batch.from)}–{displayTime(batch.to)} · {batch.total} 条
            </Button>
          ))}
          </div>
        </details>
      )}
      {selected && (
        <section className="assistant-window-reader" aria-label="待处理批次存档">
          <div className="assistant-section-heading">
            <strong>
              {selected.id === currentWindow?.id ? '当前批次' : '归档批次'} · {displayTime(selected.from)}–
              {displayTime(selected.to)}
            </strong>
            <Button
              size="sm"
              variant="ghost"
              disabled={querying}
              onClick={() => setSelected(undefined)}
            >
              收起批次
            </Button>
          </div>
          <p className="assistant-muted">
            快速阅读本次采集的待处理动作；需要继续处理时，可钉住到上方队列。已处理事件可在历史复盘查看。
          </p>
          {querying && <p role="status">正在读取待处理批次…</p>}
          {queryError && (
            <p role="alert" className="assistant-error-text">
              {queryError}
            </p>
          )}
          {pinNotice && <p role={pinNotice.error ? 'alert' : 'status'} className={pinNotice.error ? 'assistant-error-text' : 'assistant-muted'}>{pinNotice.text}</p>}
          <Button
            size="sm"
            variant="outline"
            disabled={querying}
            onClick={() => void read(selected)}
          >
            刷新此批次
          </Button>
          <div className="assistant-window-items">
            {items.map(row => (
              <AssistantMessageCard
                key={row.id}
                row={row}
                busy={busy || pinningIds.has(row.id)}
                request={request}
                interactive={false}
                pinned={pinnedIds.has(row.id) || reclaimedIds.has(row.id)}
                archivePin
                onPin={row => void pin(row)}
              />
            ))}
          </div>
          {!querying && !queryError && !items.length && (
            <p className="assistant-muted">本批没有尚未处理的动作，可在历史复盘查看全部事件。</p>
          )}
          {nextCursor && (
            <Button
              size="sm"
              variant="outline"
              disabled={querying}
              onClick={() => void read(selected, nextCursor)}
            >
              加载更多存档
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
