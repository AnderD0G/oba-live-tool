import { Result } from '@praha/byethrow'
import type { ElementHandle, Locator, Page } from 'playwright'
import {
  ElementContentMismatchedError,
  ElementNotFoundError,
  type PlatformError,
} from '#/errors/PlatformError'

export interface IElementFinder {
  /** 从单个商品详情中获取弹窗按钮 */
  getPopUpButtonFromGoodsItem(
    item: ElementHandle<SVGElement | HTMLElement>,
  ): Result.ResultAsync<ElementHandle<HTMLElement | SVGElement>, PlatformError>

  getIdFromGoodsItem(
    item: ElementHandle<SVGElement | HTMLElement>,
  ): Result.ResultAsync<number, PlatformError>

  /** 能保证商品列表不为空 */
  getCurrentGoodsItemsList(
    page: Page,
  ): Result.ResultAsync<ElementHandle<SVGElement | HTMLElement>[], PlatformError>

  getGoodsItemsScrollContainer(
    page: Page,
  ): Result.ResultAsync<ElementHandle<SVGElement | HTMLElement>, PlatformError>

  getCommentTextarea(
    page: Page,
  ): Result.ResultAsync<ElementHandle<SVGElement | HTMLElement> | Locator, PlatformError>

  getClickableSubmitCommentButton(
    page: Page,
  ): Result.ResultAsync<ElementHandle<SVGElement | HTMLElement>, PlatformError>

  /** 获取评论置顶标签，如果置顶标签不存在返回 Fail */
  getPinTopLabel(
    page: Page,
  ): Result.ResultAsync<ElementHandle<SVGElement | HTMLElement>, PlatformError>
}

export const commonElementFinder = {
  async getIdFromGoodsItem(
    item: ElementHandle<SVGElement | HTMLElement>,
    idSelector: string,
    textContent = false,
  ) {
    const idInput = textContent
      ? await (await item.$(idSelector))?.textContent()
      : await (await item.$(idSelector))?.inputValue()
    if (!idInput) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '商品ID',
          selector: idSelector,
        }),
      )
    }
    const id = Number.parseInt(idInput, 10)
    if (Number.isNaN(id)) {
      return Result.fail(
        new ElementContentMismatchedError({
          current: idInput,
          target: '数字',
        }),
      )
    }
    return Result.succeed(id)
  },

  /**
   * 评论输入框只在【直播中】的中控台里渲染：没开播、或者直播互动面板没打开时，
   * 页面上根本没有这个元素。所以这里先给一点等待时间（面板可能是异步挂载的），
   * 真正找不到时把原因写进错误信息，避免只看到一句「找不到元素 评论框」。
   */
  async getCommentTextarea(page: Page, textareaSelector: string, timeoutMs = 3000) {
    const textarea = await page
      .waitForSelector(textareaSelector, { timeout: timeoutMs, state: 'attached' })
      .catch(() => null)
    if (!textarea) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '评论框（直播间未开播、或中控台没打开直播互动面板时不会出现）',
          selector: textareaSelector,
        }),
      )
    }
    return Result.succeed(textarea)
  },

  async getGoodsItemsScrollContainer(page: Page, containerSelector: string) {
    const scrollContainer = await page.$(containerSelector)
    if (!scrollContainer) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '商品列表滚动容器',
          selector: containerSelector,
        }),
      )
    }
    return Result.succeed(scrollContainer)
  },

  async getCurrentGoodsItemsList(page: Page, itemSelector: string) {
    const items = await page.$$(itemSelector)
    if (items.length === 0) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '商品列表',
          selector: itemSelector,
        }),
      )
    }
    return Result.succeed(items)
  },

  async getPinTopLabel(page: Page, labelSelector: string) {
    const label = await page.$(labelSelector)
    if (!label) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '评论置顶标签',
          selector: labelSelector,
        }),
      )
    }
    return Result.succeed(label)
  },

  async getEmptyPinTopLabel() {
    return Result.fail(new ElementNotFoundError({ elementName: '置顶选项' }))
  },
}
