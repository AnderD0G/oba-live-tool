import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import {
  type PlatformSessionCommand,
  PlatformSessionError,
  type PlatformSessionResult,
  validatePlatformSessionCommand,
} from '../../../shared/platformSession'
import { accountManager } from '../managers/AccountManager'
import { JsonLedger } from '../services/JsonLedger'
import { attachExistingChrome } from '../services/ExistingChromeConnection'
import { typedIpcMainHandle } from '../utils/ipc'
import { createAssistantDiagnostics, runAssistantDiagnosticStage } from '../services/AssistantDiagnostics'
import { registerAnalysisShutdown } from './analysisRoom'

let vault: JsonLedger<Record<string, string>> | undefined
let diagnostics: ReturnType<typeof createAssistantDiagnostics> | undefined
function stateVault() {
  if (!vault)
    vault = new JsonLedger<Record<string, string>>(
      join(app.getPath('userData'), 'platform-login-encrypted.json'),
      {},
    )
  return vault
}
function restore(accountId: string) {
  const stored = stateVault().data[accountId]
  if (!stored || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return undefined
  }
}
async function performPlatformSessionCommand(
  input: PlatformSessionCommand,
): Promise<PlatformSessionResult> {
  try {
    const command = validatePlatformSessionCommand(input)
    let session = accountManager.accountSessions.get(command.accountId)
    if (command.action === 'state' && !session)
      return {
        ok: true,
        data: {
          accountId: command.accountId,
          platform: 'tiktok',
          supported: true,
          browserOpen: false,
          loginStatus: 'closed',
          captureReady: false,
          roomReady: false,
          busy: false,
        },
      }
    if ((command.action === 'open-login' || command.action === 'attach-browser' || command.action === 'attach-existing-browser') && !session)
      session = accountManager.createSession('tiktok', {
        id: command.accountId,
        name: accountManager.getAccountName(command.accountId),
      })
    if (!session) throw new PlatformSessionError('SESSION_CLOSED', '请先打开登录浏览器')
    let data:
      | Awaited<ReturnType<typeof session.getPlatformSessionState>>
      | Awaited<ReturnType<typeof session.getLoginQrPreview>>
    switch (command.action) {
      case 'state':
        data = await session.getPlatformSessionState()
        break
      case 'open-login':
        data = await session.openLoginBrowser({
          storageState: restore(command.accountId),
          onStorageState: state => {
            if (!safeStorage.isEncryptionAvailable())
              throw new PlatformSessionError(
                'OPERATION_FAILED',
                '系统加密不可用，登录状态无法保存到本机',
              )
            const encrypted = safeStorage.encryptString(state).toString('base64')
            stateVault().change(saved => {
              saved[command.accountId] = encrypted
            })
          },
        })
        break
      case 'attach-browser':
        data = await session.attachBrowser(command.endpoint, command.pageUrl)
        break
      case 'attach-existing-browser':
        data = await attachExistingChrome(session, command.pageUrl)
        break
      case 'set-target':
        data = await session.setLiveTarget(command.target, command.sessionId)
        break
      case 'qr-preview':
        data = await session.getLoginQrPreview(command.sessionId)
        break
    }
    return { ok: true, data }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof PlatformSessionError ? error.code : 'OPERATION_FAILED',
        message: error instanceof Error ? error.message : '账号会话操作失败',
      },
    }
  }
}
export async function executePlatformSessionCommand(input: PlatformSessionCommand): Promise<PlatformSessionResult> {
  // Best-effort metadata timing must not alter authentication or expose stored browser state.
  try { diagnostics ??= createAssistantDiagnostics(join(app.getPath('userData'), 'logs')) } catch { /* Diagnostics are optional. */ }
  return runAssistantDiagnosticStage(diagnostics?.trace, {
    traceId: randomUUID(), action: 'platform-session', accountId: input?.accountId,
  }, input?.action === 'state' ? 'platform.state' : 'platform.command', () => performPlatformSessionCommand(input))
}
export function setupPlatformSessionIpc() {
  typedIpcMainHandle(IPC_CHANNELS.platformSession.request, (_event, command) =>
    executePlatformSessionCommand(command),
  )
  registerAnalysisShutdown(() => diagnostics?.flush() ?? Promise.resolve())
}
