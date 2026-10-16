type Receipt = { key: string; receivedAt: number }
const WINDOW_MS = 10 * 60 * 1000
const MAX_RECEIPTS = 2000

function decimalId(value: unknown): string {
  return typeof value === 'string' && /^[0-9]{1,256}$/.test(value.trim())
    ? value.trim().replace(/^0+/, '')
    : ''
}

/** Action-input gate only. Every provider row is saved by the decoded evidence path first. */
export class TikTokGiftDeliveryGate {
  private recent: Receipt[] = []
  private lastTime: number | undefined

  constructor(private readonly now: () => number = Date.now) {}

  accept(message: TikTokGiftLiveMessage): boolean {
    const receivedAt = this.now()
    if (!Number.isFinite(receivedAt)) {
      this.clear()
      return false
    }
    if (this.lastTime !== undefined && receivedAt < this.lastTime) this.clear()
    this.lastTime = receivedAt
    this.recent = this.recent.filter(receipt => receivedAt - receipt.receivedAt < WINDOW_MS)
    if (message.gift_type !== 1 && message.gift_type !== 2 && message.gift_type !== 4) return false
    if (!Number.isSafeInteger(message.repeat_count) || message.repeat_count <= 0) return false
    if (typeof message.repeat_end !== 'boolean') return false
    const roomId = decimalId(message.room_id)
    const senderId = decimalId(message.user_id)
    const giftId = decimalId(message.gift_id)
    if (!giftId) return false
    let key: string
    if (message.gift_type === 1) {
      const groupId = decimalId(message.group_id)
      if (!message.repeat_end || !roomId || !senderId || !groupId) return false
      // Counts are cumulative snapshots. Deliver the final count, never sum progress frames.
      key = `streak:${roomId}:${senderId}:${giftId}:${groupId}`
    } else {
      const messageId = decimalId(message.msg_id)
      if (!messageId) return false
      key = `message:${roomId}:${messageId}`
    }
    if (this.recent.some(receipt => receipt.key === key)) return false
    this.recent.push({ key, receivedAt })
    if (this.recent.length > MAX_RECEIPTS) this.recent.splice(0, this.recent.length - MAX_RECEIPTS)
    return true
  }

  clear(): void {
    this.recent = []
    this.lastTime = undefined
  }
}
