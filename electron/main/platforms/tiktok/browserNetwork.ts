import { gunzip } from 'node:zlib'
import type { CDPSession, Page } from 'playwright'
import { isTikTokLivePage as isLivePage, sameTikTokLivePage } from './livePageIdentity'
import type {
  ProtoMessageFetchResult as FetchResult,
  WebcastPushFrame as PushFrame,
} from 'tiktok-live-proto/dist/node/v3.js'
// @ts-expect-error The SDK exports-only entry resolves in ESM/Vite, unlike this repo's legacy TS resolver.
import * as Proto from 'tiktok-live-proto/v3'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_BYTES / 3)
const MAX_QUEUED_FRAMES = 32
const MAX_MESSAGES_PER_FRAME = 256
const HTTP_HEALTH_MS = 30000
const schemas = Proto as Record<string, { decode(bytes: Uint8Array): unknown }>
const { WebcastPushFrame, ProtoMessageFetchResult } = Proto as {
  WebcastPushFrame: { decode(bytes: Uint8Array): PushFrame }
  ProtoMessageFetchResult: { decode(bytes: Uint8Array): FetchResult }
}

export interface TikTokBrowserDecodedMessage {
  method: string
  data: unknown
  /** The original inner protobuf, never re-encoded or normalized. */
  binaryPayload: Uint8Array
}

export interface TikTokBrowserFrameResult {
  messages: TikTokBrowserDecodedMessage[]
  unknownMessages: number
  decodeFailures: number
  droppedMessages: number
  commentDecodeFailures?: number
}

function decodeFetchMessages(fetch: FetchResult): TikTokBrowserFrameResult {
  const result: TikTokBrowserFrameResult = { messages: [], unknownMessages: 0, decodeFailures: 0,
    droppedMessages: Math.max(0, fetch.messages.length - MAX_MESSAGES_PER_FRAME) }
  for (const message of fetch.messages.slice(0, MAX_MESSAGES_PER_FRAME)) {
    const method = message.method
    const schema = /^Webcast[A-Za-z0-9_]{1,72}$/.test(method) && Object.hasOwn(schemas, method) ? schemas[method] : undefined
    if (!schema || typeof schema.decode !== 'function') { result.unknownMessages++; continue }
    try { result.messages.push({ method, data: schema.decode(message.payload), binaryPayload: message.payload }) }
    catch {
      result.decodeFailures++
      if (method === 'WebcastChatMessage') result.commentDecodeFailures = (result.commentDecodeFailures ?? 0) + 1
    }
  }
  return result
}

/** The HTTP endpoint returns FetchResult directly, without a websocket PushFrame. */
export function decodeTikTokHttpFetch(binary: Uint8Array): TikTokBrowserFrameResult {
  try {
    if (!(binary instanceof Uint8Array) || !binary.byteLength || binary.byteLength > MAX_BYTES) throw new Error()
    return decodeFetchMessages(ProtoMessageFetchResult.decode(binary))
  } catch { throw new Error('TikTok browser HTTP decode failed') }
}

/** Uses the connector's installed schema without its global filters or unbounded unzip. */
export async function decodeTikTokBrowserFrame(binary: Uint8Array): Promise<TikTokBrowserFrameResult> {
  try {
    if (!(binary instanceof Uint8Array) || binary.byteLength === 0 || binary.byteLength > MAX_BYTES)
      throw new Error('invalid frame')
    const outer = WebcastPushFrame.decode(binary)
    const result: TikTokBrowserFrameResult = { messages: [], unknownMessages: 0, decodeFailures: 0, droppedMessages: 0 }
    if (outer.payloadEncoding !== 'pb') return result
    let payload: Uint8Array = outer.payload
    if (payload.byteLength > MAX_BYTES) throw new Error('invalid payload')
    if (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b && payload[2] === 0x08) {
      payload = await new Promise<Buffer>((resolve, reject) => {
        gunzip(payload, { maxOutputLength: MAX_BYTES }, (error, bytes) => {
          if (error) reject(new Error('invalid compressed payload'))
          else resolve(bytes)
        })
      })
    }
    if (payload.byteLength > MAX_BYTES) throw new Error('invalid inflated payload')
    return decodeFetchMessages(ProtoMessageFetchResult.decode(payload))
  } catch {
    // Do not expose protobuf contents, raw errors, request URLs or credentials in diagnostics.
    throw new Error('TikTok browser frame decode failed')
  }
}

export interface TikTokBrowserNetworkSnapshot {
  status: 'idle' | 'connecting' | 'active' | 'unavailable'
  active: boolean
  framesReceived: number
  framesDecoded: number
  messagesDecoded: number
  unknownMessages: number
  decodeFailures: number
  callbackFailures: number
  invalidFrames: number
  droppedFrames: number
  droppedMessages: number
  queuedFrames: number
  commentDecoderHealthy: boolean
  commentHealthReason: string
  webSocketCommentHealthy: boolean
  http: {
    enabled: boolean
    responsesReceived: number
    responsesDecoded: number
    messagesDecoded: number
    unknownMessages: number
    decodeFailures: number
    callbackFailures: number
    bodyFailures: number
    invalidResponses: number
    droppedResponses: number
    droppedMessages: number
    pendingResponses: number
    queuedResponses: number
    lastReceivedAt: number | null
    commentDecoderHealthy: boolean
    commentHealthReason: string
  }
}

export interface TikTokBrowserNetworkHandle {
  /** Releases only the CDP session owned by this listener, leaving the page and browser open. */
  stop(): Promise<void>
  snapshot(): TikTokBrowserNetworkSnapshot
}

export interface TikTokBrowserNetworkOptions {
  page: Page
  isCurrent(): boolean
  onFrame(binary: Uint8Array): void | Promise<void>
  /** false means the owning room/generation rejected this decoded message. */
  onDecoded(method: string, data: unknown, binaryPayload: Uint8Array, transport?: {
    staleTransport: boolean
    provenance?: 'cdp-websocket-decoded' | 'cdp-http-decoded'
    roomId?: string
  }): void | boolean | Promise<void | boolean>
  onCommentHealth?(health: { ready: boolean; reason: string }): void
  /** Only the owner of an authenticated, selected current LIVE page may enable HTTP capture. */
  allowHttp?: boolean
  expectedRoomId?: string
}

function httpRoomId(response: { url?: unknown; status?: unknown; mimeType?: unknown }): string | undefined {
  try {
    if (response.status !== 200 || response.mimeType !== 'application/x-protobuf' || typeof response.url !== 'string') return
    const url = new URL(response.url)
    if (url.protocol !== 'https:' || url.hostname !== 'webcast.tiktok.com' || url.port || url.username || url.password ||
      url.pathname !== '/webcast/im/fetch/' || url.searchParams.getAll('room_id').length !== 1) return
    const roomId = url.searchParams.get('room_id')!
    if (!/^[1-9]\d{7,19}$/.test(roomId)) return
    return roomId
  } catch { return }
}

/** Observes existing websocket traffic. It opens no page, browser, or platform socket. */
export async function startTikTokBrowserNetwork(
  options: TikTokBrowserNetworkOptions,
): Promise<TikTokBrowserNetworkHandle> {
  let originalUrl: string
  try {
    originalUrl = options.page.url()
    if (!isLivePage(originalUrl) || !options.isCurrent()) throw new Error('invalid page')
  } catch {
    throw new Error('TikTok browser network capture unavailable')
  }
  let session: CDPSession | undefined
  let stopPromise: Promise<void> | undefined
  let processing = false
  const queue: { binary: Buffer; requestId?: string; socketState?: { closed: boolean } }[] = []
  const nativeSockets = new Set<string>()
  const socketStates = new Map<string, { closed: boolean }>()
  let mainFrameId: string | undefined
  let httpProcessing = false
  let httpAcceptedAt = 0
  const httpPending = new Map<string, { requestId: string; roomId: string }>()
  const httpQueue: { requestId: string; roomId: string }[] = []
  const http: Omit<TikTokBrowserNetworkSnapshot['http'], 'pendingResponses' | 'queuedResponses'> = {
    enabled: false, responsesReceived: 0, responsesDecoded: 0, messagesDecoded: 0,
    unknownMessages: 0, decodeFailures: 0, callbackFailures: 0, bodyFailures: 0,
    invalidResponses: 0, droppedResponses: 0, droppedMessages: 0, lastReceivedAt: null,
    commentDecoderHealthy: false, commentHealthReason: 'disabled',
  }
  let webSocketCommentHealthy = false
  let webSocketHealthReason = 'starting'
  const state: Omit<TikTokBrowserNetworkSnapshot, 'active' | 'queuedFrames' | 'webSocketCommentHealthy' | 'http'> = {
    status: 'connecting', framesReceived: 0, framesDecoded: 0, messagesDecoded: 0,
    unknownMessages: 0, decodeFailures: 0, callbackFailures: 0, invalidFrames: 0, droppedFrames: 0, droppedMessages: 0,
    commentDecoderHealthy: false, commentHealthReason: 'starting',
  }
  const current = () => {
    try { return options.isCurrent() && sameTikTokLivePage(options.page.url(), originalUrl) }
    catch { return false }
  }
  const publishHealth = () => {
    const ready = webSocketCommentHealthy || http.commentDecoderHealthy
    const reason = webSocketCommentHealthy ? webSocketHealthReason : http.commentDecoderHealthy ? http.commentHealthReason :
      http.enabled && http.commentHealthReason !== 'awaiting-native-http' ? http.commentHealthReason : webSocketHealthReason
    if (state.commentDecoderHealthy === ready && state.commentHealthReason === reason) return
    state.commentDecoderHealthy = ready
    state.commentHealthReason = reason
    if (current()) try { options.onCommentHealth?.({ ready, reason }) } catch { state.callbackFailures++ }
  }
  const commentHealth = (ready: boolean, reason: string) => {
    webSocketCommentHealthy = ready
    webSocketHealthReason = reason
    publishHealth()
  }
  const httpHealth = (ready: boolean, reason: string) => {
    http.commentDecoderHealthy = ready
    http.commentHealthReason = reason
    if (ready) httpAcceptedAt = Date.now()
    publishHealth()
  }
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    state.status = 'idle'
    queue.length = 0
    nativeSockets.clear()
    socketStates.clear()
    httpPending.clear()
    httpQueue.length = 0
    httpHealth(false, 'stopped')
    commentHealth(false, 'stopped')
    session?.removeListener('Network.webSocketFrameReceived', receive)
    session?.removeListener('Network.webSocketClosed', socketClosed)
    session?.removeListener('Network.webSocketFrameError', socketFailed)
    session?.removeListener('Network.webSocketCreated', socketCreated)
    session?.removeListener('Network.responseReceived', httpResponse)
    session?.removeListener('Network.loadingFinished', httpFinished)
    session?.removeListener('Network.loadingFailed', httpFailed)
    session?.removeListener('close', detached)
    stopPromise = (async () => { try { await session?.detach() } catch { /* Chrome may already be closed. */ } })()
    return stopPromise
  }
  const live = () => {
    if (state.status !== 'active') return false
    if (current()) return true
    void stop()
    return false
  }
  async function pump() {
    if (processing) return
    processing = true
    try {
      while (queue.length && live()) {
        const { binary, requestId, socketState } = queue.shift()!
        try { await options.onFrame(binary) }
        catch { state.callbackFailures++ }
        if (!live()) break
        let decoded: TikTokBrowserFrameResult
        try {
          decoded = await decodeTikTokBrowserFrame(binary)
          state.framesDecoded++
          state.decodeFailures += decoded.decodeFailures
          state.unknownMessages += decoded.unknownMessages
          state.droppedMessages += decoded.droppedMessages
        } catch {
          state.decodeFailures++
          // A page may own unrelated binary websocket channels. Only a socket
          // already proven by accepted LIVE data can fail the comment route.
          if (requestId && nativeSockets.has(requestId)) commentHealth(false, 'frame-decode-failed')
          continue
        }
        if (decoded.commentDecodeFailures && requestId && nativeSockets.has(requestId))
          commentHealth(false, 'comment-decode-failed')
        for (const message of decoded.messages) {
          if (!live()) break
          state.messagesDecoded++
          try {
            const accepted = await options.onDecoded(message.method, message.data, message.binaryPayload,
              { staleTransport: socketState?.closed === true })
            // Recheck after the callback, which may yield while this socket closes.
            if (accepted === false) continue
            if (socketState?.closed) {
              // The owner validated this room's raw chat, but its transport
              // closed before delivery. Do not leave an unproven starting
              // route healthy when no other native socket can deliver.
              if (message.method === 'WebcastChatMessage' && !nativeSockets.size)
                commentHealth(false, 'socket-closed')
              continue
            }
            if (requestId) {
              nativeSockets.add(requestId)
              if (nativeSockets.size > 32) nativeSockets.delete(nativeSockets.values().next().value!)
            }
            if (['awaiting-native-stream', 'socket-closed', 'socket-error'].includes(webSocketHealthReason))
              commentHealth(typeof schemas.WebcastChatMessage?.decode === 'function', 'native-stream-recovered')
            if (message.method === 'WebcastChatMessage') commentHealth(true, 'comment-decoded')
          } catch {
            state.callbackFailures++
            if (message.method === 'WebcastChatMessage') commentHealth(false, 'comment-callback-failed')
          }
        }
      }
    } finally { processing = false }
  }
  function receive(event: { requestId?: unknown; response?: { opcode?: unknown; payloadData?: unknown } }) {
    if (!live() || event?.response?.opcode !== 2) return
    state.framesReceived++
    const payload = event.response.payloadData
    if (typeof payload !== 'string' || !payload.length || payload.length > MAX_BASE64_LENGTH ||
        payload.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
      state.invalidFrames++
      return
    }
    // Drop before allocating more payload buffers when decoding is backpressured.
    if (queue.length >= MAX_QUEUED_FRAMES) {
      state.droppedFrames++
      return
    }
    const binary = Buffer.from(payload, 'base64')
    if (binary.byteLength > MAX_BYTES || binary.toString('base64') !== payload) {
      state.invalidFrames++
      return
    }
    const requestId = typeof event.requestId === 'string' && event.requestId.length <= 256 ? event.requestId : undefined
    let socketState: { closed: boolean } | undefined
    if (requestId) {
      socketState = socketStates.get(requestId)
      if (!socketState) {
        socketState = { closed: false }
        socketStates.set(requestId, socketState)
        if (socketStates.size > 64) {
          const oldestUntracked = [...socketStates.keys()].find(id => !nativeSockets.has(id))
          if (oldestUntracked) socketStates.delete(oldestUntracked)
        }
      }
    }
    queue.push({ binary, requestId, socketState })
    void pump()
  }
  function socketClosed(event: { requestId?: unknown }) {
    if (!live() || typeof event?.requestId !== 'string') return
    const socketState = socketStates.get(event.requestId)
    if (socketState) socketState.closed = true
    if (nativeSockets.delete(event.requestId) && !nativeSockets.size) commentHealth(false, 'socket-closed')
  }
  function socketFailed(event: { requestId?: unknown }) {
    if (live() && typeof event?.requestId === 'string' && nativeSockets.has(event.requestId)) commentHealth(false, 'socket-error')
  }
  function socketCreated(event: { requestId?: unknown }) {
    if (!live() || typeof event?.requestId !== 'string') return
    // An actual new websocket may reuse a protocol request ID. Previously queued
    // frames retain their closed object and cannot inherit this new generation.
    if (socketStates.get(event.requestId)?.closed) socketStates.set(event.requestId, { closed: false })
  }
  function httpResponse(event: { requestId?: unknown; frameId?: unknown; type?: unknown; response?: { url?: unknown; status?: unknown; mimeType?: unknown } }) {
    if (!live() || !http.enabled || event.frameId !== mainFrameId || !['XHR', 'Fetch'].includes(String(event.type)) ||
      typeof event.requestId !== 'string' || !event.requestId.length || event.requestId.length > 256 || !event.response ||
      !options.expectedRoomId || !/^[1-9]\d{7,19}$/.test(options.expectedRoomId)) return
    const roomId = httpRoomId(event.response)
    if (!roomId) return
    // A changed room can withdraw this HTTP route, never establish a new owner binding.
    if (roomId !== options.expectedRoomId) { http.invalidResponses++; httpHealth(false, 'http-room-mismatch'); return }
    http.responsesReceived++
    http.lastReceivedAt = Date.now()
    if (httpPending.size >= MAX_QUEUED_FRAMES && !httpPending.has(event.requestId)) { http.droppedResponses++; return }
    httpPending.set(event.requestId, { requestId: event.requestId, roomId })
  }
  function httpFinished(event: { requestId?: unknown; encodedDataLength?: unknown }) {
    if (!live() || typeof event.requestId !== 'string') return
    const candidate = httpPending.get(event.requestId)
    if (!candidate) return
    httpPending.delete(event.requestId)
    if (typeof event.encodedDataLength !== 'number' || !Number.isFinite(event.encodedDataLength) || event.encodedDataLength < 0 || event.encodedDataLength > MAX_BYTES) {
      http.droppedResponses++; return
    }
    if (httpQueue.length >= MAX_QUEUED_FRAMES) { http.droppedResponses++; return }
    httpQueue.push(candidate)
    void pumpHttp()
  }
  function httpFailed(event: { requestId?: unknown }) {
    if (!live() || typeof event.requestId !== 'string' || !httpPending.delete(event.requestId)) return
    http.bodyFailures++
    httpHealth(false, 'http-response-failed')
  }
  async function pumpHttp() {
    if (httpProcessing) return
    httpProcessing = true
    try {
      while (httpQueue.length && live()) {
        const candidate = httpQueue.shift()!
        let response: { body?: unknown; base64Encoded?: unknown }
        try { response = await session!.send('Network.getResponseBody', { requestId: candidate.requestId }) }
        catch {
          if (live()) { http.bodyFailures++; httpHealth(false, 'http-body-unavailable') }
          continue
        }
        if (!live()) break
        if (response.base64Encoded !== true || typeof response.body !== 'string' || !response.body.length ||
          response.body.length > MAX_BASE64_LENGTH || response.body.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.body)) {
          http.invalidResponses++; httpHealth(false, 'http-body-invalid'); continue
        }
        const binary = Buffer.from(response.body, 'base64')
        if (binary.byteLength > MAX_BYTES || binary.toString('base64') !== response.body) {
          http.invalidResponses++; httpHealth(false, 'http-body-invalid'); continue
        }
        let decoded: TikTokBrowserFrameResult
        try { decoded = decodeTikTokHttpFetch(binary) }
        catch { http.decodeFailures++; httpHealth(false, 'http-decode-failed'); continue }
        http.responsesDecoded++
        http.decodeFailures += decoded.decodeFailures
        http.unknownMessages += decoded.unknownMessages
        http.droppedMessages += decoded.droppedMessages
        // The owned main-frame request binds the response. Known native room IDs must agree;
        // protobuf defaults/absent IDs stay unknown and are never replaced with the request ID.
        if (decoded.messages.some(message => {
          const roomId = (message.data as { common?: { roomId?: unknown } } | null)?.common?.roomId
          return roomId !== undefined && roomId !== '0' &&
            (typeof roomId !== 'string' || !/^\d+$/.test(roomId) || roomId.replace(/^0+/, '') !== candidate.roomId)
        })) { http.invalidResponses++; httpHealth(false, 'http-room-mismatch'); continue }
        let accepted = false, failedComment = !!decoded.commentDecodeFailures
        for (const message of decoded.messages) {
          if (!live()) break
          http.messagesDecoded++
          try {
            if (await options.onDecoded(message.method, message.data, message.binaryPayload,
              { staleTransport: false, provenance: 'cdp-http-decoded', roomId: candidate.roomId }) !== false) accepted = true
          } catch {
            http.callbackFailures++
            if (message.method === 'WebcastChatMessage') failedComment = true
          }
        }
        if (live() && failedComment) httpHealth(false, 'http-comment-failed')
        else if (live() && accepted) httpHealth(true, 'http-native-stream')
      }
    } finally { httpProcessing = false }
  }
  function detached() {
    if (state.status !== 'active') return
    void stop()
    state.status = 'unavailable'
    commentHealth(false, 'session-detached')
  }
  try {
    session = await options.page.context().newCDPSession(options.page)
    if (!current()) throw new Error('cancelled attach')
    session.on('Network.webSocketFrameReceived', receive)
    session.on('Network.webSocketClosed', socketClosed)
    session.on('Network.webSocketFrameError', socketFailed)
    session.on('Network.webSocketCreated', socketCreated)
    session.on('close', detached)
    if (options.allowHttp) {
      // A frame read uses the existing CDP connection; it neither navigates nor requests TikTok data.
      try {
        const tree = await session.send('Page.getFrameTree')
        const frame = tree?.frameTree?.frame
        if (typeof frame?.id === 'string' && sameTikTokLivePage(frame.url, originalUrl) && current()) {
          mainFrameId = frame.id
          http.enabled = true
          http.commentHealthReason = options.expectedRoomId && /^[1-9]\d{7,19}$/.test(options.expectedRoomId)
            ? 'awaiting-native-http' : 'http-room-binding-unverified'
          session.on('Network.responseReceived', httpResponse)
          session.on('Network.loadingFinished', httpFinished)
          session.on('Network.loadingFailed', httpFailed)
        }
      } catch { http.commentHealthReason = 'http-frame-unavailable' }
    }
    await session.send('Network.enable')
    if (!current()) throw new Error('cancelled attach')
    state.status = 'active'
    // Attaching CDP and installing a schema does not prove this page has a LIVE
    // socket. Keep DOM available until the owner accepts actual stream data.
    commentHealth(false, 'awaiting-native-stream')
  } catch {
    await stop()
    state.status = 'unavailable'
    throw new Error('TikTok browser network capture unavailable')
  }
  return {
    stop,
    snapshot() {
      if (state.status === 'active' && !current()) void stop()
      if (http.commentDecoderHealthy && Date.now() - httpAcceptedAt > HTTP_HEALTH_MS) httpHealth(false, 'http-stream-stale')
      return { ...state, active: state.status === 'active', queuedFrames: queue.length, webSocketCommentHealthy,
        http: { ...http, pendingResponses: httpPending.size, queuedResponses: httpQueue.length } }
    },
  }
}
