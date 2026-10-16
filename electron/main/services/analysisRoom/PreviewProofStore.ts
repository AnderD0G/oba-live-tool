import { createHash, randomUUID } from 'node:crypto'
import {
  AnalysisError,
  assertBoundedJson,
  type JsonValue,
  type PreviewProof,
} from '../../../../shared/analysisRoom'
export type PreviewBinding = { kind: 'dictionary' | 'groups'; [key: string]: JsonValue }
export function previewDigest(value: unknown): string {
  assertBoundedJson(value)
  const canonical = (input: JsonValue): string =>
    input && typeof input === 'object'
      ? Array.isArray(input)
        ? `[${input.map(canonical).join(',')}]`
        : `{${Object.keys(input)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonical(input[key])}`)
            .join(',')}}`
      : JSON.stringify(input)
  return createHash('sha256')
    .update(canonical(value as JsonValue))
    .digest('hex')
}
export class PreviewProofStore {
  private proofs = new Map<
    string,
    { proof: PreviewProof; binding: PreviewBinding; bytes: number }
  >()
  private bytes = 0
  private now: () => number
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }
  issue(binding: PreviewBinding): PreviewProof {
    const digest = previewDigest(binding)
    const bytes = Buffer.byteLength(JSON.stringify(binding))
    if (bytes > 64 * 1024) throw new AnalysisError('ANALYSIS_LIMIT', '预览绑定过大，请使用内容摘要')
    for (const [token, entry] of this.proofs)
      if (entry.proof.expiresAt <= this.now()) {
        this.bytes -= entry.bytes
        this.proofs.delete(token)
      }
    while (this.proofs.size >= 1000 || this.bytes + bytes > 1024 * 1024) {
      const oldest = this.proofs.keys().next().value
      if (oldest === undefined) break
      this.bytes -= this.proofs.get(oldest)?.bytes ?? 0
      this.proofs.delete(oldest)
    }
    const proof = { token: randomUUID(), expiresAt: this.now() + 900000, digest }
    this.proofs.set(proof.token, { proof, binding: structuredClone(binding), bytes })
    this.bytes += bytes
    return { ...proof }
  }
  binding(token: string): PreviewBinding {
    const entry = this.proofs.get(token)
    if (!entry || entry.proof.expiresAt <= this.now())
      throw new AnalysisError('MAPPING_PREVIEW_STALE', '预览已过期或失效，请重新预览')
    return structuredClone(entry.binding)
  }
  assertCurrent(token: string, binding: PreviewBinding): void {
    const actual = this.binding(token)
    if (previewDigest(actual) !== previewDigest(binding))
      throw new AnalysisError('MAPPING_PREVIEW_STALE', '预览内容或依赖已改变，请重新预览')
  }
}
