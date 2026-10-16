import type { AudienceTrace } from '../../../shared/audienceEvents'
import type {
  DirectorRequest,
  DirectorRequestRecord,
  DirectorRequestStatus,
} from '../../../shared/director'

const terminal = new Set<DirectorRequestStatus>(['completed', 'cancelled', 'failed', 'interrupted'])

/** Playback facts, independent of model sessions and conversation summaries. */
export class DirectorRequestHistory {
  readonly records: DirectorRequestRecord[]
  constructor(
    records: DirectorRequestRecord[] = [],
    private save: (records: DirectorRequestRecord[]) => void = () => {},
    private onTransition?: (record: DirectorRequestRecord) => void,
  ) {
    this.records = structuredClone(records)
  }
  add(request: DirectorRequest, productName: string, user = request.user, trace?: AudienceTrace) {
    if (this.records.some(r => r.id === request.id && r.user === user && !terminal.has(r.status)))
      return
    const now = Date.now()
    const record: DirectorRequestRecord = {
      id: request.id,
      user,
      trayId: request.trayId,
      productId: request.productId,
      productName,
      mode: request.mode,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      ...(trace ? { trace: structuredClone(trace) } : {}),
    }
    this.records.push(record)
    this.persist()
    this.changed(record)
  }
  set(id: string, status: DirectorRequestStatus, user?: string) {
    const now = Date.now()
    const changed: DirectorRequestRecord[] = []
    for (const record of this.records) {
      if (
        record.id !== id ||
        (user !== undefined && record.user !== user) ||
        terminal.has(record.status)
      )
        continue
      if (record.status === status) continue
      if (record.status === 'cancelling' && (status === 'playing' || status === 'preparing'))
        continue
      record.status = status
      record.updatedAt = now
      if (status === 'playing') record.startedAt ??= now
      if (terminal.has(status)) record.endedAt = now
      changed.push(record)
    }
    this.persist()
    for (const record of changed) this.changed(record)
  }
  interrupt(status: 'interrupted' | 'failed' = 'interrupted') {
    const now = Date.now()
    const changed: DirectorRequestRecord[] = []
    for (const r of this.records)
      if (!terminal.has(r.status)) {
        r.status = status
        r.updatedAt = now
        r.endedAt = now
        changed.push(r)
      }
    this.persist()
    for (const record of changed) this.changed(record)
  }
  private changed(record: DirectorRequestRecord) {
    try {
      this.onTransition?.(structuredClone(record))
    } catch {
      console.error('记录点播状态事件失败')
    }
  }
  forUser(user: string) {
    return this.records.filter(r => r.user === user)
  }
  private persist() {
    // Bound terminal history without ever evicting active requests.
    let excess = this.records.length - 2000
    for (let i = 0; i < this.records.length && excess > 0; ) {
      if (terminal.has(this.records[i].status)) {
        this.records.splice(i, 1)
        excess--
      } else i++
    }
    this.save(structuredClone(this.records))
  }
}
