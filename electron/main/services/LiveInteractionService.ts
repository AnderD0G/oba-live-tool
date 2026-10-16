import type { AudienceOutcome, AudienceTrace } from '../../../shared/audienceEvents'
import type { GroupReplyContext } from '../../../shared/audienceGroups'
import type {
  DirectorConfig,
  DirectorViewerContext,
  LiveIntent,
  LiveInteractionRecord,
} from '../../../shared/director'
import {
  DEFAULT_GREETING_REPLY,
  demoModeFromText,
  flattenReply,
  isCancelText,
  matchPlatformKeywords,
  modeAndFillerRegex,
  resolveMention,
  splitReply,
} from '../../../shared/director'
import { describeCapabilities, parseDirectorIntent } from '../../../shared/directorIntent'
import { directorStatusReply } from '../../../shared/directorStatusReply'
import type { RoutingContext } from '../../../shared/interactionRouting'
/**
 * 给 AI 的字数按窗口的这个比例算，不是按满窗口。
 *
 * 实测 AI 会**超出**字数预算（要 15 字写出 4.4 秒、约 20 字），而超出的后果很硬：
 * 语音塞不进窗口就直接不播，观众什么都收不到。所以留 15% 余量给它发挥。
 * 也不能留太多 —— 取用规则还要求「语音时长 ≥ 窗口 − 1.5 秒」，太短一样取不走。
 */
/** 见 shared/speechBudget 的 VOICE_BUDGET_RATIO —— 预算系数只有一份，别再抄一个。 */
import {
  defaultInteractionScript,
  describeScript,
  scriptForStep,
} from '../../../shared/interactionScript'
import type { DurationModel } from '../../../shared/speechBudget'
import { DEFAULT_VIEWER_SCORE, type ViewerBehavior, viewerScore } from '../../../shared/viewerScore'
import type { ConversationPolicy } from './ConversationPolicy'
import { planSpeech } from './SpeechPlanner'

// 动作词表是可配置数据（interaction.modeKeywords），默认值在 shared/director.ts。
// 这里只是转出去，保持原来的 import 路径可用。
export { demoModeFromText }

type Input = {
  accountId: string
  /** 用户的稳定标识（user_id 或昵称），用于排队/冷却/去重。 */
  user: string
  /** 观众昵称，用来在回复开头艾特他；和 user 分开是因为 user 可能是用户 ID。 */
  name?: string
  text: string
  messageId?: string
  simulated?: boolean
  routingContext?: RoutingContext
}
type Dependencies = {
  onEvent?: (input: Input, outcome: AudienceOutcome) => void
  memory?: {
    recent(account: string, user: string): string[]
    remember(account: string, user: string, turns: string[]): void
    append(account: string, user: string, turns: string[]): void
  }
  onReply?: (reply: string, input: Input, intent: LiveIntent) => void
  replyChannels?: (input: Input, intent: LiveIntent) => { text: boolean; voice: boolean }
  audienceContext?: (input: Input) => unknown
  responseGuidance?: (input: Input) => string | undefined
  groupReplyContext?: (input: Input) => GroupReplyContext | undefined
  authorizeGroupReply?: (input: Input) => { accepted: boolean; reason: string }
  groupReplyCurrent?: (input: Input) => boolean
  policy?: ConversationPolicy
  /** 是否拦下同一个人的重复弹幕。不传就是拦。 */
  blockDuplicates?: () => boolean
  /** 当前生效的提前量（两条线自校准的结果）。不传就用配置里填的。 */
  leadSeconds?: () => number
  config: DirectorConfig
  catalog?: () => DirectorConfig
  valid: () => boolean
  interpret: (prompt: string, signal: AbortSignal) => Promise<string>
  /** 当前的字数→时长系数（自校准）。不传就用实测默认值。 */
  durationModel?: () => DurationModel
  accept: (
    trayId: string,
    productId: string,
    mode: 'B' | 'C',
    user: string,
    trace?: AudienceTrace,
  ) => {
    accepted: boolean
    code: string
    message: string
  }
  send: (text: string, signal: AbortSignal) => Promise<boolean>
  /** 撤掉这个用户已排队的点播；不给目标就撤他队列里的全部。 */
  cancel?: (
    trayId: string | undefined,
    productId: string | undefined,
    mode: 'B' | 'C' | undefined,
    user: string,
  ) => { cancelled: number; message: string }
  /** 这个观众此刻的真实处境：他自己排的队 + 正在播什么。 */
  status?: (user: string) => Partial<DirectorViewerContext> & {
    phase: string
    productId: string
    step: string
    queue: { trayId: string; productId: string; mode: 'B' | 'C' }[]
  }
  activeTrayId?: () => string
  now?: () => number
}

/**
 * 协议校验已经挪进 `shared/directorIntent.ts`，由**能力表**统一推导。
 * 这里只做转发，保持原来的 import 路径可用。
 */
export const parseLiveIntent = parseDirectorIntent

/** 一个观众这场直播里的行为记录（只统计，不存原文，避免越长越占内存）。 */
interface ViewerSession {
  /** 说过几句 */
  comments: number
  /** 其中几句是重复的（和他自己前面说过的完全一样） */
  duplicated: number
  /** 已经被忽略过几次 */
  ignored: number
  /** 已经回过几次 */
  answered: number
  /** 成功点播过几次 */
  demos: number
  /** 他发过的不同说法（只留最近 30 条，用来判断是不是复读） */
  said: Set<string>
  /** 最近几句的时间戳（只留最近 30 个，用来算"一分钟内说了几句"） */
  recentAt: number[]
  firstAt: number
  lastAt: number
}

export class LiveInteractionService {
  readonly records: LiveInteractionRecord[] = []
  private controller = new AbortController()
  private queue: { input: Input; done: (result: string) => void }[] = []
  private busy = false
  private seen = new Set<string>()
  /**
   * 一轮没问完的对话。两种形态：
   * - 只知道想看什么（mode），等观众报编号；
   * - 只知道是哪一款（productId），等观众说"展示"还是"上头"。
   */
  private pending = new Map<
    string,
    {
      mode?: 'B' | 'C'
      trayId: string
      productId?: string
      expires: number
      /**
       * 我们最后问他的**原话**。
       *
       * 没有这个，AI 就不知道"是/不是"在确认哪件事 —— 它只看到观众说了"是"，
       * 却看不到我们上一句问的是什么。对话就是这么变成鸡同鸭讲的。
       */
      said?: string
    }
  >()
  private turns = new Map<string, string[]>()
  /**
   * 这个观众**这场直播**里的行为画像。
   *
   * 「什么人该不该理」不该由总纲写死 —— 那是死规矩，正常人问声好也会被误伤。
   * 改成把证据交给 AI：他说了多少句、几句是重复的、已经被忽略过几次、
   * 点播过几回、来了多久。让 AI 自己判断这人是来买东西的还是在刷屏。
   */
  private viewers = new Map<string, ViewerSession>()
  private sequence = 0
  constructor(private deps: Dependencies) {}
  private event(input: Input, outcome: AudienceOutcome) {
    try {
      this.deps.onEvent?.(input, {
        ...outcome,
        preview: Boolean(input.simulated || this.deps.config.interaction?.observeOnly !== false),
      })
    } catch {
      console.error('记录回复事件失败')
    }
  }
  stop() {
    this.controller.abort()
    for (const job of this.queue.splice(0)) {
      this.event(job.input, { kind: 'reply.result', detail: 'cancelled before processing' })
      job.done('cancelled')
    }
    this.pending.clear()
    this.turns.clear()
    this.viewers.clear()
  }
  private active() {
    return !this.controller.signal.aborted && this.deps.valid()
  }
  private async interpret(prompt: string, timeoutMs = 15000) {
    const request = new AbortController()
    const abort = () => request.abort()
    this.controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, Math.max(1, Math.min(15000, timeoutMs)))
    let rejectAbort: () => void = () => {}
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error('Interpretation cancelled or timed out'))
        request.signal.addEventListener('abort', rejectAbort, { once: true })
      })
      return await Promise.race([this.deps.interpret(prompt, request.signal), cancelled])
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', rejectAbort)
      this.controller.signal.removeEventListener('abort', abort)
    }
  }
  comment(input: Input): Promise<string> {
    if (!this.active()) return Promise.resolve('cancelled')
    const key = JSON.stringify([input.accountId, input.messageId || [input.user, input.text]])
    // 关掉重复拦截时不再拦 —— 测试时经常反复发同一句。
    if (this.deps.blockDuplicates?.() !== false && this.seen.has(key))
      return Promise.resolve('duplicate')
    if (this.queue.length >= 50) {
      this.event(input, { kind: 'reply.result', detail: 'queue full' })
      return Promise.resolve('queue full')
    }
    this.seen.add(key)
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value ?? '')
    return new Promise(done => {
      this.queue.push({ input: { ...input, text: input.text.slice(0, 2000) }, done })
      void this.drain()
    })
  }
  private async drain() {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length && this.active()) {
        const job = this.queue.shift()
        if (!job) break
        const result = await this.process(job.input)
        this.noteOutcome(job.input, result)
        job.done(result)
      }
    } finally {
      this.busy = false
      if (!this.active()) this.stop()
    }
  }
  /** 取（或建）这个观众的行为画像，顺手把这一句记进去。 */
  private sessionFor(key: string, text: string, now: number): ViewerSession {
    let session = this.viewers.get(key)
    if (!session) {
      if (this.viewers.size >= 500) this.viewers.delete(this.viewers.keys().next().value ?? '')
      session = {
        comments: 0,
        duplicated: 0,
        ignored: 0,
        answered: 0,
        demos: 0,
        said: new Set(),
        recentAt: [],
        firstAt: now,
        lastAt: now,
      }
      this.viewers.set(key, session)
    }
    const normalized = text.trim().toLowerCase().replace(/\s+/g, '')
    if (session.said.has(normalized)) session.duplicated++
    else if (session.said.size < 30) session.said.add(normalized)
    session.comments++
    session.lastAt = now
    session.recentAt.push(now)
    if (session.recentAt.length > 30) session.recentAt.shift()
    return session
  }
  /** 这一句最后是怎么处理的 —— 记下来给后面的话当证据。 */
  private noteOutcome(input: Input, result: string) {
    const session = this.viewers.get(JSON.stringify([input.accountId, input.user]))
    if (!session) return
    if (result.startsWith('ignored')) session.ignored++
    else if (result === 'accepted' || result === 'observe-only') {
      session.answered++
      session.demos++
    } else if (result.startsWith('answered') || result === 'greeting') session.answered++
  }
  /**
   * 这个观众这一场的行为统计。
   */
  private behaviorOf(session: ViewerSession, now: number): ViewerBehavior {
    return {
      comments: session.comments,
      duplicated: session.duplicated,
      ignored: session.ignored,
      answered: session.answered,
      demos: session.demos,
      minutesActive: Math.max(0, Math.round((session.lastAt - session.firstAt) / 60000)),
      lastMinute: session.recentAt.filter(at => now - at < 60000).length,
    }
  }
  /**
   * 给 AI 看的观众画像。只给统计数字，不给昵称、ID —— 够它判断"这人是不是在刷屏"就行。
   *
   * 分也一起给它：快到阈值时 AI 该更克制，而不是等系统一刀切。
   */
  private describeViewer(session: ViewerSession, now: number, config: DirectorConfig) {
    const behavior = this.behaviorOf(session, now)
    const scoring = viewerScore(behavior, config.interaction?.viewerScore)
    return {
      ...behavior,
      score: scoring.score,
      muteAt: (config.interaction?.viewerScore ?? DEFAULT_VIEWER_SCORE).muteAt,
      scoreReasons: scoring.reasons,
    }
  }
  private async process(input: Input) {
    const config = this.deps.catalog?.() || this.deps.config
    const record: LiveInteractionRecord = {
      id: ++this.sequence,
      user: input.user,
      text: input.text,
      result: 'interpreting',
    }
    this.records.push(record)
    if (this.records.length > 100) this.records.shift()
    const key = JSON.stringify([input.accountId, input.user])
    const now = (this.deps.now || Date.now)()
    // 他这场直播里的表现：说得多不多、是不是在复读、已经忽略过几回。
    // 该不该理他，让 AI 拿这些证据判断，而不是总纲写死一条规矩。
    const session = this.sessionFor(key, input.text, now)
    for (const [user, pending] of this.pending) {
      if (pending.expires <= now) {
        this.pending.delete(user)
      }
    }
    const activeTrayId = this.deps.activeTrayId?.() || config.trays[0]?.id || ''
    const playbackIdentity = () => {
      const status = this.deps.status?.(input.user)
      return JSON.stringify([
        this.deps.activeTrayId?.() || activeTrayId,
        status?.phase,
        status?.productId,
        status?.nowPlaying?.requestId,
      ])
    }
    const initialPlayback = playbackIdentity()
    const pending = this.pending.get(key)
    if (this.deps.memory) this.turns.set(key, this.deps.memory.recent(input.accountId, input.user))
    const mayAct = !input.simulated && this.deps.config.interaction?.observeOnly === false
    const catalog = config.trays.map(t => ({
      trayId: t.id,
      trayName: t.name,
      summary: t.summary || '',
      products: t.products.map(p => ({
        id: p.id,
        name: p.name,
        aliases: p.aliases,
        facts: p.facts,
        B: Boolean(p.B.length),
        C: Boolean(p.C.length),
      })),
    }))
    let providerPending = false
    let rejectedGeneratedGreeting = false
    const groupReply = this.deps.groupReplyContext?.(input)
    const guidance = groupReply?.guidance || this.deps.responseGuidance?.(input)
    try {
      const spokenMode = demoModeFromText(input.text, config.interaction?.modeKeywords)
      const productOf = (target: { trayId: string; productId: string }) =>
        config.trays
          .find(t => t.id === target.trayId)
          ?.products.find(p => p.id === target.productId)
      /**
       * 观众只报了编号，没说要看展示还是试戴。默认先问一句，等他答了再入队；
       * 关掉这个行为、或者这款压根没有试戴素材，就直接按展示入队。
       */
      const askMode = (target: { trayId: string; productId: string }): LiveIntent => {
        const ask = this.deps.config.interaction?.askModeBeforeDemo ?? true
        if (!ask || !productOf(target)?.C.length)
          return { action: 'request_demo', ...target, mode: 'B' }
        return { action: 'ask_mode', ...target }
      }
      let intent: LiveIntent | undefined
      // "007 上头"、"看看 007" 这类句子里编号前后带着说明词，先去掉再比对编号，
      // 这样既能认出是哪一款，也能看出他要的是展示还是试戴。
      const textForMatch = input.text
        .replace(modeAndFillerRegex(config.interaction?.modeKeywords), ' ')
        .trim()
      const exact = catalog.flatMap(t =>
        t.products
          .filter(p => [p.id, p.name, ...p.aliases].includes(textForMatch))
          .map(p => ({ trayId: t.trayId, productId: p.id })),
      )
      const namedTrays = config.trays.filter(
        t => input.text.includes(t.name) || (t.id.length >= 3 && input.text.includes(t.id)),
      )
      const preferred = exact.filter(p => p.trayId === (pending?.trayId || activeTrayId))
      const explicitlyNamed =
        namedTrays.length === 1 ? exact.filter(p => p.trayId === namedTrays[0].id) : []
      const resolved =
        namedTrays.length > 1
          ? undefined
          : explicitlyNamed.length === 1
            ? explicitlyNamed[0]
            : namedTrays.length === 1
              ? undefined
              : preferred.length === 1
                ? preferred[0]
                : exact.length === 1
                  ? exact[0]
                  : undefined
      // 规则层只做**高确定性快通道** —— 命中就省掉一次 AI 往返，没命中一律交给 AI。
      //
      // 什么算高确定性：观众自己说了明确动作词、报了能唯一对上号的编号、
      // 或者答的是我们刚问过的那句话。这些不需要"理解"，只需要匹配。
      //
      // 什么不算：靠"这款/那个"之类指代、要靠上文猜的那类。以前这里有一条正则
      // 兜底，结果观众的"这个多少钱"被抢成"你想看哪一款？"，AI 连看都没看到。
      // 现在这类全部交给 AI —— 它拿得到 yourQueue / nowPlaying，比正则判得准。
      //
      // 每条规则自己声明 priority，越大越先判，命中即停：顺序是数据，不是位置。
      // （"那个不要了"曾被后面的规则抢走，就是因为顺序藏在代码行号里。）
      const awaitingMode = pending?.productId ? pending : undefined
      let cancelResult: { cancelled: number; message: string } | undefined
      const intentRules: {
        priority: number
        name: string
        decide: () => LiveIntent | undefined
      }[] = [
        {
          // 取消排最高：这是"撤回"，优先级高于一切重新点播的解读。
          // 撤到了才算取消；没撤到就往下走（可能只是顺口一说，或他本来就没点播）。
          priority: 100,
          name: 'cancel',
          decide: () => {
            if (
              !mayAct ||
              !this.deps.cancel ||
              !isCancelText(input.text, config.interaction?.cancelKeywords)
            )
              return undefined
            cancelResult = this.deps.cancel(
              resolved?.trayId ?? pending?.trayId,
              resolved?.productId ?? pending?.productId,
              resolved ? spokenMode : undefined,
              input.user,
            )
            return cancelResult.cancelled ? { action: 'cancel_demo' } : undefined
          },
        },
        {
          // 刚才问了他"展示还是上头"，他答了动作词 → 直接入队
          priority: 90,
          name: 'answer-pending-mode',
          decide: () =>
            awaitingMode && spokenMode
              ? {
                  action: 'request_demo',
                  trayId: awaitingMode.trayId,
                  productId: awaitingMode.productId as string,
                  mode: spokenMode,
                }
              : undefined,
        },
        {
          // 问模式期间他换了另一款 → 对新款重新问模式
          priority: 80,
          name: 'switch-product-while-asking',
          decide: () => (awaitingMode && resolved ? askMode(resolved) : undefined),
        },
        {
          // 之前问过"想看什么"（只知道模式），他现在报了编号 → 用那个模式入队
          priority: 75,
          name: 'product-with-pending-mode',
          decide: () =>
            pending && resolved
              ? { action: 'request_demo', ...resolved, mode: pending.mode ?? 'B' }
              : undefined,
        },
        {
          // 编号 + 明确动作 → 直接入队
          priority: 70,
          name: 'product-with-mode',
          decide: () =>
            resolved && spokenMode
              ? { action: 'request_demo', ...resolved, mode: spokenMode }
              : undefined,
        },
        {
          // 只报了编号、没说动作 → 先问一句（这层不交给 AI，保证确定性）
          priority: 60,
          name: 'product-without-mode',
          decide: () => (resolved ? askMode(resolved) : undefined),
        },
      ]
      for (const rule of [...intentRules].sort((a, b) => b.priority - a.priority)) {
        intent = rule.decide()
        if (intent) {
          record.rule = rule.name
          break
        }
      }
      if (!intent && groupReply) {
        const gate = this.deps.policy?.before(input.accountId, input.user, input.text)
        if (gate && !gate.allow) {
          record.result = gate.reason
          return record.result
        }
        const scoring = viewerScore(this.behaviorOf(session, now), config.interaction?.viewerScore)
        if (scoring.muted) {
          record.result = 'muted'
          return record.result
        }
        const fixed = groupReply.fixedText
          ? parseLiveIntent(
              JSON.stringify({ action: 'greeting', reply: groupReply.fixedText }),
              config,
              { guidedGreetings: true },
            )
          : undefined
        if (mayAct) {
          const permission = this.deps.authorizeGroupReply?.(input)
          if (!permission?.accepted) {
            record.result = permission?.reason || 'GROUP_CHANNEL_UNAVAILABLE'
            return record.result
          }
        }
        if (fixed) {
          intent = fixed
          record.rule = 'group-fixed-template'
        }
      }
      if (
        !intent &&
        !pending &&
        !guidance &&
        /^(你好|哈喽|嗨|hello|hi)[呀啊!！。\s]*$/i.test(input.text.trim()) &&
        !viewerScore(this.behaviorOf(session, now), config.interaction?.viewerScore).muted
      ) {
        const gate = this.deps.policy?.before(input.accountId, input.user, input.text)
        if (gate && !gate.allow) {
          record.result = gate.reason
          return record.result
        }
        intent = { action: 'greeting' }
        record.rule = 'cached-greeting'
      }
      if (!intent) {
        if (!input.simulated && this.deps.policy) {
          const gate = this.deps.policy.reserveModel(
            input.accountId,
            input.user,
            input.text,
            Boolean(pending),
          )
          if (!gate.allow) {
            record.result = gate.reason
            return record.result
          }
        }
        // 记分到阈值就不再回他 —— 但**只拦 AI 这条路**：取消点播、明确报编号点播
        // 这些确定性动作照旧处理（他还能撤回自己的队，也能照常点播）。
        // 顺带这也是防刷屏的成本闸门：不然刷屏的人每喊一声都要烧一次 AI 调用。
        const scoring = viewerScore(this.behaviorOf(session, now), config.interaction?.viewerScore)
        if (scoring.muted) {
          record.result = scoring.reasons.length
            ? `muted（${scoring.reasons.join('，')}）`
            : 'muted'
          return record.result
        }
        const viewerStatus = this.deps.status?.(input.user) ?? {}
        const scriptConfig =
          this.deps.config.interaction?.interactionScript ?? defaultInteractionScript()
        const stepName = (viewerStatus as { step?: string }).step ?? ''
        const stepScript = scriptConfig.enabled ? scriptForStep(scriptConfig, stepName) : undefined
        /**
         * 预瞄 → 瞄准 → 字数预算，全部走 `planSpeech` 这一个出口。
         *
         * 以前这里、路由决策、进房问候三处各算各的 `aimWindow`，
         * 参数一旦不一致就会出现「提示词说能说 13 个字、真去合成时又没窗口」，
         * 而且永远查不出是哪一处不一致。现在读的是同一份结果。
         */
        const plan = planSpeech(
          this.deps.leadSeconds?.() ?? scriptConfig.leadSeconds,
          this.deps.durationModel?.(),
        )
        const speechRule = (() => {
          if (!scriptConfig.enabled) return '互动话术已关闭。这条只发文字。'
          if (!stepScript)
            return `当前步骤「${stepName || '未知'}」没有配互动话术。这条只发文字，语音不会播。`
          if (!plan.ok) return `${plan.detail}。这条只发文字，语音不会播。`
          return (
            `语音窗口：还有 ${plan.inSeconds.toFixed(1)} 秒开始，能占用 ` +
            `${plan.duration.toFixed(2)} 秒 —— **请把这句话控制在 ${plan.maxChars} 个字以内（含标点）**。` +
            (plan.minChars
              ? `完整原句替换建议${plan.minChars}到${plan.maxChars}字，贴近原句时长但不说废话；明显太短会保留原讲解，等待更匹配的窗口或转文字。`
              : '') +
            '保持完整语义；实际时长合成后测量，过长会适度变速或等待后续窗口，最终可转文字。无需为了填满窗口说废话。'
          )
        })()
        /** 这一步该引导什么：步骤决定引导内容，窗口决定说多长。 */
        const scriptRule = stepScript ? describeScript(stepScript) : ''
        const prompt = JSON.stringify({
          audienceContext: this.deps.audienceContext?.(input),
          responseGuidance: guidance,
          groupAttributes: groupReply?.attributes,
          includeNickname: groupReply?.includeNickname,
          policy: config.aiPolicy,
          // 协议说明由能力表生成，不再手写（见 shared/directorIntent.ts）
          rules: describeCapabilities({
            guidedGreetings: Boolean(guidance),
          }),
          catalog,
          activeTrayId,
          // 我们最后问了他什么、问的是哪一件。他说"是/不是/对/不要"时，
          // 指的就是这里 —— 没有这块，AI 只能看见一个孤零零的"是"，
          // 不知道在确认什么，对话就成了鸡同鸭讲。
          asking: pending
            ? {
                said: pending.said ?? '',
                trayId: pending.trayId,
                productId: pending.productId ?? '',
                productName: pending.productId
                  ? (productOf({
                      trayId: pending.trayId,
                      productId: pending.productId,
                    })?.name ?? '')
                  : '',
                mode: pending.mode ?? null,
                expiresInSeconds: Math.max(0, Math.round((pending.expires - now) / 1000)),
              }
            : null,
          // 引擎的真实状态：他排了什么队、现在在播什么，里面也带着预瞄到的插入点。
          // 有了这个，AI 才判得准"不用了""我刚才点的那个"这类靠上下文的话。
          ...viewerStatus,
          // 他这场直播里的行为：说得多不多、复读了几回、已经忽略过几次、现在多少分。
          // AI 靠这个判断"这人是来买东西的还是在刷屏"—— 而不是靠总纲里的死规矩。
          viewer: this.describeViewer(session, now, config),
          // 平台固定说法（小红书「求讲解N号商品」这类正则）命中了什么。
          // 只是把"这句话是平台生成的、里面那个 N 是多少"告诉 AI，
          // **不替它决定播什么** —— N 是直播间序号，处理方式在总纲的规则一/二/三里。
          platformHits: matchPlatformKeywords(input.text, config.interaction?.xiaohongshuKeywords),
          recent: this.turns.get(key) || [],
          conversationLimits: this.deps.policy?.snapshot(input.accountId, input.user),
          // 这一步该引导什么（按步骤配，含优先级顺序）。
          scriptRule,
          // 硬约束：这句回复要说多长，才塞得进预瞄到的那个窗口。
          speechRule,
          replacement: plan.ok
            ? {
                originalSentence: plan.originalText,
                material: plan.context,
                instruction:
                  '仅替换已审核的整句。与当前商品和讲解上下文衔接，不能丢失正在回应的观众问题；不要重复原句或照念素材标注。',
              }
            : undefined,
          comment: input.text,
        })
        const providerStarted = Date.now()
        providerPending = true
        const response = await this.interpret(prompt)
        providerPending = false
        let copyRepairUsed = false
        const repairReply = async (
          action: string,
          reply: string,
          minChars: number,
          maxChars: number,
        ) => {
          copyRepairUsed = true
          const copyRepair = {
            action,
            reply,
            minChars,
            maxChars,
            instruction:
              '保持同一个action和原问题，只重写reply。含标点严格满足字数区间，保持自然完整；短窗只保留一个欢迎或留言引导重点，不照抄长模板，不编造商品信息或已完成动作。',
          }
          providerPending = true
          const repaired = await this.interpret(
            JSON.stringify({
              task: `你是完整短句编辑。本次唯一任务是将reply改为${minChars}至${maxChars}字（包括标点），超出就无法播放。不要重新判断action，不要求同时完成欢迎、介绍、提问等多个目标。只输出包含原action及reply的JSON。`,
              copyRepair,
              comment: input.text,
              rules:
                '问候中禁止阿拉伯数字、链接、商品事实、优惠功效、已完成动作和内部积分。邀请报编号时不要举具体数字或颜色编号配对。必须保持完整自然语义。',
              context: {
                policy: config.aiPolicy,
                catalog,
                activeTrayId,
                responseGuidance: guidance,
              },
            }),
            15000 - (Date.now() - providerStarted),
          )
          providerPending = false
          const next = parseLiveIntent(repaired, config, { guidedGreetings: true })
          if (
            next.action !== action ||
            !('reply' in next) ||
            typeof next.reply !== 'string' ||
            !next.reply.trim()
          )
            throw new Error('Reply repair must return a complete reply for the same action')
          return next
        }
        try {
          intent = parseLiveIntent(response, config, {
            guidedGreetings: Boolean(guidance),
          })
        } catch (error) {
          // Never reinterpret rejected actions or fact answers. Only a strictly shaped,
          // guided greeting may receive one fresh rewrite before any action or send.
          let rejected: unknown
          try {
            rejected = JSON.parse(response)
          } catch {}
          if (
            !this.active() ||
            !guidance ||
            !rejected ||
            typeof rejected !== 'object' ||
            Array.isArray(rejected)
          )
            throw error
          const value = rejected as Record<string, unknown>
          if (
            value.action !== 'greeting' ||
            typeof value.reply !== 'string' ||
            Object.keys(value).some(key => key !== 'action' && key !== 'reply')
          )
            throw error
          rejectedGeneratedGreeting = true
          const next = await repairReply(
            'greeting',
            value.reply,
            plan.ok ? (plan.minChars ?? 2) : 2,
            plan.ok ? plan.maxChars : 120,
          )
          if (next.action !== 'greeting') throw error
          intent = next
          rejectedGeneratedGreeting = false
        }
        if (
          !copyRepairUsed &&
          plan.ok &&
          this.active() &&
          guidance &&
          this.deps.replyChannels?.(input, intent)?.voice !== false &&
          (intent.action === 'greeting' || intent.action === 'acknowledge') &&
          intent.reply
        ) {
          const count = [...intent.reply].length
          if (count > plan.maxChars || (plan.minChars && count < plan.minChars)) {
            // One fresh complete rewrite, never a hard cut. Saved fact answers and
            // deterministic actions are deliberately excluded from this repair.
            // Malformed rewrite cannot discard the already valid original reply.
            try {
              const next = await repairReply(
                intent.action,
                intent.reply,
                plan.minChars ?? 2,
                plan.maxChars,
              )
              if (next.action === intent.action) intent = next
            } catch (error) {
              if (providerPending) throw error
            }
          }
        }
      }
      if (!this.active()) {
        record.result = 'cancelled'
        return record.result
      }
      const explicitTray = namedTrays.length === 1 ? namedTrays[0] : undefined
      if (intent.action === 'request_demo' && namedTrays.length > 1)
        intent = { action: 'ask_clarification', mode: intent.mode }
      if (intent.action === 'request_demo' && explicitTray && intent.trayId !== explicitTray.id)
        intent = { action: 'ask_clarification', mode: intent.mode }
      if (
        (intent.action === 'answer' || intent.action === 'answer_tray') &&
        ((!explicitTray && namedTrays.length > 1) ||
          (explicitTray && intent.trayId !== explicitTray.id))
      )
        intent = { action: 'unknown' }
      if (intent.action === 'request_demo' && !explicitTray) {
        const productId = intent.productId
        if (/另一|其他|别的|another|other/i.test(input.text))
          intent = { action: 'ask_clarification', mode: intent.mode }
        else if (
          config.trays.find(t => t.id === activeTrayId)?.products.some(p => p.id === productId)
        )
          intent = { ...intent, trayId: activeTrayId }
      }
      if (intent.action === 'answer' && !explicitTray) {
        const productId = intent.productId
        if (
          config.trays.find(t => t.id === activeTrayId)?.products.some(p => p.id === productId) &&
          intent.trayId !== activeTrayId
        )
          intent = { action: 'unknown' }
      }
      if (
        intent.action === 'request_demo' &&
        activeTrayId !== (this.deps.activeTrayId?.() || activeTrayId) &&
        !config.trays.some(
          t =>
            t.id === (intent as Extract<LiveIntent, { action: 'request_demo' }>).trayId &&
            (input.text.includes(t.name) || input.text.includes(t.id)),
        )
      )
        intent = { action: 'ask_clarification', mode: intent.mode }
      record.intent = intent
      if (
        !explicitTray &&
        initialPlayback !== playbackIdentity() &&
        ['answer', 'answer_tray', 'request_demo', 'ask_mode'].includes(intent.action)
      ) {
        intent = {
          action: 'ask_clarification',
          mode: 'mode' in intent && intent.mode ? intent.mode : 'B',
        }
        record.intent = intent
      }
      if (!this.turns.has(key) && this.turns.size >= 500)
        this.turns.delete(this.turns.keys().next().value ?? '')
      // 对话要两边都留着：只记观众说了什么，AI 就不知道自己上一句问的是什么，
      // 他说"是/不是"时根本没法对应。我们回的原话在下面 reply 定稿后补进去。
      this.turns.set(key, [...(this.turns.get(key) || []), `观众：${input.text}`].slice(-10))
      if (mayAct) this.deps.memory?.append(input.accountId, input.user, [`观众：${input.text}`])
      let reply = ''
      if (intent.action === 'ask_clarification') {
        record.result = 'clarification'
        reply = '你想看哪个托盘的哪一款？请告诉我托盘和商品编号或名称。'
        if (this.pending.size >= 500) this.pending.delete(this.pending.keys().next().value ?? '')
        this.pending.set(key, {
          mode: intent.mode,
          trayId: this.deps.activeTrayId?.() || activeTrayId,
          expires: (this.deps.now || Date.now)() + 60000,
          said: reply,
        })
      } else if (intent.action === 'ask_mode') {
        const product = productOf(intent)
        const name = `${intent.productId} ${product?.name || ''}`.trim()
        record.result = 'ask-mode'
        reply = `${name}：想看讲解展示，还是看上头试戴？回我"展示"或"上头"就行。`
        if (this.pending.size >= 500) this.pending.delete(this.pending.keys().next().value ?? '')
        this.pending.set(key, {
          trayId: intent.trayId,
          productId: intent.productId,
          expires: (this.deps.now || Date.now)() + 60000,
          said: reply,
        })
      } else if (intent.action === 'cancel_demo') {
        if (!mayAct) {
          record.result = 'observe-only'
          return record.result
        }
        const result = cancelResult ??
          this.deps.cancel?.(intent.trayId, intent.productId, intent.mode, input.user) ?? {
            cancelled: 0,
            message: '',
          }
        if (result.cancelled) {
          record.result = 'cancelled-demo'
          reply = result.message
        } else {
          record.result = 'nothing-to-cancel'
          reply = directorStatusReply(this.deps.status?.(input.user))
        }
      } else if (intent.action === 'request_demo') {
        this.pending.delete(key)
        if (!mayAct) record.result = 'observe-only'
        else {
          const result = this.deps.accept(
            intent.trayId,
            intent.productId,
            intent.mode,
            input.user,
            input.routingContext?.trace,
          )
          record.result = result.code
          reply = result.message
        }
      } else if (intent.action === 'answer' || intent.action === 'answer_tray') {
        record.result = 'answered'
        reply = intent.fact.trim()
      } else if (intent.action === 'greeting') {
        // 必须真的说话。以前没有这个动作，观众问好只能被忽略 —— 人当场就走了。
        record.result = 'greeting'
        reply =
          intent.reply?.trim() ||
          config.interaction?.greetingReply?.trim() ||
          DEFAULT_GREETING_REPLY
      } else if (intent.action === 'acknowledge') {
        record.result = 'answered-acknowledgement'
        reply = intent.reply.trim()
      } else if (intent.action === 'status') {
        record.result = 'answered-status'
        reply = directorStatusReply(this.deps.status?.(input.user))
      } else if (intent.action === 'off_topic') {
        const response = mayAct
          ? this.deps.policy?.classified(input.accountId, input.user, 'off_topic')
          : undefined
        reply = response?.reply || ''
        record.result = response ? `off-topic-${response.kind}` : 'off-topic-observed'
      } else if (intent.action === 'unknown') {
        record.result = 'unknown'
        reply = '这项商品信息我暂时无法确认。'
      } else record.result = 'ignored'
      // 把"我们回了什么"也记进对话历史 —— 下一轮 AI 才看得到自己上一句问的是什么，
      // 观众回"是/不是"时才能对应上（以前只记观众那半边，等于让 AI 闭着一只眼看对话）。
      if (reply && !this.deps.memory)
        this.turns.set(
          key,
          [...(this.turns.get(key) || []), `我们（${intent.action}）：${reply}`].slice(-10),
        )
      // 把准备说出口的原话留在记录里：发不发送是另一回事，
      // 至少界面上能直接看到 AI 打算回什么，不用去猜 result 代号。
      //
      // 平台评论框不支持换行（Enter 就是发送键），多行文本可能只发出去第一行 —— 先压成一行。
      // 开头艾特观众，让大家看得出这条是回给谁的。艾特也算进字数里。
      // 注意这里不能 trim：模板末尾的空格是"@昵称 "和正文之间的分隔，删了就成了"@昵称正文"。
      const mention = (
        groupReply?.includeNickname === false || groupReply?.fixedText
          ? ''
          : resolveMention(config.interaction?.mentionTemplate, input.name)
      ).replace(/\s*\n+\s*/g, ' ')
      // 注意：交给拆条器的是**没压平**的原文。换行是最强的断点，
      // 先压平就只能从行中间劈（真实日志里"浅色系（003 米黄"被劈成了两半）。
      const raw = reply ? `${mention}${reply}` : ''
      const singleLine = flattenReply(raw)
      // 平台有字数上限，一次说不完就分两条发；拆不动（太长）才拦下不发。
      const parts = splitReply(raw)
      record.reply = singleLine
      if (singleLine)
        this.event(input, { kind: 'reply.generated', text: singleLine, detail: intent.action })
      const channels = this.deps.replyChannels?.(input, intent) || { text: true, voice: true }
      if (groupReply && this.deps.groupReplyCurrent?.(input) === false) {
        record.result = 'GROUP_PREVIEW_STALE'
        return record.result
      }
      // Prepare voice concurrently with text delivery; its context guard is captured now.
      if (reply && mayAct && this.active() && channels.voice)
        this.deps.onReply?.(reply, input, intent)
      if (singleLine && !parts.length) {
        record.result = 'too-long'
        return record.result
      }
      if (
        parts.length &&
        channels.text &&
        this.active() &&
        !input.simulated &&
        this.deps.config.interaction?.observeOnly === false &&
        this.deps.config.interaction.publicReply
      ) {
        let failed = false
        for (const part of parts) {
          if (groupReply && this.deps.groupReplyCurrent?.(input) === false) {
            record.result = 'GROUP_PREVIEW_STALE'
            return record.result
          }
          let sent: boolean
          try {
            sent = await this.deps.send(part, this.controller.signal)
          } catch {
            this.event(input, {
              kind: 'text.failed',
              text: part,
              detail: 'send threw or was cancelled',
            })
            throw new Error('send failed')
          }
          this.event(input, { kind: sent ? 'text.sent' : 'text.failed', text: part })
          if (!this.active()) break
          if (!sent) {
            failed = true
            break
          }
        }
        if (failed) record.result += ': send failed'
        else if (parts.length > 1) record.result += `（分 ${parts.length} 条）`
        if (!failed && this.active() && this.deps.memory)
          this.deps.memory.append(input.accountId, input.user, [
            `我们（${intent.action}）：${reply}`,
          ])
      }
      return record.result
    } catch {
      if (groupReply && this.deps.groupReplyCurrent?.(input) === false) {
        record.result = 'GROUP_PREVIEW_STALE'
        return record.result
      }
      // Provider errors may contain credentials or raw request data.
      record.result = this.active()
        ? record.result === 'accepted'
          ? 'accepted: send failed'
          : 'error: interpretation/send failed'
        : 'cancelled'
      // Only pre-action provider failure or a twice-rejected guided greeting gets this
      // acknowledgement. Other invalid intents fail closed; uncertain sends never retry.
      if (
        (providerPending || rejectedGeneratedGreeting) &&
        mayAct &&
        this.active() &&
        this.deps.config.interaction?.publicReply
      ) {
        const channels = this.deps.replyChannels?.(input, { action: 'unknown' }) ?? {
          text: true,
          voice: true,
        }
        if (channels.text || channels.voice) {
          const mention =
            groupReply?.includeNickname === false
              ? ''
              : resolveMention(config.interaction?.mentionTemplate, input.name)
          record.reply = flattenReply(
            `${mention}这条问题暂时没能处理，请再发一次想看的颜色或编号。`,
          )
          const acknowledgement = rejectedGeneratedGreeting
            ? 'rejected greeting acknowledgement'
            : 'provider failure acknowledgement'
          this.event(input, {
            kind: 'reply.generated',
            text: record.reply,
            detail: acknowledgement,
          })
          const delivery = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)])
          let abort!: () => void
          const cancelled = new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('acknowledgement cancelled'))
            if (delivery.aborted) abort()
            else delivery.addEventListener('abort', abort, { once: true })
          })
          let sent = false
          try {
            sent = await Promise.race([this.deps.send(record.reply, delivery), cancelled])
          } catch {
          } finally {
            delivery.removeEventListener('abort', abort)
          }
          this.event(input, {
            kind: sent && this.active() ? 'text.sent' : 'text.failed',
            text: record.reply,
            detail: acknowledgement,
          })
          if (!this.active()) record.result = 'cancelled'
        }
      }
      return record.result
    } finally {
      this.event(input, { kind: 'reply.result', text: record.reply, detail: record.result })
    }
  }
}
