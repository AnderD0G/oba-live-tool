import { join } from 'node:path'
import {
  AnalysisError,
  type AnalysisParameters,
  analysisId,
  analysisInteger,
  type MappingScope,
  validateAnalysisScope,
  validateMappingScope,
} from '../../../../shared/analysisRoom'
import type {
  AttributeDictionaryDraft,
  DictionaryPreview,
  DictionaryState,
  PublishedAttributeDictionary,
} from '../../../../shared/audienceAttributes'
import type { AnalysisCaptureStore } from './AnalysisCaptureStore'
import type { SqliteAnalysisCaptureStore } from './SqliteAnalysisCaptureStore'
import { mapObservation, validateAttributeDraft } from './AttributeMapper'
import { type PreviewBinding, PreviewProofStore, previewDigest } from './PreviewProofStore'

interface DictionaryLedger {
  revision: number
  draft: AttributeDictionaryDraft
  activeVersion?: number
  versions: Array<PublishedAttributeDictionary | Pick<PublishedAttributeDictionary, 'version' | 'publishedAt' | 'acceptedFormatVersions'>>
}
interface DictionaryOptions {
  store: AnalysisCaptureStore
  proofs?: PreviewProofStore
  enabledGroupReferences?: (
    platform: LiveControlPlatform,
    source: MappingScope['source'],
  ) => { revision: string; accountIds: string[] }
  formatVersion?: (scope: MappingScope) => number | undefined
  onPublished?: (dictionary: PublishedAttributeDictionary) => void
  now?: () => number
}
export class AttributeDictionaryService {
  readonly ready: Promise<void>
  private ledgers = new Map<string, DictionaryLedger>()
  private loaded = false
  private proofs: PreviewProofStore
  constructor(private options: DictionaryOptions) {
    this.proofs = options.proofs ?? new PreviewProofStore({ now: options.now })
    this.ready = this.initialize()
    this.ready.catch(() => {})
  }
  private get sql() {
    return (this.options.store as AnalysisCaptureStore & { sqlite?: SqliteAnalysisCaptureStore['sqlite'] }).sqlite
  }
  private key(platform: LiveControlPlatform, source: MappingScope['source']): string {
    validateMappingScope({ platform, source })
    return `${platform}-${source}`
  }
  private file(platform: LiveControlPlatform, source: MappingScope['source']): string {
    return join(this.options.store.root, 'dictionaries', `${this.key(platform, source)}.json`)
  }
  private ledger(platform: LiveControlPlatform, source: MappingScope['source']): DictionaryLedger {
    if (!this.loaded) throw new AnalysisError('ANALYSIS_UNAVAILABLE', '属性字典尚未初始化')
    const key = this.key(platform, source)
    if (this.sql) {
      const saved = this.sql.readDictionary(platform, source) as DictionaryLedger | undefined
      if (saved) {
        analysisInteger(saved.revision)
        const draft = validateAttributeDraft(saved.draft)
        if (!Array.isArray(saved.versions) || saved.versions.length > 100)
          throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '字典版本目录无效')
        let last = 0
        for (const summary of saved.versions) {
          analysisInteger(summary.version, 1); analysisInteger(summary.publishedAt)
          if (summary.version <= last || !Array.isArray(summary.acceptedFormatVersions) || !summary.acceptedFormatVersions.length || summary.acceptedFormatVersions.length > 16)
            throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '字典版本目录无效')
          summary.acceptedFormatVersions.forEach(value => analysisInteger(value, 1))
          last = summary.version
        }
        if (saved.activeVersion !== undefined) analysisInteger(saved.activeVersion, 1)
        if (last ? saved.activeVersion !== last : saved.activeVersion !== undefined)
          throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '字典已发布版本指针无效')
        return { ...saved, draft }
      }
      return { revision: 0, draft: { identity: { userIdPath: '/__not_configured__' }, definitions: [], acceptedFormatVersions: [1] }, versions: [] }
    }
    if (!this.ledgers.has(key))
      this.ledgers.set(key, {
        revision: 0,
        draft: {
          identity: { userIdPath: '/__not_configured__' },
          definitions: [],
          acceptedFormatVersions: [1],
        },
        versions: [],
      })
    const ledger = this.ledgers.get(key)
    if (!ledger) throw new AnalysisError('ANALYSIS_INTERNAL', '字典不可用')
    return ledger
  }
  private async initialize(): Promise<void> {
    const store = this.options.store
    await store.recover()
    if (this.sql) { this.loaded = true; return }
    for (const name of await store.io.list(join(store.root, 'dictionaries'))) {
      if (!name.endsWith('.json') || name.includes('.pending-')) continue
      const match = /^(.*)-(control|compass)\.json$/.exec(name)
      if (!match) continue
      try {
        const scope = validateMappingScope({ platform: match[1], source: match[2] })
        const file = this.file(scope.platform, scope.source)
        await store.safePath(file)
        if ((await store.io.size(file)) > store.limits.maxMetadataBytes)
          throw new Error('dictionary bytes')
        const parsed = JSON.parse(await store.io.read(file)) as Omit<DictionaryLedger, 'versions'> & { versions: PublishedAttributeDictionary[] }
        analysisInteger(parsed.revision)
        const draft = validateAttributeDraft(parsed.draft)
        if (!Array.isArray(parsed.versions)) throw new Error('versions')
        const versions: PublishedAttributeDictionary[] = []
        for (const version of parsed.versions) {
          if (
            version.platform !== scope.platform ||
            version.source !== scope.source ||
            version.version !== versions.length + 1
          )
            throw new Error('version scope/order')
          analysisInteger(version.publishedAt)
          versions.push({
            ...validateAttributeDraft(version),
            ...scope,
            version: version.version,
            publishedAt: version.publishedAt,
          })
          if (versions.length % 200 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        }
        if (
          (versions.length > 0 && parsed.activeVersion !== versions.length) ||
          (versions.length === 0 && parsed.activeVersion !== undefined)
        )
          throw new Error('active pointer')
        this.ledgers.set(this.key(scope.platform, scope.source), {
          revision: parsed.revision,
          draft,
          versions,
          ...(parsed.activeVersion === undefined ? {} : { activeVersion: parsed.activeVersion }),
        })
      } catch {
        throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '字典文件损坏或不兼容；已保留原始证据')
      }
    }
    this.loaded = true
  }
  read(
    platform: LiveControlPlatform,
    source: MappingScope['source'],
    version?: number,
  ): DictionaryState {
    const ledger = this.ledger(platform, source)
    const selectedVersion =
      version === undefined
        ? undefined
        : this.published(platform, source, analysisInteger(version, 1))
    if (version !== undefined && !selectedVersion)
      throw new AnalysisError('ANALYSIS_NOT_FOUND', '字典版本不存在')
    return structuredClone({
      revision: ledger.revision,
      draft: ledger.draft,
      ...(selectedVersion ? { selectedVersion } : {}),
      ...(ledger.activeVersion === undefined ? {} : { activeVersion: ledger.activeVersion }),
      versions: ledger.versions.map(({ version, publishedAt, acceptedFormatVersions }) => ({
        version,
        publishedAt,
        acceptedFormatVersions,
      })),
    })
  }
  published(
    platform: LiveControlPlatform,
    source: MappingScope['source'],
    version?: number,
  ): PublishedAttributeDictionary | undefined {
    const ledger = this.ledger(platform, source)
    if (this.sql) {
      const selected = version ?? ledger.activeVersion
      if (selected === undefined) return undefined
      analysisInteger(selected, 1)
      const saved = this.sql.readDictionaryVersion(platform, source, selected) as PublishedAttributeDictionary | undefined
      if (!saved) return undefined
      if (saved.platform !== platform || saved.source !== source || saved.version !== selected)
        throw new AnalysisError('ANALYSIS_STORAGE_FAILED', '字典版本范围无效')
      analysisInteger(saved.publishedAt)
      return { ...validateAttributeDraft(saved), platform, source, version: selected, publishedAt: saved.publishedAt }
    }
    const found = ledger.versions.find(item => item.version === (version ?? ledger.activeVersion))
    return found ? structuredClone(found as PublishedAttributeDictionary) : undefined
  }
  private expected(
    platform: LiveControlPlatform,
    source: MappingScope['source'],
    revision: number,
  ): DictionaryLedger {
    analysisInteger(revision)
    const ledger = this.ledger(platform, source)
    if (revision !== ledger.revision)
      throw new AnalysisError('MAPPING_REVISION_CONFLICT', '字典已变化，请重新加载')
    return ledger
  }
  async saveDraft(input: AnalysisParameters['mapping-draft']): Promise<DictionaryState> {
    await this.ready
    const draft = validateAttributeDraft(input.draft)
    return this.options.store.mutateConfiguration(async () => {
      const ledger = this.expected(input.platform, input.source, input.revision)
      const next = { ...ledger, draft, revision: ledger.revision + 1 }
      if (this.sql) await this.sql.writeDictionary(input.platform, input.source, { ...next, versions: [] })
      else {
        await this.options.store.writeMetadata(this.file(input.platform, input.source), next)
        this.ledgers.set(this.key(input.platform, input.source), next)
      }
      return this.read(input.platform, input.source)
    })
  }
  private dependencies(scope: MappingScope) {
    return (
      this.options.enabledGroupReferences?.(scope.platform, scope.source) ?? {
        revision: '0',
        accountIds: [],
      }
    )
  }
  private binding(
    input: AnalysisParameters['mapping-preview'],
    ledger: DictionaryLedger,
  ): PreviewBinding {
    const scope = { accountId: input.accountId, platform: input.platform, source: input.source }
    const session = this.options.store.owned(scope, input.sessionId)
    const start = analysisInteger(input.sampleRange?.start ?? 1, 1)
    const end = analysisInteger(
      input.sampleRange?.end ?? Math.min(session.counters.received, start + 199),
      start,
    )
    if (end - start + 1 > 200) throw new AnalysisError('ANALYSIS_LIMIT', '每次预览最多 200 条样本')
    const adapterFormatVersion = this.options.formatVersion?.(input) ?? session.formatVersion
    return {
      kind: 'dictionary',
      accountId: input.accountId,
      platform: input.platform,
      source: input.source,
      revision: ledger.revision,
      sessionId: session.id,
      formatVersion: session.formatVersion,
      adapterFormatVersion,
      start,
      end,
      contentDigest: previewDigest(ledger.draft),
      dependencyRevision: this.dependencies(input).revision,
    }
  }
  async preview(input: AnalysisParameters['mapping-preview']): Promise<DictionaryPreview> {
    await this.ready
    const scope = validateAnalysisScope({
      accountId: input.accountId,
      platform: input.platform,
      source: input.source,
    })
    const ledger = this.expected(input.platform, input.source, input.revision)
    const session = this.options.store.owned(scope, input.sessionId)
    if (['collecting', 'stopping'].includes(session.status) || !session.counters.saved)
      throw new AnalysisError('ANALYSIS_INCOMPLETE', '请先停止保存含真实样本的分析记录')
    const binding = this.binding(input, ledger)
    const counts = { known: 0, unknown: 0, conflict: 0, removed: 0, conversionFailed: 0 }
    const samples: DictionaryPreview['samples'] = []
    const warnings = new Set<string>()
    if (!session.complete) warnings.add('INCOMPLETE_CAPTURE')
    if (!ledger.draft.acceptedFormatVersions.includes(session.formatVersion))
      warnings.add('FORMAT_INCOMPATIBLE')
    if (this.dependencies(input).accountIds.length) warnings.add('GROUP_DEPENDENCY')
    let scanned = 0
    let matched = 0
    const rows = this.sql
      ? this.options.store.records(session.id, '', Number(binding.start) - 1)
      : this.options.store.records(session.id)
    for await (const row of rows) {
      if (++scanned % 200 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      if (!row.record) {
        warnings.add('CORRUPT_RECORDS')
        continue
      }
      if (this.sql && row.record.recordSequence > Number(binding.end)) break
      if (
        row.record.recordSequence < Number(binding.start) ||
        row.record.recordSequence > Number(binding.end)
      )
        continue
      const snapshot = mapObservation(row.record, {
        ...ledger.draft,
        platform: input.platform,
        source: input.source,
        version: ledger.activeVersion ?? 0,
        publishedAt: 0,
      })
      snapshot.origin = 'history'
      matched++
      if (samples.length < 10) samples.push(snapshot)
      for (const fact of Object.values(snapshot.values)) {
        counts[fact.status]++
        if (fact.status !== 'known' && fact.reason === 'REMOVED') counts.removed++
        if (
          fact.status !== 'known' &&
          ['TYPE_MISMATCH', 'CONVERSION_FAILED', 'ENUM_UNDECLARED'].includes(fact.reason)
        )
          counts.conversionFailed++
      }
    }
    if (!matched) throw new AnalysisError('ANALYSIS_INCOMPLETE', '所选范围没有可验证的真实样本')
    this.expected(input.platform, input.source, input.revision)
    if (previewDigest(binding) !== previewDigest(this.binding(input, ledger)))
      throw new AnalysisError('MAPPING_PREVIEW_STALE', '预览过程中依赖已变化，请重新预览')
    return {
      ...this.proofs.issue(binding),
      revision: ledger.revision,
      scope,
      sessionId: session.id,
      counts,
      samples,
      warnings: [...warnings],
    }
  }
  async publish(input: AnalysisParameters['mapping-publish']): Promise<DictionaryState> {
    await this.ready
    analysisInteger(input.revision)
    analysisId(input.previewToken)
    return this.options.store.mutateConfiguration(async () => {
      const ledger = this.expected(input.platform, input.source, input.revision)
      const original = this.proofs.binding(input.previewToken)
      if (
        original.kind !== 'dictionary' ||
        original.platform !== input.platform ||
        original.source !== input.source
      )
        throw new AnalysisError('MAPPING_PREVIEW_STALE', '凭据种类或来源不一致')
      const previewInput: AnalysisParameters['mapping-preview'] = {
        platform: input.platform,
        source: input.source,
        accountId: String(original.accountId),
        revision: input.revision,
        sessionId: String(original.sessionId),
        sampleRange: { start: Number(original.start), end: Number(original.end) },
      }
      const check = () => {
        if (this.dependencies(input).accountIds.length)
          throw new AnalysisError(
            'MAPPING_GROUP_DEPENDENCY',
            '已保存账号仍有启用的相关组策略，请先关闭并重新预览',
          )
        this.expected(input.platform, input.source, input.revision)
        this.proofs.assertCurrent(input.previewToken, this.binding(previewInput, ledger))
      }
      check()
      if (
        !ledger.draft.acceptedFormatVersions.includes(Number(original.formatVersion)) ||
        !ledger.draft.acceptedFormatVersions.includes(Number(original.adapterFormatVersion))
      )
        throw new AnalysisError('MAPPING_INVALID', '请明确声明采集格式兼容性并重新预览')
      if (input.rollbackFromVersion !== undefined) {
        const old = this.published(
          input.platform,
          input.source,
          analysisInteger(input.rollbackFromVersion, 1),
        )
        if (!old || previewDigest(validateAttributeDraft(old)) !== previewDigest(ledger.draft))
          throw new AnalysisError('MAPPING_INVALID', '回退内容必须先保存为新草稿并重新预览')
      }
      const version: PublishedAttributeDictionary = {
        ...structuredClone(ledger.draft),
        platform: input.platform,
        source: input.source,
        version: (this.sql ? ledger.activeVersion ?? 0 : ledger.versions.length) + 1,
        publishedAt: (this.options.now ?? Date.now)(),
      }
      const next = {
        ...ledger,
        revision: ledger.revision + 1,
        activeVersion: version.version,
        versions: this.sql ? [version] : [...ledger.versions, version],
      }
      if (this.sql) await this.sql.writeDictionary(input.platform, input.source, next, check)
      else {
        await this.options.store.writeMetadata(this.file(input.platform, input.source), next, 0, check)
        this.ledgers.set(this.key(input.platform, input.source), next)
      }
      try {
        this.options.onPublished?.(structuredClone(version))
      } catch {
        /* Persisted publication remains authoritative. */
      }
      return this.read(input.platform, input.source)
    })
  }
}
