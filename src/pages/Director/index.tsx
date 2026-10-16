import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_CTA_SUBTEXT, DEFAULT_CTA_TEXT } from 'shared/ctaOverlay'
import type {
  DirectorCommand,
  DirectorConfig,
  DirectorOverlayVariant,
  DirectorPlatformKeyword,
  DirectorProduct,
} from 'shared/director'
import {
  DEFAULT_CANCEL_KEYWORDS,
  DEFAULT_GREETING_REPLY,
  DEFAULT_MENTION_TEMPLATE,
  DEFAULT_MODE_KEYWORDS,
  DEFAULT_XIAOHONGSHU_KEYWORDS,
  type DirectorSnapshot,
  type DirectorStep,
  defaultDirectorConfig,
  directorStepCues,
  directorStepOverlayVariants,
  isDirectorVideoStep,
  newDirectorContinuationStep,
} from 'shared/director'
import type { DirectorChange } from 'shared/directorDiff'
import { diffDirectorConfig, summarizeChanges } from 'shared/directorDiff'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import type { ObsSceneMetadata } from 'shared/obsEffect'
import type { PopupClash } from 'shared/popupTimeline'
import {
  crowdedPopups,
  describeClash,
  MIN_POPUP_GAP_SECONDS,
  popupMoments,
} from 'shared/popupTimeline'
import type { ViewerScoreConfig, ViewerScoreRule } from 'shared/viewerScore'
import {
  type InteractionScriptConfig,
  defaultInteractionScript,
} from 'shared/interactionScript'
import { DEFAULT_VIEWER_SCORE, VIEWER_SCORE_LABELS, VIEWER_SCORE_ORDER } from 'shared/viewerScore'
import { useAccounts } from '@/hooks/useAccounts'
import { TransitionSettings } from './TransitionSettings'
import { SpeechSlots } from './SpeechSlots'
import { InteractionScripts } from './InteractionScripts'
import { TargetMode } from './TargetMode'
import InteractiveExperiment from './InteractiveExperiment'

const inputClass = 'w-full rounded-md border bg-background p-2 text-sm'
const buttonClass = 'rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40'
const obsGroupListId = 'director-obs-groups'

/** 改动条目的语气色：新增绿、删除红、修改中性。 */
const changeTone: Record<DirectorChange['kind'], string> = {
  added: 'text-emerald-600',
  removed: 'text-red-600',
  changed: 'text-amber-700',
}
const changeSign: Record<DirectorChange['kind'], string> = {
  added: '＋',
  removed: '－',
  changed: '·',
}

/**
 * 「这次跟上次比，我改了什么」。
 *
 * 按作用域分组，用托盘名 / 商品编号 / 步骤名说话，不暴露字段路径 ——
 * 目的只是让人扫一眼就能确认"刚才那一下是不是我改的"，或者决定要不要回滚。
 */
function ChangeList({
  changes,
  onRollback,
}: {
  changes: DirectorChange[]
  onRollback: () => void
}) {
  const groups: Array<[string, DirectorChange[]]> = []
  for (const change of changes) {
    const last = groups.at(-1)
    if (last && last[0] === change.scope) last[1].push(change)
    else groups.push([change.scope, [change]])
  }
  return (
    <div className="rounded border p-3 text-sm space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          和上次保存的版本对比（{changes.length} 处）—— 保存才会产生新版本，中途再改还是比这一版
        </span>
        <button type="button" className={buttonClass} onClick={onRollback}>
          全部回滚
        </button>
      </div>
      {groups.map(([scope, items]) => (
        <div key={scope} className="space-y-1">
          <div className="text-muted-foreground">{scope}</div>
          <ul className="space-y-1 pl-3">
            {items.map((change, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Diff rows have no persistent IDs and contain only stateless text.
              <li key={`${change.field}-${index}`}>
                <span className={changeTone[change.kind]}>{changeSign[change.kind]}</span>{' '}
                <span className="font-medium">{change.field}</span>
                <span className="text-muted-foreground"> · </span>
                {change.summary}
                {change.lines && change.lines.length > 0 && (
                  <div className="mt-1 space-y-0.5 pl-4 font-mono text-xs">
                    {change.lines.map((line, lineIndex) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: Identical diff lines may repeat; these rows contain no state.
                        key={lineIndex}
                        className={
                          line.startsWith('+')
                            ? 'text-emerald-600'
                            : line.startsWith('-')
                              ? 'text-red-600'
                              : 'text-muted-foreground'
                        }
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function defaultInteraction(): NonNullable<DirectorConfig['interaction']> {
  return {
    enabled: false,
    observeOnly: true,
    publicReply: false,
    model: 'deepseek-chat',
    modeKeywords: {},
  }
}
/** 逗号/顿号/空格分隔的词表 → 数组（去空、去重、最多 60 条） */
function parseModeWords(value: string) {
  const words = value
    .split(/[，,、\s]+/)
    .map(word => word.trim())
    .filter(Boolean)
  return [...new Set(words)].slice(0, 60)
}
/** 编辑框里显示：配置没填就显示出厂词表，让用户看见当前实际生效的词 */
function showModeWords(value: string[] | undefined, fallback: string[]) {
  return (value?.length ? value : fallback).join('，')
}
async function call(command: DirectorCommand) {
  const result = await window.ipcRenderer.invoke(IPC_CHANNELS.director.request, command)
  if (!result.ok) throw new Error(result.error || '操作失败')
  return result
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Callers supply the nested form control through children.
    <label className="block space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
/** 全局设置分组的横贯标题：全局配置太多，不给路标就没法找。 */
function GroupHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="md:col-span-2 mt-2 border-b pb-1 first:mt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <Field label={label}>
      <input
        className={inputClass}
        type="number"
        step="0.1"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
    </Field>
  )
}
function FileField({
  label,
  value,
  kind,
  onChange,
}: {
  label: string
  value: string
  kind: 'video' | 'image' | 'audio' | 'executable'
  onChange: (s: string) => void
}) {
  const [error, setError] = useState('')
  return (
    <div className="space-y-1">
      <Field label={label}>
        <div className="flex gap-2">
          <input className={inputClass} value={value} readOnly placeholder="选择本地文件" />
          <button
            className={buttonClass}
            type="button"
            onClick={async () => {
              try {
                const r = await call({ action: 'pick', kind })
                if (r.file) onChange(r.file)
                setError('')
              } catch (e) {
                setError(String(e))
              }
            }}
          >
            选择
          </button>
          {value && (
            <button className={buttonClass} type="button" onClick={() => onChange('')}>
              清除
            </button>
          )}
        </div>
      </Field>
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  )
}
function AudioList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-sm">配音版本（按顺序轮换）</p>
      {value.map((file, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Repeated audio paths are valid ordered variants; rows have no local state.
        <div key={`${i}-${file}`} className="flex gap-2 items-center text-xs">
          <span className="truncate flex-1" title={file}>
            {file.split(/[\\/]/).pop()}
          </span>
          <button
            type="button"
            className={buttonClass}
            onClick={async () => {
              try {
                setUrl((await call({ action: 'preview-file', file })).url || '')
              } catch (e) {
                setError(String(e))
              }
            }}
          >
            试听
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            移除
          </button>
        </div>
      ))}
      <FileField
        label="添加一个音频版本"
        value=""
        kind="audio"
        onChange={file => {
          if (file) onChange([...value, file])
        }}
      />
      {url && (
        // biome-ignore lint/a11y/useMediaCaption: Local audio preview has no supplied caption track.
        <audio controls src={url} className="w-full" />
      )}
      {error && <p>{error}</p>}
    </div>
  )
}
function StepEditor({
  step,
  update,
  popupEnabled,
  clashes,
}: {
  step: DirectorStep
  update: (patch: Partial<DirectorStep>) => void
  /** 全局商品弹窗总开关。关着的话，配了时间点也不会弹 —— 要在这里说清楚。 */
  popupEnabled: boolean
  /** 本段（B 或 C）里挨得太近的弹卡对，用来在配时间点的地方直接提示。 */
  clashes: PopupClash[]
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [cueGoodsId, setCueGoodsId] = useState('')
  const slicePlaying = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload only when the file changes; editing its cut start must not reload playback.
  useEffect(() => {
    let live = true
    setUrl('')
    setError('')
    setTime(step.start)
    setPlaying(false)
    slicePlaying.current = false
    if (step.file)
      void call({ action: 'preview-file', file: step.file })
        .then(r => {
          if (live) setUrl(r.url || '')
        })
        .catch(e => {
          if (live) setError(String(e))
        })
    return () => {
      live = false
    }
  }, [step.file])
  const seek = (next: number) => {
    const value = Math.max(0, Math.min(next, duration || next))
    if (video.current) video.current.currentTime = value
    setTime(value)
  }
  const pause = () => {
    video.current?.pause()
    slicePlaying.current = false
    setPlaying(false)
  }
  const playFrom = (from: number, stopAtEnd: boolean) => {
    const current = video.current
    if (!current) return
    current.currentTime = Math.max(0, Math.min(from, duration || from))
    slicePlaying.current = stopAtEnd
    void current.play().catch(e => setError(String(e)))
  }
  const startPercent = duration > 0 ? Math.min(100, (step.start / duration) * 100) : 0
  const effectiveEnd = step.end > 0 ? step.end : duration
  const selectedDuration = Math.max(0, effectiveEnd - step.start)
  const selectedDurationKnown = step.end > 0 || duration > 0
  const endPercent = duration > 0 ? Math.min(100, (effectiveEnd / duration) * 100) : 100
  const currentPercent = duration > 0 ? Math.min(100, (time / duration) * 100) : 0
  const cues = directorStepCues(step)
  const videoStep = isDirectorVideoStep(step)
  const overlayVariants = directorStepOverlayVariants(step)
  const updateOverlayVariant = (id: string, patch: Partial<DirectorOverlayVariant>) =>
    update({
      overlayVariants: overlayVariants.map(variant =>
        variant.id === id ? { ...variant, ...patch } : variant,
      ),
    })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="步骤名称">
          <input
            className={inputClass}
            value={step.name}
            onChange={e => update({ name: e.target.value })}
          />
        </Field>
        <Field label="步骤类型">
          <select
            className={inputClass}
            value={step.kind}
            onChange={e => {
              const kind = e.target.value as DirectorStep['kind']
              update({
                kind,
                ...(videoStep === (kind !== 'image') ? {} : { file: '', start: 0, end: 0 }),
                overlayGroup:
                  kind === 'video-obs-group' ? step.overlayGroup || '商品搭配图' : undefined,
                overlayVariants:
                  kind === 'video-obs-group'
                    ? step.overlayVariants?.length
                      ? step.overlayVariants
                      : [
                          {
                            id: crypto.randomUUID(),
                            name: '搭配 1',
                            overlayGroup: step.overlayGroup || '商品搭配图',
                            audio: step.audio,
                          },
                        ]
                    : step.overlayVariants,
              })
            }}
          >
            <option value="video">视频片段＋配音</option>
            <option value="video-obs-group">视频片段＋配音＋OBS角标素材组</option>
            <option value="image">图片＋配音</option>
          </select>
        </Field>
      </div>
      <FileField
        label={
          videoStep ? '原始完整视频（多个步骤可复用）' : '图片（全屏等比显示，底层保留上一帧）'
        }
        value={step.file}
        kind={videoStep ? 'video' : 'image'}
        onChange={file => update({ file })}
      />
      <Field label="本步骤临时 OBS 组（可留空）">
        <input
          className={inputClass}
          list={obsGroupListId}
          value={step.stepGroup || ''}
          onChange={e => update({ stepGroup: e.target.value })}
          placeholder="从已读取的 OBS 组中选择，也可手动输入"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          只在本步骤播放期间整组显示；A/B/C 默认组仍会同时显示。同一个组可以复用于多个步骤。
        </p>
      </Field>
      {step.kind === 'video-obs-group' && (
        <div className="space-y-3 rounded border p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">角标素材组与配音（成套轮换）</p>
            <button
              className={buttonClass}
              type="button"
              onClick={() =>
                update({
                  overlayVariants: [
                    ...overlayVariants,
                    {
                      id: crypto.randomUUID(),
                      name: `搭配 ${overlayVariants.length + 1}`,
                      overlayGroup: '',
                      audio: [],
                    },
                  ],
                })
              }
            >
              新增一套
            </button>
          </div>
          {overlayVariants.map((variant, variantIndex) => (
            <div key={variant.id} className="space-y-3 rounded border p-3">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                <Field label="搭配名称">
                  <input
                    className={inputClass}
                    value={variant.name}
                    onChange={e => updateOverlayVariant(variant.id, { name: e.target.value })}
                    placeholder={`搭配 ${variantIndex + 1}`}
                  />
                </Field>
                <Field label="OBS 角标素材组名称">
                  <input
                    className={inputClass}
                    list={obsGroupListId}
                    value={variant.overlayGroup}
                    onChange={e =>
                      updateOverlayVariant(variant.id, { overlayGroup: e.target.value })
                    }
                    placeholder="例如：通勤搭配"
                  />
                </Field>
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() =>
                    update({
                      overlayVariants: overlayVariants.filter(item => item.id !== variant.id),
                    })
                  }
                >
                  删除
                </button>
              </div>
              <AudioList
                value={variant.audio}
                onChange={audio => updateOverlayVariant(variant.id, { audio })}
              />
            </div>
          ))}
          <p className="mt-1 text-xs text-muted-foreground">
            每次执行会轮换选择一整套，再从这一套的 OBS
            组中随机挑选图片或“媒体源”视频，并播放该套自己的配音。视频会自动循环到主步骤结束。
          </p>
        </div>
      )}
      {url && videoStep && (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: Local source preview has no supplied caption track. */}
          <video
            ref={video}
            src={url}
            controls
            className="w-full max-h-80 rounded bg-black"
            onLoadedMetadata={() => {
              const current = video.current
              if (!current) return
              setDuration(current.duration || 0)
              current.currentTime = Math.min(step.start, current.duration || step.start)
              setTime(current.currentTime)
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={() => {
              const v = video.current
              if (!v) return
              setTime(v.currentTime)
              if (slicePlaying.current && step.end > 0 && v.currentTime >= step.end) {
                v.pause()
                slicePlaying.current = false
              }
            }}
            onError={() => setError('预览无法解码此文件，可尝试 MP4/H.264 格式')}
          />
          <div className="space-y-1">
            {/* biome-ignore lint/a11y/useSemanticElements: This group is a visual timeline, not a fieldset of form inputs. */}
            <div className="relative h-7" role="group" aria-label="视频切片进度条">
              <div className="absolute left-0 right-0 top-2.5 h-2 rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className="absolute top-0 h-2 rounded-full bg-emerald-500/70"
                  style={{
                    left: `${startPercent}%`,
                    width: `${Math.max(0, endPercent - startPercent)}%`,
                  }}
                />
              </div>
              <span
                className="absolute top-1.5 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-white bg-blue-600 shadow"
                style={{ left: `${startPercent}%` }}
                title={`起点 ${step.start.toFixed(2)} 秒`}
              />
              <span
                className="absolute top-1.5 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-white bg-orange-500 shadow"
                style={{ left: `${endPercent}%` }}
                title={step.end > 0 ? `终点 ${step.end.toFixed(2)} 秒` : '终点尚未设置'}
              />
              <span
                className="absolute top-1 h-5 w-1 -translate-x-1/2 rounded bg-slate-950 dark:bg-white"
                style={{ left: `${currentPercent}%` }}
                title={`当前位置 ${time.toFixed(2)} 秒`}
              />
              {cues.map(cue => (
                <span
                  key={cue.id}
                  className="absolute top-0 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-white bg-fuchsia-600 shadow"
                  style={{
                    left: `${duration > 0 ? Math.min(100, ((step.start + cue.at) / duration) * 100) : 0}%`,
                  }}
                  title={`商品卡片 ${cue.goodsId}：本段 ${cue.at.toFixed(2)} 秒`}
                />
              ))}
              <input
                aria-label="拖动视频位置"
                className="absolute inset-0 h-7 w-full cursor-pointer opacity-0"
                type="range"
                min={0}
                max={duration || 0}
                step={0.01}
                value={Math.min(time, duration || 0)}
                onChange={e => {
                  pause()
                  seek(Number(e.target.value))
                }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>蓝点：起点</span>
              <span>绿段：本步骤</span>
              <span>橙点：终点</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center text-sm">
            <span>
              {time.toFixed(2)} / {duration.toFixed(2)} 秒
            </span>
            <button
              className={buttonClass}
              type="button"
              onClick={() => {
                const start = Number((video.current?.currentTime ?? time).toFixed(3))
                update({ start })
              }}
            >
              设为起点
            </button>
            <button
              className={buttonClass}
              type="button"
              onClick={() => {
                pause()
                seek(0)
                update({ start: 0 })
              }}
            >
              起点设为 0
            </button>
            <button
              className={buttonClass}
              type="button"
              onClick={() => {
                pause()
                update({ end: Number((video.current?.currentTime ?? time).toFixed(3)) })
              }}
            >
              设为终点
            </button>
            <button
              className={buttonClass}
              type="button"
              onClick={() => {
                if (playing) pause()
                else playFrom(time >= duration - 0.05 ? step.start : time, false)
              }}
            >
              {playing ? '暂停' : '继续播放'}
            </button>
            <button
              className={buttonClass}
              type="button"
              onClick={() => playFrom(step.start, true)}
            >
              从起点预览本段
            </button>
          </div>
        </>
      )}
      {url && step.kind === 'image' && (
        <img
          alt="步骤素材预览"
          src={url}
          className="max-h-72 w-full object-contain rounded bg-black"
        />
      )}
      {error && <p className="text-red-500 text-sm">{error}</p>}
      {videoStep ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="起点（秒）"
              value={step.start}
              onChange={start => update({ start })}
            />
            <NumberField
              label="终点（秒，0＝片尾）"
              value={step.end}
              onChange={end => update({ end })}
            />
          </div>
          <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
            本步骤视频时长：
            <strong>
              {selectedDurationKnown ? `${selectedDuration.toFixed(2)} 秒` : '等待读取视频'}
            </strong>
            {selectedDurationKnown && step.end <= 0 && (
              <span className="ml-1 text-xs text-muted-foreground">（从起点到片尾）</span>
            )}
          </div>
        </div>
      ) : (
        <NumberField
          label="没有配音时的图片停留秒数；有配音则等配音结束"
          value={step.duration}
          onChange={duration => update({ duration })}
        />
      )}
      {step.kind !== 'video-obs-group' && (
        <AudioList
          value={step.audio}
          onChange={audio =>
            update({
              audio,
              speechWindows: (step.speechWindows || []).filter(w => audio.includes(w.audio)),
            })
          }
        />
      )}
      {videoStep && (
        <Field label="配音比视频片段长时">
          <select
            className={inputClass}
            value={step.audioOverflow || 'continue'}
            onChange={e =>
              update({
                audioOverflow: e.target.value as 'continue' | 'hold' | 'strict',
                ...(e.target.value !== 'continue' ? { speechSlot: false, speechWindows: [] } : {}),
              })
            }
          >
            <option value="continue">视频连续：配音可以跨到下一画面（推荐）</option>
            <option value="hold">步骤同步：停留在本步骤末帧</option>
            <option value="strict">严格匹配：启动时报错</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            连续模式保持视频按切点向前播放，旁白按顺序说完；只有整个 A/B/C 结束后旁白仍未结束，
            才停在最终画面等待。
          </p>
        </Field>
      )}
      {videoStep && (step.audioOverflow || 'continue') === 'continue' && (
        <>
          <label className="block rounded border p-3 text-sm">
            <input
              type="checkbox"
              checked={Boolean(step.speechSlot)}
              disabled={Boolean(step.speechWindows?.length)}
              onChange={e => update({ speechSlot: e.target.checked })}
            />{' '}
            允许互动回复替换本段配音
            <p className="mt-1 text-xs text-muted-foreground">
              仅勾选可省略的完整句子。原句结束后才接话；回复须已生成且实际时长能放入当前画面剩余时间，否则照常播原配音。关键商品讲解不要勾选。
            </p>
          </label>
          <SpeechSlots step={step} update={update} />
        </>
      )}
      {Boolean(step.speechWindows?.length) && (
        <div className="space-y-2 rounded border p-3 text-sm">
            <p>语音窗口审核记录（秒，以配音文件开头计时）</p>
          {step.speechWindows?.map((window, index) => (
            <div
              key={`${window.audio}:${window.start}`}
              className="flex items-center justify-between gap-2"
            >
              <span className="break-all">
                {window.audio.split(/[\\/]/).pop()}：{window.start.toFixed(2)} —{' '}
                  {window.end.toFixed(2)}
                  {' · '}{!window.review || !window.material ? '旧窗口：未启用，请重新分析审核' : window.kind === 'silence' ? '静音插入' : '整句替换'}
                  {window.transcript?.text && <span className="block">原句：{window.transcript.text}</span>}
                  {window.review && <span className="block text-xs text-muted-foreground">审核理由：{window.review.reason}</span>}
              </span>
              <button
                type="button"
                className="text-destructive"
                onClick={() =>
                  update({ speechWindows: step.speechWindows?.filter((_, i) => i !== index) })
                }
              >
                保留原句
              </button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
              旧自动切段不会直接启用。上方重新分析并逐句审核后保存；未批准部分保留原配音。
          </p>
        </div>
      )}
      <div className="space-y-2 rounded border p-3">
        <p className="text-sm">商品链接时间点</p>
        {!popupEnabled && (
          <p className="rounded border border-amber-500 bg-amber-500/10 p-2 text-xs text-amber-700">
            ⚠ <b>商品弹窗总开关是关着的</b>，下面这些时间点一个都不会弹。 去「全局设置与 OBS 输出 →
            商品弹窗总开关」打开它，并且要用 「准备并启动 OBS 导播」（模拟流程不弹）。
          </p>
        )}
        {clashes.length > 0 && (
          <p className="rounded border border-amber-500 bg-amber-500/10 p-2 text-xs text-amber-700">
            ⚠ 这一段有 {clashes.length} 处弹卡挨得太近（不到 {MIN_POPUP_GAP_SECONDS} 秒），
            会连着弹好几下同一张卡 —— 平台侧看不出，但每次都会真发一次请求：
            <span className="mt-1 block space-y-0.5">
              {clashes.map((clash, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Recomputed collision descriptions are stateless and have no IDs.
                <span key={index} className="block">
                  · {describeClash(clash)}
                </span>
              ))}
            </span>
          </p>
        )}
        {cues.map(cue => (
          <div key={cue.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <NumberField
              label="本段第几秒"
              value={cue.at}
              onChange={at =>
                update({
                  cues: cues.map(item => (item.id === cue.id ? { ...item, at } : item)),
                  goodsId: null,
                })
              }
            />
            <NumberField
              label="商品卡片编号"
              value={cue.goodsId}
              onChange={goodsId =>
                update({
                  cues: cues.map(item => (item.id === cue.id ? { ...item, goodsId } : item)),
                  goodsId: null,
                })
              }
            />
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                update({ cues: cues.filter(item => item.id !== cue.id), goodsId: null })
              }
            >
              删除
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 items-end">
          <Field label="要弹出的商品卡片编号">
            <input
              type="number"
              min={1}
              className={inputClass}
              value={cueGoodsId}
              onChange={e => setCueGoodsId(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className={buttonClass}
            disabled={!Number.isInteger(Number(cueGoodsId)) || Number(cueGoodsId) < 1}
            onClick={() => {
              const visualEnd = step.end > step.start ? step.end : duration
              const at = videoStep
                ? Math.min(Math.max(0, visualEnd - step.start), Math.max(0, time - step.start))
                : 0
              update({
                cues: [
                  ...cues,
                  {
                    id: crypto.randomUUID(),
                    at: Number(at.toFixed(3)),
                    kind: 'goods',
                    goodsId: Number(cueGoodsId),
                  },
                ],
                goodsId: null,
              })
              setCueGoodsId('')
            }}
          >
            {videoStep ? '在当前画面添加' : '在图片开始时添加'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          视频无需为了切换链接而拆步骤；预览到梳子出现的画面，填写梳子编号后点击添加即可。
        </p>
      </div>
      <Field label="本步骤字幕（可留空）">
        <input
          className={inputClass}
          value={step.caption}
          onChange={e => update({ caption: e.target.value })}
        />
      </Field>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={step.optional}
          onChange={e => update({ optional: e.target.checked })}
        />
        素材不可用时允许跳过此步骤
      </label>
    </div>
  )
}

export default function Director() {
  const [config, setConfig] = useState<DirectorConfig>(defaultDirectorConfig)
  const [state, setState] = useState<DirectorSnapshot>()
  const [trayIndex, setTrayIndex] = useState(0)
  const [productIndex, setProductIndex] = useState(0)
  const [mode, setMode] = useState<'B' | 'C'>('B')
  const [stepIndex, setStepIndex] = useState(0)
  const [aStepIndex, setAStepIndex] = useState(0)
  const [tab, setTab] = useState<'edit' | 'live' | 'experiment'>('edit')
  const [message, setMessage] = useState('加载中…')
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [user, setUser] = useState('测试观众')
  // 未保存判定不用 dirty 布尔值，而是留一份「上次保存的版本」当基准：
  // 连改十次没保存，比的始终是同一个老版本 —— 只有保存才会产生新基准。
  const [baseline, setBaseline] = useState<DirectorConfig | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  /** 别处（API / MCP / 另一个窗口）改过配置，而本地还有没保存的改动 —— 保存会盖掉它。 */
  const [conflict, setConflict] = useState(false)
  const dirtyRef = useRef(false)
  const serverConfigRef = useRef('')
  const [rehearsal, setRehearsal] = useState<{ running: boolean; logs: string[] } | null>(null)
  const [rehearseSeconds, setRehearseSeconds] = useState(4)
  const [obsScenes, setObsScenes] = useState<ObsSceneMetadata[]>([])
  /** 每个托盘的 B/C 引导页本地文件路径（托盘 id → 路径），给用户复制到 OBS 用。 */
  const [ctaFiles, setCtaFiles] = useState<Record<string, string>>({})
  const accountId = useAccounts(s => s.currentAccountId)
  useEffect(() => {
    let live = true
    let inFlight = false
    void call({ action: 'state' })
      .then(r => {
        if (live) {
          if (r.config) {
            setConfig(r.config)
            setBaseline(r.config)
            serverConfigRef.current = JSON.stringify(r.config)
          }
          setState(r.state)
          if (r.ctaFiles) setCtaFiles(r.ctaFiles)
          setMessage('配置只保存在本机；模拟运行不会控制直播。')
        }
      })
      .catch(e => {
        if (live) setMessage(String(e))
      })
    const timer = setInterval(async () => {
      if (inFlight) return
      inFlight = true
      try {
        const r = await call({ action: 'state' })
        if (live) {
          setState(r.state)
          setRehearsal(r.rehearsal ?? null)
          // 热刷新：别处改过配置就自动跟进，不用切页面、不用点"重新载入"。
          // 本地有未保存改动时绝不覆盖，只提示冲突。
          if (r.config) {
            const next = JSON.stringify(r.config)
            if (next !== serverConfigRef.current) {
              serverConfigRef.current = next
              if (dirtyRef.current) setConflict(true)
              else {
                setConfig(r.config)
                setBaseline(r.config)
                setConflict(false)
              }
            }
          }
          if (r.ctaFiles) setCtaFiles(r.ctaFiles)
        }
      } catch {
      } finally {
        inFlight = false
      }
    }, 700)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  const tray = config.trays[trayIndex]
  const aSteps = tray?.A || []
  const aStep = aSteps[aStepIndex]
  const product = tray?.products[productIndex]
  const step = product?.[mode][stepIndex]
  const obsGroups = [
    ...new Set(
      (obsScenes.find(scene => scene.name === config.scene)?.sources || [])
        .filter(source => source.isGroup && source.containerName === config.scene)
        .map(source => source.name),
    ),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const edit = (fn: (c: DirectorConfig) => void) => {
    setConfig(current => {
      const next = structuredClone(current)
      fn(next)
      return next
    })
  }
  const changes = useMemo(
    () => (baseline ? diffDirectorConfig(baseline, config) : []),
    [baseline, config],
  )
  const dirty = changes.length > 0
  dirtyRef.current = dirty
  const viewerScoreConfig: ViewerScoreConfig =
    config.interaction?.viewerScore ?? DEFAULT_VIEWER_SCORE
  const patchViewerScore = (patch: Partial<ViewerScoreConfig>) =>
    edit(c => {
      const base = c.interaction ?? defaultInteraction()
      c.interaction = {
        ...base,
        viewerScore: { ...(base.viewerScore ?? DEFAULT_VIEWER_SCORE), ...patch },
      }
    })
  /** 改一条规则的扣分；写回时把三条都补齐并定序，配置里不留半截。 */
  const patchInteractionScript = (patch: Partial<InteractionScriptConfig>) =>
    edit(c => {
      const base = c.interaction ?? defaultInteraction()
      c.interaction = {
        ...base,
        interactionScript: {
          ...(base.interactionScript ?? defaultInteractionScript()),
          ...patch,
        },
      }
    })
  const patchViewerRule = (when: ViewerScoreRule, delta: number) =>
    patchViewerScore({
      rules: VIEWER_SCORE_ORDER.map(item => ({
        when: item,
        delta:
          item === when
            ? delta
            : (viewerScoreConfig.rules.find(rule => rule.when === item)?.delta ?? 0),
      })),
    })
  const xiaohongshuKeywords: DirectorPlatformKeyword[] =
    config.interaction?.xiaohongshuKeywords ?? DEFAULT_XIAOHONGSHU_KEYWORDS
  const patchKeywords = (next: DirectorPlatformKeyword[]) =>
    edit(c => {
      const base = c.interaction ?? defaultInteraction()
      c.interaction = { ...base, xiaohongshuKeywords: next }
    })
  const patchKeyword = (index: number, patch: Partial<DirectorPlatformKeyword>) =>
    patchKeywords(
      xiaohongshuKeywords.map((keyword, at) => (at === index ? { ...keyword, ...patch } : keyword)),
    )
  const removeKeyword = (index: number) =>
    patchKeywords(xiaohongshuKeywords.filter((_, at) => at !== index))
  /** 当场就能看出正则写错没有，不用等保存被拦。 */
  const brokenKeywords = xiaohongshuKeywords
    .map(keyword => {
      try {
        new RegExp(keyword.pattern)
        return ''
      } catch {
        return keyword.name.trim() || '未命名'
      }
    })
    .filter(Boolean)
  const productEdit = (patch: Partial<DirectorProduct>) =>
    edit(c => Object.assign(c.trays[trayIndex].products[productIndex], patch))
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    const result = await call({ action: 'save', config })
    // 保存后立刻取回服务端的权威版本当新基准 —— 界面不用手动刷新，
    // "未保存"提示自然消失，改动列表清空。
    const fresh = await call({ action: 'state' })
    if (fresh.config) {
      setConfig(fresh.config)
      setBaseline(fresh.config)
      serverConfigRef.current = JSON.stringify(fresh.config)
    } else setBaseline(structuredClone(config))
    setState(fresh.state)
    setShowChanges(false)
    setConflict(false)
    const warnings: string[] = result.warnings || []
    setMessage(
      warnings.length
        ? `已保存，但有 ${warnings.length} 处倒回（画面会往回跳）：\n${warnings.join('\n')}`
        : '已保存',
    )
  }
  /** 一键回到上次保存的版本：不提示"未保存"了，因为确实没改动了。 */
  const rollback = () => {
    if (!baseline) return
    setConfig(structuredClone(baseline))
    setShowChanges(false)
    setMessage('已回滚到上次保存的版本，未保存的改动都丢掉了')
  }
  const reload = async () => {
    if (dirty && !window.confirm('界面里还有未保存的改动，重新载入会丢弃它们。确定继续吗？')) return
    const result = await call({ action: 'state' })
    if (result.config) {
      setConfig(result.config)
      setBaseline(result.config)
      serverConfigRef.current = JSON.stringify(result.config)
    }
    setState(result.state)
    setConflict(false)
    setShowChanges(false)
    setMessage('已重新从磁盘载入配置')
  }
  const rehearse = () =>
    perform(async () => {
      const target = product ?? tray?.products[0]
      const result = await call({
        action: 'rehearse',
        trayId: tray?.id || '',
        productId: target?.id || '',
        mode,
        seconds: rehearseSeconds,
      })
      setRehearsal(result.rehearsal ?? null)
      setMessage(result.message || '转场试跑已开始')
    })
  const stopRehearse = () =>
    perform(async () => {
      await call({ action: 'rehearse-stop' })
      setRehearsal(null)
      setMessage('转场试跑已停止')
    })
  const discoverObs = async () => {
    const result = await call({ action: 'discover-obs' })
    setObsScenes(result.scenes || [])
    const scene = result.scenes?.find(item => item.name === config.scene)
    const count =
      scene?.sources.filter(source => source.isGroup && source.containerName === config.scene)
        .length || 0
    setMessage(
      scene
        ? `已从“${config.scene}”读取 ${count} 个顶层素材组`
        : `OBS 中没有找到导播场景“${config.scene}”`,
    )
  }
  const start = (preview: boolean) =>
    perform(async () => {
      await save()
      const r = await call({ action: 'start', trayId: tray?.id || '', accountId, preview })
      setState(r.state)
      setMessage(r.message || '')
      setTab('live')
    })
  const addTray = () => {
    edit(c =>
      c.trays.push({
        id: crypto.randomUUID(),
        name: `托盘 ${c.trays.length + 1}`,
        A: [],
        transitionIn: '',
        transitionOut: '',
        products: [],
      }),
    )
    setTrayIndex(config.trays.length)
    setProductIndex(0)
    setStepIndex(0)
    setAStepIndex(0)
  }
  const addProduct = () =>
    edit(c => {
      const used = new Set(c.trays[trayIndex].products.map(p => p.id))
      let n = 1
      while (used.has(String(n).padStart(3, '0'))) n++
      c.trays[trayIndex].products.push({
        id: String(n).padStart(3, '0'),
        name: '新商品',
        aliases: [],
        goodsId: null,
        stateGroups: { B: '', C: '' },
        facts: '',
        notes: {},
        B: [],
        C: [],
      })
      setProductIndex(c.trays[trayIndex].products.length - 1)
      setStepIndex(0)
    })
  if (tab === 'experiment') {
    return (
      <div className="p-6 space-y-5 max-w-7xl mx-auto">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">互动导播</h1>
            <p className="text-sm text-muted-foreground mt-1">本机互动实验 · 独立排练</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => setTab('edit')}>
              素材与编排
            </button>
            <button type="button" className={buttonClass} onClick={() => setTab('live')}>
              导播台
            </button>
            <button type="button" className={`${buttonClass} bg-muted`} aria-pressed="true">
              互动实验
            </button>
          </div>
        </div>
        <InteractiveExperiment onOpenDirector={() => setTab('live')} />
      </div>
    )
  }
  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <datalist id={obsGroupListId}>
        {obsGroups.map(name => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">互动导播</h1>
          <p className="text-sm text-muted-foreground mt-1">托盘总览 A · 商品详情 B · 试戴 C</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={() => setTab('edit')}>
            素材与编排
          </button>
          <button type="button" className={buttonClass} onClick={() => setTab('live')}>
            导播台
          </button>
          <button type="button" className={buttonClass} onClick={() => setTab('experiment')}>
            互动实验
          </button>
          <button
            className={buttonClass}
            type="button"
            disabled={busy}
            onClick={() => void perform(reload)}
            title="强制重新从磁盘读取配置；平时不用点，别处改过会自动跟进"
          >
            强制重新载入
          </button>
          <button
            type="button"
            className={
              dirty
                ? 'rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-40'
                : buttonClass
            }
            disabled={busy || state?.running}
            onClick={() => void perform(save)}
          >
            保存{dirty ? `（${changes.length} 处改动）` : ''}
          </button>
        </div>
      </div>

      {/* 未保存就一直挂着这条 —— 不切页面、不点刷新也能看见 */}
      <div
        className={`sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded border p-3 text-sm ${
          dirty
            ? 'border-amber-500 bg-amber-500/10'
            : 'border-transparent bg-muted/30 text-muted-foreground'
        }`}
        role="status"
      >
        {dirty ? (
          <>
            <span className="font-medium text-amber-700">● {summarizeChanges(changes)}</span>
            <button
              type="button"
              className="rounded-md bg-amber-600 px-3 py-1.5 text-white hover:bg-amber-700 disabled:opacity-40"
              disabled={busy || state?.running}
              onClick={() => void perform(save)}
            >
              保存
            </button>
            <button type="button" className={buttonClass} onClick={() => setShowChanges(v => !v)}>
              {showChanges ? '收起改动' : '改了哪些'}
            </button>
            <button type="button" className={buttonClass} onClick={rollback}>
              回滚到上次保存
            </button>
            {state?.running && (
              <span className="text-muted-foreground">导播运行中不能保存，先停一下</span>
            )}
          </>
        ) : (
          <span>已保存 · 和磁盘上的版本一致（别处改过会自动跟进，不用点重新载入）</span>
        )}
        {conflict && (
          <span className="text-red-600">
            ⚠ 别处刚改过配置，你现在保存会把它盖掉 —— 想留住就点「回滚到上次保存」先看看
          </span>
        )}
      </div>

      {dirty && showChanges && <ChangeList changes={changes} onRollback={rollback} />}
      <div
        className={`whitespace-pre-line rounded border p-3 text-sm ${state?.phase === 'error' ? 'border-red-500 bg-red-500/10 text-red-600' : 'bg-muted/30'}`}
        role="status"
      >
        {(state?.running || state?.phase === 'error') && state.message ? state.message : message}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="rounded border p-2 bg-background"
          disabled={state?.running}
          value={trayIndex}
          onChange={e => {
            setTrayIndex(Number(e.target.value))
            setProductIndex(0)
            setStepIndex(0)
            setAStepIndex(0)
          }}
        >
          {config.trays.map((t, i) => (
            <option key={t.id} value={i}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="button" className={buttonClass} disabled={state?.running} onClick={addTray}>
          ＋托盘组
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy || state?.running}
          onClick={() => void perform(discoverObs)}
        >
          读取 OBS 素材组
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!tray || busy || state?.running}
          onClick={() => void start(true)}
        >
          模拟流程
        </button>
        <button
          type="button"
          className="rounded bg-primary text-primary-foreground px-3 py-2 text-sm disabled:opacity-40"
          disabled={!tray || busy || state?.running}
          onClick={() => void start(false)}
        >
          准备并启动 OBS 导播
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!state?.running}
          onClick={() =>
            void perform(async () => {
              const r = await call({ action: 'stop' })
              setState(r.state)
              setMessage('已停止')
            })
          }
        >
          停止
        </button>
      </div>
      {tab === 'edit' && (
        <fieldset disabled={state?.running || busy} className="space-y-5 disabled:opacity-60">
          <TargetMode config={config} accountId={accountId} apply={setConfig} />
          <details className="border rounded p-4">
            <summary className="cursor-pointer">全局设置与 OBS 输出</summary>
            <label className="mt-4 block space-y-1 text-sm">
              <span className="text-muted-foreground">
                AI 总纲 · 全局唯一一份（真人直播也读它）· 最多 20000 字
              </span>
              <textarea
                className={`${inputClass} min-h-40`}
                value={config.aiPolicy}
                onChange={e =>
                  edit(c => {
                    c.aiPolicy = e.target.value
                  })
                }
              />
            </label>
            <div className="grid md:grid-cols-2 gap-4 mt-4">
              <GroupHeading
                title="OBS 与画面"
                hint="连哪个 OBS、画面多大、片段之间怎么接。一般不用动。"
              />
              <Field label="独立 OBS 场景（自动创建并在启动后切换到该场景）">
                <input
                  className={inputClass}
                  value={config.scene}
                  onChange={e =>
                    edit(c => {
                      c.scene = e.target.value
                    })
                  }
                />
              </Field>
              <TransitionSettings
                value={config.transition}
                onChange={transition =>
                  edit(c => {
                    c.transition = transition
                  })
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="OBS 画布宽度"
                  value={config.canvasWidth}
                  onChange={v =>
                    edit(c => {
                      c.canvasWidth = v
                    })
                  }
                />
                <NumberField
                  label="OBS 画布高度"
                  value={config.canvasHeight}
                  onChange={v =>
                    edit(c => {
                      c.canvasHeight = v
                    })
                  }
                />
                <NumberField
                  label="片段淡化毫秒"
                  value={config.transitionMs}
                  onChange={v =>
                    edit(c => {
                      c.transitionMs = v
                    })
                  }
                />
              </div>
              <GroupHeading
                title="AI 与观众互动"
                hint="观众说什么话算要展示/要试戴/要取消，以及回复要不要艾特他。改词表保存即生效。"
              />
              <Field label="上头（试戴）识别词 · 逗号分隔 · 观众说这些词就按 C 试戴走">
                <input
                  className={inputClass}
                  value={showModeWords(
                    config.interaction?.modeKeywords?.C,
                    DEFAULT_MODE_KEYWORDS.C,
                  )}
                  onChange={e =>
                    edit(c => {
                      const base = c.interaction ?? defaultInteraction()
                      c.interaction = {
                        ...base,
                        modeKeywords: { ...base.modeKeywords, C: parseModeWords(e.target.value) },
                      }
                    })
                  }
                />
              </Field>
              <Field label="展示（讲解）识别词 · 逗号分隔 · 观众说这些词就按 B 展示走">
                <input
                  className={inputClass}
                  value={showModeWords(
                    config.interaction?.modeKeywords?.B,
                    DEFAULT_MODE_KEYWORDS.B,
                  )}
                  onChange={e =>
                    edit(c => {
                      const base = c.interaction ?? defaultInteraction()
                      c.interaction = {
                        ...base,
                        modeKeywords: { ...base.modeKeywords, B: parseModeWords(e.target.value) },
                      }
                    })
                  }
                />
              </Field>
              <Field label="打招呼回复 · 观众说「你好」时回这句 · 留空用默认">
                <input
                  className={inputClass}
                  value={config.interaction?.greetingReply ?? DEFAULT_GREETING_REPLY}
                  onChange={e =>
                    edit(c => {
                      const base = c.interaction ?? defaultInteraction()
                      c.interaction = { ...base, greetingReply: e.target.value }
                    })
                  }
                />
              </Field>
              <fieldset className="space-y-3 rounded-md border p-3 text-sm md:col-span-2">
                <legend>观众记分表（刷屏到什么程度就不再回他）</legend>
                <p className="text-xs text-muted-foreground">
                  某些行为扣分，累计到阈值就不再回他。<b>每场直播都从 0 分重新开始</b>，
                  不会因为昨天刷过屏今天就一开播就静音。 静音只拦「要不要回他」——
                  他照样能撤回自己排的队、照常报编号点播。 关掉就永远不静音。
                </p>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={viewerScoreConfig.enabled}
                    onChange={e => patchViewerScore({ enabled: e.target.checked })}
                  />
                  启用记分
                </label>
                <div className="flex flex-wrap gap-4">
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">一分钟内超过几句算刷屏</span>
                    <input
                      className={inputClass}
                      type="number"
                      min={1}
                      max={200}
                      value={viewerScoreConfig.floodPerMinute}
                      onChange={e => patchViewerScore({ floodPerMinute: Number(e.target.value) })}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">累计到多少分就不再回他</span>
                    <input
                      className={inputClass}
                      type="number"
                      min={1}
                      max={999}
                      value={viewerScoreConfig.muteAt}
                      onChange={e => patchViewerScore({ muteAt: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <div className="space-y-1">
                  {VIEWER_SCORE_ORDER.map(when => (
                    <label key={when} className="flex flex-wrap items-center gap-2">
                      <span className="w-44">{VIEWER_SCORE_LABELS[when]}</span>
                      <span className="text-muted-foreground">每次扣</span>
                      <input
                        className="w-20 rounded-md border bg-background p-2 text-sm"
                        type="number"
                        min={0}
                        max={99}
                        value={viewerScoreConfig.rules.find(rule => rule.when === when)?.delta ?? 0}
                        onChange={e => patchViewerRule(when, Number(e.target.value))}
                      />
                      <span className="text-muted-foreground">分</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  照现在这张表：一个人闷头复读同样的字，到第 {(() => {
                    const delta =
                      viewerScoreConfig.rules.find(rule => rule.when === 'duplicate')?.delta ?? 0
                    return delta > 0
                      ? `${Math.max(1, Math.ceil(viewerScoreConfig.muteAt / delta))} 次`
                      : '（不会因为复读被静音）'
                  })()}
                  就不再回他。刷屏是按「超出的句数」扣分，一分钟喊 20 句会直接到线。
                </p>
              </fieldset>
              <InteractionScripts config={config} patch={patchInteractionScript} />
              <fieldset className="space-y-3 rounded-md border p-3 text-sm md:col-span-2">
                <legend>小红书关键词（平台固定说法，用正则认）</legend>
                <p className="text-xs text-muted-foreground">
                  观众在千帆商品列表上点一下，平台就会发出固定格式的评论。 这张表只负责<b>认出来</b>
                  、并把里面的数字取出来交给 AI； 至于拿到之后怎么问、怎么播，写在总纲的规则里
                  （「求讲解 N 号商品」对应规则一/二/三）。
                  <b>正则里的第一个括号就是那个 N</b>。
                </p>
                {xiaohongshuKeywords.map((keyword, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Legacy editable keywords lack IDs; field-based keys would remount inputs on each keystroke.
                  <div key={index} className="grid gap-2 md:grid-cols-[10rem_1fr_auto] items-end">
                    <Field label="名字">
                      <input
                        className={inputClass}
                        value={keyword.name}
                        onChange={e => patchKeyword(index, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="正则（第一个括号 = N）">
                      <input
                        className={`${inputClass} font-mono`}
                        value={keyword.pattern}
                        onChange={e => patchKeyword(index, { pattern: e.target.value })}
                      />
                    </Field>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => removeKeyword(index)}
                      title="删掉这条"
                    >
                      删除
                    </button>
                  </div>
                ))}
                {brokenKeywords.length > 0 && (
                  <p className="rounded border border-red-500 bg-red-500/10 p-2 text-xs text-red-600">
                    ⚠ 这几条正则写错了，保存会被拦下：
                    {brokenKeywords.map(name => ` ${name}`).join('、')}
                  </p>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  disabled={xiaohongshuKeywords.length >= 20}
                  onClick={() => patchKeywords([...xiaohongshuKeywords, { name: '', pattern: '' }])}
                >
                  ＋加一条
                </button>
              </fieldset>
              <Field label="取消点播识别词 · 逗号分隔 · 观众点完说这些就把他的点播撤掉">
                <input
                  className={inputClass}
                  value={showModeWords(config.interaction?.cancelKeywords, DEFAULT_CANCEL_KEYWORDS)}
                  onChange={e =>
                    edit(c => {
                      const base = c.interaction ?? defaultInteraction()
                      c.interaction = { ...base, cancelKeywords: parseModeWords(e.target.value) }
                    })
                  }
                />
              </Field>
              <Field label="回复开头艾特观众 · {name}=昵称 · {initial}=首字 · 清空则不艾特">
                <input
                  className={inputClass}
                  value={config.interaction?.mentionTemplate ?? DEFAULT_MENTION_TEMPLATE}
                  onChange={e =>
                    edit(c => {
                      const base = c.interaction ?? defaultInteraction()
                      c.interaction = { ...base, mentionTemplate: e.target.value }
                    })
                  }
                />
              </Field>
              <fieldset className="space-y-2 rounded-md border p-3 text-sm">
                <legend>转场试跑</legend>
                <p className="text-muted-foreground text-xs">
                  只编 3 条片段（都去掉旁白）：{tray?.name || '当前托盘'} 最后一个 A 步骤的末尾、
                  {product?.id || tray?.products[0]?.id || '第一个商品'}·{mode} 第一步的开头、
                  以及该商品最后一步的末尾。循环顺序：
                  <br />A 末尾 →[进商品转场]→ 商品第一步开头 ⋯⋯（中间步骤省略）⋯⋯ 商品最后一步末尾
                  →[回总览转场]→ A 末尾
                  <br />
                  这样两个方向的转场都按真实位置呈现。不写配置、不弹商品窗、不推流。
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block space-y-1">
                    <span>每边播几秒</span>
                    <input
                      className={inputClass}
                      type="number"
                      min={1}
                      max={20}
                      value={rehearseSeconds}
                      onChange={event => setRehearseSeconds(Number(event.target.value))}
                    />
                  </label>
                  <button
                    className={buttonClass}
                    type="button"
                    disabled={busy || state?.running || rehearsal?.running}
                    onClick={() => void rehearse()}
                  >
                    开始试跑
                  </button>
                  <button
                    className={buttonClass}
                    type="button"
                    disabled={busy || !rehearsal?.running}
                    onClick={() => void stopRehearse()}
                  >
                    停止试跑
                  </button>
                </div>
                {rehearsal && (
                  <div className="space-y-1 rounded border bg-muted/30 p-2 text-xs">
                    <p className="font-medium">{rehearsal.running ? '试跑进行中' : '试跑已结束'}</p>
                    {rehearsal.logs.slice(-6).map(line => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                )}
              </fieldset>
              <GroupHeading
                title="时长与队列"
                hint="总览停多久、点播怎么排队。这些直接决定观众等多久。"
              />
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="普通总览秒数"
                  value={config.normalSeconds}
                  onChange={v =>
                    edit(c => {
                      c.normalSeconds = v
                    })
                  }
                />
                <NumberField
                  label="点播间总览秒数"
                  value={config.requestSeconds}
                  onChange={v =>
                    edit(c => {
                      c.requestSeconds = v
                    })
                  }
                />
              </div>
              <NumberField
                label="点播队列上限"
                value={config.maxQueue}
                onChange={v =>
                  edit(c => {
                    c.maxQueue = v
                  })
                }
              />
              <NumberField
                label="同一观众点播冷却秒数"
                value={config.cooldownSeconds}
                onChange={v =>
                  edit(c => {
                    c.cooldownSeconds = v
                  })
                }
              />
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.interruptAOnRequest}
                  onChange={e =>
                    edit(c => {
                      c.interruptAOnRequest = e.target.checked
                    })
                  }
                />
                允许点播在当前 A 步骤播完后抢占（默认开启）
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.queueSkipsOverview ?? true}
                  onChange={e =>
                    edit(c => {
                      c.queueSkipsOverview = e.target.checked
                    })
                  }
                />
                <span>
                  队列里还有点播时，直接接下一个，不回总览（默认开启）
                  <span className="block text-xs text-muted-foreground">
                    只跟「队列里有没有东西」有关，**B/C 任意组合都算**： B→B、B→C、C→B、C→C
                    都不插总览。队列空了才回 A。
                  </span>
                </span>
              </label>
              <label className="flex gap-2 text-sm md:col-span-2">
                <input
                  type="checkbox"
                  checked={config.popup}
                  onChange={e =>
                    edit(c => {
                      c.popup = e.target.checked
                    })
                  }
                />
                <span>
                  <b>商品弹窗总开关</b>（B/C 跟随商品卡，接管原来的定时弹窗）
                  <span className="block text-xs text-muted-foreground">
                    商品链接时间点、商品卡片编号全是靠这个开关触发的 ——
                    <b>关着的话，下面配得再对也不会弹</b>。
                    另外「模拟流程」按设计不弹商品卡，必须用「准备并启动 OBS 导播」，
                    而且要先把中控台连上。
                  </span>
                </span>
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config.listen}
                  onChange={e =>
                    edit(c => {
                      c.listen = e.target.checked
                    })
                  }
                />
                接收当前账号的新评论点播
              </label>
              <GroupHeading title="工具与路径" hint="剪辑/探针程序位置。装好之后一般不用再改。" />
              <FileField
                label="FFmpeg"
                value={config.ffmpeg}
                kind="executable"
                onChange={v =>
                  edit(c => {
                    c.ffmpeg = v
                  })
                }
              />
              <FileField
                label="FFprobe"
                value={config.ffprobe}
                kind="executable"
                onChange={v =>
                  edit(c => {
                    c.ffprobe = v
                  })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              OBS 连接复用“OBS 设置”。请先在 OBS
              预览新场景、检查声卡监听与标签位置。自动生成配音、图片与商品资料 API
              尚未接入；当前支持导入已生成素材。AI 总纲就在这里（全局唯一一份，真人直播也读它）；
              DeepSeek 的开关、场景和密钥仍在“自动回复”里设置。
            </p>
          </details>
          {tray && (
            <>
              <section className="border rounded p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold">A · 托盘总览</h2>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      if (confirm('删除这个托盘及其配置？原始素材不会删除。')) {
                        edit(c => {
                          c.trays.splice(trayIndex, 1)
                        })
                        setTrayIndex(0)
                        setProductIndex(0)
                        setAStepIndex(0)
                      }
                    }}
                  >
                    删除托盘配置
                  </button>
                </div>
                <Field label="托盘名称">
                  <input
                    className={inputClass}
                    value={tray.name}
                    onChange={e =>
                      edit(c => {
                        c.trays[trayIndex].name = e.target.value
                      })
                    }
                  />
                </Field>
                <Field label="托盘简介（识别托盘用；一行一条，物流/售后等托盘级信息会被自动回复逐行引用；可留空）">
                  <textarea
                    className={inputClass}
                    value={tray.summary || ''}
                    onChange={e =>
                      edit(c => {
                        c.trays[trayIndex].summary = e.target.value
                      })
                    }
                    placeholder={
                      '一行一条，例如：\n默认发中通，48 小时内发货\n偏远地区不包邮\n支持七天无理由退换'
                    }
                  />
                </Field>
                <fieldset className="space-y-3 rounded-md border p-3 text-sm">
                  <legend>B/C 引导评论浮层（催观众说话）</legend>
                  <p className="text-xs text-muted-foreground">
                    A 段有总览引导语，B/C 段观众只顾看、没人说话 —— 而 B/C 最该催评论。
                    这里生成的是一张<b>本地网页</b>（字是活的：一直转 + 呼吸 + 手指上下跳）， 在 OBS
                    里加一个「浏览器源」指向下面这个文件，把那个源放进同名的一个素材组， 导播进 B/C
                    时就会自动把它亮起来、回 A 摘掉。
                  </p>
                  <Field label="引导文字（最多 24 字；留空用默认）">
                    <input
                      className={inputClass}
                      value={tray.cta?.text ?? ''}
                      placeholder={DEFAULT_CTA_TEXT}
                      onChange={e =>
                        edit(c => {
                          c.trays[trayIndex].cta = {
                            ...c.trays[trayIndex].cta,
                            text: e.target.value,
                          }
                        })
                      }
                    />
                  </Field>
                  <Field label="副标题（最多 30 字；留空只有一行）">
                    <input
                      className={inputClass}
                      value={tray.cta?.subtext ?? ''}
                      placeholder={DEFAULT_CTA_SUBTEXT}
                      onChange={e =>
                        edit(c => {
                          c.trays[trayIndex].cta = {
                            ...c.trays[trayIndex].cta,
                            subtext: e.target.value,
                          }
                        })
                      }
                    />
                  </Field>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(tray.cta?.enabled)}
                        onChange={e =>
                          edit(c => {
                            c.trays[trayIndex].cta = {
                              ...c.trays[trayIndex].cta,
                              enabled: e.target.checked,
                            }
                          })
                        }
                      />
                      在 B/C 段显示引导
                    </label>
                    <NumberField
                      label="字号（像素）"
                      value={tray.cta?.fontSize ?? 64}
                      onChange={v =>
                        edit(c => {
                          c.trays[trayIndex].cta = { ...c.trays[trayIndex].cta, fontSize: v }
                        })
                      }
                    />
                  </div>
                  <Field label="生成的本地网页（排查用；OBS 的源由应用自动创建，不用手填）">
                    <input
                      className={`${inputClass} font-mono`}
                      readOnly
                      value={ctaFiles[tray.id] || '（保存配置后生成）'}
                      onFocus={e => e.target.select()}
                    />
                  </Field>
                  {tray.cta?.enabled && (
                    <p className="text-xs text-emerald-600">
                      ✓ 已启用。保存后在 OBS 的「来源」里找
                      <span className="font-mono"> OBA-Director:{config.scene}:cta </span>
                      （应用自己建的），启动导播进 B/C 就会显示。
                    </p>
                  )}
                </fieldset>
                <Field label="A 状态常驻 OBS 组（可留空）">
                  <input
                    className={inputClass}
                    list={obsGroupListId}
                    value={tray.stateGroup || ''}
                    onChange={e =>
                      edit(c => {
                        c.trays[trayIndex].stateGroup = e.target.value
                      })
                    }
                    placeholder="例如：A-SKU素材组"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    A 全程显示，离开 A 自动隐藏。请把它建成“OBA 互动导播”场景中的顶层组；
                    组内文字、图片和位置只在 OBS 中编辑。
                  </p>
                </Field>
                <div className="space-y-3 rounded border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {aSteps.map((item, index) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`${buttonClass} ${index === aStepIndex ? 'bg-primary/10' : ''}`}
                        onClick={() => setAStepIndex(index)}
                      >
                        {index + 1}. {item.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => {
                        const current = aSteps[aStepIndex]
                        const next = newDirectorContinuationStep(current, aSteps.length + 1)
                        const insertAt = current ? aStepIndex + 1 : aSteps.length
                        edit(c => {
                          const steps = [...(c.trays[trayIndex].A || [])]
                          steps.splice(insertAt, 0, next)
                          c.trays[trayIndex].A = steps
                        })
                        setAStepIndex(insertAt)
                      }}
                    >
                      {aSteps.length ? '＋下一步骤' : '＋第一个 A 步骤'}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A、B、C 使用同一种步骤配置；A 播放期间会持续显示上方指定的常驻组。
                  </p>
                  {aStep && isDirectorVideoStep(aStep) && aStep.end > aStep.start && (
                    <p className="text-xs text-muted-foreground">
                      新建下一步骤时会自动复用当前原视频，并从 {aStep.end.toFixed(2)} 秒继续。
                    </p>
                  )}
                  {aStep && (
                    <div className="border-t pt-4 space-y-3">
                      <StepEditor
                        key={aStep.id}
                        step={aStep}
                        popupEnabled={config.popup}
                        clashes={crowdedPopups(popupMoments(aSteps, null, '总览'))}
                        update={patch =>
                          edit(c => {
                            const target = c.trays[trayIndex].A?.[aStepIndex]
                            if (target) Object.assign(target, patch)
                          })
                        }
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={aStepIndex === 0}
                          onClick={() => {
                            edit(c => {
                              const list = [...(c.trays[trayIndex].A || [])]
                              ;[list[aStepIndex - 1], list[aStepIndex]] = [
                                list[aStepIndex],
                                list[aStepIndex - 1],
                              ]
                              c.trays[trayIndex].A = list
                            })
                            setAStepIndex(aStepIndex - 1)
                          }}
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={aStepIndex === aSteps.length - 1}
                          onClick={() => {
                            edit(c => {
                              const list = [...(c.trays[trayIndex].A || [])]
                              ;[list[aStepIndex + 1], list[aStepIndex]] = [
                                list[aStepIndex],
                                list[aStepIndex + 1],
                              ]
                              c.trays[trayIndex].A = list
                            })
                            setAStepIndex(aStepIndex + 1)
                          }}
                        >
                          下移
                        </button>
                        <button
                          type="button"
                          className={buttonClass}
                          onClick={() => {
                            edit(c => {
                              c.trays[trayIndex].A = (c.trays[trayIndex].A || []).filter(
                                (_, index) => index !== aStepIndex,
                              )
                            })
                            setAStepIndex(0)
                          }}
                        >
                          删除步骤
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <details>
                  <summary className="cursor-pointer text-sm">试戴与托盘切换转场</summary>
                  <div className="space-y-3 mt-3">
                    <FileField
                      label="进入试戴／切换托盘的转场"
                      value={tray.transitionIn}
                      kind="video"
                      onChange={v =>
                        edit(c => {
                          c.trays[trayIndex].transitionIn = v
                        })
                      }
                    />
                    <FileField
                      label="试戴返回总览的转场"
                      value={tray.transitionOut}
                      kind="video"
                      onChange={v =>
                        edit(c => {
                          c.trays[trayIndex].transitionOut = v
                        })
                      }
                    />
                  </div>
                </details>
              </section>
              <div className="grid md:grid-cols-[220px_1fr] gap-4">
                <aside className="border rounded p-3 space-y-2">
                  <h2 className="font-semibold">商品目录</h2>
                  {tray.products.map((p, i) => (
                    <button
                      type="button"
                      key={p.id}
                      className={`block w-full text-left rounded p-2 text-sm ${productIndex === i ? 'bg-primary/10' : 'hover:bg-muted'}`}
                      onClick={() => {
                        setProductIndex(i)
                        setStepIndex(0)
                      }}
                    >
                      {p.id}｜{p.name}
                      <span className="block text-xs text-muted-foreground">
                        展示 {p.B.length} 步 · 试戴 {p.C.length} 步
                      </span>
                    </button>
                  ))}
                  <button type="button" className={buttonClass} onClick={addProduct}>
                    ＋商品
                  </button>
                </aside>
                {product && (
                  <section className="border rounded p-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="全场唯一编号">
                        <input
                          className={inputClass}
                          value={product.id}
                          onChange={e => productEdit({ id: e.target.value })}
                        />
                      </Field>
                      <Field label="商品名称">
                        <input
                          className={inputClass}
                          value={product.name}
                          onChange={e => productEdit({ name: e.target.value })}
                        />
                      </Field>
                      <Field label="常用叫法（逗号分隔）">
                        <input
                          className={inputClass}
                          value={product.aliases.join(',')}
                          onChange={e =>
                            productEdit({
                              aliases: e.target.value
                                .split(/[,，]/)
                                .map(s => s.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </Field>
                      <Field label="平台商品卡片编号（非颜色规格 SKU）">
                        <input
                          type="number"
                          className={inputClass}
                          value={product.goodsId ?? ''}
                          onChange={e =>
                            productEdit({
                              goodsId: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field label="B 状态常驻 OBS 组（可留空）">
                        <input
                          className={inputClass}
                          list={obsGroupListId}
                          value={product.stateGroups?.B || ''}
                          onChange={e =>
                            productEdit({
                              stateGroups: { ...product.stateGroups, B: e.target.value },
                            })
                          }
                          placeholder="例如：B-讲解提示组"
                        />
                      </Field>
                      <Field label="C 状态常驻 OBS 组（可留空）">
                        <input
                          className={inputClass}
                          list={obsGroupListId}
                          value={product.stateGroups?.C || ''}
                          onChange={e =>
                            productEdit({
                              stateGroups: { ...product.stateGroups, C: e.target.value },
                            })
                          }
                          placeholder="例如：C-试戴提示组"
                        />
                      </Field>
                      <p className="col-span-2 text-xs text-muted-foreground">
                        B/C 常驻组也要直接放在“OBA 互动导播”场景中。它们会覆盖整个状态，
                        请勿与单个步骤里用于随机轮换的“OBS 角标素材组”共用。
                      </p>
                    </div>
                    <Field label="已确认商品资料（每行一条；自动回复只引用这里的资料）">
                      <textarea
                        className={inputClass}
                        value={product.facts}
                        onChange={e => productEdit({ facts: e.target.value })}
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="B 展示的点播说明（只在观众点播 B 时随“已排队”说一句）">
                        <input
                          className={inputClass}
                          value={product.notes?.B || ''}
                          onChange={e =>
                            productEdit({ notes: { ...product.notes, B: e.target.value } })
                          }
                          placeholder="留空则不说"
                        />
                      </Field>
                      <Field label="C 试戴的点播说明（只在观众点播 C 时随“已排队”说一句）">
                        <input
                          className={inputClass}
                          value={product.notes?.C || ''}
                          onChange={e =>
                            productEdit({ notes: { ...product.notes, C: e.target.value } })
                          }
                          placeholder="留空则不说"
                        />
                      </Field>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          setMode('B')
                          setStepIndex(0)
                        }}
                      >
                        B 商品详情
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          setMode('C')
                          setStepIndex(0)
                        }}
                      >
                        C 试戴
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          if (confirm('删除此商品配置？')) {
                            edit(c => {
                              c.trays[trayIndex].products.splice(productIndex, 1)
                            })
                            setProductIndex(0)
                          }
                        }}
                      >
                        删除商品
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {product[mode].map((s, i) => (
                        <button
                          type="button"
                          key={s.id}
                          className={`${buttonClass} ${i === stepIndex ? 'bg-primary/10' : ''}`}
                          onClick={() => setStepIndex(i)}
                        >
                          {i + 1}. {s.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          const current = product[mode][stepIndex]
                          const next = newDirectorContinuationStep(
                            current,
                            product[mode].length + 1,
                          )
                          const insertAt = current ? stepIndex + 1 : product[mode].length
                          const steps = [...product[mode]]
                          steps.splice(insertAt, 0, next)
                          productEdit({ [mode]: steps })
                          setStepIndex(insertAt)
                        }}
                      >
                        {product[mode].length ? '＋下一步骤' : '＋第一个步骤'}
                      </button>
                    </div>
                    {step && isDirectorVideoStep(step) && step.end > step.start && (
                      <p className="text-xs text-muted-foreground">
                        新建下一步骤时会自动复用当前原视频，并从 {step.end.toFixed(2)} 秒继续。
                      </p>
                    )}
                    {step && (
                      <div className="border-t pt-4 space-y-3">
                        <StepEditor
                          key={step.id}
                          step={step}
                          popupEnabled={config.popup}
                          clashes={crowdedPopups(
                            popupMoments(
                              product[mode],
                              product.goodsId,
                              mode === 'C' ? '试戴' : '展示',
                            ),
                          )}
                          update={patch =>
                            edit(c =>
                              Object.assign(
                                c.trays[trayIndex].products[productIndex][mode][stepIndex],
                                patch,
                              ),
                            )
                          }
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={stepIndex === 0}
                            onClick={() => {
                              const list = [...product[mode]]
                              ;[list[stepIndex - 1], list[stepIndex]] = [
                                list[stepIndex],
                                list[stepIndex - 1],
                              ]
                              productEdit({ [mode]: list })
                              setStepIndex(stepIndex - 1)
                            }}
                          >
                            上移
                          </button>
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={stepIndex === product[mode].length - 1}
                            onClick={() => {
                              const list = [...product[mode]]
                              ;[list[stepIndex + 1], list[stepIndex]] = [
                                list[stepIndex],
                                list[stepIndex + 1],
                              ]
                              productEdit({ [mode]: list })
                              setStepIndex(stepIndex + 1)
                            }}
                          >
                            下移
                          </button>
                          <button
                            type="button"
                            className={buttonClass}
                            onClick={() => {
                              productEdit({
                                [mode]: product[mode].filter((_, i) => i !== stepIndex),
                              })
                              setStepIndex(0)
                            }}
                          >
                            删除步骤
                          </button>
                        </div>
                      </div>
                    )}
                  </section>
                )}
              </div>
            </>
          )}
        </fieldset>
      )}
      {tab === 'live' && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="border rounded p-4">
              <p className="text-muted-foreground text-sm">当前状态</p>
              <p className="text-3xl mt-2">{state?.phase || 'idle'}</p>
              <p>
                {state?.preview ? '模拟运行' : 'OBS 输出'} ·{' '}
                {config.trays.find(t => t.id === state?.trayId)?.name}
              </p>
            </div>
            <div className="border rounded p-4">
              <p className="text-muted-foreground text-sm">商品 / 步骤</p>
              <p className="mt-2">{state?.productId || '全部商品'}</p>
              <p>{state?.step || '尚未开始'}</p>
            </div>
            <div className="border rounded p-4">
              <p className="text-muted-foreground text-sm">最近状态</p>
              <p className="mt-2 text-sm">{state?.message}</p>
            </div>
          </div>
          <div className="border rounded p-4 space-y-3">
            <h2 className="font-semibold">手动点播</h2>
            <div className="flex flex-wrap gap-2">
              {config.trays.flatMap(t =>
                t.products.map(p => (
                  <div key={p.id} className="border rounded p-2 space-x-2 text-sm">
                    <span>
                      {p.id} {p.name}
                    </span>
                    {(['B', 'C'] as const).map(m => (
                      <button
                        type="button"
                        key={m}
                        className={buttonClass}
                        disabled={!state?.running || !p[m].length}
                        onClick={() =>
                          void perform(async () => {
                            const r = await call({
                              action: 'enqueue',
                              trayId: t.id,
                              productId: p.id,
                              mode: m,
                            })
                            setMessage(r.message || '')
                          })
                        }
                      >
                        {m === 'B' ? '展示' : '试戴'}
                      </button>
                    ))}
                  </div>
                )),
              )}
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <section className="border rounded p-4 space-y-3">
              <h2 className="font-semibold">点播队列</h2>
              {state?.queue.map(r => (
                <div key={r.id} className="flex justify-between text-sm items-center">
                  <span>
                    {r.productId} · {r.mode === 'C' ? '试戴' : '展示'} · {r.user}
                  </span>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void perform(async () => {
                        await call({ action: 'remove', id: r.id })
                      })
                    }
                  >
                    取消
                  </button>
                </div>
              ))}
              {!state?.queue.length && (
                <p className="text-sm text-muted-foreground">暂无点播，按原顺序轮播。</p>
              )}
            </section>
            <section className="border rounded p-4 space-y-3">
              <h2 className="font-semibold">模拟观众评论</h2>
              <input
                className={inputClass}
                value={user}
                onChange={e => setUser(e.target.value)}
                placeholder="观众标识（不同观众分别记录）"
              />
              <input
                className={inputClass}
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="例如：003 试戴；或者：这个想试戴"
              />
              <button
                type="button"
                className={buttonClass}
                disabled={!state?.running}
                onClick={() =>
                  void perform(async () => {
                    const r = await call({ action: 'comment', user, text })
                    setMessage(r.message || '')
                    setText('')
                  })
                }
              >
                测试识别
              </button>
              <p className="text-xs text-muted-foreground">
                这里只测试导播的编号识别。DeepSeek 模拟评论在“自动回复”页面操作。
              </p>
            </section>
          </div>
          <section className="border rounded p-4">
            <h2 className="font-semibold mb-2">运行记录 / 待确认回复</h2>
            <div className="max-h-64 overflow-auto space-y-1">
              {state?.logs.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate log text is valid; these display-only rows have no state or event IDs.
                <p key={i} className="text-xs break-all">
                  {line}
                </p>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
