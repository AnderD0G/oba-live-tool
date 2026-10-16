/** Installed v3: field 3 is total. It corresponds to v2 viewerCount, not totalUser. */
export interface TikTokRoomSnapshot {
  receivedAt: number
  onlineCount: number
  source: 'sdk-decoded'
  totalUser?: string
  anonymous?: string
}
function decimal(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : undefined
}
export function tikTokRoomSnapshot(value: unknown, receivedAt: number): TikTokRoomSnapshot | null {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(receivedAt) || receivedAt < 0)
    return null
  const data = value as Record<string, unknown>
  const raw = decimal(data.total)
  if (raw === undefined) return null
  const onlineCount = Number(raw)
  if (!Number.isSafeInteger(onlineCount) || onlineCount < 0) return null
  const totalUser = decimal(data.totalUser)
  const anonymous = decimal(data.anonymous)
  return {
    receivedAt,
    onlineCount,
    source: 'sdk-decoded',
    ...(totalUser === undefined ? {} : { totalUser }),
    ...(anonymous === undefined ? {} : { anonymous }),
  }
}
