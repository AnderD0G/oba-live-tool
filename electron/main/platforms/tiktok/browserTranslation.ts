import type { CDPSession, Page } from 'playwright'
import type { BrowserTranslationObservation } from '../../../../shared/browserTranslation'
import { isTikTokLivePage, sameTikTokLivePage } from './livePageIdentity'

const MAX_BYTES = 256 * 1024
const MAX_PENDING = 32
const MAX_PAIRS = 64
const ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml'
interface Pair { original: string; chinese: string; language?: string }

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8000 && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
}
/** This is a conservative parser of already observed Chrome responses, not a Google API client. */
export function parseChromeTranslationPairs(requestBody: string, responseBody: string): Pair[] {
  try {
    if (Buffer.byteLength(requestBody) > MAX_BYTES || Buffer.byteLength(responseBody) > MAX_BYTES) return []
    const request = JSON.parse(requestBody), response = JSON.parse(responseBody)
    if (!Array.isArray(request) || request.length !== 2 || !Array.isArray(request[0]) || request[0].length !== 3 ||
      request[1] !== 'te_lib' || !['zh-CN', 'zh-Hans'].includes(request[0][2]) || typeof request[0][1] !== 'string') return []
    const originals = request[0][0]
    if (!Array.isArray(originals) || originals.length < 1 || originals.length > MAX_PAIRS || !originals.every(safeText)) return []
    if (!Array.isArray(response) || response.length !== 2 || !Array.isArray(response[0]) || !Array.isArray(response[1]) ||
      response[0].length !== originals.length || response[1].length !== originals.length) return []
    if (!response[0].every(safeText) || !response[1].every((language: unknown) => typeof language === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language))) return []
    return originals.flatMap((original: string, index: number) => {
      const chinese = response[0][index] as string
      // Untranslated nicknames, unsupported content and emoji remain observations of nothing.
      if (!/\p{Script=Han}/u.test(chinese) || chinese === original) return []
      return [{ original, chinese, language: response[1][index] }]
    })
  } catch { return [] }
}

export interface BrowserTranslationSnapshot {
  active: boolean
  pendingRequests: number
  requestsObserved: number
  pairsObserved: number
  bodyFailures: number
  callbackFailures: number
  droppedRequests: number
}
interface Options {
  page: Page
  isCurrent(): boolean
  captureGeneration: string
  now?(): number
  onTranslation(observation: BrowserTranslationObservation): void | Promise<void>
}
/** Opens only a bounded CDP observer; never navigates, translates, authenticates or reads headers. */
export async function startTikTokBrowserTranslations(options: Options): Promise<{ stop(): Promise<void>; snapshot(): BrowserTranslationSnapshot }> {
  const originalUrl = options.page.url()
  if (!isTikTokLivePage(originalUrl) || !options.isCurrent() || !options.captureGeneration || options.captureGeneration.length > 200)
    throw new Error('网页译文观察不可用')
  let session: CDPSession | undefined
  let active = true
  let stopPromise: Promise<void> | undefined
  let mainFrameId: string | undefined
  const pending = new Map<string, { postData: string; ready: boolean; processing: boolean; receivedAt: number }>()
  const counters = { requestsObserved: 0, pairsObserved: 0, bodyFailures: 0, callbackFailures: 0, droppedRequests: 0 }
  const now = options.now ?? Date.now
  const current = () => {
    try { return active && options.isCurrent() && !options.page.isClosed() && sameTikTokLivePage(options.page.url(), originalUrl) }
    catch { return false }
  }
  const request = (event: any) => {
    // Redirects reuse a CDP request ID. Revoke its previous original even when
    // the new event has an invalid endpoint, method, frame or missing body.
    if (typeof event?.requestId === 'string' && pending.has(event.requestId)) { pending.delete(event.requestId); return }
    if (!current() || !mainFrameId || event?.frameId !== mainFrameId || !['XHR', 'Fetch'].includes(event?.type) ||
      typeof event?.requestId !== 'string' || event.requestId.length > 200 || event?.request?.url !== ENDPOINT ||
      event.redirectResponse || event.request.method !== 'POST' || typeof event.request.postData !== 'string' || Buffer.byteLength(event.request.postData) > MAX_BYTES) return
    const id = event.requestId as string
    for (const [key, value] of pending) if (!value.processing && now() - value.receivedAt > 30000) pending.delete(key)
    if (pending.size >= MAX_PENDING) { counters.droppedRequests++; return }
    pending.set(id, { postData: event.request.postData, ready: false, processing: false, receivedAt: now() })
    counters.requestsObserved++
  }
  const response = (event: any) => {
    const entry = pending.get(event?.requestId)
    if (!entry) return
    if (!current() || event?.frameId !== mainFrameId || !['XHR', 'Fetch'].includes(event?.type) ||
      event?.response?.url !== ENDPOINT || event.response.status !== 200 || event.response.mimeType !== 'application/json+protobuf') {
      pending.delete(event.requestId); return
    }
    entry.ready = true
  }
  const failed = (event: any) => { pending.delete(event?.requestId) }
  const finished = (event: any) => {
    const id = event?.requestId as string, entry = pending.get(id)
    if (!entry || entry.processing) return
    if (!current() || !entry.ready || (typeof event.encodedDataLength === 'number' && event.encodedDataLength > MAX_BYTES)) {
      pending.delete(id); return
    }
    entry.processing = true
    void (async () => {
      try {
        const result = await session!.send('Network.getResponseBody', { requestId: id })
        if (!current() || pending.get(id) !== entry) return
        if (result.base64Encoded !== false || typeof result.body !== 'string' || Buffer.byteLength(result.body) > MAX_BYTES) {
          counters.bodyFailures++; return
        }
        const pairs = parseChromeTranslationPairs(entry.postData, result.body)
        if (!pairs.length) { counters.bodyFailures++; return }
        for (let index = 0; index < pairs.length && current(); index++) {
          counters.pairsObserved++
          try { await options.onTranslation({ ...pairs[index], source: 'chrome-google', receivedAt: now(),
            captureGeneration: options.captureGeneration, observationId: `${id}:${index}` }) }
          catch { counters.callbackFailures++ }
        }
      } catch { if (current()) counters.bodyFailures++ }
      finally { if (pending.get(id) === entry) pending.delete(id) }
    })()
  }
  const stop = () => {
    if (stopPromise) return stopPromise
    active = false
    pending.clear()
    session?.removeListener('Network.requestWillBeSent', request)
    session?.removeListener('Network.responseReceived', response)
    session?.removeListener('Network.loadingFinished', finished)
    session?.removeListener('Network.loadingFailed', failed)
    stopPromise = (async () => {
      if (session) { await session.send('Network.disable').catch(() => {}); await session.detach().catch(() => {}) }
    })()
    return stopPromise
  }
  try {
    session = await options.page.context().newCDPSession(options.page)
    if (!current()) throw new Error()
    const tree = await session.send('Page.getFrameTree')
    mainFrameId = tree.frameTree?.frame?.id
    if (!current() || typeof mainFrameId !== 'string' || !mainFrameId) throw new Error()
    session.on('Network.requestWillBeSent', request)
    session.on('Network.responseReceived', response)
    session.on('Network.loadingFinished', finished)
    session.on('Network.loadingFailed', failed)
    await session.send('Network.enable', { maxTotalBufferSize: MAX_BYTES * MAX_PENDING, maxResourceBufferSize: MAX_BYTES, maxPostDataSize: MAX_BYTES })
    if (!current()) throw new Error()
    return { stop, snapshot: () => ({ active: current(), pendingRequests: pending.size, ...counters }) }
  } catch { await stop(); throw new Error('网页译文观察不可用') }
}
