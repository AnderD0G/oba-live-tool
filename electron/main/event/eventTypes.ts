export type MainEvents = {
  'live-comment': { accountId: string; comment: LiveMessage }
  'comment-listener-stopped': { accountId: string }
  'page-closed': {
    accountId: string
  }
  'providers-updated': Record<string, ProviderInfo>
}
