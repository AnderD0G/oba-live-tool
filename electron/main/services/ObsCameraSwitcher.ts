import {
  type ObsCameraAction,
  type ObsCameraConfig,
  type ObsCameraStatus,
  type ObsCameraTarget,
  validateObsCameraConfig,
} from '../../../shared/obsCamera'
import { type ObsRpcClient, ObsWebSocketClient } from './ObsWebSocketClient'

type SceneItem = {
  sourceName: string
  sceneItemId: number
  sceneItemEnabled: boolean
  sceneItemIndex?: number
  isGroup?: boolean
}
type Filter = {
  filterName: string
  filterKind: string
  filterEnabled?: boolean
  filterSettings?: Record<string, unknown>
}
const FILTER_NAME = 'OBA 双机位淡入淡出'
const FILTER_KIND = 'color_filter_v2'

interface SwitcherOptions {
  wait?: (ms: number) => Promise<void>
  onAction?: (action: ObsCameraAction) => void
}

export class ObsCameraSwitcher {
  private tail: Promise<unknown> = Promise.resolve()
  private cached: ObsCameraStatus = { ok: false, error: '尚未检查 OBS 机位' }
  private checkedAt = 0
  private stopped = false
  private stopping = false
  constructor(
    private connection: { url: string; password: string },
    private config: ObsCameraConfig,
    private client: ObsRpcClient = new ObsWebSocketClient(),
    private options: SwitcherOptions = {},
  ) {}

  get lastStatus() {
    return this.cached
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  private async read(): Promise<{
    android: SceneItem
    iphone: SceneItem
    status: ObsCameraStatus
  }> {
    if (this.stopped) throw new Error('机位控制已停止')
    validateObsCameraConfig(this.config)
    await this.client.connect(this.connection.url, this.connection.password)
    const response = await this.client.call('GetSceneItemList', {
      sceneName: this.config.sceneName,
    })
    const items = Array.isArray(response.sceneItems) ? response.sceneItems : []
    const find = (name: string) => {
      const matches = items.filter(
        item => item && typeof item === 'object' && (item as SceneItem).sourceName === name,
      ) as SceneItem[]
      if (matches.length !== 1 || typeof matches[0].sceneItemId !== 'number')
        throw new Error(`OBS 场景「${this.config.sceneName}」中找不到唯一的直属来源「${name}」`)
      return matches[0]
    }
    const android = find(this.config.androidSource)
    const iphone = find(this.config.iphoneSource)
    const androidEnabled = android.sceneItemEnabled === true
    const iphoneEnabled = iphone.sceneItemEnabled === true
    const selected =
      androidEnabled && iphoneEnabled
        ? 'both'
        : androidEnabled
          ? 'android'
          : iphoneEnabled
            ? 'iphone'
            : 'none'
    const program = await this.client
      .call('GetCurrentProgramScene')
      .catch((): Record<string, unknown> => ({}))
    const programScene =
      typeof program.currentProgramSceneName === 'string'
        ? program.currentProgramSceneName
        : undefined
    const status: ObsCameraStatus = {
      ok: true,
      selected,
      androidEnabled,
      iphoneEnabled,
      programScene,
      onProgram: programScene === undefined ? undefined : programScene === this.config.sceneName,
    }
    this.cached = status
    this.checkedAt = Date.now()
    return { android, iphone, status }
  }

  status(force = false) {
    if (!force && Date.now() - this.checkedAt < 2000) return Promise.resolve(this.cached)
    return this.enqueue(async () => {
      if (!force && Date.now() - this.checkedAt < 2000) return this.cached
      try {
        return (await this.read()).status
      } catch (error) {
        this.cached = {
          ok: false,
          error: error instanceof Error ? error.message : 'OBS 机位检查失败',
        }
        this.checkedAt = Date.now()
        return this.cached
      }
    })
  }

  private set(item: SceneItem, enabled: boolean) {
    return this.client.call('SetSceneItemEnabled', {
      sceneName: this.config.sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemEnabled: enabled,
    })
  }

  private async requireExclusiveSource(sourceName: string) {
    const response = await this.client.call('GetSceneList')
    if (!Array.isArray(response.scenes)) throw new Error('无法核对机位来源是否被其他场景引用')
    for (const scene of response.scenes as Array<{ sceneName?: string }>) {
      if (typeof scene.sceneName !== 'string') continue
      const visited = new Set<string>()
      let references = 0
      const visit = async (container: string, group = false) => {
        if (visited.has(container)) return
        visited.add(container)
        const list = await this.client.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
          sceneName: container,
        })
        if (!Array.isArray(list.sceneItems)) throw new Error(`无法读取 OBS 场景「${container}」`)
        for (const item of list.sceneItems as SceneItem[]) {
          if (item.sourceName === sourceName) references += 1
          if (item.isGroup) await visit(item.sourceName, true)
        }
      }
      await visit(scene.sceneName)
      if (references > (scene.sceneName === this.config.sceneName ? 1 : 0))
        throw new Error(
          `机位来源「${sourceName}」还被「${scene.sceneName}」引用；请使用独立的机位来源再启用淡入淡出`,
        )
    }
  }

  private async filters(sourceName: string) {
    const result = await this.client.call('GetSourceFilterList', { sourceName })
    if (!Array.isArray(result.filters)) throw new Error(`无法读取来源「${sourceName}」的滤镜`)
    return result.filters as Filter[]
  }

  private async readFilter(sourceName: string) {
    const filter = await this.client.call('GetSourceFilter', {
      sourceName,
      filterName: FILTER_NAME,
    })
    if (
      typeof filter.filterKind !== 'string' ||
      typeof filter.filterEnabled !== 'boolean' ||
      !filter.filterSettings ||
      typeof filter.filterSettings !== 'object' ||
      Array.isArray(filter.filterSettings)
    )
      throw new Error('OBS 未返回机位滤镜的完整设置，无法安全恢复')
    return filter as Required<Omit<Filter, 'filterName'>>
  }

  private async setOpacity(sourceName: string, opacity: number, verify = false) {
    await this.client.call('SetSourceFilterSettings', {
      sourceName,
      filterName: FILTER_NAME,
      filterSettings: { opacity },
      overlay: true,
    })
    if (verify && Number((await this.readFilter(sourceName)).filterSettings?.opacity) !== opacity)
      throw new Error('OBS 未确认机位滤镜透明度')
  }

  private report(action: ObsCameraAction) {
    try {
      this.options.onAction?.(action)
    } catch {
      /* Recording must not undo a successful OBS action. */
    }
  }

  switchTo(target: ObsCameraTarget) {
    if (this.stopping || this.stopped) return Promise.reject(new Error('机位控制已停止'))
    return this.enqueue(async () => {
      const transitionMethod = this.config.transitionMethod ?? 'cut'
      const transitionMs = transitionMethod === 'cut' ? 0 : (this.config.transitionMs ?? 450)
      let before: Awaited<ReturnType<ObsCameraSwitcher['read']>> | undefined
      let visibilityChanged = false
      let cleanupFilter: (() => Promise<void>) | undefined
      let filterWasVisible = false
      try {
        if (this.stopping || this.stopped) throw new Error('机位控制已停止')
        if (target !== 'android' && target !== 'iphone') throw new Error('无效机位')
        before = await this.read()
        const show = target === 'android' ? before.android : before.iphone
        const hide = target === 'android' ? before.iphone : before.android
        if (show.sceneItemEnabled && !hide.sceneItemEnabled) {
          this.report({
            target,
            ok: true,
            before: before.status,
            after: before.status,
            transitionMethod,
            transitionMs,
          })
          return before.status
        }
        const change = async (item: SceneItem, enabled: boolean) => {
          visibilityChanged = true
          await this.set(item, enabled)
        }
        const alreadyVisibleUpper =
          show.sceneItemEnabled &&
          hide.sceneItemEnabled &&
          Number.isInteger(show.sceneItemIndex) &&
          Number.isInteger(hide.sceneItemIndex) &&
          (show.sceneItemIndex as number) > (hide.sceneItemIndex as number)
        if (transitionMethod === 'opacity-filter' && !alreadyVisibleUpper) {
          if (
            ![show.sceneItemIndex, hide.sceneItemIndex].every(value => Number.isInteger(value)) ||
            show.sceneItemIndex === hide.sceneItemIndex
          )
            throw new Error('OBS 未返回两个机位的有效叠放顺序，无法安全淡入淡出')
          // Keep the lower camera opaque. Complementary alpha ramps on both sources
          // would expose the background and darken the middle of a dissolve.
          const upper =
            (show.sceneItemIndex as number) > (hide.sceneItemIndex as number) ? show : hide
          const fading = before.status.selected === 'none' ? show : upper
          filterWasVisible = fading.sceneItemEnabled
          await this.requireExclusiveSource(fading.sourceName)
          const kinds = await this.client.call('GetSourceFilterKindList')
          if (
            !Array.isArray(kinds.sourceFilterKinds) ||
            !kinds.sourceFilterKinds.includes(FILTER_KIND)
          )
            throw new Error('OBS 不支持现代透明度滤镜，请选择直接切换')
          const listed = (await this.filters(fading.sourceName)).find(
            filter => filter.filterName === FILTER_NAME,
          )
          // The list identifies the filter; only the validated detail response is
          // trusted as a complete snapshot for conflict checks and restoration.
          const existing = listed ? await this.readFilter(fading.sourceName) : undefined
          if (
            existing &&
            (existing.filterKind !== FILTER_KIND ||
              Number(existing.filterSettings?.opacity ?? 1) !== 1 ||
              ['gamma', 'contrast', 'brightness', 'saturation', 'hue_shift'].some(
                key => Number(existing.filterSettings?.[key] ?? 0) !== 0,
              ))
          )
            throw new Error(
              `来源「${fading.sourceName}」的滤镜「${FILTER_NAME}」存在冲突，请先更名或移除冲突滤镜`,
            )
          if (existing) {
            const snapshot = structuredClone(existing)
            cleanupFilter = async () => {
              await this.client.call('SetSourceFilterSettings', {
                sourceName: fading.sourceName,
                filterName: FILTER_NAME,
                filterSettings: snapshot.filterSettings,
                overlay: false,
              })
              await this.client.call('SetSourceFilterEnabled', {
                sourceName: fading.sourceName,
                filterName: FILTER_NAME,
                filterEnabled: snapshot.filterEnabled,
              })
              const restored = await this.readFilter(fading.sourceName)
              if (
                Number(restored.filterSettings?.opacity ?? 1) !== 1 ||
                restored.filterEnabled !== snapshot.filterEnabled
              )
                throw new Error('OBS 未确认恢复原机位滤镜')
            }
          } else {
            cleanupFilter = async () => {
              if (
                !(await this.filters(fading.sourceName)).some(
                  filter => filter.filterName === FILTER_NAME,
                )
              )
                return
              await this.client.call('RemoveSourceFilter', {
                sourceName: fading.sourceName,
                filterName: FILTER_NAME,
              })
              if (
                (await this.filters(fading.sourceName)).some(
                  filter => filter.filterName === FILTER_NAME,
                )
              )
                throw new Error('OBS 未确认移除临时机位滤镜')
            }
            await this.client.call('CreateSourceFilter', {
              sourceName: fading.sourceName,
              filterName: FILTER_NAME,
              filterKind: FILTER_KIND,
              filterSettings: { opacity: 1 },
            })
          }
          const filter = await this.readFilter(fading.sourceName)
          if (filter.filterKind !== FILTER_KIND) throw new Error('OBS 机位滤镜类型不符')
          const fadeIn = fading.sceneItemId === show.sceneItemId
          await this.setOpacity(fading.sourceName, fadeIn ? 0 : 1, true)
          await this.client.call('SetSourceFilterEnabled', {
            sourceName: fading.sourceName,
            filterName: FILTER_NAME,
            filterEnabled: true,
          })
          if ((await this.readFilter(fading.sourceName)).filterEnabled !== true)
            throw new Error('OBS 未确认启用机位滤镜')
          if (!show.sceneItemEnabled) await change(show, true)
          const steps = Math.ceil(transitionMs / 40)
          const wait =
            this.options.wait ??
            ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
          for (let step = 1; step <= steps; step += 1) {
            await wait(transitionMs / steps)
            await this.setOpacity(
              fading.sourceName,
              fadeIn ? step / steps : 1 - step / steps,
              step === steps,
            )
          }
          if (hide.sceneItemEnabled) await change(hide, false)
          await cleanupFilter()
          cleanupFilter = undefined
        } else {
          if (!show.sceneItemEnabled) await change(show, true)
          if (hide.sceneItemEnabled) await change(hide, false)
        }
        const after = await this.read()
        if (after.status.selected !== target) throw new Error('OBS 未确认目标机位')
        this.report({
          target,
          ok: true,
          before: before.status,
          after: after.status,
          transitionMethod,
          transitionMs,
        })
        return after.status
      } catch (error) {
        let restoreError: unknown
        try {
          if (before && visibilityChanged) {
            // Re-enable the original camera before disabling the failed destination.
            for (const item of [before.android, before.iphone].filter(
              item => item.sceneItemEnabled,
            ))
              await this.set(item, true)
            if (filterWasVisible && cleanupFilter) {
              await cleanupFilter()
              cleanupFilter = undefined
            }
            for (const item of [before.android, before.iphone].filter(
              item => !item.sceneItemEnabled,
            ))
              await this.set(item, false)
          }
        } catch (failure) {
          restoreError = failure
        }
        try {
          await cleanupFilter?.()
        } catch (failure) {
          restoreError ??= failure
        }
        if (before && visibilityChanged && !restoreError) {
          try {
            await this.read()
          } catch (failure) {
            restoreError = failure
          }
        }
        const message = restoreError
          ? '切换失败且恢复原机位或滤镜失败，请查看 OBS 现场画面'
          : error instanceof Error
            ? error.message
            : 'OBS 机位切换失败'
        if (restoreError) this.cached = { ok: false, error: message }
        this.report({
          target,
          ok: false,
          before: before?.status,
          after: before ? this.cached : undefined,
          transitionMethod,
          transitionMs,
          error: message,
        })
        if (restoreError) throw new Error(message)
        throw error
      }
    })
  }

  async stop() {
    this.stopping = true
    await this.tail
    this.stopped = true
    this.cached = { ok: false, error: '机位控制已停止' }
    await this.client.disconnect()
  }
}
