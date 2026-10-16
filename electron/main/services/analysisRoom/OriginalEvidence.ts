import type { JsonValue, OriginalBusinessEvidence, OriginalEvidenceSummary } from '../../../../shared/analysisRoom'
import { analysisInteger } from '../../../../shared/analysisRoom'
import { isOriginalAuthField } from '../../platforms/tiktok/decodedEvidence'

export function emptyOriginalSummary(): OriginalEvidenceSummary {
  return { file: 'originals.jsonl', received: 0, saved: 0, dropped: 0, pending: 0, bytes: 0, redacted: 0 }
}

export function originalSummaryFromDisk(input: OriginalEvidenceSummary): OriginalEvidenceSummary {
  if (input.file !== 'originals.jsonl') throw new Error('invalid original file')
  const output = emptyOriginalSummary()
  for (const key of ['received', 'saved', 'dropped', 'pending', 'bytes', 'redacted'] as const) {
    analysisInteger(input[key])
    output[key] = input[key]
  }
  if (input.error !== undefined) {
    if (!/^[A-Z_]{1,128}$/.test(input.error)) throw new Error('invalid original error')
    output.error = input.error
  }
  return output
}

/** Only decoded native business event JSON reaches this boundary; credentials are never an evidence source. */
export function originalData(input: OriginalBusinessEvidence, maxBytes: number, maxDepth: number): JsonValue {
  if (input.format !== 'tiktok-decoded-v1' || !['sdk-decoded', 'cdp-websocket-decoded', 'cdp-http-decoded'].includes(input.provenance) || typeof input.complete !== 'boolean' || typeof input.json !== 'string')
    throw new Error('INVALID_ORIGINAL')
  if (Buffer.byteLength(input.json) > maxBytes) throw new Error('ORIGINAL_LIMIT')
  if (input.protobufBase64 !== undefined && (typeof input.protobufBase64 !== 'string' || input.protobufBase64.length > maxBytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.protobufBase64)))
    throw new Error('INVALID_ORIGINAL')
  if (input.removedPaths !== undefined && (!Array.isArray(input.removedPaths) || input.removedPaths.length > 1000 || input.removedPaths.some(path => typeof path !== 'string' || Buffer.byteLength(path) > 4096)))
    throw new Error('INVALID_ORIGINAL')
  if (input.removedPaths?.length && (input.complete || input.protobufBase64 !== undefined)) throw new Error('INVALID_ORIGINAL')
  const data: JsonValue = JSON.parse(input.json)
  const eventType = data && typeof data === 'object' && !Array.isArray(data) && typeof data.type === 'string' ? data.type : ''
  const stack = [{ value: data, depth: 0, path: '' }]
  while (stack.length) {
    const { value, depth, path } = stack.pop()!
    if (depth > maxDepth) throw new Error('ORIGINAL_LIMIT')
    if (!value || typeof value !== 'object') continue
    for (const key of Object.keys(value)) {
      const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
      const child = (value as Record<string, JsonValue>)[key]
      if (isOriginalAuthField(key, childPath, child, eventType)) throw new Error('INVALID_ORIGINAL')
      stack.push({ value: child, depth: depth + 1, path: childPath })
    }
  }
  return data
}
