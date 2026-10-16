import type { HookSettings } from '../../../../shared/hooks'
import { OBS_INSTANT_INPUTS } from '../../../../shared/obsEffect'

/** Empty production rules still have a usable, RAM-only local-effect test path. */
export function mockHookSettings(saved: HookSettings): HookSettings {
  const settings = structuredClone(saved)
  if (settings.rules.length) return settings
  settings.rules = (['enter', 'like', 'follow'] as const).map((kind, index) => ({
    id: `mock-default-${kind}`,
    name: `模拟${['欢迎', '点赞', '关注'][index]}测试`,
    enabled: true,
    source: 'tiktok',
    eventType: `viewer.${kind}`,
    conditions: [],
    actions: [
      {
        id: 'local-caption',
        type: 'obs.art-text',
        inputName: OBS_INSTANT_INPUTS[index],
        template: `${['欢迎', '感谢点赞', '感谢关注'][index]} {{user.screenName}}`,
        style: 'rainbow',
        holdMs: 600,
        delivery: 'immediate',
      },
    ],
  }))
  return settings
}
