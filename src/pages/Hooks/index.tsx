import { Pencil, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import {
  defaultHookSettings,
  type HookAction,
  type HookCommand,
  type HookRule,
  type HookSettings,
  type TikTokLevelStrategy,
} from 'shared/hooks'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import type { AssistantAudiencePolicy } from 'shared/assistantAudiencePolicy'
import type { ObsSceneMetadata } from 'shared/obsEffect'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/useToast'
import { useAccounts } from '@/hooks/useAccounts'

type TriggerKind = 'tiktok' | 'tiktok-follow' | 'tiktok-like' | 'tiktok-gift' | 'xiaohongshu' | 'xiaohongshu-follow' | 'webhook'
type ExecutionMode = 'parallel' | 'sequential'
type ObsTargetMode = 'source' | 'group-random'

interface Draft {
  id?: string
  name: string
  trigger: TriggerKind
  minLevel: number
  audienceSelection: 'all' | 'rule' | 'legacy'
  audienceRuleId: string
  audienceAccountId?: string
  audienceConditionField?: 'audience.matchedRuleId' | 'audience.ruleId'
  cooldownMs: number
  levelStrategy: TikTokLevelStrategy
  eventName: string
  minAmount: string
  giftId: string
  minGiftCount: string
  minGiftCoins: string
  sceneName: string
  useObs: boolean
  obsTargetMode: ObsTargetMode
  sourceName: string
  sourceContainerName?: string
  groupName: string
  groupContainerName?: string
  avoidImmediateRepeat: boolean
  durationMs: number
  useText: boolean
  useArtText: boolean
  artTextInputName: string
  artTextTemplate: string
  artTextStyle: 'rainbow' | 'gold' | 'arc' | 'random'
  artTextDelivery: 'immediate' | 'queued'
  artTextHoldMs: number
  artTextPriority: number
  textSourceName: string
  textTemplate: string
  useAi: boolean
  aiApiKey: string
  aiModel: string
  aiSystemPrompt: string
  aiPromptTemplate: string
  useSend: boolean
  sendTemplate: string
  executionMode: ExecutionMode
}

const emptyDraft: Draft = {
  name: '',
  trigger: 'tiktok',
  minLevel: 0,
  audienceSelection: 'all',
  audienceRuleId: '',
  cooldownMs: 0,
  levelStrategy: 'fan-club-first',
  eventName: 'order.paid',
  minAmount: '',
  giftId: '',
  minGiftCount: '1',
  minGiftCoins: '',
  sceneName: '',
  useObs: true,
  obsTargetMode: 'group-random',
  sourceName: '',
  groupName: '',
  avoidImmediateRepeat: true,
  durationMs: 30_000,
  useText: false,
  useArtText: false,
  artTextInputName: '✨ 互动欢迎字',
  artTextTemplate: '欢迎 {{user.screenName}}',
  artTextStyle: 'rainbow',
  artTextDelivery: 'queued',
  artTextHoldMs: 1800,
  artTextPriority: 10,
  textSourceName: '',
  textTemplate: '欢迎 {{user.name}} 进入直播间',
  useAi: false,
  aiApiKey: '',
  aiModel: 'deepseek-flash',
  aiSystemPrompt: '你是直播间助手。回复要自然、简短，不要编造信息。',
  aiPromptTemplate: '请为刚刚关注直播间的 {{user.name}} 生成一句答谢语。',
  useSend: false,
  sendTemplate: '{{actions.ai-reply.text}}',
  executionMode: 'parallel',
}

export function createHookTrigger(trigger: TriggerKind): Pick<HookRule, 'source' | 'eventType'> {
  return {
    source: trigger === 'webhook' ? 'webhook' : trigger.startsWith('tiktok') ? 'tiktok' : 'xiaohongshu',
    eventType: trigger === 'webhook'
      ? 'webhook.received'
      : trigger === 'tiktok-gift'
        ? 'viewer.gift'
        : trigger === 'xiaohongshu-follow' || trigger === 'tiktok-follow'
          ? 'viewer.follow'
          : trigger === 'tiktok-like' ? 'viewer.like' : 'viewer.enter',
  }
}

export function readHookTrigger(rule: Pick<HookRule, 'source' | 'eventType'>): TriggerKind {
  if (rule.source === 'tiktok') {
    if (rule.eventType === 'viewer.gift') return 'tiktok-gift'
    if (rule.eventType === 'viewer.follow') return 'tiktok-follow'
    if (rule.eventType === 'viewer.like') return 'tiktok-like'
  }
  if (rule.source === 'xiaohongshu' && rule.eventType === 'viewer.follow') {
    return 'xiaohongshu-follow'
  }
  return rule.source
}

export function createGiftConditions(giftId: string, minGiftCount: string, minGiftCoins = ''): HookRule['conditions'] {
  const count = Number(minGiftCount)
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('最低礼物数量必须是大于或等于 1 的整数')
  }
  const id = giftId.trim()
  if (id && !/^[1-9]\d*$/.test(id)) {
    throw new Error('礼物 ID 必须是正整数，留空表示任意礼物')
  }
  const conditions: HookRule['conditions'] = []
  if (id) conditions.push({ field: 'gift.id', operator: 'eq', value: id })
  conditions.push({ field: 'gift.count', operator: 'gte', value: count })
  if (minGiftCoins.trim()) {
    const coins = Number(minGiftCoins)
    if (!Number.isSafeInteger(coins) || coins < 1) {
      throw new Error('最低总金币数必须是大于或等于 1 的整数')
    }
    conditions.push({ field: 'gift.totalCoins', operator: 'gte', value: coins })
  }
  return conditions
}

export function readGiftFilters(rule: Pick<HookRule, 'conditions'>) {
  const id = rule.conditions.find(item => item.field === 'gift.id' && item.operator === 'eq')?.value
  const count = rule.conditions.find(item => item.field === 'gift.count' && item.operator === 'gte')?.value
  const coins = rule.conditions.find(item => item.field === 'gift.totalCoins' && item.operator === 'gte')?.value
  return {
    giftId: typeof id === 'string' || typeof id === 'number' ? String(id) : '',
    minGiftCount: typeof count === 'number' ? String(count) : '1',
    minGiftCoins: typeof coins === 'number' ? String(coins) : '',
  }
}

export function giftTriggerDefaults() {
  return {
    minGiftCoins: '1',
    useSend: false,
    sendTemplate: '{{user.mention}} 谢谢你的 {{gift.name}} ×{{gift.count}}！',
    artTextTemplate: '谢谢 {{user.screenName}} 的 {{gift.name}} ×{{gift.count}}',
    textTemplate: '谢谢 {{user.name}} 的 {{gift.name}} ×{{gift.count}}',
    aiPromptTemplate: '请为 {{user.name}} 送出的 {{gift.name}} ×{{gift.count}} 生成一句简短答谢语。',
  }
}

export function getDraftRuleEnabled(id: string | undefined, rules: HookRule[]) {
  return id ? rules.find(rule => rule.id === id)?.enabled ?? true : true
}

export function preserveSavedGiftMetadata(rule: HookRule, savedRule: HookRule | undefined): HookRule {
  if (!savedRule || savedRule.id !== rule.id || rule.source !== 'tiktok' || rule.eventType !== 'viewer.gift'
    || savedRule.source !== 'tiktok' || savedRule.eventType !== 'viewer.gift') return rule
  return {
    ...rule,
    exclusiveGroup: savedRule.exclusiveGroup,
    priority: savedRule.priority,
    levelStrategy: savedRule.levelStrategy,
  }
}

export default function Hooks() {
  const accountId = useAccounts(state => state.currentAccountId)
  const [settings, setSettings] = useState<HookSettings>(defaultHookSettings)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [scenes, setScenes] = useState<ObsSceneMetadata[]>([])
  const [webhookUrl, setWebhookUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [audiencePolicyRead, setAudiencePolicyRead] = useState<{ accountId: string; policy?: AssistantAudiencePolicy; error?: string }>()
  const [policyRefresh, setPolicyRefresh] = useState(0)
  const audiencePolicy = audiencePolicyRead?.accountId === accountId ? audiencePolicyRead.policy : undefined
  const audiencePolicyError = audiencePolicyRead?.accountId === accountId ? audiencePolicyRead.error : undefined
  const { toast } = useToast()

  useEffect(() => {
    void request({ action: 'state' }).then(response => {
      if (!response.ok) {
        toast.error(response.error)
        return
      }
      if (response.settings) setSettings(response.settings)
      if (response.webhookUrl) setWebhookUrl(response.webhookUrl)
    })
  }, [toast])

  useEffect(() => {
    let current = true
    void window.ipcRenderer.invoke('assistant-desk:request', { action: 'policy-get', params: { accountId } })
      .then(response => {
        if (!current) return
        setAudiencePolicyRead(response.ok ? { accountId, policy: response.data as AssistantAudiencePolicy } : { accountId, error: response.error.message })
      }).catch(() => {
        if (current) setAudiencePolicyRead({ accountId, error: '观众规则读取失败，请刷新重试' })
      })
    return () => { current = false }
  }, [accountId, policyRefresh])

  const selectedScene = scenes.find(scene => scene.name === draft.sceneName)
  const selectedSourceKey = draft.sourceName
    ? JSON.stringify([draft.sourceContainerName || draft.sceneName, draft.sourceName])
    : ''
  const selectedGroupKey = draft.groupName
    ? JSON.stringify([draft.groupContainerName || draft.sceneName, draft.groupName])
    : ''

  const discoverObs = async () => {
    setBusy('discover')
    try {
      const response = await request({ action: 'discover-obs' })
      if (!response.ok) throw new Error(response.error)
      setScenes(response.scenes || [])
      const scene =
        response.scenes?.find(item => item.name === draft.sceneName) || response.scenes?.[0]
      const source = scene?.sources.find(item => !item.isGroup)
      const group = scene?.sources.find(item => item.isGroup)
      setDraft(current => ({
        ...current,
        sceneName: scene?.name || '',
        sourceName: source?.name || '',
        sourceContainerName: source?.containerName,
        groupName: group?.name || '',
        groupContainerName: group?.containerName,
      }))
      toast.success(response.message || '已读取 OBS')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取 OBS 失败')
    } finally {
      setBusy(null)
    }
  }

  const buildRule = (): HookRule | null => {
    if (!draft.name.trim()) {
      toast.error('请输入钩子名称')
      return null
    }
    if (!draft.useObs && !draft.useText && !draft.useArtText && !draft.useAi && !draft.useSend) {
      toast.error('请至少启用一个动作')
      return null
    }
    if (!Number.isInteger(draft.durationMs) || draft.durationMs < 100) {
      toast.error('显示时长必须是大于或等于 100 的整数')
      return null
    }
    const savedRule = settings.rules.find(rule => rule.id === draft.id)
    const triggerIdentity = createHookTrigger(draft.trigger)
    const sameTrigger = savedRule?.source === triggerIdentity.source && savedRule?.eventType === triggerIdentity.eventType
    const conditions: HookRule['conditions'] = (sameTrigger ? savedRule.conditions : []).filter(condition =>
      !['user.effectiveLevel', 'audience.matchedRuleId', 'audience.ruleId', 'audience.accountId', 'gift.id', 'gift.count', 'gift.totalCoins', 'eventName', 'payload.amount'].includes(condition.field))
    if (draft.trigger === 'webhook') conditions.push({ field: 'eventName', operator: 'eq', value: draft.eventName.trim() })
    else if (draft.audienceSelection === 'rule') {
      conditions.push({ field: draft.audienceConditionField || 'audience.matchedRuleId', operator: 'eq', value: draft.audienceRuleId })
      if (draft.audienceAccountId) conditions.push({ field: 'audience.accountId', operator: 'eq', value: draft.audienceAccountId })
    } else if (draft.audienceSelection === 'legacy') {
      const legacy = sameTrigger ? savedRule.conditions.filter(condition => condition.field === 'user.effectiveLevel') : []
      conditions.push(...(legacy.length ? legacy.map((condition, index) =>
        index === 0 && typeof condition.value === 'number' ? { ...condition, value: draft.minLevel } : condition)
        : [{ field: 'user.effectiveLevel', operator: 'gte' as const, value: draft.minLevel }]))
    }
    if (draft.trigger === 'tiktok-gift') {
      try {
        conditions.push(...createGiftConditions(draft.giftId, draft.minGiftCount, draft.minGiftCoins))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '礼物条件无效')
        return null
      }
    }
    if (draft.trigger === 'webhook') {
      if (!draft.eventName.trim()) {
        toast.error('请输入 Webhook 事件名称')
        return null
      }
      if (draft.minAmount !== '') {
        const amount = Number(draft.minAmount)
        if (!Number.isFinite(amount) || amount < 0) {
          toast.error('最低金额必须是大于或等于 0 的数字')
          return null
        }
        conditions.push({ field: 'payload.amount', operator: 'gte', value: amount })
      }
    }
    if (
      draft.useObs &&
      (!draft.sceneName ||
        (draft.obsTargetMode === 'source' ? !draft.sourceName : !draft.groupName))
    ) {
      toast.error(`请先读取并选择 OBS ${draft.obsTargetMode === 'source' ? '来源' : '素材组'}`)
      return null
    }
    if (draft.useText && (!draft.textSourceName || !draft.textTemplate.trim())) {
      toast.error('请选择 OBS 文字来源并填写文字模板')
      return null
    }
    if (draft.useArtText && (!draft.artTextInputName || !draft.artTextTemplate.trim())) {
      toast.error('请选择艺术字浏览器来源并填写文字模板')
      return null
    }
    if (draft.useAi && (!draft.aiApiKey.trim() || !draft.aiModel.trim())) {
      toast.error('请填写 DeepSeek API Key 和模型')
      return null
    }
    if (draft.useSend && !draft.sendTemplate.trim()) {
      toast.error('请填写发送到公屏的文字模板')
      return null
    }

    const actions: HookAction[] = []
    let previousActionId: string | undefined
    const append = (action: HookAction, waitForDurationMs?: number) => {
      if (draft.executionMode === 'sequential' && previousActionId) {
        action.dependsOn = [previousActionId]
      }
      actions.push(action)
      previousActionId = action.id
      if (draft.executionMode === 'sequential' && waitForDurationMs && action.id) {
        const waitId = `${action.id}-complete`
        actions.push({
          id: waitId,
          type: 'delay',
          dependsOn: [action.id],
          durationMs: waitForDurationMs,
        })
        previousActionId = waitId
      }
    }
    if (draft.useObs) {
      append(
        draft.obsTargetMode === 'group-random'
          ? {
              id: 'obs-animation',
              type: 'obs.play-random-group',
              target: {
                sceneName: draft.sceneName,
                groupName: draft.groupName,
                groupContainerName: draft.groupContainerName,
                durationMs: draft.durationMs,
                avoidImmediateRepeat: draft.avoidImmediateRepeat,
              },
            }
          : {
              id: 'obs-animation',
              type: 'obs.show-source',
              target: {
                sceneName: draft.sceneName,
                sourceName: draft.sourceName,
                sourceContainerName: draft.sourceContainerName,
                durationMs: draft.durationMs,
              },
            },
        draft.durationMs,
      )
    }
    if (draft.useText) {
      append({
        id: 'obs-text',
        type: 'obs.set-text',
        inputName: draft.textSourceName,
        template: draft.textTemplate.trim(),
      })
    }
    if (draft.useArtText) {
      append({
        id: 'art-text',
        type: 'obs.art-text',
        inputName: draft.artTextInputName,
        template: draft.artTextTemplate.trim(),
        style: draft.artTextStyle,
        delivery: draft.artTextDelivery,
        holdMs: draft.artTextHoldMs,
        priority: draft.artTextPriority,
      })
    }
    if (draft.useAi) {
      append({
        id: 'ai-reply',
        type: 'ai.generate-text',
        provider: 'deepseek',
        model: draft.aiModel.trim(),
        apiKey: draft.aiApiKey.trim(),
        systemPrompt: draft.aiSystemPrompt.trim(),
        promptTemplate: draft.aiPromptTemplate.trim(),
      })
    }
    if (draft.useSend) {
      const sendAction: HookAction = {
        id: 'send-message',
        type: 'platform.send-message',
        template: draft.sendTemplate.trim(),
        requireMention: draft.sendTemplate.includes('{{user.mention}}'),
      }
      if (
        draft.executionMode === 'parallel' &&
        draft.useAi &&
        draft.sendTemplate.includes('{{actions.ai-reply.')
      ) {
        sendAction.dependsOn = ['ai-reply']
      }
      append(sendAction)
    }

    return preserveSavedGiftMetadata({
      id: draft.id || crypto.randomUUID(),
      name: draft.name.trim(),
      enabled: getDraftRuleEnabled(draft.id, settings.rules),
      cooldownMs: draft.cooldownMs,
      exclusiveGroup: sameTrigger ? savedRule.exclusiveGroup : undefined,
      priority: sameTrigger ? savedRule.priority : undefined,
      levelStrategy: draft.audienceSelection === 'legacy' ? draft.levelStrategy : sameTrigger ? savedRule.levelStrategy : undefined,
      ...createHookTrigger(draft.trigger),
      conditions,
      actions,
    }, settings.rules.find(rule => rule.id === draft.id))
  }

  const addRule = () => {
    const rule = buildRule()
    if (!rule) return
    setSettings(current => ({
      ...current,
      rules: [...current.rules.filter(item => item.id !== rule.id), rule],
    }))
    setDraft(emptyDraft)
    toast.success(draft.id ? '钩子已更新，请保存' : '钩子已添加，请保存')
  }

  const editRule = (rule: HookRule) => {
    const giftFilters = readGiftFilters(rule)
    const giftDefaults = rule.eventType === 'viewer.gift' ? giftTriggerDefaults() : undefined
    const level = rule.conditions.find(item => item.field === 'user.effectiveLevel')
    const audienceRule = rule.conditions.find(item => ['audience.matchedRuleId', 'audience.ruleId'].includes(item.field) && item.operator === 'eq')
    const audienceAccount = rule.conditions.find(item => item.field === 'audience.accountId' && item.operator === 'eq')
    const eventName = rule.conditions.find(item => item.field === 'eventName')
    const amount = rule.conditions.find(item => item.field === 'payload.amount')
    const sourceAction = rule.actions.find(action => action.type === 'obs.show-source')
    const groupAction = rule.actions.find(action => action.type === 'obs.play-random-group')
    const textAction = rule.actions.find(action => action.type === 'obs.set-text')
    const artTextAction = rule.actions.find(action => action.type === 'obs.art-text')
    const legacyText = sourceAction?.text
    const aiAction = rule.actions.find(action => action.type === 'ai.generate-text')
    const sendAction = rule.actions.find(action => action.type === 'platform.send-message')
    const target = sourceAction?.target
    const isSequential = rule.actions
      .slice(1)
      .every((action, index) => action.dependsOn?.[0] === rule.actions[index].id)
    setDraft({
      id: rule.id,
      name: rule.name,
      trigger: readHookTrigger(rule),
      minLevel: typeof level?.value === 'number' ? level.value : 0,
      audienceSelection: audienceRule ? 'rule' : level ? 'legacy' : 'all',
      audienceRuleId: typeof audienceRule?.value === 'string' ? audienceRule.value : '',
      audienceAccountId: typeof audienceAccount?.value === 'string' ? audienceAccount.value : undefined,
      audienceConditionField: audienceRule?.field as Draft['audienceConditionField'],
      cooldownMs: rule.cooldownMs ?? 0,
      levelStrategy: rule.levelStrategy || 'fan-club-first',
      eventName: typeof eventName?.value === 'string' ? eventName.value : 'order.paid',
      minAmount: typeof amount?.value === 'number' ? String(amount.value) : '',
      ...giftFilters,
      sceneName: target?.sceneName || groupAction?.target.sceneName || '',
      useObs: Boolean(sourceAction || groupAction),
      obsTargetMode: groupAction ? 'group-random' : 'source',
      sourceName: target?.sourceName || '',
      sourceContainerName: target?.sourceContainerName,
      groupName: groupAction?.target.groupName || '',
      groupContainerName: groupAction?.target.groupContainerName,
      avoidImmediateRepeat: groupAction?.target.avoidImmediateRepeat ?? true,
      durationMs: target?.durationMs || groupAction?.target.durationMs || 30_000,
      useText: Boolean(textAction || legacyText),
      useArtText: Boolean(artTextAction),
      artTextInputName: artTextAction?.inputName || '✨ 互动欢迎字',
      artTextTemplate: artTextAction?.template || giftDefaults?.artTextTemplate || '欢迎 {{user.screenName}}',
      artTextStyle: artTextAction?.style || 'rainbow',
      artTextDelivery: artTextAction?.delivery ?? 'queued',
      artTextHoldMs: artTextAction?.holdMs || 1800,
      artTextPriority: artTextAction?.priority || 0,
      textSourceName: textAction?.inputName || legacyText?.inputName || '',
      textTemplate: textAction?.template || legacyText?.template || giftDefaults?.textTemplate || '欢迎 {{user.name}} 进入直播间',
      useAi: Boolean(aiAction),
      aiApiKey: aiAction?.apiKey || '',
      aiModel: aiAction?.model || 'deepseek-flash',
      aiSystemPrompt: aiAction?.systemPrompt || '你是直播间助手。回复要自然、简短，不要编造信息。',
      aiPromptTemplate:
        aiAction?.promptTemplate || giftDefaults?.aiPromptTemplate || '请为刚刚关注直播间的 {{user.name}} 生成一句答谢语。',
      useSend: Boolean(sendAction),
      sendTemplate: sendAction?.template || giftDefaults?.sendTemplate || '{{actions.ai-reply.text}}',
      executionMode: isSequential ? 'sequential' : 'parallel',
    })
  }

  const save = async () => {
    setBusy('save')
    try {
      const response = await request({ action: 'save', settings })
      if (!response.ok) throw new Error(response.error)
      if (response.settings) setSettings(response.settings)
      if (response.webhookUrl) setWebhookUrl(response.webhookUrl)
      toast.success(response.message || '保存成功')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }

  const test = async (rule: HookRule) => {
    setBusy(rule.id)
    try {
      const response = await request({ action: 'test', rule })
      if (!response.ok) throw new Error(response.error)
      toast.success(response.message || '试播成功')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '试播失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>钩子设置</CardTitle>
          <CardDescription>事件满足条件后执行可配置动作，支持并行或顺序运行。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="钩子名称">
              <Input
                value={draft.name}
                onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
                placeholder="例如：高级用户欢迎动画"
              />
            </Field>
            <Field label="触发事件">
              <Select
                value={draft.trigger}
                onValueChange={(trigger: TriggerKind) => setDraft(current => ({
                  ...current,
                  trigger,
                  useObs: trigger === 'tiktok-follow',
                  useArtText: trigger.startsWith('tiktok'),
                  artTextTemplate: trigger === 'tiktok-follow'
                    ? '谢谢关注 {{user.screenName}}'
                    : trigger === 'tiktok-like'
                      ? '谢谢点赞 {{user.screenName}}'
                      : '欢迎 {{user.screenName}}',
                  artTextStyle: trigger === 'tiktok-like' ? 'gold' : 'rainbow',
                  artTextPriority: trigger === 'tiktok-follow' ? 100 : trigger === 'tiktok-like' ? 0 : 10,
                  useSend: trigger.startsWith('tiktok'),
                  sendTemplate: trigger === 'tiktok-like'
                    ? '{{user.mention}} 谢谢你的点赞！'
                    : trigger === 'tiktok-follow'
                      ? '{{user.mention}} 谢谢关注，欢迎常来！'
                      : '{{user.mention}} 欢迎来到直播间！',
                  cooldownMs: trigger === 'tiktok-like' ? 180_000 : 0,
                  ...(trigger === 'tiktok-gift' ? giftTriggerDefaults() : {}),
                }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tiktok">TikTok · 用户进入直播间</SelectItem>
                  <SelectItem value="tiktok-follow">TikTok · 关注主播</SelectItem>
                  <SelectItem value="tiktok-like">TikTok · 点赞</SelectItem>
                  <SelectItem value="tiktok-gift">TikTok · 送礼</SelectItem>
                  <SelectItem value="xiaohongshu">小红书 · 用户进入直播间</SelectItem>
                  <SelectItem value="xiaohongshu-follow">小红书 · 关注主播</SelectItem>
                  <SelectItem value="webhook">本机 Webhook</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {draft.trigger !== 'webhook' ? (
              <Field label="匹配观众规则">
                <Select
                  value={draft.audienceSelection === 'legacy' ? '__legacy__' : draft.audienceSelection === 'rule'
                    ? audienceRuleValue(draft.audienceAccountId || '__unbound__', draft.audienceRuleId) : '__all__'}
                  onValueChange={value => {
                    if (value === '__all__' || value === '__legacy__') {
                      setDraft(current => ({ ...current, audienceSelection: value === '__all__' ? 'all' : 'legacy' }))
                      return
                    }
                    const [selectedAccount, ruleId] = JSON.parse(value.slice(5)) as [string, string]
                    setDraft(current => ({ ...current, audienceSelection: 'rule', audienceRuleId: ruleId, audienceAccountId: selectedAccount, audienceConditionField: 'audience.matchedRuleId' }))
                  }}
                >
                  <SelectTrigger aria-label="匹配观众规则"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">所有观众</SelectItem>
                    {draft.audienceSelection === 'legacy' ? <SelectItem value="__legacy__">原等级条件（保留已有规则）</SelectItem> : null}
                    {draft.audienceSelection === 'rule' && (!draft.audienceAccountId || draft.audienceAccountId !== accountId || !audiencePolicy?.rules.some(rule => rule.id === draft.audienceRuleId)) ? (
                      <SelectItem value={audienceRuleValue(draft.audienceAccountId || '__unbound__', draft.audienceRuleId)} disabled>
                        {!draft.audienceAccountId ? '观众规则未绑定账号' : draft.audienceAccountId !== accountId ? '其他账号的观众规则' : '观众规则不可用（已删除或未读取）'} · {draft.audienceRuleId}
                      </SelectItem>
                    ) : null}
                    {audiencePolicy?.rules.map(rule => (
                      <SelectItem key={rule.id} value={audienceRuleValue(accountId, rule.id)} disabled={!audiencePolicy.enabled || !rule.enabled}>
                        {rule.label} · {rule.result.label}{!rule.enabled ? '（已停用）' : !audiencePolicy.enabled ? '（策略已暂停）' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">直接使用当前账号保存的观众规则；修改规则名称或结果标签后仍保持关联。</p>
                {audiencePolicyError ? <p role="status" className="text-xs text-destructive">{audiencePolicyError}；原关联仍保留。</p> : null}
                {draft.audienceSelection === 'rule' && (!audiencePolicy?.enabled || !draft.audienceAccountId || draft.audienceAccountId !== accountId || !audiencePolicy.rules.some(rule => rule.id === draft.audienceRuleId && rule.enabled)) ? (
                  <p role="status" className="text-xs text-destructive">此关联当前不可用，原规则 ID 已保留；停用、删除或其他账号的规则不会触发。</p>
                ) : null}
                <Button type="button" variant="outline" size="sm" onClick={() => setPolicyRefresh(value => value + 1)}>刷新观众规则</Button>
              </Field>
            ) : null}
            {draft.trigger === 'tiktok' && draft.audienceSelection === 'legacy' ? (
              <>
                <Field label="等级选择规则">
                  <Select
                    value={draft.levelStrategy}
                    onValueChange={(levelStrategy: TikTokLevelStrategy) =>
                      setDraft(current => ({ ...current, levelStrategy }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fan-club-first">粉丝团等级优先</SelectItem>
                      <SelectItem value="gift-first">账号/送礼等级优先</SelectItem>
                      <SelectItem value="highest">取两个等级中的最高值</SelectItem>
                      <SelectItem value="fan-club-only">仅使用粉丝团等级</SelectItem>
                      <SelectItem value="gift-only">仅使用账号/送礼等级</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="最低等级">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.minLevel}
                    onChange={event =>
                      setDraft(current => ({ ...current, minLevel: Number(event.target.value) }))
                    }
                  />
                </Field>
              </>
            ) : draft.trigger === 'tiktok-gift' ? (
              <>
                <GiftCoinField
                  value={draft.minGiftCoins}
                  onValueChange={minGiftCoins => setDraft(current => ({ ...current, minGiftCoins }))}
                />
                <Field label="礼物 ID（可选）">
                  <Input
                    value={draft.giftId}
                    onChange={event =>
                      setDraft(current => ({ ...current, giftId: event.target.value }))
                    }
                    placeholder="例如：5655（Rose）；留空表示任意礼物"
                  />
                </Field>
                <Field label="最低礼物数量（最终 repeat_count）">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.minGiftCount}
                    onChange={event =>
                      setDraft(current => ({ ...current, minGiftCount: event.target.value }))
                    }
                  />
                </Field>
              </>
            ) : draft.trigger === 'webhook' ? (
              <>
                <Field label="Webhook 事件名称">
                  <Input
                    value={draft.eventName}
                    onChange={event =>
                      setDraft(current => ({ ...current, eventName: event.target.value }))
                    }
                    placeholder="order.paid"
                  />
                </Field>
                <Field label="最低金额（可选，对应 payload.amount）">
                  <Input
                    type="number"
                    min={0}
                    value={draft.minAmount}
                    onChange={event =>
                      setDraft(current => ({ ...current, minAmount: event.target.value }))
                    }
                    placeholder="留空表示不限制"
                  />
                </Field>
              </>
            ) : null}
            {draft.trigger.startsWith('tiktok') ? (
              <Field label="同一观众冷却时间（秒）">
                <Input type="number" min={0} max={86400} value={draft.cooldownMs / 1000}
                  onChange={event => setDraft(current => ({ ...current, cooldownMs: Number(event.target.value) * 1000 }))} />
              </Field>
            ) : null}
            <Field label="Webhook 端口">
              <Input
                type="number"
                min={1024}
                max={65535}
                value={settings.webhookPort}
                onChange={event =>
                  setSettings(current => ({
                    ...current,
                    webhookPort: Number(event.target.value),
                  }))
                }
              />
            </Field>
          </div>
          {draft.trigger === 'tiktok' && draft.audienceSelection === 'legacy' ? (
            <p className="text-sm text-muted-foreground">
              每条钩子独立选择发生等级冲突时使用哪个等级；“账号/送礼等级”来自 TikTok LIVE 的
              payGrade。
            </p>
          ) : draft.trigger === 'tiktok-gift' ? (
            <p className="text-sm text-muted-foreground">
              连送过程全部记录，结束后只触发一次。礼物数量采用最终累计 repeat_count，不累加过程数量；日志可审计。
              总金币为单价 × 同一组连送最终数量，每组计算，不累加整场。多个金币档规则只执行匹配门槛最高的一档；
              通用送礼规则作兜底，匹配金币档时不会同时执行通用规则。未知币值不进入金币价值档。
              最低总金币数留空可保留通用规则，礼物 ID 可留空。
              例如 Rose 最终数量为 3 时，屏幕模板可显示“谢谢 Alice 的 Rose ×3”。公屏发送需手动启用动作。
            </p>
          ) : draft.trigger === 'webhook' ? (
            <div className="rounded-md bg-muted p-3 font-mono text-sm">
              POST {webhookUrl.replace('{事件名称}', draft.eventName || '{事件名称}')}
              <br />
              JSON 示例：{'{"amount": 199, "orderId": "A001"}'}
            </div>
          ) : draft.trigger.startsWith('tiktok') ? (
            <p className="text-sm text-muted-foreground">按事件发生时当前账号的观众规则匹配；未达到门槛或字段未知时不会命中所选规则。</p>
          ) : draft.trigger === 'xiaohongshu-follow' ? (
            <p className="text-sm text-muted-foreground">
              使用千帆直播 WebSocket 的 follow_emcee 事件，可读取关注用户昵称、ID 和关注状态。
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              已通过千帆直播 WebSocket 的 audience_join_v2 事件确认，可读取用户
              ID、昵称、关注状态和角色。
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>动作组合</CardTitle>
          <CardDescription>
            每个动作都可选；并行模式会同时启动，顺序模式会按下方顺序逐个执行。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="执行方式">
              <Select
                value={draft.executionMode}
                onValueChange={(executionMode: ExecutionMode) =>
                  setDraft(current => ({ ...current, executionMode }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="parallel">尽可能并行</SelectItem>
                  <SelectItem value="sequential">按下方顺序执行</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button variant="outline" onClick={() => void discoverObs()} disabled={busy !== null}>
                {busy === 'discover' ? '读取中...' : '读取 OBS 场景、来源和素材组'}
              </Button>
            </div>
          </div>

          <ActionSection
            title="1. OBS 动画"
            description="可显示单个来源，或直接从 OBS 素材组中随机选择一个来源。"
            enabled={draft.useObs}
            onEnabledChange={useObs => setDraft(current => ({ ...current, useObs }))}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="播放方式">
                <Select
                  value={draft.obsTargetMode}
                  onValueChange={(obsTargetMode: ObsTargetMode) =>
                    setDraft(current => ({ ...current, obsTargetMode }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="group-random">从 OBS 素材组随机播放</SelectItem>
                    <SelectItem value="source">显示单个 OBS 来源</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="场景">
                <Select
                  value={draft.sceneName}
                  onValueChange={sceneName => {
                    const scene = scenes.find(item => item.name === sceneName)
                    const source = scene?.sources.find(item => !item.isGroup)
                    const group = scene?.sources.find(item => item.isGroup)
                    setDraft(current => ({
                      ...current,
                      sceneName,
                      sourceName: source?.name || '',
                      sourceContainerName: source?.containerName,
                      groupName: group?.name || '',
                      groupContainerName: group?.containerName,
                      textSourceName: '',
                    }))
                  }}
                  disabled={!scenes.length}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="请先读取 OBS" />
                  </SelectTrigger>
                  <SelectContent>
                    {scenes.map(scene => (
                      <SelectItem key={scene.name} value={scene.name}>
                        {scene.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {draft.obsTargetMode === 'group-random' ? (
                <Field label="OBS 素材组">
                  <Select
                    value={selectedGroupKey}
                    onValueChange={value => {
                      const [groupContainerName, groupName] = JSON.parse(value) as [string, string]
                      setDraft(current => ({ ...current, groupName, groupContainerName }))
                    }}
                    disabled={!selectedScene?.sources.some(source => source.isGroup)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择 OBS 组" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedScene?.sources
                        .filter(source => source.isGroup)
                        .map(group => (
                          <SelectItem
                            key={`${group.containerName}:${group.name}`}
                            value={JSON.stringify([group.containerName, group.name])}
                          >
                            {group.path}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field label="OBS 来源">
                  <Select
                    value={selectedSourceKey}
                    onValueChange={value => {
                      const [sourceContainerName, sourceName] = JSON.parse(value) as [
                        string,
                        string,
                      ]
                      setDraft(current => ({ ...current, sourceName, sourceContainerName }))
                    }}
                    disabled={!selectedScene?.sources.some(source => !source.isGroup)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择来源" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedScene?.sources
                        .filter(source => !source.isGroup)
                        .map(source => (
                          <SelectItem
                            key={`${source.containerName}:${source.name}`}
                            value={JSON.stringify([source.containerName, source.name])}
                          >
                            {source.path}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label={draft.obsTargetMode === 'group-random' ? '最长播放时间（毫秒，视频结束会提前隐藏）' : '显示时长（毫秒）'}>
                <Input
                  type="number"
                  min={100}
                  max={600000}
                  step={100}
                  value={draft.durationMs}
                  onChange={event =>
                    setDraft(current => ({ ...current, durationMs: Number(event.target.value) }))
                  }
                />
              </Field>
              {draft.obsTargetMode === 'group-random' && (
                <div className="flex items-center gap-3 text-sm">
                  <Switch
                    checked={draft.avoidImmediateRepeat}
                    onCheckedChange={avoidImmediateRepeat =>
                      setDraft(current => ({ ...current, avoidImmediateRepeat }))
                    }
                  />
                  避免连续两次播放同一素材
                </div>
              )}
            </div>
          </ActionSection>

          <ActionSection
            title="2. OBS 艺术字"
            description="用独立的浏览器来源显示观众名字，不同来源可同时显示。"
            enabled={draft.useArtText}
            onEnabledChange={useArtText => setDraft(current => ({ ...current, useArtText }))}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="艺术字浏览器来源">
                <Select value={draft.artTextInputName}
                  onValueChange={artTextInputName => setDraft(current => ({ ...current, artTextInputName }))}>
                  <SelectTrigger><SelectValue placeholder="请选择 OBS 来源" /></SelectTrigger>
                  <SelectContent>
                    {selectedScene?.sources.filter(source => !source.isGroup).map(source => (
                      <SelectItem key={`art:${source.containerName}:${source.name}`} value={source.name}>{source.path}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="屏幕文字模板">
                <Input value={draft.artTextTemplate}
                  onChange={event => setDraft(current => ({ ...current, artTextTemplate: event.target.value }))}
                  placeholder="欢迎 {{user.screenName}}" />
              </Field>
              <Field label="文字样式">
                <Select value={draft.artTextStyle}
                  onValueChange={(artTextStyle: Draft['artTextStyle']) => setDraft(current => ({ ...current, artTextStyle }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rainbow">彩虹字</SelectItem>
                    <SelectItem value="gold">金色字</SelectItem>
                    <SelectItem value="arc">彩虹拱形</SelectItem>
                    <SelectItem value="random">随机</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="显示方式">
                <Select value={draft.artTextDelivery}
                  onValueChange={(artTextDelivery: Draft['artTextDelivery']) => setDraft(current => ({ ...current, artTextDelivery }))}>
                  <SelectTrigger aria-label="艺术字显示方式"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">立即显示</SelectItem>
                    <SelectItem value="queued">逐条排队</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  立即显示会用新文字更新同一来源；逐条排队会等上一条显示完毕。
                </p>
              </Field>
              <Field label="停留时间（毫秒）">
                <Input type="number" min={500} max={10000} step={100} value={draft.artTextHoldMs}
                  onChange={event => setDraft(current => ({ ...current, artTextHoldMs: Number(event.target.value) }))} />
              </Field>
              <Field label="排队优先级（0–100）">
                <Input type="number" min={0} max={100} step={1} value={draft.artTextPriority} disabled={draft.artTextDelivery === 'immediate'}
                  onChange={event => setDraft(current => ({ ...current, artTextPriority: Number(event.target.value) }))} />
              </Field>
            </div>
          </ActionSection>

          <ActionSection
            title="3. OBS 文字"
            description="只修改文字也可以，不要求同时播放动画。"
            enabled={draft.useText}
            onEnabledChange={useText => setDraft(current => ({ ...current, useText }))}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="文字来源">
                <Select
                  value={draft.textSourceName}
                  onValueChange={textSourceName =>
                    setDraft(current => ({ ...current, textSourceName }))
                  }
                  disabled={!selectedScene?.sources.length}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="请选择 OBS 文字来源" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedScene?.sources
                      .filter(source => !source.isGroup)
                      .map(source => (
                        <SelectItem
                          key={`text:${source.containerName}:${source.name}`}
                          value={source.name}
                        >
                          {source.path}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="文字模板">
                <Input
                  value={draft.textTemplate}
                  onChange={event =>
                    setDraft(current => ({ ...current, textTemplate: event.target.value }))
                  }
                  placeholder="欢迎 {{user.name}} 进入直播间"
                />
              </Field>
            </div>
          </ActionSection>

          <ActionSection
            title="4. DeepSeek 生成文字"
            description="根据事件元数据和直播规则生成简短回复。"
            enabled={draft.useAi}
            onEnabledChange={useAi => setDraft(current => ({ ...current, useAi }))}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="API Key">
                <Input
                  type="password"
                  value={draft.aiApiKey}
                  onChange={event =>
                    setDraft(current => ({ ...current, aiApiKey: event.target.value }))
                  }
                  placeholder="DeepSeek API Key"
                />
              </Field>
              <Field label="模型">
                <Input
                  value={draft.aiModel}
                  onChange={event =>
                    setDraft(current => ({ ...current, aiModel: event.target.value }))
                  }
                  placeholder="deepseek-flash"
                />
              </Field>
              <Field label="直播规则 / 系统提示词">
                <Input
                  value={draft.aiSystemPrompt}
                  onChange={event =>
                    setDraft(current => ({ ...current, aiSystemPrompt: event.target.value }))
                  }
                />
              </Field>
              <Field label="事件提示词">
                <Input
                  value={draft.aiPromptTemplate}
                  onChange={event =>
                    setDraft(current => ({ ...current, aiPromptTemplate: event.target.value }))
                  }
                />
              </Field>
            </div>
          </ActionSection>

          <ActionSection
            title="5. 发送到公屏"
            description="直播事件会回复到触发该事件的账号；手动试播不会真实发送。"
            enabled={draft.useSend}
            onEnabledChange={useSend => setDraft(current => ({ ...current, useSend }))}
          >
            <Field label="发送内容模板">
              <Input
                value={draft.sendTemplate}
                onChange={event =>
                  setDraft(current => ({ ...current, sendTemplate: event.target.value }))
                }
                placeholder="{{actions.ai-reply.text}}"
              />
            </Field>
          </ActionSection>

          <p className="text-sm text-muted-foreground">
            变量：{'{{user.name}}'}、{'{{user.screenName}}'}、{'{{user.mention}}'}、{'{{user.id}}'}、{'{{room.id}}'}、{'{{gift.name}}'}、{'{{gift.count}}'}、{'{{gift.id}}'}、{'{{gift.unitCoins}}'}、{'{{gift.totalCoins}}'}、{'{{payload.amount}}'}；
            DeepSeek 输出：{'{{actions.ai-reply.text}}'}。即使选择并行，引用 AI
            输出的公屏动作也会自动等待 AI 完成。
          </p>
          <div className="flex gap-2">
            <Button onClick={addRule}>{draft.id ? '更新钩子' : '添加钩子'}</Button>
            {draft.id && (
              <Button variant="outline" onClick={() => setDraft(emptyDraft)}>
                取消编辑
              </Button>
            )}
            <Button variant="outline" onClick={() => void save()} disabled={busy !== null}>
              {busy === 'save' ? '保存中...' : '保存全部钩子'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已配置钩子（{settings.rules.length}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.rules.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              暂无钩子，请在上方配置触发条件和 OBS 动作。
            </div>
          ) : (
            settings.rules.map(rule => (
              <div
                key={rule.id}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="font-medium">{rule.name}</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {describeRule(rule, audiencePolicy, accountId)} → {rule.actions.map(describeAction).join('、')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={enabled =>
                      setSettings(current => ({
                        ...current,
                        rules: current.rules.map(item =>
                          item.id === rule.id ? { ...item, enabled } : item,
                        ),
                      }))
                    }
                    aria-label={`启用钩子 ${rule.name}`}
                  />
                  <Button variant="outline" size="sm" onClick={() => void test(rule)}>
                    {busy === rule.id ? '试播中' : '试播'}
                  </Button>
                  <Button variant="outline" size="icon" onClick={() => editRule(rule)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      setSettings(current => ({
                        ...current,
                        rules: current.rules.filter(item => item.id !== rule.id),
                      }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function audienceRuleValue(accountId: string, ruleId: string) {
  return `rule:${JSON.stringify([accountId, ruleId])}`
}

export function describeRule(rule: HookRule, policy?: AssistantAudiencePolicy, accountId?: string) {
  const linked = rule.conditions.find(condition => ['audience.matchedRuleId', 'audience.ruleId'].includes(condition.field) && condition.operator === 'eq')
  const linkedAccount = rule.conditions.find(condition => condition.field === 'audience.accountId' && condition.operator === 'eq')
  const currentRule = linkedAccount && linkedAccount.value === accountId ? policy?.rules.find(item => item.id === linked?.value) : undefined
  const audienceSuffix = linked ? currentRule
    ? ` · 观众规则 ${currentRule.label} · ${currentRule.result.label}${!currentRule.enabled || !policy?.enabled ? '（已停用）' : ''}`
    : ` · 观众规则不可用（${String(linked.value)}）` : ''
  if (rule.source === 'tiktok') {
    if (rule.eventType === 'viewer.gift') {
      const { giftId, minGiftCount, minGiftCoins } = readGiftFilters(rule)
      return `TikTok 送礼 · ${giftId ? `礼物 ID ${giftId}` : '任意礼物'} · 数量 ${minGiftCount} 起${minGiftCoins ? ` · 总金币 ${minGiftCoins} 起` : ''}${audienceSuffix}`
    }
    if (rule.eventType === 'viewer.follow') return `TikTok 用户关注主播${audienceSuffix}`
    if (rule.eventType === 'viewer.like') return `TikTok 用户点赞${audienceSuffix}`
    const level = rule.conditions.find(item => item.field === 'user.effectiveLevel')?.value
    return `TikTok 用户进入${level === undefined ? audienceSuffix || ' · 所有观众' : ` · ${describeLevelStrategy(rule.levelStrategy)} · 等级 ${String(level)} 起${audienceSuffix}`}`
  }
  if (rule.source === 'xiaohongshu') {
    return `${rule.eventType === 'viewer.follow' ? '小红书用户关注主播' : '小红书用户进入直播间'}${audienceSuffix}`
  }
  const eventName = rule.conditions.find(item => item.field === 'eventName')?.value
  const amount = rule.conditions.find(item => item.field === 'payload.amount')?.value
  return `Webhook · ${String(eventName || '')}${amount === undefined ? '' : ` · 金额 ${String(amount)} 起`}`
}

export function GiftCoinField({
  value,
  onValueChange,
}: {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <Field label="最低总金币数（可选）">
      <Input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={event => onValueChange(event.target.value)}
        placeholder="100"
      />
    </Field>
  )
}

function describeLevelStrategy(strategy: TikTokLevelStrategy | undefined) {
  switch (strategy) {
    case 'gift-first':
      return '账号/送礼等级优先'
    case 'highest':
      return '取最高等级'
    case 'fan-club-only':
      return '仅粉丝团等级'
    case 'gift-only':
      return '仅账号/送礼等级'
    default:
      return '粉丝团等级优先'
  }
}

function describeAction(action: HookAction) {
  switch (action.type) {
    case 'obs.show-source':
      return `OBS 来源 ${action.target.sourceName}`
    case 'obs.play-random-group':
      return `OBS 素材组 ${action.target.groupName}`
    case 'obs.set-text':
      return `OBS 文字 ${action.inputName}`
    case 'obs.art-text':
      return `OBS 艺术字 ${action.inputName} · ${action.delivery === 'immediate' ? '立即显示' : '逐条排队'}`
    case 'ai.generate-text':
      return `DeepSeek ${action.model}`
    case 'platform.send-message':
      return '发送公屏'
    case 'delay':
      return `等待 ${action.durationMs}ms`
  }
}

function ActionSection({
  title,
  description,
  enabled,
  onEnabledChange,
  children,
}: {
  title: string
  description: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      {enabled && children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function request(command: HookCommand) {
  return window.ipcRenderer.invoke(IPC_CHANNELS.hooks.request, command)
}
