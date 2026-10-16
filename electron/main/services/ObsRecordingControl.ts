import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { ObsRpcClient } from './ObsWebSocketClient'

/** Recording is independent of streaming. Only stop the recording started through this control. */
export class ObsRecordingControl {
  private tail: Promise<unknown> = Promise.resolve()
  private owner?: string
  constructor(
    private client: ObsRpcClient,
    private settings: () => { url: string; password: string },
    private confirmation = { timeoutMs: 5000, pollIntervalMs: 100 },
  ) {
    if (!Number.isInteger(confirmation.timeoutMs) || confirmation.timeoutMs < 1 || confirmation.timeoutMs > 10_000 ||
        !Number.isInteger(confirmation.pollIntervalMs) || confirmation.pollIntervalMs < 1 || confirmation.pollIntervalMs > confirmation.timeoutMs)
      throw new Error('OBS录像确认等待配置无效')
  }
  private async confirm(active: boolean) {
    const deadline = performance.now() + this.confirmation.timeoutMs
    const timeout = () => new Error(active ? 'OBS未确认录像启动，请在OBS中核实' : 'OBS未确认录像停止，请在OBS中核实')
    while (true) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw timeout()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const state = await Promise.race([
          this.client.call('GetRecordStatus'),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), Math.ceil(remaining)) }),
        ])
        if (performance.now() >= deadline) throw timeout()
        if (typeof state.outputActive !== 'boolean') throw new Error('OBS未返回可确认的录像状态')
        if (state.outputActive === active) return
      } finally { if (timer) clearTimeout(timer) }
      const waitMs = Math.min(this.confirmation.pollIntervalMs, deadline - performance.now())
      if (waitMs > 0) await delay(waitMs)
    }
  }
  execute(accountId: string, action: 'status' | 'start' | 'stop') {
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        const settings = this.settings()
        await this.client.connect(settings.url, settings.password)
        const state = await this.client.call('GetRecordStatus')
        if (typeof state.outputActive !== 'boolean') throw new Error('OBS未返回可确认的录像状态')
        const active = state.outputActive
        if (!active) this.owner = undefined
        if (action === 'status')
          return {
            active,
            owned: active && this.owner === accountId,
            outputDuration: state.outputDuration,
            outputTimecode: state.outputTimecode,
          }
        if (action === 'start') {
          if (active) return { active: true, owned: this.owner === accountId, alreadyRunning: true }
          await this.client.call('StartRecord')
          // A successful command acknowledgement precedes the output state transition.
          // Failed or late confirmations must never claim a subsequently external recording.
          await this.confirm(true)
          this.owner = accountId
          return { active: true, owned: true, startedAt: Date.now() }
        }
        if (!active) return { active: false, owned: false, alreadyStopped: true }
        if (this.owner !== accountId)
          throw new Error('这段录像由其他操作启动，请在OBS中结束；助播台不会停止它')
        const result = await this.client.call('StopRecord')
        // Keep ownership on a failed/unconfirmed stop so the initiating account can retry.
        await this.confirm(false)
        this.owner = undefined
        return {
          active: false,
          owned: false,
          stoppedAt: Date.now(),
          outputPath: typeof result.outputPath === 'string' ? result.outputPath : undefined,
        }
      })
      .finally(() => this.client.disconnect())
    this.tail = pending.catch(() => {})
    return pending
  }
}
