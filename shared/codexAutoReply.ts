export type AutoReplyPhase =
  | 'queued'
  | 'generating'
  | 'sending'
  | 'sent'
  | 'speaking'
  | 'spoken'
  | 'failed'
  | 'cancelled'
  | 'skipped'
export interface CodexAutoRecord {
  id: string
  accountId: string
  nickname: string
  comment: string
  text: string
  phase: AutoReplyPhase
  detail: string
  delivery?: 'text' | 'voice'
}
export interface CodexAutoState {
  enabled: boolean
  accountId: string | null
  message: string
  records: CodexAutoRecord[]
  delivery?: 'text' | 'voice'
}
export interface CodexAutoSettings {
  accountId: string
  enabled: boolean
  instructions: string
  model?: string
  blockList?: string[]
  delivery?: 'text' | 'voice'
}
