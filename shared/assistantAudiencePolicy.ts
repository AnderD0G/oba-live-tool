import type { AssistantDeskAudience, AssistantDeskRow } from './assistantDesk'
import { isWelcomePresetId } from './obsWelcome'
import { ASSISTANT_MESSAGE_LANGUAGES, normalizeMessageLanguage, UNIDENTIFIED_MESSAGE_LANGUAGE } from './assistantLanguageCatalog'

export type AudiencePolicyTier = 'gold' | 'silver' | 'neutral'
export type AudienceMessageCategory = 'greeting' | 'emoji' | 'question' | 'purchase' | 'other'
export type AudiencePolicyField = 'payLevel' | 'fansClubLevel' | 'followerCount' | 'followingCount' | 'followStatus' | 'subscriptionActive' | 'comments' | 'enters' | 'follows' | 'finalGiftGroups' | 'knownGiftCoins' | 'manualCountry' | 'inferredCountry' | 'regionEvidenceScore' | 'textScript' | 'textEvidenceScore' | 'messageCategory' | 'messageLanguage'
export type AudiencePolicyOperator = 'eq' | 'gte' | 'lte' | 'in'
export interface AudiencePolicyCondition { field: AudiencePolicyField; operator: AudiencePolicyOperator; value: number | string | boolean | string[] }
export interface AudiencePolicyRule {
  id: string
  label: string
  enabled: boolean
  priority: number
  conditions: AudiencePolicyCondition[]
  result: { tier: AudiencePolicyTier; label: string; autoAttention: boolean; welcomePresetId?: string; cardColor?: string }
}
export interface AssistantAudiencePolicy { revision: number; enabled: boolean; rules: AudiencePolicyRule[]; attentionWindowSeconds?: number }
export interface ManualAudienceCountryTag { audienceUuid: string; countryCode: string; source: 'manual'; note?: string; revision: number; updatedAt: number }
export interface AudienceCountryTagResult { audienceUuid: string; tag?: ManualAudienceCountryTag; revision: number }
export interface AudienceCountryEvidence { countryCode: string; script: 'Thai' | 'Khmer' | 'Lao' | 'Myanmar'; source: 'nickname-script' | 'comment-script'; strength: 10 | 25 | 50 }
export type AudienceTextScript = AudienceCountryEvidence['script'] | 'Arabic' | 'Hiragana' | 'Katakana' | 'Han' | 'Hangul' | 'Cyrillic' | 'Greek' | 'Hebrew' | 'Devanagari' | 'Bengali' | 'Tamil' | 'Telugu' | 'Latin'
export interface AudienceScriptEvidence { script: AudienceTextScript; source: 'nickname-script' | 'comment-script'; strength: 10 | 25 | 50 }
export interface AudienceTextEvidence { script?: AudienceTextScript; evidenceStrength: number; evidence: AudienceScriptEvidence[]; uncertainties: string[] }
export interface AudienceConditionResult { field: AudiencePolicyField; operator: AudiencePolicyOperator; expected: AudiencePolicyCondition['value']; actual?: number | string | boolean; status: 'match' | 'no-match' | 'unknown'; source?: string }
export interface AssistantAudienceTriage {
  policyRevision: number
  tier: AudiencePolicyTier
  label: string
  autoAttention: boolean
  cardColor?: string
  welcomePresetId?: string
  matchedRuleId?: string
  reasons: string[]
  evaluatedRules: { id: string; matched: boolean; conditions: AudienceConditionResult[] }[]
  messageCategory: AudienceMessageCategory
  country: { code?: string; source: 'manual' | 'script-hint' | 'unknown'; evidenceStrength: number; evidence: AudienceCountryEvidence[]; uncertainties: string[]; manualTag?: ManualAudienceCountryTag; tagRevision: number }
  textEvidence?: AudienceTextEvidence
  facts: Partial<Record<AudiencePolicyField, { value: number | string | boolean; source: string }>>
  attention?: { source: 'manual' | 'reply' | 'policy'; reviewDueAt: number; reviewDue: boolean; deferredUntil?: number; pinRevision?: number }
}
export interface AudiencePolicyInput { row?: AssistantDeskRow; audience?: AssistantDeskAudience; manualTag?: ManualAudienceCountryTag }
export interface AudiencePolicyFieldDefinition { field: AudiencePolicyField; label: string; type: 'number' | 'country' | 'category' | 'boolean' | 'script' | 'language'; operators: AudiencePolicyOperator[]; source: string; description: string }
export interface AudiencePolicyCatalog { version: 1; fields: AudiencePolicyFieldDefinition[]; categories: AudienceMessageCategory[]; countries: { code: string; label: string }[]; scripts?: { code: AudienceTextScript; label: string }[]; languages?: { code: string; label: string }[]; limits: { rules: 20; conditionsPerRule: 10 }; publicFields?: { field: string; label: string; source: string; description: string }[]; unknownFields?: { field: string; label: string; source: string; description: string }[] }

const supportedScripts: { script: AudienceTextScript; label: string; regex: RegExp; countryCode?: string }[] = [
  { script: 'Thai', label: '泰文字', countryCode: 'TH', regex: /[\u0e00-\u0e7f]/ },
  { script: 'Khmer', label: '高棉文字', countryCode: 'KH', regex: /[\u1780-\u17ff\u19e0-\u19ff]/ },
  { script: 'Lao', label: '老挝文字', countryCode: 'LA', regex: /[\u0e80-\u0eff]/ },
  { script: 'Myanmar', label: '缅甸文字', countryCode: 'MM', regex: /[\u1000-\u109f\uaa60-\uaa7f\ua9e0-\ua9ff]/ },
  { script: 'Arabic', label: '阿拉伯文字', regex: /\p{Script=Arabic}/u },
  { script: 'Hiragana', label: '日文平假名', regex: /\p{Script=Hiragana}/u },
  { script: 'Katakana', label: '日文片假名', regex: /\p{Script=Katakana}/u },
  { script: 'Han', label: '汉字（多语言共享）', regex: /\p{Script=Han}/u },
  { script: 'Hangul', label: '韩文字母', regex: /\p{Script=Hangul}/u },
  { script: 'Cyrillic', label: '西里尔字母', regex: /\p{Script=Cyrillic}/u },
  { script: 'Greek', label: '希腊字母', regex: /\p{Script=Greek}/u },
  { script: 'Hebrew', label: '希伯来字母', regex: /\p{Script=Hebrew}/u },
  { script: 'Devanagari', label: '天城文字', regex: /\p{Script=Devanagari}/u },
  { script: 'Bengali', label: '孟加拉文字', regex: /\p{Script=Bengali}/u },
  { script: 'Tamil', label: '泰米尔文字', regex: /\p{Script=Tamil}/u },
  { script: 'Telugu', label: '泰卢固文字', regex: /\p{Script=Telugu}/u },
  { script: 'Latin', label: '拉丁字母', regex: /\p{Script=Latin}/u },
]
export function audienceTextScriptLabel(script: AudienceTextScript): string { return supportedScripts.find(item => item.script === script)?.label ?? script }

const countryCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '))
export function isCountryCode(value: unknown): value is string { return typeof value === 'string' && countryCodes.has(value) }
export function isAudienceCardColor(value: unknown): value is string { return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) }
const categories: AudienceMessageCategory[] = ['greeting', 'emoji', 'question', 'purchase', 'other']
const numericFields = ['payLevel', 'fansClubLevel', 'followerCount', 'followingCount', 'followStatus', 'comments', 'enters', 'follows', 'finalGiftGroups', 'knownGiftCoins', 'regionEvidenceScore', 'textEvidenceScore'] as const
const labels: Record<AudiencePolicyField, string> = { payLevel: '消费等级', fansClubLevel: '粉丝团等级', followerCount: '粉丝数', followingCount: '关注数', followStatus: '平台关注状态码', subscriptionActive: '已观测订阅', comments: '已保存评论数', enters: '已保存进入次数', follows: '已保存关注事件数', finalGiftGroups: '已去重完成礼物组', knownGiftCoins: '已知礼物金币合计', manualCountry: '人工地区标签', inferredCountry: '脚本地域线索', regionEvidenceScore: '地域证据强度', textScript: '文字线索', textEvidenceScore: '文字证据强度', messageCategory: '消息类别', messageLanguage: '发言语言' }
export function audiencePolicyCatalog(): AudiencePolicyCatalog {
  const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
  return { version: 1, categories: [...categories], countries: [...countryCodes].map(code => ({ code, label: names.of(code) ?? code })), scripts: supportedScripts.map(({ script, label }) => ({ code: script, label })), languages: [...ASSISTANT_MESSAGE_LANGUAGES.map(language => ({ ...language })), { code: UNIDENTIFIED_MESSAGE_LANGUAGE, label: '语言未知（有发言）' }], limits: { rules: 20, conditionsPerRule: 10 },
    publicFields: [['userId', '平台用户ID'], ['audienceUuid', '本地稳定观众UUID'], ['mentionHandle', '平台公开账号'], ['avatarUrl', 'SDK头像地址'], ['bio', 'SDK公开简介']].map(([field, label]) => ({ field, label, source: field === 'audienceUuid' ? 'local-stable-identity' : 'normalized-public-metadata', description: field === 'audienceUuid' ? '本工具按已验证的平台 userId 分配并持久保存稳定 UUID；无稳定平台 ID 保持未知，不按昵称合并。' : '仅展示当前SDK已提供并验证的值；缺失保留未知，不请求外部资料。' })),
    unknownFields: [['ip', '实际IP'], ['gender', '性别'], ['age', '年龄'], ['country', '实际国家/国籍']].map(([field, label]) => ({ field, label, source: 'not-provided', description: '当前标准化SDK未提供；不作为规则字段，不通过外部服务补全。' })),
    fields: (Object.keys(labels) as AudiencePolicyField[]).map(field => {
      const type = numericFields.includes(field as typeof numericFields[number]) ? 'number' : field === 'subscriptionActive' ? 'boolean' : field === 'messageCategory' ? 'category' : field === 'textScript' ? 'script' : field === 'messageLanguage' ? 'language' : 'country'
      return { field, label: labels[field], type, operators: type === 'number' ? ['eq', 'gte', 'lte'] : type === 'boolean' ? ['eq'] : ['eq', 'in'],
        source: ['comments', 'enters', 'follows', 'finalGiftGroups', 'knownGiftCoins'].includes(field) ? 'saved-events' : field === 'manualCountry' ? 'manual' : field === 'messageLanguage' ? 'detected-message-language' : ['inferredCountry', 'regionEvidenceScore', 'textScript', 'textEvidenceScore', 'messageCategory'].includes(field) ? 'deterministic-text-rule' : 'normalized-public-metadata',
        description: field === 'messageLanguage' ? '只使用本条评论已记录的语言检测结果；有发言但未检测出语言可匹配语言未知，进入、点赞或空评论不匹配。不从昵称或文字猜测语言，不代表地区。' : field === 'knownGiftCoins' ? '仅累加已知金币；0表示已保存事件中已知合计为0，未知礼物价值未计入，不代表总消费为0。' : field === 'regionEvidenceScore' ? '规则证据强度10/25/50，不是校准概率，不代表IP、国籍或实际居住国家。' : field === 'textScript' ? '昵称或本条评论至少两个受支持的文字字母；多种文字或无证据为UNKNOWN。文字不等于识别语言，不能确定国家、国籍或居住地。' : field === 'textEvidenceScore' ? '文字规则证据强度10/25/50，不是校准概率；多种文字或无证据为UNKNOWN，不能确定国家或居住地。' : field === 'followStatus' ? '只展示平台已提供的正整数状态码，不推断未关注。' : field === 'subscriptionActive' ? '仅已观测true；缺失与false不会变成已知未订阅。' : '只使用已保存或当前事件的已知字段；缺失为UNKNOWN，不按0匹配。' }
    }) }
}
export function defaultAudiencePolicy(): AssistantAudiencePolicy {
  return { revision: 1, enabled: true, attentionWindowSeconds: 300, rules: [{ id: 'baseline-gold', label: '等级与粉丝达到门槛', enabled: true, priority: 100,
    conditions: [{ field: 'payLevel', operator: 'gte', value: 15 }, { field: 'followerCount', operator: 'gte', value: 100 }],
    result: { tier: 'gold', label: '重点观众', autoAttention: true, welcomePresetId: 'gold' } }] }
}
function invalid(): never { throw new Error('筛选策略字段、条件或上限无效') }
function boundedLabel(value: unknown, max = 60): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) }
export function validateAudiencePolicy(raw: unknown, revision: number): AssistantAudiencePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const input = raw as Record<string, any>
  if (Object.keys(input).some(key => !['revision', 'enabled', 'rules', 'attentionWindowSeconds'].includes(key)) || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 20) invalid()
  const seconds = input.attentionWindowSeconds ?? 300
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3600) invalid()
  const definitions = new Map(audiencePolicyCatalog().fields.map(field => [field.field, field]))
  const ids = new Set<string>()
  const rules: AudiencePolicyRule[] = input.rules.map((rule: any) => {
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some(key => !['id', 'label', 'enabled', 'priority', 'conditions', 'result'].includes(key)) || typeof rule.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(rule.id) || ids.has(rule.id) || !boundedLabel(rule.label) || typeof rule.enabled !== 'boolean' || !Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 10000 || !Array.isArray(rule.conditions) || !rule.conditions.length || rule.conditions.length > 10) invalid()
    ids.add(rule.id)
    const conditions = rule.conditions.map((condition: any): AudiencePolicyCondition => {
      if (!condition || typeof condition !== 'object' || Object.keys(condition).some(key => !['field', 'operator', 'value'].includes(key))) invalid()
      const definition = definitions.get(condition.field)
      if (!definition || !definition.operators.includes(condition.operator)) invalid()
      if (definition.type === 'number') { if (!Number.isSafeInteger(condition.value) || condition.value < 0) invalid() }
      else if (definition.type === 'boolean') { if (typeof condition.value !== 'boolean') invalid() }
      else {
        const values = condition.operator === 'in' ? condition.value : [condition.value]
        if (!Array.isArray(values) || !values.length || values.length > 20 || values.some(value => definition.type === 'country' ? !isCountryCode(value) : definition.type === 'script' ? !supportedScripts.some(item => item.script === value) : definition.type === 'language' ? value !== UNIDENTIFIED_MESSAGE_LANGUAGE && !ASSISTANT_MESSAGE_LANGUAGES.some(language => language.code === value) : !categories.includes(value))) invalid()
        if (condition.operator === 'eq' && typeof condition.value !== 'string') invalid()
      }
      return { field: condition.field, operator: condition.operator, value: Array.isArray(condition.value) ? [...condition.value] : condition.value }
    })
    const result = rule.result
    if (!result || typeof result !== 'object' || Object.keys(result).some(key => !['tier', 'label', 'autoAttention', 'welcomePresetId', 'cardColor'].includes(key)) || !['gold', 'silver', 'neutral'].includes(result.tier) || !boundedLabel(result.label) || typeof result.autoAttention !== 'boolean' || (result.welcomePresetId !== undefined && !isWelcomePresetId(result.welcomePresetId)) || (result.cardColor !== undefined && !isAudienceCardColor(result.cardColor))) invalid()
    return { id: rule.id, label: rule.label, enabled: rule.enabled, priority: rule.priority, conditions,
      result: { tier: result.tier, label: result.label, autoAttention: result.autoAttention, ...(result.welcomePresetId === undefined ? {} : { welcomePresetId: result.welcomePresetId }), ...(result.cardColor === undefined ? {} : { cardColor: result.cardColor }) } }
  })
  return { revision, enabled: input.enabled, rules, attentionWindowSeconds: seconds }
}
export function classifyMessageCategory(original: unknown): AudienceMessageCategory {
  const value = typeof original === 'string' ? original.slice(0, 2000).trim().toLocaleLowerCase() : ''
  if (!value) return 'other'
  if (/\b(buy|order|price|shipping|purchase)\b|how\s+much|多少钱|价格|我要买|购买|下单|发货|ราคา|ซื้อ|สั่งซื้อ|តម្លៃ|ទិញ|ລາຄາ|ဝယ်|ราคาเท่าไหร่/.test(value)) return 'purchase'
  if (/[?？]|\b(what|where|when|which|how|can|could)\b|怎么|如何|有没有|多大/.test(value)) return 'question'
  if (/^(hello|hi|hey|hola|bonjour|สวัสดี(?:ครับ|ค่ะ)?|你好|您好|哈喽|សួស្តី|ສະບາຍດີ|မင်္ဂလာပါ)[\s!！,.，。]*$/.test(value)) return 'greeting'
  if (/\p{Extended_Pictographic}/u.test(value) && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s!！,.，。]+$/u.test(value)) return 'emoji'
  return 'other'
}
export function inferTextEvidence(nickname: unknown, original: unknown): AudienceTextEvidence {
  const evidence: AudienceScriptEvidence[] = []
  for (const [source, value] of [['nickname-script', nickname], ['comment-script', original]] as const) {
    if (typeof value !== 'string') continue
    const letters = [...value.slice(0, source === 'nickname-script' ? 100 : 2000)].filter(character => /\p{L}/u.test(character))
    for (const hint of supportedScripts) if (letters.filter(character => hint.regex.test(character)).length >= 2)
      evidence.push({ script: hint.script, source, strength: source === 'nickname-script' ? 10 : evidence.some(existing => existing.source === 'nickname-script' && existing.script === hint.script) ? 50 : 25 })
  }
  const scripts = new Set(evidence.map(item => item.script))
  const uncertainties = evidence.length ? ['script-is-not-language-or-country'] : ['unsupported-or-no-script-evidence']
  if (evidence.length && evidence.every(item => item.source === 'nickname-script')) uncertainties.push('name-only')
  if (scripts.size > 1) uncertainties.push('mixed-scripts')
  return { script: scripts.size === 1 ? [...scripts][0] : undefined, evidenceStrength: scripts.size > 1 ? 0 : Math.max(0, ...evidence.map(item => item.strength)), evidence, uncertainties }
}
function countryEvidenceFromText(textEvidence: AudienceTextEvidence): AssistantAudienceTriage['country'] {
  const evidence: AudienceCountryEvidence[] = textEvidence.evidence.flatMap(item => {
    const hint = supportedScripts.find(hint => hint.script === item.script)
    const script = item.script
    return hint?.countryCode && (script === 'Thai' || script === 'Khmer' || script === 'Lao' || script === 'Myanmar') ? [{ ...item, script, countryCode: hint.countryCode }] : []
  })
  const countries = new Set(evidence.map(value => value.countryCode))
  const uncertainties = evidence.length ? ['language-is-not-country'] : ['unsupported-or-no-script-evidence']
  if (evidence.length && evidence.every(value => value.source === 'nickname-script')) uncertainties.push('name-only')
  if (countries.size > 1) uncertainties.push('conflicting-scripts')
  return { code: countries.size === 1 ? [...countries][0] : undefined, source: countries.size === 1 ? 'script-hint' : 'unknown', evidenceStrength: countries.size > 1 ? 0 : Math.max(0, ...evidence.map(value => value.strength)), evidence, uncertainties, tagRevision: 0 }
}
export function inferCountryEvidence(nickname: unknown, original: unknown): AssistantAudienceTriage['country'] {
  return countryEvidenceFromText(inferTextEvidence(nickname, original))
}
export function evaluateAudiencePolicy(policy: AssistantAudiencePolicy, input: AudiencePolicyInput): AssistantAudienceTriage {
  const { row, audience, manualTag } = input
  const nickname = row?.nickname ?? audience?.nickname
  const original = row?.kind === 'comment' ? row.original : ''
  const textEvidence = inferTextEvidence(nickname, original)
  const inferred = countryEvidenceFromText(textEvidence)
  const country = { ...inferred, uncertainties: [...inferred.uncertainties] }
  if (manualTag && isCountryCode(manualTag.countryCode)) {
    if (country.evidence.some(value => value.countryCode !== manualTag.countryCode)) country.uncertainties.push('manual-evidence-conflict')
    country.code = manualTag.countryCode; country.source = 'manual'; country.manualTag = manualTag; country.tagRevision = manualTag.revision
  }
  const facts: AssistantAudienceTriage['facts'] = {}
  const numeric = (field: AudiencePolicyField, value: unknown, source: string, positive = false) => {
    if (Number.isSafeInteger(value) && (value as number) >= (positive ? 1 : 0)) facts[field] = { value: value as number, source }
  }
  numeric('payLevel', row?.payLevel ?? audience?.payLevel, row?.levelSource?.payLevel ?? 'observed-public-metadata', true)
  numeric('fansClubLevel', row?.fansClubLevel ?? audience?.fansClubLevel, row?.levelSource?.fansClubLevel ?? 'observed-public-metadata', true)
  numeric('followerCount', row?.followerCount ?? audience?.followerCount, row?.followerCountSource ?? 'prior-observed', true)
  for (const field of ['followingCount', 'followStatus'] as const) numeric(field, row?.publicProfile?.[field] ?? audience?.publicProfile?.[field], row?.publicProfileSource ?? 'prior-observed-public-profile', true)
  if ((row?.publicProfile?.subscriptionActive ?? audience?.publicProfile?.subscriptionActive) === true) facts.subscriptionActive = { value: true, source: row?.publicProfileSource ?? 'prior-observed-public-profile' }
  for (const field of ['comments', 'enters', 'follows', 'finalGiftGroups', 'knownGiftCoins'] as const) numeric(field, audience?.[field], field === 'knownGiftCoins' ? 'saved-known-gift-coins-only' : 'saved-events')
  if (manualTag && isCountryCode(manualTag.countryCode)) facts.manualCountry = { value: manualTag.countryCode, source: 'manual' }
  if (inferred.code) facts.inferredCountry = { value: inferred.code, source: 'script-hint-language-not-country' }
  if (inferred.code) facts.regionEvidenceScore = { value: inferred.evidenceStrength, source: 'deterministic-evidence-strength-not-probability' }
  if (textEvidence.script) {
    facts.textScript = { value: textEvidence.script, source: 'deterministic-script-not-language-or-country' }
    facts.textEvidenceScore = { value: textEvidence.evidenceStrength, source: 'deterministic-evidence-strength-not-probability' }
  }
  const messageCategory = row?.kind === 'comment' ? classifyMessageCategory(row.original) : 'other'
  if (row?.kind === 'comment' && row.original.trim()) {
    const messageLanguage = normalizeMessageLanguage(row.translation.language)
    facts.messageLanguage = { value: messageLanguage ?? UNIDENTIFIED_MESSAGE_LANGUAGE, source: messageLanguage ? `${row.translation.source ?? 'recorded'}-detected-message-language` : 'unidentified-comment-language' }
  }
  facts.messageCategory = { value: messageCategory, source: 'bounded-message-cues' }
  const result: AssistantAudienceTriage = { policyRevision: policy.revision, tier: 'neutral', label: '普通观众', autoAttention: false, reasons: [policy.enabled ? '没有命中已启用规则；未知字段不按0匹配' : '筛选策略已暂停'], evaluatedRules: [], messageCategory, country, textEvidence, facts }
  if (!policy.enabled) return result
  for (const rule of policy.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.enabled).sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index).map(value => value.rule)) {
    const conditions: AudienceConditionResult[] = rule.conditions.map(condition => {
      const fact = facts[condition.field]
      const match = fact === undefined ? undefined : condition.operator === 'eq' ? fact.value === condition.value : condition.operator === 'gte' ? typeof fact.value === 'number' && typeof condition.value === 'number' && fact.value >= condition.value : condition.operator === 'lte' ? typeof fact.value === 'number' && typeof condition.value === 'number' && fact.value <= condition.value : condition.operator === 'in' && Array.isArray(condition.value) && typeof fact.value === 'string' ? condition.value.includes(fact.value) : false
      return { field: condition.field, operator: condition.operator, expected: condition.value, actual: fact?.value, source: fact?.source, status: match === undefined ? 'unknown' : match ? 'match' : 'no-match' }
    })
    const matched = conditions.every(condition => condition.status === 'match')
    result.evaluatedRules.push({ id: rule.id, matched, conditions })
    if (matched) {
      const { cardColor, ...ruleResult } = rule.result
      Object.assign(result, ruleResult, isAudienceCardColor(cardColor) ? { cardColor } : {}, { matchedRuleId: rule.id, reasons: [`命中规则：${rule.label}`] }); break
    }
  }
  return result
}
