import { Check, Languages, LoaderCircle, Pin, RotateCcw, Send, Sparkles, X } from 'lucide-react'
import { type CSSProperties, useContext, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type {
  AssistantDeskCommand,
  AssistantDeskResult,
  AssistantDeskState,
} from '../../../shared/assistantDesk'
import { type AudienceCountryTagResult } from '../../../shared/assistantAudiencePolicy'
import {
  annotateAssistantEmoji,
  ASSISTANT_EMOJI_CONTEXT_NOTE,
} from '../../../shared/assistantEmojiMeaning'
import { AudienceCountryEditor, AudienceLanguageBadge, AudienceTriageBadges } from './AudiencePolicyPanel'
import { FlagText } from './FlagText'
import { assistantReplyEligible, resolveAssistantReplyRule } from '../../../shared/assistantReplyPolicy'
import { ASSISTANT_MESSAGE_LANGUAGES, normalizeMessageLanguage } from '../../../shared/assistantLanguageCatalog'
import { ReplyPolicyContext } from './ReplyPolicyPanel'
import { VoiceDraftInput } from './VoiceDraftInput'
import { actionEventFact, assistantKindLabels, displayLanguage, displayRuleColor, displayTime, paymentTier } from './presentation'

type Row = AssistantDeskState['rows'][number]
const translationIdentityFields = ['id', 'accountId', 'sessionId', 'platform', 'receivedAt', 'sourceEventId', 'userId', 'audienceUuid', 'kind', 'original'] as const
export type DeskRequest = (command: AssistantDeskCommand) => Promise<AssistantDeskResult>
export interface ManualTranslationContext {
  sessionId?: string
  maxAgeSeconds: number
  ai: Pick<AssistantDeskState['ai'], 'used' | 'limit' | 'pauseReason'>
  busy: boolean
}
const nicknameSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const compactEmojiName = (name: string) =>
  name.startsWith('家庭:')
    ? '家庭'
    : name.replace(/:\s*(?:浅|中等偏浅|中等|中等偏深|深)肤色$/, '')

const replyLabels: Record<Row['reply']['status'], string> = {
  none: '暂无回复',
  queued: '回复排队中',
  generating: '正在生成回复',
  review: '等待确认',
  sending: '正在发送',
  sent: '已发送',
  failed: '发送失败',
  dismissed: '已忽略',
  interrupted: '处理已中断',
}
const kindLabels = assistantKindLabels
const replyLanguageSourceLabels = { manual: '人工选择', observed: '按发言', 'recent-viewer-comment': '参考同场发言', 'nickname-hint': '参考昵称·推测', 'default-english': '默认英语' }

export function AssistantMessageCard({
  row,
  busy,
  request,
  interactive = true,
  pinned = false,
  onPin,
  attentionSession,
  attentionActions = false,
  archivePin = false,
  pinLabel = '留待处理',
  manualTranslation,
  manualTranslationActions = interactive,
  manualTranslationUpdate,
}: {
  row: Row
  busy: boolean
  request: DeskRequest
  interactive?: boolean
  pinned?: boolean
  onPin?: (row: Row) => void
  attentionSession?: { id?: string; maxAgeSeconds: number }
  attentionActions?: boolean
  archivePin?: boolean
  pinLabel?: string
  manualTranslation?: ManualTranslationContext
  manualTranslationActions?: boolean
  manualTranslationUpdate?: Row
}) {
  const [confirmedCountry, setConfirmedCountry] = useState<AudienceCountryTagResult>()
  const [edit, setEdit] = useState<{ owner: string; chinese: string }>()
  const [translating, setTranslating] = useState(false)
  const translationPending = useRef(false)
  const editRevision = useRef(0)
  const [translationNotice, setTranslationNotice] = useState<{ error: boolean; text: string }>()
  const owner = `${row.accountId}:${row.id}`
  const replyControl = useContext(ReplyPolicyContext)
  const eligibleReply = assistantReplyEligible(row)
  const [generating, setGenerating] = useState(false)
  const generationPending = useRef(false)
  const [generationError, setGenerationError] = useState('')
  const automaticTargetLanguage = normalizeMessageLanguage(row.replyLanguageHint?.language) ??
    normalizeMessageLanguage(row.translation.language) ??
    (row.kind !== 'comment' ? normalizeMessageLanguage(row.reply.targetLanguage) : undefined) ?? 'en'
  const suggestionSource = row.replyLanguageHint?.source ?? (normalizeMessageLanguage(row.translation.language) ? 'observed' : 'default-english')
  const suggestionLabel = replyLanguageSourceLabels[suggestionSource]
  const [selectedLanguage, setSelectedLanguage] = useState<{ owner: string; language: string; needsPreview: boolean }>()
  const [translatedLanguage, setTranslatedLanguage] = useState<{ owner: string; language: string }>()
  const manualTargetLanguage = selectedLanguage?.owner === owner ? selectedLanguage.language : ''
  const targetLanguage = manualTargetLanguage || automaticTargetLanguage
  const languageChanged = selectedLanguage?.owner === owner && selectedLanguage.needsPreview
  const previewLanguage = translatedLanguage?.owner === owner ? translatedLanguage.language :
    normalizeMessageLanguage(row.reply.targetLanguage) ?? normalizeMessageLanguage(row.translation.language) ?? automaticTargetLanguage
  const retryPending = useRef(false)
  const localIdentity = JSON.stringify(translationIdentityFields.map(key => row[key]))
  const [retry, setRetry] = useState<{
    identity: string
    baseline: string
    pending: boolean
    translation: Row['translation']
    error?: string
  }>()
  const currentRetry = retry?.identity === localIdentity ? retry : undefined
  const [retainedLocal, setRetainedLocal] = useState<{
    identity: string
    value: Pick<Row, 'translation' | 'ai'>
  }>()
  const retained = row.translation.source === 'local' && retainedLocal?.identity === localIdentity ? retainedLocal.value : undefined
  const localBase = retained ?? row
  const matchingUpdate = manualTranslationUpdate &&
    translationIdentityFields.every(key => manualTranslationUpdate[key] === row[key])
  const candidate = row.translation.source === 'local' && matchingUpdate ? manualTranslationUpdate : undefined
  const acceptCandidate = candidate && (
    (candidate.translation.source === 'ai' &&
      (localBase.translation.source !== 'ai' || localBase.translation.status !== 'ready' ||
        candidate.translation.status === 'ready' || !!currentRetry?.pending)) ||
    (candidate.translation.source === 'local' &&
      ((!!candidate.translation.manualAttempt &&
        (localBase.translation.source !== 'ai' || localBase.translation.status !== 'ready' || !!currentRetry?.pending)) ||
        (localBase.translation.source !== 'ai' &&
          (candidate.translation.status === 'interrupted' || !['ready', 'interrupted'].includes(localBase.translation.status)))))
  )
  const localUpdate = acceptCandidate ? candidate : localBase
  if (row.translation.source === 'local' &&
    (localUpdate.translation !== row.translation || localUpdate.ai !== row.ai) &&
    (!retained || retained.translation !== localUpdate.translation || retained.ai !== localUpdate.ai)) {
    // Retain only enrichment: timeline membership, original fields and reading position still use row.
    setRetainedLocal({ identity: localIdentity, value: { translation: localUpdate.translation, ai: localUpdate.ai } })
  } else if (retainedLocal && (retainedLocal.identity !== localIdentity || row.translation.source !== 'local')) {
    setRetainedLocal(undefined)
  }
  const translationUpdate = currentRetry && row.translation.source !== 'local'
    ? (matchingUpdate ? manualTranslationUpdate : row)
    : localUpdate
  const translationRevision = JSON.stringify([translationUpdate.translation, translationUpdate.ai?.requestedAt, translationUpdate.ai?.completedAt])
  const translation =
    currentRetry && (currentRetry.pending || currentRetry.baseline === translationRevision)
      ? currentRetry.translation
      : translationUpdate.translation
  const visibleTranslation = translation.status === 'pending' && translation.fallback
    ? { status: 'ready' as const, ...translation.fallback }
    : translation
  const retainedOriginal = translation.status === 'skipped' && translation.source === 'ai' && translation.language === 'und'
  const originalLanguage = (row.translation.source === 'local' ? translation.language : row.translation.language) ?? translation.fallback?.language
  const retryUnavailable = manualTranslation
    ? !manualTranslation.sessionId || row.sessionId !== manualTranslation.sessionId
      ? '场次已结束'
      : ['sent', 'dismissed'].includes(row.reply.status)
        ? '消息已处理'
        : manualTranslation.ai.used >= manualTranslation.ai.limit || manualTranslation.ai.pauseReason === 'request-limit'
          ? 'AI 请求已到上限'
          : manualTranslation.ai.pauseReason === 'storage-error'
            ? '存档暂不可用'
            : manualTranslation.busy || ['queued', 'generating', 'sending'].includes(row.reply.status)
              ? '当前消息正在处理'
              : undefined
    : busy ? '当前消息正在处理' : undefined
  const retryCommentTranslation = async () => {
    if (retryPending.current || retryUnavailable || translation.status === 'pending') return
    retryPending.current = true
    const baseline = translationRevision
    const fallback = translation.status === 'ready' && ['local', 'browser'].includes(translation.source ?? '') && translation.chinese?.trim()
      ? { source: translation.source as 'local' | 'browser', method: translation.method, language: translation.language, chinese: translation.chinese }
      : translation.fallback
    setRetry({ identity: localIdentity, baseline, pending: true, translation: { status: 'pending', source: 'ai', language: translation.language, ...(fallback ? { fallback } : {}) } })
    try {
      const result = await request({ action: 'translate-retry', params: { accountId: row.accountId, rowId: row.id } })
      const data = result.ok ? result.data as Row | undefined : undefined
      const returned = data && translationIdentityFields.every(key => data[key] === row[key]) ? data : undefined
      if (row.translation.source === 'local' && returned &&
        (returned.translation.source === 'ai' || !!returned.translation.manualAttempt) &&
        returned.translation.status !== 'pending') {
        // Exact final manual responses remain authoritative even after both bounded snapshots omit this row.
        setRetainedLocal({ identity: localIdentity, value: { translation: returned.translation, ai: returned.ai } })
      }
      setRetry({
        identity: localIdentity, baseline, pending: false,
        translation: returned?.translation ?? translation,
        error: result.ok ? undefined : result.error.message,
      })
    } catch {
      setRetry({ identity: localIdentity, baseline, pending: false, translation, error: '翻译请求失败，请重试；原文已保留' })
    } finally {
      retryPending.current = false
    }
  }
  const serverText = row.reply.text ?? ''
  const serverChinese = row.reply.chinese ?? ''
  const draft = edit?.owner === owner ? edit.chinese : serverChinese
  const dirty = draft !== serverChinese
  const draftTranslation = row.reply.draftTranslation
  const previewStale =
    dirty ||
    translating ||
    languageChanged ||
    targetLanguage !== previewLanguage ||
    !serverChinese.trim() ||
    !serverText.trim() ||
    draftTranslation?.status === 'pending' ||
    draftTranslation?.status === 'failed'
  const editable =
    interactive && attentionActions && (row.kind === 'comment' || eligibleReply) &&
    (row.kind === 'comment' || replyControl.policy?.enabled || !!row.reply.chinese || !!row.reply.text) &&
    (row.reply.status === 'review' ||
      row.reply.status === 'failed' ||
      row.reply.status === 'none' ||
      (pinned && ['none', 'interrupted'].includes(row.reply.status)))
  const waiting = ['queued', 'generating', 'sending'].includes(row.reply.status)
  const pinUnavailable =
    !pinned && attentionSession
      ? !attentionSession.id || row.sessionId !== attentionSession.id
        ? '场次已结束'
        : undefined
      : undefined
  const recipient = Array.from(row.mentionHandle ?? row.nickname)
    .filter(
      character =>
        character !== '@' && character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
    .join('')
    .trim()
    .slice(0, 100)
  const replyLabel =
    row.reply.status === 'failed' && !row.reply.requestId
      ? '回复处理失败'
      : replyLabels[row.reply.status]
  const params = { accountId: row.accountId, rowId: row.id }
  const replyRule = replyControl.policy && resolveAssistantReplyRule(replyControl.policy, row.kind, { tier: row.triage?.tier ?? 'neutral', matchedRuleId: row.triage?.matchedRuleId })
  const generationUnavailable = !replyControl.policy?.enabled ? '请先启用 AI 回复规则'
    : !replyRule || replyRule.mode === 'off' ? '此动作没有启用的回复规则'
      : replyControl.ai?.used !== undefined && replyControl.ai.used >= replyControl.ai.limit ? 'AI 请求已到上限'
        : replyControl.ai?.paused ? 'AI 已暂停'
          : busy || waiting || generating || translating ? '当前消息正在处理'
            : dirty ? '请先更新当前中文草稿的发送预览' : undefined
  const generateReply = async () => {
    if (generationPending.current || generationUnavailable) return
    generationPending.current = true; setGenerating(true); setGenerationError('')
    try {
      const result = await request({ action: 'reply-generate', params: { ...params, requestId: crypto.randomUUID() } })
      if (!result.ok) setGenerationError(result.error.message)
    } catch { setGenerationError('生成回复失败；原事件与中文草稿已保留，请重试') }
    finally { generationPending.current = false; setGenerating(false) }
  }
  const triage = row.triage
  const ruleColor = displayRuleColor(triage?.cardColor)
  const actionFact = actionEventFact(row)
  const emojiAnnotations =
    row.kind === 'comment' ? (row.emojiAnnotations ?? annotateAssistantEmoji(row.original)) : []
  const confirmedRegion =
    confirmedCountry && triage && confirmedCountry.revision >= triage.country.tagRevision
      ? confirmedCountry.tag
        ? {
            ...triage.country,
            code: confirmedCountry.tag.countryCode,
            source: 'manual' as const,
            manualTag: confirmedCountry.tag,
            tagRevision: confirmedCountry.revision,
          }
        : confirmedCountry.revision === triage.country.tagRevision
          ? triage.country
          : {
              code: undefined,
              source: 'unknown' as const,
              evidenceStrength: 0,
              evidence: [],
              uncertainties: ['manual-tag-not-set'],
              tagRevision: confirmedCountry.revision,
            }
      : undefined
  const translate = async () => {
    if (translationPending.current || busy || !draft.trim()) return
    translationPending.current = true
    setTranslating(true)
    setTranslationNotice(undefined)
    const submittedRevision = editRevision.current
    const submittedLanguage = targetLanguage
    try {
      const result = await request({
        action: 'reply-translate',
        params: { ...params, chinese: draft, ...(manualTargetLanguage ? { targetLanguage: manualTargetLanguage } : {}), requestId: crypto.randomUUID() },
      })
      if (!result.ok) setTranslationNotice({ error: true, text: result.error.message })
      else {
        setTranslatedLanguage({ owner, language: normalizeMessageLanguage((result.data as Row)?.reply?.targetLanguage) ?? submittedLanguage })
        if (submittedRevision === editRevision.current) setSelectedLanguage(current => current?.owner === owner ? { ...current, needsPreview: false } : current)
        setTranslationNotice({
          error: false,
          text:
            submittedRevision === editRevision.current
              ? '发送预览已更新，请核对后确认发送'
              : '较新的中文修改已保留，请再次更新发送预览',
        })
      }
    } catch {
      setTranslationNotice({ error: true, text: '更新发送预览失败；中文草稿已保留，请重试' })
    } finally {
      translationPending.current = false
      setTranslating(false)
    }
  }
  const avatarInitial =
    nicknameSegmenter.segment(row.nickname)[Symbol.iterator]().next().value?.segment || '?'
  const followerCount =
    typeof row.followerCount === 'number' &&
    Number.isSafeInteger(row.followerCount) &&
    row.followerCount > 0
      ? row.followerCount
      : undefined
  const followerSource =
    row.followerCountSource === 'event'
      ? '本条事件'
      : row.followerCountSource === 'prior-observed'
        ? '此前观测'
        : '来源未知'
  return (
    <article
      className={`assistant-message assistant-tier-${triage?.tier ?? paymentTier(row.payLevel)}${triage ? ' assistant-triaged' : ''}`}
      data-priority={triage?.tier ?? paymentTier(row.payLevel)}
      data-rule-color={ruleColor}
      style={ruleColor ? { '--assistant-rule-color': ruleColor } as CSSProperties : undefined}
      aria-label={`${row.nickname} 的${kindLabels[row.kind] ?? row.kind}`}
      data-row-id={row.id}
    >
      <div className="assistant-message-meta">
        <div className="assistant-person">
          <span className="assistant-avatar" aria-hidden="true">
            <FlagText text={avatarInitial} />
          </span>
          <div>
            <strong className="break-all"><FlagText text={row.nickname || '昵称未知'} /></strong>
            <div className="assistant-identity" title={[row.mentionHandle ? `用户名 @${row.mentionHandle}` : '用户名未提供', row.userId ? `平台 ID ${row.userId}` : '平台 ID 未提供', row.audienceUuid ? `UUID ${row.audienceUuid}` : ''].filter(Boolean).join(' · ')}>
              <span className="assistant-username"><FlagText text={row.mentionHandle ? `用户名 @${row.mentionHandle}` : '用户名未提供'} /></span>
              {' · '}
              {row.userId ? `平台 ID ${row.userId}` : '平台 ID 未提供'}
              {row.audienceUuid && <span title={row.audienceUuid}> · UUID {row.audienceUuid}</span>}
            </div>
          </div>
        </div>
        <time
          dateTime={new Date(row.receivedAt).toISOString()}
          title={displayTime(row.receivedAt, true)}
        >
          {displayTime(row.receivedAt)}
        </time>
      </div>
      <div className="assistant-message-badges">
        {triage && (
          <AudienceTriageBadges
            triage={triage}
            language={originalLanguage}
            country={confirmedRegion}
            hasMessage={row.kind === 'comment'}
          />
        )}
        <span>{kindLabels[row.kind] ?? row.kind}</span>
        <span>
          {paymentTier(row.payLevel) === 'neutral' ? '消费等级未知' : `消费等级 ${row.payLevel}`}
        </span>
        <span>粉丝团等级 {row.fansClubLevel ?? '未知'}</span>
        <span
          title={
            followerCount === undefined
              ? '平台未提供有效粉丝数'
              : `来源：${followerSource}；观测时间：${displayTime(row.followerCountObservedAt, true)}`
          }
        >
          {followerCount === undefined ? '粉丝数未知' : `粉丝 ${followerCount}`}
        </span>
      </div>
      {triage?.attention && (
        <p
          className={`assistant-triage-reminder ${triage.attention.reviewDue && !pinned ? 'assistant-review-due' : ''}`}
          title={pinned && !triage.attention.deferredUntil ? '持续保留到取消钉住、已处理或结束本次采集' : `提醒时间：${displayTime(triage.attention.deferredUntil ?? triage.attention.reviewDueAt, true)}`}
        >
          {triage.attention.deferredUntil
            ? `稍后处理至 ${displayTime(triage.attention.deferredUntil)}`
            : pinned
              ? '已钉住 · 持续保留'
              : triage.attention.reviewDue
              ? '待处理满 5 分钟'
              : '待处理 · 5 分钟提醒'}
        </p>
      )}
      {actionFact ? <div className="assistant-action-body" aria-label="已记录动作">
        <span className="assistant-action-icon" aria-hidden="true">{actionFact.icon}</span>
        <strong>{actionFact.label}</strong>
        {actionFact.count && <span className="assistant-action-count">{actionFact.count}</span>}
        {actionFact.coins && <span className="assistant-action-coins">{actionFact.coins}</span>}
        {['sent', 'dismissed'].includes(row.reply.status) && <span className="assistant-event-status"><Check size={14} />已处理</span>}
      </div> : <div className="assistant-message-columns">
        <section>
          {!triage ? <div className="assistant-original-heading">
            <span className="assistant-field-label">原文</span>
            <AudienceLanguageBadge language={originalLanguage} hasMessage={row.kind === 'comment'} />
          </div> : <span className="assistant-field-label">原文</span>}
          <p className="assistant-original-text whitespace-pre-wrap break-words"><FlagText text={row.original} /></p>
          {row.gift && (
            <p className="assistant-muted">
              {row.gift.name ?? '礼物'} · 金币 {row.gift.totalCoins ?? '未知'}
            </p>
          )}
        </section>
        <section
          className={visibleTranslation.status === 'ready' ? 'assistant-translation-ready' : ''}
        >
          <span className="assistant-field-label">{retainedOriginal ? '翻译说明' : <>中文译文{visibleTranslation.source === 'local' ? visibleTranslation.status === 'ready' && visibleTranslation.method === 'dictionary' ? ' · 本地词表' : ' · Chrome 本地译文' : visibleTranslation.source === 'browser' ? ' · 网页译文' : visibleTranslation.status === 'ready' ? ' · AI译文' : ''}</>}</span>
          {visibleTranslation.status === 'ready' ? (
            <p className="assistant-translation-text whitespace-pre-wrap break-words">
              <FlagText text={visibleTranslation.chinese || '无译文'} />
            </p>
          ) : translation.status !== 'pending' ? (
            <p className="assistant-muted">
              {retainedOriginal
                ? translation.error || '含义不明确，保留原文'
                : translation.source === 'local'
                  ? `Chrome 本地翻译未完成：${translation.error || '尚无可用译文，原文已保留'}`
                  : translation.status === 'missing' && translation.source === 'browser'
                    ? '未找到网页译文'
                    : translation.status === 'skipped'
                      ? '此事件未翻译'
                      : translation.status === 'interrupted'
                        ? '翻译已中断'
                        : `翻译失败：${translation.error || '请重试'}`}
            </p>
          ) : null}
          {translation.status === 'pending' && (
            <p className="assistant-wait">
              <LoaderCircle className="animate-spin" size={14} />
              {translation.source === 'local' ? 'Chrome 本地翻译中' : 'DeepSeek 翻译中'}
              <span className="assistant-ellipsis" aria-hidden="true">
                …
              </span>
            </p>
          )}
          {translation.manualAttempt && (
            <p role={translation.manualAttempt.status === 'skipped' ? 'status' : 'alert'} className={translation.manualAttempt.status === 'skipped' ? 'assistant-muted' : 'assistant-error-text'}>
              {translation.manualAttempt.status === 'skipped' && translation.status === 'ready'
                ? `含义不明确，保留${translation.source === 'browser' ? '网页' : '本地'}译文`
                : translation.manualAttempt.message}
            </p>
          )}
          {manualTranslationActions && manualTranslation && row.kind === 'comment' &&
            !['sent', 'dismissed'].includes(row.reply.status) &&
            (['missing', 'failed', 'interrupted'].includes(translation.status) ||
              (translation.status === 'ready' && translation.source === 'local') ||
              translation.status === 'skipped' ||
              !!translation.manualAttempt ||
              (translation.status === 'pending' && translation.source !== 'local')) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!retryUnavailable || translation.status === 'pending' || !!currentRetry?.pending}
                title={retryUnavailable ?? '使用 DeepSeek 翻译，并留待处理'}
                onClick={() => void retryCommentTranslation()}
              >
                {translation.status === 'pending' ? <LoaderCircle className="animate-spin" /> : <Languages />}
                {translation.status === 'pending' ? 'DeepSeek 翻译中' : 'DeepSeek 翻译'}
              </Button>
            )}
          {currentRetry?.error && translation.status !== 'pending' && (
            <p role="alert" className="assistant-error-text">{currentRetry.error}</p>
          )}
          {interactive && !manualTranslation &&
            row.translation.source !== 'browser' &&
            row.translation.source !== 'local' &&
            (['failed', 'interrupted'].includes(row.translation.status) ||
              row.reply.status === 'interrupted') &&
            row.kind === 'comment' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void request({ action: 'translate-retry', params })}
              >
                <RotateCcw />
                重试 AI
              </Button>
            )}
        </section>
      </div>}
      {row.kind === 'comment' && !!row.localAbbreviations?.length && <section role="region" aria-label="本地常见缩写释义">
        <span className="assistant-field-label">本地常见缩写释义</span>
        <p className="assistant-muted">本地词表说明，具体意思仍需结合上下文。</p>
        <ul>{row.localAbbreviations.map(value => <li key={value.token}>{value.token}：{value.chineseMeaning}</li>)}</ul>
      </section>}
      {emojiAnnotations.length > 0 && (
        <section className="assistant-emoji-meanings" aria-label="表情含义">
          <span className="assistant-field-label">表情含义 · {emojiAnnotations.length} 种</span>
          <ul>
            {emojiAnnotations.map(annotation => (
              <li
                key={annotation.emoji}
                data-emoji={annotation.emoji}
                title={`${annotation.chineseName}${annotation.chineseMeaning ? `：${annotation.chineseMeaning}` : ''}`}
              >
                <span className="assistant-emoji-symbol"><FlagText text={annotation.emoji} /></span>
                <div>
                  <strong>
                    {compactEmojiName(annotation.chineseName)}
                    {annotation.count > 1 && <small> ×{annotation.count}</small>}
                  </strong>
                </div>
              </li>
            ))}
          </ul>
          <details className="assistant-emoji-details">
            <summary>展开全部详细含义</summary>
            <p className="assistant-muted">本地字典 · {ASSISTANT_EMOJI_CONTEXT_NOTE}</p>
            {emojiAnnotations.map(annotation => (
              <p key={annotation.emoji} data-emoji-detail={annotation.emoji}>
                <strong><FlagText text={annotation.emoji} /> {annotation.chineseName}</strong>
                {annotation.chineseMeaning && <span>：{annotation.chineseMeaning}</span>}
                {annotation.source === 'unknown' && <span>；本地字典尚无名称，不猜测含义</span>}
              </p>
            ))}
          </details>
        </section>
      )}
      {(attentionActions && (row.kind === 'comment' || eligibleReply) || interactive && ['sent', 'dismissed'].includes(row.reply.status) && (!!row.reply.text || !!row.reply.chinese)) && (
        <section className="assistant-reply" aria-label="回复草稿">
          <div className="assistant-reply-recipient">
            回复对象：<strong>@<FlagText text={recipient || '昵称未知'} /></strong> ·{' '}
            {row.userId ? `平台 ID ${row.userId}` : '平台 ID 未提供'}
            <small>
              对应消息 {row.sourceEventId || row.id} · {displayTime(row.receivedAt)}
            </small>
          </div>
          <div
            className={`assistant-reply-status ${row.reply.status === 'sent' ? 'assistant-sent' : ''}`}
            role="status"
          >
            {waiting ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : row.reply.status === 'sent' ? (
              <Check size={14} />
            ) : null}
            {replyLabel}
            {waiting && (
              <span className="assistant-ellipsis" aria-hidden="true">
                …
              </span>
            )}
            {row.reply.contextRevision !== undefined && (
              <small>知识版本 {row.reply.contextRevision}</small>
            )}
            {(row.reply.policyRevision ?? row.ai?.replyPolicyRevision) !== undefined && <small>回复规则 v{row.reply.policyRevision ?? row.ai?.replyPolicyRevision}{row.reply.ruleId ? ` · ${row.reply.ruleId}` : ''}</small>}
          </div>
          {attentionActions && interactive && eligibleReply && !['sent', 'dismissed'].includes(row.reply.status) && <div className="assistant-actions">
            <Button size="sm" variant="outline" disabled={!!generationUnavailable} title={generationUnavailable ?? '按此动作已保存的知识和要求生成草稿'} onClick={() => void generateReply()}>
              {generating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}{generating ? 'AI 正在生成回复' : 'AI 生成回复'}
            </Button>
            {generationUnavailable && <span className="assistant-muted">{generationUnavailable}</span>}
          </div>}
          {generationError && <p role="alert" className="assistant-error-text">{generationError}</p>}
          {row.reply.error && (
            <p role="alert" className="assistant-error-text">
              {row.reply.error}
            </p>
          )}
          {row.mentionWarning && <p className="assistant-error-text">{row.mentionWarning}</p>}
          {!editable && row.reply.chinese && (
            <p className="assistant-reply-chinese">回复中文：<FlagText text={row.reply.chinese} /></p>
          )}
          {editable ? (
            <>
              <label className="assistant-field">回复目标语言
                <select aria-label="回复目标语言" value={manualTargetLanguage} disabled={busy || translating} onChange={event => { editRevision.current++; setSelectedLanguage({ owner, language: event.target.value, needsPreview: true }); setTranslationNotice(undefined) }}>
                  <option value="">自动 · {displayLanguage(automaticTargetLanguage)}（{suggestionLabel}）</option>
                  {ASSISTANT_MESSAGE_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
                </select>
                <small className="assistant-muted">{manualTargetLanguage ? `手动回复语言：${displayLanguage(manualTargetLanguage)}` : `${suggestionLabel}：${displayLanguage(automaticTargetLanguage)} · 仅用于回复草稿`}</small>
              </label>
              <label className="assistant-field">
                中文回复草稿
                <Textarea
                  aria-label={`编辑 ${row.nickname} 的中文回复`}
                  value={draft}
                  maxLength={1000}
                  onChange={event => {
                    editRevision.current++
                    setEdit({ owner, chinese: event.target.value })
                    setTranslationNotice(undefined)
                  }}
                  rows={2}
                  placeholder="用中文填写要回复这位观众的内容"
                />
              </label>
              <VoiceDraftInput
                key={`${owner}:${row.sessionId}`}
                accountId={row.accountId}
                rowId={row.id}
                value={draft}
                disabled={busy || translating || draftTranslation?.status === 'pending'}
                onChange={chinese => {
                  editRevision.current++
                  setEdit({ owner, chinese })
                  setTranslationNotice(undefined)
                }}
              />
              <p className="assistant-send-preview">
                发送预览{displayLanguage(targetLanguage) && ` · ${displayLanguage(targetLanguage)}`}：@
                <FlagText text={recipient || '昵称未知'} /> <FlagText text={serverText || '尚未生成发送内容'} />
              </p>
              {previewStale && <p className="assistant-muted">发送预览待更新</p>}
              {translationNotice && (
                <p
                  role={translationNotice.error ? 'alert' : 'status'}
                  className={translationNotice.error ? 'assistant-error-text' : 'assistant-muted'}
                >
                  {translationNotice.text}
                </p>
              )}
              {!translationNotice && draftTranslation?.status === 'failed' && (
                <p role="alert" className="assistant-error-text">
                  {draftTranslation.error || '发送预览翻译失败；中文草稿已保留，请重试'}
                </p>
              )}
              <div className="assistant-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    translating ||
                    draftTranslation?.status === 'pending' ||
                    (!dirty && !languageChanged &&
                      targetLanguage === previewLanguage &&
                      !!serverText.trim() &&
                      !['failed', 'none', 'interrupted'].includes(row.reply.status) &&
                      draftTranslation?.status !== 'failed') ||
                    !draft.trim()
                  }
                  onClick={() => void translate()}
                >
                  {translating || draftTranslation?.status === 'pending' ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Languages />
                  )}
                  {translating || draftTranslation?.status === 'pending'
                    ? '正在更新预览'
                    : '翻译并更新预览'}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || previewStale || row.reply.status !== 'review'}
                  onClick={() =>
                    void request({
                      action: 'reply-approve',
                      params: {
                        ...params,
                        expectedText: serverText,
                        requestId: crypto.randomUUID(),
                      },
                    })
                  }
                >
                  <Send />
                  确认并发送
                </Button>
                {!(attentionActions && triage) &&
                  ['review', 'failed', 'interrupted'].includes(row.reply.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void request({ action: 'reply-dismiss', params })}
                    >
                      <X />
                      忽略
                    </Button>
                  )}
                {previewStale && (
                  <span className="assistant-muted">先更新发送预览，再确认发送</span>
                )}
                {!row.userId && (
                  <span className="assistant-error-text">
                    缺少唯一平台 ID，请核对同名观众；发送使用昵称文本 @
                  </span>
                )}
              </div>
            </>
          ) : serverText ? (
            <p className="assistant-reply-text whitespace-pre-wrap break-words">
              {row.reply.status === 'sent' && <FlagText text={`@${recipient} `} />}
              <FlagText text={serverText} />
            </p>
          ) : null}
          {interactive && attentionActions && !editable && row.reply.status === 'interrupted' && (
            <div className="assistant-actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void request({ action: 'reply-dismiss', params })}
              >
                <X />
                忽略
              </Button>
            </div>
          )}
        </section>
      )}
      {attentionActions &&
        (triage?.attention || row.kind !== 'comment') &&
        !waiting &&
        !['sent', 'dismissed'].includes(row.reply.status) && (
          <div className="assistant-actions assistant-triage-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void request({ action: 'reply-dismiss', params })}
            >
              {row.kind === 'comment' ? '已人工处理' : '完成处理'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="仅延后提醒；已钉住的动作继续保留"
              onClick={() =>
                void request({
                  action: 'attention-defer',
                  params: { ...params, requestId: crypto.randomUUID() },
                })
              }
            >
              稍后处理
            </Button>
          </div>
        )}
      {row.audienceUuid && triage && (
        <AudienceCountryEditor row={row} request={request} onConfirmed={setConfirmedCountry} />
      )}
      {onPin && !['sent', 'dismissed'].includes(row.reply.status) && (
        <>
          <Button
            className="assistant-pin-action"
            size="sm"
            variant="outline"
            disabled={busy || !!pinUnavailable || (archivePin && pinned)}
            aria-pressed={pinned}
            title={pinned ? archivePin ? '已钉住到待处理工作区，可在队列取消钉住' : '已钉住；取消后按当前批次和时限决定是否归档' : '钉住到待处理工作区，保留到取消、已处理或结束本次采集'}
            onClick={() => onPin(row)}
          >
            <Pin />
            {pinned ? archivePin ? '已钉住' : '取消钉住' : archivePin ? '钉住到待处理' : pinLabel}
          </Button>
          {/* Reserve every wrapped hint's size so expiry cannot move paused live rows. */}
          <div className="assistant-muted" style={{ display: 'grid' }}>
            {['场次已结束，不能留待处理'].map(hint => (
              <span
                key={hint}
                aria-hidden="true"
                style={{ gridArea: '1 / 1', visibility: 'hidden' }}
              >
                {hint}
              </span>
            ))}
            {pinUnavailable && (
              <p role="status" style={{ gridArea: '1 / 1' }}>
                {pinUnavailable}，不能留待处理
              </p>
            )}
          </div>
        </>
      )}
    </article>
  )
}
