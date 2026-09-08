import { Result } from '@praha/byethrow'
import type { Page } from 'playwright'
import type { BrowserSession } from '#/managers/BrowserSessionManager'
import {
  comment,
  connect,
  ensurePage,
  getAccountName,
  getItemFromVirtualScroller,
  openUrlByElement,
  toggleButton,
} from '../helper'
import type { ICommentListener, IPerformComment, IPerformPopup, IPlatform } from '../IPlatform'
import { XiaohongshuCommentListener } from './commentListener'
import { REGEXPS, SELECTORS, TEXTS, URLS } from './constant'
import { xiaohongshuElementFinder as elementFinder } from './elment-finder'

const PLATFORM_NAME = '小红书' as const

/**
 * 小红书（千帆）
 */
export class XiaohongshuPlatform
  implements IPlatform, IPerformPopup, IPerformComment, ICommentListener
{
  readonly _isCommentListener = true
  readonly _isPerformComment = true
  readonly _isPerformPopup = true
  private mainPage: Page | null = null
  private commentListener: XiaohongshuCommentListener | null = null
  private accountName = ''

  async connect(browserSession: BrowserSession) {
    const { page } = browserSession
    const isConnected = await connect(page, {
      isInLiveControlSelector: SELECTORS.IN_LIVE_CONTROL,
      liveControlUrl: URLS.LIVE_CONTROL_PAGE,
      loginUrlRegex: REGEXPS.LOGIN_PAGE,
    })

    if (isConnected) {
      // 小红书反爬，直接用 goto 进入中控台加载不出元素
      const newPage = await openUrlByElement(page, URLS.LIVE_CONTROL_PAGE)
      await page.close()
      browserSession.page = newPage
      this.mainPage = newPage
    }
    return isConnected
  }

  async login(browserSession: BrowserSession): Promise<void> {
    const { page } = browserSession
    if (!REGEXPS.LOGIN_PAGE.test(page.url())) {
      await page.goto(URLS.LOGIN_PAGE)
    }
    await page.waitForSelector(SELECTORS.LOGGED_IN, {
      timeout: 0,
    })
  }

  async getAccountName(session: BrowserSession) {
    const accountName = await getAccountName(session.page, SELECTORS.ACCOUNT_NAME)
    this.accountName = accountName ?? ''
    if (accountName?.endsWith('的店')) {
      this.accountName = accountName.slice(0, -2)
    }
    return this.accountName
  }

  disconnect(): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async performPopup(id: number, signal?: AbortSignal) {
    return Result.pipe(
      ensurePage(this.mainPage),
      Result.andThen(page => getItemFromVirtualScroller(page, elementFinder, id)),
      Result.andThen(item => elementFinder.getPopUpButtonFromGoodsItem(item)),
      Result.andThen(btn =>
        toggleButton(btn, TEXTS.POPUP_BUTTON, TEXTS.POPUP_BUTTON_CANCLE, signal),
      ),
    )
  }

  async performComment(message: string) {
    return Result.pipe(
      ensurePage(this.mainPage),
      Result.andThen(page => comment(page, elementFinder, message, false)),
    )
  }

  async performConfirmedComment(message: string, signal: AbortSignal): Promise<boolean> {
    const page = this.mainPage
    if (!page || page.isClosed() || signal.aborted) return false
    const found = await elementFinder.getCommentTextarea(page)
    if (Result.isFailure(found)) return false
    const input = found.value
    // Do not overwrite text the host is currently composing in Qianfan.
    if ((await input.inputValue()).trim())
      throw new Error('千帆输入框已有内容，请先处理后再开启自动回复')
    await input.fill(message, { timeout: 5000 })
    const button = await elementFinder.getClickableSubmitCommentButton(page)
    if (signal.aborted || Result.isFailure(button)) {
      if ((await input.inputValue()) === message) await input.fill('')
      return false
    }
    const response = page
      .waitForResponse(r => r.url().includes('send_comment') && r.request().method() === 'POST', {
        timeout: 10000,
      })
      .catch(() => null)
    if (signal.aborted) return false
    await button.value.dispatchEvent('click')
    const result = await response
    if (!result?.ok()) return false
    const body = await result.json().catch(() => null)
    return (
      body?.success === true &&
      body?.data?.comment === message &&
      (body.data.common_response?.common_result === undefined ||
        body.data.common_response.common_result === 0)
    )
  }

  async startCommentListener(onComment: (comment: LiveMessage) => void): Promise<void> {
    const page = ensurePage(this.mainPage)
    if (Result.isFailure(page)) {
      throw page.error
    }
    this.commentListener = new XiaohongshuCommentListener(page.value)
    this.commentListener.setAccountName(this.accountName)
    await this.commentListener.startCommentListener(onComment)
  }

  stopCommentListener(): void {
    this.commentListener?.stopCommentListener()
  }

  getCommentListenerPage(): Page {
    if (!this.commentListener) {
      throw new Error('Comment listener not started')
    }
    return this.commentListener.getCommentListenerPage()
  }

  getPopupPage() {
    return this.mainPage
  }

  getCommentPage() {
    return this.mainPage
  }

  get platformName() {
    return PLATFORM_NAME
  }
}
