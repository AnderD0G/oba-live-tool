import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { types } from 'node:util'

export type StagedLiteralSpan = { sourceId: number; startOffset: number; nextOffset: number }
export type StagedLiteral = StagedLiteralSpan & {
  bytes: Buffer; literalSha256: string; sourceSha256: string; fetchedBytes: number;
  payloadByteWork: number; scalarByteWork: number; byteWork: number; queryCount: number;
}
export class CaptureExtentError extends Error {
  constructor(readonly code: string, readonly byteWork = 0) { super(code) }
}
export function readStagedLiteral(
  db: DatabaseSync, input: StagedLiteralSpan, maxSpanBytes: number, remainingByteWork: number,
): StagedLiteral {
  let scalarByteWork = 0, payloadByteWork = 0, queryCount = 0
  const fail: (code: string) => never = code => { throw new CaptureExtentError(code, scalarByteWork + payloadByteWork) }
  const integer = (value: unknown, minimum = 0): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  // Internal capability only. The caller owns schema/family/manifest verification,
  // quiescence and all decoder/validator work outside this byte reader.
  if (!input || typeof input !== 'object' || types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('INVALID_EXTENT')
  const keys = Reflect.ownKeys(input), wanted = ['sourceId', 'startOffset', 'nextOffset']
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !wanted.includes(key))) fail('INVALID_EXTENT')
  for (const key of wanted) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('INVALID_EXTENT')
  }
  const span = { sourceId: input.sourceId, startOffset: input.startOffset, nextOffset: input.nextOffset }
  if (!integer(span.sourceId, 1) || !integer(span.startOffset) || !integer(span.nextOffset, 1) ||
      span.nextOffset <= span.startOffset || !integer(maxSpanBytes, 1) || maxSpanBytes > 131074 ||
      !integer(remainingByteWork) || remainingByteWork > 1048576) fail('INVALID_EXTENT')
  const size = span.nextOffset - span.startOffset
  if (size > maxSpanBytes) fail('EXTENT_LIMIT')
  // Fixed numeric input work avoids making the required allowance depend on its
  // own decimal representation. Scalar accounting is separate from payload work.
  scalarByteWork = 16 + 2 * Buffer.byteLength(JSON.stringify({ span, maxSpanBytes }))
  if (scalarByteWork > remainingByteWork) fail('RESOURCE_WORK_LIMIT')
  const getScalar = (sql: string, ...parameters: number[]): Record<string, unknown> | undefined => {
    if (++queryCount > 12) fail('STAGED_EXTENT_CORRUPT')
    const row = db.prepare(sql).get(...parameters) as Record<string, unknown> | undefined
    // Every selected text value is truncated in SQL; no path/body is selected.
    scalarByteWork += 2 * Buffer.byteLength(JSON.stringify(row ?? null))
    if (scalarByteWork + payloadByteWork > remainingByteWork) fail('RESOURCE_WORK_LIMIT')
    return row
  }
  try {
    for (const [key, expected] of [['status', 'verified'], ['inventory_complete', '1']]) {
      const row = getScalar(`SELECT substr(value,1,33) AS value,length(CAST(value AS BLOB)) AS bytes
        FROM legacy_import_meta WHERE key='${key}'`)
      if (!row || row.value !== expected || row.bytes !== Buffer.byteLength(expected)) fail('STAGE_NOT_VERIFIED')
    }
    const source = getScalar('SELECT size,verified,length(CAST(sha256 AS BLOB)) AS sha_bytes FROM legacy_sources WHERE id=?', span.sourceId)
    if (!source) fail('SOURCE_NOT_FOUND')
    if (source.verified !== 1) fail('STAGE_NOT_VERIFIED')
    if (!integer(source.size) || source.sha_bytes !== 64) fail('STAGED_EXTENT_CORRUPT')
    if (span.nextOffset > source.size) fail('INVALID_EXTENT')
    const hashRow = getScalar('SELECT substr(sha256,1,65) AS sha256 FROM legacy_sources WHERE id=?', span.sourceId)
    if (!hashRow || typeof hashRow.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(hashRow.sha256)) fail('STAGED_EXTENT_CORRUPT')
    type Chunk = { offset: number; nextOffset: number; length: number }
    const chunks: Chunk[] = []
    let lastOffset = span.startOffset, covered = span.startOffset, fetchedBytes = 0
    while (covered < span.nextOffset) {
      const first = chunks.length === 0
      const row = getScalar(`SELECT offset,next_offset,length(bytes) AS byte_length FROM legacy_chunks
        WHERE source_id=? AND offset${first ? '<=' : '>'}? ORDER BY offset${first ? ' DESC' : ''} LIMIT 1`,
        span.sourceId, lastOffset)
      if (!row || !integer(row.offset) || !integer(row.next_offset, 1) || !integer(row.byte_length, 1) ||
          row.byte_length > 65536 || row.next_offset - row.offset !== row.byte_length ||
          row.next_offset > source.size || row.next_offset <= covered ||
          (first ? row.offset > covered : row.offset !== covered)) fail('STAGED_EXTENT_CORRUPT')
      // Short physical chunks are legal. A fifth valid descriptor exceeds this
      // reader's work capability; its preserved evidence is not corrupt.
      if (chunks.length === 4) fail('RESOURCE_WORK_LIMIT')
      chunks.push({ offset: row.offset, nextOffset: row.next_offset, length: row.byte_length })
      fetchedBytes += row.byte_length; covered = row.next_offset; lastOffset = row.offset
    }
    const required = fetchedBytes + 2 * size
    if (scalarByteWork + required > remainingByteWork) fail('RESOURCE_WORK_LIMIT')
    const bytes = Buffer.alloc(size)
    let copied = 0
    for (const chunk of chunks) {
      if (++queryCount > 12) fail('STAGED_EXTENT_CORRUPT')
      const row = db.prepare('SELECT substr(bytes,1,65537) AS bytes FROM legacy_chunks WHERE source_id=? AND offset=?')
        .get(span.sourceId, chunk.offset) as { bytes: Uint8Array } | undefined
      if (!row || !(row.bytes instanceof Uint8Array)) fail('STAGED_EXTENT_CORRUPT')
      payloadByteWork += row.bytes.byteLength
      if (scalarByteWork + payloadByteWork > remainingByteWork) fail('RESOURCE_WORK_LIMIT')
      if (row.bytes.byteLength !== chunk.length) fail('STAGED_EXTENT_CORRUPT')
      const start = Math.max(span.startOffset, chunk.offset), end = Math.min(span.nextOffset, chunk.nextOffset)
      const part = row.bytes.subarray(start - chunk.offset, end - chunk.offset)
      bytes.set(part, start - span.startOffset)
      copied += part.byteLength; payloadByteWork += part.byteLength
    }
    if (copied !== size) fail('STAGED_EXTENT_CORRUPT')
    const literalSha256 = createHash('sha256').update(bytes).digest('hex')
    payloadByteWork += size
    if (payloadByteWork !== required || scalarByteWork + payloadByteWork > remainingByteWork) fail('RESOURCE_WORK_LIMIT')
    return { ...span, bytes, literalSha256, sourceSha256: hashRow.sha256, fetchedBytes,
      payloadByteWork, scalarByteWork, byteWork: scalarByteWork + payloadByteWork, queryCount }
  } catch (error) {
    if (error instanceof CaptureExtentError) throw error
    fail('STAGED_EXTENT_UNAVAILABLE')
  }
}
