import { randomUUID } from 'node:crypto'
import {
  type CaptureComment,
  type CapturePolicy,
  type CaptureRecord,
  type CaptureRule,
  type CaptureState,
  matchCapture,
  validatePolicy,
} from '../../../shared/commentCatcher'
import { JsonLedger } from './JsonLedger'

interface CaptureData {
  version: 1
  rules: CaptureRule[]
  records: CaptureRecord[]
}
export class CaptureStore {
  private ledger: JsonLedger<CaptureData>
  private recent = new Map<string, CaptureComment>()
  private active: CaptureState['active'] = null
  private error = ''
  constructor(
    file: string,
    private captured: (records: CaptureRecord[]) => void = () => {},
  ) {
    this.ledger = new JsonLedger(file, { version: 1, rules: [], records: [] })
    const d = this.ledger.data
    if (d.version !== 1 || !Array.isArray(d.rules) || !Array.isArray(d.records))
      throw new Error('弹幕捕手数据格式不兼容')
    for (const r of d.rules) validatePolicy(r.policy)
  }
  state(accountId: string): CaptureState {
    return structuredClone({
      rules: this.ledger.data.rules,
      records: this.ledger.data.records.filter(r => r.accountId === accountId),
      active: this.active,
      recentCount: [...this.recent.values()].filter(c => c.accountId === accountId).length,
      error: this.error,
    })
  }
  saveRule(name: string, policy: CapturePolicy) {
    const n = this.name(name)
    const valid = validatePolicy(policy)
    this.ledger.change(d => {
      if (d.rules.length >= 100) throw new Error('最多保存 100 条规则')
      d.rules.push({ id: randomUUID(), name: n, policy: valid, createdAt: Date.now() })
    })
  }
  rename(id: string, name: string) {
    const n = this.name(name)
    this.ledger.change(d => {
      const r = d.rules.find(r => r.id === id)
      if (!r) throw new Error('规则不存在')
      r.name = n
    })
  }
  deleteRule(id: string) {
    if (this.active?.ruleId === id) throw new Error('请先停止捕获再删除规则')
    this.ledger.change(d => {
      d.rules = d.rules.filter(r => r.id !== id)
    })
  }
  private name(name: string) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
      throw new Error('名称需为 1–80 个字符')
    return name.trim()
  }
  start(
    accountId: string,
    ruleId: string,
    dedupe: 'userCode' | 'message',
    batchName: string,
    includeRecent: boolean,
    maxPerUser = 0,
  ) {
    if (
      typeof accountId !== 'string' ||
      !accountId ||
      !this.ledger.data.rules.some(r => r.id === ruleId)
    )
      throw new Error('账号或规则无效')
    if (!['userCode', 'message'].includes(dedupe)) throw new Error('去重模式无效')
    if (this.active) throw new Error('请先停止当前批次')
    if (!Number.isInteger(maxPerUser) || maxPerUser < 0 || maxPerUser > 10000)
      throw new Error('每人上限应为 0–10000')
    this.active = {
      accountId,
      ruleId,
      dedupe,
      batchId: randomUUID(),
      batchName: this.name(batchName),
      maxPerUser,
    }
    this.error = ''
    if (includeRecent)
      this.capture([...this.recent.values()].filter(c => c.accountId === accountId))
  }
  stop() {
    this.active = null
  }
  disconnected(accountId: string) {
    if (this.active?.accountId === accountId) {
      this.stop()
      this.error = '监听已停止，捕获已暂停'
    }
  }
  comment(comment: CaptureComment) {
    if (
      ![
        'comment',
        'xiaohongshu_comment',
        'taobao_comment',
        'wechat_channel_live_msg',
        'tiktok_comment',
      ].includes(comment.msg_type) ||
      comment.is_self ||
      typeof comment.content !== 'string' ||
      !comment.msg_id ||
      comment.content.length > 4000
    )
      return
    const key = JSON.stringify([comment.accountId, comment.msg_type, comment.msg_id])
    if (this.recent.has(key)) return
    this.recent.set(key, structuredClone(comment))
    if (this.recent.size > 5000) this.recent.delete(this.recent.keys().next().value!)
    this.capture([comment])
  }
  private capture(comments: CaptureComment[]) {
    const active = this.active
    if (!active) return
    const rule = this.ledger.data.rules.find(r => r.id === active.ruleId)!
    const records: CaptureRecord[] = []
    const old = this.ledger.data.records.filter(r => r.batchId === active.batchId)
    const seenMessages = new Set(old.map(r => r.messageId))
    const seenUsers = new Set(
      old.filter(r => r.userId).map(r => JSON.stringify([r.userId, r.code])),
    )
    const userCounts = new Map<string, number>()
    for (const r of old) if (r.userId) userCounts.set(r.userId, (userCounts.get(r.userId) ?? 0) + 1)
    for (const c of comments) {
      if (c.accountId !== active.accountId || seenMessages.has(c.msg_id)) continue
      const code = matchCapture(c.content ?? '', rule.policy)
      if (code === null) continue
      const userId = c.user_id || ''
      if (active.maxPerUser && !userId) {
        this.error = '有弹幕缺少用户 ID，无法应用每人限额，已跳过'
        continue
      }
      if (active.maxPerUser && (userCounts.get(userId) ?? 0) >= active.maxPerUser) continue
      const userKey = JSON.stringify([userId, code])
      if (active.dedupe === 'userCode' && userId && seenUsers.has(userKey)) continue
      seenMessages.add(c.msg_id)
      if (userId) seenUsers.add(userKey)
      if (userId) userCounts.set(userId, (userCounts.get(userId) ?? 0) + 1)
      const t =
        Number.isFinite(c.time) && c.time > 0
          ? c.time < 1e12
            ? c.time * 1000
            : c.time
          : Date.now()
      records.push({
        id: randomUUID(),
        batchId: active.batchId,
        batchName: active.batchName,
        ruleId: rule.id,
        ruleName: rule.name,
        accountId: c.accountId,
        messageId: c.msg_id,
        userId,
        nickname: c.nick_name,
        content: c.content!,
        code,
        time: t,
        capturedAt: Date.now(),
      })
    }
    if (!records.length) return
    try {
      this.ledger.change(d => {
        if (d.records.length + records.length > 20000)
          throw new Error('捕获记录已达到 20000 条，已停止捕获，请先归档数据')
        d.records.push(...records)
      })
      this.captured(records)
    } catch (e) {
      this.error = e instanceof Error ? e.message : '保存失败'
      this.stop()
    }
  }
}
