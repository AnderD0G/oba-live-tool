import { join } from 'node:path'
import { app } from 'electron'
import { JsonLedger } from './JsonLedger'

export type TikTokViewer = {
  userId: string
  uniqueId: string
  nickname: string
  firstSeen: number
  lastSeen: number
  entryCount: number
  commentCount: number
  fansClubLevel?: number
  payLevel?: number
  subscriber?: boolean
  followStatus?: string
  language?: string
}

export class TikTokViewerStore {
  private ledger = new JsonLedger<Record<string, Record<string, TikTokViewer>>>(
    join(app.getPath('userData'), 'tiktok-viewers.json'),
    {},
  )
  private pending = new Map<string, TikTokViewer>()
  private timer?: ReturnType<typeof setTimeout>

  observe(accountId: string, message: TikTokMemberLiveMessage | TikTokCommentLiveMessage) {
    const userId = message.user_id || message.unique_id
    if (!userId || !accountId) return
    const key = JSON.stringify([accountId, userId])
    const prior = this.pending.get(key) || this.ledger.data[accountId]?.[userId]
    const now = Date.now()
    const next: TikTokViewer = {
      userId,
      uniqueId: message.unique_id,
      nickname: message.nick_name,
      firstSeen: prior?.firstSeen || now,
      lastSeen: now,
      entryCount: (prior?.entryCount || 0) + (message.msg_type === 'tiktok_member' ? 1 : 0),
      commentCount: (prior?.commentCount || 0) + (message.msg_type === 'tiktok_comment' ? 1 : 0),
      fansClubLevel:
        message.msg_type === 'tiktok_member' ? message.fans_club_level : prior?.fansClubLevel,
      payLevel: message.msg_type === 'tiktok_member' ? message.pay_level : prior?.payLevel,
      subscriber: message.msg_type === 'tiktok_member' ? message.is_subscriber : prior?.subscriber,
      followStatus:
        message.msg_type === 'tiktok_member' ? message.follow_status : prior?.followStatus,
      language: prior?.language,
    }
    this.pending.set(key, next)
    this.timer ??= setTimeout(() => this.flush(), 2000)
  }

  setLanguage(accountId: string, userId: string, language: string) {
    if (!userId || !/^[a-zA-Z-]{2,40}$/.test(language)) return
    const key = JSON.stringify([accountId, userId])
    const prior = this.pending.get(key) || this.ledger.data[accountId]?.[userId]
    if (!prior || prior.language === language) return
    this.pending.set(key, { ...prior, language })
    this.timer ??= setTimeout(() => this.flush(), 2000)
  }

  count(accountId: string) {
    return Object.keys(this.ledger.data[accountId] || {}).length
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending.size) return
    const entries = [...this.pending]
    this.pending.clear()
    this.ledger.change(data => {
      for (const [key, viewer] of entries) {
        const [accountId] = JSON.parse(key) as [string, string]
        data[accountId] ??= {}
        data[accountId][viewer.userId] = viewer
      }
    })
  }
}
