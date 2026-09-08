import { randomUUID } from 'node:crypto'
import type {
  CodexAutoRecord,
  CodexAutoSettings,
  CodexAutoState,
} from '../../../shared/codexAutoReply'
import type {
  CodexDraftProgress,
  CodexDraftRequest,
  CodexDraftResult,
} from '../../../shared/codexDraft'

interface Comment {
  msg_id: string
  msg_type: string
  nick_name: string
  content?: string
  user_id?: string
  is_self?: boolean
}
interface Dependencies {
  ready: (accountId: string) => boolean
  hostName: (accountId: string) => string
  busy: () => boolean
  generate: (
    request: CodexDraftRequest,
    progress: (event: CodexDraftProgress) => void,
  ) => Promise<CodexDraftResult>
  cancel: () => void
  send: (accountId: string, text: string, signal: AbortSignal) => Promise<boolean>
  changed: (state: CodexAutoState) => void
  intervalMs?: number
}

/** An enabled session owns a serial queue. Turning it off invalidates all late results. */
export class CodexAutoReplyService {
  private state: CodexAutoState = {
    enabled: false,
    accountId: null,
    message: '未开启',
    records: [],
  }
  private settings?: CodexAutoSettings
  private epoch = 0
  private queue: Array<{ record: CodexAutoRecord; received: number }> = []
  private seen = new Set<string>()
  private ownUsers = new Set<string>()
  private ownTexts = new Map<string, number>()
  private processing = false
  private nextSend = 0
  private controller?: AbortController
  private wake?: () => void
  constructor(private deps: Dependencies) {}
  snapshot(): CodexAutoState {
    return structuredClone(this.state)
  }
  private emit() {
    this.deps.changed(this.snapshot())
  }

  enable(settings: CodexAutoSettings) {
    if (this.state.enabled) throw new Error('请先关闭当前 Codex 自动回复')
    if (!this.deps.ready(settings.accountId)) throw new Error('请先连接小红书千帆并开始监听')
    this.settings = { ...settings }
    this.epoch++
    this.state.enabled = true
    this.state.accountId = settings.accountId
    this.state.message = '已开启：等待新评论，生成完成后自动发送'
    this.emit()
  }

  disable(reason = '已关闭；待处理评论已取消') {
    this.epoch++
    this.state.enabled = false
    this.state.message = reason
    this.controller?.abort()
    this.deps.cancel()
    this.wake?.()
    for (const { record } of this.queue) {
      record.phase = 'cancelled'
      record.detail = '自动回复已关闭'
    }
    this.queue = []
    this.emit()
  }

  disconnected(accountId: string) {
    if (this.state.enabled && this.state.accountId === accountId)
      this.disable('连接或监听已停止，自动回复已关闭')
  }

  comment(accountId: string, comment: Comment) {
    const key = `${accountId}:${comment.msg_id}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 3000) this.seen.delete(this.seen.values().next().value as string)
    if (comment.is_self && comment.user_id) this.ownUsers.add(`${accountId}:${comment.user_id}`)
    const text = comment.content?.trim()
    if (
      !this.state.enabled ||
      this.state.accountId !== accountId ||
      comment.msg_type !== 'xiaohongshu_comment' ||
      !text
    )
      return
    if (!this.deps.ready(accountId)) {
      this.disconnected(accountId)
      return
    }
    const ownKey = `${accountId}:${text}`
    if (
      comment.is_self ||
      comment.nick_name === this.deps.hostName(accountId) ||
      this.ownUsers.has(`${accountId}:${comment.user_id}`) ||
      (this.ownTexts.get(ownKey) ?? 0) > Date.now() ||
      this.settings?.blockList?.includes(comment.nick_name)
    )
      return
    const record: CodexAutoRecord = {
      id: comment.msg_id,
      accountId,
      nickname: comment.nick_name,
      comment: text,
      text: '',
      phase: 'queued',
      detail: '排队等待',
    }
    this.state.records = [record, ...this.state.records].slice(0, 50)
    if (this.queue.length >= 10) {
      record.phase = 'skipped'
      record.detail = '待处理评论已满，请稍后再试'
    } else this.queue.push({ record, received: Date.now() })
    this.emit()
    void this.pump()
  }

  private async delay(ms: number) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, ms)
      const self = this
      function done() {
        clearTimeout(timer)
        if (self.wake === done) self.wake = undefined
        resolve()
      }
      this.wake = done
    })
  }

  private async pump() {
    if (this.processing) return
    this.processing = true
    try {
      while (this.state.enabled && this.queue.length) {
        const epoch = this.epoch
        const { record, received } = this.queue[0]
        if (!this.deps.ready(record.accountId)) {
          this.disconnected(record.accountId)
          break
        }
        if (Date.now() - received > 60000) {
          this.queue.shift()
          record.phase = 'skipped'
          record.detail = '等待超过一分钟，已跳过'
          this.emit()
          continue
        }
        if (this.deps.busy() || Date.now() < this.nextSend) {
          await this.delay(250)
          continue
        }
        const settings = this.settings
        if (!settings) {
          this.disable('回复设置不可用，请重新开启')
          break
        }
        this.queue.shift()
        this.controller = new AbortController()
        const signal = this.controller.signal
        const current = () =>
          this.state.enabled &&
          this.epoch === epoch &&
          !signal.aborted &&
          this.deps.ready(record.accountId)
        try {
          record.phase = 'generating'
          record.detail = 'Codex 正在生成'
          this.emit()
          const result = await this.deps.generate(
            {
              requestId: randomUUID(),
              comment: record.comment,
              instructions: `${settings.instructions}\n本条将自动发送到直播间，请只回复正文，控制在60字以内。`,
              model: settings.model,
            },
            event => {
              if (current()) {
                record.detail = event.message
                if (event.text !== undefined) record.text = event.text
                this.emit()
              }
            },
          )
          if (!current()) {
            record.phase = 'cancelled'
            record.detail = '已取消发送'
            continue
          }
          if (!result.ok) throw new Error(result.error)
          record.text = result.text.trim()
          if (!record.text || [...record.text].length > 100)
            throw new Error('草稿为空或超过100字，已暂停自动发送')
          record.phase = 'sending'
          record.detail = '正在发送，等待平台确认'
          this.emit()
          this.ownTexts.set(`${record.accountId}:${record.text}`, Date.now() + 120000)
          for (const [key, until] of this.ownTexts)
            if (until < Date.now()) this.ownTexts.delete(key)
          const confirmed = await this.deps.send(record.accountId, record.text, signal)
          if (!confirmed) throw new Error('平台未确认发送结果，请检查直播间；不会自动重发')
          record.phase = 'sent'
          record.detail = '平台已确认发送'
          this.nextSend = Date.now() + (this.deps.intervalMs ?? 5000)
        } catch (error) {
          record.phase = signal.aborted ? 'cancelled' : 'failed'
          record.detail = signal.aborted
            ? '已关闭；若已提交，请查看直播间'
            : error instanceof Error
              ? error.message
              : '回复失败'
          if (this.epoch === epoch && this.state.enabled) this.disable(record.detail)
        } finally {
          this.controller = undefined
          this.emit()
        }
      }
    } finally {
      this.processing = false
    }
  }
}
