import { useMemo, useState } from 'react'
import type { DirectorConfig } from 'shared/director'
import {
  type InteractionGoal,
  type InteractionScript,
  type InteractionScriptConfig,
  INTERACTION_GOAL_HINTS,
  INTERACTION_GOAL_LABELS,
  INTERACTION_GOAL_ORDER,
  defaultInteractionScript,
} from 'shared/interactionScript'

const secondary = 'rounded border px-2 py-1 text-xs disabled:opacity-50'
const inputClass = 'w-full rounded border bg-background px-2 py-1 text-xs'

interface StepOption {
  /** 步骤名，写进配置用的就是这个 */
  name: string
  /** 显示用前缀（段位 + 商品编号） */
  prefix: string
}

/** 把 A/B/C 的步骤平铺成一条直线 —— 用户明确要求不分段位，就是一条线。 */
export function flattenStepNames(config: DirectorConfig): StepOption[] {
  const options: StepOption[] = []
  const seen = new Set<string>()
  for (const tray of config.trays) {
    for (const step of tray.A || []) push(step.name, 'A')
    for (const product of tray.products || [])
      for (const mode of ['B', 'C'] as const)
        for (const step of product[mode] || []) push(step.name, `${mode} ${product.id}`)
  }
  /** 同名步骤只列一次 —— 配置是按名字匹配的，列多了会让人以为要逐个配。 */
  function push(name: string, prefix: string) {
    const trimmed = name?.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    options.push({ name: trimmed, prefix })
  }
  return options
}

function GoalPicker({
  goals,
  onChange,
}: {
  goals: InteractionGoal[]
  onChange: (goals: InteractionGoal[]) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {INTERACTION_GOAL_ORDER.map(goal => {
        const index = goals.indexOf(goal)
        const on = index >= 0
        return (
          <button
            key={goal}
            type="button"
            title={INTERACTION_GOAL_HINTS[goal]}
            className={`rounded border px-2 py-0.5 text-xs ${
              on ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
            }`}
            onClick={() =>
              onChange(on ? goals.filter(item => item !== goal) : [...goals, goal])
            }
          >
            {on ? `${index + 1}. ` : ''}
            {INTERACTION_GOAL_LABELS[goal]}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 按步骤的互动话术配置。
 *
 * **步骤决定「引导什么」，窗口决定「说多长」** —— 这张表只管前者；
 * 后者由预瞄 + 字数预算负责，AI 把两者揉成一句自然的话。
 */
export function InteractionScripts({
  config,
  patch,
}: {
  config: DirectorConfig
  patch: (next: Partial<InteractionScriptConfig>) => void
}) {
  const script: InteractionScriptConfig =
    config.interaction?.interactionScript ?? defaultInteractionScript()
  const [adding, setAdding] = useState('')
  const steps = useMemo(() => flattenStepNames(config), [config])
  const configured = new Set(script.scripts.map(item => item.step))
  const available = steps.filter(option => !configured.has(option.name))

  const replace = (index: number, next: InteractionScript) =>
    patch({ scripts: script.scripts.map((item, i) => (i === index ? next : item)) })
  const remove = (index: number) =>
    patch({ scripts: script.scripts.filter((_, i) => i !== index) })
  const add = () => {
    if (!adding) return
    patch({ scripts: [...script.scripts, { step: adding, goals: ['greet'], hint: '' }] })
    setAdding('')
  }

  return (
    <fieldset className="md:col-span-2 space-y-3 rounded border p-3">
      <legend className="px-1 text-sm font-medium">互动话术（例外覆盖）</legend>
      <p className="text-xs text-muted-foreground">
        优先级主要由<b>总纲</b>决定，AI 会看着现场自己判断该说什么 ——
        观众刚问了问题就优先答他，刚进房就优先欢迎，不机械地挨个念。
        <b>所以这张表平时不用配</b>，只在某个步骤你想强制或禁止某一项时，才加一行覆盖默认。
        <br />
        <b>说多长</b>由预瞄自动控制（窗口多大就说到哪一级），不用在这里配。
      </p>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={script.enabled}
            onChange={e => patch({ enabled: e.target.checked })}
          />
          启用语音互动话术
        </label>
        <label className="flex items-center gap-2">
          预瞄提前量
          <input
            type="number"
            min={2}
            max={20}
            step={0.5}
            className="w-20 rounded border bg-background px-2 py-1 text-xs"
            value={script.leadSeconds}
            onChange={e => patch({ leadSeconds: Number(e.target.value) })}
          />
          秒
        </label>
        <span className="text-muted-foreground">
          实测生成耗时约 1.4~4.1 秒（DeepSeek 0.85s + 千问 0.8~2.8s + 预载 0.5s）。
          改大更稳，但能瞄准的窗口更少。
        </span>
      </div>

      <div className="space-y-2">
        {script.scripts.map((item, index) => (
          <div key={`${item.step || '__default__'}`} className="space-y-2 rounded border p-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium">
                {item.step ? item.step : '默认（AI 参考这个优先级，自己判断说到哪一级）'}
              </span>
              {item.step && (
                <button type="button" className="text-destructive" onClick={() => remove(index)}>
                  删除
                </button>
              )}
            </div>
            <GoalPicker
              goals={item.goals}
              onChange={goals => replace(index, { ...item, goals })}
            />
            <input
              className={inputClass}
              placeholder="附加指引，可留空。例如：评论报编号，我给你看颜色"
              value={item.hint}
              onChange={e => replace(index, { ...item, hint: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              点上面的按钮切换引导项，<b>点选顺序就是优先级</b>。
              「引导评论」最值钱 —— 评论会触发画面展示。
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="rounded border bg-background px-2 py-1 text-xs"
          value={adding}
          onChange={e => setAdding(e.target.value)}
        >
          <option value="">选一个要强制覆盖的步骤…</option>
          {available.map(option => (
            <option key={option.name} value={option.name}>
              {option.prefix} / {option.name}
            </option>
          ))}
        </select>
        <button type="button" className={secondary} disabled={!adding} onClick={add}>
          添加
        </button>
        <span className="text-muted-foreground">
          一共 {steps.length} 个步骤，已单独配 {script.scripts.filter(item => item.step).length} 个
        </span>
      </div>
    </fieldset>
  )
}
