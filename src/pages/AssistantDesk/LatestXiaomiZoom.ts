export interface LatestXiaomiZoomOptions {
  submit: (ratio: number) => Promise<boolean>
  onPending?: (pending: boolean) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => () => void
}
export class LatestXiaomiZoom {
  private next?: number
  private active?: number
  private lastStarted = Number.NEGATIVE_INFINITY
  private cancelTimer?: () => void
  private disposed = false
  private readonly now: () => number
  private readonly schedule: NonNullable<LatestXiaomiZoomOptions['schedule']>
  constructor(private options: LatestXiaomiZoomOptions) {
    this.now = options.now || Date.now
    this.schedule =
      options.schedule ||
      ((run, delay) => {
        const timer = setTimeout(run, delay)
        return () => clearTimeout(timer)
      })
  }

  request(ratio: number): void {
    if (this.disposed || !Number.isFinite(ratio) || ratio < 1 || ratio > 10) return
    if (ratio === this.active) {
      this.next = undefined
      return
    }
    this.next = ratio
    this.options.onPending?.(true)
    this.drain()
  }

  private drain() {
    if (this.disposed || this.active !== undefined || this.cancelTimer || this.next === undefined)
      return
    const remaining = Math.max(0, 300 - (this.now() - this.lastStarted))
    if (remaining) {
      this.cancelTimer = this.schedule(() => {
        this.cancelTimer = undefined
        this.drain()
      }, remaining)
      return
    }
    const ratio = this.next
    this.next = undefined
    this.active = ratio
    this.lastStarted = this.now()
    void this.send(ratio)
  }

  private async send(ratio: number) {
    try {
      if (!(await this.options.submit(ratio))) this.next = undefined
    } catch {
      this.next = undefined
    } finally {
      this.active = undefined
      if (!this.disposed) {
        if (this.next === undefined) this.options.onPending?.(false)
        else this.drain()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.next = undefined
  }
}
