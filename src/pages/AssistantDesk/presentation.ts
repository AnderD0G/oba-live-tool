import type { AssistantDeskRow } from '../../../shared/assistantDesk'
import { normalizeAssistantHistoryHandle, normalizeAssistantHistoryNickname } from '../../../shared/assistantHistoryIdentity'
import { ASSISTANT_MESSAGE_LANGUAGES, normalizeMessageLanguage } from '../../../shared/assistantLanguageCatalog'

const languageNames = new Intl.DisplayNames(['zh-CN'], { type: 'language', fallback: 'none' })
// Polling rerenders many cards. Date.toLocale* constructs a locale formatter per
// call; these equivalent formats can be reused across the entire desktop view.
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false })
const fullTimeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false })

export function displayLanguage(language?: string) {
  if (!language || ['und', 'unknown', 'auto', 'mul', 'zxx'].includes(language.toLowerCase())) return undefined
  const known = normalizeMessageLanguage(language)
  if (known) return ASSISTANT_MESSAGE_LANGUAGES.find(item => item.code === known)?.label
  try {
    return languageNames.of(language)
  } catch {
    return undefined
  }
}

export function displayRuleColor(color?: string) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined
}

export function needsReplyAttention(row: AssistantDeskRow) {
  return (
    !['sent', 'dismissed'].includes(row.reply.status) &&
    ((row.kind === 'comment' && ['queued', 'generating', 'review', 'sending', 'failed', 'interrupted'].includes(row.reply.status)) ||
      !!row.triage?.attention || !!row.triage?.autoAttention)
  )
}

export const assistantKindLabels: Record<AssistantDeskRow['kind'], string> = {
  comment: '发言', enter: '进场', like: '点赞', follow: '关注', gift: '送礼', leave: '离场', event: '其他事件',
}
const factLabels = {
  like: { icon: '❤️', label: '点赞' },
  follow: { icon: '➕', label: '关注' },
  enter: { icon: '👋', label: assistantKindLabels.enter },
  leave: { icon: '🚪', label: assistantKindLabels.leave },
  gift: { icon: '🎁', label: assistantKindLabels.gift },
  event: { icon: '📍', label: assistantKindLabels.event },
}
const knownFactNumber = (value?: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

export function actionEventFact(row: AssistantDeskRow) {
  if (row.kind === 'comment') return undefined
  const fact = factLabels[row.kind]
  const count = row.kind === 'like' ? knownFactNumber(row.likeCount) : row.kind === 'gift' ? knownFactNumber(row.gift?.count) : undefined
  const coins = row.kind === 'gift' ? knownFactNumber(row.gift?.totalCoins) : undefined
  return {
    ...fact,
    label: row.kind === 'gift' ? `送礼 · ${row.gift?.name?.trim() || '名称未知'}` : fact.label,
    count: row.kind === 'like' || row.kind === 'gift'
      ? count === undefined ? row.kind === 'like' ? '次数未知' : '数量未知' : `×${count}`
      : undefined,
    coins: row.kind === 'gift' ? coins === undefined ? '总金币未知' : `总金币 ${coins}` : undefined,
  }
}

export function paymentTier(level?: number): 'gold' | 'silver' | 'neutral' {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0) return 'neutral'
  return level >= 10 ? 'gold' : 'silver'
}

export interface HistoryFilterDraft {
  sessionId: string
  audienceUuid: string
  userId: string
  mentionHandle?: string
  nickname?: string
  from: string
  to: string
  minPayLevel: string
}

export function buildHistoryFilter(filter: HistoryFilterDraft) {
  const result: {
    sessionId?: string
    audienceUuid?: string
    userId?: string
    mentionHandle?: string
    nickname?: string
    from?: number
    to?: number
    minPayLevel?: number
  } = {}
  for (const key of ['sessionId', 'audienceUuid', 'userId'] as const)
    if (filter[key].trim()) result[key] = filter[key].trim()
  if (filter.mentionHandle?.trim()) {
    const handle = normalizeAssistantHistoryHandle(filter.mentionHandle)
    if (!handle) throw new Error('请填写有效的完整用户名，最多100字，可带一个@')
    result.mentionHandle = handle
  }
  if (filter.nickname?.trim()) {
    const nickname = normalizeAssistantHistoryNickname(filter.nickname)
    if (!nickname) throw new Error('请填写完整昵称，最多100字')
    result.nickname = nickname
  }
  for (const key of ['from', 'to'] as const) {
    if (!filter[key]) continue
    const time = new Date(filter[key]).getTime()
    if (!Number.isFinite(time)) throw new Error('请填写有效的时间')
    result[key] = time
  }
  if (result.from !== undefined && result.to !== undefined && result.from > result.to)
    throw new Error('开始时间不能晚于结束时间')
  if (filter.minPayLevel.trim()) {
    const level = Number(filter.minPayLevel)
    if (!Number.isSafeInteger(level) || level < 0) throw new Error('最低消费等级必须是非负整数')
    result.minPayLevel = level
  }
  return result
}

export function displayTime(time?: number, full = false) {
  if (time === undefined || !Number.isFinite(time)) return '未知时间'
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return 'Invalid Date'
  return (full ? fullTimeFormat : timeFormat).format(date)
}

export function displayDuration(from: number, to?: number) {
  const seconds = Math.max(0, Math.floor(((to ?? Date.now()) - from) / 1000))
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}
