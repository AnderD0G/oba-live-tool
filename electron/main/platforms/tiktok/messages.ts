export type TikTokChatEvent = {
  content: string
  common?: { msgId?: string; createTime?: string }
  user?: {
    id?: string
    userId?: string
    nickname?: string
    displayId?: string
    specialId?: string
    uniqueId?: string
    fansClub?: { data?: { level?: number } }
    fansClubInfo?: { fansLevel?: string }
    payGrade?: { level?: number }
    /** Raw SDK badges are validated by scene and priority before supplying a level. */
    badgeList?: unknown
    subscribeInfo?: { isSubscribedToAnchor?: boolean; isSubscribe?: boolean }
    followInfo?: { followStatus?: string; followerCount?: string | number; followingCount?: string | number }
    avatarThumb?: { urlList?: string[] }
    bioDescription?: string
  }
}

export type TikTokMemberEvent = Omit<TikTokChatEvent, 'content'> & { action?: number }
export type TikTokEngagementEvent = TikTokMemberEvent & { likeCount?: number; count?: number }

export type TikTokGiftEvent = TikTokMemberEvent & {
  common?: { msgId?: string; createTime?: string; roomId?: string }
  giftId?: string
  gift?: { id?: string; name?: string; type?: number; diamondCount?: number }
  repeatCount?: number
  repeatEnd?: number
  groupId?: string
}

function knownLevels(user: TikTokChatEvent['user']) {
  const positive = (value: unknown) => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : undefined
    return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined
  }
  const missingOrZero = (value: unknown) => value === undefined || value === 0 || value === '0'
  const badgeLevel = (sceneType: number, priorityType: number, checkText: boolean) => {
    const badges = user?.badgeList
    // Reject oversized lists rather than truncating away a potentially conflicting badge.
    if (!Array.isArray(badges) || badges.length > 32) return undefined
    let known: number | undefined
    for (const badge of badges) {
      if (!badge || typeof badge !== 'object' || Array.isArray(badge) ||
        badge.sceneType !== sceneType || badge.priorityType !== priorityType) continue
      const level = positive(badge.privilegeLogExtra?.level)
      if (level === undefined || level > 10_000) return undefined
      if (checkText && badge.combine !== undefined) {
        if (!badge.combine || typeof badge.combine !== 'object' || Array.isArray(badge.combine)) return undefined
        const text = badge.combine.str
        if (text !== undefined && text !== '' &&
          (typeof text !== 'string' || positive(text) !== level)) return undefined
      }
      if (known !== undefined && known !== level) return undefined
      known = level
    }
    return known
  }
  const rawPay = user?.payGrade?.level
  const rawFan = user?.fansClub?.data?.level
  const rawFanInfo = user?.fansClubInfo?.fansLevel
  const pay = positive(rawPay) ?? (missingOrZero(rawPay) ? badgeLevel(8, 20, true) : undefined)
  const fan = positive(rawFan) ?? positive(rawFanInfo) ??
    (missingOrZero(rawFan) && missingOrZero(rawFanInfo) ? badgeLevel(10, 30, false) : undefined)
  return { ...(pay === undefined ? {} : { pay_level: pay }), ...(fan === undefined ? {} : { fans_club_level: fan }) }
}

function knownFollowerCount(user: TikTokChatEvent['user']) {
  const raw = user?.followInfo?.followerCount
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : undefined
  return count !== undefined && Number.isSafeInteger(count) && count > 0 ? { follower_count: count } : {}
}

/** Project public SDK facts only; never request another profile or infer demographics. */
function knownPublicProfile(user: TikTokChatEvent['user']): { public_profile?: TikTokPublicViewerMetadata } {
  if (!user) return {}
  const profile: TikTokPublicViewerMetadata = {}
  const rawFollowing = user.followInfo?.followingCount
  const following = typeof rawFollowing === 'number' ? rawFollowing :
    typeof rawFollowing === 'string' && /^\d{1,16}$/.test(rawFollowing) ? Number(rawFollowing) : undefined
  if (following !== undefined && Number.isSafeInteger(following) && following > 0) profile.followingCount = following
  const rawStatus = user.followInfo?.followStatus
  if (rawStatus === '1' || rawStatus === '2') profile.followStatus = Number(rawStatus)
  if (user.subscribeInfo?.isSubscribedToAnchor === true || user.subscribeInfo?.isSubscribe === true) profile.subscriptionActive = true
  if (typeof user.bioDescription === 'string') {
    const bio = user.bioDescription.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1000)
    if (bio) profile.bio = bio
  }
  const urls = user.avatarThumb?.urlList
  if (Array.isArray(urls) && urls.length <= 32) {
    for (const candidate of urls) {
      if (typeof candidate !== 'string' || candidate.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(candidate)) continue
      try {
        const url = new URL(candidate)
        // Public domain HTTPS only: no credentials, local/IP destinations or nonstandard ports.
        if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}$/i.test(url.hostname) ||
          /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) continue
        profile.avatarUrl = url.href
        break
      } catch { /* Ignore malformed optional profile fields. */ }
    }
  }
  return Object.keys(profile).length ? { public_profile: profile } : {}
}

export function toTikTokGift(
  message: TikTokGiftEvent,
  knownRoomId?: string | null,
): TikTokGiftLiveMessage | null {
  const user = message.user
  const gift = message.gift
  if (!user || !gift || (gift.type !== 1 && gift.type !== 2 && gift.type !== 4)) return null
  const repeatCount = message.repeatCount
  if (typeof repeatCount !== 'number' || !Number.isSafeInteger(repeatCount) || repeatCount <= 0) return null
  // The installed v3 SDK emits numeric protobuf flags, not the legacy boolean adapter.
  if (message.repeatEnd !== 0 && message.repeatEnd !== 1) return null
  const decimalId = (value: unknown) =>
    typeof value === 'string' && /^[0-9]{1,256}$/.test(value.trim())
      ? value.trim().replace(/^0+/, '')
      : ''
  const malformedId = (value: unknown) =>
    value !== undefined && value !== null &&
    (typeof value !== 'string' || !/^[0-9]{0,256}$/.test(value.trim()))
  if (malformedId(message.giftId) || malformedId(gift.id) || malformedId(message.common?.roomId)) return null
  const topGiftId = decimalId(message.giftId)
  const nestedGiftId = decimalId(gift.id)
  if (topGiftId && nestedGiftId && topGiftId !== nestedGiftId) return null
  const giftId = topGiftId || nestedGiftId
  if (!giftId) return null
  const eventRoomId = decimalId(message.common?.roomId)
  const connectionRoomId = decimalId(knownRoomId)
  if (eventRoomId && connectionRoomId && eventRoomId !== connectionRoomId) return null
  const userId = decimalId(user.id) || decimalId(user.userId)
  const uniqueId = [user.uniqueId, user.displayId, user.specialId].find(value => typeof value === 'string' && value) || ''
  const publicHandle = [user.uniqueId, user.displayId].find(value => typeof value === 'string' && value)
  const mention = tiktokMention(publicHandle)
  const groupId = decimalId(message.groupId)
  const timestamp = Number(message.common?.createTime)
  const unitCoins = typeof gift.diamondCount === 'number' &&
    Number.isSafeInteger(gift.diamondCount) && gift.diamondCount > 0
      ? gift.diamondCount : undefined
  const totalCoins = unitCoins === undefined ? undefined : unitCoins * repeatCount
  return {
    msg_type: 'tiktok_gift',
    msg_id: decimalId(message.common?.msgId),
    nick_name: typeof user.nickname === 'string' && user.nickname ? user.nickname : uniqueId || 'TikTok 用户',
    user_id: userId,
    unique_id: String(uniqueId),
    ...(mention ? { mention_handle: mention } : {}),
    ...knownLevels(user),
    ...knownFollowerCount(user),
    ...knownPublicProfile(user),
    time: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    room_id: eventRoomId || connectionRoomId,
    gift_id: giftId,
    gift_name: typeof gift.name === 'string' ? gift.name.trim() : '',
    gift_type: gift.type,
    repeat_count: repeatCount,
    repeat_end: message.repeatEnd === 1,
    ...(groupId ? { group_id: groupId } : {}),
    ...(unitCoins === undefined ? {} : { gift_unit_coins: unitCoins }),
    ...(totalCoins !== undefined && Number.isSafeInteger(totalCoins)
      ? { gift_total_coins: totalCoins } : {}),
  }
}

export function normalizeTikTokUsername(value = '') {
  const trimmed = value.trim()
  const urlMatch = trimmed.match(/tiktok\.com\/@([^/?#]+)/i)
  return decodeURIComponent(urlMatch?.[1] ?? trimmed)
    .replace(/^@/, '')
    .trim()
}

export function tiktokMention(value?: string) {
  const handle = value?.trim().replace(/^@/, '') || ''
  return /^(?=.*[A-Za-z_])[A-Za-z0-9._]{2,24}$/.test(handle) ? `@${handle}` : ''
}

export function toTikTokComment(message: TikTokChatEvent): TikTokCommentLiveMessage | null {
  const content = message.content?.trim()
  const user = message.user
  if (!content || !user) return null
  const msgId = message.common?.msgId || crypto.randomUUID()
  const uniqueId = user.uniqueId || user.displayId || user.specialId || user.userId || user.id
  const mention = tiktokMention(user.uniqueId || user.displayId)
  return {
    msg_type: 'tiktok_comment',
    msg_id: String(msgId),
    nick_name: user.nickname || uniqueId || 'TikTok 用户',
    user_id: String(user.userId || user.id || ''),
    unique_id: String(uniqueId || ''),
    ...(mention ? { mention_handle: mention } : {}),
    ...knownLevels(user),
    ...knownFollowerCount(user),
    ...knownPublicProfile(user),
    content,
    time: Number(message.common?.createTime || Date.now()),
  }
}

export function toTikTokMember(message: TikTokMemberEvent): TikTokMemberLiveMessage | TikTokLeaveLiveMessage | null {
  // Missing action keeps compatibility with older adapters. Explicit unknown/moderation is not entry.
  if (message.action !== undefined && message.action !== 1 && message.action !== 2) return null
  const user = message.user
  if (!user) return null
  const msgId = message.common?.msgId || crypto.randomUUID()
  const uniqueId = user.uniqueId || user.displayId || user.specialId || user.userId || user.id
  const mention = tiktokMention(user.uniqueId || user.displayId)
  if (!uniqueId && !user.nickname) return null
  return {
    msg_type: message.action === 2 ? 'tiktok_leave' : 'tiktok_member',
    msg_id: String(msgId),
    nick_name: user.nickname || uniqueId || 'TikTok 用户',
    user_id: String(user.userId || user.id || ''),
    unique_id: String(uniqueId || ''),
    ...(mention ? { mention_handle: mention } : {}),
    ...(message.action === undefined ? {} : { member_action: message.action }),
    ...knownLevels(user),
    ...knownFollowerCount(user),
    ...knownPublicProfile(user),
    is_subscriber: Boolean(
      user.subscribeInfo?.isSubscribedToAnchor || user.subscribeInfo?.isSubscribe,
    ),
    follow_status: String(user.followInfo?.followStatus || ''),
    time: Number(message.common?.createTime || Date.now()),
  }
}

export function toTikTokEngagement(
  kind: 'tiktok_follow' | 'tiktok_like',
  message: TikTokEngagementEvent,
): TikTokEngagementLiveMessage | null {
  const user = message.user
  if (!user) return null
  const uniqueId = user.uniqueId || user.displayId || user.specialId || user.userId || user.id
  if (!uniqueId && !user.nickname) return null
  const mention = tiktokMention(user.uniqueId || user.displayId)
  const rawLikeCount = message.likeCount ?? message.count
  const likeCount = typeof rawLikeCount === 'number' && Number.isSafeInteger(rawLikeCount) && rawLikeCount >= 0 ? rawLikeCount : undefined
  return {
    msg_type: kind,
    msg_id: String(message.common?.msgId || crypto.randomUUID()),
    nick_name: user.nickname || uniqueId || 'TikTok 用户',
    user_id: String(user.userId || user.id || ''),
    unique_id: String(uniqueId || ''),
    ...(mention ? { mention_handle: mention } : {}),
    ...knownLevels(user),
    ...knownFollowerCount(user),
    ...knownPublicProfile(user),
    ...(kind === 'tiktok_like' && likeCount !== undefined
      ? { like_count: likeCount }
      : {}),
    time: Number(message.common?.createTime || Date.now()),
  }
}

/** DOM account links are useful mentions, but do not expose TikTok's stable numeric user ID. */
export function toTikTokDomComment(
  value: { content: string; nickName: string; userId?: string; handle?: string },
  messageId: string,
): TikTokCommentLiveMessage | null {
  const content = value?.content?.trim()
  if (!content) return null
  const mention = tiktokMention(value.handle)
  return { msg_type: 'tiktok_comment', msg_id: messageId, nick_name: value.nickName || 'TikTok 用户',
    user_id: '', unique_id: mention?.slice(1) || '', ...(mention ? { mention_handle: mention } : {}),
    content, time: Date.now() }
}
