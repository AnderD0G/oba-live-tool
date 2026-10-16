import type { SanitizedPayload } from '../../../../shared/analysisRoom'
import { sanitizeBusinessPayload } from '../../services/analysisRoom/BusinessPayload'

export interface DecodedBusinessContent {
  payload: SanitizedPayload
  envelope: { msgId: string; roomId: string; ts: number }
  failureCode?: 'PARSE_FAILED' | 'PAYLOAD_LIMIT'
}
export interface DecodedBusinessFrame {
  recognized: boolean
  contents: DecodedBusinessContent[]
  parseFailed: number
  discardedContents?: number
}
const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function identifier(value: unknown): string {
  return typeof value === 'string' && /^[\p{L}\p{N}_.:-]{1,256}$/u.test(value) ? value : ''
}
export function decodeXiaohongshuBusinessFrame(payload: string): DecodedBusinessFrame {
  const result: DecodedBusinessFrame = { recognized: false, contents: [], parseFailed: 0 }
  if (payload.length > MAX_TRANSPORT_BYTES || Buffer.byteLength(payload) > MAX_TRANSPORT_BYTES)
    return result
  let outer: Record<string, unknown> | undefined
  try {
    outer = object(JSON.parse(payload))
  } catch {
    return result
  }
  if (outer?.t !== 4) return result
  const business = object(object(outer.b)?.d)
  if (business?.biz !== 'room') return result
  result.recognized = true
  const fail = (envelope = { msgId: '', roomId: '', ts: 0 }) => {
    result.parseFailed++
    result.contents.push({
      payload: { data: null, complete: false, removedPaths: [], truncatedPaths: [] },
      envelope,
      failureCode: 'PARSE_FAILED',
    })
  }
  if (!Array.isArray(business.b)) {
    fail()
    return result
  }
  for (const content of business.b.slice(0, 1000)) {
    const encoded = object(content)?.d
    if (
      typeof encoded !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length % 4 !== 0
    ) {
      fail()
      continue
    }
    let inner: Record<string, unknown> | undefined
    try {
      inner = object(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')))
    } catch {
      fail()
      continue
    }
    if (inner?.command !== 1) continue
    const envelope = {
      msgId: identifier(inner.msgId),
      roomId: identifier(inner.roomId),
      ts:
        typeof inner.ts === 'number' && Number.isSafeInteger(inner.ts) && inner.ts > 0
          ? inner.ts
          : 0,
    }
    if (typeof inner.customData !== 'string') {
      fail(envelope)
      continue
    }
    try {
      const sanitized = sanitizeBusinessPayload(JSON.parse(inner.customData))
      result.contents.push({
        payload: sanitized,
        envelope,
        ...(sanitized.complete ? {} : { failureCode: 'PAYLOAD_LIMIT' as const }),
      })
    } catch {
      fail(envelope)
    }
  }
  if (business.b.length > 1000) {
    result.discardedContents = business.b.length - 1000
    result.contents.push({
      payload: { data: null, complete: false, removedPaths: [], truncatedPaths: [''] },
      envelope: { msgId: '', roomId: '', ts: 0 },
      failureCode: 'PAYLOAD_LIMIT',
    })
  }
  return result
}
