export type ObsCameraTarget = 'android' | 'iphone'
export type ObsCameraTransition = 'cut' | 'opacity-filter'

export interface ObsCameraConfig {
  sceneName: string
  androidSource: string
  iphoneSource: string
  /** Saved configurations without this field retain their original immediate switch. */
  transitionMethod?: ObsCameraTransition
  transitionMs?: number
}

export interface ObsCameraStatus {
  ok: boolean
  error?: string
  selected?: ObsCameraTarget | 'both' | 'none'
  androidEnabled?: boolean
  iphoneEnabled?: boolean
  onProgram?: boolean
  programScene?: string
}

export interface ObsCameraAction {
  target: ObsCameraTarget
  ok: boolean
  before?: ObsCameraStatus
  after?: ObsCameraStatus
  transitionMethod: ObsCameraTransition
  transitionMs: number
  error?: string
}

export const defaultObsCameraConfig: ObsCameraConfig = {
  sceneName: '双机位',
  androidSource: 'Android DroidCam (LAN)',
  iphoneSource: 'iPhone Moblin (LAN SRT)',
  transitionMethod: 'opacity-filter',
  transitionMs: 450,
}

export function validateObsCameraConfig(config: ObsCameraConfig) {
  if (!config || typeof config !== 'object') throw new Error('OBS 机位配置无效')
  if (
    ![config.sceneName, config.androidSource, config.iphoneSource].every(
      value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100,
    )
  )
    throw new Error('OBS 场景或机位来源名称无效')
  if (config.androidSource === config.iphoneSource) throw new Error('两个机位必须对应不同 OBS 来源')
  if (
    config.transitionMethod !== undefined &&
    !['cut', 'opacity-filter'].includes(config.transitionMethod)
  )
    throw new Error('OBS 机位过渡方式无效')
  if (
    config.transitionMs !== undefined &&
    (!Number.isInteger(config.transitionMs) ||
      config.transitionMs < 250 ||
      config.transitionMs > 1500)
  )
    throw new Error('OBS 机位淡入淡出时长必须是 250～1500 毫秒')
}
