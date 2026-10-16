import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join,dirname } from 'node:path'
import { app, dialog,safeStorage } from 'electron'
import { emitter } from '#/event/eventBus'
import { createLogger } from '#/logger'
import { accountManager } from '#/managers/AccountManager'
import { typedIpcMainHandle } from '#/utils'
import type { AudienceTrace } from '../../../shared/audienceEvents'
import { renderCtaOverlay } from '../../../shared/ctaOverlay'
import {
  type DirectorConfig,
  type DirectorCommand,
  type DirectorResponse,
  defaultDirectorConfig,
  directorStepAudioFiles,
  directorStepRewinds,
  migrateDirectorAudioFlow,
  validateDirectorConfig,
} from '../../../shared/director'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { applyDirectorOps } from '../../../shared/directorOps'
import { getVirtualCablePlayer } from '../services/VirtualCablePlayer'
import { readVirtualCable } from '../services/VirtualCableSettings'
import { SpeechBudgetLedger } from '../../../shared/speechBudget'
import { isConversationVoiceActive, isDeepSeekAutoActive } from '../services/DeepSeekAutoState'
import { DirectorApiHost } from '../services/DirectorApiHost'
import { executeHookCommand } from './hooks'
import { DirectorEngine, PreviewDirectorOutput } from '../services/DirectorEngine'
import { DirectorMedia, DirectorPreviewServer, runMediaCommand } from '../services/DirectorMedia'
import { DirectorObsOutput } from '../services/DirectorObsOutput'
import { DirectorSpeechAnalysis } from '../services/DirectorSpeechAnalysis'
import { DirectorAuthoring } from '../services/DirectorAuthoring'
import { AuthoringCopyClient } from '../services/AuthoringCopyClient'
import { liveCredentialScope,normalizeLiveConnection,LIVE_AI_ENDPOINTS } from '../../../shared/liveAI'
import { defaultDeepSeekAutoSettings } from '../../../shared/deepSeekAuto'
import { DirectorSpeechQueue } from '../services/DirectorSpeechQueue'
import { JsonLedger } from '../services/JsonLedger'
import { LiveMemoryStore } from '../services/LiveMemoryStore'
import { liveViewerIdentity } from '../services/LiveViewerIdentity'
import { getQwenVoiceClient } from '../services/QwenVoiceClient'
import { getIndexVoiceClient } from '../services/IndexVoiceClient'
import { getLiveVoiceConfiguration, selectedAccountVoiceClient } from '../services/LiveVoiceConfiguration'
import { suspendCodexForDirector } from './codexDraft'
import {
  adjustInteractionScore,
  applyInteractionRouting,
  getInteractionAudience,
  getInteractionCapabilities,
  getInteractionRouting,
  getInteractionTimeline,
  observeInteraction,
  recordInteractionEvent,
  simulateInteractionRouting,
} from './interactionRouting'
import { executeObsEffectCommand, getObsEffectService } from './obsEffect'
import { executeAnalysisRoomCommand } from './analysisRoom'
import { getDirectorExperiment } from './directorExperiment'
import { executeAssistantDeskCommand } from './assistantDesk'
import {executeEffectGroupCommand} from './effectGroups'
import { executePlatformSessionCommand } from './platformSession'

let engine: DirectorEngine | undefined
/** 本次运行的 OBS 输出。预瞄要从它读「下一个插入点还有多久、能说几个字」。 */
let directorOutput: DirectorObsOutput | undefined
let liveEpoch = 0
/** 转场试跑的独立通道；和正式导播互斥，且从不写配置。 */
let rehearsal:
  | { controller: AbortController; logs: string[]; running: boolean; task: Promise<void> }
  | undefined
let accountId = ''
/**
 * 互动语音的阶段额度账本。
 *
 * 讲解词本身有余量（很多配音比画面短），所以某次插话超出它那个窗口是可以
 * 容忍的 —— 只要总账不透支。插一句比窗口短的话会把时间退还给后面。
 */
export const directorSpeechLedger = new SpeechBudgetLedger()
export const directorSpeechQueue = new DirectorSpeechQueue(Date.now, directorSpeechLedger)

/**
 * 虚拟声卡采集源的 device_id。
 *
 * 由 `scripts/setup-obs-cable.ts` 探测并落盘到 userData。导播启动时读它。
 *
 * **必须显式 `"enabled": true` 才会用。** 这条路已经端到端验通（连着三次在真 OBS
 * 里录到 −24.0 / −27.2 / −26.8 dB），但开关仍然显式：万一换了机器、换了声卡、
 * 播放服务没起来，虚拟声卡失败会**什么都听不到**，比慢半秒严重得多。
 * 失败不致命 —— `LiveVoiceService` 会退回文件路径，再失败还有 `sendTextFallback` 兜底。
 */
function cableDevice(): string | undefined {
  const config = readVirtualCable(app.getPath('userData'))
  return config?.enabled ? config.deviceId : undefined
}
let liveMemory: LiveMemoryStore | undefined
export function getLiveMemory() {
  liveMemory ??= new LiveMemoryStore(
    join(app.getPath('userData'), 'live-interaction-memory.json'),
    (_account, record) => {
      recordInteractionEvent(record.trace, {
        kind: 'director.request',
        text: record.productName,
        facts: {
          requestId: record.id,
          requestStatus: record.status,
          trayId: record.trayId,
          productId: record.productId,
          mode: record.mode,
        },
      })
    },
  )
  return liveMemory
}
/** B/C 引导页写在这个目录下，一个托盘一张。 */
export function ctaOverlayPath(trayId: string) {
  return join(app.getPath('userData'), 'director-cache', `cta-${trayId}.html`)
}

/**
 * 把每个托盘的 B/C 引导层写成一张本地网页。
 *
 * 为什么写文件、不开 HTTP 服务：OBS 的「浏览器源」可以直接读本地文件，
 * 少一个端口、少一层故障，断网也不影响。改文案保存后重新加载一次源即可。
 *
 * 没配引导（没填 OBS 组名）就把旧文件删掉 —— 否则 OBS 那边还挂着一份过期的。
 */
function writeCtaOverlays(config: DirectorConfig) {
  try {
    const dir = join(app.getPath('userData'), 'director-cache')
    mkdirSync(dir, { recursive: true })
    for (const tray of config.trays) {
      const file = ctaOverlayPath(tray.id)
      if (!tray.cta?.enabled) {
        rmSync(file, { force: true })
        continue
      }
      writeFileSync(
        file,
        renderCtaOverlay({
          text: tray.cta.text ?? '',
          subtext: tray.cta.subtext ?? '',
          fontSize: tray.cta.fontSize,
        }),
        'utf-8',
      )
    }
  } catch (error) {
    // 引导层只是锦上添花，写不出来不能拦住导播
    createLogger('导播引导层').warn(`引导页文件写入失败：${String(error)}`)
  }
}

let savedDirectorConfig: () => DirectorConfig = defaultDirectorConfig
export function directorCatalog() {
  return structuredClone(savedDirectorConfig())
}
export function isDirectorControlling(id: string) {
  return Boolean(engine?.state.running && !engine.state.preview && accountId === id)
}
export function isDirectorOutputActive() {
  return Boolean(engine?.state.running || rehearsal?.running)
}
/**
 * 互动层需要的导播状态。
 *
 * **注意这里没有语音窗口** —— 窗口归 `SpeechWindows` 那个唯一主人管，
 * 播放层直接写、决策层直接读。以前它被塞进这里（以及「观众上下文」），
 * 绕了四跳才回到决策层，直接造成了一串 bug：预瞄只在一条路径上更新、
 * 60Hz 倒计时污染上下文指纹、取窗口被截断成 4 个。
 */
export function directorInteractionContext(id: string) {
  const running = Boolean(engine?.state.running && !engine.state.preview && accountId === id)
  return {
    epoch: liveEpoch,
    activeTrayId: running ? (engine?.state.trayId ?? '') : '',
    running,
  }
}
export function directorAcceptRequest(
  id: string,
  trayId: string,
  productId: string,
  mode: 'B' | 'C',
  user: string,
  trace?: AudienceTrace,
) {
  if (accountId !== id || !engine?.state.running || engine.state.preview)
    return { accepted: false, code: 'stopped', message: '互动导播尚未启动' }
  return engine.acceptRequest(trayId, productId, mode, user, true, trace)
}
/** 观众说"不用了"时撤掉他自己排队的点播。 */
export function directorCancelRequest(
  id: string,
  trayId: string | undefined,
  productId: string | undefined,
  mode: 'B' | 'C' | undefined,
  user: string,
) {
  if (accountId !== id || !engine?.state.running || engine.state.preview)
    return { cancelled: 0, message: '互动导播尚未启动' }
  return engine.cancelRequest(user, trayId, productId, mode)
}
/**
 * 这个观众此刻在导播里的真实处境：他自己排了哪些队、现在正播什么。
 *
 * 以前只给 AI 一轮"最近说过的话"（纯文本），它看不到队列 —— 所以"不用了"这种
 * 依赖上文的话只能靠猜。现在把引擎的真实状态一起给它。
 */
export function directorUserContext(id: string, user: string) {
  if (engine && accountId === id && !engine.state.preview) return engine.userContext(user)
  return {
    phase: 'idle' as const,
    productId: '',
    step: '',
    queue: [],
    yourQueue: [],
    yourActive: null,
    nowPlaying: null,
    capturedAt: Date.now(),
    recentRequests: getLiveMemory()
      .requests(id)
      .forUser(user)
      .filter(r => r.endedAt)
      .slice(-10)
      .reverse(),
  }
}
export function setupDirectorIpcHandlers() {
  const initial = defaultDirectorConfig()
  if (existsSync('D:\\TTS\\bin\\ffmpeg\\bin\\ffmpeg.exe')) {
    initial.ffmpeg = 'D:\\TTS\\bin\\ffmpeg\\bin\\ffmpeg.exe'
    initial.ffprobe = 'D:\\TTS\\bin\\ffmpeg\\bin\\ffprobe.exe'
  }
  const ledger = new JsonLedger(join(app.getPath('userData'), 'director.json'), initial, {
    // 界面持旧副本一保存就整份覆盖，留几版以备回滚
    backups: 5,
  })
  savedDirectorConfig = () => ledger.data
  const snapshot = () => {
    return engine?.snapshot()
  }
  const stop = async () => {
    liveEpoch++
    directorSpeechQueue.clear()
    directorOutput = undefined
    await stopRehearsal()
    await engine?.stop()
  }
  async function stopRehearsal() {
    const current = rehearsal
    if (!current) return
    current.controller.abort()
    await current.task.catch(() => {})
    if (rehearsal === current) rehearsal = undefined
  }
  /**
   * 转场试跑：只编「A 的最后一小段」和「某个商品的第一步开头」两条片段，
   * 两条都去掉旁白，然后无限循环 —— 每一圈都能看到 A→B 和 B→A 两个方向的转场。
   *
   * 用的是内存里的精简配置，不写 director.json、不弹商品窗；
   * 这样 prepare 只编译 2 条片段，几秒就能开跑，不用等完整的 68 条。
   */
  async function startRehearsal(command: {
    trayId: string
    productId: string
    mode: 'B' | 'C'
    seconds: number
  }) {
    if (isConversationVoiceActive()) throw new Error('请先关闭独立语音对话再试跑导播')
    if (engine?.state.running) throw new Error('正式导播运行中，请先停止再试跑')
    await stopRehearsal()
    const tray = ledger.data.trays.find(item => item.id === command.trayId)
    const product = tray?.products.find(item => item.id === command.productId)
    if (!tray || !product) throw new Error('找不到托盘或商品')
    const list = product[command.mode]
    if (!list.length)
      throw new Error(`${product.name} 还没有${command.mode === 'C' ? '试戴' : '展示'}素材`)
    const a = tray.A.at(-1)
    if (!a) throw new Error('这个托盘还没有 A 总览步骤')
    const seconds = Math.min(20, Math.max(1, Number(command.seconds) || 4))
    const cache = join(app.getPath('userData'), 'director-cache')
    // 取「最后一步的末尾」要知道片长，所以先探一次
    const probe = new AbortController()
    const media = new DirectorMedia(ledger.data, cache)
    const tailA = {
      ...a,
      id: 'rehearsal-a',
      audio: [],
      speechWindows: [],
      speechSlot: false,
      start: a.end > seconds ? a.end - seconds : a.start,
    }
    const first = list[0]
    const headB = {
      ...first,
      id: 'rehearsal-b-head',
      audio: [],
      speechWindows: [],
      speechSlot: false,
      end: first.end > 0 ? Math.min(first.end, first.start + seconds) : first.start + seconds,
    }
    const last = list.at(-1) ?? first
    const lastEnd = last.end > 0 ? last.end : await media.duration(last.file, probe.signal)
    const tailB = {
      ...last,
      id: 'rehearsal-b-tail',
      audio: [],
      speechWindows: [],
      speechSlot: false,
      start: Math.max(last.start, lastEnd - seconds),
      end: lastEnd,
    }
    const trimmed: DirectorConfig = {
      ...structuredClone(ledger.data),
      trays: [
        {
          ...structuredClone(tray),
          stateGroup: '',
          transitionIn: '',
          transitionOut: '',
          A: [tailA],
          products: [
            {
              ...structuredClone(product),
              stateGroups: {},
              // 两段 B：开头用来展示「进商品」，末尾用来展示「回总览」
              B: command.mode === 'B' ? [headB, tailB] : [],
              C: command.mode === 'C' ? [headB, tailB] : [],
            },
          ],
        },
      ],
    }
    validateDirectorConfig(trimmed)
    if (isConversationVoiceActive()) throw new Error('独立语音对话已启动，请先关闭再试跑导播')
    if (engine?.state.running) throw new Error('导播已启动，请先停止再试跑')

    const controller = new AbortController()
    const logs: string[] = []
    const log = (message: string) => {
      logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`)
      if (logs.length > 40) logs.shift()
    }
    const output = new DirectorObsOutput(getObsEffectService().getSettings(), cache, log)
    const signal = controller.signal
    const task = (async () => {
      try {
        log('正在准备转场试跑素材（只编 3 条片段）…')
        await output.prepare(trimmed, signal)
        const steps = trimmed.trays[0].products[0][command.mode]
        log(
          `准备完成，开始循环：A ${seconds}s →[进商品]→ ${product.id} ${product.name} 第 1 步开头 ${seconds}s`,
        )
        log(`之后直接跳到该商品最后一步的末尾 ${seconds}s →[回总览]→ A（中间步骤省略）`)
        const target = trimmed.trays[0]
        for (;;) {
          signal.throwIfAborted()
          // overview 会重置 lastStep，让接下来的 A 步骤带上「回总览」那个方向的转场
          await output.overview(target, signal)
          await output.step(target.A[0], undefined, signal, undefined, 'A', true)
          await output.product(target.products[0], signal, command.mode)
          for (const step of steps) {
            // 第一步展示「进商品」转场，最后一步的末尾承接「回总览」转场
            await output.step(step, target.products[0], signal, undefined, command.mode, true)
          }
        }
      } catch (error) {
        if (!signal.aborted)
          log(`试跑中断：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await output.stop().catch(() => {})
        if (rehearsal?.controller === controller) rehearsal.running = false
      }
    })()
    rehearsal = { controller, logs, running: true, task }
    return '转场试跑已开始（A 末尾 → 商品第一步开头 → 商品最后一步末尾 → A 末尾，循环）'
  }
  // Fill fields added after the first director release without discarding the user's saved trays.
  ledger.data.canvasWidth ||= initial.canvasWidth
  ledger.data.canvasHeight ||= initial.canvasHeight
  ledger.data.transitionMs ??= initial.transitionMs
  ledger.data.interruptAOnRequest ??= initial.interruptAOnRequest
  ledger.data.queueSkipsOverview ??= initial.queueSkipsOverview
  ledger.data.aiPolicy ||= initial.aiPolicy
  for (const tray of ledger.data.trays) tray.A ??= []
  if (ledger.data.audioFlowVersion !== 2) ledger.change(data => void migrateDirectorAudioFlow(data))
  const preview = new DirectorPreviewServer()
  const allowedFiles = new Set<string>()
  function rememberFiles() {
    for (const t of ledger.data.trays) {
      for (const f of [t.transitionIn, t.transitionOut]) if (f) allowedFiles.add(f)
      for (const s of [...t.A, ...t.products.flatMap(product => [...product.B, ...product.C])])
        for (const f of [s.file, ...directorStepAudioFiles(s)]) if (f) allowedFiles.add(f)
    }
  }
  rememberFiles()
  // 本地 API：把同一份配置以可编程方式暴露出去。写入仍然只经过这个 ledger，
  // 所以界面、API、MCP 三边看到的是同一份状态，不会互相覆盖。
  const apiLogger = createLogger('导播 API')
  const speechAnalysis = new DirectorSpeechAnalysis(
    join(app.getPath('userData'), 'director-cache', 'speech-analysis'),
  )
  let authoringCopy:AuthoringCopyClient|undefined
  const createAuthoring=(root=join(app.getPath('userData'),'director-materials'))=>new DirectorAuthoring(root,{
    copy:(entry,frames,budget,signal)=>{
      if(!authoringCopy) throw new Error('请在智能回复设置里配置 DeepSeek Flash 看图连接')
      return authoringCopy.generate(entry,frames,budget,signal)
    },
  })
  let authoring=createAuthoring()
  function configureAuthoringCopy(id:string) {
    const defaults=defaultDeepSeekAutoSettings()
    const path=join(app.getPath('userData'),'deepseek-auto-reply.json')
    const settings=existsSync(path)?JSON.parse(readFileSync(path,'utf8'))[id]:undefined
    const connection=normalizeLiveConnection({...defaults,...settings})
    if(connection.provider!=='deepseek'||connection.model!=='deepseek-flash') throw new Error('目标模式需要 DeepSeek Flash 看图模型；请先在智能回复设置里选择')
    const credential=JSON.parse(readFileSync(join(app.getPath('userData'),'director-credentials.json'),'utf8'))
    const encrypted=credential.keys?.[liveCredentialScope(id,connection)]??(connection.baseURL===LIVE_AI_ENDPOINTS.deepseek?credential.encryptedKey:'')
    if(!encrypted||!safeStorage.isEncryptionAvailable()) throw new Error('目标模式尚无可用看图密钥，请先在智能回复设置里保存密钥')
    authoringCopy=new AuthoringCopyClient({apiKey:safeStorage.decryptString(Buffer.from(encrypted,'base64')),baseURL:connection.baseURL,model:connection.model})
  }
  const requireAuthoringOffline=()=>{
    if(engine?.state.running||rehearsal?.running||isConversationVoiceActive()) throw new Error('请先停止导播、试跑和独立语音对话再制作素材')
  }
  async function runAuthoring(command:Extract<DirectorCommand,{action:`authoring-${string}`}>):Promise<DirectorResponse> {
    switch(command.action) {
      case 'authoring-prepare':
        requireAuthoringOffline();validateDirectorConfig(command.config);configureAuthoringCopy(command.accountId||'default')
        return {ok:true,authoring:authoring.startPrepare(command.config,command.options)}
      case 'authoring-status':return {ok:true,authoring:authoring.status(command.jobId)}
      case 'authoring-render':
        if(command.accountId)configureAuthoringCopy(command.accountId)
        requireAuthoringOffline();return {ok:true,authoring:authoring.startRender(command.jobId,command.copies)}
      case 'authoring-cancel':authoring.cancel(command.jobId);return {ok:true,authoring:authoring.status(command.jobId)}
      case 'authoring-candidate': {
        requireAuthoringOffline();const candidate=await authoring.candidate(command.jobId,command.config);validateDirectorConfig(candidate)
        return {ok:true,config:candidate}
      }
      case 'authoring-images':return {ok:true,frames:await authoring.images(command.jobId,command.stepId)}
      case 'authoring-audio': {
        const item=authoring.status(command.jobId).entries.find(e=>e.step.id===command.stepId)
        if(item?.state!=='ready'||!item.result)throw new Error('该步骤尚无已完成配音')
        return {ok:true,url:await preview.url(item.result.audio)}
      }
      case 'authoring-import': {
        requireAuthoringOffline();if(authoring.busy)throw new Error('请先完成或取消当前素材任务')
        const choice=await dialog.showOpenDialog({title:'选择包含 manifest.json 的素材任务文件夹',properties:['openDirectory']})
        const directory=choice.filePaths[0];if(!directory)return {ok:true}
        const loaded=createAuthoring(dirname(directory));const job=await loaded.load(directory);authoring=loaded
        return {ok:true,authoring:job}
      }
    }
  }
  const apiHost = new DirectorApiHost({
    userDataDir: app.getPath('userData'),
    obsOverlayDirectory: join(app.getAppPath(), 'dist', 'obs-instant-effects'),
    log: message => apiLogger.info(message),
    facade: {
      assistantDesk:executeAssistantDeskCommand,
      effectGroups:executeEffectGroupCommand,
      platformSession:executePlatformSessionCommand,
      analysisRoom: executeAnalysisRoomCommand,
      obsControl: command => executeObsEffectCommand(command),
      hooksControl: executeHookCommand,
      pageDiagnostics: async (id, marker) => {
        const session = accountManager.accountSessions.get(id)
        if (!session) throw new Error('账号尚未连接')
        return session.getPageDiagnostics(marker)
      },
      experimentStatus: () => getDirectorExperiment().status(),
      experimentStart: () => getDirectorExperiment().start(),
      getVoiceConfig: id => getLiveVoiceConfiguration().snapshot(id),
      applyVoiceConfig: (id, revision, patch) => getLiveVoiceConfiguration().apply(id, revision, patch),
      checkVoice: id => getLiveVoiceConfiguration().check(id),
      authoring:runAuthoring,
      getInteraction: getInteractionRouting,
      applyInteraction: applyInteractionRouting,
      simulateInteraction: simulateInteractionRouting,
      getAudience: getInteractionAudience,
      adjustAudienceScore: adjustInteractionScore,
      getTimeline: getInteractionTimeline,
      getInteractionCapabilities,
      analyzeSpeech: input => {
        if (engine?.state.running || rehearsal?.running) throw new Error('请先停止导播和试跑')
        return speechAnalysis.analyze(structuredClone(ledger.data), input)
      },
      planSpeech: async (id, selections) => {
        if (engine?.state.running || rehearsal?.running) throw new Error('请先停止导播和试跑')
        const config = structuredClone(ledger.data)
        const ops = await speechAnalysis.plan(config, id, selections)
        if (JSON.stringify(config) !== JSON.stringify(ledger.data))
          throw new Error('配置已改变，请重新分析')
        return ops
      },
      getConfig: () => structuredClone(ledger.data),
      getState: () => engine?.snapshot(),
      isRunning: () => Boolean(engine?.state.running),
      validateConfig: config => validateDirectorConfig(config),
      saveConfig: config => {
        if (engine?.state.running) throw new Error('请先停止导播再修改配置')
        validateDirectorConfig(config)
        ledger.change(data => Object.assign(data, config))
        rememberFiles()
      },
      discoverObs: async () => {
        const obs = getObsEffectService()
        const settings = obs.getSettings()
        return await obs.discover(settings.url, settings.password)
      },
    },
  })
  void app.whenReady().then(() => apiHost.start())
  app.on('before-quit', () => {
    void apiHost.stop()
  })
  emitter.on('live-comment', ({ accountId: id, comment }) => {
    if (!engine?.state.running || engine.state.preview || !ledger.data.listen || accountId !== id)
      return
    if (
      ![
        'comment',
        'xiaohongshu_comment',
        'tiktok_comment',
        'taobao_comment',
        'wechat_channel_live_msg',
      ].includes(comment.msg_type)
    )
      return
    if (!('content' in comment) || typeof comment.content !== 'string') return
    const observed = observeInteraction(id, comment)
    if (!observed) return
    const user = liveViewerIdentity(
      accountManager.accountSessions.get(id)?.getPlatformName() || 'unknown',
      comment,
    )
    if ('is_self' in comment && comment.is_self) return
    if (comment.nick_name === accountManager.accountSessions.get(id)?.getLiveAccountName()) return
    if (!isDeepSeekAutoActive(id))
      engine.comment(comment.content || '', user, comment.msg_id, observed.trace)
  })
  emitter.on('comment-listener-stopped', ({ accountId: id }) => {
    if (id === accountId) void stop()
  })
  emitter.on('page-closed', ({ accountId: id }) => {
    if (id === accountId) void stop()
  })
  app.on('before-quit', () => {
    void stop()
    preview.close()
  })
  let changing = false
  typedIpcMainHandle(
    IPC_CHANNELS.director.request,
    async (_event, command): Promise<DirectorResponse> => {
      const mutation = ['save', 'start', 'stop'].includes(command.action)
      if (mutation && changing) return { ok: false, error: '正在处理上一个操作，请稍候' }
      if (mutation) changing = true
      try {
        switch (command.action) {
          case 'authoring-prepare':case 'authoring-status':case 'authoring-render':case 'authoring-cancel':
          case 'authoring-candidate':case 'authoring-images':case 'authoring-audio':case 'authoring-import':
            return runAuthoring(command)
          case 'state':
            return {
              ok: true,
              config: ledger.data,
              state: snapshot(),
              rehearsal: rehearsal ? { running: rehearsal.running, logs: rehearsal.logs } : null,
              ctaFiles: Object.fromEntries(
                ledger.data.trays.map(t => [t.id, ctaOverlayPath(t.id)]),
              ),
            }
          case 'discover-obs': {
            const obs = getObsEffectService()
            const settings = obs.getSettings()
            return {
              ok: true,
              scenes: await obs.discover(settings.url, settings.password),
              message: '已读取 OBS 场景和素材组',
            }
          }
          case 'save':
            if (engine?.state.running) throw new Error('请先停止导播再修改配置')
            validateDirectorConfig(command.config)
            ledger.change(data => Object.assign(data, command.config))
            rememberFiles()
            writeCtaOverlays(ledger.data)
            return {
              ok: true,
              config: ledger.data,
              message: '配置已保存',
              warnings: directorStepRewinds(ledger.data),
            }
          case 'pick': {
            const extensions = {
              video: ['mp4', 'mov', 'mkv', 'webm'],
              image: ['png', 'jpg', 'jpeg', 'webp'],
              audio: ['wav', 'mp3', 'm4a', 'aac', 'ogg'],
              executable: ['exe'],
            }
            const result = await dialog.showOpenDialog({
              properties: ['openFile'],
              filters: [{ name: command.kind, extensions: extensions[command.kind] }],
            })
            const file = result.filePaths[0]
            if (file && command.kind !== 'executable') allowedFiles.add(file)
            return { ok: true, file }
          }
          case 'preview-file':
            if (!allowedFiles.has(command.file)) throw new Error('请先通过文件选择器导入素材')
            return { ok: true, url: await preview.url(command.file) }
          case 'speech-analyze': {
            if (engine?.state.running || rehearsal?.running)
              throw new Error('请先停止导播和试跑再分析插入点')
            const analysis = await speechAnalysis.analyze(
              structuredClone(ledger.data),
              command.input,
            )
            return { ok: true, analysis }
          }
          case 'speech-plan': {
            if (engine?.state.running || rehearsal?.running)
              throw new Error('请先停止导播和试跑再保存插入点')
            const draft = structuredClone(ledger.data)
            const ops = await speechAnalysis.plan(draft, command.analysisId, command.selections)
            if (JSON.stringify(draft) !== JSON.stringify(ledger.data))
              throw new Error('配置已改变，请重新分析')
            const applied = applyDirectorOps(ledger.data, ops)
            validateDirectorConfig(applied.config)
            if (command.apply) {
              ledger.change(data => Object.assign(data, applied.config))
              rememberFiles()
            }
            return {
              ok: true,
              ops,
              saved: Boolean(command.apply),
              message: command.apply ? `已保存 ${ops.length} 个步骤的插入点` : '未保存（仅预览）',
            }
          }
          case 'speech-preview': {
            if (engine?.state.running || rehearsal?.running)
              throw new Error('请先停止导播和试跑再试听')
            const text = String(command.text || '').trim()
            if (!text) throw new Error('请先输入要试听的文字')
            if (text.length > 120) throw new Error('试听文字最多 120 字')
            if (!allowedFiles.has(command.audio))
              throw new Error('请先通过文件选择器导入配音素材')
            const { start, end } = command
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0)
              throw new Error('插入点时间范围无效')
            const previewClient = selectedAccountVoiceClient<ReturnType<typeof getIndexVoiceClient> | ReturnType<typeof getQwenVoiceClient>>(command.accountId, getIndexVoiceClient, getQwenVoiceClient)

            const folder = join(app.getPath('userData'), 'director-cache', 'speech-preview')
            mkdirSync(folder, { recursive: true })
            const stamp = String(Date.now())
            const replyFile = join(folder, `reply-${stamp}.wav`)
            const mixedFile = join(folder, `mixed-${stamp}.wav`)

            const controller = new AbortController()
            const wav = await previewClient.synthesize(
              command.accountId,
              stamp,
              text,
              controller.signal,
            )
            writeFileSync(replyFile, wav)

            const media = new DirectorMedia(ledger.data, folder)
            const replyDuration = await media.duration(replyFile, controller.signal)

            // 原配音在插入点静音，合成语音从插入点起点叠上去。
            // 合成比窗口长时不会截断 —— 就是要让你听见「放不下」是什么效果。
            await runMediaCommand(
              ledger.data.ffmpeg,
              [
                '-y',
                '-i',
                command.audio,
                '-i',
                replyFile,
                '-filter_complex',
                `[0:a]volume=enable='between(t,${start},${end})':volume=0[bed];` +
                  `[1:a]adelay=${Math.round(start * 1000)}:all=1[vo];` +
                  `[bed][vo]amix=inputs=2:duration=first:normalize=0[out]`,
                '-map',
                '[out]',
                '-ar',
                '22050',
                '-ac',
                '1',
                mixedFile,
              ],
              controller.signal,
              true,
            )

            return {
              ok: true,
              replyUrl: await preview.url(replyFile),
              mixedUrl: await preview.url(mixedFile),
              replyDuration: Math.round(replyDuration * 100) / 100,
              windowDuration: Math.round((end - start) * 100) / 100,
              fits: replyDuration <= end - start,
            }
          }
          case 'start': {
            if(authoring.busy) throw new Error('请先完成或取消素材制作')
            if (isConversationVoiceActive())
              throw new Error('独立语音对话正在运行；请先关闭它，或选择导播气口模式')
            if (engine?.state.running) throw new Error('导播已经启动')
            if (rehearsal?.running) throw new Error('转场试跑进行中，请先停止试跑')
            accountId = command.accountId
            liveEpoch++
            // 开播前刷一遍引导页，保证 OBS 读到的是最新文案
            writeCtaOverlays(ledger.data)
            if (!command.preview) await suspendCodexForDirector(accountId)
            if (isConversationVoiceActive()) throw new Error('独立语音对话已启动，请先关闭它')
            if (engine?.state.running || rehearsal?.running) throw new Error('导播或试跑已启动')
            if (!command.preview && ledger.data.popup) {
              const session = accountManager.accountSessions.get(accountId)
              if (!session) throw new Error('开启商品弹窗前请先连接中控台')
              session.stopTask('auto-popup')
            }
            // 模拟流程没有真实 OBS 输出，预瞄自然也没有窗口可给。
            directorOutput = command.preview
              ? undefined
              : new DirectorObsOutput(
                  getObsEffectService().getSettings(),
                  join(app.getPath('userData'), 'director-cache'),
                  message => engine?.log(message),
                  undefined,
                  directorSpeechQueue,
                  directorSpeechLedger,
                  /**
                   * 虚拟声卡那一路。给 device_id 才会在导播场景里建采集源、
                   * 才会走那条**没有媒体源加载开销**的播报路径。
                   *
                   * 拿不到就传 undefined —— 导播照常跑，只是退回媒体源。
                   */
                  cableDevice(),
                  getVirtualCablePlayer(),
                )
            const output = directorOutput ?? new PreviewDirectorOutput()
            engine = new DirectorEngine(
              structuredClone(ledger.data),
              output,
              async (goodsId, _label, signal) => {
                const session = accountManager.accountSessions.get(accountId)
                if (!session) throw new Error('中控台未连接')
                await session.performDirectorPopup(goodsId, signal)
              },
              undefined,
              // 导播崩了留一条盘上记录 —— 界面日志一刷新就没了，事后没法查。
              ({ where, detail }) => {
                try {
                  appendFileSync(
                    join(app.getPath('userData'), 'director-crash.log'),
                    `[${new Date().toISOString()}] 导播异常停止\n  位置：${where}\n  原因：${detail}\n`,
                    'utf-8',
                  )
                } catch {}
              },
              command.preview ? undefined : getLiveMemory().requests(accountId),
            )
            await engine.start(command.trayId, command.preview)
            return {
              ok: true,
              state: engine.snapshot(),
              message: command.preview
                ? '模拟运行已开始；不会控制 OBS 或发送评论'
                : '开始准备素材，请查看导播状态',
            }
          }
          case 'rehearse': {
            const message = await startRehearsal(command)
            return {
              ok: true,
              message,
              rehearsal: rehearsal ? { running: rehearsal.running, logs: rehearsal.logs } : null,
            }
          }
          case 'rehearse-stop':
            await stopRehearsal()
            return { ok: true, message: '转场试跑已停止', rehearsal: null }
          case 'stop':
            await stop()
            return { ok: true, state: engine?.snapshot(), rehearsal: null }
          case 'enqueue':
            return {
              ok: true,
              message:
                engine?.enqueue(command.trayId, command.productId, command.mode) || '请先启动导播',
              state: engine?.snapshot(),
            }
          case 'remove':
            engine?.removeRequest(command.id)
            return { ok: true }
          case 'comment':
            return {
              ok: true,
              message: engine?.comment(command.text, command.user) || '没有识别到点播请求',
              state: snapshot(),
            }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        if (mutation) changing = false
      }
    },
  )
}
