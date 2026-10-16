import { randomUUID } from 'node:crypto'
import type { AssistantDeskDependencies } from '../../../../shared/assistantDesk'
import type { MockBatch, MockEvent, MockUser } from '../../../../shared/mockAssistant'

export interface MockCaptureSourceOptions {
  runId: string
  now?: () => number
  afterEmit?: () => Promise<void>
  onEmitted?: (count: number) => void
  onError?: (error: unknown) => void
}

/** A private replay lease. It never acquires a real platform or emits on the application event bus. */
export class MockCaptureSource {
  private batch?: MockBatch
  private listener?: (message: LiveMessage) => void
  private generation = 0
  private playback?: number
  private timer?: ReturnType<typeof setTimeout>
  private wake?: () => void
  private now: () => number
  private captureSessionId?: string
  constructor(private options: MockCaptureSourceOptions) {
    this.now = options.now ?? Date.now
  }
  userId(id: string) {
    return `mock:${this.options.runId}:${id}`
  }
  prepare(batch: MockBatch) {
    this.cancel()
    this.batch = structuredClone(batch)
  }
  readonly startCapture: AssistantDeskDependencies['startCapture'] = async (
    accountId,
    _assistantSessionId,
    onComment,
  ) => {
    if (!this.batch || this.batch.accountId !== accountId || this.listener)
      throw Object.assign(new Error('模拟批次尚未准备或已在播放'), { code: 'MOCK_NOT_PREPARED' })
    this.listener = onComment
    const owner = ++this.generation
    this.captureSessionId = randomUUID()
    return {
      captureSessionId: this.captureSessionId,
      captureStartedAt: this.now(),
      release: async () => {
        if (owner === this.generation) this.cancel()
      },
    }
  }
  cancel() {
    this.generation++
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.wake?.()
    this.wake = undefined
    this.listener = undefined
    this.captureSessionId = undefined
    this.playback = undefined
  }
  private wait(ms: number) {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.wake = resolve
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.wake = undefined
        resolve()
      }, ms)
    })
  }
  play() {
    if (!this.listener || !this.batch || !this.captureSessionId || this.playback !== undefined)
      return
    const captureSessionId = this.captureSessionId
    const owner = this.generation
    const batch = this.batch
    const listener = this.listener
    this.playback = owner
    const users = new Map(batch.users.map(user => [user.id, user]))
    const events = batch.events
      .map((event, index) => ({ event, index }))
      .sort((a, b) => a.event.atMs - b.event.atMs || a.index - b.index)
    const startedAt = this.now()
    void (async () => {
      let emitted = 0
      for (const { event } of events) {
        if (owner !== this.generation) return
        await this.wait(startedAt + event.atMs - this.now())
        if (owner !== this.generation) return
        const user = users.get(event.userId)
        if (!user) throw new Error('模拟事件缺少对应用户')
        listener(this.message(event, user, captureSessionId))
        await this.options.afterEmit?.()
        if (owner !== this.generation) return
        this.options.onEmitted?.(++emitted)
      }
      // Playback exhaustion keeps the lease/session open for review, drafts and phone controls.
    })().catch(error => {
      if (owner === this.generation) this.options.onError?.(error)
    })
  }
  private message(event: MockEvent, user: MockUser, captureSessionId: string): LiveMessage {
    const publicProfile = {
      ...(user.followingCount === undefined ? {} : { followingCount: user.followingCount }),
      ...(user.followStatus === undefined ? {} : { followStatus: user.followStatus }),
      ...(user.subscriptionActive === undefined
        ? {}
        : { subscriptionActive: user.subscriptionActive }),
    }
    const gift = event.gift
    return {
      msg_type: (
        {
          comment: 'tiktok_comment',
          enter: 'tiktok_member',
          leave: 'tiktok_leave',
          follow: 'tiktok_follow',
          like: 'tiktok_like',
          gift: 'tiktok_gift',
          event: 'mock_event',
        } as const
      )[event.kind],
      msg_id: this.userId(event.id),
      user_id: this.userId(user.id),
      unique_id: this.userId(user.id),
      nick_name: user.nickname,
      content: event.text ?? '',
      time: this.now(),
      metadata: { provenance: 'mock' },
      ...(user.payLevel === undefined ? {} : { pay_level: user.payLevel }),
      ...(user.fansClubLevel === undefined ? {} : { fans_club_level: user.fansClubLevel }),
      ...(user.followerCount === undefined ? {} : { follower_count: user.followerCount }),
      ...(Object.keys(publicProfile).length ? { public_profile: publicProfile } : {}),
      ...(event.kind === 'enter' ? { member_action: 1 } : {}),
      ...(event.kind === 'like' ? { like_count: event.likeCount ?? 1 } : {}),
      ...(gift
        ? {
            room_id: this.userId(captureSessionId),
            gift_type: 1,
            gift_id: gift.id,
            gift_name: gift.name,
            group_id: this.userId(gift.groupId ?? event.id),
            repeat_count: gift.count,
            repeat_end: gift.final,
            ...(gift.unitCoins === undefined ? {} : { gift_unit_coins: gift.unitCoins }),
            ...(gift.totalCoins === undefined ? {} : { mock_gift_total_coins: gift.totalCoins }),
          }
        : {}),
    } as unknown as LiveMessage
  }
}
