import type { AnalysisSession,BusinessObservation } from '../../../shared/analysisRoom'

export type MainEvents = {
  'analysis-session-changed':AnalysisSession
  'business-observation': BusinessObservation
  'business-listener-invalidated': { accountId: string; reason: string }
  'live-comment': { accountId: string; comment: LiveMessage }
  'comment-listener-stopped': { accountId: string }
  'page-closed': {
    sessionId?: string
    accountId: string
  }
  'providers-updated': Record<string, ProviderInfo>
}
