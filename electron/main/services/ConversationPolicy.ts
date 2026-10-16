import {
  type ConversationLimits,
  defaultConversationLimits,
  validateConversationLimits,
} from '../../../shared/conversationPolicy'
import { resourceViewerIdentity } from './LiveViewerIdentity'

type State = {
  offTopic: number
  closedUntil: number
  models: number[]
  voices: number[]
  lastSeen: number
}
/** Resource limits are per account/viewer/session, independent of commercial value. */
export class ConversationPolicy {
  private states = new Map<string, State>()
  private limits: ConversationLimits
  constructor(
    limits: Partial<ConversationLimits> = {},
    private now = Date.now,
  ) {
    this.limits = { ...defaultConversationLimits, ...limits }
    validateConversationLimits(this.limits)
  }
  configure(limits: ConversationLimits) {
    validateConversationLimits(limits)
    this.limits = structuredClone(limits)
  }
  reset(account: string) {
    for (const key of this.states.keys())
      if (JSON.parse(key)[0] === account) this.states.delete(key)
  }
  private state(account: string, user: string) {
    const key = JSON.stringify([account, resourceViewerIdentity(user)])
    const now = this.now()
    let state = this.states.get(key)
    if (!state || now - state.lastSeen > 12 * 3600000) {
      state = { offTopic: 0, closedUntil: 0, models: [], voices: [], lastSeen: now }
      this.states.set(key, state)
    }
    state.lastSeen = now
    if (this.states.size > 10000) this.states.delete(this.states.keys().next().value!)
    if (state.closedUntil && state.closedUntil <= now) {
      state.offTopic = 0
      state.closedUntil = 0
    }
    state.models = state.models.filter(at => now - at < 60000)
    state.voices = state.voices.filter(at => now - at < 60000)
    return state
  }
  snapshot(account: string, user: string) {
    const s = this.state(account, user)
    return {
      offTopicTurns: s.offTopic,
      closedUntil: s.closedUntil,
      modelCallsThisMinute: s.models.length,
      voiceRepliesThisMinute: s.voices.length,
    }
  }
  before(account: string, user: string, text: string, business = false) {
    const s = this.state(account, user)
    // Common deterministic business recovery, including bare product numbers and confirmation replies.
    const relevant =
      business ||
      /^\s*[0-9０-９]{1,6}\s*$/.test(text) ||
      new RegExp(defaultConversationLimits.businessPattern, 'i').test(text) ||
      this.limits.businessPattern
        .split('|')
        .some(word => word && text.toLowerCase().includes(word.toLowerCase()))
    if (s.closedUntil > this.now() && !relevant)
      return { allow: false, reason: 'off-topic-cooldown' }
    if (s.models.length >= this.limits.modelCallsPerMinute)
      return { allow: false, reason: 'model-rate-limit' }
    return { allow: true, reason: '' }
  }
  reserveModel(account: string, user: string, text: string, business = false) {
    const gate = this.before(account, user, text, business)
    if (gate.allow) this.state(account, user).models.push(this.now())
    return gate
  }
  classified(account: string, user: string, intent: 'off_topic' | 'business') {
    const s = this.state(account, user)
    if (intent === 'business') return { kind: 'business' as const, reply: '' }
    if (s.closedUntil > this.now()) return { kind: 'silent' as const, reply: '' }
    s.offTopic++
    if (s.offTopic >= this.limits.offTopicTurns) {
      s.closedUntil = this.now() + this.limits.offTopicCooldownMs
      return { kind: 'close' as const, reply: this.limits.closingReply }
    }
    return { kind: 'brief' as const, reply: this.limits.briefReply }
  }
  reserveVoice(account: string, user: string) {
    const s = this.state(account, user)
    if (s.voices.length >= this.limits.voicePerMinute) return false
    s.voices.push(this.now())
    return true
  }
}
