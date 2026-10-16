type Source = 'sdk' | 'webpage'
type Receipt = {
  source: Source
  messageId: string
  stableId: string
  handle: string
  content: string
  receivedAt: number
  paired: boolean
}

const WINDOW_MS = 2000
const MAX_RECEIPTS = 1000

/**
 * Reply-input gate only: callers publish raw evidence before consulting this gate.
 * Unknown identity is never matched by nickname; identical text alone cannot prove duplication.
 */
export class TikTokCommentDeliveryGate {
  private recent: Receipt[] = []
  private lastTime: number | undefined

  constructor(private readonly now: () => number = Date.now) {}

  accept(source: Source, message: TikTokCommentLiveMessage): boolean {
    const receivedAt = this.now()
    if (!Number.isFinite(receivedAt)) {
      this.clear()
      return true
    }
    if (this.lastTime !== undefined && receivedAt < this.lastTime) this.clear()
    this.lastTime = receivedAt
    this.recent = this.recent.filter(receipt => receivedAt - receipt.receivedAt < WINDOW_MS)

    const rawMessageId = message.msg_id.trim()
    const messageId = /^0*$/.test(rawMessageId) ? '' : rawMessageId
    if (
      messageId &&
      this.recent.some(receipt => receipt.source === source && receipt.messageId === messageId)
    )
      return false

    // user_id is a protocol decimal ID. unique_id can be a nickname/handle fallback, so ignore it.
    const rawStableId = message.user_id.trim()
    const stableId = /^\d+$/.test(rawStableId) ? rawStableId.replace(/^0+/, '') : ''
    const rawHandle = message.mention_handle?.trim() ?? ''
    const handle = /^@(?=.*[A-Za-z_])[A-Za-z0-9._]{2,24}$/.test(rawHandle)
      ? rawHandle.toLowerCase()
      : ''
    const incoming: Receipt = {
      source,
      messageId,
      stableId,
      handle,
      content: message.content.trim(),
      receivedAt,
      paired: false,
    }
    const counterpart = incoming.content
      ? this.recent.find(
          receipt =>
            receipt.source !== source &&
            !receipt.paired &&
            receipt.content === incoming.content &&
            this.sameIdentity(receipt, incoming),
        )
      : undefined
    if (counterpart) {
      counterpart.paired = true
      incoming.paired = true
    }
    // Retain both paired receipts so retransmissions cannot consume another cross-source message.
    this.recent.push(incoming)
    if (this.recent.length > MAX_RECEIPTS) this.recent.splice(0, this.recent.length - MAX_RECEIPTS)
    return !counterpart
  }

  private sameIdentity(left: Receipt, right: Receipt): boolean {
    if (left.stableId && right.stableId && left.stableId !== right.stableId) return false
    if (left.handle && right.handle && left.handle !== right.handle) return false
    return Boolean(
      (left.stableId && left.stableId === right.stableId) ||
        (left.handle && left.handle === right.handle),
    )
  }

  clear(): void {
    this.recent = []
    this.lastTime = undefined
  }
}
