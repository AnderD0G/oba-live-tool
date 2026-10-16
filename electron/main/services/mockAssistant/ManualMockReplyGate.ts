import { AsyncLocalStorage } from 'node:async_hooks'
import type { PlatformLiveTarget } from '../../../../shared/platformSession'

export interface MockReplyPermit {
  accountId: string
  runId: string
  rowId: string
  requestId: string
  expectedText: string
  sessionId: string
  target: PlatformLiveTarget
}

/** Only a direct desktop/phone approval may lend one send to its own async call chain. */
export class ManualMockReplyGate {
  private readonly scope = new AsyncLocalStorage<MockReplyPermit & { used: boolean }>()
  constructor(
    private readonly options: {
      currentRun(accountId: string): string | undefined
      send(permit: MockReplyPermit, text: string, signal: AbortSignal): Promise<boolean>
    },
  ) {}

  async approve<T>(permit: MockReplyPermit, work: () => Promise<T>): Promise<T> {
    return this.scope.run({ ...structuredClone(permit), used: false }, work)
  }

  async send(accountId: string, text: string, signal: AbortSignal): Promise<void> {
    const permit = this.scope.getStore()
    if (
      !permit ||
      permit.used ||
      signal.aborted ||
      permit.accountId !== accountId ||
      this.options.currentRun(accountId) !== permit.runId ||
      !text.startsWith('@') ||
      !text.endsWith(` ${permit.expectedText}`)
    )
      throw new Error('模拟回复需要在当前消息上手动确认发送')
    // Consume before touching a platform: an ambiguous outcome never becomes a retry.
    permit.used = true
    if (!(await this.options.send(permit, text, signal)))
      throw new Error('直播间或登录状态已变化，平台未确认发送；请人工核对')
  }
}
