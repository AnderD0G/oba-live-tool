import { useEffect, useState } from 'react'
import { defaultConversationLimits } from 'shared/conversationPolicy'
import {
  type DeepSeekAutoCommand,
  type DeepSeekAutoSettings,
  defaultDeepSeekAutoSettings,
  defaultThrottleSettings,
  type HumanLiveCameraStatus,
  type HumanLiveItem,
  type ThrottleSettings,
  type VirtualCableState,
} from 'shared/deepSeekAuto'
import type { LiveInteractionRecord } from 'shared/director'
import type { InteractionRoutingConfig } from 'shared/interactionRouting'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { LIVE_AI_ENDPOINTS, type LiveAIProvider } from 'shared/liveAI'
import { useAccounts } from '@/hooks/useAccounts'
import { useAutoReplyStore } from '@/hooks/useAutoReply'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { HumanLiveSceneEditor } from './HumanLiveSceneEditor'

const inputClass = 'w-full rounded border bg-background px-3 py-2 text-sm'
type State = {
  ok: boolean
  error?: string
  message?: string
  settings?: DeepSeekAutoSettings
  settingsRevision?: string
  hasKey?: boolean
  enabled?: boolean
  routing?: {
    revision: number
    config: InteractionRoutingConfig
    recent: { user: string; voice: boolean; text: boolean; reason: string }[]
  }
  records?: LiveInteractionRecord[]
  humanItems?: HumanLiveItem[]
  companionUrl?: string
  companionUrls?: string[]
  cameraStatus?: HumanLiveCameraStatus
  viewerCount?: number
  voice?: { ready: number; pending: number; logs: string[] }
  voiceService?: { state: string; ready: boolean; busy: boolean; queued: number; error?: string }
  voiceOutput?: { state: string; error: string; scene: string }
  cable?: VirtualCableState
}

export function DeepSeekAutoReply() {
  const accountId = useAccounts(s => s.currentAccountId)
  const platform = useCurrentLiveControl(s => s.platform)
  const [settings, setSettings] = useState<DeepSeekAutoSettings>(defaultDeepSeekAutoSettings)
  const [draftRevision, setDraftRevision] = useState<string>()
  const [loadedAccountId, setLoadedAccountId] = useState('')
  const draftLoaded = loadedAccountId === accountId && Boolean(draftRevision)
  // 节流逐项可配：没存过的项按默认值显示，存过的按存的值显示。
  const throttle: ThrottleSettings = { ...defaultThrottleSettings, ...settings.throttle }
  const [key, setKey] = useState('')
  const [state, setState] = useState<State>({ ok: true })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [testText, setTestText] = useState('')
  const [testRecords, setTestRecords] = useState<LiveInteractionRecord[]>([])
  const [testHumanItems, setTestHumanItems] = useState<HumanLiveItem[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    setDraftRevision(undefined)
    setLoadedAccountId('')
    const refresh = async (applySettings = false) => {
      const next: State = await window.ipcRenderer.invoke(IPC_CHANNELS.deepSeekAuto.request, {
        action: 'state',
        accountId,
      })
      if (!live) return
      setState(next)
      if (applySettings && next.settings) {
        setSettings(next.settings)
        setDraftRevision(next.settingsRevision)
        setLoadedAccountId(accountId)
      }
    }
    void refresh(true)
    const timer = setInterval(() => {
      void refresh()
    }, 1000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [accountId])
  const run = async (command: { action: string; [key: string]: unknown }) => {
    if (command.action === 'save' && !draftLoaded) {
      setMessage('请等待当前账号配置加载完成再保存')
      return false
    }
    setBusy(true)
    setMessage('')
    try {
      const next: State = await window.ipcRenderer.invoke(IPC_CHANNELS.deepSeekAuto.request, {
        ...command,
        ...(command.action === 'save' ? { revision: draftRevision } : {}),
        accountId,
      } as DeepSeekAutoCommand)
      if (!next.ok) throw new Error(next.error || '操作失败')
      if (command.action !== 'simulate') setState(next)
      if (command.action === 'save' && next.settings) {
        setSettings(next.settings)
        setDraftRevision(next.settingsRevision)
        setLoadedAccountId(accountId)
      }
      if (command.action === 'state' && next.settings) {
        setSettings(next.settings)
        setDraftRevision(next.settingsRevision)
        setLoadedAccountId(accountId)
      }
      if (command.action === 'simulate') setTestRecords(next.records || [])
      if (command.action === 'simulate') setTestHumanItems(next.humanItems || [])
      setMessage(next.message || '已完成')
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败')
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="rounded border p-4 space-y-3">
      <h2 className="font-semibold">AI 自动回复与商品点播</h2>
      {draftRevision && state.settingsRevision && draftRevision !== state.settingsRevision && (
        <p className="text-sm text-amber-600">已保存配置被 API 或其他页面更新；旧草稿不能覆盖新版本。
          <button className="ml-2 rounded border px-2 py-1" disabled={busy} onClick={() => void run({ action: 'state' })}>重新载入已保存设置</button>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        当前平台：{platform}
        。使用当前账号的评论监听；商品与托盘资料在互动导播中配置。默认仅观察，不入队、不公开发送。
      </p>
      <label className="block text-sm">
        直播模式
        <select
          className={inputClass}
          value={settings.mode || 'director'}
          disabled={Boolean(state.enabled)}
          onChange={e => setSettings({ ...settings, mode: e.target.value as 'director' | 'human' })}
        >
          <option value="director">商品互动与语音对话（可接录播导播）</option>
          <option value="human">TikTok 真人直播（手机副屏）</option>
        </select>
      </label>
      {settings.mode !== 'human' && state.routing && (
        <div className="rounded border p-3 space-y-2">
          <label className="block text-sm">
            统一接话模式（立即生效）
            <select
              className={inputClass}
              disabled={busy}
              value={state.routing.config.mode}
              onChange={e => {
                const routing = state.routing
                if (!routing) return
                void run({
                  action: 'routing-save',
                  revision: routing.revision,
                  config: { ...routing.config, mode: e.target.value },
                })
              }}
            >
              <option value="focus">专注：评论优先文字，保留讲解</option>
              <option value="selective">半专注：按观众条件选择语音</option>
              <option value="all">全员语音：所有观众可语音回应</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            规则版本 {state.routing.revision}。半专注默认按 TikTok 已知粉丝团 ≥6 或消费等级 ≥30
            筛选；未知等级不冒充零。MCP 可查能力、模拟和修改细则。
          </p>
          <p className="text-xs text-muted-foreground">
            文字/语音总开关是授权范围，下面勾选允许的通道，再由此处统一选择。全员语音仍受冷却与额度限制。
          </p>
          {!settings.publicReply && (
            <p className="text-xs text-amber-600">
              当前公开文字关闭：专注模式下不会公开答复；需要打字时请启用下方文字开关并保存。
            </p>
          )}
          {state.routing.recent.slice(0, 3).map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Recent decisions have no event IDs; these duplicate-capable text rows have no state.
            <p key={i} className="text-xs">
              {r.user}：{r.voice ? '语音' : r.text ? '文字' : '不回应'} · {r.reason}
            </p>
          ))}
        </div>
      )}
      {settings.mode === 'human' && (
        <HumanLiveSceneEditor
          settings={settings}
          disabled={Boolean(state.enabled)}
          change={setSettings}
        />
      )}
      {settings.mode === 'human' && (
        <div className="rounded border p-3 space-y-2 text-sm">
          <p className="font-medium">OBS 双机位来源</p>
          <p className="text-xs text-muted-foreground">
            沿用 OBS 特效设置里的 WebSocket 地址与密码。两个机位须是场景内的直属来源。
          </p>
          {(['sceneName', 'androidSource', 'iphoneSource'] as const).map((field, index) => (
            <label key={field} className="block">
              {['场景名称', '安卓来源', 'iPhone 来源'][index]}
              <input
                className={inputClass}
                disabled={Boolean(state.enabled)}
                value={settings.camera?.[field] || ''}
                onChange={e =>
                  setSettings({
                    ...settings,
                    camera: {
                      ...settings.camera,
                      sceneName: settings.camera?.sceneName || '双机位',
                      androidSource: settings.camera?.androidSource || '安卓',
                      iphoneSource: settings.camera?.iphoneSource || 'iPhone',
                      [field]: e.target.value,
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      )}
      <label className="block text-sm">
        模型供应商
        <select
          className={inputClass}
          disabled={Boolean(state.enabled)}
          value={settings.provider || 'deepseek'}
          onChange={e => {
            const provider = e.target.value as LiveAIProvider
            setSettings({
              ...settings,
              provider,
              baseURL: LIVE_AI_ENDPOINTS[provider],
              model: provider === 'deepseek' ? 'deepseek-flash' : '',
              disableThinking: provider === 'deepseek',
            })
            setKey('')
          }}
        >
          <option value="deepseek">DeepSeek</option>
          <option value="doubao">豆包 / 火山方舟</option>
          <option value="openai">OpenAI</option>
          <option value="custom">自定义兼容接口</option>
        </select>
      </label>
      <label className="block text-sm">
        API 地址
        <input
          className={inputClass}
          disabled={Boolean(state.enabled)}
          value={settings.baseURL ?? LIVE_AI_ENDPOINTS.deepseek}
          onChange={e => setSettings({ ...settings, baseURL: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        模型 API ID（豆包可填模型或推理接入点 ID）
        <input
          className={inputClass}
          list="oba-deepseek-models"
          value={settings.model}
          disabled={Boolean(state.enabled)}
          onChange={e => setSettings({ ...settings, model: e.target.value })}
        />
        <datalist id="oba-deepseek-models">
          <option value="deepseek-flash" />
          <option value="deepseek-v4-pro" />
        </datalist>
      </label>
      <div className="flex gap-4 text-sm">
        <label>
          <input
            type="checkbox"
            disabled={Boolean(state.enabled)}
            checked={settings.jsonMode !== false}
            onChange={e => setSettings({ ...settings, jsonMode: e.target.checked })}
          />{' '}
          启用 JSON 输出参数
        </label>
        <label>
          <input
            type="checkbox"
            disabled={Boolean(state.enabled)}
            checked={settings.disableThinking ?? true}
            onChange={e => setSettings({ ...settings, disableThinking: e.target.checked })}
          />{' '}
          发送关闭思考参数（仅限支持此参数的接口）
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        AI 总纲只有一份，已统一到「互动导播 → 全局设置」里编辑，这里不再单独存—— 真人直播和 AI
        自动回复读的都是它。
      </p>
      <label className="block text-sm">
        API Key（已保存配置：{state.hasKey ? '有密钥' : '无密钥'}；密钥按账号和 API
        地址保存，不会回显）
        <input
          className={inputClass}
          type="password"
          autoComplete="off"
          value={key}
          disabled={Boolean(state.enabled)}
          onChange={e => setKey(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>
          <input
            type="checkbox"
            checked={Boolean(settings.voiceReply)}
            disabled={Boolean(state.enabled)}
            onChange={e => setSettings({ ...settings, voiceReply: e.target.checked })}
          />{' '}
          语音回复（观众文字 → 所选音色）
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.observeOnly}
            disabled={Boolean(state.enabled)}
            onChange={e => setSettings({ ...settings, observeOnly: e.target.checked })}
          />{' '}
          仅观察：不入队、不发送
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.publicReply}
            disabled={Boolean(state.enabled)}
            onChange={e => setSettings({ ...settings, publicReply: e.target.checked })}
          />{' '}
          允许公开发送文字回复
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.askModeBeforeDemo !== false}
            disabled={Boolean(state.enabled)}
            onChange={e => setSettings({ ...settings, askModeBeforeDemo: e.target.checked })}
          />{' '}
          只报编号时先问"展示还是上头"
        </label>
      </div>
      {settings.voiceReply && (
        <div className="rounded border p-3 text-sm space-y-1">
          <p>
            <select
              className={inputClass}
              disabled={Boolean(state.enabled)}
              value={settings.voicePlayback || 'conversation'}
              onChange={e =>
                setSettings({
                  ...settings,
                  voicePlayback: e.target.value as 'conversation' | 'director',
                })
              }
            >
              <option value="conversation">实时语音对话：生成后直接在当前 OBS 场景说出来</option>
              <option value="director">导播气口：在已标注的原片语音窗口接话</option>
            </select>
          </p>
          <p className="text-xs text-muted-foreground">
            独立语音对话无需配置素材气口，与自动导播互斥。第一版接收观众文字，不含麦克风语音识别。
          </p>
          <select
            className={inputClass}
            disabled={Boolean(state.enabled)}
            value={settings.voiceBackend || 'qwen'}
            onChange={e =>
              setSettings({
                ...settings,
                voiceBackend: e.target.value as 'index25' | 'qwen' | 'legacy',
              })
            }
          >
            <option value="index25">IndexTTS 2.5 · 本地参考音色 · 17898</option>
            <option value="qwen">千问 · 小董音色 · 17899</option>
            <option value="legacy">旧语音台 · 17863</option>
          </select>
          <p>
            {settings.voiceBackend === 'index25' ? 'IndexTTS 2.5' : '语音服务'}：
            {state.voiceService?.error ||
              (state.voiceService?.ready
                ? state.voiceService.busy
                  ? '正在生成'
                  : '就绪'
                : state.voiceService?.state === 'starting'
                  ? '正在加载，请等待'
                  : '待连接')}
            ；等待合成 {state.voiceService?.queued || 0} 条
          </p>
          {state.voiceOutput && (
            <p>
              OBS：
              {state.voiceOutput.error ||
                (state.voiceOutput.state === 'playing' ? '正在说话' : '等待回复')}{' '}
              · {state.voiceOutput.scene}
            </p>
          )}
          <button
            type="button"
            className="rounded border px-3 py-2"
            disabled={busy}
            onClick={() => void run({ action: 'voice-check' })}
          >
            {busy ? '检查中…' : '检查所选语音与 OBS（不发声）'}
          </button>
          <p>
            独立对话请使用没有录播人声的场景；需要保留原讲解时，选择导播气口模式并配置允许替换的语音窗口。
          </p>
          {settings.voiceBackend === 'index25' && (
            <p className="text-xs text-muted-foreground">
              Index 默认 15 步合成，流式开启时按分句生成，缓冲够用后边生成边播，动态估时并最多 1.25×
              变速不变调。装不下等待后续完整句窗口，断流或超时转文字；需打开公开回复。音色沿用本地服务当前参考。
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ['voicePerMinute', '每人每分钟语音上限', 0, 10],
                ['modelCallsPerMinute', '每人每分钟模型调用上限', 1, 60],
                ['offTopicTurns', '闲聊几次后收尾', 1, 10],
                ['offTopicCooldownMs', '收尾后冷却分钟', 1, 60],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  className={inputClass}
                  type="number"
                  min={min}
                  max={max}
                  disabled={Boolean(state.enabled)}
                  value={
                    (settings.conversationLimits || defaultConversationLimits)[key] /
                    (key === 'offTopicCooldownMs' ? 60000 : 1)
                  }
                  onChange={e =>
                    setSettings({
                      ...settings,
                      conversationLimits: {
                        ...(settings.conversationLimits || defaultConversationLimits),
                        [key]: Number(e.target.value) * (key === 'offTopicCooldownMs' ? 60000 : 1),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="rounded border p-3 space-y-2">
            <p className="font-medium">人工节流（每一项都可以单独改，填 0 就是这一条不限）</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  ['entryTextGlobalSeconds', '进房文字·全局间隔（秒）'],
                  ['entryTextPerViewerSeconds', '进房文字·同一人间隔（秒）'],
                  ['greetingGlobalSeconds', '语音问候·全局间隔（秒）'],
                  ['greetingPerViewerSeconds', '语音问候·同一人间隔（秒）'],
                  ['fallbackGlobalSeconds', '语音失败改文字·全局间隔（秒）'],
                  ['fallbackPerViewerSeconds', '语音失败改文字·同一人间隔（秒）'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={3600}
                    step={key.endsWith('GlobalSeconds') ? 0.5 : 1}
                    disabled={Boolean(state.enabled)}
                    value={throttle[key]}
                    onChange={e =>
                      setSettings({
                        ...settings,
                        throttle: { ...throttle, [key]: Number(e.target.value) },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={throttle.blockDuplicateComments !== false}
                disabled={Boolean(state.enabled)}
                onChange={e =>
                  setSettings({
                    ...settings,
                    throttle: { ...throttle, blockDuplicateComments: e.target.checked },
                  })
                }
              />{' '}
              拦下同一个人的重复弹幕
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.streamingPlayback !== false && (settings.voiceBackend === 'index25' || state.cable?.enabled !== true)}
                disabled={Boolean(state.enabled) || (settings.voiceBackend !== 'index25' && state.cable?.enabled === true)}
                onChange={e => setSettings({ ...settings, streamingPlayback: e.target.checked })}
              />{' '}
              边生成边播放（默认开）
              {state.cable?.enabled === true && settings.voiceBackend !== 'index25' ? '——虚拟声卡开着时自动关闭' : ''}
            </label>
            <p className="text-xs text-muted-foreground">
              {settings.voiceBackend === 'index25'
                ? 'Index 先攒够可持续播放的缓冲，再进入核准的完整句窗口。生成速度和剩余时长会持续参与判断，后续分句可适度加速；关闭后等待整句生成并测量。'
                : '千问首块音频就绪后推给 OBS；关闭后等待整段合成。需要替换原讲解时，使用已核准的完整句窗口。'}
            </p>
            <p className="text-xs text-muted-foreground">
              {settings.voiceBackend === 'index25'
                ? 'Index 流式通过 OBS 互动语音源播放，虚拟声卡开关用于整句文件播放。'
                : '虚拟声卡用于完整音频文件；导播启用虚拟声卡时，千问采用整句文件播放。'}
            </p>
            <label>
              <input
                type="checkbox"
                checked={state.cable?.enabled === true}
                disabled={Boolean(state.enabled) || !state.cable?.installed || busy}
                onChange={e => void run({ action: 'virtual-cable', enabled: e.target.checked })}
              />{' '}
              走虚拟声卡播报
              {state.cable?.installed ? '' : '（这台机器还没探测到虚拟声卡）'}
            </label>
            <p className="text-xs text-muted-foreground">
              {state.cable?.installed ? (
                <>
                  {state.cable.deviceName || '虚拟声卡'}。语音<b>直接渲染到声卡</b>，绕开 OBS
                  媒体源约 <b>0.88 秒</b>的加载 —— 实测最坏情况（发话后 0.5 秒才轮到）从{' '}
                  <b>21.3 秒</b>压到 <b>2.9 秒</b>出声，而且能切进<b>正在进行</b>的气口。
                  Index 流式仍走 OBS 互动语音源，整句文件可以走虚拟声卡。<b>要先关掉自动回复才能改</b>，改完下次开启时生效。
                </>
              ) : (
                <>
                  装好 VB-Audio Virtual Cable 之后，运行 <code>scripts/setup-obs-cable.ts</code>{' '}
                  探测设备；探到了这里就能打开。
                </>
              )}
            </p>
          </div>
          <p>
            开启后自动准备快速问候：已就绪 {state.voice?.ready || 0} 条，生成中{' '}
            {state.voice?.pending || 0} 条。问候绕过 AI，复杂回复后台生成，过期不补播。
          </p>
          {state.voice?.logs.slice(0, 4).map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate log messages are valid and displayed without local state.
            <p key={`${index}-${line}`} className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={busy || Boolean(state.enabled) || !draftLoaded}
          onClick={() => void run({ action: 'save', settings })}
        >
          保存设置
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={busy || Boolean(state.enabled) || !key.trim() || !draftLoaded}
          onClick={() =>
            void (async () => {
              if (await run({ action: 'save', settings })) {
                if (await run({ action: 'key', key })) setKey('')
              }
            })()
          }
        >
          安全保存密钥
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={busy || Boolean(state.enabled) || !state.hasKey}
          onClick={() =>
            void (async () => {
              if (await run({ action: 'save', settings })) await run({ action: 'key', key: '' })
            })()
          }
        >
          删除密钥
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (state.enabled) {
                await run({ action: 'disable' })
                return
              }
              if (!(await run({ action: 'save', settings }))) return
              if (await run({ action: 'enable' }))
                useAutoReplyStore.getState().setIsRunning(accountId, false)
            })()
          }
        >
          {state.enabled ? '关闭 AI 自动回复' : '开启 AI 自动回复'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        开启前先保存设置并启动评论监听。仅观察和模拟评论仍会调用所选模型，可能产生 API
        费用；模拟评论不会公开发送。
      </p>
      {settings.mode === 'human' && (
        <div className="rounded border p-3 space-y-2">
          <p className="font-medium">OBS 机位切换</p>
          <p className="text-sm">
            {state.cameraStatus?.ok
              ? `当前：${state.cameraStatus.selected === 'android' ? '安卓' : state.cameraStatus.selected === 'iphone' ? 'iPhone' : '未确定（两个来源同时显示或隐藏）'}`
              : state.cameraStatus?.error || '开启真人直播后检查 OBS'}
          </p>
          {state.cameraStatus?.onProgram === false && (
            <p className="text-sm text-amber-600">
              OBS 当前节目场景是「{state.cameraStatus.programScene}」，请先切到「
              {settings.camera?.sceneName || '双机位'}」。
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border px-4 py-2"
              disabled={!state.enabled || busy}
              onClick={() => void run({ action: 'camera-switch', target: 'android' })}
            >
              切到安卓
            </button>
            <button
              type="button"
              className="rounded border px-4 py-2"
              disabled={!state.enabled || busy}
              onClick={() => void run({ action: 'camera-switch', target: 'iphone' })}
            >
              切到 iPhone
            </button>
          </div>
          <p className="font-medium">手机副屏与观众数据</p>
          <p className="text-sm">
            已记录 TikTok 观众：{state.viewerCount || 0}。当前仅保存
            ID、昵称、进场及评论次数、粉丝团和送礼等级、订阅、关注状态与识别语言。
          </p>
          {state.companionUrl ? (
            <div className="text-sm break-all space-y-1">
              <p>手机连接同一 Wi-Fi 后打开以下地址；有多个网卡时选手机能访问的那个：</p>
              {(state.companionUrls?.length ? state.companionUrls : [state.companionUrl]).map(
                url => (
                  <p key={url}>
                    <a className="underline" href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </p>
                ),
              )}
            </div>
          ) : (
            <p className="text-sm">开启真人直播模式后显示副屏地址。</p>
          )}
          <div className="max-h-96 overflow-auto space-y-2">
            {[...(state.humanItems || []), ...testHumanItems]
              .filter(item => item.status === 'pending' || item.status === 'failed')
              .map(item => (
                <div key={item.id} className="rounded border p-3 text-sm space-y-1">
                  <p className="font-medium">
                    {item.kind === 'demo'
                      ? '展示商品'
                      : item.kind === 'review'
                        ? '人工回复'
                        : '自动回复'}{' '}
                    · {item.user}
                  </p>
                  <p>
                    {item.chinese}
                    {item.product ? ` · ${item.product}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    原文：{item.original} · {item.language}
                  </p>
                  {item.reply && <p>建议回复：{item.reply}</p>}
                  {!testHumanItems.includes(item) && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded border px-2 py-1"
                        onClick={() => void run({ action: 'item', id: item.id, operation: 'done' })}
                      >
                        完成
                      </button>
                      <button
                        type="button"
                        className="rounded border px-2 py-1"
                        onClick={() =>
                          void run({ action: 'item', id: item.id, operation: 'ignore' })
                        }
                      >
                        忽略
                      </button>
                    </div>
                  )}
                  {item.kind === 'review' && !testHumanItems.includes(item) && (
                    <div className="flex gap-2">
                      <input
                        className={inputClass}
                        placeholder="中文回复，回车翻译并发送"
                        value={drafts[item.id] || ''}
                        onChange={e => setDrafts({ ...drafts, [item.id]: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter')
                            void run({
                              action: 'reply',
                              id: item.id,
                              chinese: drafts[item.id] || '',
                            })
                        }}
                      />
                      <button
                        type="button"
                        className="rounded border px-2"
                        onClick={() =>
                          void run({ action: 'reply', id: item.id, chinese: drafts[item.id] || '' })
                        }
                      >
                        发送
                      </button>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <div className="flex gap-2">
        <input
          className={inputClass}
          value={testText}
          onChange={e => setTestText(e.target.value)}
          placeholder="模拟评论，如：看看另一托盘的 03"
        />
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm whitespace-nowrap"
          disabled={busy || !state.hasKey || !testText.trim()}
          onClick={() => void run({ action: 'simulate', text: testText, user: '模拟观众' })}
        >
          测试识别
        </button>
      </div>
      <div className="max-h-40 overflow-auto text-xs space-y-1">
        {testRecords.map(record => (
          <p key={`test-${record.id}`}>
            测试：{record.text}
            <br />
            回复：{record.reply || '（没有要说的话）'}
            <span className="text-muted-foreground">
              {' '}
              · {record.result}
              {record.intent ? ` · ${JSON.stringify(record.intent)}` : ''}
            </span>
          </p>
        ))}
        {state.records?.map(record => (
          <p key={record.id}>
            {record.user}：{record.text}
            <br />
            回复：{record.reply || '（没有要说的话）'}
            <span className="text-muted-foreground">
              {' '}
              · {record.result}
              {record.intent ? ` · ${JSON.stringify(record.intent)}` : ''}
            </span>
          </p>
        ))}
      </div>
    </section>
  )
}
