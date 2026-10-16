import type { Page } from 'playwright'
import { createHash } from 'node:crypto'
import type { BrowserTranslationObservation } from '../../../../shared/browserTranslation'
import { isTikTokUsername } from '../../../../shared/assistantDeskContract.mjs'
import type { TikTokDomTranslationRow } from './domTranslationParser'
import { tikTokDomTranslationParserSource } from './domTranslationParser'
import { isTikTokLivePage, sameTikTokLivePage } from './livePageIdentity'
import { extractTargetBoundTikTokRoomId } from './connection'
import { startDomTranslationRoomProof } from './domTranslationRoomProof'

export class DomTranslationTracker {
  private pages = new Map<object, { rows: Map<string, { at: number; baseline: boolean; emitted: Set<string>; ambiguous: boolean }>; blocked: boolean }>()
  constructor(private generation: string) {}
  scan(key: object, rows: TikTokDomTranslationRow[], now: number): BrowserTranslationObservation[] {
    if (!this.generation || !Array.isArray(rows) || rows.length > 64 || !Number.isSafeInteger(now)) return []
    let state = this.pages.get(key)
    const baseline = !state
    if (!state) { if (this.pages.size >= 8) return []; state = { rows: new Map(), blocked: false }; this.pages.set(key, state) }
    if (state.blocked) return []
    const grouped = new Map<string, { row: TikTokDomTranslationRow; count: number }>()
    const observations: BrowserTranslationObservation[] = []
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    for (const row of rows) {
      if (!row || typeof row.original !== 'string' || !row.original || row.original.length > 8000 || typeof row.nickname !== 'string' || !row.nickname || row.nickname.length > 200) continue
      const identity = hash(JSON.stringify([row.nickname, row.original]))
      const group = grouped.get(identity)
      if (group) group.count++
      else grouped.set(identity, { row, count: 1 })
    }
    const newIdentities = [...grouped.keys()].filter(identity => !state.rows.has(identity)).length
    // Keep first-seen identities for the page lifetime; never recycle old DOM as fresh.
    if (state.rows.size + newIdentities > 512) { state.blocked = true; return [] }
    for (const [identity, { row, count }] of grouped) {
      let item = state.rows.get(identity)
      if (!item) {
        item = { at: now, baseline, emitted: new Set(), ambiguous: false }; state.rows.set(identity, item)
      }
      if (item.baseline || now < item.at) continue
      if (count >= 2) {
        if (!item.ambiguous) {
          item.ambiguous = true
          observations.push({ original: row.original, chinese: '', ambiguous: true, source: 'immersive-dom', receivedAt: now, captureGeneration: this.generation, observationId: `imt:${identity}:ambiguous` })
        }
        continue
      }
      if (item.ambiguous || now - item.at > 30000 || typeof row.chinese !== 'string' || !row.chinese.trim() || row.chinese.length > 8000 || row.chinese === row.original || !/\p{Script=Han}/u.test(row.chinese)) continue
      const translated = hash(row.chinese)
      if (item.emitted.has(translated) || item.emitted.size >= 2) continue
      item.emitted.add(translated)
      observations.push({ original: row.original, chinese: row.chinese, source: 'immersive-dom', receivedAt: item.at, captureGeneration: this.generation, observationId: `imt:${identity}:${translated}` })
    }
    return observations
  }
  forget(key: object) { this.pages.delete(key) }
  clear() { this.pages.clear() }
  get pageCount() { return this.pages.size }
}
export interface DomTranslationSnapshot { active: boolean; pagesObserved: number; pairsObserved: number; readFailures: number; callbackFailures: number; rejectedBindings: number; overflowPages: number }
export interface DomTranslationOptions { page: Page; isCurrent(): boolean; captureGeneration: string; expectedRoomId: string; expectedUsername: string; now?(): number; pollMs?: number; onTranslation(observation: BrowserTranslationObservation): void | Promise<void> }
/** Passive supplement only: no navigation, new connection, API translation or platform messages. */
export async function startTikTokDomTranslations(options: DomTranslationOptions) {
  const originalUrl = options.page.url(), now = options.now ?? Date.now
  const context = options.page.context()
  const valid = isTikTokLivePage(originalUrl) && isTikTokUsername(options.expectedUsername) &&
    /^[1-9]\d{7,19}$/.test(options.expectedRoomId) && !!options.captureGeneration && options.captureGeneration.length <= 512 && typeof context.pages === 'function'
  let active = valid, timer: ReturnType<typeof setTimeout> | undefined
  const tracker = new DomTranslationTracker(options.captureGeneration)
  const seen = new Set<Page>(), reading = new Set<Page>()
  type Watch = { epoch: number; listener: (frame: any) => void; proof?: Awaited<ReturnType<typeof startDomTranslationRoomProof>>; pending?: boolean }
  const watches = new Map<Page, Watch>()
  const proofStarting = new Set<Page>()
  const counters = { pagesObserved: 0, pairsObserved: 0, readFailures: 0, callbackFailures: 0, rejectedBindings: 0, overflowPages: 0 }
  const current = () => { try { return active && options.isCurrent() && !options.page.isClosed() && sameTikTokLivePage(options.page.url(), originalUrl) } catch { return false } }
  const candidate = (page: Page) => { try { return !page.isClosed() && sameTikTokLivePage(page.url(), originalUrl) } catch { return false } }
  const interval = options.pollMs === undefined ? 500 : options.pollMs
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 5000) throw new Error('网页译文轮询间隔无效')
  function watchPage(page: Page): Watch {
    const old = watches.get(page)
    if (old) return old
    const watch: Watch = { epoch: 0, listener: frame => {
      if (frame.parentFrame() !== null) return
      watch.epoch++; tracker.forget(page); seen.delete(page)
      const proof = watch.proof; watch.proof = undefined; watch.pending = false
      void proof?.stop().catch(() => {})
    } }
    if (typeof page.on === 'function') page.on('framenavigated', watch.listener)
    watches.set(page, watch)
    return watch
  }
  function startRoomProof(page: Page, watch: Watch) {
    if (watch.proof || watch.pending || proofStarting.has(page) || proofStarting.size >= 8) return
    proofStarting.add(page)
    watch.pending = true
    const epoch = watch.epoch
    void startDomTranslationRoomProof({ page, expectedRoomId: options.expectedRoomId, now,
      isCurrent: () => current() && candidate(page) && watches.get(page) === watch && watch.epoch === epoch })
      .then(async proof => {
        if (!current() || watches.get(page) !== watch || watch.epoch !== epoch) { await proof.stop(); return }
        watch.proof = proof
      }).catch(() => { if (current()) counters.readFailures++ })
      .finally(() => { proofStarting.delete(page); if (watch.epoch === epoch) watch.pending = false })
  }
  function unwatch(page: Page) {
    const watch = watches.get(page)
    if (!watch) return
    watches.delete(page)
    if (typeof page.off === 'function') page.off('framenavigated', watch.listener)
    void watch.proof?.stop().catch(() => {})
    tracker.forget(page); seen.delete(page)
  }
  async function read(page: Page) {
    if (reading.has(page) || reading.size >= 8 || !current() || !candidate(page)) return
    reading.add(page)
    const watch = watchPage(page), epoch = watch.epoch
    // Timed-out reads retain their slot until settlement, preventing repeated hung reads.
    let timeout: ReturnType<typeof setTimeout> | undefined
    const promise = page.evaluate(({ source, expectedUsername, expectedUrl }) => {
      if (location.origin + location.pathname !== expectedUrl) return null
      const bindings: { uniqueId: string; roomId: string }[] = []
      const text = document.getElementById('SIGI_STATE')?.textContent
      if (text && text.length <= 2 * 1024 * 1024) {
        try { const value = JSON.parse(text)?.LiveRoom?.liveRoomUserInfo?.user
          if (typeof value?.uniqueId === 'string' && typeof value?.roomId === 'string') bindings.push({ uniqueId: value.uniqueId, roomId: value.roomId })
        } catch { /* Unknown public room state stays unknown. */ }
      }
      // New LIVE pages can omit SIGI_STATE. Verify the public host profile avatar,
      // never a link or translated name inside a comment; the root room remains verified.
      const publicHeaderOwner = [...document.querySelectorAll('a[href]')].some(anchor => {
        if (anchor.closest('[data-e2e="chat-message"], [data-e2e="enter-message"]')) return false
        try { const url = new URL(anchor.getAttribute('href') || '', location.href)
          return url.origin === location.origin && url.pathname.toLowerCase() === `/@${expectedUsername.toLowerCase()}` &&
            [...anchor.querySelectorAll('img[alt]')].some(image => image.getAttribute('alt')?.toLowerCase() === expectedUsername.toLowerCase())
        } catch { return false }
      })
      const parser = new Function(`return (${source})()`)() as ReturnType<typeof import('./domTranslationParser').createTikTokDomTranslationParser>
      const parsed = parser.snapshot(document)
      if (JSON.stringify(parsed).length > 128000) return null
      return { pageUrl: location.href, bindings, publicHeaderOwner, ...parsed }
    }, { source: tikTokDomTranslationParserSource, expectedUsername: options.expectedUsername,
      expectedUrl: new URL(originalUrl).origin + new URL(originalUrl).pathname })
    void promise.finally(() => reading.delete(page)).catch(() => {})
    try {
      const value = await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('DOM_READ_TIMEOUT')), 3000) })])
      if (!current() || !candidate(page) || watches.get(page) !== watch || watch.epoch !== epoch) return
      if (!value || !sameTikTokLivePage(value.pageUrl, originalUrl) || !Array.isArray(value.bindings) || !Array.isArray(value.rows) || value.rows.length > 64 || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) { counters.readFailures++; return }
      const room = extractTargetBoundTikTokRoomId(value.bindings, value.pageUrl, options.expectedUsername)
      if (!value.bindings.length && value.publicHeaderOwner === true) startRoomProof(page, watch)
      if (value.bindings.length ? room !== options.expectedRoomId : value.publicHeaderOwner !== true || !watch.proof?.verified()) { counters.rejectedBindings++; tracker.forget(page); return }
      if (!seen.has(page)) { seen.add(page); counters.pagesObserved++ }
      if (value.overflow) counters.overflowPages++
      for (const observation of tracker.scan(page, value.rows, now())) {
        if (!current() || !candidate(page) || watch.epoch !== epoch) return
        try { await options.onTranslation(observation); counters.pairsObserved++ }
        catch { if (current()) counters.callbackFailures++ }
      }
    } catch { if (current()) counters.readFailures++ }
    finally { if (timeout) clearTimeout(timeout) }
  }
  async function poll() {
    if (!current()) return
    try {
      const pages = context.pages().filter(candidate).slice(0, 8)
      for (const page of watches.keys()) if (!pages.includes(page)) unwatch(page)
      for (const page of pages) { if (!current()) break; await read(page) }
    } catch { if (current()) counters.readFailures++ }
    finally { if (current()) { timer = setTimeout(() => void poll(), interval); timer.unref() } }
  }
  if (active) void poll()
  return { stop: async () => { active = false; if (timer) clearTimeout(timer);
      const proofs = [...watches.values()].map(watch => watch.proof).filter(proof => !!proof)
      for (const page of watches.keys()) unwatch(page)
      await Promise.all(proofs.map(proof => proof!.stop().catch(() => {})))
      tracker.clear(); seen.clear() },
    snapshot: (): DomTranslationSnapshot => ({ active: current(), ...counters }) }
}
