// export const login: LoginConstants = {
//   liveControlUrl: 'https://ark.xiaohongshu.com/live_center_control',
//   loginUrl:
//     'https://customer.xiaohongshu.com/login?service=https%3A%2F%2Fark.xiaohongshu.com%2Flive_center_control',
//   loginUrlRegex: /.*customer\.xiaohongshu\.com\/login.*/,

//   isLoggedInSelector: '.user-info-wrapper',
//   // isInLiveControlSelector: '.comment-container',
//   isInLiveControlSelector: '.app-root-topbar-wrapper',
//   hoverSelector: '.user-info-wrapper',
//   accountNameSelector: '.sellerId-name',
// }

export const URLS = {
  LOGIN_PAGE:
    'https://customer.xiaohongshu.com/login?service=https%3A%2F%2Fark.xiaohongshu.com%2Flive_center_control',
  LIVE_CONTROL_PAGE: 'https://ark.xiaohongshu.com/live_center_control',
} as const

export const REGEXPS = {
  LOGIN_PAGE: /.*customer\.xiaohongshu\.com\/login.*/,
}

export const SELECTORS = {
  LOGGED_IN: '.user-info-wrapper',
  IN_LIVE_CONTROL: '.app-root-topbar-wrapper',

  ACCOUNT_NAME_HOVER: '.user-info-wrapper',
  // ACCOUNT_NAME: '.sellerId-name',
  ACCOUNT_NAME: '.user-info-wrapper .store-name',

  /**
   * 商品列表（千帆改版后的结构，2026-09 实测）。
   *
   * 旧版是 `.goods-list .table-wrap … table tbody tr`，现在整块换成了
   * `.goods-card-list` + `.goods-card` 的卡片列表 —— 一行都不是 table 了，
   * 所以旧 selector 永远命中 0 行，日志里表现为「找不到元素 商品列表」。
   */
  GOODS_LIST: '.goods-card-list',
  GOODS_ITEM: '.goods-card-list .goods-card',
  GOODS_ITEMS_WRAPPER: '.goods-card-list',

  GOODS_ITEM_INNER: {
    /** 序号所在的整块（兜底从它的文字里抠数字） */
    INDEX: '.goods-card__index',
    /** 序号（观众看到的「1 号链接」）。值是 placeholder，不是 value。 */
    INDEX_INPUT: '.goods-card__index-input input',
    ACTION_ROW: '.goods-card__action-row',
    /** 弹卡：把商品卡弹给观众看。这是导播要按的那个。 */
    POPUP_CARD: '[data-track="live_control_popup_card"]',
    /** 讲解：直播间的「正在讲解」状态，是个可切换的开关，和弹卡是两件事。 */
    EXPLAIN_BUTTON: '[data-track-impression="live_control_explain_goods"]',
  },

  COMMENT_INPUT: {
    TEXTAREA: '.comment-input textarea',
    SUBMIT_BUTTON: '.comment-input button',
    SUBMIT_BUTTON_DISABLED: 'disabled',
  },
} as const

export const TEXTS = {
  /** 弹卡按钮的文字（用来判断当前是不是已经弹着） */
  POPUP_CARD: '弹卡',
  POPUP_BUTTON: '讲解',
  POPUP_BUTTON_CANCLE: '结束讲解',
} as const
