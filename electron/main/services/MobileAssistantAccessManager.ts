import type {
  MobileAssistantAccessCommand,
  MobileAssistantAccessResult,
  MobileAssistantAccessStatus,
} from '../../../shared/mobileAssistantDesk'

export interface MobileAssistantListener {
  start(): Promise<MobileAssistantAccessStatus>
  status(): MobileAssistantAccessStatus
  stop(): Promise<void>
}
type Dependencies = {
  createServer(accountId: string, accountName: string): MobileAssistantListener
  accountName(accountId: string): string
}

/** Serializes the desktop's access controls without changing capture state. */
export class MobileAssistantAccessManager {
  private listener?: MobileAssistantListener
  private accountId?: string
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly deps: Dependencies) {}

  execute(input: MobileAssistantAccessCommand): Promise<MobileAssistantAccessResult> {
    const operation = this.pending.then(async (): Promise<MobileAssistantAccessResult> => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['action', 'accountId'].includes(key)) ||
        !['status', 'start', 'stop'].includes(input.action) ||
        typeof input.accountId !== 'string' || input.accountId.length > 256 ||
        !input.accountId || /[\s\u0000-\u001f\u007f]/.test(input.accountId)) {
        return { ok: false, error: { code: 'MOBILE_INVALID_COMMAND', message: '手机入口操作无效' } }
      }
      const inactive = (): MobileAssistantAccessStatus => ({
        active: false, accountId: input.accountId, urls: [],
      })
      if (input.action === 'status') {
        return { ok: true, data: this.accountId === input.accountId && this.listener
          ? this.listener.status() : inactive() }
      }
      if (input.action === 'stop') {
        if (this.listener && this.accountId !== input.accountId)
          return { ok: false, error: { code: 'MOBILE_ACCOUNT_CHANGED', message: '账号已切换，请在当前账号关闭手机入口' } }
        await this.stopCurrent()
        return { ok: true, data: inactive() }
      }
      if (this.listener && this.accountId === input.accountId && this.listener.status().active)
        return { ok: true, data: this.listener.status() }
      await this.stopCurrent()
      const listener = this.deps.createServer(input.accountId, this.deps.accountName(input.accountId))
      try {
        const status = await listener.start()
        this.listener = listener
        this.accountId = input.accountId
        return { ok: true, data: status }
      } catch {
        await listener.stop().catch(() => {})
        return { ok: false, error: { code: 'MOBILE_START_FAILED', message: '手机入口暂时无法开启，请稍后重试' } }
      }
    }).catch((): MobileAssistantAccessResult => ({
      ok: false, error: { code: 'MOBILE_ACCESS_FAILED', message: '手机入口操作失败，请重试' },
    }))
    this.pending = operation.then(() => undefined)
    return operation
  }

  private async stopCurrent() {
    const previous = this.listener
    this.listener = undefined
    this.accountId = undefined
    await previous?.stop()
  }

  dispose(): Promise<void> {
    const operation = this.pending.then(() => this.stopCurrent())
    this.pending = operation.catch(() => {})
    return operation
  }
}

