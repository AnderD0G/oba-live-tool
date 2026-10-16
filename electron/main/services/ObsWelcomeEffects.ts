import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  OBS_WELCOME_PRESETS,
  isNativeWelcomeSourceUrl,
  welcomePreset,
  type ObsWelcomePresetAvailability,
} from '../../../shared/obsWelcome'
import { OBS_INSTANT_INPUTS, OBS_PREMIUM_WELCOME_INPUT } from '../../../shared/obsEffect'
import type { ArtTextDeliveryResult, ArtTextDisplayTarget } from './ObsEnterEffectService'
import type { ObsRpcClient } from './ObsWebSocketClient'

interface SceneItem {
  sceneName: string
  sceneItemId: number
  enabled: boolean
}
interface MediaTarget {
  sceneName: string
  sourceName: string
  sourceContainerName: string
  items: SceneItem[]
}
interface Playback {
  token: string
  items: SceneItem[]
  timer?: ReturnType<typeof setTimeout>
  failure?: unknown
}
interface CleanupWork {
  playback: Playback
  promise: Promise<void>
}
interface PendingPremium {
  target: ArtTextDisplayTarget
  text: string
  presetId: unknown
  resolve: (result: ArtTextDeliveryResult) => void
  reject: (error: unknown) => void
}

/** Curated entry effects share the existing OBS operation queue and exact welcome channel. */
export class ObsWelcomeEffects {
  private playbacks = new Map<string, Playback>()
  private cleanupPending = new Map<string, CleanupWork>()
  private stoppedPlaybacks = new Set<Playback>()
  private pendingPremium?: PendingPremium
  constructor(
    private client: ObsRpcClient,
    private connect: () => Promise<unknown>,
    private run: <T>(action: () => Promise<T>, kind?: 'effect' | 'control' | 'cleanup', cleanupKey?: string) => Promise<T>,
    private showHtml: (target: ArtTextDisplayTarget, text: string) => Promise<unknown>,
    private clearHtml: (inputName: string) => Promise<void>,
    private logError: (error: unknown) => void,
  ) {}

  async catalog(): Promise<ObsWelcomePresetAvailability[]> {
    return this.run(async () => {
      try {
        await this.connect()
        const sceneName = await this.currentScene()
        const items = await this.sources(sceneName)
        const welcomeError = await this.requireWelcomeSource(items).then(
          () => undefined,
          error => this.reason(error),
        )
        const premiumError = await this.requireWelcomeSource(items, OBS_PREMIUM_WELCOME_INPUT).then(
          () => undefined,
          error => this.reason(error),
        )
        return Promise.all(
          OBS_WELCOME_PRESETS.map(async preset => {
            const base = { ...preset, sceneName }
            const receiverError = preset.kind === 'html' ? welcomeError : premiumError
            if (receiverError) return { ...base, available: false, reason: receiverError }
            if (preset.kind === 'html') return { ...base, available: true }
            try {
              const target = await this.mediaTarget(preset.sourceName, sceneName, items)
              return { ...base, available: true, sourceContainerName: target.sourceContainerName }
            } catch (error) {
              return { ...base, available: false, reason: this.reason(error) }
            }
          }),
        )
      } catch (error) {
        return OBS_WELCOME_PRESETS.map(preset => ({
          ...preset,
          available: false,
          reason: this.reason(error),
        }))
      }
    })
  }

  async show(
    target: ArtTextDisplayTarget,
    text: string,
    id: unknown,
  ): Promise<ArtTextDeliveryResult> {
    const preset = welcomePreset(id)
    if (target.inputName !== OBS_INSTANT_INPUTS[0] && target.inputName !== OBS_PREMIUM_WELCOME_INPUT)
      throw new Error('欢迎样式只能用于独立秒闪欢迎来源')
    if (preset.kind === 'html') {
      if (target.inputName !== OBS_INSTANT_INPUTS[0]) throw new Error('普通欢迎需要独立秒闪欢迎来源')
      return this.showNow(target, text, id)
    }
    const premiumTarget = { ...target, inputName: OBS_PREMIUM_WELCOME_INPUT, welcomeLane: 'premium' as const }
    const activePremium = this.playbacks.get(OBS_PREMIUM_WELCOME_INPUT)
    if (activePremium?.failure !== undefined) throw activePremium.failure
    // The active clip owns its whole duration. Bursts retain just the latest next
    // item, outside the shared OBS operation queue, so ordinary channels stay live.
    if (this.playbacks.has(OBS_PREMIUM_WELCOME_INPUT) || this.cleanupPending.has(OBS_PREMIUM_WELCOME_INPUT)) {
      this.pendingPremium?.resolve({delivery:'immediate',state:'superseded',supersededPrevious:true})
      return new Promise<ArtTextDeliveryResult>((resolve,reject) => {
        this.pendingPremium = {target:premiumTarget,text,presetId:id,resolve,reject}
      })
    }
    return this.showNow(premiumTarget, text, id)
  }

  private async showNow(target: ArtTextDisplayTarget, text: string, id: unknown): Promise<ArtTextDeliveryResult> {
    const preset = welcomePreset(id)
    const previous = this.playbacks.get(target.inputName)
    if (previous?.timer) clearTimeout(previous.timer)
    // Transfer source ownership instead of retaining a chain of superseded playbacks.
    const playback: Playback = { token: randomUUID(), items: previous?.items || [] }
    if (previous) previous.items = []
    this.playbacks.set(target.inputName, playback)
    const owned = () => this.playbacks.get(target.inputName) === playback
    const result = (state: 'started' | 'superseded'): ArtTextDeliveryResult => ({
      delivery: 'immediate',
      state,
      supersededPrevious: !!previous,
    })
    try {
      if (preset.kind === 'obs-media') await this.clearHtml(target.inputName)
      const ready = await this.run(async () => {
        if (!owned()) return false
        await this.connect()
        if (playback.items.length) await this.close(playback)
        if (!owned()) return false
        const sceneName = await this.currentScene()
        const sources = await this.sources(sceneName)
        await this.requireWelcomeSource(sources, target.inputName)
        if (!owned()) return false
        if (preset.kind === 'html') return true
        const media = await this.mediaTarget(preset.sourceName, sceneName, sources)
        if (!owned()) return false
        if ((await this.currentScene()) !== sceneName)
          throw new Error('OBS 场景已变化，请重新触发欢迎')
        await this.client.call('TriggerMediaInputAction', {
          inputName: media.sourceName,
          mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
        })
        for (const item of media.items) {
          if (!owned()) return false
          // Preserve already visible parents. The selected effect itself is always temporary.
          if (item === media.items.at(-1) || !item.enabled) {
            playback.items.push(item)
            await this.client.call('SetSceneItemEnabled', {
              sceneName: item.sceneName,
              sceneItemId: item.sceneItemId,
              sceneItemEnabled: true,
            })
          }
        }
        return owned()
      }, 'effect', `welcome:${target.inputName}`)
      if (!ready || !owned()) return result('superseded')
      if (preset.kind === 'html') {
        const delivery = await this.showHtml(
          {
            ...target,
            presetId: preset.id,
            holdMs: preset.durationMs - 400,
            delivery: 'immediate',
          },
          text,
        )
        if (!owned()) return result('superseded')
        return (delivery ?? result('started')) as ArtTextDeliveryResult
      }
      playback.timer = setTimeout(() => {
        if (owned()) this.requestCleanup(target.inputName, playback)
      }, preset.durationMs)
      await this.showHtml(
        {
          ...target,
          presetId: 'pearl',
          holdMs: preset.durationMs - 400,
          welcomeLane: 'premium',
          delivery: 'immediate',
        },
        text,
      )
      if (!owned()) return result('superseded')
      return result('started')
    } catch (error) {
      if (playback.items.length) this.requestCleanup(target.inputName, playback)
      else if (owned()) {
        this.playbacks.delete(target.inputName)
        if (target.inputName === OBS_PREMIUM_WELCOME_INPUT) this.startPendingPremium()
      }
      if (error instanceof Error && 'code' in error && error.code === 'OBS_EFFECT_SUPERSEDED')
        return result('superseded')
      throw error
    }
  }

  stop() {
    this.pendingPremium?.resolve({delivery:'immediate',state:'superseded',supersededPrevious:true})
    this.pendingPremium = undefined
    const active = [...new Set([
      ...this.stoppedPlaybacks,
      ...this.playbacks.values(),
      ...[...this.cleanupPending.values()].map(work => work.playback),
    ])]
    // Cancel start ownership immediately, but keep failed closes reachable for
    // a later stop/configure retry after the connection has been restored.
    this.playbacks.clear()
    for (const playback of active) this.stoppedPlaybacks.add(playback)
    for (const playback of active) if (playback.timer) clearTimeout(playback.timer)
    const pending = [...this.cleanupPending.values()].map(work => work.promise)
    if (!active.length) return Promise.all(pending).then(() => {})
    const closing = this.run(async () => {
      // Cleanup jobs with the same key can coalesce during concurrent lifecycle
      // calls. Read the retained owners at execution time rather than a snapshot.
      const retained = [...this.stoppedPlaybacks]
      if (retained.some(playback => playback.items.length)) await this.connect()
      const results = await Promise.allSettled(retained.map(async playback => {
        await this.close(playback)
        this.stoppedPlaybacks.delete(playback)
      }))
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, `欢迎素材关闭失败：${errors.map(error => this.reason(error)).join('；')}`)
    }, 'cleanup', 'welcome-stop')
    return Promise.all([...pending, closing]).then(() => {})
  }

  private requestCleanup(inputName: string, playback: Playback) {
    if (this.playbacks.get(inputName) !== playback) return
    const pending = this.cleanupPending.get(inputName)
    if (pending) {
      pending.playback = playback
      return
    }
    // Only expired/failed playbacks request cleanup; a valid replacement keeps its owner.
    const work: CleanupWork = { playback, promise: Promise.resolve() }
    let closing: Playback | undefined
    this.cleanupPending.set(inputName, work)
    work.promise = this.run(async () => {
      closing = work.playback
      await this.close(closing)
    }, 'cleanup', `welcome:${inputName}`).then(async () => {
      if (inputName === OBS_PREMIUM_WELCOME_INPUT && this.playbacks.get(inputName) === closing)
        await this.clearHtml(inputName)
      if (this.playbacks.get(inputName) === closing) this.playbacks.delete(inputName)
    }).catch(error => {
      this.logError(error)
      if (inputName === OBS_PREMIUM_WELCOME_INPUT) {
        if (this.playbacks.get(inputName) === work.playback) work.playback.failure = error
        this.pendingPremium?.reject(error)
        this.pendingPremium = undefined
      }
    }).finally(() => {
      if (this.cleanupPending.get(inputName) !== work) return
      this.cleanupPending.delete(inputName)
      // A failed request arriving during an active close gets one subsequent owned pass.
      if (work.playback !== closing && work.playback.items.length && this.playbacks.get(inputName) === work.playback)
        this.requestCleanup(inputName, work.playback)
      if (inputName === OBS_PREMIUM_WELCOME_INPUT && !this.playbacks.has(inputName)) this.startPendingPremium()
    })
  }
  private startPendingPremium() {
    const pending = this.pendingPremium
    if (!pending || this.playbacks.has(OBS_PREMIUM_WELCOME_INPUT) || this.cleanupPending.has(OBS_PREMIUM_WELCOME_INPUT)) return
    this.pendingPremium = undefined
    void this.showNow(pending.target, pending.text, pending.presetId).then(pending.resolve,pending.reject)
  }
  private async close(playback: Playback) {
    if (playback.timer) clearTimeout(playback.timer)
    const failed: SceneItem[] = []
    const errors: unknown[] = []
    for (const item of playback.items.slice().reverse()) {
      try {
        await this.client.call('SetSceneItemEnabled', {
          sceneName: item.sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemEnabled: false,
        })
      } catch (error) {
        failed.unshift(item)
        errors.push(error)
      }
    }
    playback.items = failed
    if (errors.length)
      throw new Error(`欢迎素材关闭失败：${errors.map(error => this.reason(error)).join('；')}`)
  }
  private async currentScene(): Promise<string> {
    const { currentProgramSceneName } = await this.client.call('GetCurrentProgramScene')
    if (typeof currentProgramSceneName !== 'string' || !currentProgramSceneName)
      throw new Error('OBS 未返回当前节目场景')
    return currentProgramSceneName
  }
  private async sources(
    sceneName: string,
    parents: SceneItem[] = [],
    visited = new Set<string>(),
  ): Promise<Array<{ sourceName: string; items: SceneItem[] }>> {
    if (visited.has(sceneName) || parents.length > 8 || visited.size > 128) return []
    visited.add(sceneName)
    const response = await this.client.call(
      parents.length ? 'GetGroupSceneItemList' : 'GetSceneItemList',
      { sceneName },
    )
    const result: Array<{ sourceName: string; items: SceneItem[] }> = []
    for (const item of Array.isArray(response.sceneItems) ? response.sceneItems : []) {
      if (!item || typeof item !== 'object') continue
      const value = item as Record<string, unknown>
      if (
        typeof value.sourceName !== 'string' ||
        typeof value.sceneItemId !== 'number' ||
        typeof value.sceneItemEnabled !== 'boolean'
      )
        continue
      const chain = [
        ...parents,
        { sceneName, sceneItemId: value.sceneItemId, enabled: value.sceneItemEnabled },
      ]
      result.push({ sourceName: value.sourceName, items: chain })
      if (value.isGroup === true)
        result.push(...(await this.sources(value.sourceName, chain, visited)))
    }
    return result
  }
  private async mediaTarget(
    sourceName: string,
    sceneName: string,
    sources: Array<{ sourceName: string; items: SceneItem[] }>,
  ): Promise<MediaTarget> {
    const candidates = sources.filter(source => source.sourceName === sourceName)
    if (candidates.length !== 1)
      throw new Error(
        candidates.length ? '当前场景存在重复欢迎素材来源' : '当前 OBS 场景没有此欢迎素材',
      )
    if (candidates[0].items.at(-1)!.enabled)
      throw new Error('欢迎素材正在被其他操作占用，请待其隐藏后再试')
    const { inputKind, inputSettings } = await this.client.call('GetInputSettings', {
      inputName: sourceName,
    })
    const file = (inputSettings as Record<string, unknown> | undefined)?.local_file
    if (
      inputKind !== 'ffmpeg_source' ||
      typeof file !== 'string' ||
      !(await stat(file).catch(() => undefined))?.isFile()
    )
      throw new Error('欢迎素材的本地视频文件不可用')
    const filters = await this.client.call('GetSourceFilterList', { sourceName })
    if (
      !(Array.isArray(filters.filters) ? filters.filters : []).some(
        filter =>
          filter &&
          typeof filter === 'object' &&
          ['chroma_key_filter', 'chroma_key_filter_v2'].includes((filter as any).filterKind) &&
          (filter as any).filterEnabled === true,
      )
    )
      throw new Error('欢迎绿幕素材尚未启用透明色度键')
    const items = candidates[0].items
    return { sceneName, sourceName, sourceContainerName: items.at(-1)!.sceneName, items }
  }
  private async requireWelcomeSource(sources: Array<{ sourceName: string; items: SceneItem[] }>, inputName: string = OBS_INSTANT_INPUTS[0]) {
    const candidates = sources.filter(source => source.sourceName === inputName)
    if (candidates.length !== 1 || !candidates[0].items.every(item => item.enabled))
      throw new Error('当前 OBS 场景需要唯一且可见的原生秒闪欢迎来源')
    const input = await this.client.call('GetInputSettings', { inputName })
    if (
      input.inputKind !== 'browser_source' ||
      !isNativeWelcomeSourceUrl((input.inputSettings as any)?.url, inputName)
    )
      throw new Error('精选欢迎样式需要正确的原生欢迎来源与通道')
  }
  private reason(error: unknown) {
    return error instanceof Error ? error.message : 'OBS 欢迎素材不可用'
  }
}
