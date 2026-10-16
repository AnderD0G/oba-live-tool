/** Curated welcome choices. IDs are data; they never identify a path or executable action. */
export const OBS_WELCOME_PRESETS = [
  {
    id: 'pearl',
    label: '轻光欢迎',
    kind: 'html',
    durationMs: 960,
    description: '柔和微光，适合普通进场',
  },
  {
    id: 'gold',
    label: '金币微雨',
    kind: 'html',
    durationMs: 1200,
    description: '少量金色硬币与暖光',
  },
  {
    id: 'fireworks',
    label: '角落烟花',
    kind: 'html',
    durationMs: 1200,
    description: '细线花火，聚焦时留在角落',
  },
  {
    id: 'petals',
    label: '花瓣轻落',
    kind: 'html',
    durationMs: 1100,
    description: '淡粉花瓣轻轻飘落',
  },
  {
    id: 'orchid',
    label: '兰花弧线',
    kind: 'html',
    durationMs: 1100,
    description: '淡紫兰花与弧形枝叶',
  },
  {
    id: 'camellia',
    label: '山茶点缀',
    kind: 'html',
    durationMs: 1100,
    description: '奶白山茶点缀边缘',
  },
  {
    id: 'hearts',
    label: '暖心漂浮',
    kind: 'html',
    durationMs: 1100,
    description: '轻巧爱心，温暖不抢镜',
  },
  {
    id: 'ribbon',
    label: '柔彩丝带',
    kind: 'html',
    durationMs: 1100,
    description: '细窄丝带与柔和彩点',
  },
  {
    id: 'starlight',
    label: '星光点点',
    kind: 'html',
    durationMs: 1100,
    description: '稀疏小星星与淡淡光晕',
  },
  {
    id: 'halo',
    label: '柔光花环',
    kind: 'html',
    durationMs: 1100,
    description: '花环轮廓与珍珠光点',
  },
  {
    id: 'google-flower',
    label: 'Google Flower · 花漾进场',
    kind: 'obs-media',
    durationMs: 4000,
    description: '已有付费绿幕素材，独立播放完整 4 秒',
    sourceName: '特效 · google-flower',
  },
  {
    id: 'volcengine-flower',
    label: 'Volcengine Flower · 繁花相迎',
    kind: 'obs-media',
    durationMs: 1500,
    description: '已有绿幕素材，最多显示 1.5 秒',
    sourceName: '特效 · volcengine-flower',
  },
  {
    id: 'google-zanhua',
    label: 'Google · 簪花',
    kind: 'obs-media',
    durationMs: 1500,
    description: '已有付费绿幕簪花素材',
    sourceName: '特效 · google-zanhua',
  },
  {
    id: 'google-moonlight',
    label: 'Google · 月光',
    kind: 'obs-media',
    durationMs: 1500,
    description: '已有付费绿幕月光素材',
    sourceName: '特效 · google-moonlight',
  },
  {
    id: 'ordinary-03',
    label: '杏粉小花枝',
    kind: 'obs-media',
    durationMs: 1500,
    description: '已有绿幕花枝素材',
    sourceName: '特效 · ordinary-03-seedance',
  },
  {
    id: 'ordinary-09',
    label: '双角白山茶',
    kind: 'obs-media',
    durationMs: 1500,
    description: '已有绿幕山茶素材',
    sourceName: '特效 · ordinary-09-veo',
  },
] as const

export type ObsWelcomePresetId = (typeof OBS_WELCOME_PRESETS)[number]['id']
export type ObsWelcomePreset = (typeof OBS_WELCOME_PRESETS)[number]
export interface ObsWelcomePresetAvailability {
  id: ObsWelcomePresetId
  label: string
  kind: 'html' | 'obs-media'
  durationMs: number
  description: string
  available: boolean
  reason?: string
  sceneName?: string
  sourceName?: string
  sourceContainerName?: string
}
export function isWelcomePresetId(value: unknown): value is ObsWelcomePresetId {
  return typeof value === 'string' && OBS_WELCOME_PRESETS.some(preset => preset.id === value)
}
export function welcomePreset(value: unknown): ObsWelcomePreset {
  const preset = OBS_WELCOME_PRESETS.find(candidate => candidate.id === value)
  if (!preset) throw new Error('请选择已知的欢迎样式')
  return preset
}
export function isNativeWelcomeSourceUrl(value: unknown, inputName: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      url.pathname === '/obs/instant/welcome.html' &&
      url.searchParams.get('transport') === 'native' &&
      url.searchParams.getAll('transport').length === 1 &&
      url.searchParams.get('channel') === inputName &&
      url.searchParams.getAll('channel').length === 1
    )
  } catch {
    return false
  }
}
