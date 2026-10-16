interface XiaohongshuMessage {
  type: string
  current_time?: number
  commentId?: string
  profile?: {
    nickname?: string
    role?: number
    user_id?: string
    follow_status?: number
  }
  desc?: string
  is_follow?: boolean | number
}

interface XiaohongshuMessageEnvelope {
  msgId: string
  roomId: string
  ts: number
}

export function mapXiaohongshuMessage(
  value: unknown,
  envelope: XiaohongshuMessageEnvelope,
): LiveMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as XiaohongshuMessage
  const profile = message.profile
  if (!profile || typeof profile.nickname !== 'string' || typeof profile.user_id !== 'string') {
    return null
  }
  const time = typeof message.current_time === 'number' ? message.current_time : envelope.ts
  if (message.type === 'text' && typeof message.desc === 'string') {
    return {
      msg_type: 'xiaohongshu_comment',
      msg_id: message.commentId || envelope.msgId,
      nick_name: profile.nickname,
      user_id: profile.user_id,
      content: message.desc,
      time,
    }
  }
  if (message.type === 'audience_join_v2') {
    return {
      msg_type: 'xiaohongshu_member',
      msg_id: envelope.msgId,
      nick_name: profile.nickname,
      user_id: profile.user_id,
      follow_status: typeof profile.follow_status === 'number' ? profile.follow_status : 0,
      role: typeof profile.role === 'number' ? profile.role : 0,
      room_id: envelope.roomId,
      time,
    }
  }
  if (message.type === 'follow_emcee') {
    return {
      msg_type: 'xiaohongshu_follow',
      msg_id: envelope.msgId,
      nick_name: profile.nickname,
      user_id: profile.user_id,
      follow_status: typeof profile.follow_status === 'number' ? profile.follow_status : 0,
      room_id: envelope.roomId,
      time,
    }
  }
  return null
}
