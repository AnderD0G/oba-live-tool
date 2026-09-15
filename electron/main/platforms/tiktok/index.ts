import { Result } from '@praha/byethrow'
import type { Locator, Page } from 'playwright'
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector'
import { UnexpectedError } from '#/errors/AppError'
import { PageNotFoundError, type PlatformError } from '#/errors/PlatformError'
import { createLogger } from '#/logger'
import type { BrowserSession } from '#/managers/BrowserSessionManager'
import type {
  ICommentListener,
  IConfigurablePlatform,
  IPerformComment,
  IPlatform,
} from '../IPlatform'
import { normalizeTikTokUsername, type TikTokChatEvent, toTikTokComment } from './messages'

export { normalizeTikTokUsername, toTikTokComment } from './messages'

const PLATFORM_NAME = 'TikTok LIVE' as const
const LOGIN_URL = 'https://www.tiktok.com/login'
const SESSION_COOKIES = new Set(['sessionid', 'sessionid_ss'])

type PendingConfirmation = {
  content: string
  resolve: (confirmed: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class TikTokPlatform
  implements IPlatform, IConfigurablePlatform, ICommentListener, IPerformComment
{
  readonly _isCommentListener = true
  readonly _isPerformComment = true

  private username = ''
  private mainPage: Page | null = null
  private connection: TikTokLiveConnection | null = null
  private handleComment: (comment: LiveMessage) => void = () => {}
  private pendingConfirmations = new Set<PendingConfirmation>()
  private readonly logger = createLogger('TikTok LIVE')

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

  private async hasLoginSession(session: BrowserSession) {
    const cookies = await session.context.cookies('https://www.tiktok.com')
    return cookies.some(cookie => SESSION_COOKIES.has(cookie.name) && cookie.value.length > 0)
  }

  async connect(browserSession: BrowserSession) {
    this.requireUsername()
    if (!(await this.hasLoginSession(browserSession))) return false
    await browserSession.page.goto(this.liveUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    this.mainPage = browserSession.page
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
    await this.stopConnection()
    this.mainPage = null
  }

  async startCommentListener(onComment: (comment: LiveMessage) => void) {
    this.requireUsername()
    await this.stopConnection()
    this.handleComment = onComment

    const connection = new TikTokLiveConnection(this.username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
    })
    this.connection = connection
    connection.on(WebcastEvent.CHAT, message => this.onChat(message))

    try {
      const state = await connection.connect()
      this.logger.info(`弹幕已连接，直播间 ID：${state.roomId}`)
    } catch (error) {
      this.connection = null
      const text = error instanceof Error ? error.message : String(error)
      throw new Error(`TikTok 弹幕连接失败：${text}`)
    }
  }

  private onChat(message: TikTokChatEvent) {
    const liveMessage = toTikTokComment(message)
    if (!liveMessage) return
    this.handleComment(liveMessage)

    for (const pending of this.pendingConfirmations) {
      if (pending.content === liveMessage.content) {
        clearTimeout(pending.timer)
        this.pendingConfirmations.delete(pending)
        pending.resolve(true)
        break
      }
    }
  }

  stopCommentListener() {
    void this.stopConnection()
  }

  private async stopConnection() {
    const connection = this.connection
    this.connection = null
    if (connection) {
      connection.removeAllListeners()
      await connection.disconnect().catch(error => this.logger.warn('关闭弹幕连接失败', error))
    }
    for (const pending of this.pendingConfirmations) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    this.pendingConfirmations.clear()
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
    const confirmation = this.waitForConfirmation(message, signal)
    try {
      await this.sendPageComment(message)
      return await confirmation
    } catch (error) {
      this.resolvePending(message, false)
      throw error
    }
  }

  private waitForConfirmation(content: string, signal: AbortSignal) {
    return new Promise<boolean>(resolve => {
      const pending: PendingConfirmation = {
        content,
        resolve,
        timer: setTimeout(() => {
          this.pendingConfirmations.delete(pending)
          resolve(false)
        }, 10_000),
      }
      this.pendingConfirmations.add(pending)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(pending.timer)
          this.pendingConfirmations.delete(pending)
          resolve(false)
        },
        { once: true },
      )
    })
  }

  private resolvePending(content: string, confirmed: boolean) {
    for (const pending of this.pendingConfirmations) {
      if (pending.content !== content) continue
      clearTimeout(pending.timer)
      this.pendingConfirmations.delete(pending)
      pending.resolve(confirmed)
    }
  }

  private async findCommentInput(page: Page): Promise<Locator | null> {
    const selectors = [
      '[data-e2e="comment-input"] textarea',
      '[data-e2e="comment-input"] [contenteditable="true"]',
      'textarea[placeholder*="comment" i]',
      'textarea[placeholder*="something" i]',
      '[contenteditable="true"][role="textbox"]',
    ]
    for (const selector of selectors) {
      const candidates = page.locator(selector)
      const count = await candidates.count()
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index)
        if (await candidate.isVisible().catch(() => false)) return candidate
      }
    }
    return null
  }

  private async sendPageComment(message: string) {
    const page = this.mainPage
    if (!page || page.isClosed()) throw new PageNotFoundError()
    if (!page.url().includes(`/@${this.username}/live`)) {
      await page.goto(this.liveUrl(), { waitUntil: 'domcontentloaded', timeout: 45_000 })
    }
    const input = await this.findCommentInput(page)
    if (!input) {
      throw new Error('找不到 TikTok 评论输入框，请确认直播已开始且登录账号可以发言')
    }
    if ((await input.inputValue().catch(() => '')).trim()) {
      throw new Error('TikTok 输入框已有内容，请先处理后再开启自动回复')
    }
    await input.fill(message, { timeout: 5_000 })
    await input.press('Enter', { timeout: 5_000 })
  }

  get platformName() {
    return PLATFORM_NAME
  }
}
