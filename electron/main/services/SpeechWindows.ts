import type { SpeechBudgetLedger } from '../../../shared/speechBudget'
import { speechWindowMissed, type SpeechWindow } from '../../../shared/directorNarration'
import {
  type AimCandidate,
  MAX_AIM_SECONDS,
  MIN_USEFUL_WINDOW,
  aimWindow,
} from '../../../shared/interactionScript'

/**
 * 语音窗口的唯一主人。
 *
 * ## 为什么要单独一个类
 *
 * 窗口由**播放层**产生（每 16ms 读一次 OBS 游标），却由**决策层**消费。
 * 之前这份数据被塞进 `DirectorViewerContext`（那是「观众状态」，不是播放器
 * 内部状态），绕了四跳才回到决策层，于是：
 *
 *   · 预瞄只在「没有窗口」的老路径上更新过 → 有窗口的步骤永远 0 个候选；
 *   · 那个每 16ms 变一次的倒计时进了上下文指纹 → 每次合成都被判「上下文已变」；
 *   · 取窗口的地方被限制成 4 个 → 提前量筛不到第 5 个之后的；
 *   · 类型里根本没声明 `speech`，运行时硬塞 —— 谁也不知道有这根线。
 *
 * 现在它只有一个主人：**播放层写，决策层读**，中间不经过任何别的容器。
 * 上下文指纹因此不可能再被污染（窗口根本不在上下文里）。
 *
 * ## 写点只有三个
 *
 *   · `begin()`   —— 换到新的一段配音
 *   · `advance()` —— 读到新游标（播放层的两条路径都要调）
 *   · `end()`     —— 这一段结束，清空
 *
 * 读点只有两个：`aim()` 挑窗口、`upcoming()` 看全部候选（诊断用）。
 */
class SpeechWindowTracker {
  private windows: SpeechWindow[] = []
  /** 当前这段配音的素材键，用来识别「换段了」。 */
  private key = ''
  private cursorSeconds = 0
  private ledger?: SpeechBudgetLedger

  /**
   * 接上额度账本。
   *
   * 放在这里而不是各自持有，是因为「窗口」和「余额」永远是同一个问题的两面：
   * 这句话塞不进这个窗口，还可能靠这一步的余额塞进去。
   */
  useLedger(ledger?: SpeechBudgetLedger) {
    this.ledger = ledger
  }

  /** 换到新的一段配音。没有窗口就清空 —— 这一步不能说话。 */
  begin(key: string, windows: SpeechWindow[]) {
    this.key = key
    this.windows = [...windows].sort((a, b) => a.start - b.start)
    this.cursorSeconds = 0
  }

  /** 播放层读到游标时调用。这是唯一的更新点。 */
  advance(cursorSeconds: number) {
    if (!Number.isFinite(cursorSeconds)) return
    this.cursorSeconds = cursorSeconds
  }

  /** 这一段配音结束。 */
  end() {
    this.key = ''
    this.windows = []
    this.cursorSeconds = 0
  }

  get active() {
    return this.windows.length > 0
  }

  /**
   * 整句尚未开始、或真实静音尚未结束的窗口，按时间升序。
   * 携带已审核原句和配对上下文，供决策层生成针对该句的替换内容。
   */
  upcoming(): AimCandidate[] {
    return this.windows
      .filter(window => window.end > this.cursorSeconds + 0.05)
      .filter(window => !speechWindowMissed(window, this.cursorSeconds))
      .map(window => ({
        kind: window.kind,
        originalText: window.transcript?.text,
        context: window.material && window.review ? {
          stepId: window.material.stepId, video: window.material.video, audio: window.audio,
          start: window.transcript?.start ?? window.start,
          end: window.transcript?.end ?? window.end, reason: window.review.reason,
          variantId: window.material.variantId,
        } : undefined,
        start: window.start,
        end: window.end,
        /**
         * 还有几秒开始。**已经开始的记成负数**（已经开始了多少秒），不要夹到 0 ——
         * `usable` 是拿 `inSeconds + duration` 推**剩余**时间的，一夹就会虚高：
         * 窗口 [2,6] 游标 3 时，夹成 0 会算出 4 秒剩余，实际只剩 3 秒。
         */
        inSeconds: window.start - this.cursorSeconds,
        duration: window.end - window.start,
      }))
  }

  /** 挑一个来得及、装得下、也等得到的窗口。挑不到就是这一轮不该出声。 */
  aim(leadSeconds: number, minSeconds = MIN_USEFUL_WINDOW, maxSeconds = MAX_AIM_SECONDS) {
    return aimWindow(this.upcoming(), leadSeconds, minSeconds, maxSeconds)
  }

  /** 这一步还能超窗口多少秒。画面比配音长省下来的时间，可以垫给后面的插话。 */
  slackSeconds() {
    return Math.max(0, (this.ledger?.remainingMs ?? 0) / 1000)
  }

  /** 诊断快照：为什么没出声，一眼能看出是哪一条。 */
  snapshot() {
    return {
      active: this.active,
      key: this.key,
      cursorSeconds: this.cursorSeconds,
      total: this.windows.length,
      upcoming: this.upcoming(),
      slackSeconds: this.slackSeconds(),
    }
  }
}

/** 全进程一份。播放层写，决策层读，谁都不许再转手。 */
export const speechWindows = new SpeechWindowTracker()

export type { AimCandidate, SpeechWindow }
