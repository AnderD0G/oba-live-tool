/**
 * B/C 段的「引导评论」浮层。
 *
 * 是一张**本地网页**（OBS 里由应用自动建一个浏览器源指向它），不是图片 ——
 * 这样字是活的：能一直动、改文案不用重做素材。
 *
 * 为什么是这套动效：A 段有总览引导语，B/C 段观众只顾看、没人说话 ——
 * 而 B/C 恰恰最该催评论。但**重点必须留在商品上**，所以：
 * - 不做整块旋转的光环（试过，转起来会挡住画面、抢戏）
 * - 改成**一条绕八字的粒子流光**：一个亮点拖着渐隐的尾巴走 ∞ 字，
 *   每走完一圈换一个随机颜色，并且一圈里"先慢慢出现、再慢慢消失"，
 *   全程细、淡、不占面积 —— 有点好奇感，但不抢商品
 *
 * 用的是系统字体栈（苹方/微软雅黑/思源），不引外链字体：
 * 直播现场网络不一定好，字体加载失败比不好看严重得多。全程零网络请求。
 */

export const DEFAULT_CTA_TEXT = '评论区打编号'
/** 副标题：主标牌下面那行小字，用来说"打了会怎样"。留空就只显示一行。 */
export const DEFAULT_CTA_SUBTEXT = '直接给你 上头 / 详解'
/** 文案上限：太长会超出安全区，也会把标牌撑破。 */
export const CTA_TEXT_MAX = 24
export const CTA_SUBTEXT_MAX = 30

/**
 * 引导页文件名。一个托盘一张 —— 文案不一样，换托盘就换文件。
 */
export function ctaOverlayFileName(trayId: string) {
  return `cta-${trayId}.html`
}

export interface CtaOverlayOptions {
  /** 主标牌文字，比如「评论区打编号」 */
  text: string
  /** 副标题，比如「直接给你 上头 / 详解」；留空只有一行 */
  subtext?: string
  /** 字号（像素）。默认 64；直播画布是 1080x1920，够大才看得清。 */
  fontSize?: number
  /** 主题色，默认暖金红 */
  accent?: string
  /**
   * 标牌**中心**距画布顶部的像素高度。
   *
   * 引导源是**铺满整块画布**的（这样它随时能显示，不用改尺寸），
   * 所以"字出现在哪儿"必须由页面自己决定 —— 这个值就是干这个的。
   * 应用启动时会去读 A 段艺术字那个源的位置，把它的垂直中心填进来，
   * 于是引导层就落在艺术字那条横带上。
   */
  anchorY?: number
  /** 画布高度，用来把 anchorY 夹在画面里。默认 1920 */
  canvasHeight?: number
  /** 标牌占画布宽度的百分比。默认 100（铺满横屏） */
  widthPercent?: number
  /** 画布宽度，用来算标牌有多宽。默认 1080 */
  canvasWidth?: number
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成引导浮层的完整 HTML。
 *
 * 背景**透明** —— 它是叠在直播画面上的一个浏览器源，不是整屏页面。
 */
export function renderCtaOverlay(options: CtaOverlayOptions): string {
  // 先 trim 再兜底：只填空格时 trim 完是空串，兜底必须放在后面，
  // 否则标牌会渲染成一片空白（这个 bug 是被单测逮出来的）。
  const text = (options.text || '').trim().slice(0, CTA_TEXT_MAX) || DEFAULT_CTA_TEXT
  const subtext = (options.subtext || '').trim().slice(0, CTA_SUBTEXT_MAX)
  const fontSize = Math.min(200, Math.max(24, Math.round(options.fontSize ?? 64)))
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(options.accent || '') ? options.accent! : '#ffd54a'
  // 标牌钉在画布上的哪一行。没给就居中（画面中线）。
  const canvasHeight = Math.max(240, Math.round(options.canvasHeight ?? 1920))
  const anchorY = Math.min(
    canvasHeight - 40,
    Math.max(40, Math.round(options.anchorY ?? canvasHeight / 2)),
  )
  const canvasWidth = Math.max(320, Math.round(options.canvasWidth ?? 1080))
  const widthPercent = Math.min(100, Math.max(30, Math.round(options.widthPercent ?? 100)))
  const maxFontSize = Math.min(200, Math.max(24, Math.round(options.fontSize ?? 64)))
  const subBlock = subtext ? `\n        <span class="sub">${escapeHtml(subtext)}</span>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>互动引导</title>
<style>
  html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    font-family: "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC", sans-serif;
  }
  .stage {
    position: relative;
    width: 100%;
    height: 100%;
  }
  /* 标牌钉在画布的第 anchorY 行上（应用从艺术字那个源读来的位置） */
  .wrap {
    position: absolute;
    left: 50%;
    top: ${anchorY}px;
    width: ${widthPercent}%;
    transform: translate(-50%, -50%);
  }
  /* 粒子流光画在标牌上（细、淡），所以它跟标牌同框 */
  .wrap canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 2;
    pointer-events: none;
  }
  .badge {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 0.34em 0.6em;
    border-radius: ${subtext ? '0.36em' : '999px'};
    background: linear-gradient(180deg, rgba(12,10,20,.68), rgba(12,10,20,.9));
    box-shadow: 0 6px 22px rgba(0, 0, 0, .45);
    animation: cta-breathe 2.6s ease-in-out infinite;
  }
  .lines {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.14em;
  }
  /* 字号由脚本按画布宽度自动撑满（见下面的 fitText），这里只是初值 */
  .label {
    font-size: ${maxFontSize}px;
    font-weight: 900;
    line-height: 1;
    letter-spacing: 0.02em;
    white-space: nowrap;
    background: linear-gradient(180deg, #ffffff, ${accent});
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-stroke: 2px rgba(0, 0, 0, .5);
    filter: drop-shadow(0 3px 0 rgba(0, 0, 0, .45));
  }
  /* 副标题：说明"打了编号会怎样"，比主标牌小一圈，不抢戏 */
  .sub {
    font-size: ${Math.round(fontSize * 0.4)}px;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: 0.05em;
    white-space: nowrap;
    color: #ffe9a8;
    text-shadow: 0 2px 0 rgba(0, 0, 0, .55);
  }
  /* 很轻的呼吸 —— 幅度只有 1.5%，是为了"活着"，不是为了抢眼 */
  @keyframes cta-breathe {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.015); }
  }
  @media (prefers-reduced-motion: reduce) {
    .badge { animation: none; }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="wrap">
      <canvas id="trail"></canvas>
      <div class="badge">
        <span class="lines">
          <span class="label">${escapeHtml(text)}</span>${subBlock}
        </span>
      </div>
    </div>
  </div>
<script>
(() => {
  const canvas = document.getElementById('trail')
  const badge = document.querySelector('.badge')
  const label = document.querySelector('.label')
  const ctx = canvas.getContext('2d')
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // 尾巴长度（帧）与一圈耗时：慢一点才不抢戏
  const TAIL = 78
  const LAP_MS = 5200
  const points = []
  let hue = Math.random() * 360
  let startedAt = performance.now()

  const sub = document.querySelector('.sub')
  const MAX_FONT = ${maxFontSize}
  const MIN_FONT = 26

  /** 标牌宽是按画布百分比定的，字号再按宽度撑满 —— 几个字都一样宽。 */
  function fitText() {
    if (!label) return
    const inner = badge.clientWidth - parseFloat(getComputedStyle(badge).paddingLeft) * 2
    if (inner <= 0) return
    label.style.fontSize = '100px'
    const measured = label.getBoundingClientRect().width
    if (!measured) return
    const size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor((100 * inner * 0.94) / measured)))
    label.style.fontSize = size + 'px'
    if (sub) sub.style.fontSize = Math.round(size * 0.4) + 'px'
  }

  function fit() {
    fitText()
    const box = badge.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(box.width * dpr))
    canvas.height = Math.max(1, Math.round(box.height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** 双纽线（Gerono）：t 走一圈就是一个正正经经的 ∞ 字。 */
  function pointOn(progress) {
    const t = progress * Math.PI * 2
    const r = canvas.getBoundingClientRect()
    const cx = r.width / 2
    const cy = r.height / 2
    // 留点边距，别让流光压到标牌边缘上
    const rx = r.width / 2 - 10
    const ry = r.height / 2 - 6
    return {
      x: cx + rx * Math.cos(t),
      y: cy + ry * Math.sin(2 * t) / 2,
    }
  }

  function draw(now) {
    const progress = ((now - startedAt) % LAP_MS) / LAP_MS
    const r = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, r.width, r.height)
    if (reduce) return

    points.push(pointOn(progress))
    if (points.length > TAIL) points.shift()

    // 一圈里"先慢慢出现、再慢慢消失"，快走完时清空 —— 下一圈换个颜色重来
    const envelope = Math.pow(Math.sin(Math.PI * progress), 0.75)
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < points.length; i++) {
      const age = i / points.length
      const alpha = age * age * envelope * 0.5
      if (alpha < 0.02) continue
      const p = points[i]
      ctx.globalAlpha = alpha
      ctx.fillStyle = 'hsl(' + hue + ' 100% ' + (58 + 18 * age) + '%)'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.1 + 2.1 * age, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'

    if (progress > 0.995) {
      // 走完一圈：换随机颜色，下一圈是新的感觉
      hue = Math.random() * 360
      points.length = 0
      startedAt = now
    }
    requestAnimationFrame(draw)
  }

  fit()
  window.addEventListener('resize', fit)
  if (window.ResizeObserver) new ResizeObserver(fit).observe(badge)
  requestAnimationFrame(draw)
})()
</script>
</body>
</html>
`
}
