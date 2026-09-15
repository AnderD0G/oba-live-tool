export interface CapturePolicy {
  kind: 'digits' | 'containsDigits' | 'equals' | 'contains' | 'prefix'
  chineseDigits: boolean
  fullWidthDigits: boolean
  trim: boolean
  ignoreSpaces: boolean
  minLength: number
  maxLength: number
  terms: string[]
  maxPerUser?: number
}
export interface CaptureRule {
  id: string
  name: string
  policy: CapturePolicy
  createdAt: number
}
export interface CaptureComment {
  accountId: string
  msg_id: string
  msg_type: string
  nick_name: string
  user_id?: string
  content?: string
  time: number
  is_self?: boolean
}
export interface CaptureRecord {
  id: string
  batchId: string
  batchName: string
  ruleId: string
  ruleName: string
  accountId: string
  messageId: string
  userId: string
  nickname: string
  content: string
  code: string
  time: number
  capturedAt: number
}
export interface CaptureState {
  rules: CaptureRule[]
  records: CaptureRecord[]
  active: {
    accountId: string
    ruleId: string
    dedupe: 'userCode' | 'message'
    batchId: string
    batchName: string
    maxPerUser: number
  } | null
  recentCount: number
  error: string
}
export interface RuleTurn {
  role: 'user' | 'assistant'
  text: string
}
export interface RuleDraft {
  id: string
  message: string
  policy?: CapturePolicy
}
export type CatcherCommand =
  | { action: 'cancel' }
  | { action: 'state'; accountId: string }
  | { action: 'discuss'; turns: RuleTurn[] }
  | { action: 'preset' }
  | { action: 'confirm'; draftId: string; name: string }
  | { action: 'rename'; ruleId: string; name: string }
  | { action: 'delete'; ruleId: string }
  | {
      action: 'start'
      accountId: string
      ruleId: string
      dedupe: 'userCode' | 'message'
      batchName: string
      includeRecent: boolean
      maxPerUser: number
    }
  | { action: 'stop' }
export type CatcherResponse =
  | { ok: true; state?: CaptureState; draft?: RuleDraft }
  | { ok: false; error: string }
export const digitPreset: CapturePolicy = {
  kind: 'digits',
  chineseDigits: true,
  fullWidthDigits: true,
  trim: true,
  ignoreSpaces: false,
  minLength: 1,
  maxLength: 32,
  terms: [],
}
export function validatePolicy(value: unknown): CapturePolicy {
  if (!value || typeof value !== 'object') throw new Error('规则必须是结构化对象')
  const p = value as CapturePolicy
  const keys = [
    'kind',
    'chineseDigits',
    'fullWidthDigits',
    'trim',
    'ignoreSpaces',
    'minLength',
    'maxLength',
    'terms',
    'maxPerUser',
  ]
  if (
    p.maxPerUser !== undefined &&
    (!Number.isInteger(p.maxPerUser) || p.maxPerUser < 0 || p.maxPerUser > 10000)
  )
    throw new Error('每人上限应为 0–10000')
  if (Object.keys(p).some(k => !keys.includes(k))) throw new Error('规则包含不支持的字段')
  if (!['digits', 'containsDigits', 'equals', 'contains', 'prefix'].includes(p.kind))
    throw new Error('不支持的规则类型')
  for (const key of ['chineseDigits', 'fullWidthDigits', 'trim', 'ignoreSpaces'] as const)
    if (typeof p[key] !== 'boolean') throw new Error('规则选项必须明确为是或否')
  if (
    !Number.isInteger(p.minLength) ||
    !Number.isInteger(p.maxLength) ||
    p.minLength < 1 ||
    p.maxLength > 200 ||
    p.minLength > p.maxLength
  )
    throw new Error('长度范围必须在 1–200 之间')
  if (
    !Array.isArray(p.terms) ||
    p.terms.length > 50 ||
    p.terms.some(t => typeof t !== 'string' || !t.trim() || t.length > 100)
  )
    throw new Error('关键词不合法')
  if (!['digits', 'containsDigits'].includes(p.kind) && !p.terms.length)
    throw new Error('请指定匹配词')
  if (['digits', 'containsDigits'].includes(p.kind) && p.terms.length)
    throw new Error('数字规则不接受关键词条件')
  return structuredClone(p)
}
export function normalizeCaptureText(text: string, p: CapturePolicy): string {
  let v = text
  if (p.fullWidthDigits) v = v.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10))
  if (p.chineseDigits)
    v = v.replace(
      /[零〇一二三四五六七八九]/g,
      c =>
        ({
          零: '0',
          〇: '0',
          一: '1',
          二: '2',
          三: '3',
          四: '4',
          五: '5',
          六: '6',
          七: '7',
          八: '8',
          九: '9',
        })[c]!,
    )
  if (p.trim) v = v.trim()
  if (p.ignoreSpaces) v = v.replace(/\s/g, '')
  return v
}
export function matchCapture(text: string, p: CapturePolicy): string | null {
  if (typeof text !== 'string' || text.length > 4000) return null
  const v = normalizeCaptureText(text, p)
  let code: string | undefined
  if (p.kind === 'digits') code = /^[0-9]+$/.test(v) ? v : undefined
  else if (p.kind === 'containsDigits') code = v.match(/[0-9]+/)?.[0]
  else {
    const terms = p.terms.map(t => normalizeCaptureText(t, p))
    if (
      terms.some(t =>
        p.kind === 'equals' ? v === t : p.kind === 'prefix' ? v.startsWith(t) : v.includes(t),
      )
    )
      code = v
  }
  return code && code.length >= p.minLength && code.length <= p.maxLength ? code : null
}
export function describePolicy(p: CapturePolicy): string {
  const kind = {
    digits: '整条弹幕只能由数字组成',
    containsDigits: '弹幕中包含数字，提取第一段连续数字',
    equals: '整条弹幕等于任一指定词',
    contains: '弹幕包含任一指定词',
    prefix: '弹幕以任一指定词开头',
  }[p.kind]
  return [
    kind,
    p.terms.length ? `匹配词：${p.terms.join('、')}` : '',
    p.chineseDigits ? '零〇一二三四五六七八九按位转换为 0–9（不含十、百、两）' : '不转换中文数字',
    p.fullWidthDigits ? '全角数字转换为半角' : '不转换全角数字',
    p.trim ? '忽略首尾空白' : '保留首尾空白',
    p.ignoreSpaces ? '忽略内部空白' : '保留内部空白',
    `捕获内容长度 ${p.minLength}–${p.maxLength}；保留前导零，区分字母大小写`,
    p.maxPerUser ? `默认每位观众每批次最多 ${p.maxPerUser} 张扣号单` : '默认每位观众出单数量不限',
  ]
    .filter(Boolean)
    .join('；')
}
