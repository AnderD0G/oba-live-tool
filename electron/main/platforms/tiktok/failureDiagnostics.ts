export type TikTokFailureStage = 'proxy' | 'constructor' | 'connect' | 'room-info' | 'signature' |
  'find-input' | 'inspect-draft' | 'fill' | 'wait-submit' | 'inspect-submit' | 'submit' | 'confirmation'

export interface TikTokSafeFailure {
  stage: TikTokFailureStage
  name: string
  code?: string
  status?: number
}

const NAMES = new Set([
  'Error', 'TypeError', 'TimeoutError', 'AbortError', 'RequestError', 'HTTPError', 'AxiosError',
  'TikTokLiveError', 'InvalidResponseError', 'InvalidRequestError', 'InvalidResponseCompositeError',
  'SignAPIError', 'SignatureRateLimitError', 'SignatureMissingTokensError', 'PremiumFeatureError',
  'AuthenticatedWebSocketConnectionError', 'ConnectTimeoutError', 'UserOfflineError',
  'AlreadyConnectedError', 'AlreadyConnectingError', 'InvalidUniqueIdError', 'PlatformSessionError',
])
const CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'ERR_NETWORK', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SESSION_CHANGED', 'ROOM_NOT_READY',
  'COMMENT_DRAFT_CHANGED', 'COMMENT_CONTROL_UNAVAILABLE',
])
const SIGNATURE_ERRORS = new Set([
  'SignAPIError', 'SignatureRateLimitError', 'SignatureMissingTokensError', 'PremiumFeatureError',
  'AuthenticatedWebSocketConnectionError',
])

/** No arbitrary provider strings, messages, URLs, headers or credentials can leave this boundary. */
export function safeTikTokFailure(error: unknown, stage: TikTokFailureStage): TikTokSafeFailure {
  const read = (value: unknown, key: string): unknown => {
    try { return value && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[key] : undefined }
    catch { return undefined }
  }
  const ownName = read(error, 'name')
  const constructorName = read(read(error, 'constructor'), 'name')
  const name = typeof ownName === 'string' && NAMES.has(ownName) && ownName !== 'Error' ? ownName :
    typeof constructorName === 'string' && NAMES.has(constructorName) ? constructorName : 'Error'
  const route = read(read(error, 'config'), 'routeId')
  if (stage === 'connect') {
    if (SIGNATURE_ERRORS.has(name) || route === 'fetchSignedWebSocketFromEulerRoute' || route === 'fetchWebcastSignatureFromEulerRoute') stage = 'signature'
    else if (route === 'fetchRoomInfoRoute' || route === 'fetchRoomInfoFromApiLiveRoute' || route === 'fetchRoomInfoFromHtmlRoute') stage = 'room-info'
  }
  const code = read(error, 'code')
  const response = read(error, 'response')
  const statuses = [read(response, 'status'), read(response, 'statusCode'), read(error, 'status'), read(error, 'statusCode')]
  const status = statuses.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599) as number | undefined
  return {
    stage, name,
    ...(typeof code === 'string' && CODES.has(code) ? { code } : {}),
    ...(status === undefined ? {} : { status }),
  }
}
