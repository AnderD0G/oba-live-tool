import type { AnalysisScope, MappingScope } from '../../../../shared/analysisRoom'
import { analysisId, analysisString, validateAnalysisScope, validateMappingScope } from '../../../../shared/analysisRoom'
import { types } from 'node:util'

/** Internal owner boundary only; this unit does not open or authorize a database. */
export type CaptureMetadataOwner =
  | Readonly<{ kind: 'account'; accountId: string }>
  | Readonly<{ kind: 'mapping'; platform: MappingScope['platform']; source: MappingScope['source'] }>
  | Readonly<{ kind: 'job'; scope: Readonly<AnalysisScope>; jobId: string }>

export class CaptureMetadataOwnerError extends Error {
  readonly code = 'METADATA_OWNER_INVALID'
  constructor() { super('Invalid metadata owner') }
}

function ownObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new CaptureMetadataOwnerError()
  const names = Reflect.ownKeys(input)
  if (names.length !== keys.length || names.some(name => typeof name !== 'string' || !keys.includes(name))) {
    throw new CaptureMetadataOwnerError()
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new CaptureMetadataOwnerError()
    result[key] = descriptor.value
  }
  return result
}

export function normalizeCaptureMetadataOwner(input: unknown): CaptureMetadataOwner {
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input)) throw new CaptureMetadataOwnerError()
    const kind = Object.getOwnPropertyDescriptor(input, 'kind')
    if (!kind || !kind.enumerable || !('value' in kind)) throw new CaptureMetadataOwnerError()
    if (kind.value === 'account') {
      const value = ownObject(input, ['kind', 'accountId'])
      return Object.freeze({ kind: 'account', accountId: analysisString(value.accountId) })
    }
    if (kind.value === 'mapping') {
      const value = ownObject(input, ['kind', 'platform', 'source'])
      return Object.freeze({ kind: 'mapping', ...validateMappingScope(value) })
    }
    if (kind.value === 'job') {
      const value = ownObject(input, ['kind', 'scope', 'jobId'])
      const scoped = ownObject(value.scope, ['accountId', 'platform', 'source'])
      return Object.freeze({ kind: 'job', scope: Object.freeze(validateAnalysisScope(scoped)), jobId: analysisId(value.jobId) })
    }
    throw new CaptureMetadataOwnerError()
  } catch {
    // Public codes are fixed; no private input, path or nested exception reaches a reply.
    throw new CaptureMetadataOwnerError()
  }
}

export function captureMetadataOwnerKey(input: unknown): string {
  return JSON.stringify(normalizeCaptureMetadataOwner(input))
}
