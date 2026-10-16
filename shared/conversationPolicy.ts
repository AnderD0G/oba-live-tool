export interface ConversationLimits {
  offTopicTurns: number
  offTopicCooldownMs: number
  voicePerMinute: number
  modelCallsPerMinute: number
  briefReply: string
  closingReply: string
  businessPattern: string
}
export const defaultConversationLimits: ConversationLimits = {
  offTopicTurns: 2,
  offTopicCooldownMs: 300000,
  voicePerMinute: 3,
  modelCallsPerMinute: 4,
  briefReply: '哈哈，宝贝有想看的款式也可以告诉我。',
  closingReply: '哈哈，宝贝我们先看直播，有想看的款式告诉我。',
  businessPattern:
    '材质|尺寸|颜色|价格|多少[钱元]|库存|发货|快递|退货|退款|售后|质量|怎么[买用戴]|点播|展示|试戴|上头|取消|不看了|不用了|几号|[0-9０-９]+号|material|price|size|shipping|refund|cancel|show',
}
export function validateConversationLimits(value: ConversationLimits) {
  for (const [key, min, max] of [
    ['offTopicTurns', 1, 10],
    ['offTopicCooldownMs', 1000, 3600000],
    ['voicePerMinute', 0, 10],
    ['modelCallsPerMinute', 1, 60],
  ] as const)
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`互动限制 ${key} 无效`)
  for (const key of ['briefReply', 'closingReply'] as const)
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 120)
      throw new Error('礼貌接话需要 1～120 字')
  // Plain alternative words only: untrusted editable regexes must not block the event loop.
  if (typeof value.businessPattern !== 'string' || value.businessPattern.length > 2000)
    throw new Error('业务关键词规则无效')
}
