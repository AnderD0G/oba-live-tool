import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type {
  ProtoMessageFetchResult as FetchResult,
  WebcastPushFrame as PushFrame,
} from 'tiktok-live-proto/dist/node/v3.js'
// @ts-expect-error This exports-only SDK entry works in ESM/Vite; this repo's legacy TS resolver cannot resolve it.
import * as Proto from 'tiktok-live-proto/v3'

const { ProtoMessageFetchResult, WebcastPushFrame } = Proto as {
  ProtoMessageFetchResult: { decode(bytes: Uint8Array): FetchResult }
  WebcastPushFrame: { decode(bytes: Uint8Array): PushFrame }
}

export interface TikTokWirePayloadRingSnapshot {
  received: number
  receivedBytes: number
  retained: number
  retainedBytes: number
  skippedOversize: number
  failed: number
  evictedTTL: number
  evictedCapacity: number
  firstReceivedAt: number | null
  lastReceivedAt: number | null
  firstRetainedAt: number | null
  lastRetainedAt: number | null
}

export interface TikTokWireDiagnosticsSnapshot {
  kind: 'sdk-network-snapshot'
  capturedAt: number
  limits: {
    retentionMs: 180000
    maxEntriesPerRing: 256
    maxBytesPerRing: 4194304
    maxFrameBytes: 1048576
    maxInflatedBytes: 1048576
    maxMatches: 20
    maxPayloadsPerFrame: 256
  }
  frames: {
    received: number
    receivedBytes: number
    skippedOversize: number
    decodeFailed: number
    decompressFailed: number
    unsupportedPayloadType: number
    skippedPayloads: number
    firstReceivedAt: number | null
    lastReceivedAt: number | null
    payloads: TikTokWirePayloadRingSnapshot
  }
  decoded: TikTokWirePayloadRingSnapshot
  search?: {
    scope: 'current-retained-payloads'
    wirePayloadContainsMarker: number
    decodedPayloadContainsMarker: number
    truncated: boolean
    matches: Array<{
      source: 'wire' | 'decoded'
      receivedAt: number
      method: string
      payloadBytes: number
      sha256: string
    }>
  }
}

function emptyRing(): TikTokWirePayloadRingSnapshot {
  return {
    received: 0,
    receivedBytes: 0,
    retained: 0,
    retainedBytes: 0,
    skippedOversize: 0,
    failed: 0,
    evictedTTL: 0,
    evictedCapacity: 0,
    firstReceivedAt: null,
    lastReceivedAt: null,
    firstRetainedAt: null,
    lastRetainedAt: null,
  }
}

const LIMITS: TikTokWireDiagnosticsSnapshot['limits'] = {
  retentionMs: 180000,
  maxEntriesPerRing: 256,
  maxBytesPerRing: 4194304,
  maxFrameBytes: 1048576,
  maxInflatedBytes: 1048576,
  maxMatches: 20,
  maxPayloadsPerFrame: 256,
}

interface RetainedPayload {
  receivedAt: number
  method: string
  bytes: Buffer
  sha256: string
}

// Never pass arbitrary provider text (URLs, user labels, credentials) as a method.
function safeMethod(type: string): string {
  return typeof type === 'string' && /^Webcast[A-Za-z0-9_]{1,72}$/.test(type) ? type : 'unknown'
}

class PayloadRing {
  private entries: RetainedPayload[] = []
  private counters = emptyRing()

  add(method: string, binary: Uint8Array, receivedAt: number): void {
    this.expire(receivedAt)
    this.counters.received++
    this.counters.firstReceivedAt ??= receivedAt
    this.counters.lastReceivedAt = receivedAt
    if (!(binary instanceof Uint8Array)) {
      this.counters.failed++
      return
    }
    this.counters.receivedBytes += binary.byteLength
    if (binary.byteLength > LIMITS.maxFrameBytes) {
      this.counters.skippedOversize++
      return
    }
    // Copy only the view's own bytes; the SDK can reuse its backing buffer.
    let bytes: Buffer
    try {
      bytes = Buffer.from(binary)
    } catch {
      this.counters.failed++
      return
    }
    this.entries.push({
      receivedAt,
      method: safeMethod(method),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    this.counters.retainedBytes += bytes.byteLength
    while (
      this.entries.length > LIMITS.maxEntriesPerRing ||
      this.counters.retainedBytes > LIMITS.maxBytesPerRing
    ) {
      const removed = this.entries.shift()
      if (!removed) break
      this.counters.retainedBytes -= removed.bytes.byteLength
      this.counters.evictedCapacity++
    }
  }

  expire(now: number): void {
    this.entries = this.entries.filter(entry => {
      if (now - entry.receivedAt < LIMITS.retentionMs) return true
      this.counters.retainedBytes -= entry.bytes.byteLength
      this.counters.evictedTTL++
      return false
    })
  }

  snapshot(): TikTokWirePayloadRingSnapshot {
    return {
      ...this.counters,
      retained: this.entries.length,
      firstRetainedAt: this.entries[0]?.receivedAt ?? null,
      lastRetainedAt: this.entries.at(-1)?.receivedAt ?? null,
    }
  }

  search(
    marker: Buffer,
    source: 'wire' | 'decoded',
    matches: NonNullable<TikTokWireDiagnosticsSnapshot['search']>['matches'],
  ): number {
    let count = 0
    for (const entry of this.entries) {
      // Search literal UTF8 bytes. Decoding arbitrary protobuf as text could
      // create replacement characters that never existed in the source.
      if (!entry.bytes.includes(marker)) continue
      count++
      if (matches.length < LIMITS.maxMatches) {
        matches.push({
          source,
          receivedAt: entry.receivedAt,
          method: entry.method,
          payloadBytes: entry.bytes.byteLength,
          sha256: entry.sha256,
        })
      }
    }
    return count
  }
}

export class TikTokWireDiagnostics {
  private wire = new PayloadRing()
  private decoded = new PayloadRing()
  private frames = this.emptyFrames()

  constructor(private readonly options: { clock?: () => number } = {}) {}

  observeFrame(frame: Uint8Array): void {
    const now = this.now()
    this.wire.expire(now)
    this.frames.received++
    this.frames.firstReceivedAt ??= now
    this.frames.lastReceivedAt = now
    try {
      if (!(frame instanceof Uint8Array)) {
        this.frames.decodeFailed++
        return
      }
      this.frames.receivedBytes += frame.byteLength
      if (frame.byteLength > LIMITS.maxFrameBytes) {
        this.frames.skippedOversize++
        return
      }
      const outer = WebcastPushFrame.decode(frame)
      // This is the installed connector's format, not payloadType === 'pb'.
      if (outer.payloadEncoding !== 'pb') {
        this.frames.unsupportedPayloadType++
        return
      }
      let payload = outer.payload
      if (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b && payload[2] === 0x08) {
        try {
          payload = gunzipSync(payload, { maxOutputLength: LIMITS.maxInflatedBytes })
        } catch {
          this.frames.decompressFailed++
          return
        }
      }
      const fetchResult = ProtoMessageFetchResult.decode(payload)
      const skipped = Math.max(0, fetchResult.messages.length - LIMITS.maxPayloadsPerFrame)
      this.frames.skippedPayloads += skipped
      for (const message of fetchResult.messages.slice(skipped)) {
        // No inner event decoder. Unknown methods and undecodable inner
        // schemas remain searchable independent of DECODED_DATA emissions.
        this.wire.add(message.method, message.payload, now)
      }
    } catch {
      // Diagnostics must never interrupt the actual SDK listener.
      this.frames.decodeFailed++
    }
  }

  observeDecoded(type: string, binary: Uint8Array): void {
    try {
      this.decoded.add(type, binary, this.now())
    } catch {
      // The typed SDK contract supplies Uint8Array. If it changes, this
      // optional observer still cannot throw into business processing.
    }
  }

  reset(): void {
    this.wire = new PayloadRing()
    this.decoded = new PayloadRing()
    this.frames = this.emptyFrames()
  }

  snapshot(marker?: string): TikTokWireDiagnosticsSnapshot {
    let markerBytes: Buffer | undefined
    if (marker !== undefined) {
      if (typeof marker !== 'string' || marker.length === 0 || Array.from(marker).length > 128) {
        throw new Error('Invalid marker: expected 1..128 Unicode characters')
      }
      markerBytes = Buffer.from(marker, 'utf8')
      if (markerBytes.byteLength > 512 || markerBytes.toString('utf8') !== marker) {
        throw new Error('Invalid marker: expected valid Unicode and at most 512 UTF8 bytes')
      }
    }
    const capturedAt = this.now()
    this.wire.expire(capturedAt)
    this.decoded.expire(capturedAt)
    const snapshot: TikTokWireDiagnosticsSnapshot = {
      kind: 'sdk-network-snapshot',
      capturedAt,
      limits: { ...LIMITS },
      frames: { ...this.frames, payloads: this.wire.snapshot() },
      decoded: this.decoded.snapshot(),
    }
    if (markerBytes) {
      const matches: NonNullable<TikTokWireDiagnosticsSnapshot['search']>['matches'] = []
      const wirePayloadContainsMarker = this.wire.search(markerBytes, 'wire', matches)
      const decodedPayloadContainsMarker = this.decoded.search(markerBytes, 'decoded', matches)
      snapshot.search = {
        scope: 'current-retained-payloads',
        wirePayloadContainsMarker,
        decodedPayloadContainsMarker,
        truncated: wirePayloadContainsMarker + decodedPayloadContainsMarker > matches.length,
        matches,
      }
    }
    return snapshot
  }

  private now(): number {
    try {
      const now = (this.options.clock ?? Date.now)()
      if (Number.isFinite(now)) return now
    } catch {
      // A diagnostic clock failure must not interrupt provider processing.
    }
    return Date.now()
  }

  private emptyFrames(): Omit<TikTokWireDiagnosticsSnapshot['frames'], 'payloads'> {
    return {
      received: 0,
      receivedBytes: 0,
      skippedOversize: 0,
      decodeFailed: 0,
      decompressFailed: 0,
      unsupportedPayloadType: 0,
      skippedPayloads: 0,
      firstReceivedAt: null,
      lastReceivedAt: null,
    }
  }
}
