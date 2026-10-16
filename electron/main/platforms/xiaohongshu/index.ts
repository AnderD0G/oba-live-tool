import { Result } from '@praha/byethrow'
import type { Page } from 'playwright'
import { ElementNotFoundError } from '#/errors/PlatformError'
import type { BrowserSession } from '#/managers/BrowserSessionManager'
import { flattenReply } from '../../../../shared/director'
import {
  comment,
  connect,
  ensurePage,
  getAccountName,
  getItemFromVirtualScroller,
  openUrlByElement,
} from '../helper'
import type {
  BusinessSourceObservation,
  IBusinessDataSource,
  ICommentListener,
  IPerformComment,
  IPerformPopup,
  IPlatform,
} from '../IPlatform'
import { XiaohongshuCommentListener } from './commentListener'
import { REGEXPS, SELECTORS, TEXTS, URLS } from './constant'
import { xiaohongshuElementFinder as elementFinder } from './elment-finder'
import { isConfirmedSendReceipt } from './sendReceipt'

const PLATFORM_NAME = '小红书' as const

/**
 * 小红书（千帆）
 */
export class XiaohongshuPlatform
  implements IPlatform, IPerformPopup, IPerformComment, ICommentListener, IBusinessDataSource
{
  readonly _isCommentListener = true
  readonly _isPerformComment = true
  readonly _isPerformPopup = true
  private mainPage: Page | null = null
  private commentListener: XiaohongshuCommentListener | null = null
  private accountName = ''
  private businessSubscribers = new Set<(observation: BusinessSourceObservation) => void>()

  subscribeBusiness(listener: (observation: BusinessSourceObservation) => void) {
    this.businessSubscribers.add(listener)
    return () => {
      this.businessSubscribers.delete(listener)
    }
  }
  businessCapabilities() {
    return { sources: ['control' as const], formatVersion: 1 }
  }

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

  /**
   * 千帆的商品列表不一定长在中控台主窗口里 —— 和评论输入框一样，
   * 直播互动面板有时会单独开一个窗口。主窗口没有就依次看其它已打开的页面。
   *
   * 评论那条路早就有这个兜底（见 commentPage），弹卡这条路一直没有 ——
   * 同一个面板，评论框找不到过 2 次、商品列表一次都没找到过，症状是一致的。
   */
  private async goodsPage(): Promise<Page | null> {
    const main = this.mainPage
    if (!main || main.isClosed()) return main
    if (await main.$(SELECTORS.GOODS_ITEMS_WRAPPER)) return main
    for (const page of main.context().pages()) {
      if (page === main || page.isClosed()) continue
      if (await page.$(SELECTORS.GOODS_ITEMS_WRAPPER)) return page
    }
    return main
  }

  /**
   * 失败时把每个页面的**实际探测结果**写进错误消息。
   *
   * 以前只报「找不到元素 商品列表」，只能靠猜是页面不对、selector 过时还是 iframe。
   * 现在报错本身就带着答案，日志里直接能看出来。
   *
   * 特别注意「列表容器无」这一种：**绝大多数情况是商家还没在千帆里把商品上架**
   * （没配置/没上架时，这一场的商品列表根本不会渲染出来），不是页面没加载完。
   * 所以这里把推断也一并写出来，免得又被误当成"刚开播还没就绪"。
   */
  private async describeGoodsPages(): Promise<string> {
    const main = this.mainPage
    if (!main || main.isClosed()) return '中控台页面已关闭'
    const pages = [
      main,
      ...main
        .context()
        .pages()
        .filter(p => p !== main && !p.isClosed()),
    ]
    const parts: string[] = []
    let anyContainer = false
    for (const page of pages.slice(0, 4)) {
      const [list, items] = await Promise.all([
        page.$(SELECTORS.GOODS_LIST),
        page.$$(SELECTORS.GOODS_ITEM),
      ])
      if (list) anyContainer = true
      // 把每张卡读到的**序号**一并报出来 —— 找不到卡时，这是唯一能分辨
      // "序号没读出来"和"序号读了但都不等于想要的"的东西。
      const seen = await Promise.all(
        items.slice(0, 6).map(async item => {
          try {
            return await item.$eval(SELECTORS.GOODS_ITEM_INNER.INDEX_INPUT, (el: Element) => {
              const input = el as HTMLInputElement
              return (input.value || input.getAttribute('placeholder') || '空').trim() || '空'
            })
          } catch {
            return '读不到'
          }
        }),
      )
      const frames = page.frames().length
      const url = page
        .url()
        .replace(/^https?:\/\//, '')
        .slice(0, 48)
      parts.push(
        `${url}｜帧${frames}｜列表容器${list ? '有' : '无'}｜卡片${items.length}` +
          (seen.length ? `（序号 ${seen.join(',')}）` : ''),
      )
    }
    if (!anyContainer)
      parts.push('推断：这一场直播的商品列表没渲染出来，多半是还没在千帆里上架商品')
    else parts.push('列表在但没找到这张卡，检查一下商品卡片编号对不对')
    return parts.join(' ／ ')
  }

  async performPopup(id: number, signal?: AbortSignal) {
    const page = await this.goodsPage()
    const result = await Result.pipe(
      ensurePage(page),
      Result.andThen(found => getItemFromVirtualScroller(found, elementFinder, id)),
      Result.andThen(item => elementFinder.getPopUpButtonFromGoodsItem(item)),
      Result.andThen(async button => {
        signal?.throwIfAborted()
        // 弹卡是一次性动作，不是"讲解↔结束讲解"那种开关，别用 toggleButton。
        // button.click() 在部分平台表现诡异，沿用 dispatchEvent（见 toggleButton 注释）。
        await button.dispatchEvent('click')
        return Result.succeed()
      }),
    )
    if (Result.isFailure(result)) {
      const detail = await this.describeGoodsPages()
      // **别把原始原因吃掉** —— 上一次包装成"找不到 1 号商品卡"，
      // 结果看不出是"序号读不出来"还是"滚动到底也没找到"，白查一轮。
      const cause = result.error instanceof Error ? result.error.message : String(result.error)
      return Result.fail(
        new ElementNotFoundError({
          elementName: `${id} 号商品卡 ← ${cause}（${detail}）`,
        }),
      )
    }
    return result
  }

  /**
   * 千帆的评论输入框不一定长在中控台主窗口里 —— 直播互动面板有时会单独开一个窗口。
   * 主窗口没有就依次看其它已打开的页面，谁有输入框就用谁；都没有则仍然回主窗口，
   * 让调用方照常报「找不到评论框」。
   */
  private async commentPage(): Promise<Page | null> {
    const main = this.mainPage
    if (!main || main.isClosed()) return main
    if (await main.$(SELECTORS.COMMENT_INPUT.TEXTAREA)) return main
    for (const page of main.context().pages()) {
      if (page === main || page.isClosed()) continue
      if (await page.$(SELECTORS.COMMENT_INPUT.TEXTAREA)) return page
    }
    return main
  }

  async performComment(message: string) {
    const page = await this.commentPage()
    return Result.pipe(
      ensurePage(page),
      Result.andThen(found => comment(found, elementFinder, message, false)),
    )
  }

  async performConfirmedComment(message: string, signal: AbortSignal): Promise<boolean> {
    const page = await this.commentPage()
    if (!page || page.isClosed() || signal.aborted) return false
    const found = await elementFinder.getCommentTextarea(page)
    if (Result.isFailure(found)) return false
    const input = found.value
    // 千帆的评论框里 Enter 就是发送键，带换行的文本很可能只发出去第一行 —— 先压成一行。
    const text = flattenReply(message)
    // Do not overwrite text the host is currently composing in Qianfan.
    if ((await input.inputValue()).trim())
      throw new Error('千帆输入框已有内容，请先处理后再开启自动回复')
    await input.fill(text, { timeout: 5000 })
    const button = await elementFinder.getClickableSubmitCommentButton(page)
    if (signal.aborted || Result.isFailure(button)) {
      if ((await input.inputValue()) === text) await input.fill('')
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
    return isConfirmedSendReceipt(body, text)
  }

  async startCommentListener(onComment: (comment: LiveMessage) => void): Promise<void> {
    const page = ensurePage(this.mainPage)
    if (Result.isFailure(page)) {
      throw page.error
    }
    this.commentListener = new XiaohongshuCommentListener(page.value, observation => {
      for (const subscriber of this.businessSubscribers ?? []) {
        try {
          subscriber(observation)
        } catch {
          /* Isolate each private subscriber. */
        }
      }
    })
    this.commentListener.setAccountName(this.accountName)
    await this.commentListener.startCommentListener(onComment)
  }

  async stopCommentListener(): Promise<void> {
    await this.commentListener?.stopCommentListener()
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
