import type { BrowserTranslationObservation } from '../../../../shared/browserTranslation'

export interface TranslationDecision { rowId: string; observation?: BrowserTranslationObservation }
interface Entry {
  at: number
  bytes: number
  rows: { id: string; at: number }[]
  observations: Map<string, BrowserTranslationObservation>
  ambiguous: boolean
}
interface OwnerCache { entries: Map<string, Entry>; at: number; bytes: number; blockedUntil: number }
export const BROWSER_TRANSLATION_WINDOW_MS = 30000
/** Exact identity only. Ambiguity is retained until expiry; overflowing disables matching safely. */
export class BrowserTranslationMatcher {
  private owners = new Map<string, OwnerCache>()
  clear() { this.owners.clear() }
  clearAccount(accountId: string) {
    for (const owner of this.owners.keys()) if (JSON.parse(owner)[0] === accountId) this.owners.delete(owner)
  }
  private block(cache: OwnerCache, now: number) {
    const overflow = [...cache.entries.values()].flatMap(value => value.rows.map(row => ({ rowId: row.id })))
    cache.entries.clear(); cache.bytes = 0; cache.blockedUntil = now + BROWSER_TRANSLATION_WINDOW_MS
    return { overflow }
  }
  private entry(owner: string, generation: string, original: string, now: number) {
    for (const [key, cache] of this.owners) if (now - cache.at > BROWSER_TRANSLATION_WINDOW_MS) this.owners.delete(key)
    if (!generation || generation.length > 512 || original.length > 8000 || !original) return undefined
    let cache = this.owners.get(owner)
    if (!cache) {
      if (this.owners.size >= 32) return undefined
      cache = { entries: new Map(), bytes: 0, at: now, blockedUntil: 0 }
      this.owners.set(owner, cache)
    }
    cache.at = now
    if (now < cache.blockedUntil) return undefined
    for (const [key, entry] of cache.entries) if (now - entry.at > BROWSER_TRANSLATION_WINDOW_MS) { cache.entries.delete(key); cache.bytes -= entry.bytes }
    const key = JSON.stringify([generation, original])
    let entry = cache.entries.get(key)
    if (!entry) {
      const bytes = (owner.length + generation.length + original.length) * 12 + 512
      if (cache.entries.size >= 512 || cache.bytes + bytes > 1048576) return this.block(cache, now)
      entry = { at: now, bytes, rows: [], observations: new Map(), ambiguous: false }
      cache.entries.set(key, entry)
      cache.bytes += bytes
    }
    return { entry }
  }
  private decisions(entry: Entry): TranslationDecision[] {
    const observation = entry.observations.size === 1 ? [...entry.observations.values()][0] : undefined
    const unique = !entry.ambiguous && entry.rows.length === 1 && observation && Math.abs(entry.rows[0].at - observation.receivedAt) <= BROWSER_TRANSLATION_WINDOW_MS
    return entry.rows.map(row => ({ rowId: row.id, ...(unique ? { observation } : {}) }))
  }
  native(owner: string, generation: string, original: string, rowId: string, receivedAt: number, now: number): TranslationDecision[] {
    const result = this.entry(owner, generation, original, now)
    if (!result) return []
    if ('overflow' in result) return result.overflow ?? []
    const entry = result.entry
    if (!entry) return []
    entry.at = now
    if (!entry.rows.some(row => row.id === rowId)) {
      if (entry.rows.length >= 1) entry.ambiguous = true
      if (entry.rows.length < 2) entry.rows.push({ id: rowId, at: receivedAt })
    }
    return this.decisions(entry)
  }
  observe(owner: string, observation: BrowserTranslationObservation, now: number): TranslationDecision[] {
    if (observation?.ambiguous === true && observation.source === 'immersive-dom' && observation.chinese === '' &&
      Number.isSafeInteger(observation.receivedAt) && observation.receivedAt <= now && now - observation.receivedAt <= BROWSER_TRANSLATION_WINDOW_MS &&
      typeof observation.original === 'string' && typeof observation.captureGeneration === 'string') {
      const result = this.entry(owner, observation.captureGeneration, observation.original, now)
      if (!result) return []
      if ('overflow' in result) return result.overflow ?? []
      result.entry.ambiguous = true
      return this.decisions(result.entry)
    }
    if (!observation || !['chrome-google', 'immersive-dom'].includes(observation.source) || !Number.isSafeInteger(observation.receivedAt) || observation.receivedAt > now || now - observation.receivedAt > BROWSER_TRANSLATION_WINDOW_MS || typeof observation.original !== 'string' || typeof observation.chinese !== 'string' || !observation.chinese.trim() || observation.chinese.length > 8000 || observation.original === observation.chinese || typeof observation.captureGeneration !== 'string' || (observation.language !== undefined && (typeof observation.language !== 'string' || observation.language.length > 100))) return []
    const result = this.entry(owner, observation.captureGeneration, observation.original, now)
    if (!result) return []
    if ('overflow' in result) return result.overflow ?? []
    const entry = result.entry
    if (!entry) return []
    entry.at = now
    const identity = observation.observationId || JSON.stringify([observation.receivedAt, observation.chinese, observation.language])
    if (typeof identity !== 'string' || identity.length > 17000) return []
    const cache = this.owners.get(owner)!
    const previous = entry.observations.get(identity)
    const size = (value: BrowserTranslationObservation) => (identity.length + value.original.length + value.chinese.length + value.captureGeneration.length + (value.language?.length ?? 0)) * 2 + 512
    const bytes = size(observation) - (previous ? size(previous) : 0)
    if (cache.bytes + bytes > 1048576) return this.block(cache, now).overflow
    cache.bytes += bytes; entry.bytes += bytes
    if (!entry.observations.has(identity) && entry.observations.size >= 1) entry.ambiguous = true
    if (entry.observations.size < 2 || entry.observations.has(identity)) entry.observations.set(identity, { ...observation })
    return this.decisions(entry)
  }
}

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  BTW: '顺便说一下（by the way）', IDK: '我不知道（I don’t know）', LOL: '笑出声；常用于表示好笑（laughing out loud）',
  BRB: '马上回来（be right back）', IMO: '依我看（in my opinion）', IMHO: '依我拙见（in my humble opinion）',
  OMG: '天哪（oh my God）', THX: '谢谢（thanks）', TY: '谢谢（thank you）', FYI: '供你参考（for your information）',
}
export function localAbbreviations(original: string) {
  const tokens = new Set(original.match(/\b[A-Za-z]{2,4}\b/g)?.map(token => token.toUpperCase()) ?? [])
  return [...tokens].filter(token => ABBREVIATIONS[token]).map(token => ({ token, chineseMeaning: ABBREVIATIONS[token] }))
}
