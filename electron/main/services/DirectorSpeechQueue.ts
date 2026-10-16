import type { SpeechBudgetLedger } from '../../../shared/speechBudget'
import type { AdaptiveSpeechStream } from './AdaptiveSpeechStream'
import {OBS_STREAM_RESERVE_SECONDS} from '../../../shared/speechPlayback'

export interface ReadySpeech {
  id: string
  text: string
  file: string
  duration: number
  streaming?: AdaptiveSpeechStream
  materialize?:(budgetSeconds:number)=>Promise<{file:string;duration:number}>
  expiresAt: number
  priority: number
  valid: () => boolean
  done?: (status: 'played' | 'expired' | 'failed') => void
}
/** Contains only measured, ready audio. Never wait for inference on the playback path. */
export class DirectorSpeechQueue {
  private ready: ReadySpeech[] = []
  private timers = new Map<ReadySpeech, ReturnType<typeof setTimeout>>()
  constructor(
    private now = Date.now,
    /** 阶段额度账本：插话可以超出窗口，只要总账不透支。不传就是纯窗口判定。 */
    private ledger?: SpeechBudgetLedger,
  ) {}
  private remove(item: ReadySpeech) {
    const index = this.ready.indexOf(item)
    if (index < 0) return false
    this.ready.splice(index, 1)
    clearTimeout(this.timers.get(item))
    this.timers.delete(item)
    return true
  }
  private expire(item: ReadySpeech) {
    if (!this.remove(item)) return
    this.notifyExpired(item)
  }
  private notifyExpired(item: ReadySpeech) {
    try {
      item.done?.('expired')
    } catch (error) {
      console.error('Speech expiry callback failed', error)
    }
  }
  private arm(item: ReadySpeech) {
    const timer = setTimeout(() => {
      if (item.expiresAt <= this.now()) this.expire(item)
      else this.arm(item)
    }, Math.max(1, Math.min(2147483647, item.expiresAt - this.now())))
    timer.unref?.()
    this.timers.set(item, timer)
  }
  private prune() {
    const now = this.now()
    for (const item of [...this.ready]) {
      if (item.expiresAt <= now || !item.valid()) this.expire(item)
    }
  }
  add(item: ReadySpeech) {
    if (!Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 20) return false
    if (!Number.isFinite(item.expiresAt)) return false
    if (this.ready.some(value => value.id === item.id)) return false
    if (item.expiresAt <= this.now()) {
      this.notifyExpired(item)
      return false
    }
    this.ready.push(item)
    this.arm(item)
    if (this.ready.length > 8) this.expire(this.ready[0])
    return true
  }
  /**
   * 取一条放得进的语音。**只看账、不记账。**
   *
   * 这里以前会 `charge` 一次。问题是取用只是「决定要播」，播放层随后还会用
   * `slackSeconds()` 再复查一遍装不装得下 —— 那时账已经被扣过一次，复查用的
   * 是**扣款后**的额度，于是刚刚被放行的这句又被自己否掉。实测仿真里
   * 「取到了、检查没过、丢掉」，整整一轮听不到声音。
   *
   * 记账改到**真正开播那一刻**（`DirectorObsOutput.startSpeech` 放行之后），
   * 没播成就不该扣钱。
   */
  take(window: { deadline: number; budget: number; strict?: boolean; minDuration?:number }) {
    const now = this.now()
    this.prune()
    // 额度制：可用时间 = 窗口时长 + 这一阶段还剩的余量。
    // 前面插了句短话省下的时间，就能垫给后面这句超出的 —— 总账不透支就行。
    const slack = window.strict ? 0 : Math.max(0, (this.ledger?.remainingMs ?? 0) / 1000)
    const budget = Math.min(window.budget + slack, (window.deadline - now) / 1000)
    const candidate = [...this.ready]
      .sort((a, b) => b.priority - a.priority)
      /**
       * 静音气口只要求装得下。完整原句替换另有 minDuration：
       * 太短的回复不能制造几秒的空等，应继续原讲解，留给更匹配的窗口。
       *
       * 以前这里还有一条 `item.duration >= window.budget - 1.5`，意思是
       * 「别在窗口里留大空洞」。**那条是错的**：旁白在 `window.end` 恢复，
       * 短句播完会把剩下的静音照常等完（见 `playWindowedNarration` 的 padding），
       * 那个判断仅适用于原录音本来就是静音的窗口；不适用于原本有声音的完整句。
       *
       * 代价实测很大（A 段「目标人群」）：一句 1.04 秒的「你好呀」塞进气口
       * 2.877–6.063（3.19 秒），因为 `1.04 < 3.19 − 1.5` 被拒 —— 只能一路
       * 等到 6.748 那个 1.46 秒的小气口，**白等 3.4 秒**。
       *
       * 气口是**机会**，不是「必须填满的容器」。还有余量就塞进去，
       * 别为了等一个「更合身」的而错过眼前这个。
       */
      .find(item => (window.minDuration===undefined ||
          (Number.isFinite(window.minDuration)&&window.minDuration>=0&&
            (item.streaming?.minimumDuration??item.duration)>=window.minDuration)) &&
        (item.streaming ? item.streaming.canStart(budget - (item.streaming.generationComplete&&item.materialize ? .25 : OBS_STREAM_RESERVE_SECONDS)) : item.duration + 0.25 <= budget))
    if (candidate) this.remove(candidate)
    return candidate
  }
  clear() {
    const items = this.ready.splice(0)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const item of items) this.notifyExpired(item)
  }
  /**
   * 把取出来又没用上的放回去。
   *
   * `take` 是从队列里**移除**的。播放层取到之后还要做几项复查（游标有没有走过头、
   * 窗口够不够、上下文变没变），任何一项没过就会放弃这一句。以前放弃就是
   * `done('expired')` —— **这句从此消失，后面的气口再也用不上它**。
   *
   * 实测代价：A 段第 3 秒发话时，语音在气口2 被取出、因剩余不够被拒，
   * 于是整个 28 秒里再也没出声，只能发文字。放回队列它就能落到气口3。
   */
  put(item: ReadySpeech) {
    this.add(item)
  }
  takeNext() {
    this.prune()
    this.ready.sort((a, b) => b.priority - a.priority)
    const candidate = this.ready.find(item => !item.streaming || item.streaming.canStart(19.4))
    if (candidate) this.remove(candidate)
    return candidate
  }
}
