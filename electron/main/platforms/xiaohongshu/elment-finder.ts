import { Result } from '@praha/byethrow'
import type { ElementHandle, Page } from 'playwright'
import { ElementDisabledError, ElementNotFoundError } from '#/errors/PlatformError'
import { commonElementFinder, type IElementFinder } from '../IElementFinder'
import { SELECTORS, TEXTS } from './constant'

export const xiaohongshuElementFinder: IElementFinder = {
  /**
   * 找这张商品卡上的操作按钮。
   *
   * 千帆现在有两个不同的按钮，别再混了：
   * - **弹卡**（`live_control_popup_card`）：把商品卡弹给观众 —— 导播要的就是这个
   * - **讲解**（`live_control_explain_goods`）：直播间的"正在讲解"状态，是个开关
   *
   * 旧代码只认「讲解」，而且是在已经消失的 `.more-operation` 面板里找，
   * 所以改版后必然失败。这里优先弹卡，找不到才退回讲解（兼容别的版本）。
   */
  async getPopUpButtonFromGoodsItem(item: ElementHandle<SVGElement | HTMLElement>) {
    const row = await item.$(SELECTORS.GOODS_ITEM_INNER.ACTION_ROW)
    if (!row) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '商品卡操作区',
          selector: SELECTORS.GOODS_ITEM_INNER.ACTION_ROW,
        }),
      )
    }
    for (const selector of [
      SELECTORS.GOODS_ITEM_INNER.POPUP_CARD,
      SELECTORS.GOODS_ITEM_INNER.EXPLAIN_BUTTON,
    ]) {
      const button = await row.$(selector)
      if (button) return Result.succeed(button)
    }
    return Result.fail(
      new ElementNotFoundError({
        elementName: '弹卡按钮',
        selector: SELECTORS.GOODS_ITEM_INNER.POPUP_CARD,
      }),
    )
  },

  /**
   * 这张卡的序号 —— 也就是观众说的「1 号链接」。
   *
   * 注意：千帆把序号放在 input 的 **placeholder** 上（`placeholder="1"`），
   * `value` 一般是空的。所以旧的 `inputValue()` 读法永远读不到东西。
   */
  async getIdFromGoodsItem(item: ElementHandle<SVGElement | HTMLElement>) {
    const input = await item.$(SELECTORS.GOODS_ITEM_INNER.INDEX_INPUT)
    if (input) {
      const raw = (
        (await input.inputValue()) ||
        (await input.getAttribute('placeholder')) ||
        ''
      ).trim()
      const id = Number.parseInt(raw, 10)
      if (!Number.isNaN(id)) return Result.succeed(id)
    }
    // 兜底：序号也可能被渲染成纯文本（千帆前端换过一次渲染方式）。
    // 读不到就往上抛原始原因 —— 上层会把"序号读成什么了"写进日志。
    try {
      const text = await item.$eval(SELECTORS.GOODS_ITEM_INNER.INDEX, el => el.textContent || '')
      const match = text.match(/\d{1,3}/)
      if (match) return Result.succeed(Number.parseInt(match[0], 10))
    } catch {
      // 连兜底节点都没有，走下面的失败分支
    }
    return Result.fail(
      new ElementNotFoundError({
        elementName: `商品序号（${SELECTORS.GOODS_ITEM_INNER.INDEX_INPUT} 没读到数字）`,
        selector: SELECTORS.GOODS_ITEM_INNER.INDEX_INPUT,
      }),
    )
  },

  async getCurrentGoodsItemsList(page: Page) {
    return commonElementFinder.getCurrentGoodsItemsList(page, SELECTORS.GOODS_ITEM)
  },

  getGoodsItemsScrollContainer(page: Page) {
    return commonElementFinder.getGoodsItemsScrollContainer(page, SELECTORS.GOODS_ITEMS_WRAPPER)
  },

  getCommentTextarea(page: Page) {
    return commonElementFinder.getCommentTextarea(page, SELECTORS.COMMENT_INPUT.TEXTAREA)
  },

  async getClickableSubmitCommentButton(page: Page) {
    const submitButton = await page.$(SELECTORS.COMMENT_INPUT.SUBMIT_BUTTON)
    if (!submitButton) {
      return Result.fail(
        new ElementNotFoundError({
          elementName: '发送评论按钮',
          selector: SELECTORS.COMMENT_INPUT.SUBMIT_BUTTON,
        }),
      )
    }
    if (
      await submitButton.evaluate(
        (el, SELECTORS) => el.className.includes(SELECTORS.COMMENT_INPUT.SUBMIT_BUTTON_DISABLED),
        SELECTORS,
      )
    ) {
      return Result.fail(
        new ElementDisabledError({
          elementName: '发送评论按钮',
          element: await submitButton.evaluate(el => el.outerHTML),
        }),
      )
    }
    return Result.succeed(submitButton)
  },

  async getPinTopLabel() {
    return commonElementFinder.getEmptyPinTopLabel()
  },
}
