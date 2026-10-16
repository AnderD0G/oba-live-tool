import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BusinessObservation } from '../../../../shared/analysisRoom'

const WINDOW_MS = 20000
const MAX_RECEIPTS = 2048
const MAX_PENDING_DOM = 256
const MAX_PENDING_WRITES = 128
type NativeProvenance = 'sdk-decoded' | 'cdp-http-decoded' | 'cdp-websocket-decoded'
const NATIVE_PROVENANCES: readonly NativeProvenance[] = ['sdk-decoded', 'cdp-http-decoded', 'cdp-websocket-decoded']

export interface CaptureSourceAuditSnapshot {
  /** Tentative event correspondences; this is never a count of verified people. */
  matched: number
  domOnly: number
  ambiguous: number
  incomplete: number
  pending: number
  pendingWrites: number
  error?: string
}
interface Receipt {
  accountId: string
  streamId: string
  roomId: string
  group: string
  observationId: string
  sourceMessageId?: string
  sequence: number
  receivedAt: number
  provenance: NativeProvenance | 'dom-observation'
  kind: 'native' | 'dom'
  text?: string
  displayName?: string
  userId?: string
  handle?: string
  complete: boolean
  translatedLooking: boolean
  countedIncomplete: boolean
  settled: boolean
  nativeConsumed: boolean
  nativeIdentityKey?: string
}
interface Discrepancy {
  kind: 'dom-only-unverified'
  evidence: 'discrepancy'
  accountId: string
  platform: 'tiktok'
  source: 'control'
  streamId: string
  roomId: string
  observationId: string
  sourceMessageId?: string
  sequence: number
  observedAt: number
  checkedAt: number
  windowMs: number
  originalDomText: string
  publicDisplayName?: string
  nativeProvenancesObserved: NativeProvenance[]
  nativeEvidenceRoute: 'browser-native-decoded' | 'sdk-and-browser-native-decoded' | 'sdk-decoded' | 'not-observed'
  canonicalNativeFallback: 'browser-native-decoded'
  canonicalNativeRouteSelectionVerified: false
  qualifications: string[]
  sdkLossProven: false
  viewerIdentityProven: false
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function literal(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length <= maximum && value.trim() ? value : undefined
}
function positiveRoom(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,256}$/.test(value) && /[1-9]/.test(value)
}

/**
 * Passive, one-way comparison of sanitized business observations. It never reads private
 * original evidence, produces canonical comments, identifies viewers, or requests translation.
 * The full DOM window is observed before settling a one-to-one tentative correspondence.
 */
export class CaptureSourceAudit {
  private readonly directory: string
  private readonly now: () => number
  private readonly timer: ReturnType<typeof setInterval>
  private readonly accounts = new Map<string, CaptureSourceAuditSnapshot>()
  private receipts: Receipt[] = []
  private lastNow?: number
  private blockedUntil = 0
  private pendingWrites = 0
  private writeTail: Promise<void> = Promise.resolve()
  private closed = false
  private shutdownTask?: Promise<void>

  constructor(options: { directory: string; now?: () => number }) {
    this.directory = options.directory
    this.now = options.now ?? Date.now
    this.timer = setInterval(() => {
      const now = this.clock()
      if (now !== undefined) this.sweep(now)
    }, 5000)
    this.timer.unref?.()
  }

  private account(accountId: string): CaptureSourceAuditSnapshot {
    let state = this.accounts.get(accountId)
    if (!state) {
      state = { matched: 0, domOnly: 0, ambiguous: 0, incomplete: 0, pending: 0, pendingWrites: 0 }
      this.accounts.set(accountId, state)
    }
    return state
  }

  private incomplete(receipt: Receipt) {
    if (receipt.countedIncomplete) return
    this.account(receipt.accountId).incomplete++
    receipt.countedIncomplete = true
  }

  /** Unknown coverage blocks comparison, rather than silently discarding a possible counterpart. */
  private invalidate(now: number) {
    for (const receipt of this.receipts) if (receipt.kind === 'dom' && !receipt.settled) {
      this.incomplete(receipt)
      this.account(receipt.accountId).pending--
    }
    this.receipts = []
    this.blockedUntil = now + WINDOW_MS
  }

  private clock(): number | undefined {
    const now = this.now()
    if (!Number.isFinite(now) || now <= 0 || now > 8640000000000000) {
      this.invalidate(this.lastNow ?? 0)
      return undefined
    }
    if (this.lastNow !== undefined && now < this.lastNow) this.invalidate(now)
    this.lastNow = now
    return now
  }

  observe(input: BusinessObservation): void {
    if (this.closed || input?.scope?.platform !== 'tiktok' || input.scope.source !== 'control') return
    const kind = input.businessType === 'TikTokDomComment' && input.provenance === 'dom-observation' ? 'dom'
      : input.businessType === 'WebcastChatMessage' && NATIVE_PROVENANCES.includes(input.provenance as NativeProvenance) ? 'native' : undefined
    const accountId = literal(input.scope.accountId, 256)
    const streamId = literal(input.streamId, 512)
    const observationId = literal(input.observationId, 256)
    if (!kind || !accountId || !streamId || !observationId || !positiveRoom(input.roomId) ||
      !Number.isFinite(input.receivedAt) || input.receivedAt <= 0) return
    const state = this.account(accountId)
    const now = this.clock()
    if (now === undefined || now < this.blockedUntil || input.receivedAt > now + 5000 || now - input.receivedAt > WINDOW_MS) {
      state.incomplete++
      return
    }
    // Settle expired windows before accepting a receipt outside their time range.
    this.sweep(now, false)
    const group = JSON.stringify([accountId, 'tiktok', 'control', streamId, input.roomId])
    if (this.receipts.some(value => value.group === group && value.observationId === observationId)) return
    if (this.receipts.length >= MAX_RECEIPTS || (kind === 'dom' && this.receipts.filter(value => value.kind === 'dom' && !value.settled).length >= MAX_PENDING_DOM)) {
      this.invalidate(now)
      state.incomplete++
      return
    }
    const data = object(input.data)
    const user = kind === 'native' ? object(data?.user) : undefined
    const text = literal(data?.content, 8000)
    const displayName = literal(kind === 'native' ? user?.nickname : data?.nickName, 1000)
    const rawUserId = literal(kind === 'native' ? user?.id ?? user?.userId : data?.userId, 256)
    // Earlier DOM bridges used userId for a scraped handle. Only a positive protocol
    // ID can participate in an ID comparison; public handles have their own field.
    const userId = kind === 'native' ? rawUserId : positiveRoom(rawUserId) ? rawUserId : undefined
    const handle = literal(kind === 'native' ? user?.uniqueId ?? user?.displayId ?? user?.specialId : data?.handle, 256)
    const receipt: Receipt = {
      accountId, streamId, roomId: input.roomId, group, observationId,
      sourceMessageId: literal(input.sourceMessageId, 256), sequence: input.sequence,
      receivedAt: input.receivedAt, provenance: input.provenance as Receipt['provenance'], kind,
      text, displayName, userId, handle,
      complete: input.complete === true && !input.failureCode && input.truncatedPaths.length === 0 && !!text && !!displayName,
      translatedLooking: kind === 'dom' && (data?.isTranslated === true || data?.translated === true ||
        data?.translationStatus === 'translated' || /(?:^|\n)\s*(?:Translated(?: by| from)?\b|翻译(?:自|结果|后)|See original\b|显示原文)/i.test(text ?? '')),
      countedIncomplete: false, settled: kind === 'native', nativeConsumed: false,
    }
    if (kind === 'native') receipt.nativeConsumed = this.receipts.some(value => value.kind === 'native' &&
      value.nativeConsumed && this.nativeKey(value) === this.nativeKey(receipt))
    if (!receipt.complete) this.incomplete(receipt)
    this.receipts.push(receipt)
    if (kind === 'dom') state.pending++
    this.sweep(now)
  }

  private eligible(dom: Receipt, native: Receipt): boolean {
    if (dom.kind !== 'dom' || native.kind !== 'native' || dom.group !== native.group ||
      !dom.complete || !native.complete || dom.translatedLooking ||
      Math.abs(dom.receivedAt - native.receivedAt) > WINDOW_MS || dom.text !== native.text || dom.displayName !== native.displayName) return false
    if (dom.userId && native.userId && dom.userId !== native.userId) return false
    if (dom.handle && native.handle && dom.handle !== native.handle) return false
    return true
  }

  private nativeKey(receipt: Receipt) {
    return receipt.nativeIdentityKey ??= JSON.stringify([receipt.group, receipt.sourceMessageId ?? receipt.observationId])
  }

  private sweep(now: number, inclusive = true) {
    if (this.closed) return
    for (const dom of this.receipts) {
      if (dom.kind !== 'dom' || dom.settled || now - dom.receivedAt < WINDOW_MS ||
        (!inclusive && now - dom.receivedAt === WINDOW_MS)) continue
      const state = this.account(dom.accountId)
      dom.settled = true
      state.pending--
      const nearby = this.receipts.filter(value => value.kind === 'native' && value.group === dom.group &&
        Math.abs(value.receivedAt - dom.receivedAt) <= WINDOW_MS)
      const byNativeKey = new Map<string, Receipt[]>()
      const candidates = new Map<string, Receipt[]>()
      for (const native of nearby) {
        const key = this.nativeKey(native)
        const shadows = byNativeKey.get(key) ?? []
        shadows.push(native)
        byNativeKey.set(key, shadows)
        if (this.eligible(dom, native)) {
          const prior = candidates.get(key) ?? []
          prior.push(native)
          candidates.set(key, prior)
        }
      }
      // Inspect every shadow of a candidate protocol ID, including ineligible ones,
      // without rescanning all nearby events for each distinct candidate.
      const conflicting = [...candidates.entries()].some(([key, values]) => byNativeKey.get(key)!.some(value =>
        value.text !== values[0].text || value.displayName !== values[0].displayName ||
        value.userId !== values[0].userId || value.handle !== values[0].handle))
      if (conflicting) { this.incomplete(dom); continue }
      if (candidates.size > 0) {
        const sole = candidates.size === 1 ? [...candidates.values()][0] : undefined
        const claimants = sole ? this.receipts.filter(value => value.kind === 'dom' && sole.some(native => this.eligible(value, native))) : []
        if (sole && claimants.length === 1 && !sole.some(value => value.nativeConsumed)) {
          state.matched++
          // Consumption must outlive the matched DOM receipt. Keep it on all
          // retained native shadows of this scoped event, without another cache.
          const key = this.nativeKey(sole[0])
          for (const native of this.receipts) if (native.kind === 'native' && this.nativeKey(native) === key) native.nativeConsumed = true
        } else state.ambiguous++
      } else if (nearby.some(value => !value.complete)) {
        this.incomplete(dom)
      } else if (dom.text) {
        this.enqueue(dom, nearby, now)
      } else {
        this.incomplete(dom)
      }
    }
    // Keep finalized receipts long enough to expose duplicate claims for the entire overlap.
    this.receipts = this.receipts.filter(value => now - value.receivedAt <= WINDOW_MS * 2)
  }

  private enqueue(dom: Receipt, nearby: Receipt[], now: number) {
    const state = this.account(dom.accountId)
    if (this.pendingWrites >= MAX_PENDING_WRITES) { this.incomplete(dom); return }
    const provenances = [...new Set(nearby.map(value => value.provenance as NativeProvenance))].sort()
    const browserNative = provenances.some(value => value.startsWith('cdp-'))
    const sdk = provenances.includes('sdk-decoded')
    const qualifications = ['display-name-not-identity', 'dom-text-may-be-page-translated', 'bounded-comparison-not-sdk-loss-proof']
    if (!dom.userId && !dom.handle) qualifications.push('missing-stable-identity')
    if (!dom.displayName) qualifications.push('missing-display-name')
    if (!dom.complete) qualifications.push('incomplete-parsing')
    if (dom.translatedLooking) qualifications.push('translated-looking-dom')
    const record: Discrepancy = {
      kind: 'dom-only-unverified', evidence: 'discrepancy', accountId: dom.accountId, platform: 'tiktok', source: 'control',
      streamId: dom.streamId, roomId: dom.roomId, observationId: dom.observationId, sourceMessageId: dom.sourceMessageId,
      sequence: dom.sequence, observedAt: dom.receivedAt, checkedAt: now, windowMs: WINDOW_MS,
      originalDomText: dom.text!, publicDisplayName: dom.displayName,
      nativeProvenancesObserved: provenances,
      nativeEvidenceRoute: browserNative ? sdk ? 'sdk-and-browser-native-decoded' : 'browser-native-decoded' : sdk ? 'sdk-decoded' : 'not-observed',
      canonicalNativeFallback: 'browser-native-decoded', canonicalNativeRouteSelectionVerified: false,
      qualifications, sdkLossProven: false, viewerIdentityProven: false,
    }
    const day = new Date(now).toISOString().slice(0, 10)
    const line = `${JSON.stringify(record)}\n`
    this.pendingWrites++
    state.pendingWrites++
    this.writeTail = this.writeTail.then(async () => {
      try {
        await mkdir(this.directory, { recursive: true })
        await appendFile(join(this.directory, `${day}.jsonl`), line, 'utf8')
        state.domOnly++
      } catch {
        this.incomplete(dom)
        state.error = '采集来源校验日志写入失败，请检查存储状态'
      } finally {
        this.pendingWrites--
        state.pendingWrites--
      }
    })
  }

  snapshot(accountId: string): CaptureSourceAuditSnapshot {
    const state = this.accounts.get(accountId)
    return state ? { ...state } : { matched: 0, domOnly: 0, ambiguous: 0, incomplete: 0, pending: 0, pendingWrites: 0 }
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.closed = true
    clearInterval(this.timer)
    // An unfinished window is incomplete; shutdown must never manufacture a discrepancy.
    for (const receipt of this.receipts) if (receipt.kind === 'dom' && !receipt.settled) {
      this.incomplete(receipt)
      this.account(receipt.accountId).pending--
    }
    this.receipts = []
    this.shutdownTask = this.writeTail
    return this.shutdownTask
  }
}
