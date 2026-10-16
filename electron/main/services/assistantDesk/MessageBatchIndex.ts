import type { AssistantDeskRow, AssistantDeskSession, AssistantMessageBatch, AssistantMessageBatchSummary } from '../../../../shared/assistantDesk'
import type { AssistantDeskDerivedIndex, DerivedMap } from './AssistantDeskDerivedIndex'

interface BatchEntry { batch: Omit<AssistantMessageBatch, 'status'>; order: number; closed: boolean; firstRowOrder: number; lastRowOrder: number }
interface RowPosition { batchId: string; order: number; rowId: string }
interface SessionPosition { count: number; index: number; batchId: string }

/** Compact membership replayed from first durable rows; row text stays in the journal. */
export class MessageBatchIndex {
  private positions: Map<string, RowPosition> | DerivedMap<RowPosition>
  private sessionPositions: Map<string, SessionPosition> | DerivedMap<SessionPosition>
  private batches: Map<string, BatchEntry> | DerivedMap<BatchEntry>
  private receiveOrder = 0
  constructor(index?: AssistantDeskDerivedIndex) {
    this.positions = index?.map<RowPosition>('batch-positions', 4096) ?? new Map()
    this.sessionPositions = index?.map<SessionPosition>('batch-sessions', 200) ?? new Map()
    this.batches = index?.map<BatchEntry>('batches', 200) ?? new Map()
  }
  private key(accountId: string, id: string) { return JSON.stringify([accountId, id]) }
  observeSession(session: AssistantDeskSession) {
    // A storage-error capture can still save later rows; its explicit ending seals the partial.
    if (session.endedAt === undefined && (session.status === 'collecting' || session.status === 'storage-error')) return
    const position = this.sessionPositions.get(this.key(session.accountId, session.id))
    if (position) { const entry = this.batches.get(position.batchId)!; entry.closed = true; this.batches.set(position.batchId, entry) }
  }
  observe(row: AssistantDeskRow) {
    const rowKey = this.key(row.accountId, row.id)
    if (this.positions.has(rowKey)) return
    const sessionKey = this.key(row.accountId, row.sessionId), position = this.sessionPositions.get(sessionKey), order = (position?.count ?? 0) + 1
    const previous = position ? this.batches.get(position.batchId) : undefined
    const index = previous && !previous.closed ? position!.index : (position?.index ?? 0) + 1
    const batchId = `messages:${row.sessionId}:${index}`
    this.sessionPositions.set(sessionKey, { count: order, index, batchId })
    this.positions.set(rowKey, { batchId, order, rowId: row.id }, { sessionId: batchId, receivedAt: order })
    this.receiveOrder++
    const existing = this.batches.get(batchId)
    if (existing) {
      existing.batch.total++
      existing.batch.from = Math.min(existing.batch.from, row.receivedAt)
      existing.batch.to = Math.max(existing.batch.to, row.receivedAt)
      existing.lastRowOrder = order
      if (existing.batch.total === 1000) existing.closed = true
      this.batches.set(batchId, existing)
    } else this.batches.set(batchId, { order: this.receiveOrder, closed: false, firstRowOrder: order, lastRowOrder: order, batch: { id: batchId, accountId: row.accountId, sessionId: row.sessionId, index, from: row.receivedAt, to: row.receivedAt, total: 1, batchSize: 1000, readRevision: 0 } })
  }
  get(accountId: string, batchId: string): AssistantMessageBatch | undefined {
    const entry = this.batches.get(batchId)
    if (!entry || entry.batch.accountId !== accountId) return undefined
    return { ...entry.batch, status: entry.closed ? 'archived' : 'collecting' }
  }
  order(accountId: string, rowId: string, batchId: string) {
    const position = this.positions.get(this.key(accountId, rowId))
    return position?.batchId === batchId ? position.order : undefined
  }
  batchOrder(batchId: string) { return this.batches.get(batchId)?.order }
  bounds(batchId: string) { const entry = this.batches.get(batchId)!; return { from: entry.firstRowOrder, to: entry.lastRowOrder } }
  *members(batchId: string, afterOrder = 0): Generator<RowPosition> {
    const bounds = this.bounds(batchId)
    const values = 'valuesInSession' in this.positions
      ? this.positions.valuesInSession(batchId, Math.max(bounds.from, afterOrder + 1), bounds.to)
      : this.positions.values()
    for (const position of values) if (position.batchId === batchId && position.order > afterOrder) yield position
  }
  setRead(accountId: string, batchId: string, readAt: number | undefined) {
    const entry = this.batches.get(batchId)
    if (!entry || entry.batch.accountId !== accountId) throw new Error('Invalid message batch review record')
    entry.batch.readRevision = (entry.batch.readRevision ?? 0) + 1
    if (readAt === undefined) delete entry.batch.readAt
    else entry.batch.readAt = readAt
    this.batches.set(batchId, entry)
  }
  *archived(accountId: string, sessionId?: string): Generator<AssistantMessageBatch> {
    for (const entry of this.batches.values()) {
      if (entry.batch.accountId !== accountId || (sessionId && entry.batch.sessionId !== sessionId)) continue
      const batch = this.get(accountId, entry.batch.id)!
      if (batch.status === 'archived') yield batch
    }
  }
  summary(accountId: string, activeSessionId?: string): AssistantMessageBatchSummary {
    return this.summarize(accountId, activeSessionId)
  }
  summaryForSession(accountId: string, sessionId?: string): AssistantMessageBatchSummary {
    if (sessionId === undefined) return { batchSize: 1000, totalRows: 0, archivedTotal: 0, unreadTotal: 0, recent: [] }
    return this.summarize(accountId, sessionId, sessionId)
  }
  private summarize(accountId: string, activeSessionId?: string, sessionId?: string): AssistantMessageBatchSummary {
    const summary: AssistantMessageBatchSummary = { batchSize: 1000, totalRows: 0, archivedTotal: 0, unreadTotal: 0, recent: [] }
    for (const entry of this.batches.values()) {
      if (entry.batch.accountId !== accountId || (sessionId !== undefined && entry.batch.sessionId !== sessionId)) continue
      const batch = this.get(accountId, entry.batch.id)!
      summary.totalRows += batch.total
      if (batch.status === 'collecting') { if (batch.sessionId === activeSessionId) summary.current = batch; continue }
      summary.archivedTotal++
      if (batch.readAt === undefined) summary.unreadTotal++
      summary.recent.push(batch)
      summary.recent.sort((a, b) => this.batchOrder(b.id)! - this.batchOrder(a.id)!)
      if (summary.recent.length > 20) summary.recent.pop()
    }
    return summary
  }
}
