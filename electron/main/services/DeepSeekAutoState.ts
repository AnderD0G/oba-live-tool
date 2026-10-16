let activeAccount = ''
let unifiedReplies = false
let conversationVoice = false
export function setConversationVoiceActive(active: boolean) {
  conversationVoice = active
}
export function isConversationVoiceActive() {
  return conversationVoice
}

export function setDeepSeekAutoAccount(accountId: string, unified = false) {
  activeAccount = accountId
  unifiedReplies = Boolean(accountId && unified)
}
export function ownsUnifiedEntryReplies(accountId: string) {
  return unifiedReplies && isDeepSeekAutoActive(accountId)
}

export function isDeepSeekAutoActive(accountId: string) {
  return Boolean(accountId && activeAccount === accountId)
}
