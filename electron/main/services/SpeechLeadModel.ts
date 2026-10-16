import { readFileSync, writeFileSync } from 'node:fs'
import {
  type LeadSegment,
  type LeadState,
  DEFAULT_LEAD_SECONDS,
  afterMissed,
  afterPlayed,
  appendLeadSample,
  defaultLeadState,
  describeLead,
  leadOf,
  recentLatency,
} from '../../../shared/speechLead'

/**
 * 提前量的自校准模型 —— DeepSeek 写字和千问合成**分开记账**。
 *
 * 分开的理由是归因：合成慢了和写字慢了，处理方式不一样（前者要调千问那条链路，
 * 后者要调模型或 prompt），合起来记成一笔就永远分不清是谁。
 *
 * 同步落盘，和时长模型一样不在实时链路上（记录发生在合成完成之后）。
 * 写不进去不影响运行：丢了顶多退回配置里填的那个值。
 */
export class SpeechLeadModel {
  private state: LeadState = defaultLeadState()

  constructor(private file: string) {
    this.load()
  }

  private load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LeadState>
      if (Array.isArray(parsed.ai))
        this.state.ai = parsed.ai.filter(value => typeof value === 'number').slice(-100)
      if (Array.isArray(parsed.tts))
        this.state.tts = parsed.tts.filter(value => typeof value === 'number').slice(-100)
      if (typeof parsed.margin === 'number' && Number.isFinite(parsed.margin))
        this.state.margin = parsed.margin
    } catch {
      // 首次运行、文件损坏、权限问题都走默认值
    }
  }

  private save() {
    try {
      writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    } catch {
      // 写不进去就只在内存里生效
    }
  }

  /** 当前该提前多少秒。两段都攒够样本才用实测，否则用配置里填的。 */
  lead(fallback = DEFAULT_LEAD_SECONDS) {
    return leadOf(this.state, fallback)
  }

  get margin() {
    return this.state.margin
  }

  get sampleCount() {
    return Math.min(this.state.ai.length, this.state.tts.length)
  }

  /** 某一段的典型值，没样本就是 undefined。 */
  typical(segment: LeadSegment) {
    return recentLatency(this.state[segment])
  }

  /** 归因报告，直接写进日志/时间线。 */
  describe(fallback = DEFAULT_LEAD_SECONDS) {
    return describeLead(this.state, fallback)
  }

  /** 记一笔某一段的实测耗时。 */
  record(segment: LeadSegment, seconds: number) {
    this.state = {
      ...this.state,
      [segment]: appendLeadSample(this.state[segment], seconds),
    }
    this.save()
  }

  /** 这句话真播出去了 → 当前提前量够，下一轮再往下探一点。 */
  played() {
    this.state = afterPlayed(this.state)
    this.save()
  }

  /** 没赶上窗口 → 退回来。 */
  missed() {
    this.state = afterMissed(this.state)
    this.save()
  }
}

const instances = new Map<string, SpeechLeadModel>()

/** 进程内单例：写字的和读预瞄的要看到同一份。 */
export function getSpeechLeadModel(file: string) {
  if (!instances.has(file)) instances.set(file, new SpeechLeadModel(file))
  return instances.get(file)!
}
