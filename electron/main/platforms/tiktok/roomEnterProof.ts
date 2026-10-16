import type { Page, Response } from 'playwright'
import { isTikTokUsername } from '../../../../shared/assistantDeskContract.mjs'
import { isTikTokLivePage, sameTikTokLivePage } from './livePageIdentity'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_BINDING_MS = 15000
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Only explicit server owner + exact room strings bind; JSON's rounded numeric id is never evidence. */
export function extractRoomEnterOwnerRoom(value: unknown, expectedUsername: string): string | null {
  const root = record(value), data = record(root?.data), owner = record(data?.owner)
  if (root?.status_code !== 0 || !data || !owner || !isTikTokUsername(expectedUsername)) return null
  const names = [owner.display_id, owner.unique_id, owner.uniqueId].filter(name => name !== undefined && name !== '')
  if (!names.length || names.some(name => typeof name !== 'string' || name.toLowerCase() !== expectedUsername.toLowerCase())) return null
  const room = data.id_str
  if (typeof room !== 'string' || !/^[1-9]\d{7,19}$/.test(room)) return null
  for (const key of ['id', 'room_id_str', 'roomId', 'room_id']) {
    const alias = data[key]
    if (alias === undefined || alias === '') continue
    if (typeof alias === 'number') {
      if (Number.isSafeInteger(alias) && String(alias) !== room) return null
      continue
    }
    if (typeof alias !== 'string' || alias !== room) return null
  }
  return room
}

/** Observes only this authenticated owner's existing page; refreshes that same LIVE page at most once. */
export async function readOwnedTikTokRoomEnterProof(options: { page: Page; expectedUsername: string; isCurrent(): boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<string | null> {
  const { page, signal } = options, initialUrl = page.url(), timeoutMs = options.timeoutMs ?? MAX_BINDING_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BINDING_MS) throw new Error('Room binding deadline invalid')
  if (!isTikTokLivePage(initialUrl) || new URL(initialUrl).pathname.replace(/\/$/, '').toLowerCase() !== `/@${options.expectedUsername.toLowerCase()}/live`) return null
  const current = () => !signal?.aborted && options.isCurrent() && !page.isClosed() && sameTikTokLivePage(page.url(), initialUrl)
  if (!current()) return null
  const mainFrame = page.mainFrame()
  let alive = true, readers = 0, attempts = 0, timer: ReturnType<typeof setTimeout> | undefined, resolve!: (room: string | null) => void
  const result = new Promise<string | null>(done => { resolve = done })
  const finish = (room: string | null) => { if (alive) { alive = false; resolve(room) } }
  const cancelled = () => finish(null)
  const navigated = (frame: unknown) => { if (frame === mainFrame && !current()) finish(null) }
  const response = (value: Response) => {
    if (!alive || !current() || readers >= 2 || attempts >= 8) return
    let url: URL
    try {
      url = new URL(value.url())
      if (url.protocol !== 'https:' || url.hostname !== 'webcast.tiktok.com' || url.port || url.username || url.password || url.pathname !== '/webcast/room/enter/' ||
        value.status() !== 200 || value.request().frame() !== mainFrame || url.searchParams.getAll('room_id').length > 1) return
      const headers = value.headers()
      if (!/^application\/json(?:;|$)/i.test(headers['content-type'] ?? '')) return
      const length = headers['content-length']
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return
    } catch { return }
    attempts++; readers++
    void (async () => {
      try {
        const body = await value.body()
        if (!alive || !current() || !body.length || body.length > MAX_BODY_BYTES) return
        const room = extractRoomEnterOwnerRoom(JSON.parse(body.toString('utf8')), options.expectedUsername)
        const requestRoom = url.searchParams.get('room_id')
        if (room && (!requestRoom || requestRoom === room) && current()) finish(room)
      } catch { /* Invalid/failed responses stay unknown; no platform events are derived here. */ }
      finally { readers-- }
    })()
  }
  page.on('response', response); page.on('framenavigated', navigated); page.on('close', cancelled)
  signal?.addEventListener('abort', cancelled, { once: true })
  timer = setTimeout(cancelled, timeoutMs)
  // A stop arriving before this microtask prevents even the one authorized refresh.
  void Promise.resolve().then(async () => {
    if (!alive || !current()) { finish(null); return }
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }) }
    catch { finish(null) }
  })
  try { const room = await result; return room && current() ? room : null }
  finally {
    alive = false; if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', cancelled)
    page.off('response', response); page.off('framenavigated', navigated); page.off('close', cancelled)
  }
}
