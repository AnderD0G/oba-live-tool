import type {
  ObsCameraAction,
  ObsCameraConfig,
  ObsCameraStatus,
  ObsCameraTarget,
} from './obsCamera'

export interface ObsEffectRule {
  id: string
  enabled: boolean
  minFansLevel: number
  sceneName: string
  sourceName: string
  sourceContainerName?: string
  durationMs: number
}

export interface ObsEnterEffectSettings {
  enabled: boolean
  url: string
  password: string
  sceneName: string
  sourceName: string
  sourceContainerName?: string
  durationMs: number
  minFansLevel: number
  effects: ObsEffectRule[]
}

export interface ObsSourceMetadata {
  name: string
  containerName: string
  path: string
  isGroup: boolean
}

export interface ObsInstantPresentation {
  mode: 'wide' | 'focus'
  followCamera: boolean
}
export const defaultObsInstantPresentation: ObsInstantPresentation = { mode: 'wide', followCamera: false }
export const OBS_INSTANT_INPUTS = ['✨ 秒闪欢迎', '💗 秒闪点赞', '🌸 秒闪关注'] as const
export const OBS_PREMIUM_WELCOME_INPUT = '🌈 贵宾欢迎' as const
export const OBS_ALL_INSTANT_INPUTS = [...OBS_INSTANT_INPUTS, OBS_PREMIUM_WELCOME_INPUT] as const

export interface ObsSceneMetadata {
  name: string
  sources: ObsSourceMetadata[]
}

export const defaultObsEnterEffectSettings: ObsEnterEffectSettings = {
  enabled: false,
  url: 'ws://127.0.0.1:4455',
  password: '',
  sceneName: '',
  sourceName: '',
  durationMs: 3000,
  minFansLevel: 0,
  effects: [],
}

export type ObsEffectCommand =
  | { action: 'state' }
  | { action: 'save'; settings: ObsEnterEffectSettings }
  | { action: 'test'; settings: ObsEnterEffectSettings }
  | { action: 'discover'; url: string; password: string }
  | { action: 'trigger'; settings: ObsEnterEffectSettings }
  | { action: 'camera-state' }
  | { action: 'camera-save'; config: ObsCameraConfig }
  | { action: 'camera-status' }
  | { action: 'camera-switch'; target: ObsCameraTarget }
  | { action: 'instant-presentation-state' }
  | { action: 'welcome-presets' }
  | { action: 'instant-presentation-save'; mode: 'wide' | 'focus'; followCamera: boolean }

export type ObsEffectResponse =
  | {
      ok: true
      settings?: ObsEnterEffectSettings
      scenes?: ObsSceneMetadata[]
      message?: string
      cameraConfig?: ObsCameraConfig
      cameraStatus?: ObsCameraStatus
      cameraAction?: ObsCameraAction
      instantPresentation?: ObsInstantPresentation
      welcomePresets?: import('./obsWelcome').ObsWelcomePresetAvailability[]
    }
  | { ok: false; error: string }
