import { type DirectorStep, isDirectorVideoStep } from './director'

/**
 * 弹卡时间点的"拥挤检测"。
 *
 * 一个商品在一段（B 或 C）里会弹几次卡，位置由两处决定：
 * 1. **商品级编号** —— 引擎在**这一段一开始**就弹一次（`DirectorEngine` 里
 *    `showGoods(product.goodsId)` 排在第一步之前）
 * 2. **每个步骤上的「商品链接时间点」（cue）** —— 时间相对于该步骤的开头
 *
 * 这两处很容易撞车：商品级已经占了第 0 秒，第一步再来一条 `at: 0` 的 cue，
 * 同一瞬间就弹两次；同一步骤上重复加几条，更是连着弹。
 * 平台侧看到的是同一张卡，观众无感，但每一次都会真发一次请求。
 *
 * 所以这里把一段里所有弹卡位置**换算到同一条时间轴上**，把挨得太近的挑出来，
 * 在界面上提示 —— 配置的时候就说，而不是等播的时候才发现。
 */

/** 两次弹卡间隔小于这个秒数就算"太密"。 */
export const MIN_POPUP_GAP_SECONDS = 3

export interface PopupMoment {
  /** 从这一段开始算的绝对秒数 */
  at: number
  /** 人话来源 */
  label: string
}

/** 一个步骤占多长时间：视频看切点差，其它看 duration。 */
function stepSeconds(step: DirectorStep) {
  return isDirectorVideoStep(step) && step.end > step.start ? step.end - step.start : step.duration
}

/** 把一段（B 或 C）里所有会弹卡的位置换算到同一条时间轴上，按时间排序。 */
export function popupMoments(
  steps: DirectorStep[],
  goodsId: number | null | undefined,
  phaseLabel = '这一段',
): PopupMoment[] {
  const moments: PopupMoment[] = []
  if (goodsId !== null && goodsId !== undefined)
    moments.push({ at: 0, label: `商品编号（${phaseLabel}一开始就弹一次）` })
  let offset = 0
  steps.forEach((step, index) => {
    for (const cue of step.cues || [])
      moments.push({
        at: offset + cue.at,
        label: `第 ${index + 1} 步「${step.name || '未命名'}」第 ${cue.at} 秒`,
      })
    offset += stepSeconds(step)
  })
  return moments.sort((a, b) => a.at - b.at)
}

export interface PopupClash {
  gap: number
  first: PopupMoment
  second: PopupMoment
}

/** 挨得太近的弹卡对（含同一秒并列的）。 */
export function crowdedPopups(
  moments: PopupMoment[],
  minGap = MIN_POPUP_GAP_SECONDS,
): PopupClash[] {
  const clashes: PopupClash[] = []
  for (let index = 1; index < moments.length; index++) {
    const gap = moments[index].at - moments[index - 1].at
    if (gap < minGap) clashes.push({ gap, first: moments[index - 1], second: moments[index] })
  }
  return clashes
}

/** 一句话描述一处拥挤，给界面直接用。 */
export function describeClash(clash: PopupClash) {
  const when = clash.gap === 0 ? '同一瞬间' : `只隔 ${clash.gap.toFixed(1)} 秒`
  return `${clash.first.label} 和 ${clash.second.label} ${when}会各弹一次卡`
}
