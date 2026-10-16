import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AudienceTrace } from '../../../shared/audienceEvents'
import type {
  DirectorConfig,
  DirectorCue,
  DirectorProduct,
  DirectorRequest,
  DirectorSnapshot,
  DirectorStep,
  DirectorTray,
  DirectorViewerContext,
} from '../../../shared/director'
import {
  demoModeFromText,
  isDirectorVideoStep,
  validateDirectorRunConfig,
} from '../../../shared/director'
import { DirectorRequestHistory } from './DirectorRequestHistory'

/**
 * 弹卡失败后补试几次、每次隔多久。
 *
 * 说明：这只是**便宜的保险**，不是针对某个已知必现问题的补丁。
 * 之前把「导播刚启动那一下失败」当成"页面没就绪"，那是错的 ——
 * 实测那一次是**商家还没在千帆里把商品上架**，货架是空的，所以列表根本不存在。
 * 那种情况重试也没用（三次都会失败，日志会如实记三行）。
 * 真正可能救回来的是偶发情况：列表正在重绘、中控台页面在跳转之类。
 */
const GOODS_POPUP_RETRIES = 2
const GOODS_POPUP_RETRY_MS = 1500

export interface DirectorOutput {
  prepare(config: DirectorConfig, signal: AbortSignal): Promise<void>
  overview(tray: DirectorTray, signal: AbortSignal): Promise<void>
  completeOverview?(signal: AbortSignal): Promise<void>
  completePhase?(signal: AbortSignal): Promise<void>
  step(
    step: DirectorStep,
    product: DirectorProduct | undefined,
    signal: AbortSignal,
    onCue?: (cue: DirectorCue) => Promise<void>,
    phase?: 'A' | 'B' | 'C',
    lastInPhase?: boolean,
  ): Promise<void>
  transition(file: string, signal: AbortSignal): Promise<void>
  product(product: DirectorProduct, signal: AbortSignal, phase: 'B' | 'C'): Promise<void>
  /** holdFrame=true 时保留最后一帧，避免异常停机给观众留黑屏。 */
  stop(holdFrame?: boolean): Promise<void>
  notice?(text: string): Promise<void>
}
export class DirectorEngine {
  state: DirectorSnapshot = {
    running: false,
    preview: true,
    phase: 'idle',
    trayId: '',
    productId: '',
    step: '',
    queue: [],
    message: '',
    logs: [],
  }
  private controller?: AbortController
  private overviewInterruptRequested = false
  private task?: Promise<void>
  /** 这次运行是不是异常结束的（不是用户主动停）。决定停机时冻不冻帧。 */
  private crashed = false
  private cursor = new Map<string, number>()
  private pending = new Map<string, { mode: 'B' | 'C'; expires: number }>()
  private cooldown = new Map<string, number>()
  private seen = new Set<string>()
  /**
   * 正在播的那条点播。cancelRequest 要能看见它 —— 否则观众说"不用了"时，
   * 他的点播很可能已经因为 A 段可抢占而开始播了，队列里找不到，就撤不掉。
   */
  private current?: DirectorRequest
  /** 正在播、且观众已喊停的请求 id：当前这步放完就切走。 */
  private cancelCurrentId = ''
  constructor(
    public config: DirectorConfig,
    private output: DirectorOutput,
    private popup: (
      goodsId: number,
      label: string,
      signal: AbortSignal,
    ) => Promise<void> = async () => {},
    private wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
    /** 异常停机时回调一次，由外层落盘，方便事后查。 */
    private onCrash?: (report: { where: string; detail: string }) => void,
    readonly requestHistory = new DirectorRequestHistory(),
  ) {}

  userContext(user: string): DirectorViewerContext {
    const own = this.requestHistory.forUser(user)
    const yourQueue = this.state.queue.flatMap((request, index) => {
      const record = own.findLast(r => r.id === request.id && r.status === 'queued')
      return record ? [{ ...record, position: index + 1 }] : []
    })
    const active = this.state.running && this.state.phase !== 'error' ? this.current : undefined
    const playbackStatus =
      active && this.requestHistory.records.findLast(r => r.id === active.id && !r.endedAt)?.status
    const yourActive = active
      ? own.findLast(
          r => r.id === active.id && ['preparing', 'playing', 'cancelling'].includes(r.status),
        )
      : undefined
    return structuredClone({
      phase: this.state.phase,
      productId: this.state.productId,
      step: this.state.step,
      queue: yourQueue.map(({ trayId, productId, mode }) => ({ trayId, productId, mode })),
      yourQueue,
      yourActive: yourActive ?? null,
      nowPlaying: active
        ? {
            requestId: active.id,
            trayId: active.trayId,
            productId: active.productId,
            mode: active.mode,
            forViewer: Boolean(yourActive),
            status:
              this.cancelCurrentId === active.id
                ? 'cancelling'
                : playbackStatus === 'preparing'
                  ? 'preparing'
                  : 'playing',
          }
        : null,
      recentRequests: own
        .filter(r => r.endedAt !== undefined)
        .slice(-10)
        .reverse(),
      capturedAt: Date.now(),
    })
  }
  removeRequest(id: string) {
    if (!this.state.queue.some(request => request.id === id)) return
    this.state.queue = this.state.queue.filter(request => request.id !== id)
    this.requestHistory.set(id, 'cancelled')
  }

  log(message: string) {
    this.state.message = message
    this.state.logs = [`${new Date().toLocaleTimeString()} ${message}`, ...this.state.logs].slice(
      0,
      80,
    )
  }
  snapshot() {
    return structuredClone(this.state)
  }
  private respond(message: string) {
    void this.output.notice?.(message).catch(error => this.log(`互动字幕未显示：${String(error)}`))
    return message
  }
  private async showGoods(goodsId: number, label: string, signal: AbortSignal) {
    try {
      await this.popup(goodsId, label, signal)
      this.log(`${label} 商品卡片 ${goodsId} 已切换，请核对直播端`)
    } catch (error) {
      if (signal.aborted) throw error
      this.log(`${label} 商品链接未确认：${String(error)}`)
      // 补试放后台 —— runCues 是和视频一起 Promise.all 等的，在这里等会把画面卡住。
      void this.retryGoods(goodsId, label, signal)
    }
  }
  /** 弹卡失败后的后台补救：隔一会儿再试，不占用这一步的时间。 */
  private async retryGoods(goodsId: number, label: string, signal: AbortSignal) {
    for (let attempt = 1; attempt <= GOODS_POPUP_RETRIES; attempt++) {
      try {
        await delay(GOODS_POPUP_RETRY_MS, undefined, { signal })
      } catch {
        return
      }
      if (signal.aborted) return
      try {
        await this.popup(goodsId, label, signal)
        this.log(`${label} 商品卡片 ${goodsId} 重试成功（第 ${attempt} 次），请核对直播端`)
        return
      } catch (error) {
        if (signal.aborted) return
        this.log(`${label} 商品卡片重试第 ${attempt} 次仍未确认：${String(error)}`)
      }
    }
  }
  private async showOverview(tray: DirectorTray, signal: AbortSignal, requested = false) {
    this.overviewInterruptRequested = false
    this.state.phase = 'A'
    this.state.trayId = tray.id
    this.state.productId = ''
    this.state.step = '托盘总览'
    await this.output.overview(tray, signal)
    if (this.overviewInterruptRequested && this.state.queue.length) {
      this.log('总览已收到点播，正在切换商品')
      return
    }
    const started = Date.now()
    for (let index = 0; index < tray.A.length; index++) {
      const step = tray.A[index]
      signal.throwIfAborted()
      this.state.step = step.name
      try {
        await this.output.step(
          step,
          undefined,
          signal,
          this.config.popup && !this.state.preview
            ? cue => this.showGoods(cue.goodsId, `${tray.name} / A / ${step.name}`, signal)
            : undefined,
          'A',
          index === tray.A.length - 1,
        )
      } catch (error) {
        if (signal.aborted || !step.optional) throw error
        this.log(`跳过可选步骤 ${step.name}：${String(error)}`)
      }
      if (this.overviewInterruptRequested && this.state.queue.length) {
        this.log('当前总览步骤已播完，正在切换点播商品')
        return
      }
    }
    await this.output.completeOverview?.(signal)
    while (
      Date.now() - started <
      (requested || this.state.queue.length
        ? this.config.requestSeconds
        : this.config.normalSeconds) *
        1000
    ) {
      if (this.overviewInterruptRequested && this.state.queue.length) return
      await this.wait(100, signal)
    }
  }
  async start(trayId: string, preview: boolean) {
    if (this.state.running) throw new Error('请先停止当前导播')
    validateDirectorRunConfig(this.config, trayId)
    const tray = this.config.trays.find(t => t.id === trayId)
    if (!tray?.products.some(p => p.B.length))
      throw new Error('该托盘至少需要一款配置了 B 步骤的商品')
    this.controller = new AbortController()
    this.state = {
      ...this.state,
      running: true,
      preview,
      phase: 'preparing',
      trayId,
      productId: '',
      step: '',
      queue: [],
    }
    this.log(preview ? '正在准备模拟流程…' : '正在连接 OBS 并准备导播素材…')
    this.pending.clear()
    this.cooldown.clear()
    this.seen.clear()
    this.cursor.clear()
    const signal = this.controller.signal
    this.crashed = false
    this.task = this.run(tray, signal)
      .catch(error => {
        if (signal.aborted) return
        // 记下出事时到底在哪一步 —— 不然只有一个错误消息，没法定位。
        const where = [
          `托盘 ${tray.name}`,
          this.state.productId ? `商品 ${this.state.productId}` : '总览',
          `步骤 ${this.state.step || '—'}`,
          `阶段 ${this.state.phase}`,
        ].join(' / ')
        const detail = error instanceof Error ? error.message : String(error)
        this.state.phase = 'error'
        this.crashed = true
        this.requestHistory.interrupt('failed')
        this.log(`出错位置：${where}`)
        this.log(`导播暂停：${detail}`)
        try {
          this.onCrash?.({ where, detail })
        } catch {}
      })
      .finally(async () => {
        try {
          // 出错停机时把画面冻在最后一帧，别给观众留一路黑屏
          await this.output.stop(this.crashed)
        } catch (e) {
          this.log(`停止输出失败：${String(e)}`)
        }
        this.state.running = false
        this.requestHistory.interrupt(this.crashed ? 'failed' : 'interrupted')
        this.state.queue = []
        this.current = undefined
        this.cancelCurrentId = ''
      })
  }
  async stop() {
    this.controller?.abort()
    await this.task
    this.state.running = false
    this.state.phase = 'idle'
    this.state.queue = []
    this.requestHistory.interrupt()
    this.pending.clear()
    this.current = undefined
    this.cancelCurrentId = ''
    this.log('已停止导播')
  }
  enqueue(trayId: string, productId: string, mode: 'B' | 'C', user = '手动') {
    return this.acceptRequest(trayId, productId, mode, user, false).message
  }
  acceptRequest(
    trayId: string,
    productId: string,
    mode: 'B' | 'C',
    user: string,
    cooldown = true,
    trace?: AudienceTrace,
  ): { accepted: boolean; code: string; message: string } {
    const reject = (code: string, message: string) => ({ accepted: false, code, message })
    if (!this.state.running) return reject('stopped', '请先启动模拟或 OBS 导播')
    if (cooldown && (this.cooldown.get(user) || 0) > Date.now())
      return reject('cooldown', '你的点播已收到，请稍等当前展示结束')
    const tray = this.config.trays.find(t => t.id === trayId)
    const product = tray?.products.find(p => p.id === productId)
    if (!product?.[mode].length)
      return reject(
        'material',
        `${product?.name || productId} 暂时没有${mode === 'C' ? '试戴' : '展示'}素材`,
      )
    const merged = this.state.queue.find(
      r => r.trayId === trayId && r.productId === productId && r.mode === mode,
    )
    if (merged) {
      merged.users = [...new Set([...(merged.users ?? [merged.user]), user])]
      this.requestHistory.add(merged, product.name, user, trace)
      return reject('merged', '同款点播已合并，也记上你的点播了')
    }
    if (this.state.queue.length >= this.config.maxQueue)
      return reject('full', '点播队列已满，请稍后再试')
    const request = { id: randomUUID(), trayId, productId, mode, user }
    this.state.queue.push(request)
    this.requestHistory.add(request, product.name, user, trace)
    if (this.config.interruptAOnRequest && this.state.phase === 'A')
      this.overviewInterruptRequested = true
    const note = product.notes?.[mode]?.trim()
    const message = `${productId} ${product.name} ${mode === 'C' ? '试戴' : '展示'}已排队${note ? `：${note}` : ''}`
    this.log(message)
    if (cooldown) {
      if (this.cooldown.size >= 1000) this.cooldown.delete(this.cooldown.keys().next().value ?? '')
      this.cooldown.set(user, Date.now() + this.config.cooldownSeconds * 1000)
    }
    return { accepted: true, code: 'accepted', message }
  }
  /**
   * 撤掉观众的某条点播，排队中的和**正在播的**都能撤。
   *
   * 只管这个用户自己的，别人点的同一款不受影响。不给 productId / mode 就撤他的全部。
   *
   * 正在播的那条不在队列里，所以单独处理：标记一下，**当前这一步放完就切走**
   * （不硬切，否则音频会在半个字上断掉），然后照常回总览或接下一个排队的。
   * 观众点完又说"不用了"时，点播往往已经因为 A 段可抢占而开始播了 ——
   * 只撤队列会让他觉得"说了没用"。
   */
  cancelRequest(
    user: string,
    trayId?: string,
    productId?: string,
    mode?: 'B' | 'C',
  ): { cancelled: number; message: string } {
    const matches = (request: DirectorRequest) =>
      (request.users ?? [request.user]).includes(user) &&
      (trayId === undefined || request.trayId === trayId) &&
      (productId === undefined || request.productId === productId) &&
      (mode === undefined || request.mode === mode)
    const cancelledRequests = this.state.queue.filter(matches)
    const playing = this.current && matches(this.current) ? this.current : undefined
    if (!cancelledRequests.length && !playing)
      return { cancelled: 0, message: '你这边没有正在排队的点播。' }
    const detach = (request: DirectorRequest) => {
      request.users = (request.users ?? [request.user]).filter(viewer => viewer !== user)
      if (request.users.length) request.user = request.users[0]
      return request.users.length === 0
    }
    const removed = new Set<string>()
    for (const request of cancelledRequests) {
      this.requestHistory.set(request.id, 'cancelled', user)
      if (detach(request)) removed.add(request.id)
    }
    this.state.queue = this.state.queue.filter(request => !removed.has(request.id))
    const describe = (request: DirectorRequest) => {
      const product = this.config.trays
        .find(t => t.id === request.trayId)
        ?.products.find(p => p.id === request.productId)
      return `${request.productId} ${product?.name || ''} ${request.mode === 'C' ? '试戴' : '展示'}`
    }
    const names = cancelledRequests.map(describe)
    if (playing) {
      if (detach(playing)) {
        this.cancelCurrentId = playing.id
        this.requestHistory.set(playing.id, 'cancelling', user)
        names.push(
          `${describe(playing)}（${this.state.phase === 'transition' ? '切换中，已请求停止' : '正在播，这一步放完就切走'}）`,
        )
      } else {
        this.requestHistory.set(playing.id, 'cancelled', user)
        names.push(`${describe(playing)}（已撤掉你的点播，其他观众仍在看）`)
      }
    }
    const message = `好的，已取消：${names.join('、')}`
    // 冷却跟着一起撤：不然观众改主意马上重新点，会被"请稍等当前展示结束"挡住 ——
    // 他刚说了不用，这条冷却不该还算数。
    this.cooldown.delete(user)
    this.log(`${user}：${message}`)
    return { cancelled: cancelledRequests.length + (playing ? 1 : 0), message }
  }
  comment(text: string, user: string, messageId?: string, trace?: AudienceTrace) {
    if (!this.state.running) return '导播未启动'
    if (messageId && this.seen.has(messageId)) return ''
    if (messageId) {
      this.seen.add(messageId)
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!)
    }
    const now = Date.now()
    const old = this.pending.get(user)
    if (old && old.expires < now) this.pending.delete(user)
    const previous = this.pending.get(user)
    // 词表来自 interaction.modeKeywords（可配置），没配就用出厂词表。
    const mode = demoModeFromText(text, this.config.interaction?.modeKeywords) ?? previous?.mode
    if (!mode) return ''
    const matches = this.config.trays.flatMap(t =>
      t.products
        .filter(p =>
          [p.id, p.name, ...p.aliases]
            .filter(Boolean)
            .some(alias =>
              /^\d+$/.test(alias)
                ? new RegExp(`(^|[^0-9])${alias}([^0-9]|$)`).test(text)
                : text.includes(alias),
            ),
        )
        .map(p => ({ tray: t, product: p })),
    )
    const local = matches.filter(item => item.tray.id === this.state.trayId)
    const resolved = local.length === 1 ? local[0] : matches.length === 1 ? matches[0] : undefined
    if (!resolved) {
      if (this.pending.size >= 500) this.pending.delete(this.pending.keys().next().value!)
      this.pending.set(user, { mode, expires: now + 60000 })
      const message = '你想看哪一款？请告诉我唯一的商品编号或名称。'
      this.log(`${user}：${message}`)
      return this.respond(message)
    }
    const { tray, product } = resolved
    this.pending.delete(user)
    return this.respond(this.acceptRequest(tray.id, product.id, mode, user, true, trace).message)
  }
  /** 队列优先：还有商品在排队时跳过总览，直接 B 接 B。缺省视为开启。 */
  private queueSkipsOverview() {
    return this.config.queueSkipsOverview ?? true
  }
  private async run(initial: DirectorTray, signal: AbortSignal) {
    await this.output.prepare(this.config, signal)
    let tray = initial
    /** 上一个商品播完时队列里还有人，就别再插一遍总览了。 */
    let skipOverview = false
    while (!signal.aborted) {
      if (skipOverview) this.log(`队列还有 ${this.state.queue.length} 个点播，直接接下一个商品`)
      else await this.showOverview(tray, signal)
      skipOverview = false
      let request: DirectorRequest | undefined = this.state.queue.shift()
      if (request) {
        this.current = request
        this.requestHistory.set(request.id, 'preparing')
      }
      if (request && request.trayId !== tray.id) {
        const next = this.config.trays.find(t => t.id === request?.trayId)!
        if (next.transitionIn) {
          this.state.phase = 'transition'
          await this.output.transition(next.transitionIn, signal)
        }
        tray = next
        await this.showOverview(tray, signal, true)
      }
      signal.throwIfAborted()
      if (request && this.cancelCurrentId === request.id) {
        this.requestHistory.set(request.id, 'cancelled')
        this.current = undefined
        this.cancelCurrentId = ''
        skipOverview = this.state.queue.length > 0
        continue
      }
      if (!request) {
        const products = tray.products.filter(p => p.B.length)
        if (!products.length) throw new Error('当前托盘没有可轮播的商品')
        const i = this.cursor.get(tray.id) || 0
        request = {
          id: randomUUID(),
          trayId: tray.id,
          productId: products[i % products.length].id,
          mode: 'B',
          user: '轮播',
        }
        this.cursor.set(tray.id, i + 1)
      }
      const product = tray.products.find(p => p.id === request.productId)!
      this.state.productId = product.id
      this.current = request
      if (request.mode === 'C' && tray.transitionIn) {
        this.state.phase = 'transition'
        await this.output.transition(tray.transitionIn, signal)
      }
      this.state.phase = request.mode
      await this.output.product(product, signal, request.mode)
      this.requestHistory.set(request.id, 'playing')
      if (this.config.popup && !this.state.preview && product.goodsId !== null) {
        await this.showGoods(product.goodsId, `${product.id} ${product.name}`, signal)
      }
      for (const step of product[request.mode]) {
        signal.throwIfAborted()
        // 观众刚喊了"不用了"：这一步播完就走，剩下的步骤不放了
        if (this.cancelCurrentId === request.id) {
          this.log(`已取消：${product.id} ${product.name} 剩下的步骤不再播放`)
          break
        }
        this.state.step = step.name
        try {
          await this.output.step(
            step,
            product,
            signal,
            this.config.popup && !this.state.preview
              ? cue => this.showGoods(cue.goodsId, `${product.id} / ${step.name}`, signal)
              : undefined,
            request.mode,
            step === product[request.mode].at(-1),
          )
        } catch (error) {
          if (signal.aborted || !step.optional) throw error
          this.log(`跳过可选步骤 ${step.name}：${String(error)}`)
        }
      }
      await this.output.completePhase?.(signal)
      if (request.mode === 'C' && tray.transitionOut) {
        this.state.phase = 'transition'
        await this.output.transition(tray.transitionOut, signal)
      }
      this.requestHistory.set(
        request.id,
        this.cancelCurrentId === request.id ? 'cancelled' : 'completed',
      )
      this.current = undefined
      this.cancelCurrentId = ''
      // 这个商品播完了：队列里还有人就直接接下一个，不再回总览
      skipOverview = this.queueSkipsOverview() && this.state.queue.length > 0
    }
  }
}

export class PreviewDirectorOutput implements DirectorOutput {
  async prepare() {}
  async overview() {}
  async product() {}
  async stop() {}
  async transition(_file: string, signal: AbortSignal) {
    await delay(1000, undefined, { signal })
  }
  async step(step: DirectorStep, _p: DirectorProduct | undefined, signal: AbortSignal) {
    const seconds =
      isDirectorVideoStep(step) && step.end > step.start ? step.end - step.start : step.duration
    await delay(Math.min(seconds, 10) * 1000, undefined, { signal })
  }
}
