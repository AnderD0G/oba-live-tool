export interface TikTokDecodedEvidence {
  format: 'tiktok-decoded-v1'
  provenance: 'sdk-decoded'
  complete: boolean
  json: string
  protobufBase64?: string
  removedPaths?: string[]
}

export interface TikTokDecodedEvidenceResult {
  evidence?: TikTokDecodedEvidence
  errorCode?: 'PAYLOAD_LIMIT' | 'SERIALIZE_FAILED'
}

const MAX_BYTES = 128 * 1024
const MAX_DEPTH = 16
const MAX_REMOVED_PATHS = 1000
const MAX_PATH_BYTES = 4096
const AUTH_KEYS = new Set([
  'auth', 'session', 'cookie', 'cookies', 'authorization', 'password', 'secret',
  'credential', 'credentials', 'apikey', 'headers', 'requestheaders',
  'connectionoptions', 'requestoptions',
])

/** Exact matches only: ordinary provider URL, token and sessionId fields remain business data. */
export function isOriginalAuthKey(key: string): boolean {
  return AUTH_KEYS.has(key.normalize('NFKC').toLowerCase().replace(/[\s_.-]/g, ''))
}

// Audited against installed tiktok-live-proto@0.2.4/v3: these decoders expose a
// direct `user` field. Keep unknown future schemas closed until explicitly audited.
const nativeUserSchemas = new Set([
  'WebcastBarrageMessage', 'WebcastChatMessage', 'WebcastEmoteChatMessage',
  'WebcastGiftMessage', 'WebcastLikeMessage', 'WebcastLiveIntroMessage',
  'WebcastMemberMessage', 'WebcastRoomNotifyMessage', 'WebcastSocialMessage',
  'WebcastSubNotifyMessage',
])
/**
 * The installed v3 User schema declares secret:number (int32), default 0.
 * Only its 0/1 flag at the direct native user path is business data. Unknown
 * schemas/paths and every string/other numeric value retain the credential policy.
 */
export function isOriginalAuthField(key: string, path: string, value: unknown, eventType: string): boolean {
  if (!isOriginalAuthKey(key)) return false
  if (key !== 'secret' || path !== '/data/user/secret' || (value !== 0 && value !== 1) ||
    !/^Webcast[A-Za-z0-9_]{1,72}$/.test(eventType)) return true
  return !nativeUserSchemas.has(eventType)
}

class EvidenceFailure extends Error {
  constructor(readonly code: 'PAYLOAD_LIMIT' | 'SERIALIZE_FAILED') {
    super(code)
  }
}

function fail(): never {
  throw new EvidenceFailure('SERIALIZE_FAILED')
}

function pointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Use native typed-array accessors instead of provider-supplied shadow properties.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!

/**
 * Serialize the SDK's complete { type, data } wrapper, never a normalized comment or HTTP options.
 * Undefined uses JSON semantics; binary values have an explicit base64 representation.
 * Limits or unsupported values reject the whole item. Auth redactions are explicitly incomplete.
 */
export function serializeTikTokDecodedEvidence(
  type: string,
  event: unknown,
  binary?: Uint8Array,
): TikTokDecodedEvidenceResult {
  try {
    if (typeof type !== 'string' || type.length > 128 || !type.trim() || Buffer.byteLength(type) > 128 || !isPlainObject(event))
      fail()
    const typeDescriptor = Object.getOwnPropertyDescriptor(event, 'type')
    const dataDescriptor = Object.getOwnPropertyDescriptor(event, 'data')
    if (
      !typeDescriptor?.enumerable || !('value' in typeDescriptor) || typeDescriptor.value !== type ||
      !dataDescriptor?.enumerable || !('value' in dataDescriptor) || !isPlainObject(dataDescriptor.value)
    ) fail()

    let used = 0
    const chunks: string[] = []
    const active = new Set<object>()
    const removedPaths: string[] = []
    const reserve = (bytes: number) => {
      used += bytes
      if (used > MAX_BYTES) throw new EvidenceFailure('PAYLOAD_LIMIT')
    }
    const quote = (value: string): string => {
      // A character requires at least one JSON byte. Bound escaping allocation before stringify.
      if (value.length > MAX_BYTES) throw new EvidenceFailure('PAYLOAD_LIMIT')
      return JSON.stringify(value)
    }
    const append = (value: string) => {
      reserve(Buffer.byteLength(value))
      chunks.push(value)
    }
    const remove = (path: string) => {
      if (removedPaths.length >= MAX_REMOVED_PATHS || Buffer.byteLength(path) > MAX_PATH_BYTES)
        throw new EvidenceFailure('PAYLOAD_LIMIT')
      reserve(Buffer.byteLength(quote(path)) + 1)
      removedPaths.push(path)
    }
    const base64 = (value: Uint8Array): string => {
      if (!(value instanceof Uint8Array)) fail()
      const length = byteLength.call(value) as number
      reserve(Math.ceil(length / 3) * 4)
      return Buffer.from(
        arrayBuffer.call(value) as ArrayBuffer,
        byteOffset.call(value) as number,
        length,
      ).toString('base64')
    }

    const write = (value: unknown, depth: number, path: string): void => {
      if (depth > MAX_DEPTH) throw new EvidenceFailure('PAYLOAD_LIMIT')
      if (value === null || typeof value === 'boolean') {
        append(JSON.stringify(value))
        return
      }
      if (typeof value === 'string') {
        append(quote(value))
        return
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail()
        append(JSON.stringify(value))
        return
      }
      if (!value || typeof value !== 'object' || active.has(value)) fail()
      if (value instanceof Uint8Array) {
        if (depth + 1 > MAX_DEPTH) throw new EvidenceFailure('PAYLOAD_LIMIT')
        // Reject oversized byte views before Reflect.ownKeys allocates their indexed key list.
        const encoded = base64(value)
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) continue
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!
          if (!descriptor.enumerable) continue
          if (typeof key !== 'string') fail()
          if (key.length > MAX_BYTES) throw new EvidenceFailure('PAYLOAD_LIMIT')
          if (isOriginalAuthKey(key)) remove(`${path}/${pointer(key)}`)
          else fail()
        }
        // The base64 byte count was already reserved, so append only the surrounding syntax.
        append('{"$type":"binary","encoding":"base64","base64":"')
        chunks.push(encoded)
        append('"}')
        return
      }
      if (!Array.isArray(value) && !isPlainObject(value)) fail()
      active.add(value)
      try {
        if (Array.isArray(value)) {
          const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number
          if (length > MAX_BYTES / 2) throw new EvidenceFailure('PAYLOAD_LIMIT')
          for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!
            if (!descriptor.enumerable) continue
            if (typeof key !== 'string') fail()
            if (key.length > MAX_BYTES) throw new EvidenceFailure('PAYLOAD_LIMIT')
            if (isOriginalAuthKey(key)) remove(`${path}/${pointer(key)}`)
            else if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) fail()
          }
          append('[')
          for (let index = 0; index < length; index++) {
            if (index) append(',')
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
            if (descriptor && !('value' in descriptor)) fail()
            write(descriptor?.value === undefined ? null : descriptor.value, depth + 1, `${path}/${index}`)
          }
          append(']')
        } else {
          append('{')
          let first = true
          for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!
            if (!descriptor.enumerable) continue
            if (typeof key !== 'string') fail()
            if (key.length > MAX_BYTES) throw new EvidenceFailure('PAYLOAD_LIMIT')
            const childPath = `${path}/${pointer(key)}`
            if (isOriginalAuthField(key, childPath, 'value' in descriptor ? descriptor.value : undefined, type)) {
              remove(childPath)
              continue
            }
            if (!('value' in descriptor)) fail()
            if (descriptor.value === undefined) continue
            if (!first) append(',')
            first = false
            append(quote(key))
            append(':')
            write(descriptor.value, depth + 1, childPath)
          }
          append('}')
        }
      } finally {
        active.delete(value)
      }
    }

    write(event, 0, '')
    const evidence: TikTokDecodedEvidence = {
      format: 'tiktok-decoded-v1',
      provenance: 'sdk-decoded',
      complete: removedPaths.length === 0,
      json: chunks.join(''),
    }
    if (removedPaths.length) evidence.removedPaths = removedPaths
    // Redacted decoded data must not retain the same private fields in the undecodable raw bytes.
    else if (binary !== undefined) evidence.protobufBase64 = base64(binary)
    if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_BYTES)
      throw new EvidenceFailure('PAYLOAD_LIMIT')
    return { evidence }
  } catch (error) {
    return { errorCode: error instanceof EvidenceFailure ? error.code : 'SERIALIZE_FAILED' }
  }
}

