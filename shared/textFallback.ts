import { splitReply } from './director'

/** Stable part keys deduplicate retries without conflating distinct audience events. */
export function textFallbackParts(account: string, traceId: string, viewer: string, text: string) {
  const parts = splitReply(text)
  const groupKey = JSON.stringify([account, traceId])
  return parts.map((part, index) => ({
    text: part,
    groupKey,
    traceKey: JSON.stringify([account, traceId, index]),
    // Existing setting is explicitly "same viewer, same sentence" cooldown.
    viewerKey: JSON.stringify([account, viewer, text]),
    part: index + 1,
    parts: parts.length,
  }))
}
