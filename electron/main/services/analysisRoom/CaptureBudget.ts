import { AnalysisError, type CaptureLimits } from '../../../../shared/analysisRoom'

/** Reserved bytes include queued raw lines and every active session's future terminal metadata. */
export class CaptureBudget {
  rawBytes = 0
  metadataBytes = 0
  private metadataReserved = 0
  private metadataPending = 0
  private metadataFiles = new Map<string, number>()
  constructor(private limits: CaptureLimits) {}
  observeFile(file: string, bytes: number, raw: boolean): void {
    if (raw) this.rawBytes += bytes
    else this.committedMetadata(file, bytes)
  }
  reserveRaw(bytes: number): boolean {
    if (this.rawBytes + bytes > this.limits.maxStorageBytes) return false
    this.rawBytes += bytes
    return true
  }
  releaseRaw(bytes: number): void {
    this.rawBytes = Math.max(0, this.rawBytes - bytes)
  }
  reserveTerminal(bytes: number): void {
    if (
      this.metadataBytes + this.metadataReserved + this.metadataPending + bytes >
      this.limits.maxMetadataBytes
    ) {
      throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '分析室元数据容量不足')
    }
    this.metadataReserved += bytes
  }
  releaseTerminal(bytes: number): void {
    this.metadataReserved = Math.max(0, this.metadataReserved - bytes)
  }
  assertMetadataWrite(bytes: number, credit: number): void {
    if (
      this.metadataBytes + this.metadataReserved + this.metadataPending + bytes - credit >
      this.limits.maxMetadataBytes
    ) {
      throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '分析室元数据容量不足')
    }
  }
  committedMetadata(file: string, bytes: number): void {
    this.metadataBytes += bytes - (this.metadataFiles.get(file) ?? 0)
    this.metadataFiles.set(file, bytes)
  }
  reserveMetadataWrite(bytes: number, credit: number): () => void {
    this.assertMetadataWrite(bytes, credit)
    const pending = Math.max(0, bytes - credit)
    this.metadataPending += pending
    return () => {
      this.metadataPending = Math.max(0, this.metadataPending - pending)
    }
  }
}
