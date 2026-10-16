import type { GroupReplyContext } from '../../../../shared/audienceGroups'
import type { RoutingDecision } from '../../../../shared/interactionRouting'

export function safeGroupText(value: string, max = 512): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberately remove control characters from untrusted display text.
      .replace(/[\x00-\x1f\x7f<>\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  )
}
export function buildGroupReplyContext(
  decision: RoutingDecision,
  nickname?: string,
): GroupReplyContext | undefined {
  const group = decision.group
  if (!group) return undefined
  const name = safeGroupText(nickname ?? '', 80).replace(/[@{}]/g, '')
  const attributes: GroupReplyContext['attributes'] = {}
  for (const [key, value] of Object.entries(group.attributes).slice(0, 20)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue
    if (typeof value === 'string') attributes[key] = safeGroupText(value)
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      attributes[key] = value
  }
  const text = group.template?.replaceAll('{nickname}', group.includeNickname ? name : '').trim()
  return {
    guidance: group.guidance,
    includeNickname: group.includeNickname,
    attributes,
    ...(text ? { fixedText: safeGroupText(text, 1000) } : {}),
  }
}
export function groupReplyEligibility(
  decision: RoutingDecision,
  gates: {
    active: boolean
    observeOnly: boolean
    publicReply: boolean
    voiceEnabled: boolean
    voiceReady: boolean
    voiceQuota: boolean
    windowReady: boolean
  },
): { text: boolean; voice: boolean } {
  if (!gates.active || gates.observeOnly) return { text: false, voice: false }
  const voice =
    decision.voice &&
    gates.voiceEnabled &&
    gates.voiceReady &&
    gates.voiceQuota &&
    gates.windowReady
  return { voice, text: gates.publicReply && (decision.text || (decision.voice && !voice)) }
}
