import { randomUUID } from 'node:crypto'

/** Nicknames are display labels. Anonymous events never claim another viewer's history. */
export function liveViewerIdentity(
  platform: string,
  message: { user_id?: unknown; msg_id?: string; msg_type: string },
) {
  const id = typeof message.user_id === 'string' ? message.user_id.trim() : ''
  return id
    ? JSON.stringify(['platform-user', platform, id])
    : JSON.stringify([
        'anonymous-event',
        platform,
        message.msg_type,
        message.msg_id || randomUUID(),
      ])
}
export function resourceViewerIdentity(user: string) {
  try {
    const value = JSON.parse(user)
    if (Array.isArray(value) && value[0] === 'anonymous-event')
      return 'anonymous-room-resource-pool'
  } catch {}
  return user
}
