import {
  isTikTokUsername,
  parseTikTokAttachPage as parseAttachPage,
  validateBrowserAttachEndpoint as validateAttachEndpoint,
} from './assistantDeskContract.mjs'

export interface PlatformLiveTarget {
  username: string
  url: string
}

/** Public browser state deliberately contains no cookie or storage-state data. */
export interface PlatformLoginSnapshot {
  browserOpen: boolean
  loginStatus: 'closed' | 'required' | 'authenticated'
  target?: PlatformLiveTarget
  roomReady: boolean
}

export interface PlatformSessionState extends PlatformLoginSnapshot {
  accountId: string
  platform: string
  supported: boolean
  /** Changes whenever a browser is recreated; never a platform authentication token. */
  sessionId?: string
  captureReady: boolean
  busy: boolean
}

export interface PlatformLoginQrPreview {
  mimeType: 'image/png'
  dataUrl: string
  capturedAt: number
  width: number
  height: number
}

export type PlatformSessionCommand =
  | { action: 'state'; accountId: string }
  | { action: 'open-login'; accountId: string }
  | { action: 'set-target'; accountId: string; sessionId: string; target: string }
  | { action: 'qr-preview'; accountId: string; sessionId: string }
  | { action: 'attach-browser'; accountId: string; endpoint: string; pageUrl: string }
  | { action: 'attach-existing-browser'; accountId: string; pageUrl: string }

export type PlatformSessionErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_TARGET'
  | 'UNSUPPORTED_PLATFORM'
  | 'SESSION_CLOSED'
  | 'SESSION_CHANGED'
  | 'SESSION_BUSY'
  | 'LOGIN_REQUIRED'
  | 'ROOM_NOT_READY'
  | 'QR_NOT_VISIBLE'
  | 'QR_CAPTURE_FAILED'
  | 'OPERATION_FAILED'
  | 'PAGE_NOT_FOUND'
  | 'PAGE_AMBIGUOUS'
  | 'BROWSER_IN_USE'
  | 'ATTACH_FAILED'
  | 'CHROME_DEBUG_NOT_ENABLED'
  | 'CHROME_DEBUG_INVALID'

export class PlatformSessionError extends Error {
  constructor(readonly code: PlatformSessionErrorCode, message: string) {
    super(message)
    this.name = 'PlatformSessionError'
  }
}

export type PlatformSessionResult<T = PlatformSessionState | PlatformLoginQrPreview> =
  | { ok: true; data: T }
  | { ok: false; error: { code: PlatformSessionErrorCode; message: string } }

export function validateBrowserAttachEndpoint(input: unknown): string {
  try { return validateAttachEndpoint(input) }
  catch { throw new PlatformSessionError('INVALID_COMMAND', 'CDP endpoint 必须是带端口的本机 loopback HTTP 或 browser WebSocket 地址') }
}

export function parseTikTokAttachPage(input: unknown): PlatformLiveTarget {
  try { return parseAttachPage(input) }
  catch { throw new PlatformSessionError('INVALID_TARGET', 'pageUrl 必须是当前已打开的 https://www.tiktok.com/@账号/live 直播页面') }
}

/** Fixed host/path allowlist: arbitrary URLs never become a browser navigation. */
export function parseTikTokLiveTarget(input: unknown): PlatformLiveTarget {
  const fail = (): never => { throw new PlatformSessionError('INVALID_TARGET', '请输入合法的 TikTok @账号或 TikTok 直播间网址') }
  if (typeof input !== 'string' || input.length > 512) return fail()
  const value = input.trim()
  let username: string
  if (/^https:\/\//i.test(value)) {
    // Inspect the original authority as URL() normalizes an explicit default port away.
    if (!/^https:\/\/(?:www\.)?tiktok\.com\//i.test(value)) return fail()
    let url: URL
    try { url = new URL(value) } catch { return fail() }
    if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || url.username || url.password || url.port || url.hash) return fail()
    const match = /^\/@([^/]+)(?:\/live)?\/?$/.exec(url.pathname)
    if (!match) return fail()
    username = match[1]
  } else {
    username = value.replace(/^@/, '')
  }
  if (!isTikTokUsername(username)) return fail()
  return { username, url: `https://www.tiktok.com/@${username}/live` }
}

export function validatePlatformSessionCommand(input: unknown): PlatformSessionCommand {
  const invalid = (): never => { throw new PlatformSessionError('INVALID_COMMAND', '账号会话命令无效') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const command = input as Record<string, unknown>
  const validId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value)
  if (!validId(command.accountId)) return invalid()
  const accountId = command.accountId as string
  const allowed = command.action === 'attach-existing-browser' ? ['action', 'accountId', 'pageUrl'] : command.action === 'attach-browser' ? ['action', 'accountId', 'endpoint', 'pageUrl'] : command.action === 'set-target' ? ['action', 'accountId', 'sessionId', 'target'] : command.action === 'qr-preview' ? ['action', 'accountId', 'sessionId'] : ['action', 'accountId']
  if (Object.keys(command).some(key => !allowed.includes(key))) return invalid()
  if (command.action === 'state' || command.action === 'open-login') return { action: command.action, accountId }
  if (command.action === 'attach-existing-browser') {
    parseTikTokAttachPage(command.pageUrl)
    return { action: command.action, accountId, pageUrl: command.pageUrl as string }
  }
  if (command.action === 'attach-browser') {
    const endpoint = validateBrowserAttachEndpoint(command.endpoint)
    parseTikTokAttachPage(command.pageUrl)
    return { action: command.action, accountId, endpoint, pageUrl: command.pageUrl as string }
  }
  if (!validId(command.sessionId)) return invalid()
  const sessionId = command.sessionId as string
  if (command.action === 'qr-preview') return { action: command.action, accountId, sessionId }
  if (command.action === 'set-target') {
    parseTikTokLiveTarget(command.target)
    return { action: command.action, accountId, sessionId, target: command.target as string }
  }
  return invalid()
}
