export type TikTokChatEvent = {
  content: string
  common?: { msgId?: string; createTime?: string }
  user?: {
    id?: string
    nickname?: string
    displayId?: string
    specialId?: string
  }
}

export function normalizeTikTokUsername(value = '') {
  const trimmed = value.trim()
  const urlMatch = trimmed.match(/tiktok\.com\/@([^/?#]+)/i)
  return decodeURIComponent(urlMatch?.[1] ?? trimmed)
    .replace(/^@/, '')
    .trim()
}

export function toTikTokComment(message: TikTokChatEvent): TikTokCommentLiveMessage | null {
  const content = message.content?.trim()
  const user = message.user
  if (!content || !user) return null
  const msgId = message.common?.msgId || crypto.randomUUID()
  const uniqueId = user.displayId || user.specialId || user.id
  return {
    msg_type: 'tiktok_comment',
    msg_id: String(msgId),
    nick_name: user.nickname || uniqueId || 'TikTok 用户',
    user_id: String(user.id || uniqueId || ''),
    unique_id: String(uniqueId || ''),
    content,
    time: Number(message.common?.createTime || Date.now()),
  }
}
