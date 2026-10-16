import { setTimeout as delay } from 'node:timers/promises'
import type { DirectorTransitionConfig } from '../../../shared/director'
import type { ObsRpcClient } from './ObsWebSocketClient'

// Composite Blur v1.5.2: obs-composite-blur-filter.{c,h}.
export const DIRECTOR_BLUR_KIND = 'obs_composite_blur'
export const DIRECTOR_BLUR_SETTINGS = {
  blur_algorithm: 1,
  blur_type: 1,
  effect_mask: 0,
  radius: 0,
}

/** 「拉风箱」曲线上的一个关键点：at 是相对转场起点的毫秒数。 */
interface HuntPoint {
  at: number
  radius: number
}

export function requireDirectorDefocus(kinds: string[]) {
  if (!kinds.includes(DIRECTOR_BLUR_KIND))
    throw new Error(
      '失焦转场需要 OBS Composite Blur 滤镜（obs_composite_blur）。请确认安装并重启 OBS，或手动选择无转场／眨眼；不会自动回退黑场。',
    )
}

export class DirectorDefocusTransition {
  private prepared: string[] = []

  constructor(
    private client: Pick<ObsRpcClient, 'call'>,
    private sources: string[],
    /** 可注入，方便测试固定取值；random()=0.5 表示不做任何抖动。 */
    private random: () => number = Math.random,
  ) {}

  /** 以 base 为中心做 ±spread 比例的抖动。 */
  private jitter(base: number, spread: number) {
    return base * (1 + (this.random() * 2 - 1) * spread)
  }

  private filterName(sourceName: string) {
    return `${sourceName}:defocus`
  }

  async prepare(createFilters = true) {
    this.prepared = []
    for (const sourceName of this.sources) {
      const result = await this.client.call('GetSourceFilterList', { sourceName })
      const filters = result.filters as Array<{ filterName: string; filterKind: string }>
      const existing = filters.find(filter => filter.filterName === this.filterName(sourceName))
      if (!existing && !createFilters) continue
      if (existing && existing.filterKind !== DIRECTOR_BLUR_KIND)
        throw new Error(`失焦专用滤镜类型不匹配：${sourceName}`)
      if (!existing)
        await this.client.call('CreateSourceFilter', {
          sourceName,
          filterName: this.filterName(sourceName),
          filterKind: DIRECTOR_BLUR_KIND,
          filterSettings: DIRECTOR_BLUR_SETTINGS,
        })
      this.prepared.push(sourceName)
      await this.enabled(sourceName, false)
      if (!createFilters) continue
      await this.client.call('SetSourceFilterSettings', {
        sourceName,
        filterName: this.filterName(sourceName),
        filterSettings: DIRECTOR_BLUR_SETTINGS,
        overlay: false,
      })
    }
  }

  private enabled(sourceName: string, filterEnabled: boolean) {
    return this.client.call('SetSourceFilterEnabled', {
      sourceName,
      filterName: this.filterName(sourceName),
      filterEnabled,
    })
  }

  private async radius(radius: number) {
    const results = await Promise.allSettled(
      this.prepared.map(sourceName =>
        this.client.call('SetSourceFilterSettings', {
          sourceName,
          filterName: this.filterName(sourceName),
          filterSettings: { radius },
          overlay: true,
        }),
      ),
    )
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, '无法更新失焦滤镜')
  }

  async reset() {
    // Disable rather than leave radius=0: upstream issue #141 reports a subtle color shift.
    const results = await Promise.allSettled(
      this.prepared.map(sourceName => this.enabled(sourceName, false)),
    )
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, '无法关闭失焦滤镜，请检查 OBS 主画面滤镜')
  }

  /**
   * 生成一条「拉风箱」曲线：
   *   糊上去 → 对上一点（哎，对上了）→ 又糊回去（犹豫）→ 偶尔再犹豫一次 → 最终对上。
   *
   * 真实相机的自动对焦本来就会犹豫，而且每次的深浅和快慢都不同；参数全部带随机，
   * 是为了避免每一场转场都长得一模一样 —— 那才会露馅。
   * switchAt 是画面切换点，落在第一次糊到最重的那一刻。
   */
  private planHunt(config: DirectorTransitionConfig) {
    const peak = Math.min(30, Math.max(1, this.jitter(config.strength, 0.3)))
    const total = config.durationMs
    const weights = [
      0.18 + this.random() * 0.06, // 糊上去
      0.2 + this.random() * 0.1, // 第一次对上
      0.14 + this.random() * 0.08, // 又糊回去
    ]
    const secondHunt = this.random() < 0.25
    if (secondHunt) weights.push(0.12 + this.random() * 0.08, 0.1 + this.random() * 0.06)
    weights.push(0.3 + this.random() * 0.1) // 最终对焦
    const sum = weights.reduce((acc, weight) => acc + weight, 0)
    const spans = weights.map(weight => (weight / sum) * total)

    const catchDepth = 0.22 + this.random() * 0.28
    const loseDepth = 0.72 + this.random() * 0.23
    const points: HuntPoint[] = []
    let cursor = 0
    const push = (radius: number, span: number) => {
      cursor += span
      points.push({ at: cursor, radius })
    }
    push(peak, spans[0])
    const switchAt = cursor
    push(peak * catchDepth, spans[1])
    push(peak * loseDepth, spans[2])
    let next = 3
    if (secondHunt) {
      push(peak * (0.2 + this.random() * 0.2), spans[next++])
      push(peak * (0.55 + this.random() * 0.25), spans[next++])
    }
    push(0, spans[next])
    return { points, switchAt, total: cursor }
  }

  /**
   * 对称失焦（原版）：糊上去 → 停住 → 对回来。干脆，没有犹豫。
   * 峰值半径 ±30%、总时长 ±25%、进出比例 40%~60%，所以每一场也不是完全一样。
   */
  private planSymmetric(config: DirectorTransitionConfig) {
    const peak = Math.min(30, Math.max(1, this.jitter(config.strength, 0.3)))
    const total = config.durationMs * (1 + (this.random() * 2 - 1) * 0.25)
    const up = total * (0.4 + this.random() * 0.2)
    return {
      points: [
        { at: up, radius: peak },
        { at: total, radius: 0 },
      ],
      switchAt: up,
      total,
    }
  }

  /** 取曲线上某个时刻的半径；段内用 smoothstep 过渡。 */
  private sampleCurve(points: HuntPoint[], at: number) {
    let previous = { at: 0, radius: 0 }
    for (const point of points) {
      if (at <= point.at) {
        const span = point.at - previous.at
        const progress = span === 0 ? 1 : (at - previous.at) / span
        const eased = progress * progress * (3 - 2 * progress)
        return previous.radius + (point.radius - previous.radius) * eased
      }
      previous = point
    }
    return points.at(-1)?.radius ?? 0
  }

  /** 沿着曲线把半径推进到 toMs。采样夹在 toMs 上，保证切换点一定取到峰值。 */
  private async followCurve(
    points: HuntPoint[],
    fromMs: number,
    toMs: number,
    signal: AbortSignal,
  ) {
    const started = performance.now()
    for (;;) {
      signal.throwIfAborted()
      const at = Math.min(toMs, fromMs + (performance.now() - started))
      await this.radius(this.sampleCurve(points, at))
      if (at >= toMs) return
      await delay(Math.min(20, toMs - at), undefined, { signal })
    }
  }

  async run<T>(
    action: () => Promise<T>,
    config: DirectorTransitionConfig,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted()
    if (this.prepared.length !== this.sources.length) throw new Error('失焦滤镜尚未准备完成')
    if (config.durationMs === 0) return action()
    const { points, switchAt, total } =
      config.mode === 'hunt' ? this.planHunt(config) : this.planSymmetric(config)
    let outcome: { value: T } | { error: unknown }
    try {
      await this.radius(0)
      const results = await Promise.allSettled(
        this.prepared.map(sourceName => this.enabled(sourceName, true)),
      )
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      // 糊到最重的那一刻才切画面，切换藏在模糊里
      await this.followCurve(points, 0, switchAt, signal)
      signal.throwIfAborted()
      const result = await action()
      // 切换之后是「对上一点 → 又糊 → 最终对上」
      await this.followCurve(points, switchAt, total, signal)
      outcome = { value: result }
    } catch (error) {
      outcome = { error }
    }
    try {
      await this.reset()
    } catch (error) {
      throw new AggregateError(
        'error' in outcome ? [outcome.error, error] : [error],
        '失焦转场清理失败，请检查 OBS 主画面滤镜',
      )
    }
    if ('error' in outcome) throw outcome.error
    return outcome.value
  }
}
