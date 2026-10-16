import type { EffectActionKind, EffectGroupJob, EffectGroupRunEvent, EffectGroupsConfig, EffectSlot } from '../../../../shared/effectGroups'

export interface EffectGroupSchedulerOptions {
  now?: () => number
  play: (job: EffectGroupJob, signal: AbortSignal, onStarted: (detail?: Record<string, unknown>) => Promise<void>) => Promise<void>
  onEvent: (event: EffectGroupRunEvent) => void | Promise<void>
}

export interface EffectGroupEnqueueReceipt {
  accepted: boolean
  runId: string
  status: 'queued' | 'skipped'
  reason?: string
}

export interface EffectGroupQuarantine {
  slot: EffectSlot
  runId: string
  groupId: string
  accountId: string
  generation?: number
  reason: string
}

export interface EffectGroupSchedulerStatus {
  stopped: boolean
  queued: EffectGroupJob[]
  active: (EffectGroupJob & { status: 'preparing' | 'started'; startedAt?: number })[]
  retiring: string[]
  /** Physical blockers are global, including when the requested account is filtered. */
  quarantinedSlots: EffectGroupQuarantine[]
  auditFailures: { runId: string; status: EffectGroupRunEvent['status']; at: number; error: string }[]
}

interface Entry {
  job: EffectGroupJob
  slots: EffectSlot[]
  order: number
  expiresAt: number
  audit: Promise<void>
  terminal: boolean
  done: Promise<void>
  resolveDone: () => void
}

interface Active extends Entry {
  controller: AbortController
  phase: 'preparing' | 'started'
  startedAt?: number
  startedAudit?: Promise<void>
  stopReason?: string
  playInvoked?: boolean
  beforePlayReason?: string
}

const SLOTS: EffectSlot[] = ['main-stage', 'corner-left', 'corner-right']
const ACTION_RANK: Record<EffectActionKind, number> = { gift: 0, enter: 1, follow: 1, like: 2 }
const DEFAULT_TTL: Record<EffectActionKind, number> = { gift: 30000, enter: 8000, follow: 8000, like: 3000 }
const GLOBAL_CAPACITY = 32
const PHYSICAL_SLOT_CAPACITY = 16

function snapshot<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (part: unknown) => {
    if (!part || typeof part !== 'object' || Object.isFrozen(part)) return
    for (const child of Object.values(part)) freeze(child)
    Object.freeze(part)
  }
  freeze(copy)
  return copy
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cleanupFailed(error: unknown): boolean {
  return !!error && typeof error === 'object' && ('cleanupFailed' in error && error.cleanupFailed === true || 'code' in error && error.code === 'CLEANUP_FAILED')
}

/** One instance owns the physical OBS receiver; all accounts share its admission permits. */
export class EffectGroupScheduler {
  private readonly now: () => number
  private readonly configs = new Map<string, EffectGroupsConfig>()
  private queue: Entry[] = []
  private readonly active = new Map<string, Active>()
  private readonly retiring = new Set<string>()
  private readonly quarantine = new Map<EffectSlot, EffectGroupQuarantine>()
  private readonly watermarks = new Map<EffectSlot, { sequence: number; eventId: string }>()
  private readonly pendingAudits = new Set<Promise<void>>()
  private readonly auditFailures: EffectGroupSchedulerStatus['auditFailures'] = []
  private nextOrder = 0
  private pumping = false
  private stopped = false
  private stopping?: Promise<void>
  private expiryTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly options: EffectGroupSchedulerOptions) {
    this.now = options.now ?? Date.now
  }

  configure(config: EffectGroupsConfig): void {
    const previous = this.configs.get(config.accountId)
    if (previous && config.revision < previous.revision) return
    const next = snapshot(config)
    this.configs.set(next.accountId, next)
    if (next.enabled) {
      for (const group of next.groups) {
        if (group.enabled && (!previous || next.revision > previous.revision ||
          ![...this.active.values(), ...this.queue].some((entry) => entry.job.group.groupId === group.groupId))) this.retiring.delete(group.groupId)
      }
    }
    for (const entry of [...this.queue]) {
      if (entry.job.accountId !== next.accountId) continue
      const group = next.groups.find((item) => item.groupId === entry.job.group.groupId)
      const reason = !next.enabled || !group?.enabled ? 'GROUP_DISABLED' : entry.job.configRevision !== next.revision ? 'CONFIG_CHANGED' : undefined
      if (reason) this.removeQueued(entry, reason)
    }
    for (const entry of this.active.values()) {
      if (!entry.playInvoked && entry.job.accountId === next.accountId) {
        const group = next.groups.find((item) => item.groupId === entry.job.group.groupId)
        if (!next.enabled || !group?.enabled) entry.beforePlayReason = 'GROUP_DISABLED'
        else if (entry.job.configRevision !== next.revision) entry.beforePlayReason = 'CONFIG_CHANGED'
      }
    }
    // Reconnection/recovery may resume admission only after every physical blocker is repaired.
    if (this.stopped && !this.stopping && !this.active.size && !this.quarantine.size) this.stopped = false
    this.requestPump()
  }

  enqueue(input: EffectGroupJob): EffectGroupEnqueueReceipt {
    const job = snapshot(input)
    const config = this.configs.get(job.accountId)
    const slots = [...new Set([job.group.slot, ...(job.requiredSlots ?? [])])]
    const ttl = config?.scheduler.ttlMs[job.actionKind] ?? DEFAULT_TTL[job.actionKind]
    let resolveDone!: () => void
    const entry: Entry = { job, slots, order: ++this.nextOrder, expiresAt: job.receivedAt + ttl,
      audit: Promise.resolve(), terminal: false, done: new Promise<void>((resolve) => { resolveDone = resolve }), resolveDone: () => resolveDone() }
    const reject = (reason: string): EffectGroupEnqueueReceipt => {
      this.terminal(entry, 'skipped', reason)
      return { accepted: false, runId: job.runId, status: 'skipped', reason }
    }
    if (this.active.has(job.runId) || this.queue.some((item) => item.job.runId === job.runId)) {
      return { accepted: false, runId: job.runId, status: 'skipped', reason: 'DUPLICATE_RUN' }
    }
    if (this.stopped) return reject('STOPPED')
    if (!config?.enabled || !job.group.enabled) return reject('GROUP_DISABLED')
    if (this.retiring.has(job.group.groupId)) return reject('GROUP_RETIRED')
    if (job.configRevision !== config.revision) return reject('CONFIG_CHANGED')
    const configured = config.groups.find((item) => item.groupId === job.group.groupId)
    if (!configured?.enabled) return reject('GROUP_DISABLED')
    if (configured.actionKind !== job.actionKind || job.group.actionKind !== job.actionKind || JSON.stringify(configured) !== JSON.stringify(job.group)) return reject('CONFIG_CHANGED')
    if (!Number.isSafeInteger(job.sequence) || job.sequence < 0 || !Number.isFinite(job.receivedAt) || slots.some((slot) => !SLOTS.includes(slot))) return reject('INVALID_JOB')
    if (slots.some((slot) => this.quarantine.has(slot))) return reject('CLEANUP_PENDING')
    if (slots.some((slot) => {
      const current = this.watermarks.get(slot)
      return current && (job.sequence < current.sequence || job.sequence === current.sequence && job.eventId !== current.eventId)
    })) return reject('STALE_SEQUENCE')
    for (const slot of slots) this.watermarks.set(slot, { sequence: job.sequence, eventId: job.eventId })
    if (entry.expiresAt <= this.now()) return reject('EXPIRED')
    this.pruneExpired()
    if (job.group.coalesce === 'same-user-group-latest') {
      for (const old of [...this.queue]) {
        if (old.job.accountId === job.accountId && old.job.group.groupId === job.group.groupId && old.job.actionKind === job.actionKind && old.job.userId === job.userId) this.removeQueued(old, 'COALESCED')
      }
    }
    const candidates = [...this.queue, entry]
    const evicted = new Set<Entry>()
    const enforce = (matching: (item: Entry) => boolean, capacity: number) => {
      const competing = candidates.filter((item) => !evicted.has(item) && matching(item)).sort((a, b) => this.compare(a, b))
      for (const item of competing.slice(Math.max(1, capacity))) evicted.add(item)
    }
    for (const slot of SLOTS) {
      enforce((item) => item.slots.includes(slot), PHYSICAL_SLOT_CAPACITY)
      enforce((item) => item.job.accountId === job.accountId && item.slots.includes(slot), Math.min(PHYSICAL_SLOT_CAPACITY, config.scheduler.perSlotCapacity))
    }
    enforce((item) => item.job.accountId === job.accountId, Math.min(GLOBAL_CAPACITY, config.scheduler.queueCapacity))
    enforce(() => true, GLOBAL_CAPACITY)
    // A rejected candidate cannot evict unrelated accepted jobs as a side effect.
    if (evicted.has(entry)) return reject('QUEUE_FULL')
    for (const old of evicted) this.removeQueued(old, 'QUEUE_FULL')
    this.queue.push(entry)
    this.record(entry, 'queued', undefined, { sequence: job.sequence, configRevision: job.configRevision, generation: job.generation, requiredSlots: slots })
    this.requestPump()
    this.scheduleExpiry()
    return { accepted: true, runId: job.runId, status: 'queued' }
  }

  status(accountId?: string): EffectGroupSchedulerStatus {
    this.pruneExpired()
    this.requestPump()
    const belongs = (entry: Entry) => !accountId || entry.job.accountId === accountId
    return {
      stopped: this.stopped,
      queued: this.queue.filter(belongs).map((entry) => entry.job),
      active: [...this.active.values()].filter(belongs).map((entry) => ({ ...entry.job, status: entry.phase, startedAt: entry.startedAt })),
      retiring: [...this.retiring],
      quarantinedSlots: [...this.quarantine.values()].map((item) => ({ ...item })),
      auditFailures: this.auditFailures.map((item) => ({ ...item })),
    }
  }

  async retire(groupId: string): Promise<void> {
    this.retiring.add(groupId)
    for (const entry of [...this.queue]) if (entry.job.group.groupId === groupId) this.removeQueued(entry, 'GROUP_RETIRED')
    for (const entry of this.active.values()) if (entry.job.group.groupId === groupId && !entry.playInvoked) entry.beforePlayReason = 'GROUP_RETIRED'
    await Promise.all([...this.active.values()].filter((entry) => entry.job.group.groupId === groupId).map((entry) => entry.done))
    await this.flushAudits()
  }

  /** Call only after external resource recovery has verified cleanup. An exact run token protects newer failures. */
  repair(groupId: string, runId?: string): number {
    let repaired = 0
    for (const [slot, blocker] of this.quarantine) {
      if (blocker.groupId === groupId && (runId === undefined || blocker.runId === runId)) {
        this.quarantine.delete(slot)
        repaired++
      }
    }
    this.requestPump()
    return repaired
  }

  stop(reason = 'STOPPED'): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    for (const entry of [...this.queue]) this.removeQueued(entry, reason)
    const active = [...this.active.values()]
    for (const entry of active) {
      entry.stopReason = reason
      entry.controller.abort(reason)
    }
    const stopping = (async () => {
      await Promise.all(active.map((entry) => entry.done))
      await this.flushAudits()
      if (this.quarantine.size) throw Object.assign(new Error('Effect group cleanup is still pending'), { code: 'CLEANUP_FAILED', cleanupFailed: true })
    })()
    this.stopping = stopping
    void stopping.then(() => { if (this.stopping === stopping) this.stopping = undefined }, () => { if (this.stopping === stopping) this.stopping = undefined })
    return stopping
  }

  private compare(a: Entry, b: Entry): number {
    return ACTION_RANK[a.job.actionKind] - ACTION_RANK[b.job.actionKind] || b.job.group.priority - a.job.group.priority || a.order - b.order
  }

  private removeQueued(entry: Entry, reason: string): void {
    this.queue = this.queue.filter((item) => item !== entry)
    this.terminal(entry, 'skipped', reason)
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const entry of [...this.queue]) if (entry.expiresAt <= now) this.removeQueued(entry, 'EXPIRED')
    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    if (this.stopped || !this.queue.length) return
    const expiry = Math.min(...this.queue.map((entry) => entry.expiresAt))
    this.expiryTimer = setTimeout(() => { this.expiryTimer = undefined; this.pruneExpired(); this.requestPump() }, Math.max(1, expiry - this.now()))
    this.expiryTimer.unref?.()
  }

  private requestPump(): void {
    if (this.pumping || this.stopped) return
    this.pumping = true
    queueMicrotask(() => {
      this.pumping = false
      if (this.stopped) return
      this.pruneExpired()
      while (true) {
        const entry = this.nextRunnable()
        if (!entry) break
        this.queue = this.queue.filter((item) => item !== entry)
        const active: Active = { ...entry, controller: new AbortController(), phase: 'preparing' }
        this.active.set(entry.job.runId, active)
        // Each run awaits media outside admission and outside the player's OBS RPC queue.
        void this.run(active)
      }
      this.scheduleExpiry()
    })
  }

  private nextRunnable(): Entry | undefined {
    const active = [...this.active.values()]
    if (active.some((entry) => entry.job.group.concurrency === 'serialize')) return
    const barrier = this.queue.filter((entry) => entry.job.group.concurrency === 'serialize').sort((a, b) => a.order - b.order)[0]
    const shared = this.queue.filter((entry) => entry.job.group.concurrency !== 'serialize' && (!barrier || entry.order < barrier.order))
      .filter((entry) => entry.slots.every((slot) => !this.quarantine.has(slot) && !active.some((run) => run.slots.includes(slot))))
      .sort((a, b) => this.compare(a, b))
    if (shared.length) return shared[0]
    if (barrier && !active.length && !this.quarantine.size && !this.queue.some((entry) => entry.order < barrier.order)) return barrier
  }

  private async run(entry: Active): Promise<void> {
    let failure: unknown
    let skipped: string | undefined
    let phase: 'audit' | 'play' = 'audit'
    try {
      await entry.audit
      if (entry.controller.signal.aborted) return
      skipped = this.beforePlayReason(entry)
      if (skipped) return
      await this.record(entry, 'preparing')
      if (entry.controller.signal.aborted) return
      skipped = this.beforePlayReason(entry)
      if (skipped) return
      phase = 'play'
      entry.playInvoked = true
      await this.options.play(entry.job, entry.controller.signal, (detail) => {
        if (entry.controller.signal.aborted || this.active.get(entry.job.runId) !== entry) return Promise.reject(Object.assign(new Error('Run is no longer active'), { code: 'INTERRUPTED' }))
        if (!entry.startedAudit) {
          entry.phase = 'started'
          entry.startedAt = this.now()
          entry.startedAudit = this.record(entry, 'started', undefined, detail)
        }
        return entry.startedAudit
      })
      if (entry.startedAudit) await entry.startedAudit
      if (!entry.startedAudit && !entry.controller.signal.aborted) failure = Object.assign(new Error('Player returned without confirming start'), { code: 'START_NOT_CONFIRMED' })
    } catch (error) {
      failure = error
    } finally {
      if (cleanupFailed(failure)) {
        for (const slot of entry.slots) this.quarantine.set(slot, { slot, runId: entry.job.runId, groupId: entry.job.group.groupId,
          accountId: entry.job.accountId, generation: entry.job.generation, reason: message(failure) })
      }
      const aborted = entry.controller.signal.aborted
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : undefined
      const reason = aborted ? entry.stopReason ?? 'INTERRUPTED' : skipped ?? (failure ? phase === 'audit' ? 'AUDIT_FAILED' : code ?? 'PLAY_FAILED' : undefined)
      await this.terminal(entry, aborted ? 'interrupted' : skipped ? 'skipped' : failure ? 'failed' : 'completed', reason,
        failure ? { error: message(failure), cleanupFailed: cleanupFailed(failure) } : undefined)
      if (this.active.get(entry.job.runId) === entry) this.active.delete(entry.job.runId)
      entry.resolveDone()
      this.requestPump()
    }
  }

  private beforePlayReason(entry: Active): string | undefined {
    if (entry.beforePlayReason) return entry.beforePlayReason
    if (entry.expiresAt <= this.now()) return 'EXPIRED'
    if (this.retiring.has(entry.job.group.groupId)) return 'GROUP_RETIRED'
    const config = this.configs.get(entry.job.accountId)
    if (!config?.enabled || !config.groups.some((group) => group.groupId === entry.job.group.groupId && group.enabled)) return 'GROUP_DISABLED'
    if (config.revision !== entry.job.configRevision) return 'CONFIG_CHANGED'
  }

  private record(entry: Entry, status: EffectGroupRunEvent['status'], reason?: string, detail?: Record<string, unknown>): Promise<void> {
    const event: EffectGroupRunEvent = snapshot({ runId: entry.job.runId, accountId: entry.job.accountId, groupId: entry.job.group.groupId,
      eventId: entry.job.eventId, at: this.now(), status, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) })
    const emit = async () => {
      try { await this.options.onEvent(event) }
      catch (error) {
        this.auditFailures.push({ runId: event.runId, status, at: event.at, error: message(error) })
        if (this.auditFailures.length > 256) this.auditFailures.shift()
        throw Object.assign(new Error(message(error)), { code: 'AUDIT_FAILED' })
      }
    }
    const audit = entry.audit.then(emit, emit)
    entry.audit = audit
    const settled = audit.catch(() => {})
    this.pendingAudits.add(settled)
    void settled.then(() => this.pendingAudits.delete(settled))
    return audit
  }

  private terminal(entry: Entry, status: 'completed' | 'failed' | 'skipped' | 'interrupted', reason?: string, detail?: Record<string, unknown>): Promise<void> {
    if (entry.terminal) return entry.audit.catch(() => {})
    entry.terminal = true
    return this.record(entry, status, reason, detail).catch(() => {})
  }

  private async flushAudits(): Promise<void> {
    while (this.pendingAudits.size) await Promise.all([...this.pendingAudits])
  }
}
