import { isTikTokUsername } from '../../../../shared/assistantDeskContract.mjs'

export type TikTokBrowserCookie = {
  name: string
  value: string
}

export type TikTokCookieSession = {
  sessionId: string
  ttTargetIdc: string
}

export function extractTikTokCookieSession(
  cookies: TikTokBrowserCookie[],
): TikTokCookieSession | null {
  const sessionId =
    cookies.find(cookie => cookie.name === 'sessionid_ss')?.value ||
    cookies.find(cookie => cookie.name === 'sessionid')?.value
  const ttTargetIdc = cookies.find(cookie => cookie.name === 'tt-target-idc')?.value
  if (!sessionId || !ttTargetIdc) return null
  return { sessionId, ttTargetIdc }
}

export function proxyUrlFromRule(rule: string) {
  for (const entry of rule.split(';')) {
    const match = entry.trim().match(/^(?:PROXY|HTTPS?)\s+(.+)$/i)
    if (!match) continue
    const address = match[1].trim()
    if (!address) continue
    return /^https?:\/\//i.test(address) ? address : `http://${address}`
  }
  return null
}

export function extractTikTokRoomIdFromText(text: string) {
  const variants = [text, text.replaceAll('\\"', '"').replaceAll('&quot;', '"')]
  try {
    variants.push(decodeURIComponent(text))
  } catch {
    // Some HTML is not URI encoded. The original variants are still usable.
  }

  const patterns = [
    /[?&]room_id=(\d{8,})/i,
    /"roomId"\s*:\s*"?(\d{8,})"?/i,
    /"room_id"\s*:\s*"?(\d{8,})"?/i,
    /"room_id_str"\s*:\s*"?(\d{8,})"?/i,
  ]
  for (const variant of variants) {
    for (const pattern of patterns) {
      const roomId = variant.match(pattern)?.[1]
      if (roomId) return roomId
    }
  }
  return null
}

/** A room number is authoritative only when its structured owner and the current URL agree. */
export function extractTargetBoundTikTokRoomId(bindings: unknown, pageUrl: string, targetUsername: string): string | null {
  if (!Array.isArray(bindings) || bindings.length > 16 ||
    !isTikTokUsername(targetUsername)) return null
  let owner: string
  try {
    const url = new URL(pageUrl)
    const match = /^\/@([^/]+)\/live\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) ||
      url.username || url.password || url.port || !match || !isTikTokUsername(match[1])) return null
    owner = targetUsername.toLowerCase()
    if (match[1].toLowerCase() !== owner) return null
  } catch { return null }
  const rooms = new Set<string>()
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue
    const { uniqueId, roomId } = binding as Record<string, unknown>
    if (typeof uniqueId !== 'string' || uniqueId.toLowerCase() !== owner ||
      typeof roomId !== 'string' || !/^[1-9]\d{7,19}$/.test(roomId)) continue
    rooms.add(roomId)
  }
  return rooms.size === 1 ? [...rooms][0] : null
}

/** Cached room info precedes signer redirects, so both its public owner and room must match. */
export function verifiesTikTokSdkRoomInfo(roomInfo: unknown, roomId: string, targetUsername: string): boolean {
  if (!/^[1-9]\d{7,19}$/.test(roomId) || !isTikTokUsername(targetUsername)) return false
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
  const root = record(roomInfo)
  if (!root) return false
  let verified = false
  for (const container of [root, record(root.data)]) {
    const owner = record(container?.owner)
    if (!container || !owner) continue
    const names = [owner.uniqueId, owner.unique_id, owner.display_id].filter(value => value !== undefined && value !== '')
    if (!names.length) continue
    if (names.some(value => typeof value !== 'string' || value.toLowerCase() !== targetUsername.toLowerCase())) return false
    const ids = [container.id_str, container.room_id_str, container.roomId, container.room_id, container.id]
      .filter((value): value is string => typeof value === 'string' && value !== '')
    if (!ids.length) continue
    if (ids.some(value => value !== roomId)) return false
    verified = true
  }
  return verified
}
