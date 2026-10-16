import type { BusinessObservation } from './analysisRoom'
import type { AssistantAudiencePolicy, AssistantAudienceTriage } from './assistantAudiencePolicy'
import type { AssistantEmojiAnnotation } from './assistantEmojiMeaning'
import type { PlatformLiveTarget } from './platformSession'
import type { BrowserTranslationObservation } from './browserTranslation'
import type { AssistantReplyPolicy } from './assistantReplyPolicy'

export const ASSISTANT_DESK_ACTIONS = ['state', 'storage-status', 'storage-backup', 'context-get', 'context-save', 'policy-fields', 'policy-get', 'policy-save', 'policy-simulate', 'reply-policy-get', 'reply-policy-save', 'reply-generate', 'audience-tag', 'start', 'stop', 'timeline', 'audience', 'sessions', 'segments', 'segment-toggle', 'segment-rename', 'segment-summary', 'reply-update', 'reply-translate', 'reply-approve', 'reply-dismiss', 'translate-retry', 'attention-pin', 'attention-clear', 'attention-defer', 'attention-window', 'attention-countdown', 'message-batches', 'message-batch', 'message-batch-read', 'identity-link', 'identity-unlink', 'test-send', 'recording'] as const
export type AssistantDeskAction = typeof ASSISTANT_DESK_ACTIONS[number]
export type AssistantDeskReplyMode = 'off' | 'review' | 'auto'
export interface AssistantDeskContext {
  revision: number
  knowledge: string
  instructions: string
  replyMode: AssistantDeskReplyMode
  translationEnabled: boolean
  translationMode?: 'ai' | 'browser' | 'local'
  aiRequestLimit: number
  goldLevel: number
  priorityGold: boolean
  aiPaused: boolean
  localEffectsEnabled: boolean
  /** Current-session attention expires after this many seconds; omitted legacy values use 600. */
  attentionMaxAgeSeconds?: number
}
export interface AssistantDeskCaptureRun {
  captureSessionId: string
  /** Actual raw capture start; absent on legacy records until verified metadata is available. */
  startedAt?: number
  target?: PlatformLiveTarget
  roomId?: string
  recordingPaths?: string[]
}
export interface AssistantDeskProvenance { mode: 'mock'; runId: string }
export interface AssistantDeskSession {
  provenance?: AssistantDeskProvenance
  id: string
  accountId: string
  platform: string
  startedAt: number
  endedAt?: number
  captureSessionId?: string
  /** Every raw capture, including an explicit restart of this assistant scene. */
  captureRuns?: AssistantDeskCaptureRun[]
  status: 'collecting' | 'completed' | 'interrupted' | 'storage-error'
  aiRequests: number
  reason?: string
  recordingPaths?: string[]
}
export interface AssistantDeskGift {
  roomId?: string
  id?: string
  name?: string
  groupId?: string
  count?: number
  final: boolean
  contributed: boolean
  contributionWarning?: string
  unitCoins?: number
  totalCoins?: number
}
export interface AssistantDeskPublicProfile { avatarUrl?: string; followingCount?: number; followStatus?: number; subscriptionActive?: true; bio?: string }
export interface AssistantReplyLanguageHint {
  language: string
  source: 'manual' | 'observed' | 'recent-viewer-comment' | 'nickname-hint' | 'default-english'
}
export interface AssistantTranslationFallback {
  source: 'local' | 'browser'
  method?: 'dictionary' | 'chrome'
  language?: string
  chinese: string
}
export interface AssistantDeskRow {
  provenance?: AssistantDeskProvenance
  id: string
  sessionId: string
  accountId: string
  platform: string
  receivedAt: number
  sourceEventId?: string
  userId?: string
  audienceUuid?: string
  nickname: string
  mentionHandle?: string
  mentionWarning?: string
  kind: 'comment' | 'enter' | 'leave' | 'follow' | 'gift' | 'like' | 'event'
  /** Known count from this normalized native like event; absence stays unknown. */
  likeCount?: number
  original: string
  /** Local dictionary descriptions derived from original; never a translation or viewer fact. */
  emojiAnnotations?: readonly AssistantEmojiAnnotation[]
  payLevel?: number
  fansClubLevel?: number
  followerCount?: number
  followerCountSource?: 'event' | 'prior-observed'
  followerCountObservedAt?: number
  /** Original received-row sequence, preserved across later AI journal updates. */
  followerCountObservedOrder?: number
  levelSource?: { payLevel?: 'event' | 'prior-observed'; fansClubLevel?: 'event' | 'prior-observed' }
  publicProfile?: AssistantDeskPublicProfile
  publicProfileObservedAt?: number
  publicProfileObservedOrder?: number
  publicProfileSource?: 'event' | 'prior-observed'
  triage?: AssistantAudienceTriage
  /** Reply drafting suggestion only; never source-language or country evidence. */
  replyLanguageHint?: AssistantReplyLanguageHint
  gift?: AssistantDeskGift
  translation: { status: 'pending' | 'ready' | 'failed' | 'skipped' | 'interrupted' | 'missing'; source?: 'ai' | 'browser' | 'local'; method?: 'dictionary' | 'chrome'; language?: string; chinese?: string; error?: string;
    /** A usable same-row translation remains visible while the operator requests an AI supplement. */
    fallback?: AssistantTranslationFallback;
    manualAttempt?: { status: 'failed' | 'interrupted' | 'skipped'; message: string }
  }
  localAbbreviations?: readonly { token: string; chineseMeaning: string }[]
  reply: { status: 'none' | 'queued' | 'generating' | 'review' | 'sending' | 'sent' | 'failed' | 'dismissed' | 'interrupted'; text?: string; chinese?: string; targetLanguage?: string; error?: string; contextRevision?: number; policyRevision?: number; ruleId?: string; sentAt?: number; requestId?: string; draftTranslation?: { status: 'pending' | 'ready' | 'failed'; requestId: string; error?: string } }
  ai?: { contextRevision: number; replyPolicyRevision?: number; model?: string; requestedAt?: number; completedAt?: number; evidence?: string[]; needsReview?: boolean }
}
export interface AssistantDeskAudience {
  uuid: string
  platform: string
  userId: string
  nickname: string
  /** Public username observed for this platform identity; absent means unknown. */
  mentionHandle?: string
  firstSeenAt: number
  lastSeenAt: number
  accountIds: string[]
  linkedUuid?: string
  payLevel?: number
  fansClubLevel?: number
  followerCount?: number
  followerCountObservedAt?: number
  followerCountObservedOrder?: number
  publicProfile?: AssistantDeskPublicProfile
  publicProfileObservedAt?: number
  publicProfileObservedOrder?: number
  triage?: AssistantAudienceTriage
  comments: number
  enters: number
  leaves: number
  follows: number
  finalGiftGroups: number
  knownGiftCoins: number
  unknownGiftGroups: number
}
export interface AssistantDeskSegment {
  id: string
  sessionId: string
  /** Missing means the historical capture association is unknown. */
  captureSessionId?: string
  accountId: string
  name: string
  startedAt: number
  endedAt?: number
}
export interface AssistantDeskMarkerStatus {
  open?: { id: string; name: string; startedAt: number }
  completed: number
}
export interface AssistantDeskSegmentSummary {
  segment: AssistantDeskSegment
  comments: number
  follows: number
  enters: number
  leaves: number
  finalGiftGroups: number
  knownGiftCoins: number
  unknownGiftGroups: number
  onlineStart?: number
  onlineEnd?: number
  onlineChange?: number
  onlineMin?: number
  onlineMax?: number
  roomSnapshots: number
}
export interface AssistantDeskRoom {
  status: 'unknown' | 'fresh' | 'stale' | 'disconnected'
  onlineCount?: number
  totalUser?: string
  anonymous?: string
  receivedAt?: number
  ageMs?: number
  source?: 'sdk-decoded' | 'cdp-websocket-decoded' | 'cdp-http-decoded'
}
export interface AssistantDeskAi {
  used: number
  limit: number
  queued: number
  running: number
  paused: boolean
  pauseReason?: 'request-limit' | 'user-paused' | 'no-session' | 'storage-error' | 'configuration-change'
}
export interface AssistantDeskHealth { status: 'ok' | 'error'; pendingWrites: number; dropped: number; error?: string; recoveryWarnings: number }
export interface AssistantDeskBackupInfo {
  fileName: string; createdAt: number; recordCount: number; latestSequence: number; bytes: number; verified: true; method: 'online' | 'vacuum'
}
export interface AssistantDeskDatabaseStatus {
  engine: 'sqlite' | 'memory'; volatile?: true; schemaVersion: 1; authoritative: true; recordCount: number; latestSequence: number; migrationComplete: true; importedRecords: number; recoveryWarnings: number
  backup: { disabled?: true; intervalMs: number; retain: 7; last?: AssistantDeskBackupInfo; nextDueAt?: number; error?: string }
  mirrorWarning?: string
}
/** Current capture browser translation progress; original comments remain independent of this notice. */
export interface AssistantBrowserTranslationHealth {
  status: 'inactive' | 'waiting' | 'ok' | 'attention'
  checkedAt: number
  untranslatedCount: number
  lastCommentAt?: number
  lastTranslatedAt?: number
  attentionSince?: number
  noticeKey?: string
}
/** Public Chrome on-device APIs; never a paid provider or audience location claim. */
export interface AssistantLocalTranslationHealth {
  status: 'idle' | 'starting' | 'ready' | 'failed' | 'unavailable'
  queued: number
  activeLanguages: string[]
  lastError?: string
}
export interface AssistantLocalTranslationResult {
  status: 'ready' | 'unsupported' | 'uncertain'
  method?: 'dictionary' | 'chrome'
  language?: string
  chinese?: string
  confidence?: number
  error?: string
}
/** Immutable membership: the first durable occurrence of each row determines its batch. */
export interface AssistantMessageBatch {
  id: string
  accountId: string
  sessionId: string
  index: number
  from: number
  to: number
  total: number
  batchSize: number
  /** A read-only time slice over all captured facts; absent on legacy count batches. */
  sliceSeconds?: number
  status: 'collecting' | 'archived'
  readAt?: number
  /** Monotonic journal revision; stale UI/MCP responses must not override a newer read decision. */
  readRevision?: number
}
export interface AssistantMessageBatchSummary {
  batchSize: 1000
  totalRows: number
  archivedTotal: number
  unreadTotal: number
  current?: AssistantMessageBatch
  recent: AssistantMessageBatch[]
}
export interface AssistantMessageBatchFilter {
  accountId: string
  batchId: string
  kinds?: AssistantDeskRow['kind'][]
  tier?: 'gold' | 'silver' | 'neutral'
  minPayLevel?: number
  minFansClubLevel?: number
  minFollowerCount?: number
  cursor?: string
  limit?: number
}
export interface AssistantDeskState {
  /** Selected real destination for a human-approved simulated reply; never a worker capability. */
  mockReplyTarget?: { ready: boolean; username?: string }
  provenance?: AssistantDeskProvenance
  database?: AssistantDeskDatabaseStatus
  context: AssistantDeskContext
  audiencePolicy?: AssistantAudiencePolicy
  replyPolicy?: AssistantReplyPolicy
  activeSession?: AssistantDeskSession
  sessions: AssistantDeskSession[]
  rows: AssistantDeskRow[]
  /** Fresh unresolved comments from the active session, independent of the recent live feed. */
  attention?: { rows: AssistantDeskRow[]; total: number; pinnedRowIds?: string[]; archivedTotal?: number; window?: { id: string; startedAt: number; endsAt: number; intervalSeconds: number; active?: boolean; paused?: boolean; remainingMs?: number; archivedWindows: { id: string; from: number; to: number; total: number }[] } }
  messageBatches?: AssistantMessageBatchSummary
  /** Batches of the active assistant scene, or the last displayed scene after collection stops. */
  currentSessionMessageBatches?: AssistantMessageBatchSummary
  segments: AssistantDeskSegment[]
  /** Exact active scene/capture summary, independent of the bounded segment history. */
  currentMarker?: AssistantDeskMarkerStatus
  audience: AssistantDeskAudience[]
  room: AssistantDeskRoom
  ai: AssistantDeskAi
  health: AssistantDeskHealth
  browserTranslationHealth?: AssistantBrowserTranslationHealth
  localTranslationHealth?: AssistantLocalTranslationHealth
  /** Passive one-way DOM/native comparison; discrepancies are evidence, not loss verdicts. */
  sourceAudit?: { matched: number; domOnly: number; ambiguous: number; incomplete: number; pending: number; pendingWrites: number; error?: string }
  /** Read-only application-wide OBS queue metrics; not viewer facts or delivered effects. */
  obsOperations?: { active: boolean; queuedEffects: number; queuedControls: number; queuedDisplays: number; queuedCleanup: number; queuedStop: number; rejectedEffects: { busy: number; stale: number; stopped: number; superseded: number } }
}
export interface AssistantDeskPage<T> { items: T[]; nextCursor?: string }
export interface AssistantDeskFilter { accountId: string; sessionId?: string; userId?: string; audienceUuid?: string; /** Complete recorded public username; one leading @ and case are normalized for lookup only. */ mentionHandle?: string; /** Complete recorded nickname; literal Unicode exact match, never an identity link. */ nickname?: string; from?: number; to?: number; minPayLevel?: number; cursor?: string; limit?: number }
export type AssistantDeskCommand =
  | { action: 'state' | 'storage-status' | 'storage-backup' | 'context-get' | 'stop'; params: { accountId: string } }
  | { action: 'policy-fields' | 'policy-get'; params: { accountId: string } }
  | { action: 'reply-policy-get'; params: { accountId: string } }
  | { action: 'reply-policy-save'; params: { accountId: string; expectedRevision: number; policy: Omit<AssistantReplyPolicy, 'revision'> | AssistantReplyPolicy; requestId?: string; requireStopped?: boolean } }
  | { action: 'reply-generate'; params: { accountId: string; rowId: string; requestId: string } }
  | { action: 'policy-save'; params: { accountId: string; expectedRevision: number; policy: Omit<AssistantAudiencePolicy, 'revision'> | AssistantAudiencePolicy; requireStopped?: boolean } }
  | { action: 'policy-simulate'; params: { accountId: string; rowId: string; policy?: Omit<AssistantAudiencePolicy, 'revision'> | AssistantAudiencePolicy } }
  | { action: 'audience-tag'; params: { accountId: string; audienceUuid: string; expectedRevision: number; countryCode: string | null; note?: string } }
  | { action: 'context-save'; params: { accountId: string; expectedRevision: number; context: Omit<AssistantDeskContext, 'revision'> | AssistantDeskContext; requireStopped?: boolean } }
  | { action: 'start'; params: { accountId: string; platform?: string; requestId?: string } }
  | { action: 'timeline' | 'audience' | 'sessions' | 'segments'; params: AssistantDeskFilter }
  | { action: 'segment-toggle'; params: { accountId: string; requestId?: string; runId?: string; label?: string; sessionId?: string; expectedOpenSegmentId?: string | null } }
  | { action: 'segment-rename'; params: { accountId: string; segmentId: string; name: string } }
  | { action: 'segment-summary'; params: { accountId: string; segmentId: string } }
  | { action: 'reply-update'; params: { accountId: string; rowId: string; text: string } }
  | { action: 'reply-translate'; params: { accountId: string; rowId: string; chinese: string; targetLanguage?: string; requestId: string } }
  | { action: 'reply-approve'; params: { accountId: string; rowId: string; expectedText: string; requestId: string } }
  | { action: 'reply-dismiss' | 'translate-retry'; params: { accountId: string; rowId: string } }
  | { action: 'attention-pin'; params: { accountId: string; rowId: string; pinned: boolean; expectedPinRevision?: number } }
  | { action: 'attention-clear'; params: { accountId: string; scope?: 'all' | 'expired'; requestId: string } }
  | { action: 'attention-defer'; params: { accountId: string; rowId: string; requestId: string } }
  | { action: 'attention-window'; params: { accountId: string; windowId: string; cursor?: string; limit?: number } }
  | { action: 'attention-countdown'; params: { accountId: string; windowId: string; paused: boolean } }
  | { action: 'message-batches'; params: { accountId: string; sessionId?: string; sliceSeconds?: number; cursor?: string; limit?: number } }
  | { action: 'message-batch'; params: AssistantMessageBatchFilter }
  | { action: 'message-batch-read'; params: { accountId: string; batchId: string; read: boolean } }
  | { action: 'identity-link'; params: { accountId: string; audienceUuid: string; targetUuid: string } }
  | { action: 'identity-unlink'; params: { accountId: string; audienceUuid: string } }
  | { action: 'test-send'; params: { accountId: string; requestId: string; text?: string } }
  | { action: 'recording'; params: { accountId: string; recordingAction: 'status' | 'start' | 'stop' } }
export type AssistantDeskResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
export interface AssistantDeskDependencies {
  now?: () => number
  interpret(accountId: string, prompt: string, signal: AbortSignal): Promise<string>
  translateDraft?(accountId: string, input: { chinese: string; targetLanguage: string; originalComment?: string }, signal: AbortSignal): Promise<string>
  send(accountId: string, text: string, signal: AbortSignal): Promise<void>
  startCapture(accountId: string, assistantSessionId: string, onComment: (message: LiveMessage) => void, onCaptureCreated?: (run: AssistantDeskCaptureRun) => Promise<void>): Promise<{ captureSessionId?: string; captureStartedAt?: number; target?: PlatformLiveTarget; release(): Promise<void> }>
  /** Runs only after the initial observed event row has been durably committed. */
  onObservedPersisted?(accountId: string, message: LiveMessage, row: AssistantDeskRow): void | Promise<void>
  /** Read metadata for the exact identity; never use the current room as history. */
  captureMetadata?(accountId: string, platform: string, captureSessionId: string): Promise<{ startedAt?: number; roomId?: string } | undefined>
  subscribeTranslations?(accountId: string, listener: (observation: BrowserTranslationObservation) => void): () => void
  localTranslate?(input: { text: string; signal: AbortSignal }): Promise<AssistantLocalTranslationResult>
  localTranslationState?(): AssistantLocalTranslationHealth
  recording?(accountId: string, action: 'status' | 'start' | 'stop'): Promise<unknown>
  model?: string | ((accountId: string) => string | undefined)
}
export interface AssistantDeskBusinessObserver { observeBusiness(observation: BusinessObservation): void }
