import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { ctaOverlayFileName, renderCtaOverlay } from '../../../shared/ctaOverlay'
import type {
  DirectorConfig,
  DirectorCue,
  DirectorProduct,
  DirectorStep,
  DirectorTransitionConfig,
  DirectorTray,
} from '../../../shared/director'
import {
  directorStepAudioFiles,
  directorStepCues,
  directorStepOverlayVariants,
  directorStepPlaybackChoice,
  isDirectorVideoStep,
} from '../../../shared/director'
import { isReviewedSpeechWindow, narrationSegments, speechWindowEntryStart, speechWindowMissed,MAX_SENTENCE_PADDING_SECONDS, type SpeechWindow } from '../../../shared/directorNarration'
import { validateSpeechMaterials } from './DirectorSpeechAnalysis'
import type { SpeechBudgetLedger } from '../../../shared/speechBudget'
import { speechWindows } from './SpeechWindows'
import { DirectorDefocusTransition, requireDirectorDefocus } from './DirectorDefocusTransition'
import type { DiagnosticContext, DirectorDiagnostics } from './DirectorDiagnostics'
import type { DirectorOutput } from './DirectorEngine'
import { DirectorMedia } from './DirectorMedia'
import type { DirectorSpeechQueue, ReadySpeech } from './DirectorSpeechQueue'
import { waitForPausedStream, waitForSpeechPlayback } from './StreamingPlayback'
import {OBS_STREAM_RESERVE_SECONDS} from '../../../shared/speechPlayback'
import {sentencePaddingAllowance} from '../../../shared/directorNarration'
import { ObsWebSocketClient } from './ObsWebSocketClient'

export function selectObsTextKind(inputKinds: string[]) {
  const versioned = inputKinds
    .filter(kind => /^text_gdiplus_v\d+$/.test(kind))
    .sort((a, b) => Number(b.match(/\d+$/)?.[0]) - Number(a.match(/\d+$/)?.[0]))
  return versioned[0] || inputKinds.find(kind => kind === 'text_gdiplus') || ''
}

export function selectObsColorKind(inputKinds: string[]) {
  const versioned = inputKinds
    .filter(kind => /^color_source_v\d+$/.test(kind))
    .sort((a, b) => Number(b.match(/\d+$/)?.[0]) - Number(a.match(/\d+$/)?.[0]))
  return versioned[0] || inputKinds.find(kind => kind === 'color_source') || ''
}

export function isObsMediaInputKind(value: unknown) {
  return (
    typeof value === 'string' &&
    ['ffmpeg_source', 'vlc_source', 'slideshow', 'slideshow_v2'].includes(value)
  )
}

export function obsMediaLoopSettings(inputKind: unknown): Record<string, boolean> | undefined {
  if (inputKind === 'ffmpeg_source') return { looping: true }
  if (inputKind === 'vlc_source') return { loop: true }
  return undefined
}

export function continuousVideoRuns(steps: DirectorStep[], disabled = new Set<string>()) {
  const runs: DirectorStep[][] = []
  let run: DirectorStep[] = []
  const flush = () => {
    if (run.length > 1) runs.push(run)
    run = []
  }
  for (const step of steps) {
    const previous = run.at(-1)
    const continuous =
      previous !== undefined &&
      isDirectorVideoStep(previous) &&
      isDirectorVideoStep(step) &&
      previous.file === step.file &&
      previous.end > 0 &&
      Math.abs(previous.end - step.start) < 0.05 &&
      !disabled.has(previous.id) &&
      !disabled.has(step.id)
    if (!previous || continuous) run.push(step)
    else {
      flush()
      run.push(step)
    }
  }
  flush()
  return runs
}

type VideoKey = 'video' | 'video-next'
type SpeechSlot = {
  key: VideoKey
  endMs: number
  generation: number
  /** 这一步的画面秒数；用来算「配音比画面短多少」，攒进额度池。 */
  videoSeconds?: number
}
const VIDEO_KEYS: VideoKey[] = ['video', 'video-next']

/**
 * 虚拟声卡那一路从「启用」到真的开始抓设备要多久。
 *
 * 实测 0ms / 200ms / 500ms **都能正常出声**（−24.0 / −27.2 / −26.8 dB），
 * 所以默认 0 —— 这个数直接吃提前量，没必要白等。
 * 留个环境变量是为了以后遇到不同机器时能调。
 */
const CABLE_SPINUP_MS = Number(process.env.OBA_CABLE_SPINUP_MS ?? 0)
type SequenceSegment = {
  sequenceId: string
  file: string
  startMs: number
  endMs: number
  last: boolean
}

export class DirectorObsOutput implements DirectorOutput {
  private client: ObsWebSocketClient
  private config!: DirectorConfig
  private media!: DirectorMedia
  private inputs = new Map<string, number>()
  private compiled = new Map<
    string,
    Array<{ file: string; duration: number; held?: boolean; audio?: string }>
  >()
  private normalized = new Map<string, { file: string; duration: number }>()
  private variants = new Map<string, number>()
  private width = 1080
  private height = 1920
  private ready = false
  private lastTray?: DirectorTray
  private disabledSteps = new Set<string>()
  private heldSteps = new Set<string>()
  private noticeTimer?: ReturnType<typeof setTimeout>
  private textKind = ''
  private colorKind = ''
  private opacityKind = ''
  private opacityScale = 1
  private defocus?: DirectorDefocusTransition
  private phaseTransitionActive = false
  /** 阶段转场时切换点的叠化时长；0 表示沿用普通片段淡化的时长。 */
  private phaseFadeMs = 0
  private activeVideo?: VideoKey
  private videoGeneration = new Map<VideoKey, number>()
  private validSpeechSlot(slot: SpeechSlot) {
    return (
      this.activeVideo === slot.key && (this.videoGeneration.get(slot.key) || 0) === slot.generation
    )
  }
  /** 每一路当前装着哪个文件 —— 和音频那套一样，用来判断要不要显式重播。 */
  private videoFile = new Map<VideoKey, string>()
  private sequences = new Map<string, SequenceSegment>()
  private overlayGroups = new Map<string, number>()
  private stateGroups = new Map<string, number>()
  private activeStateGroup = ''
  private activeStepGroup = ''
  /** 引导层当前挂的是哪张网页（换托盘要换页）。 */
  private activeCtaUrl = ''
  private lastOverlaySelection = new Map<string, number>()
  private activeSequence?: { id: string; key: VideoKey }
  private lastStep?: DirectorStep
  /** 最近一次进入的商品；回到总览时用它取「回程」转场设置。 */
  private lastProduct?: DirectorProduct
  /**
   * 刚换了商品。队列优先时不回总览、直接 B 接 B，这时没有 A 阶段帮忙兜转场，
   * 所以要显式给下一个步骤补一次 —— 换商品就是换画面，不能硬切。
   */
  private productBoundary = false
  private narrationQueue: Promise<void> = Promise.resolve()
  private narrationFailure?: unknown
  private audioFile?: string
  private speechFile?: string
  /** 虚拟声卡那一路建起来了没有。建不起来就退回媒体源。 */
  private cableReady = false
  private displayMode: 'none' | 'A' | 'content' | 'transition' = 'none'
  /**
   * 屏幕上这幅画面属于哪个阶段。
   *
   * displayMode 只分得清「总览 / 商品内 / 转场片」三种，A 阶段播到一半被点播
   * 打断时它停在 'content'，和「商品内部的 B 步骤之间」长得一模一样。结果那次
   * 跨阶段切换被当成普通换片段硬切掉了。单独记一个阶段标记来区分这两件事。
   */
  private displayPhase: 'none' | 'A' | 'B' | 'C' | 'transition' = 'none'
  constructor(
    private connection: { url: string; password: string },
    private cache: string,
    private log: (s: string) => void,
    private diagnostics?: DirectorDiagnostics,
    private speech?: DirectorSpeechQueue,
    /** 阶段额度账本：这一步省下的时间能垫给后面超出的插话。 */
    private ledger?: SpeechBudgetLedger,
    /** OBS 里 `CABLE Output` 采集源的 device_id；没有就不走虚拟声卡。 */
    private cableDevice?: string,
    /** 虚拟声卡播放服务；给了才可能走那条路。 */
    private cable?: {
      play(
        path: string,
      ): Promise<{ ok: boolean; openMs?: number; duration?: number; error?: string }>
      stop(): Promise<void>
      /**
       * 预热：把播放服务拉起来并等到它就绪。
       *
       * **必须在导播启动时预热。** 第一次播要现拉起 Python，实测要几秒；
       * 如果留到出声那一刻才拉，这几秒会花在**气口里** —— 语音直接被判装不下，
       * 观众什么都听不到。放在启动阶段，这段开销是看不见的。
       */
      ensureReady?(): Promise<boolean>
    },
  ) {
    this.client = new ObsWebSocketClient(diagnostics)
    // 窗口和余额是同一个问题的两面，接上账本让窗口主人能回答「还能超多少秒」。
    speechWindows.useLedger(ledger)
  }
  private diagnosticScope<T>(context: DiagnosticContext, action: () => T) {
    return this.diagnostics ? this.diagnostics.scope(context, action) : action()
  }
  private name(key: string) {
    return `OBA-Director:${this.config.scene}:${key}`
  }
  private async visible(key: string, enabled: boolean) {
    const id = this.inputs.get(key)
    if (id !== undefined)
      await this.client.call('SetSceneItemEnabled', {
        sceneName: this.config.scene,
        sceneItemId: id,
        sceneItemEnabled: enabled,
      })
  }
  private async settings(key: string, settings: Record<string, unknown>) {
    await this.client.call('SetInputSettings', {
      inputName: this.name(key),
      inputSettings: settings,
      overlay: true,
    })
  }
  private filterName(key: string) {
    return `${this.name(key)}:crossfade`
  }
  private async ensureOpacityFilter(key: string) {
    if (!this.opacityKind) return
    const sourceName = this.name(key)
    const filters = await this.client.call('GetSourceFilterList', { sourceName })
    const exists = (filters.filters as Array<{ filterName: string }>).some(
      filter => filter.filterName === this.filterName(key),
    )
    if (!exists)
      await this.client.call('CreateSourceFilter', {
        sourceName,
        filterName: this.filterName(key),
        filterKind: this.opacityKind,
        filterSettings: { opacity: this.opacityScale },
      })
  }
  private async opacity(key: string, value: number) {
    if (!this.opacityKind) return
    await this.client.call('SetSourceFilterSettings', {
      sourceName: this.name(key),
      filterName: this.filterName(key),
      filterSettings: { opacity: Math.max(0, Math.min(1, value)) * this.opacityScale },
      overlay: true,
    })
  }
  private async animateOpacity(
    key: string,
    from: number,
    to: number,
    durationMs: number,
    signal: AbortSignal,
  ) {
    const frames = Math.max(2, Math.ceil(durationMs / 20))
    for (let frame = 1; frame <= frames; frame++) {
      const progress = frame / frames
      await this.opacity(key, from + (to - from) * progress)
      if (frame < frames) await delay(durationMs / frames, undefined, { signal })
    }
  }
  /**
   * 逐级解析实际生效的转场参数：
   *   商品级（in/out） → 全局回程（仅回总览时） → 全局主设置 → 旧版 300ms 黑场。
   * 这样单个商品可以有自己的手感，没写的字段自动往下回落。
   */
  private resolveTransition(
    target?: 'A' | 'B' | 'C',
    product?: DirectorProduct,
  ): DirectorTransitionConfig {
    const base: DirectorTransitionConfig = this.config.transition ?? {
      mode: 'blink',
      durationMs: 300,
      strength: 10,
    }
    const back = target === 'A' ? (base.back ?? {}) : {}
    const head =
      target === 'A' ? (this.lastProduct ?? product)?.transition?.out : product?.transition?.in
    return {
      mode: head?.mode ?? back.mode ?? base.mode,
      durationMs: head?.durationMs ?? back.durationMs ?? base.durationMs,
      strength: head?.strength ?? back.strength ?? base.strength,
    }
  }

  /**
   * 标记「切换点应当交叉叠化」，并保证标记一定被清掉。
   *
   * 硬切会让两幅画面的平均亮度直接跳变，观感上就是「闪白」，
   * 所以阶段转场也走 playVideo 的渐变路径，而不是一步把新画面顶上来。
   */
  private async phaseTransition<T>(fadeMs: number, run: () => Promise<T>): Promise<T> {
    this.phaseTransitionActive = true
    this.phaseFadeMs = fadeMs
    try {
      return await run()
    } finally {
      this.phaseTransitionActive = false
      this.phaseFadeMs = 0
    }
  }

  private async phaseSwitch<T>(
    action: () => Promise<T>,
    signal: AbortSignal,
    target?: 'A' | 'B' | 'C',
    product?: DirectorProduct,
  ) {
    const transition = this.resolveTransition(target, product)
    if (transition.mode === 'none' || transition.durationMs === 0) return action()
    // dissolve 与 defocus 都靠 playVideo 在切换点做交叉叠化，区别只是要不要模糊。
    if (transition.mode === 'dissolve')
      return await this.phaseTransition(transition.durationMs, action)
    // defocus 与 hunt 都靠 Composite Blur；只是曲线不同
    if (transition.mode === 'defocus' || transition.mode === 'hunt') {
      const defocus = this.defocus
      if (!defocus) throw new Error('失焦滤镜尚未准备完成')
      // 拉风箱的 durationMs 是整段犹豫过程的长度，叠化只占一小截；
      // 对称失焦本来就是「糊上去 + 对回来」，叠化用满整个时长。
      const fadeMs =
        transition.mode === 'hunt'
          ? Math.min(300, Math.max(100, Math.round(transition.durationMs * 0.22)))
          : transition.durationMs
      return await this.phaseTransition(fadeMs, () => defocus.run(action, transition, signal))
    }
    if (!this.colorKind || !this.opacityKind) return action()
    const key = 'transition-cover'
    const durationMs = transition.durationMs
    await this.opacity(key, 0)
    await this.visible(key, true)
    try {
      await this.animateOpacity(key, 0, 1, durationMs * 0.4, signal)
      const result = await action()
      await this.animateOpacity(key, 1, 0, durationMs * 0.6, signal)
      return result
    } finally {
      await this.visible(key, false)
    }
  }
  private async waitVirtualCamera(active: boolean, signal: AbortSignal) {
    const started = Date.now()
    while (Date.now() - started < 5000) {
      const state = await this.client.call('GetVirtualCamStatus')
      if (Boolean(state.outputActive) === active) return
      await delay(100, undefined, { signal })
    }
    throw new Error(`OBS 虚拟摄像头未能${active ? '启动' : '停止'}`)
  }
  private async source(
    key: string,
    kind: string,
    settings: Record<string, unknown>,
    x = 0,
    y = 0,
    full = false,
  ) {
    const result = await this.client.call('GetInputList')
    const existing = (result.inputs as Array<{ inputName: string; inputKind: string }>).find(
      i => i.inputName === this.name(key),
    )
    if (existing) {
      if (existing.inputKind !== kind) throw new Error(`来源 ${this.name(key)} 类型不匹配`)
      const item = await this.client.call('GetSceneItemId', {
        sceneName: this.config.scene,
        sourceName: this.name(key),
      })
      this.inputs.set(key, Number(item.sceneItemId))
      await this.settings(key, settings)
    } else {
      const item = await this.client.call('CreateInput', {
        sceneName: this.config.scene,
        inputName: this.name(key),
        inputKind: kind,
        inputSettings: settings,
        sceneItemEnabled: false,
      })
      this.inputs.set(key, Number(item.sceneItemId))
    }
    await this.visible(key, false)
    await this.client.call('SetSceneItemTransform', {
      sceneName: this.config.scene,
      sceneItemId: this.inputs.get(key),
      sceneItemTransform: {
        positionX: x,
        positionY: y,
        alignment: 5,
        ...(full
          ? {
              boundsType: 'OBS_BOUNDS_SCALE_INNER',
              boundsWidth: this.width,
              boundsHeight: this.height,
              boundsAlignment: 0,
            }
          : {}),
      },
    })
  }
  private async compileContinuousRuns(steps: DirectorStep[], signal: AbortSignal) {
    const excluded = new Set([...this.disabledSteps, ...this.heldSteps])
    for (const stepsInRun of continuousVideoRuns(steps, excluded)) {
      const first = stepsInRun[0]
      const last = stepsInRun.at(-1)!
      const sequenceId = `sequence:${stepsInRun.map(step => step.id).join(':')}`
      this.log(`正在合并 ${stepsInRun.length} 个连续切片，消除片段接缝…`)
      const sequence = await this.media.compile(
        {
          ...first,
          id: sequenceId,
          name: `${first.name} 等连续片段`,
          end: last.end,
          audio: [],
        },
        undefined,
        signal,
      )
      let cursor = 0
      for (let index = 0; index < stepsInRun.length; index++) {
        const step = stepsInRun[index]
        const duration = this.compiled.get(step.id)?.[0]?.duration
        if (!duration) throw new Error(`${step.name}：无法读取连续切片时长`)
        const startMs = Math.round(cursor * 1000)
        cursor += duration
        this.sequences.set(step.id, {
          sequenceId,
          file: sequence.file,
          startMs,
          endMs: Math.round(cursor * 1000),
          last: index === stepsInRun.length - 1,
        })
      }
    }
  }
  private async runCues(
    step: DirectorStep,
    signal: AbortSignal,
    onCue?: (cue: DirectorCue) => Promise<void>,
  ) {
    if (!onCue) return
    const started = Date.now()
    for (const cue of directorStepCues(step)) {
      const remaining = cue.at * 1000 - (Date.now() - started)
      if (remaining > 0) await delay(remaining, undefined, { signal })
      await onCue(cue)
    }
  }
  private async prepareOverlayGroups(config: DirectorConfig) {
    this.overlayGroups.clear()
    const names = new Set(
      config.trays.flatMap(tray =>
        [...tray.A, ...tray.products.flatMap(product => [...product.B, ...product.C])].flatMap(
          step => directorStepOverlayVariants(step).map(variant => variant.overlayGroup.trim()),
        ),
      ),
    )
    names.delete('')
    for (const name of names) {
      let item: Record<string, unknown>
      let children: Record<string, unknown>
      try {
        item = await this.client.call('GetSceneItemId', {
          sceneName: config.scene,
          sourceName: name,
        })
        children = await this.client.call('GetGroupSceneItemList', { sceneName: name })
      } catch {
        throw new Error(`OBS 场景“${config.scene}”中未找到角标素材组“${name}”`)
      }
      const sceneItemId = Number(item.sceneItemId)
      const candidates = Array.isArray(children.sceneItems)
        ? children.sceneItems.filter(
            child =>
              child &&
              typeof child === 'object' &&
              typeof (child as Record<string, unknown>).sceneItemId === 'number' &&
              (child as Record<string, unknown>).isGroup !== true,
          )
        : []
      if (!Number.isFinite(sceneItemId) || !candidates.length)
        throw new Error(`OBS 角标素材组“${name}”中还没有图片或视频来源`)
      this.overlayGroups.set(name, sceneItemId)
      await this.client.call('SetSceneItemEnabled', {
        sceneName: config.scene,
        sceneItemId,
        sceneItemEnabled: false,
      })
    }
  }
  private async prepareStateGroups(config: DirectorConfig) {
    this.stateGroups.clear()
    const names = new Set(
      config.trays.flatMap(tray => {
        const steps = [...tray.A, ...tray.products.flatMap(product => [...product.B, ...product.C])]
        return [
          tray.stateGroup?.trim() || '',
          ...tray.products.flatMap(product => [
            product.stateGroups?.B?.trim() || '',
            product.stateGroups?.C?.trim() || '',
          ]),
          ...steps.map(step => step.stepGroup?.trim() || ''),
        ]
      }),
    )
    names.delete('')
    for (const name of names) {
      try {
        const item = await this.client.call('GetSceneItemId', {
          sceneName: config.scene,
          sourceName: name,
        })
        const sceneItemId = Number(item.sceneItemId)
        if (!Number.isFinite(sceneItemId)) throw new Error('scene item id is invalid')
        // 常驻/步骤素材既可以是 OBS「组」，也可以是普通来源（图片、嵌套场景…）。
        // 这里只要求它确实存在于导演场景里：是不是组不影响开关，而 obs-websocket
        // 压根没有创建组的请求，硬要求成组等于逼用户手工搓八个组出来。
        this.stateGroups.set(name, sceneItemId)
        await this.normalizeGroupChildren(name)
        await this.client.call('SetSceneItemEnabled', {
          sceneName: config.scene,
          sceneItemId,
          sceneItemEnabled: false,
        })
      } catch {
        throw new Error(`OBS 场景“${config.scene}”中未找到状态或步骤素材组“${name}”`)
      }
    }
  }
  /**
   * 把「组」内子来源一律设为可见。
   *
   * 组的眼睛和组内子来源的眼睛是两个独立开关：子来源自己关着的时候，
   * 把组打开也是一片空白 —— 看着像标牌丢了，其实只是里面被关了。
   * 既然显隐统一由组来管，每次启动就把子来源纠正回来。
   * 传进来的如果是普通来源或嵌套场景，没有子来源可管，静默跳过。
   */
  private async normalizeGroupChildren(name: string) {
    let children: unknown
    try {
      children = (await this.client.call('GetGroupSceneItemList', { sceneName: name })).sceneItems
    } catch {
      return
    }
    if (!Array.isArray(children)) return
    for (const child of children) {
      if (!child || typeof child !== 'object') continue
      const item = child as {
        sceneItemId?: unknown
        sceneItemEnabled?: unknown
        sourceName?: unknown
      }
      if (item.sceneItemEnabled === true) continue
      const childId = Number(item.sceneItemId)
      if (!Number.isFinite(childId)) continue
      await this.client.call('SetSceneItemEnabled', {
        sceneName: name,
        sceneItemId: childId,
        sceneItemEnabled: true,
      })
      this.log(`素材组“${name}”里的“${String(item.sourceName)}”原本是隐藏的，已设为可见`)
    }
  }
  private async syncStateGroups() {
    for (const [name, sceneItemId] of this.stateGroups)
      await this.client.call('SetSceneItemEnabled', {
        sceneName: this.config.scene,
        sceneItemId,
        sceneItemEnabled: name === this.activeStateGroup || name === this.activeStepGroup,
      })
  }
  /**
   * B/C 引导层（本地网页浏览器源）的开关与换页。
   *
   * 源是应用自己建的（`OBA-Director:场景:cta`），用户不用在 OBS 里做任何事。
   * 进 B/C 亮、回 A 灭；换托盘就换那张网页。
   *
   * 全程**不抛错**：引导层只是锦上添花，出问题记一行日志，人照常播。
   */
  private async showCta(file: string | undefined) {
    if (!this.inputs.has('cta')) return
    try {
      // **隐藏时不要清 URL**：清了浏览器源就得重新加载网页，
      // 每进一次 B/C 都会先闪一下空白。URL 留着，只切显隐。
      const url = file ? pathToFileURL(file).href : ''
      if (url && url !== this.activeCtaUrl) {
        this.activeCtaUrl = url
        await this.settings('cta', { url })
      }
      await this.visible('cta', Boolean(file))
    } catch (error) {
      this.log(`B/C 引导层没挂上：${String(error)}`)
    }
  }
  /** 这个托盘该挂哪张引导页；没启用就返回 undefined。 */
  private ctaFileFor(tray: DirectorTray | undefined) {
    if (!tray?.cta?.enabled) return undefined
    return join(this.cache, ctaOverlayFileName(tray.id))
  }
  /**
   * 把引导层的位置**对齐到 A 段那个艺术字**。
   *
   * 注意：艺术字在 OBS 里是一个**源**（不是组），比如 pos(0,210) 尺寸 1080x260 ——
   * 光把它的 transform 抄给引导源是不行的：引导源是满画布的，
   * 抄完位置对了、尺寸还不对，标牌会被居中在画面中下部。
   *
   * 所以正确的做法是：引导源保持满画布，把**艺术字的垂直中心**写进网页里，
   * 让标牌自己钉在那一条横带上。
   */
  private async ctaAnchorY(config: DirectorConfig): Promise<number | undefined> {
    const _canvasHeight = config.canvasHeight || 1920
    const group = config.trays
      .flatMap(tray => tray.A.map(step => step.stepGroup?.trim()))
      .find(name => Boolean(name))
    if (!group) return undefined
    try {
      const found = await this.client.call('GetSceneItemId', {
        sceneName: this.config.scene,
        sourceName: group,
      })
      const transform = await this.client.call('GetSceneItemTransform', {
        sceneName: this.config.scene,
        sceneItemId: Number(found.sceneItemId),
      })
      const t = transform.sceneItemTransform as Record<string, unknown>
      const top = Number(t.positionY)
      const height = Number(t.height) * Number(t.scaleY || 1)
      if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return undefined
      const anchor = Math.round(top + height / 2)
      this.log(`B/C 引导层对齐「${group}」：钉在第 ${anchor} 行`)
      return anchor
    } catch (error) {
      this.log(`B/C 引导层没能读到「${group}」的位置，先用画面中线：${String(error)}`)
      return undefined
    }
  }
  /**
   * 按当前配置（和 OBS 里艺术字的位置）重写引导页。
   *
   * 放在这里而不是保存配置时：只有启动导播这一刻才知道艺术字在哪 ——
   * 位置是 OBS 里的东西，不是配置里的。
   */
  private async writeCtaPages(config: DirectorConfig) {
    const anchorY = await this.ctaAnchorY(config)
    for (const tray of config.trays) {
      if (!tray.cta?.enabled) continue
      try {
        await writeFile(
          join(this.cache, ctaOverlayFileName(tray.id)),
          renderCtaOverlay({
            text: tray.cta.text ?? '',
            subtext: tray.cta.subtext ?? '',
            fontSize: tray.cta.fontSize,
            anchorY,
            canvasHeight: config.canvasHeight,
            canvasWidth: config.canvasWidth,
          }),
          'utf-8',
        )
      } catch (error) {
        this.log(`B/C 引导页写入失败：${String(error)}`)
      }
    }
  }
  private async hideStateGroups() {
    this.activeStateGroup = ''
    this.activeStepGroup = ''
    await this.syncStateGroups()
  }
  private async showStateGroup(name?: string) {
    const normalized = name?.trim()
    if (normalized && !this.stateGroups.has(normalized))
      throw new Error(`OBS 状态常驻组“${normalized}”不可用`)
    this.activeStateGroup = normalized || ''
    this.activeStepGroup = ''
    await this.syncStateGroups()
  }
  private async showStepGroup(name?: string) {
    const normalized = name?.trim()
    if (normalized && !this.stateGroups.has(normalized))
      throw new Error(`OBS 步骤临时组“${normalized}”不可用`)
    this.activeStepGroup = normalized || ''
    await this.syncStateGroups()
  }
  /**
   * 按掉历史遗留的全局文字源。
   *
   * label0..N 是第一代「每个 SKU 一个文字源」，title 是第二代「一个全局标题框」。
   * 现在商品名和总览引导语都交给 OBS 素材组了，这两个源都不再需要 —— 但它们还
   * 留在用户的 OBS 里，启动时顺手关掉，免得和标牌叠在同一位置上。
   */
  private async hideLegacySources(...keys: string[]) {
    const prefixes = keys.map(key => this.name(key))
    const response = await this.client.call('GetSceneItemList', { sceneName: this.config.scene })
    for (const item of Array.isArray(response.sceneItems) ? response.sceneItems : []) {
      if (!item || typeof item !== 'object') continue
      const source = item as Record<string, unknown>
      const sourceName = typeof source.sourceName === 'string' ? source.sourceName : ''
      if (
        sourceName &&
        prefixes.some(prefix => sourceName.startsWith(prefix)) &&
        typeof source.sceneItemId === 'number'
      )
        await this.client.call('SetSceneItemEnabled', {
          sceneName: this.config.scene,
          sceneItemId: source.sceneItemId,
          sceneItemEnabled: false,
        })
    }
  }
  private async hideOverlayGroups() {
    for (const sceneItemId of this.overlayGroups.values())
      await this.client.call('SetSceneItemEnabled', {
        sceneName: this.config.scene,
        sceneItemId,
        sceneItemEnabled: false,
      })
  }
  private async showOverlayGroup(step: DirectorStep, selectedGroup?: string) {
    await this.hideOverlayGroups()
    if (step.kind !== 'video-obs-group') return
    const name =
      selectedGroup === undefined ? step.overlayGroup?.trim() || '' : selectedGroup.trim()
    const groupItemId = this.overlayGroups.get(name)
    if (groupItemId === undefined) throw new Error(`OBS 角标素材组“${name}”不可用`)
    const response = await this.client.call('GetGroupSceneItemList', { sceneName: name })
    const candidates = (Array.isArray(response.sceneItems) ? response.sceneItems : [])
      .filter(item => item && typeof item === 'object')
      .map(item => item as Record<string, unknown>)
      .filter(item => typeof item.sceneItemId === 'number' && item.isGroup !== true)
    if (!candidates.length) throw new Error(`OBS 角标素材组“${name}”中还没有图片或视频来源`)
    const previous = this.lastOverlaySelection.get(name)
    const available =
      candidates.length > 1
        ? candidates.filter(item => Number(item.sceneItemId) !== previous)
        : candidates
    const selected = available[Math.floor(Math.random() * available.length)]
    for (const item of candidates)
      await this.client.call('SetSceneItemEnabled', {
        sceneName: name,
        sceneItemId: Number(item.sceneItemId),
        sceneItemEnabled: item === selected,
      })
    if (isObsMediaInputKind(selected.inputKind) && typeof selected.sourceName === 'string') {
      const loopSettings = obsMediaLoopSettings(selected.inputKind)
      if (loopSettings)
        await this.client.call('SetInputSettings', {
          inputName: selected.sourceName,
          inputSettings: loopSettings,
          overlay: true,
        })
      await this.client.call('TriggerMediaInputAction', {
        inputName: selected.sourceName,
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      })
    }
    this.lastOverlaySelection.set(name, Number(selected.sceneItemId))
    await this.client.call('SetSceneItemEnabled', {
      sceneName: this.config.scene,
      sceneItemId: groupItemId,
      sceneItemEnabled: true,
    })
  }
  private async prepareStep(
    step: DirectorStep,
    label: string,
    current: number,
    total: number,
    signal: AbortSignal,
  ) {
    try {
      if (!step.file && step.optional) {
        this.disabledSteps.add(step.id)
        return
      }
      await stat(step.file)
      await validateSpeechMaterials(step)
      if (isDirectorVideoStep(step)) {
        this.log(`正在准备素材 ${current}/${total}：${label} / ${step.name}`)
        const sourceDuration = await this.media.duration(step.file, signal)
        const visualDuration = (step.end || sourceDuration) - step.start
        if (directorStepCues(step).some(cue => cue.at > visualDuration + 0.05))
          throw new Error(`${step.name}：商品链接时间点超出视频片段`)
        const variants = []
        const audioFiles = directorStepAudioFiles(step)
        const continuousAudio = (step.audioOverflow || 'continue') === 'continue'
        const hasSilentChoice =
          continuousAudio ||
          !audioFiles.length ||
          directorStepOverlayVariants(step).some(variant => !variant.audio.length)
        const audioChoices: Array<string | undefined> = continuousAudio
          ? [undefined]
          : [...(hasSilentChoice ? [undefined] : []), ...audioFiles]
        if (continuousAudio)
          for (const audio of audioFiles) {
            const duration = await this.media.duration(audio, signal)
            narrationSegments(audio, duration, step.speechWindows || [])
          }
        for (const audio of audioChoices)
          variants.push({ ...(await this.media.compile(step, audio, signal)), audio })
        this.compiled.set(step.id, variants)
        if (variants.some(variant => variant.held)) {
          this.heldSteps.add(step.id)
          this.log(`${label} / ${step.name}：配音较长，将自动停留在视频末帧`)
        }
      } else {
        const durations = []
        for (const audio of step.audio) durations.push(await this.media.duration(audio, signal))
        const available = durations.length ? Math.min(...durations) : step.duration
        if (directorStepCues(step).some(cue => cue.at > available + 0.05))
          throw new Error(`${step.name}：商品链接时间点超出图片停留时间`)
      }
    } catch (error) {
      if (signal.aborted) throw error
      /**
       * **素材文件找不到就跳过这一步，不要让整个导播起不来。**
       *
       * 原来这里是 `if (signal.aborted || !step.optional) throw error` ——
       * 只要有一个素材文件缺失（被删了、被挪走了、盘没挂上），
       * `prepareOutput` 会在准备 109 个素材的中途抛出去，**整个导播无法启动**，
       * 哪怕缺的那个只是 C 段某一件商品的一个镜头。
       *
       * 2026-09-29 实测踩到：用户桌面上 `素材` 目录不在了，A 段一个都不缺，
       * 导播却完全起不来。正确行为是**缺哪个跳哪个并说清楚**，
       * 让其余的照常播 —— 直播中途发现某个镜头没了，不该整场停摆。
       *
       * 只对「文件不存在」放行。别的错误（编码损坏、时间点越界…）
       * 仍然是真问题，照旧抛出去，别用一个宽泛的 catch 把 bug 藏起来。
       */
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      if (!step.optional && !missing) throw error
      this.disabledSteps.add(step.id)
      this.log(
        missing
          ? `跳过「${label} / ${step.name}」：素材文件找不到 —— ${(error as Error).message}`
          : `可选步骤不可用：${step.name}，${String(error)}`,
      )
    }
  }
  async prepare(config: DirectorConfig, signal: AbortSignal) {
    return this.diagnosticScope({ phase: 'preparing' }, () => this.prepareOutput(config, signal))
  }
  private async prepareOutput(config: DirectorConfig, signal: AbortSignal) {
    this.config = config
    this.media = new DirectorMedia(config, this.cache)
    this.compiled.clear()
    this.normalized.clear()
    this.disabledSteps.clear()
    this.heldSteps.clear()
    this.sequences.clear()
    this.overlayGroups.clear()
    this.stateGroups.clear()
    this.activeStateGroup = ''
    this.activeStepGroup = ''
    this.narrationQueue = Promise.resolve()
    this.narrationFailure = undefined
    this.audioFile = undefined
    this.speechFile = undefined
    this.lastOverlaySelection.clear()
    this.variants.clear()
    this.log('正在连接 OBS WebSocket…')
    await this.client.connect(this.connection.url, this.connection.password)
    const kinds = await this.client.call('GetInputKindList', { unversioned: false })
    const inputKinds = Array.isArray(kinds.inputKinds) ? kinds.inputKinds.map(String) : []
    this.textKind = selectObsTextKind(inputKinds)
    this.colorKind = selectObsColorKind(inputKinds)
    if (!this.textKind)
      throw new Error('当前 OBS 缺少“文本（GDI+）”来源，请确认 Windows 版 OBS 安装完整')
    const filterKinds = await this.client.call('GetSourceFilterKindList')
    const availableFilters = Array.isArray(filterKinds.sourceFilterKinds)
      ? filterKinds.sourceFilterKinds.map(String)
      : []
    const needsBlur = config.transition?.mode === 'defocus' || config.transition?.mode === 'hunt'
    if (needsBlur) requireDirectorDefocus(availableFilters)
    this.opacityKind = availableFilters.includes('color_filter_v2')
      ? 'color_filter_v2'
      : availableFilters.includes('color_filter')
        ? 'color_filter'
        : ''
    this.opacityScale = this.opacityKind === 'color_filter' ? 100 : 1
    const currentVideo = await this.client.call('GetVideoSettings')
    const targetWidth = config.canvasWidth || 1080
    const targetHeight = config.canvasHeight || 1920
    if (
      Number(currentVideo.baseWidth) !== targetWidth ||
      Number(currentVideo.baseHeight) !== targetHeight ||
      Number(currentVideo.outputWidth) !== targetWidth ||
      Number(currentVideo.outputHeight) !== targetHeight
    ) {
      this.log(`正在把 OBS 画布切换为 ${targetWidth}×${targetHeight} 竖屏…`)
      const [stream, record, virtualCamera] = await Promise.all([
        this.client.call('GetStreamStatus'),
        this.client.call('GetRecordStatus'),
        this.client.call('GetVirtualCamStatus'),
      ])
      if (stream.outputActive || record.outputActive)
        throw new Error('OBS 正在推流或录像，无法切换竖屏画布；请先结束当前输出')
      const restartVirtualCamera = Boolean(virtualCamera.outputActive)
      if (restartVirtualCamera) {
        this.log('正在暂时重启 OBS 虚拟摄像头以应用竖屏画布…')
        await this.client.call('StopVirtualCam')
        await this.waitVirtualCamera(false, signal)
      }
      try {
        await this.client.call('SetVideoSettings', {
          baseWidth: targetWidth,
          baseHeight: targetHeight,
          outputWidth: targetWidth,
          outputHeight: targetHeight,
          fpsNumerator: Number(currentVideo.fpsNumerator),
          fpsDenominator: Number(currentVideo.fpsDenominator),
        })
      } catch (error) {
        if (restartVirtualCamera) {
          await delay(250, undefined, { signal })
          await this.client.call('StartVirtualCam')
          await this.waitVirtualCamera(true, signal)
        }
        throw new Error(`无法切换 OBS 竖屏画布；请先停止推流和录像后重试。${String(error)}`)
      }
      if (restartVirtualCamera) {
        await delay(250, undefined, { signal })
        await this.client.call('StartVirtualCam')
        await this.waitVirtualCamera(true, signal)
      }
    }
    const video = await this.client.call('GetVideoSettings')
    this.width = Number(video.baseWidth)
    this.height = Number(video.baseHeight)
    this.log(`OBS 已连接，正在准备素材（文字源：${this.textKind}）`)
    // All variants are prepared before OBS starts: no network/encoding waits between live steps.
    const total = config.trays.reduce(
      (count, tray) =>
        count +
        (tray.products.some(product => product.B.length > 0)
          ? tray.A.length +
            tray.products.reduce((sum, product) => sum + product.B.length + product.C.length, 0)
          : 0),
      0,
    )
    let current = 0
    for (const tray of config.trays) {
      signal.throwIfAborted()
      // Empty trays are drafts. They have no playable products and must not block another tray.
      if (!tray.products.some(product => product.B.length > 0)) continue
      for (const step of tray.A) {
        current++
        await this.prepareStep(step, `${tray.name} / A`, current, total, signal)
      }
      await this.compileContinuousRuns(tray.A, signal)
      for (const file of [tray.transitionIn, tray.transitionOut].filter(Boolean)) {
        if (!this.normalized.has(file))
          this.normalized.set(file, await this.media.normalize(file, signal))
      }
      for (const p of tray.products) {
        for (const step of [...p.B, ...p.C]) {
          current++
          await this.prepareStep(step, p.id, current, total, signal)
        }
        await this.compileContinuousRuns(p.B, signal)
        await this.compileContinuousRuns(p.C, signal)
      }
    }
    signal.throwIfAborted()
    const scenes = await this.client.call('GetSceneList')
    if (!(scenes.scenes as Array<{ sceneName: string }>).some(s => s.sceneName === config.scene))
      await this.client.call('CreateScene', { sceneName: config.scene })
    await this.prepareOverlayGroups(config)
    await this.prepareStateGroups(config)
    await this.hideLegacySources('label', 'title')
    const media = {
      is_local_file: true,
      local_file: '',
      looping: false,
      clear_on_media_end: false,
      close_when_inactive: false,
    }
    await this.source('video', 'ffmpeg_source', media, 0, 0, true)
    await this.source('video-next', 'ffmpeg_source', media, 0, 0, true)
    for (const key of VIDEO_KEYS) await this.ensureOpacityFilter(key)
    await this.source('image', 'image_source', { file: '' }, 0, 0, true)
    /**
     * B/C 引导层：应用自己建的浏览器源，用户不用碰 OBS。
     *
     * 建在 image 之后、转场遮罩之前 —— OBS 新源加在最上层，
     * 这样引导层压住画面，但转场遮罩仍然压得住它（否则转场时标牌会露出来）。
     */
    if (inputKinds.includes('browser_source')) {
      await this.source(
        'cta',
        'browser_source',
        {
          url: '',
          width: this.width,
          height: this.height,
          fps: 30,
          shutdown: false,
          restart_when_active: false,
        },
        0,
        0,
        true,
      )
    } else {
      this.log('当前 OBS 没有浏览器源，B/C 引导层这一场不显示')
    }
    // 建完按艺术字的位置重写引导页（引导源本身保持满画布）
    await this.writeCtaPages(config)
    this.defocus = new DirectorDefocusTransition(
      this.client,
      [...VIDEO_KEYS, 'image'].map(key => this.name(key)),
    )
    await this.defocus.prepare(needsBlur)
    await this.source('audio', 'ffmpeg_source', media)
    await this.source('speech', 'ffmpeg_source', media)
    await this.client.call('SetInputMute', { inputName: this.name('speech'), inputMuted: true })
    const font = {
      face: 'Microsoft YaHei',
      size: Math.max(22, Math.round(this.height / 28)),
      style: 'Regular',
      flags: 0,
    }
    await this.source(
      'notice',
      this.textKind,
      { text: '', font, outline: true },
      this.width * 0.03,
      this.height * 0.88,
    )
    if (this.colorKind) {
      await this.source(
        'transition-cover',
        this.colorKind,
        { color: 0xff000000, width: this.width, height: this.height },
        0,
        0,
        true,
      )
      await this.ensureOpacityFilter('transition-cover')
      await this.opacity('transition-cover', 0)
    }
    // Keep both alternating video sources beneath images and text overlays.
    for (let index = 0; index < VIDEO_KEYS.length; index++)
      await this.client.call('SetSceneItemIndex', {
        sceneName: config.scene,
        sceneItemId: this.inputs.get(VIDEO_KEYS[index]),
        sceneItemIndex: index,
      })
    for (const key of [...VIDEO_KEYS, 'audio', 'speech'])
      await this.client.call('SetInputAudioMonitorType', {
        inputName: this.name(key),
        monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      })
    await this.client.call('SetCurrentProgramScene', { sceneName: config.scene })
    try {
      const studio = await this.client.call('GetStudioModeEnabled')
      if (studio.studioModeEnabled)
        await this.client.call('SetCurrentPreviewScene', { sceneName: config.scene })
    } catch {}
    /**
     * 虚拟声卡那一路 —— **放在最后建**。
     *
     * 播报语音走「音频输入采集」，指向 VB-Audio 虚拟声卡的 `CABLE Output`：
     * 音频由常驻播放服务直接渲染进 `CABLE Input`，**没有媒体源的加载开销**
     * （实测媒体源 880ms，这条路 76ms）。
     *
     * **必须最后建。** 实测对比过：一个**刚建出来**的采集源能正常出声（+62.6dB），
     * 而建在一堆源中间的那个不行 —— 源的状态一切正常（启用/不静音/0dB/设备 ID 都对），
     * 声音就是进不了混音。放在这里，它建完就是最后一步，没有别的源再动过场景。
     *
     * 建不出来不影响导播 —— 只是这条路用不了，会退回媒体源。
     */
    if (this.cableDevice) {
      try {
        await this.source('cable', 'wasapi_input_capture', { device_id: this.cableDevice })
        // 纯音频源，没画面：**必须「启用」**，禁用的场景项在 OBS 里根本不出声。
        // 静音由 SetInputMute 控制，不是靠禁用。
        await this.visible('cable', true)
        await this.client.call('SetInputMute', { inputName: this.name('cable'), inputMuted: true })
        this.cableReady = true
        /**
         * 预热播放服务。第一次 `/play` 会现拉起 Python（几秒），
         * 留到气口里做就来不及了 —— 语音会被判装不下、整句丢掉。
         * 预热失败不算致命：`play` 里还会再试一次。
         */
        const warm = await this.cable?.ensureReady?.().catch(() => false)
        this.log(
          warm === false
            ? '虚拟声卡播放服务预热失败，首次出声可能变慢（出声时还会再试一次）'
            : '虚拟声卡播报已就绪（CABLE Output，最后创建，播放服务已预热）',
        )
      } catch (error) {
        this.cableReady = false
        this.log(`虚拟声卡播报不可用，改用媒体源：${String(error)}`)
      }
    }
    signal.throwIfAborted()
    this.ready = true
    this.log(`OBS 已自动切换到场景“${config.scene}”，导播开始运行。`)
  }
  private async mediaPlay(key: 'audio', file: string, signal: AbortSignal) {
    signal.throwIfAborted()
    await this.visible(key, true)
    await this.client.call('SetInputMute', { inputName: this.name(key), inputMuted: false })
    if (this.audioFile === file) {
      await this.client.call('TriggerMediaInputAction', {
        inputName: this.name(key),
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      })
    } else {
      // OBS applies file updates asynchronously and starts the new file itself.
      // An immediate RESTART can still target the previous file and replay its head.
      await this.settings(key, {
        is_local_file: true,
        local_file: file,
        input_format: '',
        ffmpeg_options: '',
        looping: false,
        clear_on_media_end: false,
        restart_on_activate: false,
        close_when_inactive: false,
      })
      this.audioFile = file
    }
    await this.waitPlaying(key, signal)
  }
  private speechFits(reply: ReadySpeech, budget: number,preparing=false) {
    reply.streaming?.check()
    return reply.streaming
      ? reply.streaming.canStart(budget - (preparing&&reply.streaming.generationComplete&&reply.materialize ? .25 : OBS_STREAM_RESERVE_SECONDS))
      : reply.duration + 0.25 <= budget
  }
  private async prepareReply(reply:ReadySpeech,budget:number,signal:AbortSignal){
    const stream=reply.streaming!
    if(stream.generationComplete&&reply.materialize){
      const complete=await reply.materialize(budget-.25)
      reply.file=complete.file
    }else reply.file=await stream.prepare(budget-OBS_STREAM_RESERVE_SECONDS)
    signal.throwIfAborted()
  }
  /** The PLAY request itself is bounded too; a stuck websocket must not consume the next sentence. */
  private async playStream(reply: ReadySpeech, key: 'audio' | 'speech', remaining: number, signal: AbortSignal) {
    const stream = reply.streaming!
    signal.throwIfAborted()
    stream.check()
    if (!this.speechFits(reply, remaining)) throw new Error('流式回复已无法放入剩余窗口')
    // Admission reserves the paced HTTP tail; completion may use that reserve, never the next window.
    const deadline = Date.now() + remaining * 1000
    stream.start(deadline)
    const cancel = new AbortController()
    try {
      await Promise.race([
        this.client.call('TriggerMediaInputAction', {
          inputName: this.name(key), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
        }),
        delay(Math.max(1, deadline - Date.now()), undefined, { signal: AbortSignal.any([signal, cancel.signal]) })
          .then(() => { throw new Error('互动语音起播超过窗口截止时间') }),
      ])
      await waitForSpeechPlayback(stream,
        () => this.client.call('GetMediaInputStatus', { inputName: this.name(key) }), signal, deadline)
    } finally { cancel.abort() }
  }
  private async stopStreamConsumer(key: 'audio' | 'speech') {
    await this.client.call('TriggerMediaInputAction', {
      inputName: this.name(key), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    }).catch(() => {})
    if (key === 'audio') this.audioFile = undefined
    else this.speechFile = undefined
  }
  private async startSpeech(
    reply: ReadySpeech,
    slot: SpeechSlot,
    budget: number,
    signal: AbortSignal,
  ) {
    let streamCompleted = false
    let streamFailed = false
    try {
      if (reply.streaming) {
        if (!this.speechFits(reply, budget,true)) return false
        await this.prepareReply(reply,budget,signal)
        signal.throwIfAborted()
        if (!this.speechFits(reply, budget)) return false
      }
      // Network streams must pause immediately; only local files can be rewound after loading.
      await this.client.call('SetInputMute', { inputName: this.name('audio'), inputMuted: true })
      await this.visible('audio', true)
      if (!reply.streaming && this.audioFile === reply.file) {
        await this.client.call('TriggerMediaInputAction', {
          inputName: this.name('audio'),
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
        })
      } else if (/^https?:\/\//.test(reply.file))
        await this.settings('audio', {
          is_local_file: false, input: reply.file, input_format: reply.streaming ? 'mp3' : '',
          ffmpeg_options: reply.streaming ? 'probesize=32 analyzeduration=0' : '', looping: false,
          restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false, buffering_mb: 0,
        })
      else
        await this.settings('audio', {
          is_local_file: true,
          local_file: reply.file,
          input_format: '',
          ffmpeg_options: '',
          looping: false,
          restart_on_activate: false,
          close_when_inactive: false,
        })
      this.audioFile = reply.file
      if (reply.streaming) {
        await waitForPausedStream(
          () => this.client.call('TriggerMediaInputAction', {
            inputName: this.name('audio'), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
          }),
          () => this.client.call('GetMediaInputStatus', { inputName: this.name('audio') }),
          signal, reply.streaming,
        )
      } else {
        await this.waitPlaying('audio', signal)
        await this.client.call('TriggerMediaInputAction', {
          inputName: this.name('audio'),
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
        })
        await this.client.call('SetMediaInputCursor', { inputName: this.name('audio'), mediaCursor: 0 })
      }
      signal.throwIfAborted()
      const state = await this.client.call('GetMediaInputStatus', { inputName: this.name(slot.key) })
      const remaining = (slot.endMs - Number(state.mediaCursor)) / 1000
      if (
        !this.validSpeechSlot(slot) ||
        state.mediaState !== 'OBS_MEDIA_STATE_PLAYING' ||
        !Number.isFinite(remaining) ||
        !reply.valid() ||
        reply.expiresAt <= Date.now() ||
        !this.speechFits(reply, Math.min(budget, remaining))
      )
        return false
      await this.client.call('SetInputMute', { inputName: this.name('audio'), inputMuted: false })
      signal.throwIfAborted()
      const fresh = await this.client.call('GetMediaInputStatus', { inputName: this.name(slot.key) })
      const freshRemaining = (slot.endMs - Number(fresh.mediaCursor)) / 1000
      if (
        !this.validSpeechSlot(slot) ||
        fresh.mediaState !== 'OBS_MEDIA_STATE_PLAYING' ||
        !Number.isFinite(freshRemaining) ||
        !reply.valid() ||
        reply.expiresAt <= Date.now() ||
        !this.speechFits(reply, Math.min(budget, freshRemaining))
      )
        return false
      if (reply.streaming) {
        await this.playStream(reply, 'audio', Math.min(budget, freshRemaining), signal)
        streamCompleted = true
      } else await this.client.call('TriggerMediaInputAction', {
        inputName: this.name('audio'),
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
      })
      return true
    } catch (error) {
      streamFailed = true
      throw error
    } finally {
      if (reply.streaming && !streamCompleted) {
        await this.stopStreamConsumer('audio')
        if (streamFailed || signal.aborted) reply.streaming.dispose()
      }
    }
  }
  private async prepareMediaPlayback(
    key: VideoKey,
    file: string,
    loop: boolean,
    signal: AbortSignal,
  ) {
    this.videoGeneration.set(key, (this.videoGeneration.get(key) || 0) + 1)
    await this.client.call('SetInputMute', { inputName: this.name(key), inputMuted: true })
    if (this.videoFile.get(key) === file) {
      // 同一个文件：只能显式重播
      await this.client.call('TriggerMediaInputAction', {
        inputName: this.name(key),
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      })
    } else {
      // 换文件：只设文件，让 OBS 自己播起来。
      //
      // 这里以前还会补一句 STOP，实测是致命的：SetInputSettings 之后 OBS 会
      // 异步载入并自动开播，等我们能读到时长时它已经在播了 —— 这时候发 STOP
      // 会把媒体源打到 ENDED，随后的 RESTART 也救不回来，素材起播 125ms 就
      // 结束（单独实验复现：等到在播再 STOP → 125ms ENDED；不发 STOP → 活满）。
      // 音频那一路从来不发 STOP，所以它一直正常。
      await this.settings(key, {
        local_file: file,
        looping: loop,
        clear_on_media_end: false,
        restart_on_activate: false,
        close_when_inactive: false,
      })
      this.videoFile.set(key, file)
    }
    const ready = await this.waitMediaReady(key, file, signal)
    const short = file.split(/[\\/]/).pop() ?? file
    this.log(
      `载入 ${key} ← ${short}：期望 ${ready.expected.toFixed(2)}s，读到 ${
        ready.seen > 0 ? `${ready.seen.toFixed(2)}s` : '无'
      }，耗时 ${ready.waited}ms${ready.matched ? '' : '（没对上！）'}`,
    )
  }
  /**
   * 等 OBS 真的换上新素材再往下走。
   *
   * 实测：OBS 会在素材还没解析完时先报 PLAYING，紧接着就跳 ENDED。这时候如果
   * 已经发了 RESTART 并开始按游标等切点，就会看到"已结束、游标读不到"，
   * 误判成素材播完了，整个导播停摆（切点 12833ms / 只走到 0ms 就是这么来的）。
   * mediaDuration 是唯一能确认"文件真的解析好了"的字段。
   *
   * 注意：拿不到期望时长时**不能直接放行** —— 那正是上次漏掉这条保护的原因。
   */
  private async waitMediaReady(key: string, file: string, signal: AbortSignal) {
    const expected = await this.media.duration(file, signal).catch(() => Number.NaN)
    const started = Date.now()
    let seen = 0
    let matched = false
    let stable = 0
    let lastSeen = 0
    while (Date.now() - started < 6000) {
      signal.throwIfAborted()
      const status = await this.client.call('GetMediaInputStatus', { inputName: this.name(key) })
      const loaded = Number(status.mediaDuration) / 1000
      if (Number.isFinite(loaded) && loaded > 0) {
        seen = loaded
        stable = loaded === lastSeen ? stable + 1 : 1
        lastSeen = loaded
        if (Number.isFinite(expected)) {
          // 知道目标时长就精确比对
          if (Math.abs(loaded - expected) <= 0.75) {
            matched = true
            break
          }
        } else if (stable >= 3) {
          // 不知道目标时长，至少要求它连续三次读到同一个值 —— 否则可能读到的
          // 还是上一段素材的时长（旧值），等于没验证。
          matched = true
          break
        }
      } else {
        stable = 0
      }
      // 读到过时长又播完了，说明文件确实解析过（很短的片段会立刻播完）
      if (status.mediaState === 'OBS_MEDIA_STATE_ENDED' && seen > 0) break
      await delay(16, undefined, { signal })
    }
    return { expected, seen, matched, waited: Date.now() - started }
  }
  /**
   * 起播之后再确认它真的在往前走。
   *
   * 实测（A 阶段 4 步的视频在 2 秒内全部换完，而配音按 28 秒一步正常推进）：
   * OBS 会先报 PLAYING、时长也读得到，然后一两百毫秒内翻成 ENDED —— 素材其实
   * 根本没真正播放。只信 PLAYING 会一路错下去：连续视频按游标切点的逻辑随后
   * 看到"已结束、游标一次都没动过"，就误判素材播完，整个导播停摆。
   */
  private async waitRunning(key: VideoKey, signal: AbortSignal) {
    const started = Date.now()
    let first = -1
    while (Date.now() - started < 2500) {
      signal.throwIfAborted()
      const status = await this.client.call('GetMediaInputStatus', { inputName: this.name(key) })
      if (status.mediaState === 'OBS_MEDIA_STATE_ENDED') throw new Error('素材起播后立刻结束')
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('OBS 媒体解码失败')
      const cursor = Number(status.mediaCursor)
      // 光"游标大于 0"不够：媒体源被隐藏时游标会停在原地不动（实测卡在 16ms），
      // 却一直报 PLAYING、时长也读得到。必须看到它真的往前走了才算数。
      if (Number.isFinite(cursor) && cursor > 0) {
        if (first < 0) first = cursor
        else if (cursor > first) return
      }
      await delay(16, undefined, { signal })
    }
    throw new Error('素材起播后游标没有前进')
  }
  /**
   * 确认素材真的跑起来了；第一次落空就重新载入再试一次。
   *
   * 起播指令由 prepareMediaPlayback 负责（换文件时 OBS 自己会播，同文件时显式重播），
   * 这里只负责验证 —— 光报 PLAYING 不算数，游标必须真的开始走。
   */
  private async startPlayback(key: VideoKey, file: string, loop: boolean, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const status = await this.waitPlaying(key, signal)
        await this.waitRunning(key, signal)
        this.log(
          `起播 ${key}：${String(status.mediaState).replace('OBS_MEDIA_STATE_', '')} ` +
            `时长 ${Math.round(Number(status.mediaDuration))}ms`,
        )
        return
      } catch (error) {
        if (signal.aborted || attempt === 1) throw error
        this.log(
          `素材“${file.split(/[\\/]/).pop() ?? file}”没真正跑起来（${
            error instanceof Error ? error.message : String(error)
          }），重新载入后再试一次`,
        )
        await this.prepareMediaPlayback(key, file, loop, signal)
      }
    }
  }
  private async waitPlaying(key: VideoKey | 'audio' | 'speech', signal: AbortSignal) {
    const start = Date.now()
    let lastCursor = -1
    while (Date.now() - start < 5000) {
      signal.throwIfAborted()
      const status = await this.client.call('GetMediaInputStatus', { inputName: this.name(key) })
      /**
       * 判「真的在放」有两个证据，够一个就行：
       *
       *   · **读得到时长** —— 普通文件是这样。光看 PLAYING 不够：素材还没解析完
       *     时 OBS 也会先报 PLAYING，紧跟着就 ENDED。
       *   · **游标在推进** —— 流式播放只能靠这个。实测 OBS 对无界的 HTTP 流
       *     读不出时长，`mediaDuration` 报的是 `-9223372036854.78`（一个巨大的
       *     负数）。只认时长的话，流式那句**永远等不到「在放」，必被丢掉**。
       */
      const cursor = Number(status.mediaCursor)
      const knownDuration = Number(status.mediaDuration) > 0
      const advancing = Number.isFinite(cursor) && cursor > 0 && cursor > lastCursor
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' && (knownDuration || advancing))
        return status
      if (Number.isFinite(cursor)) lastCursor = cursor
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('OBS 媒体解码失败')
      await delay(8, undefined, { signal })
    }
    throw new Error('OBS 没有开始播放下一段素材')
  }
  private async playVideo(
    file: string,
    signal: AbortSignal,
    loop = false,
    mute = false,
    seamless = false,
  ) {
    const previous = this.activeVideo
    const next: VideoKey = previous === 'video' ? 'video-next' : 'video'
    // 必须先挂上画面再起播：OBS 不解码隐藏的媒体源 —— 隐藏时它会报 PLAYING、
    // 时长也读得到，但游标纹丝不动，最后只能由看门狗报"未确认播放完成"。
    // 音频那一路就是先 visible 再起播，所以从来没出过这个问题。
    // 交叉淡化靠的是透明度滤镜，不是显隐，所以先显示不会破坏转场。
    await this.opacity(next, previous ? 0 : 1)
    await this.visible(next, true)
    await this.prepareMediaPlayback(next, file, loop, signal)
    await this.client.call('SetInputMute', { inputName: this.name(next), inputMuted: mute })
    await this.startPlayback(next, file, loop, signal)
    if (previous) {
      // 阶段转场同样是渐变，不能一帧顶上：两幅模糊画面的平均亮度不同，
      // 硬切就是一次亮度阶跃，看起来像「闪白」。dissolve 走的也是这条。
      const transitionMs = this.phaseTransitionActive
        ? this.phaseFadeMs
        : this.opacityKind && !seamless
          ? (this.config.transitionMs ?? 200)
          : 0
      const frames = transitionMs > 0 ? Math.max(2, Math.ceil(transitionMs / 30)) : 1
      for (let frame = 1; frame <= frames; frame++) {
        const progress = frame / frames
        await Promise.all([this.opacity(previous, 1 - progress), this.opacity(next, progress)])
        if (frame < frames) await delay(transitionMs / frames, undefined, { signal })
      }
      await this.visible(previous, false)
    }
    this.activeVideo = next
    return next
  }
  /**
   * 这一步还能透支多少秒（账本剩余额度）。
   *
   * 语音比窗口长是允许的：播语音时原配音是**暂停**的，播完再把游标设到窗口结束处
   * 继续 —— 所以超支的后果只是整段旁白**往后推**，画面照常走。这正是我们要的效果。
   * 但不能无限超：透支的是「画面比配音长」省下来的时间，总账不透支才放行。
   */
  private slackSeconds() {
    return speechWindows.slackSeconds()
  }
  private async waitCursor(
    key: VideoKey,
    endMs: number,
    duration: number,
    last: boolean,
    signal: AbortSignal,
  ) {
    const started = Date.now()
    // 记下整个过程里游标走到的最高点和读到过的素材时长，出错时能自证现场。
    let peak = 0
    let mediaMs = Number.NaN
    let polls = 0
    const states = new Set<string>()
    while (Date.now() - started < (duration + 15) * 1000) {
      const status = await this.client.call('GetMediaInputStatus', { inputName: this.name(key) })
      const cursor = Number(status.mediaCursor)
      const total = Number(status.mediaDuration)
      polls++
      states.add(String(status.mediaState).replace('OBS_MEDIA_STATE_', ''))
      if (Number.isFinite(cursor)) {
        peak = Math.max(peak, cursor)
        speechWindows.advance(cursor / 1000)
      }
      if (Number.isFinite(total) && total > 0) mediaMs = total
      if (cursor >= endMs - 8) return
      if (status.mediaState === 'OBS_MEDIA_STATE_ENDED') {
        if (last) return
        throw new Error(
          `连续视频在步骤切点前提前结束：切点 ${endMs}ms，只走到 ${Math.round(peak)}ms` +
            (Number.isFinite(mediaMs)
              ? `，素材时长 ${Math.round(mediaMs)}ms`
              : '，没读到素材时长') +
            `（${key} 轮询 ${polls} 次，见过 ${[...states].join('/')}）`,
        )
      }
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('OBS 媒体解码失败')
      await delay(8, undefined, { signal })
    }
    throw new Error(
      `OBS 连续视频没有到达步骤切点：切点 ${endMs}ms，只走到 ${Math.round(peak)}ms` +
        (Number.isFinite(mediaMs) ? `，素材时长 ${Math.round(mediaMs)}ms` : '') +
        `（${key} 轮询 ${polls} 次，见过 ${[...states].join('/')}）`,
    )
  }
  private async waitEnd(key: string, duration: number, signal: AbortSignal) {
    const start = Date.now()
    let active = false
    /**
     * 游标停滞检测。
     *
     * 流式播放时音源是**边生成边推**的。万一千问比实时慢，OBS 会把已有的播完
     * 然后**卡住**（实测：2.64 秒的音频停在 2.04 秒，状态始终是 PLAYING，
     * 永远不报 ENDED）。那种情况下只等 ENDED 会一路等满 duration + 15 秒的
     * 看门狗 —— **整条旁白队列陪着卡十几秒**。
     *
     * 所以：游标连着 3 秒不动就当它播完了。语音里不可能有 3 秒静音，
     * 这个阈值不会误伤正常的句子。
     */
    let lastCursor = -1
    let stalledSince = 0
    const STALL_MS = 3000
    // Actual media state decides completion; duration is only a watchdog.
    while (Date.now() - start < (duration + 15) * 1000) {
      await delay(16, undefined, { signal })
      const status = await this.client
        .call('GetMediaInputStatus', { inputName: this.name(key) })
        .catch(error => {
          if (key === 'speech') return undefined // A transient status error is not permission to cut an utterance.
          throw error
        })
      if (!status) continue
      const cursor = Number(status.mediaCursor)
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' || cursor > 0) active = true
      if (status.mediaState === 'OBS_MEDIA_STATE_ENDED' && (active || Date.now() - start > 300))
        return
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('OBS 媒体解码失败')
      if (key === 'speech' && status.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
        if (Number.isFinite(cursor) && cursor > lastCursor) {
          lastCursor = cursor
          stalledSince = Date.now()
        } else if (!stalledSince) stalledSince = Date.now()
        else if (Date.now() - stalledSince > STALL_MS) {
          this.log('互动语音的流断了（千问比实时慢），按播完处理')
          return
        }
      }
    }
    throw new Error('OBS 未确认素材播放完成，请检查播放器')
  }
  private queueNarration(file: string, signal: AbortSignal, slot?: SpeechSlot) {
    this.narrationQueue = this.narrationQueue
      .then(async () => {
        if (this.narrationFailure) return
        signal.throwIfAborted()
        const duration = await this.media.duration(file, signal)
        /**
         * 账本以**步骤**为最小单位，不跨步骤透支。
         *
         * 这一步的额度 = 画面时长 − 配音时长。插话可以用它透支，但插完之后
         * 这一步的总音频不能超过这一步的视频时长。
         *
         * 每一步开账时**重置**（不是累加）—— 上一步用剩的不带给下一步。
         */
        if (slot?.videoSeconds)
          this.ledger?.reset((slot.videoSeconds - duration) * 1000)
        let deadline = 0
        if (slot && this.validSpeechSlot(slot)) {
          const state = await this.client.call('GetMediaInputStatus', {
            inputName: this.name(slot.key),
          })
          const cursor = Number(state.mediaCursor)
          if (state.mediaState === 'OBS_MEDIA_STATE_PLAYING' && Number.isFinite(cursor))
            deadline = Date.now() + Math.max(0, slot.endMs - cursor)
        }
        let reply = slot ? this.speech?.take({ deadline, budget: duration, strict: true }) : undefined
        const started = Date.now()
        let completed = false
        try {
          if (reply && slot) {
            let admitted = false
            try {
              admitted = await this.startSpeech(reply, slot, Math.min(duration, (deadline - Date.now()) / 1000), signal)
            } catch {
              if (reply.streaming) {
                reply.done?.(signal.aborted ? 'expired' : 'failed')
                reply = undefined
              }
              signal.throwIfAborted()
              this.log('互动语音准备失败，继续原配音')
            }
            if (!admitted && reply) {
              // 放回队列，别丢 —— 后面的气口还用得上（见 `DirectorSpeechQueue.put`）。
              if (reply.valid() && reply.expiresAt > Date.now()) this.speech?.put(reply)
              else reply.done?.('expired')
              reply = undefined
            }
          }
          if (!reply) await this.mediaPlay('audio', file, signal)
          if (!reply?.streaming) await this.waitEnd('audio', reply?.duration ?? duration, signal)
          if (reply) {
            completed = true
            reply.streaming?.dispose()
            reply.done?.('played')
            this.log(`互动语音已播放：${reply.text}`)
            // Preserve the original narration timeline; short replacement never pulls the next sentence forward.
            const remaining = duration * 1000 - (Date.now() - started)
            if (remaining > 0) await delay(remaining, undefined, { signal })
          }
        } catch (error) {
          if (!completed) reply?.done?.(signal.aborted ? 'expired' : 'failed')
          throw error
        }
      })
      .catch(error => {
        this.narrationFailure ??= error
      })
  }
  private queueStepNarration(
    step: DirectorStep,
    audio: string,
    signal: AbortSignal,
    slot: { key: VideoKey; endMs: number; videoSeconds?: number; variantId?: string },
  ) {
    const boundSlot = { ...slot, generation: this.videoGeneration.get(slot.key) || 0 }
    const windows = (step.speechWindows || [])
      .filter(w => w.audio === audio && isReviewedSpeechWindow(w))
      .filter(w => !w.material?.variantId || w.material.variantId === slot.variantId)
      .sort((a, b) => a.start - b.start)
    // 窗口交给唯一主人。播放层只负责「换段」和「报游标」，不自己存一份。
    if (!windows.length) {
      speechWindows.begin(slot.key, [])
      if (step.speechWindows?.some(w => w.audio === audio))
        this.log('旧语音窗口缺少原句审核或素材配对，已保留原配音；请重新分析并逐句审核')
      this.queueNarration(audio, signal, step.speechSlot && !step.speechWindows?.length ? boundSlot : undefined)
      return
    }
    this.narrationQueue = this.narrationQueue
      .then(async () => {
        if (!this.narrationFailure) {
          await validateSpeechMaterials(step, windows)
          speechWindows.begin(slot.key, windows)
          await this.playWindowedNarration(audio, windows, boundSlot, signal)
        }
      })
      .catch(error => {
        this.narrationFailure ??= error
      })
  }
  /** Pause the original at an approved boundary; skip its sentence only after a completed replacement. */
  private async playWindowedNarration(
    file: string,
    windows: SpeechWindow[],
    slot: SpeechSlot,
    signal: AbortSignal,
  ) {
    const duration = await this.media.duration(file, signal)
    /**
     * 每一步开账时**重置**额度（不是累加），上一步用剩的不带给下一步。
     *
     * 这一步以前漏了 —— 重置只写在 `queueNarration` 里，而那是「**没有气口**」
     * 的步骤走的路径。结果：**真正会说话的那些步骤（有气口的）从来没重置过**，
     * 用的是上一步残留的值或者初始的 0，「按步骤记账」等于没生效。
     */
    if (slot.videoSeconds)
      this.ledger?.reset((slot.videoSeconds - duration) * 1000)
    await this.mediaPlay('audio', file, signal)
    const started = Date.now()
    for (const window of windows) {
      let reply: ReadySpeech | undefined
      let muted = false
      let paused = false
      let completed = false
      let admitted = false
      let failed = false
      let replyBudget = 0
      try {
        while (Date.now() - started < (duration + 15) * 1000) {
          signal.throwIfAborted()
          const status = await this.client.call('GetMediaInputStatus', {
            inputName: this.name('audio'),
          })
          if (status.mediaState === 'OBS_MEDIA_STATE_ENDED') return
          if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') throw new Error('原配音解码失败')
          const cursor = Number(status.mediaCursor) / 1000
          if (!Number.isFinite(cursor)) break
          // 报游标给窗口主人。有窗口的步骤走这条路，没窗口的走 waitCursor ——
          // 两条路都必须报，少一条就会出现「有窗口的步骤反而 0 个候选」。
          speechWindows.advance(cursor)
          // A sentence must be intercepted before it starts. Only verified silence allows late entry.
          if (speechWindowMissed(window, cursor) || cursor >= window.end - 0.3) break
          // Preload before the boundary. HTTP streams pause immediately; local files rewind after loading.
          // Early preparation never enlarges the approved playback budget or permits late sentence entry.
          if (cursor >= window.start - 1.6) {
            const startAt = Math.max(cursor, speechWindowEntryStart(window))
            replyBudget = window.end - startAt
            reply = this.speech?.take({
              deadline: Date.now() + (window.end - cursor) * 1000,
              // **按「真正能开播的那一刻」算可用空间**，别用「现在」——
              // 提前取的时候「现在」还在窗口前面，会把空间算大。
              budget: window.end - startAt,
              strict: true,
              // A short reply in a long *sentence* would manufacture seconds of
              // silent padding. Keep it queued for a closer-sized opportunity.
              minDuration:window.kind==='sentence'?Math.max(0,window.end-startAt-sentencePaddingAllowance(window,windows)):undefined,
            })
            if (reply) break
          }
          await delay(16, undefined, { signal })
        }
        if (!reply) continue
        if (reply.streaming) {
          const video = await this.client.call('GetMediaInputStatus', { inputName: this.name(slot.key) })
          const remaining = (slot.endMs - Number(video.mediaCursor)) / 1000
          if (!this.validSpeechSlot(slot) || video.mediaState !== 'OBS_MEDIA_STATE_PLAYING' || !Number.isFinite(remaining)) continue
          replyBudget = Math.min(replyBudget, remaining)
          if (!this.speechFits(reply, replyBudget,true)) continue
          await this.prepareReply(reply,replyBudget,signal)
          signal.throwIfAborted()
          if (!this.speechFits(reply, replyBudget)) continue
        }
        /**
         * **虚拟声卡那条路优先。**
         *
         * 没有媒体源加载开销（实测：媒体源 880ms，虚拟声卡 76ms），所以气口一到
         * 就能出声 —— 不用提前 1.6 秒去取，能用的气口范围明显变大。
         *
         * 走这条路时把 `reply` 置空，让下面的 finally 不再重复处理它。
         */
        if (!reply.streaming && this.cableReady && this.cable && /\.wav$/i.test(reply.file)) {
          const outcome = await this.playSpeechViaCable(reply, slot, window, signal,sentencePaddingAllowance(window,windows))
          if (outcome !== 'missed')
            reply.done?.(outcome === 'played' ? 'played' : outcome === 'failed' ? 'failed' : 'expired')
          if (outcome === 'played') this.log(`互动语音已播放：${reply.text}`)
          reply = undefined
          continue
        }
        await this.client.call('SetInputMute', { inputName: this.name('speech'), inputMuted: true })
        await this.visible('speech', true)
        if (!reply.streaming && this.speechFile === reply.file)
          await this.client.call('TriggerMediaInputAction', {
            inputName: this.name('speech'),
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
          })
        else if (/^https?:\/\//.test(reply.file))
          /**
           * 流式那条路：音频来自本地 HTTP 流，不是文件。
           *
           * 实测（真 OBS）：往文件里追加播不出来（ffmpeg 读到 EOF 就结束）、
           * WAV 走 HTTP 压根不播，**只有 MP3 走 HTTP 分块流是边收边播的**。
           * 所以这里的几个开关是照着那个实验配的：不循环、不循环后清屏、
           * 缓冲设为 0（默认缓冲会把首块压到能播之前）。
           */
          await this.settings('speech', {
            is_local_file: false,
            input: reply.file,
            input_format: reply.streaming ? 'mp3' : '',
            ffmpeg_options: reply.streaming ? 'probesize=32 analyzeduration=0' : '',
            looping: false,
            restart_on_activate: false,
            close_when_inactive: false,
            clear_on_media_end: false,
            buffering_mb: 0,
          })
        else
          await this.settings('speech', {
            is_local_file: true,
            local_file: reply.file,
            input_format: '',
            ffmpeg_options: '',
            looping: false,
            restart_on_activate: false,
            close_when_inactive: false,
          })
        this.speechFile = reply.file
        if (reply.streaming) {
          await waitForPausedStream(
            () => this.client.call('TriggerMediaInputAction', {
              inputName: this.name('speech'), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
            }),
            () => this.client.call('GetMediaInputStatus', { inputName: this.name('speech') }),
            signal, reply.streaming,
          )
        } else {
          await this.waitPlaying('speech', signal)
          await this.client.call('TriggerMediaInputAction', {
            inputName: this.name('speech'),
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
          })
          await this.client.call('SetMediaInputCursor', {
            inputName: this.name('speech'),
            mediaCursor: 0,
          })
        }
        let cursor = 0
        do {
          signal.throwIfAborted()
          const state = await this.client.call('GetMediaInputStatus', {
            inputName: this.name('audio'),
          })
          if (state.mediaState !== 'OBS_MEDIA_STATE_PLAYING') { cursor = Number.NaN; break }
          cursor = Number(state.mediaCursor) / 1000
          if (!Number.isFinite(cursor) || cursor >= speechWindowEntryStart(window)) break
          await delay(8, undefined, { signal })
        } while (Date.now() - started < (duration + 15) * 1000)
        if (
          !Number.isFinite(cursor) ||
          cursor < speechWindowEntryStart(window) ||
          speechWindowMissed(window, cursor) ||
          !reply.valid() ||
          reply.expiresAt <= Date.now()
        ) {
          /**
           * 复查没过 —— **把这句放回队列**，别丢掉。
           *
           * `take` 是从队列里移除的。丢掉的话后面所有气口都再也用不上它，
           * 观众只能收到文字。实测代价：A 段第 3 秒发话时，语音在气口2 被取出、
           * 因为 OBS 加载（0.9 秒）把游标推过了窗口头而被拒 —— 于是整个 28 秒
           * 里再也没出声。放回去它会落到气口3。
           */
          continue
        }
        const video = await this.client.call('GetMediaInputStatus', {
          inputName: this.name(slot.key),
        })
        const remaining = (slot.endMs - Number(video.mediaCursor)) / 1000
        if (
          !this.validSpeechSlot(slot) ||
          video.mediaState !== 'OBS_MEDIA_STATE_PLAYING' ||
          !Number.isFinite(remaining) ||
          !this.speechFits(reply, Math.min(remaining, window.end - cursor))
        )
          continue
        // Pause while audible: a rejected admission must resume the exact same cursor without losing words.
        paused = true
        await this.client.call('TriggerMediaInputAction', {
          inputName: this.name('audio'),
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
        })
        let fresh = await this.client.call('GetMediaInputStatus', {
          inputName: this.name('audio'),
        })
        // OBS acknowledges PAUSE before its media state changes. Keep narration audible
        // while waiting, then recheck the actual stopped cursor against the same window.
        const pauseDeadline = Date.now() + 120
        while (fresh.mediaState === 'OBS_MEDIA_STATE_PLAYING' && Date.now() < pauseDeadline) {
          await delay(4, undefined, { signal })
          fresh = await this.client.call('GetMediaInputStatus', {
            inputName: this.name('audio'),
          })
        }
        cursor = Number(fresh.mediaCursor) / 1000
        signal.throwIfAborted()
        if (
          fresh.mediaState !== 'OBS_MEDIA_STATE_PAUSED' ||
          !Number.isFinite(cursor) ||
          cursor < speechWindowEntryStart(window) ||
          speechWindowMissed(window, cursor) ||
          !this.speechFits(reply, window.end - cursor) ||
          (window.kind==='sentence'&&window.end-cursor-(reply.streaming?.minimumDuration??reply.duration)>sentencePaddingAllowance(window,windows)) ||
          !this.validSpeechSlot(slot) ||
          !reply.valid() ||
          reply.expiresAt <= Date.now()
        )
          continue
        await this.client.call('SetInputMute', { inputName: this.name('audio'), inputMuted: true })
        muted = true
        await this.client.call('SetInputMute', {
          inputName: this.name('speech'),
          inputMuted: false,
        })
        const finalVideo = await this.client.call('GetMediaInputStatus', {
          inputName: this.name(slot.key),
        })
        const finalRemaining = (slot.endMs - Number(finalVideo.mediaCursor)) / 1000
        signal.throwIfAborted()
        if (
          !this.validSpeechSlot(slot) ||
          !reply.valid() ||
          reply.expiresAt <= Date.now() ||
          finalVideo.mediaState !== 'OBS_MEDIA_STATE_PLAYING' ||
          !Number.isFinite(finalRemaining) ||
          !this.speechFits(reply, Math.min(finalRemaining, window.end - cursor))
        )
          continue
        admitted = true
        /**
         * 到这里才记账。**扣的是「这一步实际多花掉的时间」**：语音比窗口短就退钱
         * （charge 带符号），比窗口长就扣这一步的额度。放在放行之后而不是取用时，
         * 是因为取用只是「决定要播」—— 播放层随后还要复查一遍，那时若账已扣过，
         * 复查用的就是扣款后的额度，等于自己否掉自己。
         */
        // Padding consumes the whole approved window; it must not create spare credit.
        const speechStarted = Date.now()
        if (reply.streaming) {
          await this.playStream(reply, 'speech', Math.min(finalRemaining, window.end - cursor), signal)
        } else {
          await this.client.call('TriggerMediaInputAction', {
            inputName: this.name('speech'),
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
          })
          // A slow decoder must not cut the reply tail or skip protected narration. Resume at the exact approved end.
          await this.waitEnd('speech', reply.duration, signal)
        }
        completed = true
        const padding = (window.end - cursor) * 1000 - (Date.now() - speechStarted)
        if (padding > 0) await delay(padding, undefined, { signal })
      } catch (error) {
        failed = !signal.aborted
        /**
         * **一定要把原因打出来。** 这里原来只写「未能完成」，实际错误被吞了 ——
         * 2026-09-29 直播里观众听到「没有声音」，日志却只留一句没有信息量的话，
         * 只能靠读代码猜。现在连错误原文一起记。
         */
        this.log(
          `句内互动未能完成，恢复原配音：${error instanceof Error ? error.message : String(error)}`,
        )
        signal.throwIfAborted()
      } finally {
        if (reply) {
          try {
            await this.client
              .call('SetInputMute', { inputName: this.name('speech'), inputMuted: true })
              .catch(() => {})
            if (reply.streaming && !completed) await this.stopStreamConsumer('speech')
            await this.visible('speech', false).catch(() => {})
            if (paused && !signal.aborted) {
              if (completed)
                await this.client.call('SetMediaInputCursor', {
                  inputName: this.name('audio'),
                  mediaCursor: window.end * 1000,
                })
              if (muted)
                await this.client.call('SetInputMute', {
                  inputName: this.name('audio'),
                  inputMuted: false,
                })
              await this.client.call('TriggerMediaInputAction', {
                inputName: this.name('audio'),
                mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
              })
            }
          } finally {
            if (reply.streaming && (completed || admitted || failed || signal.aborted)) reply.streaming.dispose()
            if (!admitted && !failed && !signal.aborted) this.speech?.put(reply)
            else reply.done?.(completed ? 'played' : failed ? 'failed' : 'expired')
            if (completed) this.log(`互动语音已播放：${reply.text}`)
          }
        }
      }
    }
    await this.waitEnd('audio', duration, signal)
  }
  /**
   * 走虚拟声卡播这一句：静音旁白 → 播到声卡 → 恢复旁白并跳到气口末尾。
   *
   * 和 OBS 媒体源那条路的区别**只在「怎么出声」**：
   *   · 不用加载媒体源（省掉 880ms），所以不用提前 1.6 秒取用；
   *   · 出声时刻由播放服务保证（它写完第一块缓冲才返回）。
   *
   * 旁白那套处理完全一样：暂停 → 播完跳到 `window.end` 继续，一个字都不丢。
   *
   * 返回 `played` / `missed`（窗口不合适，已放回队列）/ `failed` / `aborted`。
   */
  private async playSpeechViaCable(
    reply: ReadySpeech,
    slot: SpeechSlot,
    window: SpeechWindow,
    signal: AbortSignal,
    paddingLimit=MAX_SENTENCE_PADDING_SECONDS,
  ): Promise<'played' | 'missed' | 'failed' | 'aborted'> {
    if (!this.cable) return 'missed'
    let paused = false
    let muted = false
    let completed = false
    let cursor = 0
    try {
      // Pause in the verified leading silence; do not wait for an exact timestamp match.
      const waitStarted = Date.now()
      do {
        signal.throwIfAborted()
        const state = await this.client.call('GetMediaInputStatus', {
          inputName: this.name('audio'),
        })
        if (state.mediaState !== 'OBS_MEDIA_STATE_PLAYING') return this.releaseSpeech(reply, '原配音未播放')
        cursor = Number(state.mediaCursor) / 1000
        if (!Number.isFinite(cursor)) return this.releaseSpeech(reply, '读不到游标')
        speechWindows.advance(cursor)
        if (speechWindowMissed(window, cursor) || cursor >= window.end - 0.3)
          return this.releaseSpeech(reply, `游标 ${cursor.toFixed(2)} 已到气口末尾 ${window.end.toFixed(2)}`)
        if (cursor >= speechWindowEntryStart(window)) break
        await delay(8, undefined, { signal })
      } while (Date.now() - waitStarted < (reply.duration + 15) * 1000)
      if (!Number.isFinite(cursor) || !reply.valid() || reply.expiresAt <= Date.now())
        return this.releaseSpeech(reply, `等气口期间失效（游标 ${cursor}）`)
      // 还没到气口头就再等（气口在将来）
      while (cursor < speechWindowEntryStart(window)) {
        signal.throwIfAborted()
        await delay(8, undefined, { signal })
        const state = await this.client.call('GetMediaInputStatus', {
          inputName: this.name('audio'),
        })
        if (state.mediaState !== 'OBS_MEDIA_STATE_PLAYING')
          return this.releaseSpeech(reply, '等气口时原配音停了')
        cursor = Number(state.mediaCursor) / 1000
        if (!Number.isFinite(cursor)) return this.releaseSpeech(reply, '读不到游标')
        if (speechWindowMissed(window, cursor))
          return this.releaseSpeech(reply, `游标 ${cursor.toFixed(2)} 冲过了气口头 ${window.start.toFixed(2)}`)
        if (Date.now() - waitStarted > (reply.duration + 15) * 1000)
          return this.releaseSpeech(reply, '等气口超时')
      }
      const video = await this.client.call('GetMediaInputStatus', {
        inputName: this.name(slot.key),
      })
      const remaining = (slot.endMs - Number(video.mediaCursor)) / 1000
      if (
        !this.validSpeechSlot(slot) ||
        video.mediaState !== 'OBS_MEDIA_STATE_PLAYING' ||
        !Number.isFinite(remaining) ||
        reply.duration + 0.25 > Math.min(remaining, window.end - cursor)
      )
        return this.releaseSpeech(
          reply,
          `取用复查没过（slot有效=${this.validSpeechSlot(slot)} 画面=${video.mediaState} ` +
            `剩${remaining.toFixed(2)}s 到气口末${(window.end - cursor).toFixed(2)}s ` +
            `额度${this.slackSeconds().toFixed(2)}s 需要${(reply.duration + 0.25).toFixed(2)}s）`,
        )
      paused = true
      await this.client.call('TriggerMediaInputAction', {
        inputName: this.name('audio'),
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
      })
      /**
       * **等它真的停下来再复查。**
       *
       * OBS 的暂停是异步的：发完 `PAUSE` 立刻读状态，拿到的还是 PLAYING ——
       * 实测就因为这个把一句本来完全放得下的话拒了（诊断原话：
       * 「状态=PLAYING 到气口末 3.18s 额度 0.00s 需要 1.37s」，空间明明够）。
       */
      let fresh = await this.client.call('GetMediaInputStatus', {
        inputName: this.name('audio'),
      })
      const pauseDeadline = Date.now() + 120
      while (fresh.mediaState !== 'OBS_MEDIA_STATE_PAUSED' && Date.now() < pauseDeadline) {
        await delay(4, undefined, { signal })
        fresh = await this.client.call('GetMediaInputStatus', {
          inputName: this.name('audio'),
        })
      }
      cursor = Number(fresh.mediaCursor) / 1000
      signal.throwIfAborted()
      if (
        fresh.mediaState !== 'OBS_MEDIA_STATE_PAUSED' ||
        !Number.isFinite(cursor) ||
        cursor < speechWindowEntryStart(window) ||
        speechWindowMissed(window, cursor) ||
        reply.duration + 0.25 > window.end - cursor ||
        (window.kind==='sentence'&&window.end-cursor-reply.duration>paddingLimit) ||
        !this.validSpeechSlot(slot) ||
        !reply.valid() ||
        reply.expiresAt <= Date.now()
      )
        return this.releaseSpeech(
          reply,
          `暂停后复查没过（状态=${fresh.mediaState} 游标=${cursor.toFixed(2)} ` +
            `到气口末${(window.end - cursor).toFixed(2)}s 额度${this.slackSeconds().toFixed(2)}s ` +
            `需要${(reply.duration + 0.25).toFixed(2)}s）`,
        )
      // 静音原配音、放虚拟声卡 —— 中间没有加载等待，立刻就是声音
      await this.client.call('SetInputMute', { inputName: this.name('audio'), inputMuted: true })
      muted = true
      /**
       * **出声之前再确认一次它是启用的。**
       *
       * 建源的时候设了启用，但后面的场景处理（隐藏引导层、状态组、切场景）
       * 会把它一起隐藏掉。**禁用的场景项在 OBS 里完全不出声** —— 实测踩过：
       * 播放服务明明推了（起播 14ms），录制里却是静音。
       */
      /**
       * **只确保它是启用的，千万别「关掉再打开」。**
       *
       * 我一度加过「关掉 → 等 60ms → 打开」想强制 OBS 重抓设备，结果**反而把它弄哑了** ——
       * OBS 关掉采集再打开时没来得及重新抓，声音从此进不来。
       *
       * 实测对照（同一个场景、同一段音频）：
       *   · 走我这个方法（带开关那版）→ 录制里只有 −73dB（近乎静音）
       *   · 绕开这个方法、只用原始 OBS 调用 → −12dB（正常出声）
       *
       * 所以这里只做「确保启用」，不动它。
       */
      await this.visible('cable', true)
      await this.client.call('SetInputMute', { inputName: this.name('cable'), inputMuted: false })
      /**
       * 给 OBS 一点时间把这一路采集**跑起来**。
       *
       * 实测对照（同场景同音频）：放音前留 500ms，录制里有 −13dB；一启用就立刻播，
       * 只剩 −73dB（近乎静音）。OBS 的 WASAPI 采集从「启用」到真的开始抓设备
       * 不是瞬时的。
       */
      await delay(CABLE_SPINUP_MS, undefined, { signal })
      // 出声前把这一路的真实状态打出来 —— 静音/禁用都是「明明播了却没声音」的元凶
      const cableState = (await this.client
        .call('GetInputMute', { inputName: this.name('cable') })
        .catch(() => undefined)) as { inputMuted: boolean } | undefined
      const cableItem = (await this.client
        .call('GetSceneItemEnabled', {
          sceneName: this.config.scene,
          sceneItemId: this.inputs.get('cable') ?? -1,
        })
        .catch(() => undefined)) as { sceneItemEnabled: boolean } | undefined
      const cableVolume = (await this.client
        .call('GetInputVolume', { inputName: this.name('cable') })
        .catch(() => undefined)) as { inputVolumeDb: number } | undefined
      this.log(
        `虚拟声卡状态：静音=${cableState?.inputMuted ?? '?'} 启用=${cableItem?.sceneItemEnabled ?? '?'} ` +
          `音量=${cableVolume?.inputVolumeDb ?? '?'}dB 源名=${this.name('cable')}`,
      )
      // 到这一步才记账（和媒体源那条路同一个理由：取用不算数，真播才算）
      // The remaining window is padded below, so no fictional time credit is earned.
      const speechStarted = Date.now()
      const played = await this.cable.play(reply.file)
      if (!played.ok) {
        this.log(`虚拟声卡播报失败，恢复原配音：${played.error ?? '未知原因'}`)
        return 'failed'
      }
      completed = true
      this.log(
        `互动语音已播放（虚拟声卡，起播 ${played.openMs?.toFixed(0) ?? '?'}ms）：${reply.text}`,
      )
      const padding = (window.end - cursor) * 1000 - (Date.now() - speechStarted)
      if (padding > 0) await delay(padding, undefined, { signal })
      return 'played'
    } catch (error) {
      if (signal.aborted) return 'aborted'
      this.log(`虚拟声卡播报异常，恢复原配音：${String(error)}`)
      return 'failed'
    } finally {
      try {
        await this.client
          .call('SetInputMute', { inputName: this.name('cable'), inputMuted: true })
          .catch(() => {})
        if (paused && !signal.aborted) {
          // 播出去了才跳游标 —— 没播成的话旁白要从原地继续，不能吞掉内容
          if (completed)
            await this.client.call('SetMediaInputCursor', {
              inputName: this.name('audio'),
              mediaCursor: window.end * 1000,
            })
          if (muted)
            await this.client.call('SetInputMute', {
              inputName: this.name('audio'),
              inputMuted: false,
            })
          await this.client.call('TriggerMediaInputAction', {
            inputName: this.name('audio'),
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
          })
        }
      } catch {
        // 恢复失败不该把整条导播带崩；下一句会重新对齐
      }
    }
  }
  /**
   * 这句没用上 —— **放回队列**，后面的气口还能用。
   * 丢掉的话这句就永远消失了（`take` 是移除操作）。
   *
   * `reason` 会进日志：这条路上有七八处拒绝，不写原因就只能靠猜。
   */
  private releaseSpeech(reply: ReadySpeech, reason: string): 'missed' {
    this.log(`这一句没用上（${reason}），放回队列等下一个气口`)
    if (reply.valid() && reply.expiresAt > Date.now()) this.speech?.put(reply)
    else reply.done?.('expired')
    return 'missed'
  }
  private async settleNarration(signal: AbortSignal) {    await this.narrationQueue
    signal.throwIfAborted()
    const failure = this.narrationFailure
    this.narrationQueue = Promise.resolve()
    this.narrationFailure = undefined
    await this.visible('audio', false)
    if (failure) throw failure
  }
  async overview(tray: DirectorTray, signal: AbortSignal) {
    return this.diagnosticScope({ phase: 'A', step: 'overview' }, () =>
      this.showOverview(tray, signal),
    )
  }
  private async showOverview(tray: DirectorTray, signal: AbortSignal) {
    this.lastTray = tray
    signal.throwIfAborted()
    await this.settleNarration(signal)
    await this.visible('image', false)
    await this.hideOverlayGroups()
    await this.showStateGroup(tray.stateGroup)
    // 回总览就把引导层摘掉 —— 它只在 B/C 挂
    await this.showCta(undefined)
    this.activeSequence = undefined
    this.lastStep = undefined
    // 回到总览就作废：这里的转场由 A 阶段自己那条规则兜
    this.productBoundary = false
  }
  async completeOverview(signal: AbortSignal) {
    return this.diagnosticScope({ phase: 'A', step: 'completeOverview' }, async () => {
      await this.settleNarration(signal)
      this.displayMode = 'A'
      this.displayPhase = 'A'
      this.activeSequence = undefined
      this.lastStep = undefined
    })
  }
  async narration(file: string, signal: AbortSignal) {
    const duration = await this.media.duration(file, signal)
    await this.mediaPlay('audio', file, signal)
    await this.waitEnd('audio', duration, signal)
    await this.visible('audio', false)
  }
  async product(p: DirectorProduct, signal: AbortSignal, phase: 'B' | 'C') {
    return this.diagnosticScope({ phase, step: 'product', productId: p.id }, async () => {
      signal.throwIfAborted()
      // 记下来，等这个商品播完回总览时按它的「回程」转场设置走
      // 换了商品就要给一次转场（B 接 B 的情况靠它）
      this.productBoundary = this.lastProduct !== undefined && this.lastProduct.id !== p.id
      this.lastProduct = p
      await this.settleNarration(signal)
      await this.showStateGroup(p.stateGroups?.[phase])
      // B/C 才挂引导层（催评论），回 A 会摘掉
      await this.showCta(this.ctaFileFor(this.lastTray))
    })
  }
  async completePhase(signal: AbortSignal) {
    await this.settleNarration(signal)
  }
  async step(
    step: DirectorStep,
    p: DirectorProduct | undefined,
    signal: AbortSignal,
    onCue?: (cue: DirectorCue) => Promise<void>,
    phase: 'A' | 'B' | 'C' = p ? 'B' : 'A',
    lastInPhase = true,
  ) {
    const run = async () => {
      this.diagnostics?.record('step.start')
      try {
        await this.playStep(step, p, signal, onCue, phase, lastInPhase)
        this.diagnostics?.record('step.end')
      } catch (error) {
        this.diagnostics?.record('step.failure')
        throw error
      }
    }
    return this.diagnostics
      ? this.diagnostics.scope(
          { phase, step: step.name, stepId: step.id, file: step.file, productId: p?.id },
          run,
        )
      : run()
  }
  private async playStep(
    step: DirectorStep,
    p: DirectorProduct | undefined,
    signal: AbortSignal,
    onCue?: (cue: DirectorCue) => Promise<void>,
    phase: 'A' | 'B' | 'C' = p ? 'B' : 'A',
    lastInPhase = true,
  ) {
    if (this.disabledSteps.has(step.id)) return
    signal.throwIfAborted()
    const continuousAudio =
      isDirectorVideoStep(step) && (step.audioOverflow || 'continue') === 'continue'
    if (!continuousAudio) await this.settleNarration(signal)
    await this.showStepGroup(step.stepGroup)
    const index = this.variants.get(step.id) || 0
    this.variants.set(step.id, index + 1)
    const choice = directorStepPlaybackChoice(step, index)
    const pairedVariants = directorStepOverlayVariants(step)
    const variantId = pairedVariants.length ? pairedVariants[index % pairedVariants.length].id : undefined
    await this.visible('image', false)
    await this.hideOverlayGroups()
    const shouldTransition =
      // 队列优先时 B 直接接 B，没有 A 阶段兜转场，这里补上
      this.productBoundary ||
      this.displayMode === 'A' ||
      this.displayMode === 'transition' ||
      (phase === 'A' && this.displayMode === 'content' && !this.lastStep) ||
      // A 播到一半就被点播打断时，上面三条一个都不成立（displayMode 还是
      // 'content'、lastStep 还留着），于是「总览 → 商品」被硬切。这里补上：
      // 屏幕上明明是 A 的画面，却要切进 B/C，那就是跨阶段，必须给转场。
      (this.displayPhase === 'A' && phase !== 'A')
    this.productBoundary = false
    if (isDirectorVideoStep(step)) {
      const versions = this.compiled.get(step.id)!
      const selected = versions.find(version => version.audio === choice.audio) || versions[0]
      const sequence = this.sequences.get(step.id)
      if (sequence) {
        let key = this.activeSequence?.key
        const audio = choice.audio
        let overlayShown = false
        if (!key || this.activeSequence?.id !== sequence.sequenceId) {
          const playSequence = async () => {
            const nextKey = await this.playVideo(
              sequence.file,
              signal,
              false,
              true,
              this.displayMode === 'A',
            )
            await this.showOverlayGroup(step, choice.overlayGroup)
            overlayShown = true
            return nextKey
          }
          key = shouldTransition
            ? await this.phaseSwitch(playSequence, signal, phase, p)
            : await playSequence()
          this.activeSequence = { id: sequence.sequenceId, key }
        }
        if (!overlayShown) await this.showOverlayGroup(step, choice.overlayGroup)
        this.displayMode = phase === 'A' && lastInPhase ? 'A' : 'content'
        this.displayPhase = phase
        if (audio) {
          if (continuousAudio)
            this.queueStepNarration(step, audio, signal, {
              variantId,
              key,
              endMs: sequence.endMs,
              videoSeconds: (sequence.endMs - sequence.startMs) / 1000,
            })
          else await this.mediaPlay('audio', audio, signal)
        }
        await Promise.all([
          this.waitCursor(
            key,
            sequence.endMs,
            (sequence.endMs - sequence.startMs) / 1000,
            sequence.last,
            signal,
          ),
          this.runCues(step, signal, onCue),
        ])
        if (!continuousAudio) await this.visible('audio', false)
        await this.hideOverlayGroups()
        if (sequence.last) this.activeSequence = undefined
        this.lastStep = step
        return
      }
      this.activeSequence = undefined
      const seamless = Boolean(
        this.lastStep !== undefined &&
          isDirectorVideoStep(this.lastStep) &&
          this.lastStep.file === step.file &&
          this.lastStep.end > 0 &&
          Math.abs(this.lastStep.end - step.start) < 0.05,
      )
      const playStep = async () => {
        const key = await this.playVideo(
          selected.file,
          signal,
          false,
          false,
          seamless || this.displayMode === 'A',
        )
        await this.showOverlayGroup(step, choice.overlayGroup)
        return key
      }
      const key = shouldTransition
        ? await this.phaseSwitch(playStep, signal, phase, p)
        : await playStep()
      if (continuousAudio && choice.audio)
        this.queueStepNarration(step, choice.audio, signal, {
          variantId,
          key,
          endMs: selected.duration * 1000,
          videoSeconds: selected.duration,
        })
      this.displayMode = phase === 'A' && lastInPhase ? 'A' : 'content'
      this.displayPhase = phase
      await Promise.all([
        this.waitEnd(key, selected.duration, signal),
        this.runCues(step, signal, onCue),
      ])
      await this.hideOverlayGroups()
      this.lastStep = step
    } else {
      // Preserve the last video frame under the image, silence the underlying video.
      const showImage = async () => {
        const key = this.activeVideo || 'video'
        const state = await this.client.call('GetMediaInputStatus', { inputName: this.name(key) })
        if (state.mediaState === 'OBS_MEDIA_STATE_PLAYING')
          await this.client.call('TriggerMediaInputAction', {
            inputName: this.name(key),
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
          })
        await this.client.call('SetInputMute', { inputName: this.name(key), inputMuted: true })
        await this.settings('image', { file: step.file })
        await this.visible('image', true)
      }
      if (shouldTransition) await this.phaseSwitch(showImage, signal, phase, p)
      else await showImage()
      this.displayMode = phase === 'A' && lastInPhase ? 'A' : 'content'
      this.displayPhase = phase
      await Promise.all([
        step.audio.length
          ? this.narration(step.audio[index % step.audio.length], signal)
          : delay(step.duration * 1000, undefined, { signal }),
        this.runCues(step, signal, onCue),
      ])
      await this.visible('image', false)
      this.lastStep = step
    }
  }
  async transition(file: string, signal: AbortSignal) {
    return this.diagnosticScope({ phase: 'transition', file }, () =>
      this.playTransition(file, signal),
    )
  }
  private async playTransition(file: string, signal: AbortSignal) {
    await this.settleNarration(signal)
    const normalized = this.normalized.get(file)
    const playTransition = async () => {
      await this.hideOverlayGroups()
      await this.hideStateGroups()
      for (const key of this.inputs.keys())
        if (!VIDEO_KEYS.includes(key as VideoKey) && key !== 'notice')
          await this.visible(key, false)
      return this.playVideo(normalized?.file || file, signal, false, false, true)
    }
    const key =
      this.displayMode === 'A' || this.displayMode === 'content'
        ? await this.phaseSwitch(playTransition, signal)
        : await playTransition()
    await this.waitEnd(
      key,
      normalized?.duration || (await this.media.duration(file, signal)),
      signal,
    )
    this.displayMode = 'transition'
    this.displayPhase = 'transition'
    this.activeSequence = undefined
    this.lastStep = undefined
  }
  async stop(holdFrame = false) {
    return this.diagnosticScope({ phase: 'stopping' }, () => this.stopOutput(holdFrame))
  }
  private async stopOutput(holdFrame = false) {
    clearTimeout(this.noticeTimer)
    await this.narrationQueue.catch(() => {})
    this.narrationQueue = Promise.resolve()
    this.narrationFailure = undefined
    /**
     * 清掉窗口 —— 不然导播停了、OBS 那边什么都停了，互动层还能从残留的窗口
     * 里瞄到一个「来得及的气口」，然后白白合成一句没地方放的话。
     */
    speechWindows.end()
    if (this.defocus) {
      try {
        await this.defocus.reset()
      } catch (error) {
        this.log(`失焦滤镜清理失败，请在 OBS 检查主画面：${String(error)}`)
      }
      this.defocus = undefined
    }
    if (this.ready || this.inputs.size) {
      try {
        await this.hideOverlayGroups()
      } catch {}
      try {
        await this.hideStateGroups()
      } catch {}
      // 出错停机时把画面冻在最后一帧，而不是把视频源关掉 —— 关掉就是给观众
      // 一路黑屏，那比停住一帧难看得多。用户主动停止时不冻（本来就要收干净）。
      const holdKey = holdFrame ? this.activeVideo : undefined
      for (const key of [...VIDEO_KEYS, 'audio', 'speech']) {
        try {
          if (key === holdKey) {
            await this.client.call('TriggerMediaInputAction', {
              inputName: this.name(key),
              mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
            })
            await this.client.call('SetInputMute', { inputName: this.name(key), inputMuted: true })
          } else {
            await this.client.call('TriggerMediaInputAction', {
              inputName: this.name(key),
              mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
            })
          }
        } catch {}
      }
      for (const key of this.inputs.keys()) {
        // 冻帧那一帧要留在画面上，其余照旧全关
        if (key === holdKey) continue
        try {
          await this.visible(key, false)
        } catch {}
      }
      if (holdKey) this.log(`导播已停止，画面停在最后一帧（${holdKey}）`)
      // On stop/failure keep a silent tray, rather than leaving a black live output.
      if (this.ready && this.lastTray) {
        try {
          if (holdKey) {
            // 冻住的是某个商品的画面，就配它自己的名牌 —— 总览那套编号牌对不上。
            await this.showStateGroup(this.lastProduct?.stateGroups?.B)
          } else {
            await this.overview(this.lastTray, new AbortController().signal)
          }
        } catch {}
      }
    }
    await this.client.disconnect()
    this.ready = false
    this.displayMode = 'none'
    this.displayPhase = 'none'
    this.productBoundary = false
    this.activeSequence = undefined
    this.lastStep = undefined
  }
  async notice(text: string) {
    if (!this.ready) return
    clearTimeout(this.noticeTimer)
    await this.settings('notice', { text: text.slice(0, 80) })
    await this.visible('notice', true)
    this.noticeTimer = setTimeout(() => {
      void this.visible('notice', false).catch(() => {})
    }, 6000)
  }
}
