import { join } from 'node:path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { createAssistantDiagnostics } from '../services/AssistantDiagnostics'
import { AssistantVoiceCoordinator } from '../services/AssistantVoiceCoordinator'
import { typedIpcMainHandle } from '../utils/ipc'
import { executeAssistantVoiceScene } from './assistantDesk'
import { registerAnalysisShutdown } from './analysisRoom'
import { getVoiceMicRouter } from './studioMicHotkey'
import { isMockAssistantSelected } from './mockAssistant'

let voice: AssistantVoiceCoordinator | undefined
let diagnostics: ReturnType<typeof createAssistantDiagnostics> | undefined

/** Desktop and all account-bound mobile listeners share one microphone owner. */
export function getAssistantVoice(): AssistantVoiceCoordinator {
  if (!voice) {
    diagnostics ??= createAssistantDiagnostics(join(app.getPath('userData'), 'logs'))
    voice = new AssistantVoiceCoordinator({ state: executeAssistantVoiceScene,
      trace: event => { if (!event.accountId || !isMockAssistantSelected(event.accountId)) diagnostics!.trace(event) }, micRouter: getVoiceMicRouter() })
  }
  return voice
}

export function setupAssistantVoiceIpc() {
  typedIpcMainHandle(IPC_CHANNELS.assistantVoice.request, (_event, command) => getAssistantVoice().execute(command))
  // Register without constructing a coordinator or contacting the microphone.
  registerAnalysisShutdown(async () => {
    try { await voice?.dispose() } finally { await diagnostics?.flush() }
  })
}
