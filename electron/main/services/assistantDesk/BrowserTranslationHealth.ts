import { randomUUID } from 'node:crypto'
import type { AssistantBrowserTranslationHealth } from '../../../../shared/assistantDesk'

const STALL_MS = 60000
const COMMENT_FRESH_MS = 30000
const ROW_EXPIRY_MS = 120000
const MAX_ROWS = 200

interface HealthRow { receivedAt: number; matched: boolean }

/** A bounded, passive progress check. Only verified native rows and matcher decisions enter it. */
export class BrowserTranslationHealth {
  private rows = new Map<string, HealthRow>()
  private generation?: string
  private startedAt: number
  private unresolvedSince?: number
  private lastCommentAt?: number
  private lastTranslatedAt?: number
  private attentionSince?: number
  private noticeKey?: string

  constructor(private now: () => number) { this.startedAt = now() }

  private prune(now: number) {
    for (const [id, row] of this.rows) if (now - row.receivedAt > ROW_EXPIRY_MS) this.rows.delete(id)
    if (![...this.rows.values()].some(row => !row.matched)) this.unresolvedSince = undefined
  }
  private clearNotice() { this.attentionSince = undefined; this.noticeKey = undefined }
  private reset(now: number) {
    this.rows.clear(); this.startedAt = now; this.unresolvedSince = undefined
    this.lastCommentAt = undefined; this.lastTranslatedAt = undefined; this.clearNotice()
  }
  /** Returns true only when native evidence changed the current capture generation. */
  native(generation: string, rowId: string, original: string, receivedAt: number): boolean {
    const now = this.now()
    if (!generation || generation.length > 512 || !Number.isSafeInteger(receivedAt) || receivedAt > now || now - receivedAt > ROW_EXPIRY_MS) return false
    const changed = this.generation !== undefined && this.generation !== generation
    if (changed) this.reset(now)
    this.generation = generation
    this.prune(now)
    // Han-only, emoji-only, and number-only comments provide no translation-progress evidence.
    if (!/\p{L}/u.test(original.replace(/\p{Script=Han}/gu, '')) || this.rows.has(rowId)) return changed
    if (this.lastCommentAt !== undefined && receivedAt - Math.max(this.lastCommentAt, this.lastTranslatedAt ?? this.lastCommentAt) > COMMENT_FRESH_MS) {
      this.unresolvedSince = now; this.clearNotice()
    }
    this.lastCommentAt = Math.max(this.lastCommentAt ?? receivedAt, receivedAt)
    this.unresolvedSince ??= now
    this.rows.set(rowId, { receivedAt, matched: false })
    while (this.rows.size > MAX_ROWS) this.rows.delete(this.rows.keys().next().value!)
    return changed
  }
  /** Called with actual matcher decisions, never with an arbitrary DOM observation. */
  decision(rowId: string, chinese?: string) {
    const now = this.now(); this.prune(now)
    const row = this.rows.get(rowId)
    if (!row) return
    if (typeof chinese !== 'string' || !chinese.trim() || !/\p{Script=Han}/u.test(chinese)) {
      if (row.matched) { row.matched = false; this.unresolvedSince ??= now }
      return
    }
    if (row.matched) return
    row.matched = true; this.lastTranslatedAt = now; this.clearNotice()
    this.unresolvedSince = [...this.rows.values()].some(value => !value.matched) ? now : undefined
  }
  state(): AssistantBrowserTranslationHealth {
    const now = this.now(); this.prune(now)
    const untranslatedCount = [...this.rows.values()].filter(row => !row.matched).length
    const recent = this.lastCommentAt !== undefined && now - this.lastCommentAt <= COMMENT_FRESH_MS
    const stalled = untranslatedCount >= 3 && recent && this.unresolvedSince !== undefined && now - Math.max(this.startedAt, this.unresolvedSince, this.lastTranslatedAt ?? this.startedAt) >= STALL_MS
    if (stalled) {
      if (!this.noticeKey) { this.attentionSince = now; this.noticeKey = randomUUID() }
    } else this.clearNotice()
    const status = !this.rows.size ? 'inactive' : stalled ? 'attention' : this.lastTranslatedAt !== undefined && (!untranslatedCount || now - this.lastTranslatedAt < STALL_MS) ? 'ok' : 'waiting'
    return { status, checkedAt: now, untranslatedCount, ...(this.lastCommentAt === undefined ? {} : { lastCommentAt: this.lastCommentAt }),
      ...(this.lastTranslatedAt === undefined ? {} : { lastTranslatedAt: this.lastTranslatedAt }),
      ...(this.attentionSince === undefined ? {} : { attentionSince: this.attentionSince, noticeKey: this.noticeKey }) }
  }
}
