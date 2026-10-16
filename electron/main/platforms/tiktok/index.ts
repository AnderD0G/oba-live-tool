import { Result } from '@praha/byethrow'
import { randomUUID } from 'node:crypto'
import { session as electronSession } from 'electron'
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent'
import type { Locator, Page } from 'playwright'
import {
  TikTokLiveConnection,
  ControlEvent,
  type TikTokLiveConstructorConnectionOptions,
  WebcastEvent,
} from 'tiktok-live-connector'
import { UnexpectedError } from '#/errors/AppError'
import { PageNotFoundError, type PlatformError } from '#/errors/PlatformError'
import { createLogger } from '#/logger'
import type { BrowserSession } from '#/managers/BrowserSessionManager'
import type {
  BusinessSourceObservation,
  IBusinessDataSource,
  ICommentListener,
  IConfigurablePlatform,
  ILoginFirstPlatform,
  IPerformComment,
  IPlatform,
  ITranslationObserver,
} from '../IPlatform'
import {
  extractTikTokCookieSession,
  extractTargetBoundTikTokRoomId,
  verifiesTikTokSdkRoomInfo,
  proxyUrlFromRule,
  type TikTokCookieSession,
} from './connection'
import { normalizeTikTokUsername, toTikTokComment, toTikTokDomComment, toTikTokEngagement, toTikTokGift, toTikTokMember } from './messages'
import { serializeTikTokDecodedEvidence } from './decodedEvidence'
import { sanitizeBusinessPayload } from '../../services/analysisRoom/BusinessPayload'
import { type TikTokDomParser, tikTokDomParserSource } from './domCommentParser'
import type { CaptureTransports } from '../../../../shared/analysisRoom'
import { TikTokGiftDeliveryGate } from './giftDeliveryGate'
import { TikTokWireDiagnostics } from './wireDiagnostics'
import { safeTikTokFailure, type TikTokSafeFailure, type TikTokFailureStage } from './failureDiagnostics'
import { startTikTokBrowserNetwork, type TikTokBrowserNetworkHandle } from './browserNetwork'
import { sameTikTokLivePage } from './livePageIdentity'
import { readOwnedTikTokRoomEnterProof } from './roomEnterProof'
import { TikTokNativeDeliveryGate } from './nativeDeliveryGate'

function hasStableNativeCommentId(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const common = (data as { common?: unknown }).common
  if (!common || typeof common !== 'object' || Array.isArray(common)) return false
  const id = (common as { msgId?: unknown }).msgId
  return typeof id === 'string' && /^\d{1,256}$/.test(id) && !/^0+$/.test(id)
}
import { startTikTokBrowserTranslations } from './browserTranslation'
import { startTikTokDomTranslations } from './domBrowserTranslation'
import type { BrowserTranslationObservation } from '../../../../shared/browserTranslation'
import {
  PlatformSessionError,
  parseTikTokLiveTarget,
  parseTikTokAttachPage,
  type PlatformLiveTarget,
  type PlatformLoginSnapshot,
  type PlatformLoginQrPreview,
} from '../../../../shared/platformSession'

export { normalizeTikTokUsername, toTikTokComment, toTikTokMember } from './messages'

const PLATFORM_NAME = 'TikTok LIVE' as const
const LOGIN_URL = 'https://www.tiktok.com/login'
const SESSION_COOKIES = new Set(['sessionid', 'sessionid_ss'])
const DOM_COMMENT_BRIDGE = '__obaTikTokLiveComment'

type TikTokDomComment = {
  content: string
  nickName: string
  userId: string
  handle?: string
}

export class TikTokPlatform
  implements IPlatform, IConfigurablePlatform, ICommentListener, IPerformComment, IBusinessDataSource, ILoginFirstPlatform, ITranslationObserver
{
  readonly _isCommentListener = true
  readonly _isPerformComment = true
  readonly _isLoginFirstPlatform = true

  private username = ''
  private mainPage: Page | null = null
  private loginBrowserSession: BrowserSession | null = null
  private loginTargetReady = false
  private sessionRevision = 0
  private sessionNavigation?: symbol
  private cleanupInFlight = 0
  private connectionCleanupTail: Promise<void> = Promise.resolve()
  private connection: TikTokLiveConnection | null = null
  private browserNetwork: TikTokBrowserNetworkHandle | null = null
  private browserTranslations: Awaited<ReturnType<typeof startTikTokBrowserTranslations>> | null = null
  private domTranslations: Awaited<ReturnType<typeof startTikTokDomTranslations>> | null = null
  private translationSubscribers = new Set<(observation: BrowserTranslationObservation) => void>()
  private domBridgePages = new WeakSet<Page>()
  private listenerGeneration = 0
  private roomProofController: AbortController | null = null
  private readonly captureInstanceId = randomUUID()
  private captureGeneration = ''
  private webpageGeneration: string | null = null
  private domRoomId: string | null = null
  private listenerPage: Page | null = null
  private listenerUrl = ''
  private removePageListeners: (() => void) | null = null
  private captureTransports: CaptureTransports = { sdk: 'idle', webpage: 'idle' }
  private domMessageSequence = 0
  private cookieSession: TikTokCookieSession | null = null
  private proxyUrl: string | null = null
  private handleComment: (comment: LiveMessage) => void = () => {}
  private readonly logger = createLogger('TikTok LIVE')
  private businessSubscribers = new Set<(observation: BusinessSourceObservation) => void>()
  private listenerInvalidationSubscribers = new Set<(reason: string) => void>()
  private businessStreamId = randomUUID()
  private businessSequence = 0
  private readonly nativeDeliveryGate = new TikTokNativeDeliveryGate()
  private readonly giftDeliveryGate = new TikTokGiftDeliveryGate()
  private readonly wireDiagnostics = new TikTokWireDiagnostics()
  private readonly browserWireDiagnostics = new TikTokWireDiagnostics()
  private sdkFailure: TikTokSafeFailure | null = null
  private sdkCommentsHealthy = false
  private browserCommentsHealthy = false
  private commentRouteReason = 'native-starting-or-unavailable'
  private domStandbyObservations = 0
  private canonicalComments = { sdk: 0, 'browser-native': 0, webpage: 0 }

  subscribeBusiness(listener: (observation: BusinessSourceObservation) => void) {
    this.businessSubscribers.add(listener)
    return () => { this.businessSubscribers.delete(listener) }
  }

  subscribeListenerInvalidation(listener: (reason: string) => void) {
    this.listenerInvalidationSubscribers.add(listener)
    return () => { this.listenerInvalidationSubscribers.delete(listener) }
  }

  subscribeTranslations(listener: (observation: BrowserTranslationObservation) => void) {
    this.translationSubscribers.add(listener)
    return () => { this.translationSubscribers.delete(listener) }
  }

  businessCapabilities() {
    return { sources: ['control' as const], formatVersion: 1, captureTransports: { ...this.captureTransports } }
  }

  getSdkNetworkDiagnostics(marker?: string) {
    const preferredSource = this.commentDeliverySource()
    return {
      ...this.wireDiagnostics.snapshot(marker),
      commentDelivery: { source: preferredSource, strategy: 'native-id-first-arrival' as const, reason: preferredSource === 'idle'
        ? (this.domRoomId ? 'native-channels-not-ready' : 'native-room-binding-unverified')
        : preferredSource === 'browser-native' ? this.browserNetwork?.snapshot().commentHealthReason || 'browser-native-primary' : this.commentRouteReason,
        sdkHealthy: this.sdkCommentsHealthy, browserNativeHealthy: this.browserCommentsHealthy,
        domStandbyObservations: this.domStandbyObservations, delivered: { ...this.canonicalComments } },
      ...(this.sdkFailure ? { connectionFailure: { ...this.sdkFailure } } : {}),
      ...(this.browserTranslations ? { browserTranslations: this.browserTranslations.snapshot() } : {}),
      ...(this.domTranslations ? { domTranslations: this.domTranslations.snapshot() } : {}),
      ...(this.browserNetwork ? { browserNetwork: {
        ...this.browserNetwork.snapshot(),
        wire: { ...this.browserWireDiagnostics.snapshot(marker), kind: 'browser-network-snapshot' as const },
      } } : {}),
    }
  }

  private publishBusiness(observation: BusinessSourceObservation) {
    for (const listener of this.businessSubscribers) {
      try { listener(observation) } catch { /* Evidence observers cannot interrupt normal monitoring. */ }
    }
  }

  private observeDecoded(type: string, event: unknown, binary: Uint8Array, provenance: 'sdk-decoded' | 'cdp-websocket-decoded' | 'cdp-http-decoded' = 'sdk-decoded') {
    if (provenance === 'sdk-decoded') this.wireDiagnostics.observeDecoded(type, binary)
    else this.browserWireDiagnostics.observeDecoded(type, binary)
    if (!this.businessSubscribers.size) return
    const result = serializeTikTokDecodedEvidence(type, event, binary)
    const decoded = result.evidence ? JSON.parse(result.evidence.json) : undefined
    const data = decoded?.data
    const common = data?.common
    const receivedAt = Date.now()
    const timestamp = Number(common?.createTime)
    const platformTime = timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp
    // Protobuf defaults use "0" for an absent ID; keep it in evidence, not room binding metadata.
    const identifier = (value: unknown) => typeof value === 'string' && value !== '0' && /^[\p{L}\p{N}_.:-]{1,256}$/u.test(value) ? value : undefined
    const sourceMessageId = identifier(common?.msgId)
    const roomId = identifier(common?.roomId)
    const payload = sanitizeBusinessPayload(data ?? null)
    this.publishBusiness({
      ...payload,
      observationId: randomUUID(),
      streamId: this.businessStreamId,
      sequence: ++this.businessSequence,
      receivedAt,
      formatVersion: 1,
      businessType: /^[A-Za-z0-9_.:-]{1,128}$/.test(type) ? type : 'UnknownTikTokEvent',
      provenance,
      ...(Number.isSafeInteger(platformTime) && platformTime > 0 && platformTime <= receivedAt + 86400000 ? { platformTime } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(roomId ? { roomId } : {}),
      ...(result.evidence ? { original: { ...result.evidence, provenance } } : {}),
      ...(result.errorCode ? { originalFailureCode: result.errorCode, complete: false } : {}),
    })
  }

  configure(config: LivePlatformConfig) {
    this.username = normalizeTikTokUsername(config.tiktokUsername)
  }

  private requireUsername() {
    if (!this.username) {
      throw new Error('请先填写 TikTok 主播账号，例如 @yourname')
    }
  }

  private liveUrl() {
    this.requireUsername()
    return `https://www.tiktok.com/@${encodeURIComponent(this.username)}/live`
  }

  private async hasLoginSession(session: BrowserSession, assertCurrent?: () => void) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let cookies: Awaited<ReturnType<BrowserSession['context']['cookies']>>
    try {
      cookies = await Promise.race([
        session.context.cookies('https://www.tiktok.com'),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new PlatformSessionError('OPERATION_FAILED', '读取 TikTok 登录状态超时，请重试')), 3000)
        }),
      ])
    } finally { if (timeout) clearTimeout(timeout) }
    assertCurrent?.()
    this.cookieSession = extractTikTokCookieSession(cookies)
    const hasSession = cookies.some(
      cookie => SESSION_COOKIES.has(cookie.name) && cookie.value.length > 0,
    )
    if (this.cookieSession) {
      this.logger.info('已读取 TikTok 登录会话，将用于识别当前账号可见的直播间')
    } else if (hasSession) {
      this.logger.warn('TikTok 登录会话缺少区域信息，受限直播间可能无法识别')
    }
    return hasSession
  }

  private ownLoginBrowser(session: BrowserSession) {
    this.loginBrowserSession = session
    this.mainPage = session.page
    this.loginTargetReady = false
    ++this.sessionRevision
  }

  private ownedLoginBrowser(session: BrowserSession) {
    const page = session.page
    const revision = this.sessionRevision
    const assertCurrent = () => {
      if (this.loginBrowserSession !== session || session.page !== page || this.mainPage !== page ||
        this.sessionRevision !== revision || page.isClosed())
        throw new PlatformSessionError('SESSION_CHANGED', '账号浏览器或页面已变化，请刷新后重试')
    }
    assertCurrent()
    return { page, assertCurrent }
  }

  private hasActiveCapture() {
    return this.cleanupInFlight > 0 || !!this.connection || !!this.browserNetwork || !!this.webpageGeneration ||
      this.captureTransports.sdk === 'connecting' || this.captureTransports.sdk === 'connected' ||
      this.captureTransports.browserNetwork === 'connecting' || this.captureTransports.browserNetwork === 'active' ||
      this.captureTransports.webpage === 'active'
  }

  private isTargetPage(page: Page, target: PlatformLiveTarget) {
    try {
      const url = new URL(page.url())
      return url.protocol === 'https:' && ['www.tiktok.com', 'tiktok.com'].includes(url.hostname) &&
        !url.username && !url.password && !url.port &&
        (url.pathname === `/@${target.username}/live` || url.pathname === `/@${target.username}/live/`)
    } catch { return false }
  }

  async openLoginBrowser(session: BrowserSession): Promise<void> {
    if (this.sessionNavigation || this.hasActiveCapture())
      throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听，再打开登录页')
    const operation = Symbol('login-page')
    this.sessionNavigation = operation
    this.ownLoginBrowser(session)
    const { page, assertCurrent } = this.ownedLoginBrowser(session)
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
      assertCurrent()
    } finally {
      if (this.sessionNavigation === operation) this.sessionNavigation = undefined
    }
  }

  async attachLoginBrowser(session: BrowserSession, pageUrl: string): Promise<void> {
    const target = parseTikTokAttachPage(pageUrl)
    if (this.sessionNavigation || this.hasActiveCapture())
      throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听，再接入现有浏览器')
    if (session.page.isClosed() || !sameTikTokLivePage(session.page.url(), pageUrl))
      throw new PlatformSessionError('SESSION_CHANGED', '接入期间直播页面已变化')
    this.ownLoginBrowser(session)
    const { page, assertCurrent } = this.ownedLoginBrowser(session)
    const assertPage = () => {
      assertCurrent()
      if (!sameTikTokLivePage(page.url(), pageUrl)) throw new PlatformSessionError('SESSION_CHANGED', '接入期间直播页面已变化')
    }
    try {
      if (!(await this.hasLoginSession(session, assertPage)))
        throw new PlatformSessionError('LOGIN_REQUIRED', '这个 Chrome 的 TikTok 登录尚未生效，请在原窗口完成登录')
      assertPage()
      this.username = target.username
      this.loginTargetReady = true
    } catch (error) {
      if (this.loginBrowserSession === session) {
        ++this.sessionRevision
        this.loginBrowserSession = null
        this.mainPage = null
        this.loginTargetReady = false
        this.cookieSession = null
      }
      throw error
    }
  }

  async getPlatformSessionState(session: BrowserSession): Promise<PlatformLoginSnapshot> {
    const { page, assertCurrent } = this.ownedLoginBrowser(session)
    const authenticated = await this.hasLoginSession(session, assertCurrent)
    assertCurrent()
    const target = this.username ? parseTikTokLiveTarget(this.username) : undefined
    return {
      browserOpen: true, loginStatus: authenticated ? 'authenticated' : 'required',
      ...(target ? { target } : {}),
      roomReady: authenticated && this.loginTargetReady && !!target && this.isTargetPage(page, target),
    }
  }

  async setLiveTarget(session: BrowserSession, input: string): Promise<void> {
    const target = parseTikTokLiveTarget(input)
    const current = this.ownedLoginBrowser(session)
    if (this.sessionNavigation || this.hasActiveCapture())
      throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听，再切换直播间')
    const operation = Symbol('room-page')
    this.sessionNavigation = operation
    this.loginTargetReady = false
    try {
      if (!(await this.hasLoginSession(session, current.assertCurrent)))
        throw new PlatformSessionError('LOGIN_REQUIRED', '请先在账号浏览器中完成 TikTok 登录')
      current.assertCurrent()
      if (this.hasActiveCapture()) throw new PlatformSessionError('SESSION_BUSY', '请先停止账号监听，再切换直播间')
      this.username = target.username
      ++this.sessionRevision
      const { page, assertCurrent } = this.ownedLoginBrowser(session)
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      assertCurrent()
      if (!this.isTargetPage(page, target)) throw new PlatformSessionError('ROOM_NOT_READY', '账号页面未停留在所选直播间，请检查登录和房间网址')
      this.loginTargetReady = true
    } finally {
      if (this.sessionNavigation === operation) this.sessionNavigation = undefined
    }
  }

  async getLoginQrPreview(session: BrowserSession): Promise<PlatformLoginQrPreview> {
    const { page, assertCurrent } = this.ownedLoginBrowser(session)
    const pageUrl = page.url()
    const loginPage = () => {
      try {
        const url = new URL(page.url())
        return url.protocol === 'https:' && ['www.tiktok.com', 'tiktok.com'].includes(url.hostname) &&
          !url.username && !url.password && !url.port && /^\/login(?:\/(?:qr|qrcode))?\/?$/.test(url.pathname)
      } catch { return false }
    }
    if (this.sessionNavigation) throw new PlatformSessionError('SESSION_BUSY', '账号页面正在切换，请稍后重试')
    if (!loginPage()) throw new PlatformSessionError('QR_NOT_VISIBLE', '当前页面没有可见的 TikTok 登录二维码')
    // Only explicit QR image/canvas/svg nodes qualify; no container or full-page screenshots.
    const qrRoots = ['[data-e2e="qr-code"]', '[data-e2e="qrcode"]', '[data-e2e="login-qr-code"]']
    const selector = [
      ...qrRoots.flatMap(root => [`${root}:is(canvas,img,svg)`, `${root} :is(canvas,img,svg)`]),
      'img[alt*="QR" i]', 'img[alt*="二维码"]', 'canvas[aria-label*="QR" i]', 'svg[aria-label*="QR" i]',
    ].join(',')
    const candidates = page.locator(selector)
    const count = Math.min(await candidates.count(), 8)
    assertCurrent()
    for (let index = 0; index < count; index++) {
      const candidate = candidates.nth(index)
      if (!(await candidate.isVisible().catch(() => false))) continue
      const bounds = await candidate.boundingBox()
      assertCurrent()
      if (!bounds || bounds.width < 32 || bounds.height < 32 || bounds.width > 1024 || bounds.height > 1024) continue
      const overlapsInput = await candidate.evaluate(element => {
        const qr = element.getBoundingClientRect()
        return Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"]')).some(input => {
          const style = getComputedStyle(input)
          const box = input.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 &&
            box.width > 0 && box.height > 0 && qr.left < box.right && qr.right > box.left && qr.top < box.bottom && qr.bottom > box.top
        })
      }, undefined, { timeout: 1000 }).catch(() => true)
      assertCurrent()
      if (overlapsInput) continue
      let png: Buffer
      try {
        png = await candidate.screenshot({ type: 'png', scale: 'css', timeout: 2000, animations: 'disabled' })
      } catch {
        assertCurrent()
        throw new PlatformSessionError('QR_CAPTURE_FAILED', '可见二维码截图失败，请重试')
      }
      assertCurrent()
      if (page.url() !== pageUrl || !loginPage()) throw new PlatformSessionError('SESSION_CHANGED', '截图期间账号页面已变化，请刷新后重试')
      if (png.length < 24 || png.length > 524288 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new PlatformSessionError('QR_CAPTURE_FAILED', '二维码截图超过限制或格式无效')
      const width = png.readUInt32BE(16)
      const height = png.readUInt32BE(20)
      if (width < 32 || height < 32 || width > 1024 || height > 1024)
        throw new PlatformSessionError('QR_CAPTURE_FAILED', '二维码截图尺寸无效')
      return { mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}`, capturedAt: Date.now(), width, height }
    }
    throw new PlatformSessionError('QR_NOT_VISIBLE', '当前页面没有可见的 TikTok 登录二维码，请手动选择二维码登录')
  }

  private async resolveSystemProxy() {
    if (this.proxyUrl) return this.proxyUrl
    const configured = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    if (configured) {
      this.proxyUrl = configured
      return configured
    }
    const rule = await electronSession.defaultSession.resolveProxy('https://www.tiktok.com')
    this.proxyUrl = proxyUrlFromRule(rule)
    if (this.proxyUrl) this.logger.info('弹幕连接将使用系统代理')
    return this.proxyUrl
  }

  private async roomIdFromLoggedPage(generation?: number, signal?: AbortSignal) {
    const page = this.mainPage
    if (!page || page.isClosed()) return null
    const pageUrl = page.url()
    const username = this.username
    const deadline = Date.now() + 15000
    const current = () => !signal?.aborted && this.mainPage === page && !page.isClosed() && sameTikTokLivePage(page.url(), pageUrl) && this.username === username && (generation === undefined || generation === this.listenerGeneration)
    let timer: ReturnType<typeof setTimeout> | undefined, removeAbort: (() => void) | undefined
    const read = (async () => {
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
      if (!current()) return null
      return page.evaluate(() => {
        const bindings: Array<{ uniqueId: string; roomId: string }> = []
        const field = (value: unknown, key: string): unknown => value && typeof value === 'object'
          ? (value as Record<string, unknown>)[key] : undefined
        const pair = (value: unknown, ownerKey: string) => {
          const uniqueId = field(value, ownerKey)
          const roomId = field(value, 'roomId')
          if (typeof uniqueId === 'string' && typeof roomId === 'string') bindings.push({ uniqueId, roomId })
        }
        const add = (state: unknown) => {
          const room = field(field(state, 'LiveRoom'), 'liveRoomUserInfo')
          pair(field(room, 'user'), 'uniqueId')
        }
        // SSR may belong to the room visited before an SPA navigation. Export only public owner/room pairs.
        const text = document.getElementById('SIGI_STATE')?.textContent
        if (text && text.length <= 2 * 1024 * 1024) {
          try { add(JSON.parse(text)) } catch { /* Missing/invalid state never becomes a binding. */ }
        }
        return { pageUrl: location.href, bindings }
      })
    })()
    let pageState: { pageUrl: string; bindings: { uniqueId: string; roomId: string }[] } | null
    try {
      pageState = await Promise.race([read, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), 3000)
        const abort = () => resolve(null)
        signal?.addEventListener('abort', abort, { once: true }); removeAbort = () => signal?.removeEventListener('abort', abort)
      })])
    } finally { if (timer) clearTimeout(timer); removeAbort?.() }
    if (!current()) return null
    let roomId = pageState ? extractTargetBoundTikTokRoomId(pageState.bindings, pageState.pageUrl, username) : null
    // Only an explicitly authenticated, selected LIVE page may refresh to obtain first-party owner proof.
    if (!roomId && generation !== undefined && this.loginTargetReady && current() && Date.now() < deadline) {
      roomId = await readOwnedTikTokRoomEnterProof({ page, expectedUsername: username, isCurrent: current, signal, timeoutMs: Math.max(1, deadline - Date.now()) })
    }
    if (!current()) return null
    this.logger.info(`已登录直播页可信房间绑定：target=@${username}，roomId=${roomId || '未知；只保留诊断，不交付未绑定原生事件'}`)
    return roomId
  }

  private async startDomCommentListener(listenerGeneration = this.listenerGeneration) {
    const page = this.mainPage
    if (!page || page.isClosed()) throw new PageNotFoundError()

    const generation = randomUUID()
    this.webpageGeneration = generation
    this.listenerPage = page
    this.listenerUrl = typeof page.url === 'function' ? page.url() : ''
    if (!this.domBridgePages.has(page)) {
      await page.exposeBinding(DOM_COMMENT_BRIDGE, (_source, value: TikTokDomComment, deliveryGeneration?: string) => {
        if (deliveryGeneration !== this.webpageGeneration || this.listenerPage !== page ||
          page !== this.mainPage || page.isClosed() ||
          (this.listenerUrl && !sameTikTokLivePage(page.url(), this.listenerUrl))) return
        const content = value?.content?.trim()
        if (!content) return
        this.logger.info(
          `登录网页捕获到新弹幕：用户=${value.nickName || value.userId || '未知'}，内容=${JSON.stringify(content)}`,
        )
        this.domMessageSequence += 1
        const message = toTikTokDomComment(value, `tiktok-dom-${Date.now()}-${this.domMessageSequence}`)
        if (message) {
          this.publishBusiness({
            ...sanitizeBusinessPayload(value),
            observationId: randomUUID(), streamId: this.businessStreamId,
            sequence: ++this.businessSequence, receivedAt: Date.now(), formatVersion: 1,
            sourceMessageId: message.msg_id, businessType: 'TikTokDomComment', provenance: 'dom-observation',
            ...(this.domRoomId ? { roomId: this.domRoomId } : {}),
          })
          this.onLiveMessage(message, 'webpage')
        }
      })
      this.domBridgePages.add(page)
    }
    if (listenerGeneration !== this.listenerGeneration || this.webpageGeneration !== generation || page.isClosed())
      throw new Error('TikTok 采集启动已取消')

    const initialRows = await page.evaluate(({ bridgeName, parserSource, generation }) => {
      type BridgeWindow = Window & {
        __obaTikTokCommentObserver?: MutationObserver
        __obaTikTokCommentPoll?: number
        __obaTikTokCommentGeneration?: string
        [key: string]: unknown
      }
      const targetWindow = window as unknown as BridgeWindow
      targetWindow.__obaTikTokCommentGeneration = generation
      targetWindow.__obaTikTokCommentObserver?.disconnect()
      if (targetWindow.__obaTikTokCommentPoll) {
        window.clearInterval(targetWindow.__obaTikTokCommentPoll)
      }
      const rowSelector = '.text-UIText1'
      const parser = new Function(`return (${parserSource})()`)() as TikTokDomParser
      const lastFingerprints = new WeakMap<Element, string>()
      const pendingFingerprints = new WeakMap<Element, { fingerprint: string }>()

      const scanRow = (row: Element) => {
        if (targetWindow.__obaTikTokCommentGeneration !== generation) return
        const parsed = parser.parse(row)
        if (parsed.parseStatus !== 'parsed') return
        const message = parsed.comment
        const currentFingerprint = parser.fingerprint(message)
        if (
          lastFingerprints.get(row) === currentFingerprint ||
          pendingFingerprints.get(row)?.fingerprint === currentFingerprint
        ) return
        const bridge = targetWindow[bridgeName]
        if (typeof bridge === 'function') {
          const delivery = { fingerprint: currentFingerprint }
          pendingFingerprints.set(row, delivery)
          void Promise.resolve()
            .then(() => {
              if (targetWindow.__obaTikTokCommentGeneration === generation)
                return (bridge as (value: TikTokDomComment, generation: string) => Promise<void>)(message, generation)
            })
            .then(() => {
              if (pendingFingerprints.get(row) === delivery)
                lastFingerprints.set(row, currentFingerprint)
            })
            .catch(() => { /* Retry a failed delivery on the next row scan. */ })
            .finally(() => {
              if (pendingFingerprints.get(row) === delivery)
                pendingFingerprints.delete(row)
            })
        }
      }

      const scheduleRowScan = (row: Element) => {
        window.setTimeout(() => scanRow(row), 120)
      }

      const existingRows = Array.from(document.querySelectorAll(rowSelector))
      existingRows.forEach(row => {
        const parsed = parser.parse(row)
        if (parsed.parseStatus === 'parsed')
          lastFingerprints.set(row, parser.fingerprint(parsed.comment))
      })
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          const targetElement =
            mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
          const targetRow = targetElement?.closest(rowSelector)
          if (targetRow) scheduleRowScan(targetRow)
          for (const node of mutation.addedNodes) {
            const element = node instanceof Element ? node : node.parentElement
            if (!element) continue
            if (element.matches(rowSelector)) scheduleRowScan(element)
            element.querySelectorAll(rowSelector).forEach(scheduleRowScan)
            const parentRow = element.closest(rowSelector)
            if (parentRow) scheduleRowScan(parentRow)
          }
        }
      })
      observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['data-e2e', 'href', 'contenteditable'],
      })
      targetWindow.__obaTikTokCommentObserver = observer
      targetWindow.__obaTikTokCommentPoll = window.setInterval(() => {
        document.querySelectorAll(rowSelector).forEach(scanRow)
      }, 500)
      return existingRows.length
    }, { bridgeName: DOM_COMMENT_BRIDGE, parserSource: tikTokDomParserSource, generation })
    this.logger.info(`已启用登录网页弹幕监听，当前可见消息行：${initialRows}`)
  }

  private async stopDomCommentListener(page = this.listenerPage ?? this.mainPage, generation = this.webpageGeneration) {
    if (this.webpageGeneration === generation) this.webpageGeneration = null
    if (!page || page.isClosed()) return
    await page
      .evaluate(generation => {
        const targetWindow = window as Window & {
          __obaTikTokCommentObserver?: MutationObserver
          __obaTikTokCommentPoll?: number
          __obaTikTokCommentGeneration?: string
        }
        if (targetWindow.__obaTikTokCommentGeneration && targetWindow.__obaTikTokCommentGeneration !== generation) return
        targetWindow.__obaTikTokCommentObserver?.disconnect()
        targetWindow.__obaTikTokCommentObserver = undefined
        targetWindow.__obaTikTokCommentGeneration = undefined
        if (targetWindow.__obaTikTokCommentPoll) {
          window.clearInterval(targetWindow.__obaTikTokCommentPoll)
          targetWindow.__obaTikTokCommentPoll = undefined
        }
      }, generation)
      .catch(() => {})
  }

  async connect(browserSession: BrowserSession) {
    this.requireUsername()
    this.ownLoginBrowser(browserSession)
    const { assertCurrent } = this.ownedLoginBrowser(browserSession)
    if (!(await this.hasLoginSession(browserSession, assertCurrent))) return false
    await browserSession.page.goto(this.liveUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    assertCurrent()
    this.loginTargetReady = true
    return true
  }

  async login(browserSession: BrowserSession) {
    this.requireUsername()
    const { page, context } = browserSession
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    this.logger.info('请在打开的 TikTok 页面完成登录')

    while (!page.isClosed()) {
      const cookies = await context.cookies('https://www.tiktok.com')
      if (cookies.some(cookie => SESSION_COOKIES.has(cookie.name) && cookie.value.length > 0)) {
        return
      }
      await page.waitForTimeout(1_000)
    }
    throw new Error('TikTok 登录窗口已关闭')
  }

  async getAccountName() {
    return `@${this.username}`
  }

  async disconnect() {
    ++this.sessionRevision
    this.loginTargetReady = false
    this.loginBrowserSession = null
    await this.stopConnection()
    this.mainPage = null
  }

  async startCommentListener(onComment: (comment: LiveMessage) => void) {
    if (this.sessionNavigation) throw new PlatformSessionError('SESSION_BUSY', '账号页面正在切换，请稍后开始监听')
    this.requireUsername()
    const cleanup = this.stopConnection()
    const generation = this.listenerGeneration
    const page = this.mainPage
    const pageUrl = page && typeof page.url === 'function' ? page.url() : ''
    const username = this.username
    await cleanup
    const current = () => generation === this.listenerGeneration && this.mainPage === page && this.username === username &&
      !!page && !page.isClosed() && sameTikTokLivePage(page.url(), pageUrl) &&
      this.isTargetPage(page, { username, url: this.liveUrl() })
    if (!current()) throw new Error('TikTok 采集启动已取消')
    this.handleComment = onComment
    this.businessStreamId = randomUUID()
    this.captureGeneration = `${this.captureInstanceId}:${generation}`
    this.businessSequence = 0
    this.captureTransports = { sdk: 'connecting', webpage: 'idle', browserNetwork: 'connecting' }
    if (page && typeof page.on === 'function') {
      const invalidate = (reason: 'PAGE_CLOSED' | 'PAGE_CHANGED') => {
        // Closing the page makes current() false, so ownership must be checked separately.
        if (generation !== this.listenerGeneration || this.mainPage !== page) return
        void this.stopConnection().catch(() => { this.logger.warn('TikTok 失效监听清理失败') })
        this.captureTransports = { sdk: 'unavailable', webpage: 'unavailable', browserNetwork: 'unavailable', reason }
        for (const listener of [...this.listenerInvalidationSubscribers]) {
          try { listener(reason) } catch { this.logger.warn('TikTok 监听失效通知失败') }
        }
      }
      const closed = () => invalidate('PAGE_CLOSED')
      const navigated = (frame: import('playwright').Frame) => {
        if (frame === page.mainFrame() && !sameTikTokLivePage(page.url(), this.listenerUrl)) invalidate('PAGE_CHANGED')
      }
      page.on('close', closed)
      page.on('framenavigated', navigated)
      this.removePageListeners = () => {
        page.off('close', closed)
        page.off('framenavigated', navigated)
      }
    }
    let loggedPageRoomId: string | null = null
    this.listenerUrl = pageUrl
    const roomProofController = new AbortController()
    this.roomProofController = roomProofController
    try {
      loggedPageRoomId = await this.roomIdFromLoggedPage(generation, roomProofController.signal)
      if (current() && pageUrl && page && sameTikTokLivePage(page.url(), pageUrl) &&
        this.isTargetPage(page, { username: this.username, url: this.liveUrl() }) &&
        loggedPageRoomId && /^\d{10,}$/.test(loggedPageRoomId)) this.domRoomId = loggedPageRoomId
    } catch { this.logger.warn('登录网页房间 ID 暂不可用，网页证据将保持房间未知') }
    finally { if (this.roomProofController === roomProofController) this.roomProofController = null }
    if (!current()) throw new Error('TikTok 采集启动已取消')
    try {
      await this.startDomCommentListener(generation)
      if (!current()) throw new Error('TikTok 采集启动已取消')
      this.captureTransports = { ...this.captureTransports, sdk: 'connecting', webpage: 'active' }
    } catch {
      if (!current()) throw new Error('TikTok 采集启动已取消')
      await this.stopDomCommentListener(page)
      if (!current()) throw new Error('TikTok 采集启动已取消')
      this.captureTransports = { ...this.captureTransports, sdk: 'connecting', webpage: 'unavailable', reason: 'WEBPAGE_LISTENER_FAILED' }
    }
    await this.startBrowserNetworkListener(generation, page, pageUrl)
    if (!current()) throw new Error('TikTok 采集启动已取消')
    await this.startBrowserTranslationListener(generation, page, pageUrl)
    if (!current()) throw new Error('TikTok 采集启动已取消')
    const sdkReady = this.startSdkCommentListener(generation, page, loggedPageRoomId)
    // The owned webpage is already usable; a remote handshake must not block capture or stop.
    if (this.captureTransports.webpage === 'active' || this.captureTransports.browserNetwork === 'active') {
      void sdkReady
      return
    }
    const sdkAvailable = await sdkReady
    if (!current()) throw new Error('TikTok 采集启动已取消')
    if (!sdkAvailable) {
      const cleanup = this.stopConnection()
      const failureGeneration = this.listenerGeneration
      await cleanup
      if (failureGeneration === this.listenerGeneration)
        this.captureTransports = { sdk: 'unavailable', webpage: 'unavailable', browserNetwork: 'unavailable', reason: 'CAPTURE_TRANSPORTS_UNAVAILABLE' }
      throw new Error('TikTok 采集通道均不可用，请检查直播页及网络后重试')
    }
  }

  private async startBrowserTranslationListener(generation: number, page: Page | null, pageUrl: string) {
    const captureGeneration = this.captureGeneration
    const current = () => generation === this.listenerGeneration && this.mainPage === page && !!page &&
      !page.isClosed() && typeof page.url === 'function' && sameTikTokLivePage(page.url(), pageUrl) && this.captureGeneration === captureGeneration
    try {
      if (!page || !current()) return
      const handle = await startTikTokBrowserTranslations({ page, isCurrent: current, captureGeneration,
        onTranslation: observation => {
          if (!current()) return
          // Rendering supplements never enter comment consumers, business records or welcome hooks.
          for (const subscriber of this.translationSubscribers) {
            try { subscriber(observation) } catch { this.logger.warn('网页译文接收失败') }
          }
        },
      })
      if (!current()) { await handle.stop(); return }
      this.browserTranslations = handle
    } catch { if (current()) this.logger.warn('网页译文观察暂不可用，原生采集不受影响') }
    try {
      if (!page || !current()) return
      const handle = await startTikTokDomTranslations({ page, isCurrent: current, captureGeneration,
        expectedRoomId: this.domRoomId ?? '', expectedUsername: this.username,
        onTranslation: observation => {
          if (!current()) return
          for (const subscriber of this.translationSubscribers) {
            try { subscriber(observation) } catch { this.logger.warn('网页译文接收失败') }
          }
        } })
      if (!current() || !handle.snapshot().active) { await handle.stop(); return }
      this.domTranslations = handle
    } catch { if (current()) this.logger.warn('双语网页译文观察暂不可用，原生采集不受影响') }
  }

  private async startBrowserNetworkListener(generation: number, page: Page | null, pageUrl: string) {
    const username = this.username, captureGeneration = this.captureGeneration
    const owned = () => generation === this.listenerGeneration && this.mainPage === page && !!page && !page.isClosed()
    const current = () => owned() && this.username === username && this.captureGeneration === captureGeneration &&
      typeof page?.url === 'function' && sameTikTokLivePage(page.url(), pageUrl)
    try {
      if (!page || !current()) throw new Error('browser network unavailable')
      const handle = await startTikTokBrowserNetwork({
        page, isCurrent: current, allowHttp: this.loginTargetReady,
        ...(this.domRoomId ? { expectedRoomId: this.domRoomId } : {}),
        onFrame: binary => { if (current()) this.browserWireDiagnostics.observeFrame(binary) },
        onCommentHealth: health => {
          if (!current()) return
          this.browserCommentsHealthy = health.ready && !!this.domRoomId
          this.commentRouteReason = this.domRoomId ? health.reason : 'native-room-binding-unverified'
        },
        onDecoded: (method, data, binary, transport) => {
          if (!current()) return false
          if (!data || typeof data !== 'object' || Array.isArray(data)) return false
          if (!this.domRoomId) {
            // Retain only bounded unbound diagnostics. No target-room originals, room
            // snapshots, hooks or canonical comments may inherit an unverified owner.
            this.browserWireDiagnostics.observeDecoded(method, binary)
            this.commentRouteReason = 'native-room-binding-unverified'
            return false
          }
          const common = (data as { common?: { roomId?: unknown } }).common
          const rawRoomId = common?.roomId
          if (rawRoomId !== undefined && (typeof rawRoomId !== 'string' || !/^\d{1,20}$/.test(rawRoomId))) return false
          const roomId = typeof rawRoomId === 'string' ? rawRoomId.replace(/^0+/, '') : ''
          if (roomId && (!/^[1-9]\d{7,19}$/.test(roomId) || roomId !== this.domRoomId.replace(/^0+/, ''))) return false
          const provenance = transport?.provenance === 'cdp-http-decoded' ? 'cdp-http-decoded' : 'cdp-websocket-decoded'
          if (provenance === 'cdp-http-decoded' && (!transport?.roomId ||
            (this.domRoomId && transport.roomId !== this.domRoomId.replace(/^0+/, '')) ||
            (roomId && roomId !== transport.roomId))) return false
          this.observeDecoded(method, { type: method, data }, binary, provenance)
          // Accept verified room evidence while withholding normalized dispatch.
          // The transport owner can then fail over a first-frame closed socket.
          if (transport?.staleTransport) return true
          // Stable comment IDs share one consumer gate across HTTP/websocket/SDK;
          // a healthy transport does not establish that it received every ID.
          if (method !== 'WebcastChatMessage' && provenance === 'cdp-http-decoded' && this.browserNetwork?.snapshot().webSocketCommentHealthy) return true
          // Keep both protocol evidence streams. Only normalized delivery is selected.
          if (method !== 'WebcastChatMessage' && this.captureTransports.sdk === 'connected' && this.sdkCommentsHealthy) return true
          const socialAction = (data as { action?: unknown }).action
          if (method === 'WebcastChatMessage') {
            if (!hasStableNativeCommentId(data)) return true
            const comment = toTikTokComment(data as Parameters<typeof toTikTokComment>[0])
            if (!comment) {
              this.browserCommentsHealthy = false
              this.commentRouteReason = 'comment-normalization-failed'
              throw new Error('TikTok native comment normalization failed')
            }
            this.browserCommentsHealthy = true
            // Protocol comments share exact native IDs across the SDK/browser takeover.
            this.onLiveMessage(comment, 'browser-native', this.domRoomId, provenance)
          } else if (method === 'WebcastMemberMessage') {
            const member = toTikTokMember(data as Parameters<typeof toTikTokMember>[0])
            if (member) this.onLiveMessage(member, 'browser-native', this.domRoomId, provenance)
          } else if (method === 'WebcastGiftMessage') {
            const gift = toTikTokGift(data as Parameters<typeof toTikTokGift>[0])
            if (gift && this.giftDeliveryGate.accept(gift)) this.onLiveMessage(gift, 'browser-native', this.domRoomId, provenance)
          } else if (method === 'WebcastLikeMessage') {
            const like = toTikTokEngagement('tiktok_like', data as Parameters<typeof toTikTokEngagement>[1])
            if (like) this.onLiveMessage(like, 'browser-native', this.domRoomId, provenance)
          } else if (method === 'WebcastSocialMessage' && (socialAction === 1 || socialAction === '1')) {
            const follow = toTikTokEngagement('tiktok_follow', data as Parameters<typeof toTikTokEngagement>[1])
            if (follow) this.onLiveMessage(follow, 'browser-native', this.domRoomId, provenance)
          }
          return true
        },
      })
      if (!current()) { await handle.stop(); return }
      this.browserNetwork = handle
      this.browserCommentsHealthy = handle.snapshot().commentDecoderHealthy && !!this.domRoomId
      this.captureTransports = { ...this.captureTransports, browserNetwork: handle.snapshot().active ? 'active' : 'unavailable' }
    } catch {
      if (owned()) {
        this.browserCommentsHealthy = false
        this.captureTransports = { ...this.captureTransports, browserNetwork: 'unavailable' }
        this.logger.warn('TikTok 浏览器原生网络监听暂不可用')
      }
    }
  }

  private async startSdkCommentListener(generation: number, page: Page | null, loggedPageRoomId: string | null): Promise<boolean> {
    let connection: TikTokLiveConnection | null = null
    let stage: TikTokFailureStage = 'proxy'
    const username = this.username
    const pageUrl = page && typeof page.url === 'function' ? page.url() : ''
    const captureGeneration = this.captureGeneration
    const current = () => generation === this.listenerGeneration && this.mainPage === page && this.username === username &&
      this.captureGeneration === captureGeneration && (!page || !page.isClosed() && typeof page.url === 'function' && sameTikTokLivePage(page.url(), pageUrl))
    try {
      const proxy = await this.resolveSystemProxy()
      if (!current()) return false

      const httpAgent = proxy ? new HttpProxyAgent({ proxy, keepAlive: true }) : undefined
      const httpsAgent = proxy ? new HttpsProxyAgent({ proxy, keepAlive: true }) : undefined
      const connectionOptions = {
        processInitialData: false,
        fetchRoomInfoOnConnect: true,
        ...(this.cookieSession
          ? {
              session: {
                cookie: {
                  type: 'cookie' as const,
                  value: this.cookieSession,
                },
              },
            }
          : {}),
        ...(proxy
          ? {
              webClientOptions: {
                agent: { http: httpAgent, https: httpsAgent },
                timeout: { request: 15_000 },
              },
              wsClientOptions: {
                agent: httpsAgent,
                handshakeTimeout: 15_000,
              },
            }
          : {}),
      } as unknown as TikTokLiveConstructorConnectionOptions
      stage = 'constructor'
      connection = new TikTokLiveConnection(username, connectionOptions)
      const ownedConnection = connection
      const active = () => current() && this.connection === ownedConnection
      let roomVerified = false
      let sdkRoomId = loggedPageRoomId
      const matchesRoom = (data: unknown) => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false
        const roomId = (data as { common?: { roomId?: unknown } }).common?.roomId
        if (roomId === undefined) return true
        if (typeof roomId !== 'string' || !/^\d{1,20}$/.test(roomId)) return false
        const normalizedRoomId = roomId.replace(/^0+/, '')
        return !normalizedRoomId || (/^[1-9]\d{7,19}$/.test(normalizedRoomId) && normalizedRoomId === sdkRoomId)
      }
      const canDeliver = (data: unknown) => active() && roomVerified && matchesRoom(data)
      connection.on(ControlEvent.WEBSOCKET_DATA, binary => {
        if (active()) this.wireDiagnostics.observeFrame(binary)
      })
      connection.on(ControlEvent.DECODED_DATA, (type, event, binary) => {
        if (!active()) return
        if (canDeliver(event?.data)) this.observeDecoded(type, event, binary)
        else this.wireDiagnostics.observeDecoded(type, binary)
      })
      connection.on(WebcastEvent.CHAT, data => {
        if (!canDeliver(data)) return
        if (!hasStableNativeCommentId(data)) return
        const comment = toTikTokComment(data)
        if (!comment) { this.sdkCommentsHealthy = false; this.commentRouteReason = 'sdk-comment-normalization-failed'; return }
        this.sdkCommentsHealthy = true
        this.logger.info(
          `弹幕库捕获到新弹幕：用户=${comment.nick_name}，内容=${JSON.stringify(comment.content)}`,
        )
        this.onLiveMessage(comment, 'sdk', sdkRoomId)
      })
      connection.on(WebcastEvent.MEMBER, data => {
        if (!canDeliver(data)) return
        const member = toTikTokMember(data)
        if (!member) return
        this.logger.info(`检测到用户${member.msg_type === 'tiktok_leave' ? '离开' : '进入'}直播间：${member.nick_name}`)
        this.onLiveMessage(member, 'sdk', sdkRoomId)
      })
      connection.on(WebcastEvent.FOLLOW, data => {
        if (!canDeliver(data)) return
        const follow = toTikTokEngagement('tiktok_follow', data)
        if (follow) this.onLiveMessage(follow, 'sdk', sdkRoomId)
      })
      connection.on(WebcastEvent.LIKE, data => {
        if (!canDeliver(data)) return
        const like = toTikTokEngagement('tiktok_like', data)
        if (like) this.onLiveMessage(like, 'sdk', sdkRoomId)
      })
      connection.on(WebcastEvent.GIFT, data => {
        if (!canDeliver(data)) return
        const gift = toTikTokGift(data, sdkRoomId)
        if (gift && this.giftDeliveryGate.accept(gift)) this.onLiveMessage(gift, 'sdk', sdkRoomId)
      })
      connection.on(ControlEvent.DISCONNECTED, () => {
        if (!active()) return
        this.connection = null
        this.sdkCommentsHealthy = false
        this.commentRouteReason = 'sdk-disconnected'
        this.captureTransports = { ...this.captureTransports, sdk: 'unavailable', reason: 'SDK_DISCONNECTED' }
        void this.closeConnector(ownedConnection)
      })
      connection.on(ControlEvent.ERROR || 'error', () => {
        if (!active()) return
        this.sdkCommentsHealthy = false
        this.commentRouteReason = 'sdk-error'
      })
      this.connection = connection
      stage = 'connect'
      const state = await connection.connect(loggedPageRoomId || undefined)
      if (!active()) {
        await this.closeConnector(connection)
        return false
      }
      if (typeof state.roomId !== 'string' || !/^[1-9]\d{7,19}$/.test(state.roomId) ||
        (loggedPageRoomId && state.roomId !== loggedPageRoomId))
        throw new PlatformSessionError('ROOM_NOT_READY', 'SDK 房间与当前主播的可信绑定不一致，保留浏览器原生采集')
      if (!loggedPageRoomId && (this.captureTransports.browserNetwork === 'active' ||
        !verifiesTikTokSdkRoomInfo(state.roomInfo, state.roomId, username)))
        throw new PlatformSessionError('ROOM_NOT_READY', 'SDK 缺少可核实的当前主播房间绑定，保留浏览器采集')
      sdkRoomId = state.roomId
      roomVerified = true
      this.sdkCommentsHealthy = true
      this.captureTransports = {
        ...this.captureTransports, sdk: 'connected',
        ...(this.captureTransports.webpage === 'unavailable' ? { reason: 'WEBPAGE_LISTENER_FAILED' as const } : {}),
      }
      this.logger.info(`弹幕已连接，直播间 ID：${state.roomId}`)
      return true
    } catch (error) {
      if (connection && this.connection === connection) this.connection = null
      if (current()) {
        this.sdkCommentsHealthy = false
        this.captureTransports = { ...this.captureTransports, sdk: 'unavailable', reason: 'SDK_CONNECT_FAILED' }
        this.sdkFailure = safeTikTokFailure(error, stage)
        this.logger.warn(`TikTok SDK 连接不可用（SDK_CONNECT_FAILED）：${JSON.stringify(this.sdkFailure)}`)
      }
      if (connection) await this.closeConnector(connection)
      return false
    }
  }

  private commentDeliverySource(): 'sdk' | 'browser-native' | 'idle' {
    // Connection/health preference only. Business admission below is the first
    // valid native ID from either current owner, preserving its real provenance.
    if (this.browserNetwork?.snapshot().active && this.browserCommentsHealthy && this.domRoomId) return 'browser-native'
    if (this.captureTransports.sdk === 'connected' && this.sdkCommentsHealthy) return 'sdk'
    return 'idle'
  }
  private onLiveMessage(liveMessage: TikTokCommentLiveMessage | TikTokMemberLiveMessage | TikTokLeaveLiveMessage | TikTokEngagementLiveMessage | TikTokGiftLiveMessage, source: 'sdk' | 'webpage' | 'browser-native' = 'sdk', nativeRoomId: string | null = this.domRoomId,
    nativeProvenance: 'sdk-decoded' | 'cdp-websocket-decoded' | 'cdp-http-decoded' = source === 'sdk' ? 'sdk-decoded' : 'cdp-websocket-decoded') {
    if (source === 'webpage') { this.domStandbyObservations++; return }
    if (!this.captureGeneration) return
    if (liveMessage.msg_type === 'tiktok_comment') {
      // Normalization can mint a UUID for a missing protocol ID. Preserve such
      // raw evidence, but do not claim a stable dual-source business identity.
      if (!/^\d{1,256}$/.test(liveMessage.msg_id) || /^0+$/.test(liveMessage.msg_id)) return
      if (!this.nativeDeliveryGate.accept(nativeRoomId, liveMessage.msg_type, liveMessage.msg_id)) return
      this.canonicalComments[source]++
    }
    else if (!this.nativeDeliveryGate.accept(nativeRoomId, liveMessage.msg_type === 'tiktok_leave' ? 'tiktok_member' : liveMessage.msg_type, liveMessage.msg_id)) return
    const canonical = { ...liveMessage, metadata: { captureGeneration: this.captureGeneration, provenance: nativeProvenance } }
    this.handleComment(canonical)
  }

  stopCommentListener() {
    return this.stopConnection()
  }

  private async stopConnection() {
    this.roomProofController?.abort()
    this.roomProofController = null
    ++this.cleanupInFlight
    ++this.listenerGeneration
    this.captureGeneration = ''
    const page = this.listenerPage ?? this.mainPage
    const webpageGeneration = this.webpageGeneration
    this.webpageGeneration = null
    this.listenerPage = null
    this.domRoomId = null
    this.handleComment = () => {}
    this.nativeDeliveryGate.clear()
    this.giftDeliveryGate.clear()
    this.wireDiagnostics.reset()
    this.browserWireDiagnostics.reset()
    this.sdkFailure = null
    this.sdkCommentsHealthy = false
    this.browserCommentsHealthy = false
    this.commentRouteReason = 'native-starting-or-unavailable'
    this.domStandbyObservations = 0
    this.canonicalComments = { sdk: 0, 'browser-native': 0, webpage: 0 }
    this.removePageListeners?.()
    this.removePageListeners = null
    const connection = this.connection
    const browserNetwork = this.browserNetwork
    const browserTranslations = this.browserTranslations
    const domTranslations = this.domTranslations
    this.connection = null
    this.browserNetwork = null
    this.browserTranslations = null
    this.domTranslations = null
    this.captureTransports = { sdk: 'idle', webpage: 'idle', browserNetwork: 'idle' }
    if (connection) connection.removeAllListeners()
    try {
      // A second stop may find null handles while an earlier stop still owns their cleanup.
      // Joining that work prevents a replacement coordinator from overtaking invalidation.
      const cleanup = Promise.allSettled([
        this.connectionCleanupTail,
        Promise.resolve().then(() => this.stopDomCommentListener(page, webpageGeneration)),
        Promise.resolve().then(() => connection ? this.closeConnector(connection) : undefined),
        Promise.resolve().then(() => browserNetwork?.stop()),
        Promise.resolve().then(() => browserTranslations?.stop()),
        Promise.resolve().then(() => domTranslations?.stop()),
      ]).then(results => {
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })
      this.connectionCleanupTail = cleanup.catch(() => {})
      await cleanup
    } finally { --this.cleanupInFlight }
  }

  private async closeConnector(connection: TikTokLiveConnection) {
    connection.removeAllListeners()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => connection.disconnect()).catch(() => { this.logger.warn('TikTok SDK 连接清理失败') }),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 1500) }),
      ])
    } finally { if (timeout) clearTimeout(timeout) }
  }

  getCommentListenerPage() {
    if (!this.mainPage || this.mainPage.isClosed()) throw new PageNotFoundError()
    return this.mainPage
  }

  getCommentPage() {
    return this.mainPage
  }

  async performComment(message: string): Result.ResultAsync<boolean, PlatformError> {
    return Result.try({
      immediate: true,
      try: async () => {
        await this.sendPageComment(message)
        return false
      },
      catch: error =>
        error instanceof PageNotFoundError
          ? error
          : new UnexpectedError({
              description: error instanceof Error ? error.message : String(error),
            }),
    })
  }

  async performConfirmedComment(message: string, signal: AbortSignal) {
    if (signal.aborted) return false
    try {
      await this.sendPageComment(message, signal)
    } catch (error) {
      if (signal.aborted) return false
      throw error
    }
    return !signal.aborted
  }

  private async findCommentInput(page: Page): Promise<Locator | null> {
    const selectors = [
      '[data-e2e="room-chat-input-field"]',
      '[data-e2e="enter-message"][contenteditable]',
      '[data-e2e="enter-message"] [contenteditable]',
      '[data-e2e="enter-message"] textarea',
      '[data-e2e="comment-input"] textarea',
      '[data-e2e="comment-input"] [contenteditable="true"]',
      'div[contenteditable="plaintext-only"][placeholder]',
      '[contenteditable="plaintext-only"]',
      'textarea[placeholder*="comment" i]',
      'textarea[placeholder*="something" i]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
    ]
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector)
        const count = await candidates.count()
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index)
          if (await candidate.isVisible().catch(() => false)) return candidate
        }
      }
    }
    return null
  }

  private async logCommentInputDiagnostics(page: Page) {
    const diagnostics = await Promise.all(
      page.frames().map(async frame => ({
        url: frame.url(),
        controls: await frame
          .locator('textarea, [contenteditable]')
          .evaluateAll(elements =>
            elements.slice(0, 20).map(element => {
              const htmlElement = element as HTMLElement
              const rect = htmlElement.getBoundingClientRect()
              return {
                tag: element.tagName,
                dataE2e: element.getAttribute('data-e2e'),
                role: element.getAttribute('role'),
                placeholder: element.getAttribute('placeholder'),
                contentEditable: element.getAttribute('contenteditable'),
                visible: rect.width > 0 && rect.height > 0,
              }
            }),
          )
          .catch(() => []),
      })),
    )
    this.logger.warn(`TikTok 评论输入控件诊断：${JSON.stringify(diagnostics)}`)
  }

  private async sendPageComment(message: string, signal?: AbortSignal) {
    const page = this.mainPage
    if (!page || page.isClosed()) throw new PageNotFoundError()
    const target = parseTikTokLiveTarget(this.username)
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (this.mainPage !== page || page.isClosed() || this.username !== target.username)
        throw new PlatformSessionError('SESSION_CHANGED', '发送期间账号页面或直播间已变化')
      if (!this.isTargetPage(page, target)) throw new PlatformSessionError('ROOM_NOT_READY', '账号页面未停留在所选直播间')
    }
    if (!this.isTargetPage(page, target)) {
      if (signal) throw new PlatformSessionError('ROOM_NOT_READY', '账号页面未停留在所选直播间')
      await page.goto(this.liveUrl(), { waitUntil: 'domcontentloaded', timeout: 45_000 })
    }
    assertCurrent()
    let stage: TikTokFailureStage = 'find-input'
    let method: 'button' | 'enter' | undefined
    let submissionAttempted = false
    let controlState: 'not-observed' | 'absent' | 'hidden' | 'disabled' | 'actionability-timeout' | 'ready' = 'not-observed'
    try {
      const input = await this.findCommentInput(page)
      assertCurrent()
      if (!input) throw new Error('找不到 TikTok 评论输入框，请确认直播已开始且登录账号可以发言')
      const readDraft = () => input.evaluate(element =>
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value : element.textContent || '', undefined, { timeout: 5000 })
      stage = 'inspect-draft'
      const existingContent = await readDraft()
      assertCurrent()
      if (existingContent.trim()) throw new Error('TikTok 输入框已有内容，请先处理后再开启自动回复')
      stage = 'fill'
      await input.fill(message, { timeout: 5_000 })
      assertCurrent()
      const assertOwnedDraft = async () => {
        assertCurrent()
        const draft = await readDraft()
        assertCurrent()
        if (draft !== message) throw Object.assign(new Error('TikTok 输入框内容已变化，未提交；请先核对保留的草稿'), { code: 'COMMENT_DRAFT_CHANGED' })
      }
      const inputContainer = input.locator('xpath=ancestor::*[@data-e2e="live-chat-input-container"][1]')
      const sendButton = inputContainer.locator('[data-e2e="room-chat-send-btn"]').first()
      // Filling can render the control asynchronously. A hidden/disabled control is
      // still a button composer; it must never be mistaken for an Enter-only input.
      stage = 'wait-submit'
      const appearanceDeadline = Date.now() + 750
      let hasButton = false
      do {
        await assertOwnedDraft()
        hasButton = await sendButton.count() > 0
        assertCurrent()
        if (hasButton) break
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      } while (Date.now() < appearanceDeadline)
      method = hasButton ? 'button' : 'enter'
      controlState = hasButton ? 'not-observed' : 'absent'
      if (hasButton) {
        const readyDeadline = Date.now() + 5_000
        let ready = false
        do {
          await assertOwnedDraft()
          const blocked = await sendButton.evaluate(element => {
            const style = getComputedStyle(element)
            return !!element.closest('[disabled], [aria-disabled="true"], [inert]') ||
              style.pointerEvents === 'none' || style.cursor === 'not-allowed'
          }, undefined, { timeout: 1000 })
          assertCurrent()
          if (blocked || !(await sendButton.isEnabled())) controlState = 'disabled'
          else if (!(await sendButton.isVisible())) controlState = 'hidden'
          else {
            try {
              // Trial performs Playwright's visibility/stability/hit-target checks
              // without dispatching a click. Recheck ownership before the one click.
              await sendButton.click({ trial: true, timeout: 150 })
              assertCurrent()
              ready = true
              controlState = 'ready'
            } catch (error) {
              assertCurrent()
              if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error
              controlState = 'actionability-timeout'
            }
          }
          if (ready) break
          await new Promise<void>(resolve => setTimeout(resolve, 50))
        } while (Date.now() < readyDeadline)
        if (!ready) throw Object.assign(new Error('TikTok 发送按钮尚不可点击，草稿已保留；未使用回车补发'), { code: 'COMMENT_CONTROL_UNAVAILABLE' })
      }
      stage = 'inspect-submit'
      await assertOwnedDraft()
      assertCurrent()
      stage = 'submit'
      submissionAttempted = true
      if (hasButton) await sendButton.click({ timeout: 500 })
      else await input.press('Enter', { timeout: 500 })
      assertCurrent()
      stage = 'confirmation'
      const deadline = Date.now() + 2000
      do {
        assertCurrent()
        const draft = await readDraft()
        assertCurrent()
        if (!draft.trim()) {
          // The UI accepted the single submission. Server/public readback is audited separately.
          this.logger.info('TikTok 评论已单次提交，输入框已清空；公屏读回另行核验')
          return
        }
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      throw new Error('TikTok 评论未确认提交，草稿保留；请检查公屏后再决定是否重试')
    } catch (error) {
      this.logger.warn(`TikTok 评论提交失败：${JSON.stringify({ ...safeTikTokFailure(error, stage), ...(method ? { method } : {}), submissionAttempted, controlState })}`)
      throw error
    }
  }

  get platformName() {
    return PLATFORM_NAME
  }
}
