import { readFileSync, writeFileSync } from 'node:fs'
import {
  DEFAULT_DURATION_MODEL,
  type DurationModel,
  type DurationSample,
  appendSample,
  fitDurationModel,
} from '../../../shared/speechBudget'

/**
 * 字数 → 语音时长的自校准模型。
 *
 * 每次合成完记一笔（字数, 实测时长），样本够了就重新回归，下一次预估就更准。
 * 同步做，不引入 worker/队列 —— 200 条样本的最小二乘是微秒级，而记录发生在
 * 生成完成之后，本来就不在实时链路上。
 *
 * 落盘失败不影响运行：模型只影响「建议 AI 说几个字」，丢了顶多退回默认系数。
 */
export class SpeechDurationModel {
  private samples: DurationSample[] = []
  private model: DurationModel = DEFAULT_DURATION_MODEL

  constructor(private file: string) {
    this.load()
  }

  private load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { samples?: DurationSample[] }
      if (Array.isArray(parsed.samples)) this.samples = parsed.samples.slice(-200)
    } catch {
      // 首次运行、文件损坏、权限问题都走默认系数
    }
    this.model = fitDurationModel(this.samples)
  }

  get current() {
    return this.model
  }

  get sampleCount() {
    return this.samples.length
  }

  /** 记一笔实测。样本不足时模型仍是默认值，不用几条坏样本去改所有人的预算。 */
  record(chars: number, seconds: number) {
    if (!Number.isFinite(chars) || !Number.isFinite(seconds) || chars <= 0 || seconds <= 0) return
    this.samples = appendSample(this.samples, { chars, seconds })
    this.model = fitDurationModel(this.samples)
    try {
      writeFileSync(this.file, `${JSON.stringify({ samples: this.samples }, null, 2)}\n`, 'utf8')
    } catch {
      // 写不进去就只在内存里生效
    }
  }
}

const instances = new Map<string, SpeechDurationModel>()

/** 进程内单例：模型要在合成侧和 prompt 侧看到同一份。 */
export function getSpeechDurationModel(file: string) {
  if (!instances.has(file)) instances.set(file, new SpeechDurationModel(file))
  return instances.get(file)!
}
