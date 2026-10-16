const RETENTION_MS = 180000
const MAX_RECEIPTS = 4096

/** Consumer gate only: every verified transport retains its original before this gate. */
export class TikTokNativeDeliveryGate {
  private receipts = new Map<string, number>()
  private lastTime: number | undefined

  constructor(private readonly now: () => number = Date.now) {}

  accept(roomId: string | null | undefined, kind: string, messageId: string): boolean {
    if (typeof roomId !== 'string' || !/^[1-9]\d{7,19}$/.test(roomId)) return false
    // No native ID means no proof of duplication. Never pair by translated name/text.
    if (typeof messageId !== 'string' || !/^\d{1,256}$/.test(messageId) || /^0+$/.test(messageId)) return true
    const receivedAt = this.now()
    if (!Number.isFinite(receivedAt)) { this.clear(); return true }
    if (this.lastTime !== undefined && receivedAt < this.lastTime) this.clear()
    this.lastTime = receivedAt
    for (const [key, at] of this.receipts) {
      if (receivedAt - at < RETENTION_MS) break
      this.receipts.delete(key)
    }
    const key = `${roomId}:${kind}:${messageId.replace(/^0+/, '')}`
    if (this.receipts.has(key)) return false
    this.receipts.set(key, receivedAt)
    if (this.receipts.size > MAX_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!)
    return true
  }

  clear() { this.receipts.clear(); this.lastTime = undefined }
}
