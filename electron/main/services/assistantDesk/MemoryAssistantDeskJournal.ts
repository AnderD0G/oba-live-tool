import type { AssistantDeskDatabaseStatus } from '../../../../shared/assistantDesk'
import type {
  AssistantDeskJournalFilter,
  AssistantDeskJournalRecord,
  AssistantDeskJournalStorage,
} from './AssistantDeskJournal'

/** Canonical facts for one disposable simulation. Nothing in this class touches the filesystem. */
export class MemoryAssistantDeskJournal implements AssistantDeskJournalStorage {
  private records: AssistantDeskJournalRecord[] = []
  private latestRecords = new Map<string, AssistantDeskJournalRecord>()
  private tail: Promise<void> = Promise.resolve()
  private bytes = 0
  private closing = false
  private closed = false
  private closePending?: Promise<void>
  pending = 0
  dropped = 0
  recoveryWarnings = 0
  error?: string
  constructor(private limits = { records: 100000, bytes: 64 * 1024 * 1024 }) {}
  private check() {
    if (this.closing || this.closed) throw new Error('模拟内存记录已关闭')
  }
  async initialize() {
    this.check()
  }
  async append(record: AssistantDeskJournalRecord, guard?: () => boolean) {
    this.check()
    const payload = JSON.stringify(record)
    const bytes = Buffer.byteLength(payload)
    if (bytes > 128 * 1024) throw new Error('模拟记录超过128KB上限')
    const snapshot = JSON.parse(payload) as AssistantDeskJournalRecord
    this.pending++
    const task = this.tail
      .then(() => {
        if (guard && !guard())
          throw Object.assign(new Error('记录已变化'), { code: 'REPLY_CHANGED' })
        if (this.records.length >= this.limits.records || this.bytes + bytes > this.limits.bytes) {
          this.error = '模拟内存达到上限，请清空后重新准备'
          this.dropped++
          throw Object.assign(new Error(this.error), { code: 'MOCK_MEMORY_LIMIT' })
        }
        this.records.push(snapshot)
        this.bytes += bytes
        const data = snapshot.data as Record<string, unknown> | null
        const entity = ['context', 'policy', 'audience-policy', 'health'].includes(snapshot.type)
          ? 'current'
          : data && typeof data === 'object'
            ? (data.id ??
              data.uuid ??
              data.audienceUuid ??
              data.batchId ??
              data.key ??
              data.requestId)
            : undefined
        if (typeof entity === 'string')
          this.latestRecords.set(
            JSON.stringify([snapshot.type, snapshot.accountId, entity]),
            snapshot,
          )
      })
      .finally(() => {
        this.pending--
      })
    this.tail = task.catch(() => {})
    await task
  }
  async *read(
    reverse = false,
    filter?: AssistantDeskJournalFilter,
  ): AsyncGenerator<AssistantDeskJournalRecord> {
    this.check()
    await this.flush()
    const records = this.records.filter(
      record =>
        (!filter?.type || filter.type === record.type) &&
        (!filter?.accountId || filter.accountId === record.accountId),
    )
    if (reverse) records.reverse()
    for (const record of records) yield structuredClone(record)
  }
  async latest(type: string, accountId: string, entityId: string) {
    this.check()
    await this.flush()
    const record = this.latestRecords.get(JSON.stringify([type, accountId, entityId]))
    return record ? structuredClone(record) : undefined
  }
  async metadata(_value: unknown) {
    this.check()
    await this.flush()
  }
  async status(): Promise<AssistantDeskDatabaseStatus> {
    this.check()
    await this.flush()
    return {
      engine: 'memory',
      volatile: true,
      schemaVersion: 1,
      authoritative: true,
      recordCount: this.records.length,
      latestSequence: this.records.length,
      migrationComplete: true,
      importedRecords: 0,
      recoveryWarnings: 0,
      backup: { intervalMs: 0, retain: 7, disabled: true },
    }
  }
  async backup(): Promise<never> {
    throw Object.assign(new Error('模拟数据仅保存在内存，不提供磁盘备份'), {
      code: 'MOCK_VOLATILE_STORAGE',
    })
  }
  async flush() {
    await this.tail
  }
  close() {
    this.closePending ??= (async () => {
      this.closing = true
      await this.flush()
      this.records = []
      this.latestRecords.clear()
      this.bytes = 0
      this.closed = true
    })()
    return this.closePending
  }
}
