import { randomUUID } from 'node:crypto'
import type { AssistantDeskDependencies } from '../../../../shared/assistantDesk'
import {
  type MockBatch,
  type MockRuntimeStatus,
  validateMockBatch,
} from '../../../../shared/mockAssistant'
import type { AssistantDeskService } from '../assistantDesk/AssistantDeskService'
import { MockCaptureSource } from './MockCaptureSource'

export interface MockRuntimeOptions {
  createDesk(
    accountId: string,
    startCapture: AssistantDeskDependencies['startCapture'],
    context: { runId: string },
  ): AssistantDeskService | Promise<AssistantDeskService>
  getMetadataRevision(accountId: string): string | Promise<string>
  onReset?(accountId: string, reason: 'start' | 'stop' | 'clear' | 'leave'): void | Promise<void>
}
interface Entry {
  accountId: string
  selected: boolean
  phase: MockRuntimeStatus['phase']
  generation: number
  emitted: number
  runId?: string
  batch?: MockBatch
  service?: AssistantDeskService
  creating?: Promise<AssistantDeskService>
  source?: MockCaptureSource
  tail: Promise<void>
  error?: MockRuntimeStatus['error']
}
class MockRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
const fail = (code: string, message: string): never => {
  throw new MockRuntimeError(code, message)
}

/** Owns disposable services independently of real capture, global observations and durable history. */
export class MockRuntime {
  private entries = new Map<string, Entry>()
  private closed = false
  private closing?: Promise<void>
  constructor(private options: MockRuntimeOptions) {}
  private entry(accountId: string) {
    if (this.closed) fail('MOCK_SHUTDOWN', '模拟服务已关闭')
    if (
      typeof accountId !== 'string' ||
      !accountId ||
      accountId.length > 256 ||
      /[\s\p{Cc}]/u.test(accountId)
    )
      fail('MOCK_ACCOUNT_MISMATCH', '模拟账号无效')
    let entry = this.entries.get(accountId)
    if (!entry) {
      if (this.entries.size >= 100) fail('MOCK_ACCOUNT_LIMIT', '模拟账号数量已达到上限')
      entry = {
        accountId,
        selected: false,
        phase: 'idle',
        generation: 0,
        emitted: 0,
        tail: Promise.resolve(),
      }
      this.entries.set(accountId, entry)
    }
    return entry
  }
  private serial<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const result = entry.tail.then(task)
    entry.tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
  status(accountId: string): MockRuntimeStatus {
    const entry = this.entries.get(accountId)
    const batch = entry?.batch
    if (!entry) return { accountId, selected: false, phase: 'idle', volatile: true, emitted: 0 }
    return {
      accountId,
      selected: entry.selected,
      phase: entry.phase,
      volatile: true,
      emitted: entry.emitted,
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.error ? { error: { ...entry.error } } : {}),
      ...(batch
        ? {
            batch: {
              batchId: batch.batchId,
              name: batch.name,
              metadataRevision: batch.metadataRevision,
              userCount: batch.users.length,
              eventCount: batch.events.length,
              durationMs: batch.durationMs,
            },
          }
        : {}),
    }
  }
  isSelected(accountId: string) {
    return this.entries.get(accountId)?.selected ?? false
  }
  /** Metadata reads may run inside our queue; this accessor neither creates nor queues work. */
  peekService(accountId: string): AssistantDeskService | undefined {
    return this.closed ? undefined : this.entries.get(accountId)?.service
  }
  async prepare(accountId: string, input: unknown): Promise<MockRuntimeStatus> {
    const entry = this.entry(accountId)
    // Snapshot before entering the queue; callers cannot mutate a queued batch.
    const snapshot = validateMockBatch(input, accountId)
    return this.serial(entry, async () => {
      if (entry.phase === 'running') fail('MOCK_RUNNING', '请先停止模拟，再准备新批次')
      entry.batch = validateMockBatch(
        snapshot,
        accountId,
        await this.options.getMetadataRevision(accountId),
      )
      entry.phase = 'prepared'
      entry.emitted = 0
      entry.error = undefined
      return this.status(accountId)
    })
  }
  private check(entry: Entry, generation: number) {
    if (entry.generation !== generation) fail('MOCK_CANCELLED', '模拟操作已取消')
  }
  private async service(entry: Entry, generation: number): Promise<AssistantDeskService> {
    this.check(entry, generation)
    if (entry.service) return entry.service
    if (entry.creating) return entry.creating
    entry.runId ??= randomUUID()
    const runId = entry.runId
    let desk: AssistantDeskService | undefined
    const source = new MockCaptureSource({
      runId,
      afterEmit: async () => {
        await desk?.flushIngest(entry.accountId)
      },
      onEmitted: count => {
        if (entry.source === source) entry.emitted = count
      },
      onError: () => {
        if (entry.source === source) {
          source.cancel()
          entry.phase = 'stopped'
          entry.error = {
            code: 'MOCK_PLAYBACK_FAILED',
            message: '模拟事件处理失败，请检查模拟场次后重新准备',
          }
          void desk?.execute({ action: 'stop', params: { accountId: entry.accountId } })
        }
      },
    })
    entry.source = source
    const creating = (async () => {
      const created = await this.options.createDesk(entry.accountId, source.startCapture, { runId })
      if (entry.generation !== generation || created.mockRunId !== runId) {
        await created.shutdown()
        this.check(entry, generation)
        fail('MOCK_UNSAFE_FACTORY', '模拟服务必须使用内存存储并强制人工发送')
      }
      desk = created
      entry.service = created
      return created
    })()
    entry.creating = creating
    try {
      return await creating
    } finally {
      if (entry.creating === creating) entry.creating = undefined
    }
  }
  async serviceFor(accountId: string): Promise<AssistantDeskService> {
    const entry = this.entry(accountId)
    const generation = entry.generation
    return this.serial(entry, async () => {
      if (!entry.selected) fail('MOCK_NOT_SELECTED', '当前账号尚未选择模拟现场')
      return this.service(entry, generation)
    })
  }
  async start(accountId: string): Promise<MockRuntimeStatus> {
    const entry = this.entry(accountId)
    const generation = entry.generation
    return this.serial(entry, async () => {
      this.check(entry, generation)
      if (entry.phase === 'running') return this.status(accountId)
      if (!entry.batch) fail('MOCK_NOT_PREPARED', '请先准备模拟批次')
      const batch = validateMockBatch(
        entry.batch,
        accountId,
        await this.options.getMetadataRevision(accountId),
      )
      this.check(entry, generation)
      const service = await this.service(entry, generation)
      this.check(entry, generation)
      const source = entry.source
      if (!source) throw new MockRuntimeError('MOCK_UNAVAILABLE', '模拟回放服务尚未就绪')
      source.prepare(batch)
      await service.seedMockAudience(
        accountId,
        batch.users.map(user => ({ ...user, userId: source.userId(user.id) })),
      )
      this.check(entry, generation)
      await this.options.onReset?.(accountId, 'start')
      this.check(entry, generation)
      const result = await service.execute({
        action: 'start',
        params: { accountId, platform: 'tiktok' },
      })
      this.check(entry, generation)
      if (!result.ok) throw new MockRuntimeError(result.error.code, result.error.message)
      entry.selected = true
      entry.phase = 'running'
      entry.emitted = 0
      entry.error = undefined
      source.play()
      return this.status(accountId)
    })
  }
  async stop(accountId: string): Promise<MockRuntimeStatus> {
    const entry = this.entry(accountId)
    entry.generation++
    entry.source?.cancel()
    return this.serial(entry, async () => {
      if (entry.service) {
        const result = await entry.service.execute({ action: 'stop', params: { accountId } })
        if (!result.ok) throw new MockRuntimeError(result.error.code, result.error.message)
      }
      if (entry.phase === 'running') entry.phase = 'stopped'
      await this.options.onReset?.(accountId, 'stop')
      return this.status(accountId)
    })
  }
  private reset(accountId: string, leave: boolean): Promise<MockRuntimeStatus> {
    const entry = this.entry(accountId)
    const wasSelected = entry.selected
    entry.generation++
    entry.source?.cancel()
    if (leave) entry.selected = false
    return this.serial(entry, async () => {
      const service = entry.service
      entry.service = undefined
      entry.creating = undefined
      entry.source = undefined
      entry.batch = undefined
      entry.runId = undefined
      entry.emitted = 0
      entry.error = undefined
      entry.phase = 'idle'
      entry.selected = !leave && wasSelected
      await service?.shutdown()
      await this.options.onReset?.(accountId, leave ? 'leave' : 'clear')
      return this.status(accountId)
    })
  }
  async clear(accountId: string) {
    return this.reset(accountId, false)
  }
  async leave(accountId: string) {
    return this.reset(accountId, true)
  }
  shutdown(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const entries = [...this.entries.values()]
    for (const entry of entries) {
      entry.generation++
      entry.source?.cancel()
      entry.selected = false
    }
    this.closing = (async () => {
      const results = await Promise.allSettled(
        entries.map(async entry => {
          await entry.tail
          const service = entry.service
          entry.service = undefined
          entry.source = undefined
          entry.creating = undefined
          entry.selected = false
          entry.phase = 'idle'
          entry.batch = undefined
          entry.runId = undefined
          entry.emitted = 0
          entry.error = undefined
          await service?.shutdown()
          await this.options.onReset?.(entry.accountId, 'leave')
        }),
      )
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return this.closing
  }
}
