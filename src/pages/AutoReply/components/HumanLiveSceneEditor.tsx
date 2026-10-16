import type { DeepSeekAutoSettings, HumanLiveScene } from 'shared/deepSeekAuto'

const field = 'w-full rounded border bg-background px-3 py-2 text-sm'
export function HumanLiveSceneEditor({
  settings,
  disabled,
  change,
}: {
  settings: DeepSeekAutoSettings
  disabled: boolean
  change: (settings: DeepSeekAutoSettings) => void
}) {
  const scenes = settings.scenes || []
  const scene = scenes.find(value => value.id === settings.selectedSceneId)
  const update = (next: HumanLiveScene) =>
    change({ ...settings, scenes: scenes.map(value => (value.id === next.id ? next : value)) })
  return (
    <div className="rounded border p-3 space-y-3">
      <p className="font-medium">真人直播场景</p>
      <p className="text-xs text-muted-foreground">
        每场直播选一个场景。场景总纲和知识库共同决定回复内容。
      </p>
      <div className="flex gap-2">
        <select
          className={field}
          value={settings.selectedSceneId || ''}
          disabled={disabled}
          onChange={e => change({ ...settings, selectedSceneId: e.target.value })}
        >
          <option value="">选择场景</option>
          {scenes.map(value => (
            <option key={value.id} value={value.id}>
              {value.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded border px-3 whitespace-nowrap"
          disabled={disabled || scenes.length >= 30}
          onClick={() => {
            const next = {
              id: crypto.randomUUID(),
              name: '真人发饰直播',
              policy: '',
              knowledge: [],
            }
            change({ ...settings, selectedSceneId: next.id, scenes: [...scenes, next] })
          }}
        >
          新建场景
        </button>
      </div>
      {scene && (
        <>
          <label className="block text-sm">
            场景名称
            <input
              className={field}
              value={scene.name}
              disabled={disabled}
              onChange={e => update({ ...scene, name: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            本场景补充（叠加在全局 AI 总纲之后，可留空）
            <textarea
              className={`${field} min-h-24`}
              value={scene.policy}
              disabled={disabled}
              placeholder="只写这一个场景特有的要求，如：本场只讲 05、06 两个编号，不主动提价格。"
              onChange={e => update({ ...scene, policy: e.target.value })}
            />
          </label>
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">知识库</span>
            <button
              type="button"
              className="rounded border px-3 py-1 text-sm"
              disabled={disabled || scene.knowledge.length >= 50}
              onClick={() =>
                update({
                  ...scene,
                  knowledge: [
                    ...scene.knowledge,
                    { id: crypto.randomUUID(), name: '新资料', content: '' },
                  ],
                })
              }
            >
              新增资料
            </button>
          </div>
          {scene.knowledge.map(entry => (
            <div key={entry.id} className="rounded border p-2 space-y-2">
              <div className="flex gap-2">
                <input
                  className={field}
                  value={entry.name}
                  disabled={disabled}
                  onChange={e =>
                    update({
                      ...scene,
                      knowledge: scene.knowledge.map(value =>
                        value.id === entry.id ? { ...value, name: e.target.value } : value,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="rounded border px-2"
                  disabled={disabled}
                  onClick={() =>
                    update({
                      ...scene,
                      knowledge: scene.knowledge.filter(value => value.id !== entry.id),
                    })
                  }
                >
                  删除
                </button>
              </div>
              <textarea
                className={`${field} min-h-28`}
                value={entry.content}
                disabled={disabled}
                placeholder="一行一条已确认的事实，例如：001 号发夹宽约 8 厘米。"
                onChange={e =>
                  update({
                    ...scene,
                    knowledge: scene.knowledge.map(value =>
                      value.id === entry.id ? { ...value, content: e.target.value } : value,
                    ),
                  })
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm"
            disabled={disabled}
            onClick={() =>
              change({
                ...settings,
                selectedSceneId: '',
                scenes: scenes.filter(value => value.id !== scene.id),
              })
            }
          >
            删除此场景
          </button>
        </>
      )}
    </div>
  )
}
