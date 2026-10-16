import { randomUUID } from 'node:crypto'
import type {
  AudienceEventKind,
  AudienceFacts,
  AudienceOutcome,
  AudienceTrace,
} from '../../../shared/audienceEvents'
import type { AudienceEventStore } from './AudienceEventStore'

function knownId(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 300 ||
    [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return undefined
  return value.trim()
}
export class AudienceTimeline {
  private sessions = new Map<string, AudienceTrace>()
  constructor(
    private store: AudienceEventStore,
    private report = () => console.error('观众时间线写入失败；请查看时间线存储状态'),
  ) {}
  receive(
    accountId: string,
    platform: string,
    message: LiveMessage,
    kind: AudienceEventKind,
  ): AudienceTrace {
    const key = JSON.stringify([accountId, platform])
    let session = this.sessions.get(key)
    if (!session) {
      session = { accountId, platform, sessionId: randomUUID(), traceId: randomUUID() }
      this.sessions.set(key, session)
      this.record(session, {
        kind: 'session.started',
        detail: 'local observation session; not a platform broadcast identifier',
      })
    }
    const raw = message as unknown as Record<string, unknown>
    const facts: AudienceFacts = {}
    const fields = {
      fansClubLevel: 'fans_club_level',
      payLevel: 'pay_level',
      followStatus: 'follow_status',
      isSubscriber: 'is_subscriber',
      likeCount: 'like_count',
      giftId: 'gift_id',
      giftName: 'gift_name',
      giftType: 'gift_type',
      giftCount: 'repeat_count',
      giftGroupId: 'group_id',
      giftRepeatEnd: 'repeat_end',
      giftUnitCoins: 'gift_unit_coins',
      giftTotalCoins: 'gift_total_coins',
      roomId: 'room_id',
      orderStatus: 'order_status',
      orderTime: 'order_ts',
      productId: 'product_id',
      productTitle: 'product_title',
    } as const
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const value = raw[fields[key]]
      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        facts[key] = value
    }
    const trace: AudienceTrace = {
      ...session,
      traceId: randomUUID(),
      userId: knownId(raw.user_id),
      userName: knownId(message.nick_name),
      sourceEventId: knownId(message.msg_id),
    }
    void this.store
      .append({
        ...trace,
        kind,
        text: typeof raw.content === 'string' ? raw.content : undefined,
        sourceType: message.msg_type,
        facts,
      })
      .catch(this.report)
    return trace
  }
  end(account?: string) {
    for (const [key, trace] of this.sessions) {
      if (account !== undefined && trace.accountId !== account) continue
      this.record(trace, { kind: 'session.ended' })
      this.sessions.delete(key)
    }
  }
  record(trace: AudienceTrace | undefined, outcome: AudienceOutcome) {
    if (!trace) return
    void this.store.append({ ...trace, ...outcome }).catch(this.report)
  }
}
