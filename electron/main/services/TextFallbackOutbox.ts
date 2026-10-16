/** Callers may extend this with account, viewer and trace metadata for their sender. */
export interface TextFallbackMessage {
  traceKey: string
  text: string
  /** Absolute deadline in milliseconds. */
  expiresAt: number
}

export type TextFallbackSendResult =
  | { status: 'sent' }
  /** Explicit confirmation that nothing was sent and retrying is safe. */
  | { status: 'retryable'; reason?: string }
  | { status: 'failed' | 'unknown'; reason?: string }

export type TextFallbackFailureReason =
  | 'expired' | 'overflow' | 'stopped' | 'invalid'
  | 'failed' | 'unknown' | 'retries-exhausted'

export interface TextFallbackOutboxOptions<T extends TextFallbackMessage = TextFallbackMessage> {
  sender: (message: T, signal: AbortSignal) => Promise<TextFallbackSendResult>
  /** Milliseconds until sending is allowed. Rechecked before every attempt. */
  throttle?: (message: T) => number
  onSuccess?: (message: T) => void
  onFailure: (message: T, reason: TextFallbackFailureReason, detail?: string) => void
  /** Includes the active send. Default 32, maximum 1024. */
  capacity?: number
  /** Additional attempts after an explicit safe failure. Default 2, maximum 5. */
  maxRetries?: number
  retryDelayMs?: number
  /** Retained terminal trace keys; default 1024. Active keys are always retained. */
  dedupCapacity?: number
  now?: () => number
}

interface Entry<T> {
  message: T
  attempts: number
  retryAt: number
  terminal: boolean
  controller: AbortController
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
}

/**
 * FIFO fallback delivery with bounded memory and explicit outcomes. Exceptions and
 * timed-out in-flight sends have unknown delivery and are never automatically retried.
 * A sender ignoring abort retains the serialization lock until it settles; queued
 * deadlines still fire. This prevents overlapping potentially successful sends.
 */
export class TextFallbackOutbox<T extends TextFallbackMessage = TextFallbackMessage> {
  private queue: Entry<T>[] = []
  private active?: Entry<T>
  private terminalKeys = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private pumping = false
  private readonly capacity: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly dedupCapacity: number
  private readonly now: () => number

  constructor(private readonly options: TextFallbackOutboxOptions<T>) {
    this.capacity = bounded(options.capacity, 32, 1, 1024)
    this.maxRetries = bounded(options.maxRetries, 2, 0, 5)
    this.retryDelayMs = bounded(options.retryDelayMs, 500, 1, 60000)
    this.dedupCapacity = bounded(options.dedupCapacity, 1024, 1, 10000)
    this.now = options.now ?? (() => Date.now())
  }

  /** False means duplicate or rejected; rejections are reported to onFailure. */
  enqueue(message: T): boolean {
    if (this.terminalKeys.has(message.traceKey) || this.active?.message.traceKey === message.traceKey ||
        this.queue.some(entry => entry.message.traceKey === message.traceKey)) return false
    const reason = this.stopped ? 'stopped'
      : !message.traceKey || !message.text.trim() || !Number.isFinite(message.expiresAt) ? 'invalid'
      : message.expiresAt <= this.now() ? 'expired'
      : this.queue.length + (this.active ? 1 : 0) >= this.capacity ? 'overflow' : undefined
    if (reason) {
      this.notify(() => this.options.onFailure(message, reason))
      return false
    }
    this.queue.push({
      message: { ...message }, attempts: 0, retryAt: 0, terminal: false,
      controller: new AbortController(),
    })
    this.pump()
    return true
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    const queued = this.queue.splice(0)
    if (this.active && !this.active.terminal) {
      this.finish(this.active, 'unknown', 'Stopped while delivery was unconfirmed')
      this.active.controller.abort()
    }
    for (const entry of queued) this.finish(entry, 'stopped')
  }

  private notify(callback: () => void) {
    try { callback() } catch (error) { console.error('Text fallback observer failed', error) }
  }

  private finish(entry: Entry<T>, reason?: TextFallbackFailureReason, detail?: string) {
    if (entry.terminal) return
    entry.terminal = true
    this.terminalKeys.add(entry.message.traceKey)
    while (this.terminalKeys.size > this.dedupCapacity) {
      this.terminalKeys.delete(this.terminalKeys.values().next().value!)
    }
    this.notify(() => {
      if (reason) this.options.onFailure(entry.message, reason, detail)
      else this.options.onSuccess?.(entry.message)
    })
  }

  private pump() {
    if (this.stopped || this.pumping) return
    this.pumping = true
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      const now = this.now()
      const expired = this.queue.filter(entry => entry.message.expiresAt <= now)
      this.queue = this.queue.filter(entry => entry.message.expiresAt > now)
      for (const entry of expired) this.finish(entry, 'expired')
      if (this.active && !this.active.terminal && this.active.message.expiresAt <= now) {
        this.finish(this.active, 'unknown', 'Deadline reached while delivery was unconfirmed')
        this.active.controller.abort()
      }
      if (this.stopped) return
      let nextAttempt = Infinity
      if (!this.active && this.queue.length) {
        const head = this.queue[0]
        let delay: number
        try {
          delay = this.options.throttle?.(head.message) ?? 0
          if (!Number.isFinite(delay) || delay < 0) throw new Error('Invalid throttle delay')
        } catch (error) {
          // No send occurred. Leave the message queued and recheck until its deadline.
          delay = this.retryDelayMs
        }
        nextAttempt = Math.max(now + delay, head.retryAt)
        if (nextAttempt <= now) {
          this.active = this.queue.shift()!
          void this.send(this.active)
          nextAttempt = Infinity
        }
      }
      const deadline = Math.min(
        nextAttempt,
        ...this.queue.map(entry => entry.message.expiresAt),
        this.active && !this.active.terminal ? this.active.message.expiresAt : Infinity,
      )
      if (!this.stopped && Number.isFinite(deadline)) {
        this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(2147483647, deadline - this.now())))
        this.timer.unref?.()
      }
    } finally {
      this.pumping = false
    }
  }

  private async send(entry: Entry<T>) {
    entry.attempts++
    let result: TextFallbackSendResult
    try {
      result = await this.options.sender(entry.message, entry.controller.signal)
    } catch (error) {
      // A synchronously throwing sender must unwind pump before observers re-enter.
      await Promise.resolve()
      result = { status: 'unknown', reason: String(error) }
    }
    if (!entry.terminal) {
      if (this.now() >= entry.message.expiresAt) {
        this.finish(entry, 'unknown', 'Sender settled after deadline')
      } else if (result?.status === 'sent') {
        this.finish(entry)
      } else if (result?.status === 'retryable') {
        if (entry.attempts <= this.maxRetries) {
          entry.retryAt = this.now() + this.retryDelayMs
          this.queue.unshift(entry)
        } else this.finish(entry, 'retries-exhausted', result.reason)
      } else {
        this.finish(entry, result?.status === 'failed' ? 'failed' : 'unknown', result?.reason)
      }
    }
    this.active = undefined
    this.pump()
  }
}
