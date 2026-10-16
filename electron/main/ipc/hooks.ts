import path from 'node:path'
import { app } from 'electron'
import {
  defaultHookSettings,
  type HookCommand,
  type HookResponse,
  type HookRule,
  type HookSettings,
} from '../../../shared/hooks'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { emitter } from '../event/eventBus'
import { createLogger } from '../logger'
import { accountManager } from '../managers/AccountManager'
import { AIChatService } from '../services/AIChatServices'
import { ownsUnifiedEntryReplies } from '../services/DeepSeekAutoState'
import { HookEngine } from '../services/HookEngine'
import { JsonLedger } from '../services/JsonLedger'
import { LocalHookServer } from '../services/LocalHookServer'
import { typedIpcMainHandle } from '../utils/ipc'
import { recordAudit } from './audit'
import { observeAudience, recordInteractionEvent } from './interactionRouting'
import { getObsEffectLedger, getObsEffectService } from './obsEffect'
import type { GroupEvaluationInput } from '../../../shared/audienceGroups'
import { getAssistantDesk } from './assistantDesk'
import type { AssistantDeskContext } from '../../../shared/assistantDesk'
import type {AssistantDeskRow} from '../../../shared/assistantDesk'
import type {EffectActionKind} from '../../../shared/effectGroups'
import { welcomePreset } from '../../../shared/obsWelcome'

let analysisHookSettings: () => HookSettings = () => defaultHookSettings
let assistantEffectDispatch:((accountId:string,message:LiveMessage,row?:AssistantDeskRow,legacyEnabled?:boolean)=>Promise<void>)|undefined
let effectGroupsBridge:{nextSequence:()=>number;ownsAction:(accountId:string,action:EffectActionKind)=>boolean;dispatchPersisted:(row:AssistantDeskRow,sequence:number)=>Promise<{handled:boolean}>}|undefined
export function registerEffectGroupsBridge(bridge:NonNullable<typeof effectGroupsBridge>){effectGroupsBridge=bridge}
const receivedSequences=new WeakMap<object,number>()
let legacySequence=0
export function reserveEffectSequence(message:LiveMessage){
  let sequence=receivedSequences.get(message)
  if(sequence===undefined){sequence=effectGroupsBridge?.nextSequence()??++legacySequence;receivedSequences.set(message,sequence)}
  return sequence
}
let hookCommandDispatch: ((command: HookCommand) => Promise<HookResponse>) | undefined

export async function executeHookCommand(command: HookCommand): Promise<HookResponse> {
  if (!hookCommandDispatch) return { ok: false, error: '钩子服务尚未初始化' }
  return hookCommandDispatch(command)
}
export async function dispatchAssistantLocalEffects(accountId:string,message:LiveMessage,row?:AssistantDeskRow){
  if(!assistantEffectDispatch)return
  const context=await getAssistantDesk().execute({action:'context-get',params:{accountId}})
  if(context.ok){
    const legacyEnabled=(context.data as AssistantDeskContext).localEffectsEnabled===true
    if(legacyEnabled||row&&effectGroupsBridge?.ownsAction(accountId,row.kind as EffectActionKind))
      await assistantEffectDispatch(accountId,message,row,legacyEnabled)
  }
}
/** Read-only warning metadata; no action templates, credentials or dispatch are exposed. */
export function getAnalysisHookSummaries(platform: LiveControlPlatform): NonNullable<GroupEvaluationInput['hooks']> {
  return analysisHookSettings().rules.filter(rule => rule.source === platform && rule.eventType === 'viewer.enter').slice(0,1000).map(rule => ({id:rule.id,enabled:rule.enabled,events:['viewer.enter']}))
}

export function setupHookIpcHandlers() {
  const logger = createLogger('钩子')
  let sendTail: Promise<void> = Promise.resolve()
  let pendingSends = 0
  let nextSendAt = 0
  const ledger = new JsonLedger<HookSettings>(
    path.join(app.getPath('userData'), 'hooks.json'),
    structuredClone(defaultHookSettings),
    { backups: 5 },
  )
  migrateObsEffects(ledger)
  normalizeMigratedRules(ledger)
  const engine = new HookEngine(
    ledger.data,
    getObsEffectService(),
    logger,
    {
      async generateText(action, prompt) {
        const service = AIChatService.createService(
          action.apiKey,
          action.provider,
          action.customBaseURL,
        )
        return service.chat(
          [
            ...(action.systemPrompt.trim()
              ? [{ role: 'system' as const, content: action.systemPrompt.trim() }]
              : []),
            { role: 'user', content: prompt },
          ],
          action.model,
        )
      },
      async sendMessage(accountId, text) {
        if (!accountId) throw new Error('该事件没有关联直播账号，无法发送到公屏')
        if (pendingSends >= 20) throw new Error('公屏答谢队列已满')
        pendingSends++
        const task = sendTail
          .catch(() => {})
          .then(async () => {
            const waitMs = Math.max(0, nextSendAt - Date.now())
            if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs))
            const session = accountManager.accountSessions.get(accountId)
            if (!session?.liveInteractionReady()) throw new Error('直播账号未连接或评论监听已停止')
            const sent = await session.sendCodexReply(text, new AbortController().signal)
            nextSendAt = Date.now() + 3_000
            if (!sent) throw new Error('平台未确认公屏消息发送成功')
          })
          .finally(() => {
            pendingSends--
          })
        sendTail = task.catch(() => {})
        await task
      },
    },
    recordAudit,
    recordInteractionEvent,
  )
  const server = new LocalHookServer(engine)
  analysisHookSettings = () => engine.getSettings()
  // All accounts share this one OBS service and its physical receivers.
  const welcomeOwners = new Map<string, number>()
  const claimWelcome = (sequence:number, presetId:unknown) => {
    const lane = welcomePreset(presetId).kind === 'obs-media' ? 'premium' : 'ordinary'
    // Sequence is allocated before async classification. A slow older result
    // cannot take ownership from a newer arrival in the same visual channel.
    if(sequence > (welcomeOwners.get(lane) ?? 0)) welcomeOwners.set(lane,sequence)
    return ()=>welcomeOwners.get(lane)===sequence
  }
  assistantEffectDispatch=async(accountId,message,row,legacyEnabled=true)=>{
    const event=engine.fromLiveMessage(message)
    if(!event)return
    const sequence=reserveEffectSequence(message)
    const audiencePolicy=await getAssistantDesk().classifyAudienceEvent(accountId,message)
    const welcomePolicy=event.type==='viewer.enter'?audiencePolicy:undefined
    const welcomeCurrent=welcomePolicy?claimWelcome(sequence,welcomePolicy.welcomePresetId??(welcomePolicy.tier==='gold'?'gold':'pearl')):undefined
    const groupResult=row&&effectGroupsBridge?await effectGroupsBridge.dispatchPersisted({...row,triage:audiencePolicy},sequence):{handled:false}
    await engine.dispatch(event,{accountId,localEffectsOnly:true,suppressPublicReplies:true,suppressObsEffects:groupResult.handled||!legacyEnabled,audiencePolicy,welcomePolicy,welcomeCurrent})
  }

  void server.start(ledger.data.webhookPort).catch(error => {
    logger.error(`启动本机 Webhook 失败：${error instanceof Error ? error.message : String(error)}`)
  })

  emitter.on('live-comment', ({ accountId, comment }) => {
    const audience = observeAudience(accountId, comment)
    if (!audience) return
    const event = engine.fromLiveMessage(comment)
    if (!event) return
    const sequence=reserveEffectSequence(comment)
    if (audience) {
      event.data.user = { ...(event.data.user as object), ...audience.user }
      event.data.room = { ...(event.data.room as object), ...audience.room }
    }
    void (async () => {
      const audiencePolicy=await getAssistantDesk().classifyAudienceEvent(accountId,comment)
      const welcomePolicy=event.type==='viewer.enter'?audiencePolicy:undefined
      const welcomeCurrent=welcomePolicy?claimWelcome(sequence,welcomePolicy.welcomePresetId??(welcomePolicy.tier==='gold'?'gold':'pearl')):undefined
      await engine.dispatch(event, {
        suppressObsEffects:effectGroupsBridge?.ownsAction(accountId,event.type.replace('viewer.','') as EffectActionKind)??false,
        accountId,
        trace: audience.trace,
        suppressPublicReplies: event.type === 'viewer.enter' && ownsUnifiedEntryReplies(accountId),
        audiencePolicy,
        welcomePolicy,
        welcomeCurrent,
      })
    })().catch(error => {
        logger.error(`处理直播钩子失败：${error instanceof Error ? error.message : String(error)}`)
      })
  })

  app.on('before-quit', () => {
    void server.stop()
  })

  hookCommandDispatch = async (command): Promise<HookResponse> => {
    try {
      if (!command || typeof command.action !== 'string') throw new Error('无效操作')
      switch (command.action) {
        case 'state':
          return {
            ok: true,
            settings: engine.getSettings(),
            webhookUrl: `http://127.0.0.1:${engine.getSettings().webhookPort}/hooks/{事件名称}`,
          }
        case 'save': {
          engine.configure(command.settings)
          await server.start(command.settings.webhookPort)
          ledger.change(data => Object.assign(data, engine.getSettings()))
          return {
            ok: true,
            settings: engine.getSettings(),
            webhookUrl: `http://127.0.0.1:${command.settings.webhookPort}/hooks/{事件名称}`,
            message: '钩子设置已保存',
          }
        }
        case 'discover-obs': {
          const obs = getObsEffectService()
          const settings = obs.getSettings()
          return {
            ok: true,
            scenes: await obs.discover(settings.url, settings.password),
            message: '已读取 OBS 场景和来源',
          }
        }
        case 'test':
          await testHook(command.rule, engine)
          return { ok: true, message: '钩子试播成功' }
        default:
          throw new Error('未知操作')
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '钩子操作失败' }
    }
  }
  typedIpcMainHandle(IPC_CHANNELS.hooks.request, (_event, command) => executeHookCommand(command))
}

async function testHook(rule: HookRule, engine: HookEngine) {
  await engine.preview(rule)
}

function migrateObsEffects(ledger: JsonLedger<HookSettings>) {
  if (ledger.data.migratedObsEffects) return
  const obsSettings = getObsEffectLedger().data
  ledger.change(data => {
    for (const effect of obsSettings.effects || []) {
      data.rules.push({
        id: `migrated-${effect.id}`,
        name: `TikTok 进场 · ${effect.minFansLevel} 级`,
        enabled: obsSettings.enabled && effect.enabled,
        exclusiveGroup: 'tiktok.viewer.enter.level',
        priority: effect.minFansLevel,
        levelStrategy: 'fan-club-first',
        source: 'tiktok',
        eventType: 'viewer.enter',
        conditions: [
          {
            field: 'user.effectiveLevel',
            operator: 'gte',
            value: effect.minFansLevel,
          },
        ],
        actions: [
          {
            type: 'obs.show-source',
            target: {
              sceneName: effect.sceneName,
              sourceName: effect.sourceName,
              sourceContainerName: effect.sourceContainerName,
              durationMs: effect.durationMs,
            },
          },
        ],
      })
    }

    data.migratedObsEffects = true
  })
}

function normalizeMigratedRules(ledger: JsonLedger<HookSettings>) {
  const needsUpdate = ledger.data.rules.some(
    rule => rule.id.startsWith('migrated-') && !rule.exclusiveGroup,
  )
  if (!needsUpdate) return
  ledger.change(data => {
    for (const rule of data.rules) {
      if (!rule.id.startsWith('migrated-') || rule.exclusiveGroup) continue
      const level = rule.conditions.find(condition => condition.field === 'user.effectiveLevel')
      rule.exclusiveGroup = 'tiktok.viewer.enter.level'
      rule.priority = typeof level?.value === 'number' ? level.value : 0
      rule.levelStrategy = 'fan-club-first'
    }
  })
}
