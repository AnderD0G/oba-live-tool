import type {
  ObsEffectRule,
  ObsEnterEffectSettings,
  ObsSceneMetadata,
  ObsSourceMetadata,
} from '../../../shared/obsEffect'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultObsEnterEffectSettings, OBS_ALL_INSTANT_INPUTS, OBS_PREMIUM_WELCOME_INPUT } from '../../../shared/obsEffect'
import type { ObsArtTextAction } from '../../../shared/hooks'
import { type ObsRpcClient, ObsWebSocketClient } from './ObsWebSocketClient'
import { ObsWelcomeEffects } from './ObsWelcomeEffects'
import { isNativeWelcomeSourceUrl, welcomePreset } from '../../../shared/obsWelcome'

interface ObsEffectLogger {
  info(...data: unknown[]): void
  error(...data: unknown[]): void
}

type ObsOperationKind = 'effect' | 'display' | 'control' | 'cleanup' | 'stop'
interface ObsOperation {
  kind: ObsOperationKind
  action: () => Promise<unknown>
  queuedAt: number
  operationKey?: string
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

class ObsOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

type EffectTarget = Pick<
  ObsEffectRule,
  'sceneName' | 'sourceName' | 'sourceContainerName' | 'durationMs'
>

export type ArtTextDisplayTarget = Pick<
  ObsArtTextAction,
  'inputName' | 'style' | 'holdMs' | 'priority' | 'delivery' | 'presetId'
> & { welcomeLane?: 'premium' }

export interface ArtTextDeliveryResult {
  delivery: 'immediate'
  state: 'started' | 'superseded'
  supersededPrevious: boolean
}

interface ImmediateArtTextJob {
  target: ArtTextDisplayTarget
  text: string
  token: string
  supersededPrevious: boolean
  resolve: (result: ArtTextDeliveryResult) => void
  reject: (error: unknown) => void
}

interface ImmediateArtTextWork {
  inputName: string
  job: ImmediateArtTextJob
  running: boolean
  timer?: ReturnType<typeof setTimeout>
  displayedToken?: string
  displayedNativeKind?: NativeArtTextKind
}

interface QueuedArtTextWork {
  inputName: string
  displayedToken?: string
  controller: AbortController
  reject: (error: unknown) => void
}

type NativeArtTextKind = 'welcome' | 'like' | 'follow'

function nativeArtTextKind(url: URL, inputName: string): NativeArtTextKind | undefined {
  if (
    url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
    url.searchParams.get('transport') !== 'native' || url.searchParams.get('channel') !== inputName
  ) return undefined
  return /^\/obs\/instant\/(welcome|like|follow)\.html$/.exec(url.pathname)?.[1] as NativeArtTextKind | undefined
}

function validateEffect(effect: EffectTarget) {
  if (!effect.sceneName.trim()) throw new Error('请选择 OBS 场景')
  if (!effect.sourceName.trim()) throw new Error('请选择 OBS 来源')
  if (
    !Number.isInteger(effect.durationMs) ||
    effect.durationMs < 100 ||
    effect.durationMs > 600_000
  ) {
    throw new Error('显示时长必须是 100 到 600000 毫秒之间的整数')
  }
}

export function normalizeObsSettings(
  input: Partial<ObsEnterEffectSettings>,
): ObsEnterEffectSettings {
  const isLegacy = !Array.isArray(input.effects)
  const settings = {
    ...structuredClone(defaultObsEnterEffectSettings),
    ...structuredClone(input),
    effects: Array.isArray(input.effects) ? structuredClone(input.effects) : [],
  }
  if (isLegacy && settings.sceneName && settings.sourceName) {
    settings.effects.push({
      id: 'legacy-default',
      enabled: true,
      minFansLevel: 0,
      sceneName: settings.sceneName,
      sourceName: settings.sourceName,
      sourceContainerName: settings.sourceContainerName,
      durationMs: settings.durationMs,
    })
  }
  return settings
}

export function validateObsSettings(settings: ObsEnterEffectSettings) {
  validateObsConnection(settings.url)
  if (!settings.enabled) return
  if (!settings.effects.some(effect => effect.enabled)) {
    throw new Error('请至少添加并启用一个等级特效')
  }
  for (const effect of settings.effects) {
    validateEffect(effect)
    if (!Number.isInteger(effect.minFansLevel) || effect.minFansLevel < 0) {
      throw new Error('最低等级必须是大于或等于 0 的整数')
    }
  }
}

export function validateObsConnection(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OBS WebSocket 地址无效')
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('OBS 地址必须使用 ws:// 或 wss://')
}

export class ObsEnterEffectService {
  private welcome: ObsWelcomeEffects
  private settings: ObsEnterEffectSettings
  private activeTargets = new Map<
    string,
    {
      sceneName: string
      sceneItemId: number
      timer: ReturnType<typeof setTimeout>
      expired: boolean
    }
  >()
  private lastGroupSelection = new Map<string, number>()
  private groupPlaybacks = new Map<string, string>()
  private operationQueue: ObsOperation[] = []
  private operationRunning = false
  private sourceCleanupPending = false
  private suspendedEffects = 0
  private stopWork?: Promise<void>
  private cleanupFailed = false
  private rejectedEffects = { busy: 0, stale: 0, stopped: 0, superseded: 0 }
  private immediateArtText = new Map<string, ImmediateArtTextWork>()
  private cancelledImmediateArtText = new Map<string, ImmediateArtTextWork>()
  private artTextPresentation = new Map<string, 'wide' | 'focus'>()
  private artTextRunning = false
  private activeArtText?: QueuedArtTextWork
  private cancelledArtText?: QueuedArtTextWork
  private artTextQueue: Array<{
    target: ArtTextDisplayTarget
    text: string
    resolve: () => void
    reject: (error: unknown) => void
  }> = []

  constructor(
    settings: ObsEnterEffectSettings,
    private readonly client: ObsRpcClient = new ObsWebSocketClient(),
    private readonly logger: ObsEffectLogger = console,
    private readonly createClient: () => ObsRpcClient = () => new ObsWebSocketClient(),
  ) {
    this.settings = normalizeObsSettings(settings)
    this.welcome = new ObsWelcomeEffects(this.client,
      () => this.client.connect(this.settings.url, this.settings.password),
      (action, kind, cleanupKey) => this.enqueue(action, kind, cleanupKey), (target, text) => this.showArtText(target, text),
      inputName => this.clearImmediateArtTextChannel(inputName),
      error => this.logger.error('欢迎素材操作失败', error))
  }

  getWelcomePresets() { return this.welcome.catalog() }
  showWelcomePreset(target: ArtTextDisplayTarget, text: string, presetId: unknown) {
    if (this.suspendedEffects || this.cleanupFailed) return Promise.reject(this.effectRejection('stopped'))
    return this.welcome.show(target, text, presetId)
  }

  async configure(settings: ObsEnterEffectSettings) {
    const normalized = normalizeObsSettings(settings)
    validateObsSettings(normalized)
    if (this.operationQueue.filter(job => job.kind === 'control').length >= 16)
      throw new ObsOperationError('OBS_CONTROL_BUSY', 'OBS 控制队列繁忙，请稍后重试')
    this.suspendPendingEffects()
    const welcomeWork = this.welcome.stop()
    const immediateWork = this.cancelImmediateArtText()
    const queuedWork = this.cancelQueuedArtText()
    const welcomeResult = welcomeWork.then(() => undefined, error => error)
    try {
      await this.enqueue(async () => {
        const welcomeError = await welcomeResult
        await this.cleanupStoppedEffects(welcomeError, immediateWork, queuedWork)
        this.settings = normalized
      })
    } finally { this.suspendedEffects -= 1 }
  }

  getSettings() {
    return structuredClone(this.settings)
  }

  async test(settings: ObsEnterEffectSettings) {
    validateObsConnection(settings.url)
    validateEffect(settings)
    const client = this.createClient()
    try {
      await client.connect(settings.url, settings.password)
      await this.findSceneItem(settings, client)
    } finally {
      await client.disconnect()
    }
  }

  async discover(url: string, password: string): Promise<ObsSceneMetadata[]> {
    validateObsConnection(url)
    const client = this.createClient()
    try {
      await client.connect(url, password)
      const response = await client.call('GetSceneList')
      const scenes = Array.isArray(response.scenes) ? response.scenes : []
      const result: ObsSceneMetadata[] = []
      for (const scene of scenes) {
        if (!scene || typeof scene !== 'object') continue
        const sceneName = (scene as Record<string, unknown>).sceneName
        if (typeof sceneName !== 'string') continue
        result.push({
          name: sceneName,
          sources: await this.listSources(client, sceneName),
        })
      }
      return result
    } finally {
      await client.disconnect()
    }
  }

  async preview(settings: ObsEnterEffectSettings) {
    validateObsConnection(settings.url)
    validateEffect(settings)
    const client = this.createClient()
    await client.connect(settings.url, settings.password)
    try {
      const sceneItemId = await this.findSceneItem(settings, client)
      const sceneName = settings.sourceContainerName || settings.sceneName
      const instant = await this.prepareInstantSource(client, settings.sourceName)
      if (instant) {
        await this.playInstantSource(client, sceneName, sceneItemId, instant)
        await client.disconnect()
        return
      }
      await client.call('SetSceneItemEnabled', {
        sceneName,
        sceneItemId,
        sceneItemEnabled: true,
      })
      setTimeout(() => {
        void client
          .call('SetSceneItemEnabled', {
            sceneName,
            sceneItemId,
            sceneItemEnabled: false,
          })
          .catch(error => {
            this.logger.error(
              `关闭手动试播来源失败：${error instanceof Error ? error.message : String(error)}`,
            )
          })
          .finally(() => client.disconnect())
      }, settings.durationMs)
    } catch (error) {
      await client.disconnect()
      throw error
    }
  }

  handleLiveMessage(message: LiveMessage) {
    if (!this.settings.enabled || message.msg_type !== 'tiktok_member') return
    const usesFansClubLevel = (message.fans_club_level ?? 0) > 0
    const viewerLevel = usesFansClubLevel ? message.fans_club_level : message.pay_level
    const levelType = usesFansClubLevel ? '粉丝团' : '送礼'
    const effect = this.settings.effects
      .filter(rule => rule.enabled && (viewerLevel === undefined ? rule.minFansLevel === 0 : rule.minFansLevel <= viewerLevel))
      .sort((a, b) => b.minFansLevel - a.minFansLevel)[0]
    if (!effect) {
      this.logger.info(
        `TikTok 用户 ${message.nick_name} 的${levelType}等级为 ${viewerLevel}，没有匹配的 OBS 特效`,
      )
      return
    }
    void this.trigger(message.nick_name, effect, viewerLevel, levelType).catch(error => {
      this.logger.error(
        `触发进场特效失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  trigger(
    viewerName = '测试观众',
    effect = this.settings.effects.find(rule => rule.enabled),
    viewerLevel: number | undefined = 0,
    levelType = '粉丝团',
  ) {
    if (!this.settings.enabled) return Promise.reject(new Error('请先启用并保存 OBS 进场特效'))
    if (!effect) return Promise.reject(new Error('没有可用的 OBS 特效规则'))
    return this.executeEffect(
      effect,
      `TikTok 用户 ${viewerName} 进入直播间（${viewerLevel === undefined ? '等级未知' : `${levelType} ${viewerLevel} 级`}）`,
    )
  }

  executeEffect(
    effect: ObsEffectRule,
    triggerName = '钩子',
    textUpdate?: { inputName: string; text: string },
  ) {
    return this.enqueue(async () => {
      await this.client.connect(this.settings.url, this.settings.password)
      const instant = await this.prepareInstantSource(this.client, effect.sourceName, textUpdate?.text || triggerName)
      if (textUpdate) {
        await this.client.call('SetInputSettings', {
          inputName: textUpdate.inputName,
          inputSettings: { text: textUpdate.text },
          overlay: true,
        })
      }
      const sceneItemId = await this.findSceneItem(effect, this.client)
      const sceneName = effect.sourceContainerName || effect.sceneName
      if (instant) {
        await this.playInstantSource(this.client, sceneName, sceneItemId, instant)
        this.clearTargetTimer(targetKey(sceneName, sceneItemId))
      } else {
        await this.client.call('SetSceneItemEnabled', {
          sceneName,
          sceneItemId,
          sceneItemEnabled: true,
        })
        this.scheduleHide(sceneName, sceneItemId, effect.durationMs)
      }
      this.logger.info(`${triggerName}，已触发 ${effect.sourceName}`)
    }, 'effect')
  }

  playRandomGroup(
    target: {
      sceneName: string
      groupName: string
      groupContainerName?: string
      durationMs: number
      avoidImmediateRepeat: boolean
    },
    triggerName = '钩子',
  ) {
    validateDuration(target.durationMs)
    if (!target.sceneName.trim() || !target.groupName.trim()) throw new Error('请选择 OBS 素材组')
    return this.enqueue(async () => {
      await this.client.connect(this.settings.url, this.settings.password)
      const groupContainerName = target.groupContainerName || target.sceneName
      const groupSceneItemId = await this.findSceneItem(
        {
          sceneName: target.sceneName,
          sourceName: target.groupName,
          sourceContainerName: groupContainerName,
          durationMs: target.durationMs,
        },
        this.client,
      )
      const response = await this.client.call('GetGroupSceneItemList', {
        sceneName: target.groupName,
      })
      const candidates = (Array.isArray(response.sceneItems) ? response.sceneItems : [])
        .filter(item => item && typeof item === 'object')
        .map(item => item as Record<string, unknown>)
        .filter(
          item =>
            typeof item.sourceName === 'string' &&
            typeof item.sceneItemId === 'number' &&
            item.isGroup !== true,
        )
      if (!candidates.length) throw new Error(`OBS 素材组“${target.groupName}”中没有可播放来源`)

      const groupKey = `${groupContainerName}\u0000${target.groupName}`
      const previousId = this.lastGroupSelection.get(groupKey)
      const available =
        target.avoidImmediateRepeat && candidates.length > 1
          ? candidates.filter(item => item.sceneItemId !== previousId)
          : candidates
      const selected = available[Math.floor(Math.random() * available.length)]

      for (const candidate of candidates) {
        const sceneItemId = candidate.sceneItemId as number
        const key = targetKey(target.groupName, sceneItemId)
        this.clearTargetTimer(key)
        await this.client.call('SetSceneItemEnabled', {
          sceneName: target.groupName,
          sceneItemId,
          sceneItemEnabled: candidate === selected,
        })
      }
      const selectedId = selected.sceneItemId as number
      this.lastGroupSelection.set(groupKey, selectedId)
      const playbackToken = crypto.randomUUID()
      this.groupPlaybacks.set(groupKey, playbackToken)
      this.clearTargetTimer(targetKey(groupContainerName, groupSceneItemId))
      if (isMediaInputKind(selected.inputKind)) {
        await this.client.call('TriggerMediaInputAction', {
          inputName: selected.sourceName,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
        })
      } else if (selected.inputKind === 'browser_source') {
        await this.client.call('PressInputPropertiesButton', {
          inputName: selected.sourceName,
          propertyName: 'refreshnocache',
        })
      }
      await this.client.call('SetSceneItemEnabled', {
        sceneName: groupContainerName,
        sceneItemId: groupSceneItemId,
        sceneItemEnabled: true,
      })
      this.scheduleHide(target.groupName, selectedId, target.durationMs)
      this.scheduleHide(groupContainerName, groupSceneItemId, target.durationMs)
      if (isMediaInputKind(selected.inputKind)) {
        this.hideGroupWhenMediaEnds({
          groupKey,
          playbackToken,
          groupContainerName,
          groupSceneItemId,
          groupName: target.groupName,
          selectedId,
          inputName: selected.sourceName as string,
        })
      }
      this.logger.info(
        `${triggerName}，已从素材组“${target.groupName}”随机触发 ${selected.sourceName}`,
      )
      return { sourceName: selected.sourceName as string }
    }, 'effect')
  }

  setText(inputName: string, text: string) {
    if (!inputName.trim()) return Promise.reject(new Error('请选择 OBS 文字来源'))
    return this.enqueue(async () => {
      await this.client.connect(this.settings.url, this.settings.password)
      await this.client.call('SetInputSettings', {
        inputName,
        inputSettings: { text },
        overlay: true,
      })
    }, 'effect')
  }

  async setArtTextPresentation(inputNames: string[], mode: 'wide' | 'focus') {
    if (!['wide', 'focus'].includes(mode)) throw new Error('艺术字显示模式无效')
    const names = [...new Set(inputNames)]
    if (names.some(name => !name.trim())) throw new Error('艺术字来源不能为空')
    if (this.operationQueue.filter(job => job.kind === 'control').length >= 16)
      throw new ObsOperationError('OBS_CONTROL_BUSY', 'OBS 控制队列繁忙，请稍后重试')
    for (const name of names) this.artTextPresentation.set(name, mode)
    return this.enqueue(async () => {
      const result: { updated: string[]; skipped: Array<{ inputName: string; reason: string }> } = {
        updated: [],
        skipped: [],
      }
      if (!names.length) return result
      try {
        await this.client.connect(this.settings.url, this.settings.password)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        result.skipped = names.map(inputName => ({ inputName, reason }))
        return result
      }
      for (const inputName of names) {
        try {
          const response = await this.client.call('GetInputSettings', { inputName })
          const currentUrl = (response.inputSettings as Record<string, unknown> | undefined)?.url
          if (typeof currentUrl !== 'string' || !currentUrl)
            throw new Error('OBS 艺术字浏览器来源没有设置 URL')
          const url = new URL(currentUrl)
          url.searchParams.set('mode', this.artTextPresentation.get(inputName) || mode)
          if (url.toString() !== currentUrl) {
            await this.client.call('SetInputSettings', {
              inputName,
              inputSettings: { url: url.toString() },
              overlay: true,
            })
          }
          result.updated.push(inputName)
        } catch (error) {
          result.skipped.push({
            inputName,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return result
    })
  }

  stop() {
    if (this.stopWork) return this.stopWork
    this.suspendPendingEffects()
    const welcomeWork = this.welcome.stop()
    const immediateWork = this.cancelImmediateArtText()
    const queuedWork = this.cancelQueuedArtText()
    const welcomeResult = welcomeWork.then(() => undefined, error => error)
    this.stopWork = this.enqueue(async () => {
      const welcomeError = await welcomeResult
      await this.cleanupStoppedEffects(welcomeError, immediateWork, queuedWork)
    }, 'stop').finally(() => {
      this.suspendedEffects -= 1
      this.stopWork = undefined
    })
    return this.stopWork
  }

  private async findSceneItem(settings: EffectTarget, client: ObsRpcClient) {
    const response = await client.call('GetSceneItemId', {
      sceneName: settings.sourceContainerName || settings.sceneName,
      sourceName: settings.sourceName,
    })
    const sceneItemId = response.sceneItemId
    if (typeof sceneItemId !== 'number') throw new Error('OBS 未返回有效的来源 ID')
    return sceneItemId
  }

  private async listSources(
    client: ObsRpcClient,
    containerName: string,
    path = '',
    visited = new Set<string>(),
  ): Promise<ObsSourceMetadata[]> {
    if (visited.has(containerName)) return []
    visited.add(containerName)
    const response = await client.call(path ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
      sceneName: containerName,
    })
    const items = Array.isArray(response.sceneItems) ? response.sceneItems : []
    const sources: ObsSourceMetadata[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const data = item as Record<string, unknown>
      if (typeof data.sourceName !== 'string') continue
      const itemPath = path ? `${path} / ${data.sourceName}` : data.sourceName
      sources.push({
        name: data.sourceName,
        containerName,
        path: itemPath,
        isGroup: data.isGroup === true,
      })
      if (data.isGroup === true) {
        sources.push(...(await this.listSources(client, data.sourceName, itemPath, visited)))
      }
    }
    return sources
  }

  private scheduleHide(sceneName: string, sceneItemId: number, durationMs: number) {
    const key = targetKey(sceneName, sceneItemId)
    this.clearTargetTimer(key)
    const target = { sceneName, sceneItemId, expired: false, timer: undefined as unknown as ReturnType<typeof setTimeout> }
    target.timer = setTimeout(() => {
      if (this.activeTargets.get(key) !== target) return
      target.expired = true
      this.queueExpiredSourcesCleanup()
    }, durationMs)
    this.activeTargets.set(key, target)
  }

  private queueExpiredSourcesCleanup() {
    if (this.sourceCleanupPending) return
    this.sourceCleanupPending = true
    let complete = false
    void this.enqueue(async () => {
      for (const [key, target] of this.activeTargets) {
        if (!target.expired || this.activeTargets.get(key) !== target) continue
        clearTimeout(target.timer)
        await this.hideSource(target.sceneName, target.sceneItemId)
        if (this.activeTargets.get(key) === target) this.activeTargets.delete(key)
      }
      complete = true
    }, 'cleanup', 'expired-sources').catch(error => {
      this.logger.error(`关闭进场特效失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.sourceCleanupPending = false
      // A source that expires after the scan passed it gets a subsequent bounded pass.
      if (complete && [...this.activeTargets.values()].some(target => target.expired))
        this.queueExpiredSourcesCleanup()
    })
  }

  showArtText(target: ArtTextDisplayTarget, text: string) {
    if (this.suspendedEffects || this.cleanupFailed) return Promise.reject(this.effectRejection('stopped'))
    if ((target.welcomeLane !== undefined && (target.welcomeLane !== 'premium' || target.inputName !== OBS_PREMIUM_WELCOME_INPUT)) ||
        (target.inputName === OBS_PREMIUM_WELCOME_INPUT && target.welcomeLane !== 'premium'))
      return Promise.reject(new Error('贵宾欢迎需要独立原生来源与通道'))
    if (target.presetId !== undefined) {
      try { if (welcomePreset(target.presetId).kind !== 'html') throw new Error('媒体欢迎样式需要欢迎素材入口') }
      catch (error) { return Promise.reject(error) }
    }
    if (!target.inputName.trim() || !text.trim())
      return Promise.reject(new Error('艺术字来源和内容不能为空'))
    if (!Number.isInteger(target.holdMs) || target.holdMs < 500 || target.holdMs > 10_000)
      return Promise.reject(new Error('艺术字停留时间必须在 500 到 10000 毫秒之间'))
    if (target.delivery !== undefined && !['immediate', 'queued'].includes(target.delivery))
      return Promise.reject(new Error('艺术字显示方式无效'))
    if (target.delivery === 'immediate') return this.showImmediateArtText(target, text)
    return new Promise<void>((resolve, reject) => {
      if (this.artTextQueue.length >= 8) {
        let lowestIndex = 0
        for (let i = 1; i < this.artTextQueue.length; i++) {
          if ((this.artTextQueue[i].target.priority || 0) <=
              (this.artTextQueue[lowestIndex].target.priority || 0)) lowestIndex = i
        }
        if ((target.priority || 0) <= (this.artTextQueue[lowestIndex].target.priority || 0)) {
          reject(new Error('艺术字队列繁忙，请稍后重试'))
          return
        }
        const [displaced] = this.artTextQueue.splice(lowestIndex, 1)
        displaced.reject(new Error('艺术字队列繁忙，已优先显示高优先级事件'))
      }
      this.artTextQueue.push({ target, text, resolve, reject })
      void this.playNextArtText()
    })
  }

  private showImmediateArtText(target: ArtTextDisplayTarget, text: string) {
    return new Promise<ArtTextDeliveryResult>((resolve, reject) => {
      let work = this.immediateArtText.get(target.inputName)
      if (!work && this.immediateArtText.size >= 32) {
        reject(new Error('即时艺术字来源繁忙，请稍后重试'))
        return
      }
      const supersededPrevious = !!work
      if (work) {
        clearTimeout(work.timer)
        work.timer = undefined
        work.job.resolve({
          delivery: 'immediate',
          state: 'superseded',
          supersededPrevious: work.job.supersededPrevious,
        })
      }
      const job: ImmediateArtTextJob = {
        target: { ...target },
        text,
        token: crypto.randomUUID(),
        supersededPrevious,
        resolve,
        reject,
      }
      if (work) work.job = job
      else {
        work = { inputName: target.inputName, job, running: false }
        this.immediateArtText.set(target.inputName, work)
      }
      if (!work.running) this.startImmediateArtText(work)
    })
  }

  private ownsImmediateArtText(work: ImmediateArtTextWork, job: ImmediateArtTextJob) {
    return this.immediateArtText.get(work.inputName) === work && work.job === job
  }

  private startImmediateArtText(work: ImmediateArtTextWork) {
    work.running = true
    let job = work.job
    void this.enqueue(async () => {
      job = work.job
      if (!this.ownsImmediateArtText(work, job)) return
      await this.client.connect(this.settings.url, this.settings.password)
      if (!this.ownsImmediateArtText(work, job)) return
      const response = await this.client.call('GetInputSettings', { inputName: work.inputName })
      if (!this.ownsImmediateArtText(work, job)) return
      const originalUrl = (response.inputSettings as Record<string, unknown> | undefined)?.url
      if (typeof originalUrl !== 'string' || !originalUrl)
        throw new Error('OBS 艺术字浏览器来源没有设置 URL')
      const url = new URL(originalUrl)
      const mode = url.searchParams.get('mode')
      const presentation = this.artTextPresentation.get(work.inputName) || (mode === 'focus' ? 'focus' : 'wide')
      const kind = nativeArtTextKind(url, work.inputName)
      if (job.target.presetId && !isNativeWelcomeSourceUrl(originalUrl, work.inputName))
        throw new Error('精选欢迎样式需要正确的原生欢迎来源与通道')
      // Record ownership before the await so stop/configure can clear an acknowledged in-flight write.
      work.displayedToken = job.token
      work.displayedNativeKind = kind
      if (kind) {
        await this.emitNativeArtText({
          channel: work.inputName, kind, operation: 'show', token: job.token,
          text: job.text.trim().slice(0, 140), mode: presentation,
          style: job.target.style === 'random' ? 'gold' : job.target.style,
          holdMs: job.target.holdMs,
          ...(job.target.presetId ? { presetId: job.target.presetId } : {}),
          ...(job.target.welcomeLane ? { welcomeLane: job.target.welcomeLane } : {}),
        })
      } else {
        url.search = ''
        url.searchParams.set('mode', presentation)
        url.searchParams.set('text', job.text.trim().slice(0, 140))
        if (job.target.style !== 'random') url.searchParams.set('style', job.target.style)
        url.searchParams.set('hold', String(job.target.holdMs))
        if (job.target.presetId) url.searchParams.set('preset', job.target.presetId)
        url.searchParams.set('auto', '0')
        url.searchParams.set('r', job.token)
        await this.client.call('SetInputSettings', {
          inputName: work.inputName,
          inputSettings: { url: url.toString() },
          overlay: true,
        })
      }
      if (!this.ownsImmediateArtText(work, job)) return
      work.timer = setTimeout(() => {
        work.timer = undefined
        void this.enqueue(async () => {
          if (!this.ownsImmediateArtText(work, job)) return
          await this.clearImmediateArtTextUrl(work, () => this.ownsImmediateArtText(work, job))
          if (this.ownsImmediateArtText(work, job)) this.immediateArtText.delete(work.inputName)
        }, 'cleanup', `instant:${work.inputName}`).catch(error => {
          if (this.ownsImmediateArtText(work, job)) this.immediateArtText.delete(work.inputName)
          this.logger.error('清理即时艺术字失败', error)
        })
      }, job.target.holdMs + 950)
      job.resolve({
        delivery: 'immediate',
        state: 'started',
        supersededPrevious: job.supersededPrevious,
      })
    }, 'display').catch(error => {
      job.reject(error)
      if (this.ownsImmediateArtText(work, job)) this.immediateArtText.delete(work.inputName)
    }).finally(() => {
      work.running = false
      if (this.immediateArtText.get(work.inputName) === work && work.job !== job)
        this.startImmediateArtText(work)
    })
  }

  private cancelImmediateArtText() {
    for (const item of this.immediateArtText.values()) this.cancelledImmediateArtText.set(item.inputName, item)
    const work = [...this.cancelledImmediateArtText.values()]
    this.immediateArtText.clear()
    for (const item of work) {
      clearTimeout(item.timer)
      item.timer = undefined
      item.job.reject(new Error('即时艺术字已停止或 OBS 配置已更新'))
    }
    return work
  }

  private cancelQueuedArtText() {
    const work = this.activeArtText
    if (work && !work.controller.signal.aborted) {
      this.cancelledArtText = work
      work.controller.abort()
      work.reject(this.effectRejection('stopped'))
    }
    return this.cancelledArtText
  }

  private async clearImmediateArtTextChannel(inputName: string) {
    const work = this.immediateArtText.get(inputName)
    if (!work) return
    this.immediateArtText.delete(inputName)
    this.cancelledImmediateArtText.set(inputName, work)
    clearTimeout(work.timer)
    work.job.resolve({ delivery: 'immediate', state: 'superseded', supersededPrevious: true })
    await this.enqueue(async () => {
      await this.clearImmediateArtTextUrl(work)
      if (this.cancelledImmediateArtText.get(inputName) === work) this.cancelledImmediateArtText.delete(inputName)
    }, 'cleanup', `instant:${inputName}`)
  }

  private async clearCancelledImmediateArtText(work: ImmediateArtTextWork[]) {
    const errors: unknown[] = []
    for (const item of work) {
      if (this.cancelledImmediateArtText.get(item.inputName) !== item) continue
      try {
        await this.clearImmediateArtTextUrl(item)
        if (this.cancelledImmediateArtText.get(item.inputName) === item) this.cancelledImmediateArtText.delete(item.inputName)
      } catch (error) {
        this.logger.error('清理已取消的即时艺术字失败', error)
        errors.push(error)
      }
    }
    this.throwCleanupErrors(errors)
  }

  private async cleanupStoppedEffects(welcomeError: unknown, immediateWork: ImmediateArtTextWork[], queuedWork?: QueuedArtTextWork) {
    const errors: unknown[] = welcomeError === undefined ? [] : [welcomeError]
    const attempt = async (action: () => Promise<unknown>) => {
      try { await action() } catch (error) { errors.push(error) }
    }
    // The first lifecycle call drains admitted writes on their existing
    // connection. A failed call still disconnects, so only retries reconnect.
    if (this.cleanupFailed && (immediateWork.some(work => work.displayedToken) || queuedWork?.displayedToken || this.activeTargets.size))
      await attempt(() => this.client.connect(this.settings.url, this.settings.password))
    await attempt(() => this.clearCancelledImmediateArtText(immediateWork))
    if (queuedWork && this.cancelledArtText === queuedWork) await attempt(async () => {
      await this.clearImmediateArtTextUrl(queuedWork)
      if (this.cancelledArtText === queuedWork) this.cancelledArtText = undefined
    })
    await attempt(() => this.hideAllSources())
    await attempt(() => this.client.disconnect())
    this.cleanupFailed = errors.length > 0
    this.throwCleanupErrors(errors)
  }

  private throwCleanupErrors(errors: unknown[]) {
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors,
      `OBS 清理失败：${errors.map(error => error instanceof Error ? error.message : String(error)).join('；')}`)
  }

  private async clearImmediateArtTextUrl(
    work: Pick<ImmediateArtTextWork, 'inputName' | 'displayedToken' | 'displayedNativeKind'>,
    isCurrent = () => true,
  ) {
    if (!work.displayedToken) return
    if (work.displayedNativeKind) {
      if (!isCurrent()) return
      await this.emitNativeArtText({
        channel: work.inputName, kind: work.displayedNativeKind,
        operation: 'clear', token: work.displayedToken,
        ...(work.inputName === OBS_PREMIUM_WELCOME_INPUT ? {welcomeLane:'premium'} : {}),
      })
      return
    }
    const response = await this.client.call('GetInputSettings', { inputName: work.inputName })
    if (!isCurrent()) return
    const currentUrl = (response.inputSettings as Record<string, unknown> | undefined)?.url
    if (typeof currentUrl !== 'string') return
    const url = new URL(currentUrl)
    if (url.searchParams.get('r') !== work.displayedToken) return
    const mode = url.searchParams.get('mode')
    url.search = ''
    url.searchParams.set('mode', mode === 'focus' ? 'focus' : 'wide')
    url.searchParams.set('auto', '0')
    await this.client.call('SetInputSettings', {
      inputName: work.inputName,
      inputSettings: { url: url.toString() },
      overlay: true,
    })
  }

  private async prepareInstantSource(client: ObsRpcClient, inputName: string, text?: string) {
    if (!(OBS_ALL_INSTANT_INPUTS as readonly string[]).includes(inputName)) return
    const response = await client.call('GetInputSettings', { inputName })
    const originalUrl = (response.inputSettings as Record<string, unknown> | undefined)?.url
    if (response.inputKind !== 'browser_source' || typeof originalUrl !== 'string') return
    let url: URL
    try { url = new URL(originalUrl) } catch { return }
    const kind = nativeArtTextKind(url, inputName)
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\/obs\/instant\/(welcome|like|follow)\.html$/.test(url.pathname) &&
        (!kind || url.searchParams.getAll('transport').length !== 1 || url.searchParams.getAll('channel').length !== 1))
      throw new Error('秒闪来源配置无效：请检查原生播放模式与独立来源通道')
    if (!kind) return
    const samples = { welcome: '欢迎 测试观众 来到直播间', like: '谢谢 测试观众 的点赞', follow: '谢谢 测试观众 的关注' }
    return {
      channel: inputName, kind, operation: 'show', token: crypto.randomUUID(),
      text: text?.trim().slice(0, 140) || samples[kind],
      mode: this.artTextPresentation.get(inputName) || (url.searchParams.get('mode') === 'focus' ? 'focus' : 'wide'),
      style: 'arc', holdMs: inputName === OBS_PREMIUM_WELCOME_INPUT ? 3600 : 560,
      ...(inputName === OBS_PREMIUM_WELCOME_INPUT ? {welcomeLane:'premium'} : {}),
    }
  }

  private async playInstantSource(client: ObsRpcClient, sceneName: string, sceneItemId: number, event: Record<string, unknown>) {
    const before = await client.call('GetSceneItemEnabled', { sceneName, sceneItemId })
    if (typeof before.sceneItemEnabled !== 'boolean') throw new Error('无法读取秒闪来源的原可见状态')
    const wasEnabled = before.sceneItemEnabled
    try {
      if (!wasEnabled) await client.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true })
      // Successful native sources stay enabled as receivers; the document clears its own card.
      await this.emitNativeArtText(event, client)
    } catch (error) {
      if (!wasEnabled) {
        try { await client.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: false }) }
        catch (restoreError) { throw new AggregateError([error, restoreError], '秒闪播放失败，且 OBS 来源状态恢复失败') }
      }
      throw error
    }
  }

  private emitNativeArtText(event: Record<string, unknown>, client = this.client) {
    return client.call('CallVendorRequest', {
      vendorName: 'obs-browser',
      requestType: 'emit_event',
      requestData: { event_name: 'oba-instant-effect', event_data: event },
    })
  }

  private async playNextArtText() {
    if (this.artTextRunning) return
    this.artTextQueue.sort((a, b) => (b.target.priority || 0) - (a.target.priority || 0))
    const job = this.artTextQueue.shift()
    if (!job) return
    this.artTextRunning = true
    const work: QueuedArtTextWork = { inputName: job.target.inputName, controller: new AbortController(), reject: job.reject }
    this.activeArtText = work
    const owned = () => this.activeArtText === work && !work.controller.signal.aborted
    try {
      const { target, text } = job
      await this.enqueue(async () => {
        if (!owned()) return
        await this.client.connect(this.settings.url, this.settings.password)
        if (!owned()) return
        const response = await this.client.call('GetInputSettings', { inputName: target.inputName })
        if (!owned()) return
        const originalUrl = (response.inputSettings as Record<string, unknown> | undefined)?.url
        if (typeof originalUrl !== 'string' || !originalUrl)
          throw new Error('OBS 艺术字浏览器来源没有设置 URL')
        const url = new URL(originalUrl)
        url.search = ''
        url.searchParams.set('text', text.trim().slice(0, 140))
        if (target.style !== 'random') url.searchParams.set('style', target.style)
        url.searchParams.set('hold', String(target.holdMs))
        url.searchParams.set('auto', '0')
        work.displayedToken = crypto.randomUUID()
        url.searchParams.set('r', work.displayedToken)
        await this.client.call('SetInputSettings', {
          inputName: target.inputName,
          inputSettings: { url: url.toString() },
          overlay: true,
        })
      }, 'display')
      await delay(target.holdMs + 950, undefined, { signal: work.controller.signal })
      if (!this.artTextQueue.length && owned()) {
        await this.enqueue(async () => {
          if (owned()) await this.clearImmediateArtTextUrl(work, owned)
        }, 'cleanup', `queued-text:${target.inputName}`)
      }
      job.resolve()
    } catch (error) {
      job.reject(error)
    } finally {
      if (this.activeArtText === work) this.activeArtText = undefined
      this.artTextRunning = false
      void this.playNextArtText()
    }
  }

  private hideGroupWhenMediaEnds(target: {
    groupKey: string
    playbackToken: string
    groupContainerName: string
    groupSceneItemId: number
    groupName: string
    selectedId: number
    inputName: string
  }) {
    let seenPlaying = false
    let reading = false
    const selectedKey = targetKey(target.groupName, target.selectedId)
    const parentKey = targetKey(target.groupContainerName, target.groupSceneItemId)
    const selectedTarget = this.activeTargets.get(selectedKey)
    const parentTarget = this.activeTargets.get(parentKey)
    const started = Date.now()
    const interval = setInterval(() => {
      if (
        this.groupPlaybacks.get(target.groupKey) !== target.playbackToken ||
        !this.activeTargets.has(selectedKey)
      ) {
        clearInterval(interval)
        return
      }
      if (reading) return
      reading = true
      void this.client.call('GetMediaInputStatus', { inputName: target.inputName })
        .then(status => {
          if (this.groupPlaybacks.get(target.groupKey) !== target.playbackToken) return
          if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') seenPlaying = true
          if (
            !['OBS_MEDIA_STATE_ENDED', 'OBS_MEDIA_STATE_STOPPED'].includes(String(status.mediaState)) ||
            (!seenPlaying && Date.now() - started <= 750)
          ) return
          clearInterval(interval)
          this.groupPlaybacks.delete(target.groupKey)
          if (selectedTarget && this.activeTargets.get(selectedKey) === selectedTarget) selectedTarget.expired = true
          if (parentTarget && this.activeTargets.get(parentKey) === parentTarget) parentTarget.expired = true
          this.queueExpiredSourcesCleanup()
        })
        .catch(error => this.logger.error('读取特效播放状态失败', error))
        .finally(() => { reading = false })
    }, 250)
  }

  private async hideSource(sceneName: string, sceneItemId: number) {
    await this.client.call('SetSceneItemEnabled', {
      sceneName,
      sceneItemId,
      sceneItemEnabled: false,
    })
  }

  private async hideAllSources() {
    this.groupPlaybacks.clear()
    const errors: unknown[] = []
    for (const [key, target] of this.activeTargets) {
      clearTimeout(target.timer)
      try {
        await this.hideSource(target.sceneName, target.sceneItemId)
        if (this.activeTargets.get(key) === target) this.activeTargets.delete(key)
      } catch (error) { errors.push(error) }
    }
    this.throwCleanupErrors(errors)
  }

  private clearTargetTimer(key: string) {
    const target = this.activeTargets.get(key)
    if (!target) return
    clearTimeout(target.timer)
    this.activeTargets.delete(key)
  }

  getOperationQueueState() {
    const count = (kind: ObsOperationKind) => this.operationQueue.filter(job => job.kind === kind).length
    return {
      active: this.operationRunning,
      queuedEffects: count('effect'), queuedControls: count('control'),
      queuedDisplays: count('display'), queuedCleanup: count('cleanup'), queuedStop: count('stop'),
      rejectedEffects: { ...this.rejectedEffects },
    }
  }

  private effectRejection(reason: 'busy' | 'stale' | 'stopped' | 'superseded') {
    this.rejectedEffects[reason] += 1
    const messages = {
      busy: 'OBS 特效队列繁忙，已跳过本次事件',
      stale: 'OBS 特效等待超时，已跳过过期事件',
      stopped: 'OBS 特效已停止或配置正在更新，已跳过本次事件',
      superseded: 'OBS 特效已被更新事件替代，已跳过旧事件',
    }
    return new ObsOperationError(`OBS_EFFECT_${reason.toUpperCase()}`, messages[reason])
  }

  private suspendPendingEffects() {
    this.suspendedEffects += 1
    const pending = this.operationQueue
    this.operationQueue = pending.filter(job => job.kind !== 'effect' && job.kind !== 'display')
    for (const job of pending) {
      if (job.kind === 'effect' || job.kind === 'display') job.reject(this.effectRejection('stopped'))
    }
    for (const job of this.artTextQueue.splice(0)) job.reject(this.effectRejection('stopped'))
  }

  private enqueue<T>(action: () => Promise<T>, kind: ObsOperationKind = 'control', operationKey?: string): Promise<T> {
    if ((kind === 'effect' || kind === 'display') && (this.suspendedEffects || this.cleanupFailed))
      return Promise.reject(this.effectRejection('stopped'))
    if (kind === 'effect' && operationKey) {
      const index = this.operationQueue.findIndex(job => job.kind === kind && job.operationKey === operationKey)
      if (index >= 0) {
        const [superseded] = this.operationQueue.splice(index, 1)
        superseded.reject(this.effectRejection('superseded'))
      }
    }
    const count = this.operationQueue.filter(job => job.kind === kind).length
    if (kind === 'effect' && count >= 8) return Promise.reject(this.effectRejection('busy'))
    if (kind === 'display' && count >= 33) return Promise.reject(this.effectRejection('busy'))
    if (kind === 'control' && count >= 16)
      return Promise.reject(new ObsOperationError('OBS_CONTROL_BUSY', 'OBS 控制队列繁忙，请稍后重试'))
    if (kind === 'cleanup' && operationKey) {
      const pending = this.operationQueue.find(job => job.kind === 'cleanup' && job.operationKey === operationKey)
      if (pending) {
        pending.action = action
        return pending.promise as Promise<T>
      }
    }
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = value => yes(value as T); reject = no })
    this.operationQueue.push({ kind, action, queuedAt: Date.now(), operationKey, promise, resolve, reject })
    if (!this.operationRunning) {
      this.operationRunning = true
      queueMicrotask(() => { void this.drainOperations() })
    }
    return promise
  }

  private async drainOperations() {
    const priority = { cleanup: 0, stop: 1, control: 2, display: 3, effect: 4 }
    while (this.operationQueue.length) {
      let index = 0
      for (let i = 1; i < this.operationQueue.length; i++)
        if (priority[this.operationQueue[i].kind] < priority[this.operationQueue[index].kind]) index = i
      const [job] = this.operationQueue.splice(index, 1)
      if (job.kind === 'effect' && Date.now() - job.queuedAt > 750) {
        job.reject(this.effectRejection('stale'))
        continue
      }
      try { job.resolve(await job.action()) }
      catch (error) { job.reject(error) }
    }
    this.operationRunning = false
  }
}

function validateDuration(durationMs: number) {
  if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 600_000) {
    throw new Error('显示时长必须是 100 到 600000 毫秒之间的整数')
  }
}

function targetKey(sceneName: string, sceneItemId: number) {
  return `${sceneName}\u0000${sceneItemId}`
}

function isMediaInputKind(value: unknown) {
  return (
    typeof value === 'string' &&
    ['ffmpeg_source', 'vlc_source', 'slideshow', 'slideshow_v2'].includes(value)
  )
}
