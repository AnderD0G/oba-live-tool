import { join } from 'node:path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { accountManager } from '../managers/AccountManager'
import { createAssistantDiagnostics } from '../services/AssistantDiagnostics'
import { MobileAssistantAccessManager } from '../services/MobileAssistantAccessManager'
import { MobileAssistantDeskServer } from '../services/MobileAssistantDeskServer'
import { typedIpcMainHandle } from '../utils/ipc'
import { executeAssistantDeskCommand, executeAssistantVoiceScene } from './assistantDesk'
import { getAssistantVoice } from './assistantVoice'
import { registerAnalysisShutdown } from './analysisRoom'

export function setupAssistantMobileIpc() {
  const diagnostics = createAssistantDiagnostics(join(app.getPath('userData'), 'logs'))
  const manager = new MobileAssistantAccessManager({
    accountName: accountId => accountManager.getAccountName(accountId),
    createServer: (accountId, accountName) => new MobileAssistantDeskServer({
      accountId,
      accountName,
      assetDirectory: join(app.getAppPath(), app.isPackaged ? 'dist' : 'public', 'assistant-mobile'),
      execute: executeAssistantDeskCommand,
      voiceScene: executeAssistantVoiceScene,
      trace: diagnostics.trace,
      voice: command => getAssistantVoice().execute(command),
    }),
  })
  typedIpcMainHandle(IPC_CHANNELS.assistantMobile.request, (_event, command) =>
    manager.execute(command))
  registerAnalysisShutdown(async () => { try { await manager.dispose() } finally { await diagnostics.flush() } })
  app.once('before-quit', () => { void manager.dispose().catch(() => {}) })
}

