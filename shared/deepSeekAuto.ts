import { type ConversationLimits, validateConversationLimits } from './conversationPolicy'
import type { InteractionRoutingConfig } from './interactionRouting'
import type { DirectorConfig } from './director'
import { type LiveAIProvider, normalizeLiveConnection } from './liveAI'
import { type ObsCameraConfig, type ObsCameraStatus, validateObsCameraConfig } from './obsCamera'

export interface DeepSeekAutoSettings {
  provider?: LiveAIProvider
  baseURL?: string
  jsonMode?: boolean
  disableThinking?: boolean
  voiceReply?: boolean
  voiceBackend?: 'index25' | 'qwen' | 'legacy'
  voicePlayback?: 'conversation' | 'director'
  conversationLimits?: ConversationLimits
  model: string
  observeOnly: boolean
  publicReply: boolean
  /**
   * 观众只报了编号（没说要展示还是试戴）时，先问一句"想看展示还是上头"，
   * 等他答了再入队；关掉就是老行为，直接按展示入队。
   */
  askModeBeforeDemo?: boolean
  mode?: 'director' | 'human'
  selectedSceneId?: string
  scenes?: HumanLiveScene[]
  camera?: HumanLiveCameraConfig
  throttle?: ThrottleSettings
  /**
   * 流式播放：PCM → ffmpeg 转 MP3 → 本地 HTTP 流 → OBS。
   * Index 使用自适应分句缓冲与严格播放截止；关闭则等待完整 WAV。
   *
   * **默认开。** 实测（真千问 + 仿真导播）：「你好呀」从观众发话到出声
   * 3.18 秒，等整段是 3.66 秒 —— 流式稳定快 0.5 秒，因为音频更早就绪，
   * 能更早塞进那个**正在进行**的气口。
   *
   * 关掉它会退回「整段合成完再播」：更准（真实时长精确、窗口判定不会偏差），
   * 但慢半秒。怀疑流式有问题时先关这个开关，别的都不用动。
   */
  streamingPlayback?: boolean
}

/**
 * 人工节流：每一条都是可填的秒数，填 0 就是这一条不限流。
 *
 * 这些闸门分别防的是不同的事（刷屏、超支、重复招呼），所以不合成一个总开关 ——
 * 想放开哪一条就只改哪一条，其余照旧生效。
 */
export interface ThrottleSettings {
  /** 进房欢迎文字：两条之间至少隔几秒（全局）。 */
  entryTextGlobalSeconds: number
  /** 进房欢迎文字：同一个人多久内只欢迎一次。 */
  entryTextPerViewerSeconds: number
  /** 语音失败改发文字：两条之间至少隔几秒（全局）。 */
  fallbackGlobalSeconds: number
  /** 语音失败改发文字：同一个人同一句多久内只补一次。 */
  fallbackPerViewerSeconds: number
  /** 语音问候：两条之间至少隔几秒（全局）。 */
  greetingGlobalSeconds: number
  /** 语音问候：同一个人多久内只问候一次。 */
  greetingPerViewerSeconds: number
  /** 同一个人的重复弹幕是否拦下不回复。 */
  blockDuplicateComments: boolean
}

/** 默认值就是原来写死的那些数字，行为不变。 */
export const defaultThrottleSettings: ThrottleSettings = {
  entryTextGlobalSeconds: 8,
  entryTextPerViewerSeconds: 60,
  fallbackGlobalSeconds: 2.5,
  fallbackPerViewerSeconds: 60,
  greetingGlobalSeconds: 8,
  greetingPerViewerSeconds: 60,
  blockDuplicateComments: true,
}

const THROTTLE_SECONDS_FIELDS = [
  'entryTextGlobalSeconds',
  'entryTextPerViewerSeconds',
  'fallbackGlobalSeconds',
  'fallbackPerViewerSeconds',
  'greetingGlobalSeconds',
  'greetingPerViewerSeconds',
] as const

export function validateThrottleSettings(value: ThrottleSettings) {
  for (const key of THROTTLE_SECONDS_FIELDS)
    if (
      typeof value[key] !== 'number' ||
      !Number.isFinite(value[key]) ||
      value[key] < 0 ||
      value[key] > 3600
    )
      throw new Error(`节流 ${key} 无效（0～3600 秒，0 为不限）`)
  if (typeof value.blockDuplicateComments !== 'boolean') throw new Error('重复弹幕拦截的设置无效')
}

export type HumanLiveCameraConfig = ObsCameraConfig
export type HumanLiveCameraStatus = ObsCameraStatus

export interface HumanLiveScene {
  id: string
  name: string
  policy: string
  knowledge: { id: string; name: string; content: string }[]
}

export interface HumanLiveItem {
  trace?: import('./audienceEvents').AudienceTrace
  id: string
  auditTraceId?: string
  userId?: string
  mention?: string
  user: string
  original: string
  chinese: string
  language: string
  kind: 'demo' | 'review' | 'answer' | 'greeting'
  status: 'pending' | 'sending' | 'done' | 'ignored' | 'sent' | 'failed'
  product?: string
  reply?: string
  createdAt: number
}

export const defaultDeepSeekAutoSettings = (): DeepSeekAutoSettings => ({
  model: 'deepseek-flash',
  observeOnly: true,
  publicReply: false,
  askModeBeforeDemo: true,
  mode: 'director',
  voiceBackend: 'qwen',
  voicePlayback: 'conversation',
  selectedSceneId: '',
  scenes: [],
  camera: { sceneName: '双机位', androidSource: '安卓', iphoneSource: 'iPhone' },
})

export function currentDeepSeekModel(model?: string) {
  return !model || model === 'deepseek-chat' || model === 'deepseek-reasoner'
    ? 'deepseek-flash'
    : model
}

export function activeDirectorInteraction(
  current: DirectorConfig['interaction'],
  settings: DeepSeekAutoSettings,
): NonNullable<DirectorConfig['interaction']> {
  return {
    ...current,
    enabled: true,
    model: settings.model,
    observeOnly: settings.observeOnly,
    publicReply: settings.publicReply,
    askModeBeforeDemo: settings.askModeBeforeDemo ?? true,
  }
}

/**
 * 虚拟声卡状态。
 *
 * 这是**机器级**设置（`userData/virtual-cable.json`），不属于某个账号 ——
 * 换账号播，声卡还是同一块。所以界面上要说明「改完下次启动导播生效」。
 */
export type VirtualCableState = {
  /** 播放服务起着、并且认得出虚拟声卡。false 时开关没意义。 */
  installed: boolean
  /** 用户显式打开的开关。 */
  enabled: boolean
  /** 探测到的设备名，给界面显示用。 */
  deviceName: string
}

export type DeepSeekAutoCommand =
  | { action: 'state'; accountId: string }
  | { action: 'save'; accountId: string; settings: DeepSeekAutoSettings; revision: string }
  | { action: 'key'; accountId: string; key: string }
  | { action: 'enable'; accountId: string }
  | { action: 'disable'; accountId: string }
  | { action: 'voice-check'; accountId: string }
  | {
      action: 'routing-save'
      accountId: string
      revision: number
      config: InteractionRoutingConfig
    }
  | { action: 'simulate'; accountId: string; text: string; user: string }
  | { action: 'item'; accountId: string; id: string; operation: 'done' | 'ignore' }
  | { action: 'reply'; accountId: string; id: string; chinese: string }
  | { action: 'camera-status'; accountId: string }
  | { action: 'camera-switch'; accountId: string; target: 'android' | 'iphone' }
  | { action: 'virtual-cable'; accountId: string; enabled: boolean }

export function validateDeepSeekAutoSettings(settings: DeepSeekAutoSettings) {
  normalizeLiveConnection(settings)
  if (settings.voiceReply !== undefined && typeof settings.voiceReply !== 'boolean')
    throw new Error('语音开关无效')
  if (
    settings.voiceBackend !== undefined &&
    !['index25', 'qwen', 'legacy'].includes(settings.voiceBackend)
  )
    throw new Error('语音服务无效')
  if (
    settings.voicePlayback !== undefined &&
    !['conversation', 'director'].includes(settings.voicePlayback)
  )
    throw new Error('语音播放方式无效')
  if (settings.conversationLimits) validateConversationLimits(settings.conversationLimits)
  if (typeof settings.observeOnly !== 'boolean' || typeof settings.publicReply !== 'boolean')
    throw new Error('自动回复设置无效')
  if (settings.askModeBeforeDemo !== undefined && typeof settings.askModeBeforeDemo !== 'boolean')
    throw new Error('点播先问展示还是试戴的设置无效')
  if (settings.throttle) validateThrottleSettings(settings.throttle)
  if (settings.streamingPlayback !== undefined && typeof settings.streamingPlayback !== 'boolean')
    throw new Error('流式播放的设置无效')
  if (settings.mode !== undefined && !['director', 'human'].includes(settings.mode))
    throw new Error('直播模式无效')
  if (settings.camera) {
    validateObsCameraConfig(settings.camera)
  }
  if (settings.scenes !== undefined) {
    if (!Array.isArray(settings.scenes) || settings.scenes.length > 30)
      throw new Error('场景数量无效')
    const ids = new Set<string>()
    for (const scene of settings.scenes) {
      if (!scene || !/^[a-zA-Z0-9_-]{1,80}$/.test(scene.id) || ids.has(scene.id))
        throw new Error('场景编号无效或重复')
      ids.add(scene.id)
      if (
        !scene.name?.trim() ||
        scene.name.length > 100 ||
        typeof scene.policy !== 'string' ||
        scene.policy.length > 20000
      )
        throw new Error('场景名称或总纲无效')
      if (!Array.isArray(scene.knowledge) || scene.knowledge.length > 50)
        throw new Error('知识库数量无效')
      for (const entry of scene.knowledge) {
        if (
          !entry.name?.trim() ||
          entry.name.length > 100 ||
          typeof entry.content !== 'string' ||
          entry.content.length > 30000
        )
          throw new Error('知识库名称或内容无效')
      }
      if (scene.knowledge.reduce((size, entry) => size + entry.content.length, 0) > 50000)
        throw new Error('单个场景的知识库总长度最多 50000 字')
    }
    if (settings.selectedSceneId && !ids.has(settings.selectedSceneId))
      throw new Error('请选择存在的直播场景')
  }
}
