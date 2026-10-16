import type { DirectorTransitionConfig, DirectorTransitionMode } from 'shared/director'

const MODES: Array<{ value: DirectorTransitionMode; label: string }> = [
  { value: 'none', label: '无额外转场' },
  { value: 'blink', label: '眨眼遮挡（旧版）' },
  { value: 'hunt', label: '拉风箱 · 对焦犹豫（建议 800~1000ms）' },
  { value: 'defocus', label: '对称失焦 · 糊上→停→对回（建议 250~400ms）' },
  { value: 'dissolve', label: '交叉叠化（不模糊）' },
]
const inputClass = 'w-full rounded-md border bg-background p-2 text-sm'
const isMode = (value: string): value is DirectorTransitionMode =>
  MODES.some(item => item.value === value)
/** 需要 Composite Blur 的模式：只有它们才用得上失焦半径 */
const BLUR_MODES: DirectorTransitionMode[] = ['defocus', 'hunt']
const needsRadius = (mode: DirectorTransitionMode) => BLUR_MODES.includes(mode)

export function TransitionSettings({
  value,
  onChange,
}: {
  value?: DirectorTransitionConfig
  onChange: (value: DirectorTransitionConfig) => void
}) {
  const current = value ?? { mode: 'blink' as const, durationMs: 300, strength: 10 }
  const back = current.back
  return (
    <fieldset className="space-y-3 rounded-md border p-3 text-sm">
      <legend>状态切换：A ↔ B / C</legend>

      <div className="space-y-2 rounded-md border p-2">
        <p className="font-medium">去程（A → B / C）</p>
        <label className="block space-y-1">
          <span>转场方式</span>
          <select
            className={inputClass}
            value={current.mode}
            onChange={event => {
              if (isMode(event.target.value)) onChange({ ...current, mode: event.target.value })
            }}
          >
            {MODES.map(item => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span>转场时长（毫秒，建议 250～350）</span>
          <input
            className={inputClass}
            type="number"
            min={0}
            max={2000}
            step={10}
            disabled={current.mode === 'none'}
            value={current.durationMs}
            onChange={event => onChange({ ...current, durationMs: Number(event.target.value) })}
          />
        </label>
        <label className="block space-y-1">
          <span>失焦半径（像素，建议 10）</span>
          <input
            className={inputClass}
            type="number"
            min={1}
            max={30}
            step={1}
            disabled={!needsRadius(current.mode)}
            value={current.strength}
            onChange={event => onChange({ ...current, strength: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="space-y-2 rounded-md border p-2">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={back !== undefined}
            onChange={event =>
              onChange(
                event.target.checked
                  ? {
                      ...current,
                      back: {
                        mode: current.mode,
                        durationMs: current.durationMs,
                        strength: current.strength,
                      },
                    }
                  : { ...current, back: undefined },
              )
            }
          />
          <span>回程（B / C → A）单独设置</span>
        </label>
        {back === undefined ? (
          <p className="text-muted-foreground text-xs">未勾选时沿用去程的设置。</p>
        ) : (
          <>
            <label className="block space-y-1">
              <span>转场方式</span>
              <select
                className={inputClass}
                value={back.mode ?? current.mode}
                onChange={event => {
                  if (isMode(event.target.value))
                    onChange({ ...current, back: { ...back, mode: event.target.value } })
                }}
              >
                {MODES.map(item => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span>转场时长（毫秒）</span>
              <input
                className={inputClass}
                type="number"
                min={0}
                max={2000}
                step={10}
                disabled={(back.mode ?? current.mode) === 'none'}
                value={back.durationMs ?? current.durationMs}
                onChange={event =>
                  onChange({
                    ...current,
                    back: { ...back, durationMs: Number(event.target.value) },
                  })
                }
              />
            </label>
            <label className="block space-y-1">
              <span>失焦半径（像素）</span>
              <input
                className={inputClass}
                type="number"
                min={1}
                max={30}
                step={1}
                disabled={!needsRadius(back.mode ?? current.mode)}
                value={back.strength ?? current.strength}
                onChange={event =>
                  onChange({ ...current, back: { ...back, strength: Number(event.target.value) } })
                }
              />
            </label>
            <p className="text-muted-foreground text-xs">
              去程是「从总览凑近看细节」，失焦更贴语义；回程是「物品归位」，两个画面都是静帧，
              用交叉叠化更干净，也不会把摆放位置的细微差别暴露出来。
            </p>
          </>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        切换点一律做交叉叠化，不再一帧顶上（硬切会让两幅模糊画面的平均亮度跳变，看起来像闪白）。
        失焦每次的峰值半径、时长与进出比例会轻微随机，避免每场动作一模一样。
        拉风箱还会随机「第一次对上」的深度，并偶尔多犹豫一次。
        时长对两种失焦含义不同：拉风箱是整段犹豫过程的长度，对称失焦是「糊上去 + 对回来」的总长。
        失焦仅作用于主画面，不处理字幕、素材组或配音；同一商品连续步骤不增加转场。
        失焦需要已安装的 Composite Blur，缺失会明确报错，不会回退黑场。
      </p>
    </fieldset>
  )
}
