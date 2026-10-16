export type LiveAIProvider = 'deepseek' | 'openai' | 'doubao' | 'custom'
export interface LiveAIConnection {
  provider: LiveAIProvider
  baseURL: string
  model: string
  jsonMode: boolean
  disableThinking: boolean
}
export const LIVE_AI_ENDPOINTS: Record<LiveAIProvider, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  custom: '',
}
export function normalizeLiveConnection(value: {
  model: string
  provider?: LiveAIProvider
  baseURL?: string
  jsonMode?: boolean
  disableThinking?: boolean
}): LiveAIConnection {
  const provider = value.provider ?? 'deepseek'
  if (!(provider in LIVE_AI_ENDPOINTS)) throw new Error('AI 供应商无效')
  const url = new URL(value.baseURL?.trim() || LIVE_AI_ENDPOINTS[provider])
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('API 地址须为 HTTPS 或本机 HTTP，不能包含密钥或查询参数')
  const model =
    provider === 'deepseek' && ['deepseek-chat', 'deepseek-reasoner'].includes(value.model)
      ? 'deepseek-flash'
      : value.model.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error('模型名称无效')
  return {
    provider,
    baseURL: url.toString().replace(/\/+$/, ''),
    model,
    jsonMode: value.jsonMode ?? true,
    disableThinking: value.disableThinking ?? provider === 'deepseek',
  }
}
export function liveCredentialScope(
  account: string,
  connection: Pick<LiveAIConnection, 'baseURL'>,
) {
  return JSON.stringify([account, connection.baseURL])
}
