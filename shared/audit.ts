export type AuditEntry = {
  id: string
  traceId: string
  at: number
  origin: 'hook' | 'human-ai' | 'analysis-ui' | 'analysis-api' | 'analysis-system'
  phase: 'event' | 'decision' | 'action'
  status: 'received' | 'matched' | 'skipped' | 'pending' | 'sent' | 'done' | 'failed'
  accountId?: string
  platform?: string
  eventType?: string
  userId?: string
  userName?: string
  message?: string
  scene?: string
  model?: string
  ruleId?: string
  ruleName?: string
  ruleRevision?: string
  actionId?: string
  actionType?: string
  content?: string
  detail?: string
  preview?: boolean
}

export type AuditDraft = Omit<AuditEntry, 'id' | 'at'>
