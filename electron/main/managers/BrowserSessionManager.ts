import type playwright from 'playwright'
import { get as getHTTP } from 'node:http'
import { performance } from 'node:perf_hooks'
import { chromium as cdpChromium } from 'playwright'
import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import WebSocket from 'ws'
import { findChromium } from '#/utils/checkChrome'
import { PlatformSessionError, parseTikTokAttachPage, validateBrowserAttachEndpoint } from '../../../shared/platformSession'
import { sameTikTokLivePage } from '../platforms/tiktok/livePageIdentity'
import { extractTargetBoundTikTokRoomId } from '../platforms/tiktok/connection'

export interface BrowserSession {
  browser: playwright.Browser
  context: playwright.BrowserContext
  page: playwright.Page
  ownership?: 'owned' | 'external'
  /** External sessions release the CDP transport; they never close a context or page. */
  release?: () => Promise<void>
}

export interface BrowserConfig {
  headless?: boolean
  storageState?: string
}

export type StorageState = playwright.BrowserContextOptions['storageState']

chromium.use(stealth())

function loopbackURL(endpoint: string): URL {
  const url = new URL(endpoint)
  // Do not delegate the permitted localhost hostname to external DNS resolution.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url
}

async function resolveLocalWebSocket(endpoint: string, timeoutMs: number): Promise<string> {
  if (new URL(endpoint).protocol === 'ws:') return endpoint
  const url = loopbackURL(endpoint)
  url.pathname = '/json/version'
  return new Promise((resolve, reject) => {
    const request = getHTTP(url, response => {
      // Native HTTP requests do not follow redirects. Never trust discovery URLs.
      if (response.statusCode !== 200) {
        response.destroy()
        reject(new Error('CDP discovery failed'))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 65536) {
          response.destroy(new Error('CDP discovery response is too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const discovered: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')).webSocketDebuggerUrl
          const valid = validateBrowserAttachEndpoint(discovered)
          if (new URL(valid).protocol !== 'ws:') throw new Error('Invalid CDP discovery protocol')
          resolve(valid)
        } catch { reject(new Error('CDP discovery returned an invalid local WebSocket')) }
      })
    })
    const timeout = setTimeout(() => request.destroy(new Error('CDP discovery timed out')), timeoutMs)
    timeout.unref()
    request.on('error', reject)
    request.once('close', () => clearTimeout(timeout))
  })
}

/** One validated socket, with redirects disabled, passed directly to Playwright. */
class LocalCDPTransport implements playwright.ConnectOverCDPTransport {
  private messageReceiver?: (message: object) => void
  private closeReceiver?: (reason?: string) => void
  private pending: object[] = []
  private closed = false
  private notified = false

  constructor(private socket: WebSocket) {
    socket.on('message', data => {
      try {
        const message: unknown = JSON.parse(data.toString())
        if (typeof message !== 'object' || message === null) throw new Error('Invalid CDP message')
        if (this.messageReceiver) this.messageReceiver(message)
        else if (this.pending.length < 64) this.pending.push(message)
        else this.close()
      } catch { this.close() }
    })
    socket.on('error', () => this.close())
    socket.once('close', () => { this.closed = true; this.pending = []; this.notifyClose() })
  }

  get onmessage() { return this.messageReceiver }
  set onmessage(receiver: ((message: object) => void) | undefined) {
    this.messageReceiver = receiver
    if (receiver) {
      const pending = this.pending
      this.pending = []
      // Playwright assigns its callbacks before issuing the first CDP command.
      queueMicrotask(() => { for (const message of pending) this.messageReceiver?.(message) })
    }
  }

  get onclose() { return this.closeReceiver }
  set onclose(receiver: ((reason?: string) => void) | undefined) {
    this.closeReceiver = receiver
    if (this.closed) queueMicrotask(() => this.notifyClose())
  }

  private notifyClose() {
    if (this.notified || !this.closeReceiver) return
    this.notified = true
    this.closeReceiver('Local CDP connection closed')
  }

  send(message: object) { this.socket.send(JSON.stringify(message)) }
  close() { this.socket.terminate() }
}

async function connectLocalTransport(endpoint: string, remaining: () => number, awaitingAllow: () => void): Promise<LocalCDPTransport> {
  const socketEndpoint = await resolveLocalWebSocket(endpoint, remaining())
  awaitingAllow()
  const socket = new WebSocket(loopbackURL(socketEndpoint), {
    followRedirects: false,
    handshakeTimeout: remaining(),
    maxPayload: 16 * 1024 * 1024,
  })
  const transport = new LocalCDPTransport(socket)
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off('open', open); socket.off('error', error); socket.off('close', close) }
      const open = () => { cleanup(); resolve() }
      const error = (cause: Error) => { cleanup(); reject(cause) }
      const close = () => { cleanup(); reject(new Error('CDP socket closed before opening')) }
      socket.once('open', open)
      socket.once('error', error)
      socket.once('close', close)
    })
    return transport
  } catch (error) { transport.close(); throw error }
}

class BrowserSessionManager {
  private chromePath: string | null = null
  private attachedPages = new Map<string, symbol>()

  public setChromePath(path: string) {
    this.chromePath = path
  }

  private async getChromePathOrDefault() {
    if (!this.chromePath) {
      this.chromePath = await findChromium()
    }
    return this.chromePath
  }

  private async createBrowser(headless = true) {
    const path = await this.getChromePathOrDefault()
    return chromium.launch({
      headless,
      executablePath: path,
    })
  }

  public async createSession(
    headless = true,
    storageState?: StorageState,
  ): Promise<BrowserSession> {
    const browser = await this.createBrowser(headless)
    const context = await browser.newContext({
      viewport: null, // 显式设置 null，关闭固定视口
      storageState,
    })
    const page = await context.newPage()
    return { browser, context, page, ownership: 'owned' }
  }

  public async attachSession(endpoint: string, pageUrl: string, options: { timeoutMs?: number } = {}): Promise<BrowserSession> {
    validateBrowserAttachEndpoint(endpoint)
    parseTikTokAttachPage(pageUrl)
    const timeoutMs = options.timeoutMs ?? 120000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new PlatformSessionError('INVALID_COMMAND', 'Chrome 接入等待预算必须是1至120000毫秒')
    let browser: playwright.Browser | undefined
    let transport: LocalCDPTransport | undefined
    const deadline = performance.now() + timeoutMs
    let expired = false
    let stage = '发现本机调试端点'
    const remaining = () => {
      const left = deadline - performance.now()
      if (expired || left <= 0) { expired = true; throw new Error('CDP attach deadline exceeded') }
      return left
    }
    const timer = setTimeout(() => { expired = true; transport?.close() }, timeoutMs)
    timer.unref()
    try {
      transport = await connectLocalTransport(endpoint, remaining, () => { stage = '等待 Chrome 允许本机连接' })
      stage = '初始化本机调试连接'
      browser = await cdpChromium.connectOverCDP(transport, { timeout: remaining(), noDefaults: true })
      remaining()
      stage = '确认已有直播页面'
      const matches = browser.contexts().flatMap(context => context.pages()
        .filter(page => !page.isClosed() && sameTikTokLivePage(page.url(), pageUrl))
        .map(page => ({ context, page })))
      if (matches.length === 0) throw new PlatformSessionError('PAGE_NOT_FOUND', '现有 Chrome 中未找到指定的 TikTok 直播页面')
      let selected = matches.length === 1 ? matches[0] : undefined
      if (!selected && matches.length <= 8) {
        stage = '核对重复标签页的公开房间归属'
        const target = parseTikTokAttachPage(pageUrl)
        const verified = await Promise.all(matches.map(async candidate => {
          remaining()
          const value = await candidate.page.evaluate(() => {
            const text = document.getElementById('SIGI_STATE')?.textContent
            const bindings: { uniqueId: string; roomId: string }[] = []
            if (text && text.length <= 2 * 1024 * 1024) {
              try {
                const user = JSON.parse(text)?.LiveRoom?.liveRoomUserInfo?.user
                if (typeof user?.uniqueId === 'string' && typeof user?.roomId === 'string')
                  bindings.push({ uniqueId: user.uniqueId, roomId: user.roomId })
              } catch { /* No verified public room. */ }
            }
            return { pageUrl: location.href, bindings }
          })
          remaining()
          return !candidate.page.isClosed() && sameTikTokLivePage(candidate.page.url(), pageUrl) &&
            sameTikTokLivePage(value.pageUrl, pageUrl) &&
            extractTargetBoundTikTokRoomId(value.bindings, value.pageUrl, target.username)
            ? candidate : undefined
        }))
        const proven = verified.filter((candidate): candidate is typeof matches[number] => !!candidate)
        if (proven.length === 1) selected = proven[0]
      }
      if (!selected) throw new PlatformSessionError('PAGE_AMBIGUOUS', '该直播间有多个标签页，无法唯一核对公开房间归属，请保留一个后重试')
      const { context, page } = selected
      const probe = await context.newCDPSession(page)
      let targetId: string
      try {
        targetId = (await probe.send('Target.getTargetInfo')).targetInfo.targetId
      } finally {
        await probe.detach()
      }
      remaining()
      // Chrome target IDs remain stable across HTTP/WS aliases and CDP clients.
      if (this.attachedPages.has(targetId)) throw new PlatformSessionError('BROWSER_IN_USE', '这个浏览器页面已经被其他账号接管，请先断开原账号')
      const owner = Symbol('attached-page')
      this.attachedPages.set(targetId, owner)
      const attachedBrowser = browser
      const forget = () => { if (this.attachedPages.get(targetId) === owner) this.attachedPages.delete(targetId) }
      attachedBrowser.once('disconnected', forget)
      let released = false
      const release = async () => {
        if (released) return
        released = true
        try {
          // Playwright connectOverCDP's browser.close closes only its transport.
          // Never call context.close/page.close or send CDP Browser.close here.
          await attachedBrowser.close()
        } finally { forget() }
      }
      return { browser: attachedBrowser, context, page, ownership: 'external', release }
    } catch (error) {
      // This is a CDP-attached Browser, so close only disconnects this client.
      transport?.close()
      await browser?.close().catch(() => {})
      if (!expired && error instanceof PlatformSessionError) throw error
      // Do not echo a capability endpoint or CDP error details into public output.
      throw new PlatformSessionError('ATTACH_FAILED', expired
        ? `接入现有 Chrome 等待超时（${stage}），请在原 Chrome 中允许本机连接后重试`
        : `无法连接现有 Chrome（${stage}），请开启远程调试并允许本机连接后重试`)
    } finally { clearTimeout(timer) }
  }
}

export const browserManager = new BrowserSessionManager()
