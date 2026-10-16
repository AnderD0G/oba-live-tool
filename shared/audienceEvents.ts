export const AUDIENCE_EVENT_KINDS = [
  'session.started',
  'session.ended',
  'viewer.enter',
  'viewer.comment',
  'viewer.follow',
  'viewer.like',
  'viewer.gift',
  'viewer.subscription',
  'viewer.fanclub',
  'order.observed',
  'viewer.event',
  'routing.decision',
  'reply.generated',
  'reply.result',
  'text.sent',
  'text.failed',
  'voice.requested',
  'voice.ready',
  'voice.played',
  'voice.skipped',
  'voice.failed',
  'hook.action',
  'hook.decision',
  'human.decision',
  'human.action',
  'director.request',
  'identity.changed',
  'profile.changed',
] as const
export type AudienceEventKind = (typeof AUDIENCE_EVENT_KINDS)[number]
export const AUDIENCE_FACT_KEYS = [
  'fansClubLevel',
  'payLevel',
  'followStatus',
  'isSubscriber',
  'likeCount',
  'giftId',
  'giftName',
  'giftType',
  'giftCount',
  'giftGroupId',
  'giftRepeatEnd',
  'giftUnitCoins',
  'giftTotalCoins',
  'roomId',
  'orderStatus',
  'orderTime',
  'productId',
  'productTitle',
  'requestId',
  'requestStatus',
  'trayId',
  'mode',
  'actionId',
  'actionType',
  'actionStatus',
  'hookRevision',
] as const
export type AudienceFacts = Partial<
  Record<(typeof AUDIENCE_FACT_KEYS)[number], string | number | boolean>
>
export interface AudienceTrace {
  traceId: string
  sessionId: string
  accountId: string
  platform: string
  userId?: string
  userName?: string
  sourceEventId?: string
}
export interface AudienceEventDraft extends AudienceTrace {
  kind: AudienceEventKind
  text?: string
  detail?: string
  sourceType?: string
  ruleId?: string
  ruleRevision?: number
  platformTime?: number
  preview?: boolean
  facts?: AudienceFacts
}
export interface AudienceEvent extends AudienceEventDraft {
  id: string
  receivedAt: number
}
export type AudienceOutcome = Pick<
  AudienceEventDraft,
  'kind' | 'text' | 'detail' | 'preview' | 'ruleId' | 'ruleRevision' | 'facts'
>
export interface AudienceEventQuery {
  accountId: string
  platform?: string
  userId?: string
  sessionId?: string
  traceId?: string
  kind?: AudienceEventKind
  limit?: number
  cursor?: string
}
export interface AudienceEventPage {
  items: AudienceEvent[]
  nextCursor?: string
  scanned: number
  corruptLines: number
}
