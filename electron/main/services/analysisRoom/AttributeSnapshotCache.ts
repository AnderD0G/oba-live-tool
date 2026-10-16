import { type AnalysisScope, analysisInteger } from '../../../../shared/analysisRoom'
import type {
  AttributeFact,
  AttributeProvenance,
  AttributeSnapshot,
  AttributeType,
} from '../../../../shared/audienceAttributes'

const key = (scope: AnalysisScope, userId: string) =>
  JSON.stringify([scope.accountId, scope.platform, scope.source, userId])
const mappingKey = (platform: LiveControlPlatform, source: AnalysisScope['source']) =>
  JSON.stringify([platform, source])
function unavailable(
  fact: AttributeFact,
  reason: string,
): AttributeProvenance & { status: 'unknown' | 'conflict'; type: AttributeType; reason: string } {
  if (fact.status === 'known') {
    const { value: _value, ...provenance } = fact
    return { ...provenance, status: 'unknown', reason }
  }
  return { ...fact, status: 'unknown', reason }
}
export class AttributeSnapshotCache {
  private profiles = new Map<string, AttributeSnapshot>()
  private versions = new Map<string, number>()
  private profileBytes = new Map<string, number>()
  private bytes = 0
  private limits: { maxProfiles: number; maxBytes: number }
  constructor(options: { maxProfiles?: number; maxBytes?: number } = {}) {
    this.limits = {
      maxProfiles: analysisInteger(options.maxProfiles ?? 10000, 1, 10000),
      maxBytes: analysisInteger(options.maxBytes ?? 32 * 1024 * 1024, 1, 32 * 1024 * 1024),
    }
  }
  private remove(id: string): void {
    this.bytes -= this.profileBytes.get(id) ?? 0
    this.profileBytes.delete(id)
    this.profiles.delete(id)
  }
  observe(snapshot: AttributeSnapshot): void {
    if (snapshot.origin === 'history' || snapshot.userId === undefined) return
    const versionKey = mappingKey(snapshot.scope.platform, snapshot.scope.source)
    const active = this.versions.get(versionKey) ?? snapshot.mappingVersion
    if (snapshot.mappingVersion < active) return
    this.versions.set(versionKey, snapshot.mappingVersion)
    const id = key(snapshot.scope, snapshot.userId)
    const previous = this.profiles.get(id)
    const next = structuredClone(snapshot)
    next.values = { ...previous?.values }
    for (const [attributeId, incoming] of Object.entries(snapshot.values)) {
      const old = next.values[attributeId]
      if (!old || old.mappingVersion !== incoming.mappingVersion) {
        next.values[attributeId] = structuredClone(incoming)
        continue
      }
      if (
        incoming.status === 'unknown' &&
        ['MISSING', 'BUSINESS_TYPE_MISMATCH'].includes(incoming.reason)
      )
        continue
      const comparable = old.platformTime !== undefined && incoming.platformTime !== undefined
      const difference = comparable
        ? (incoming.platformTime ?? 0) - (old.platformTime ?? 0)
        : incoming.streamId === old.streamId
          ? incoming.sequence - old.sequence
          : incoming.observedAt - old.observedAt
      if (difference < 0) continue
      if (difference === 0) {
        if (old.status === 'conflict') continue
        if (
          old.status === 'known' &&
          incoming.status === 'known' &&
          !Object.is(old.value, incoming.value)
        )
          next.values[attributeId] = {
            ...unavailable(old, 'OBSERVATION_CONFLICT'),
            status: 'conflict',
          }
        continue
      }
      next.values[attributeId] = {
        ...structuredClone(incoming),
        timeBasis: comparable ? 'platform' : 'local-sequence',
      }
    }
    if (next.nickname === undefined && previous?.mappingVersion === snapshot.mappingVersion)
      next.nickname = previous.nickname
    this.remove(id)
    const bytes = Buffer.byteLength(JSON.stringify(next))
    if (bytes > this.limits.maxBytes) return
    while (
      this.profiles.size >= this.limits.maxProfiles ||
      this.bytes + bytes > this.limits.maxBytes
    ) {
      const oldest = this.profiles.keys().next().value
      if (oldest === undefined) return
      this.remove(oldest)
    }
    this.profiles.set(id, next)
    this.profileBytes.set(id, bytes)
    this.bytes += bytes
  }
  snapshot(
    scope: AnalysisScope,
    userId: string,
    mappingVersion: number,
    now: number,
  ): AttributeSnapshot | undefined {
    const profile = this.profiles.get(key(scope, userId))
    if (!profile) return undefined
    const result = structuredClone(profile)
    result.mappingVersion = mappingVersion
    const active = this.versions.get(mappingKey(scope.platform, scope.source))
    for (const [id, fact] of Object.entries(result.values)) {
      if (
        fact.mappingVersion !== mappingVersion ||
        (active !== undefined && mappingVersion !== active)
      )
        result.values[id] = unavailable(fact, 'MAPPING_CHANGED')
      else if (now >= fact.expiresAt) result.values[id] = unavailable(fact, 'EXPIRED')
    }
    if (profile.mappingVersion !== mappingVersion) delete result.nickname
    return result
  }
  invalidateDictionary(
    platform: LiveControlPlatform,
    source: AnalysisScope['source'],
    newVersion: number,
  ): void {
    const id = mappingKey(platform, source)
    this.versions.set(id, Math.max(this.versions.get(id) ?? 0, newVersion))
  }
  clearAccount(accountId: string): void {
    for (const [id, profile] of this.profiles)
      if (profile.scope.accountId === accountId) this.remove(id)
  }
}
