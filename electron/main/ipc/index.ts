import { setupAIChatIpcHandlers } from './aichat'
import { setupAssistantDeskIpc } from './assistantDesk'
import { setupMockAssistantIpc } from './mockAssistant'
import { setupAssistantMobileIpc } from './assistantMobile'
import { setupAssistantVoiceIpc } from './assistantVoice'
import { setupStudioMicHotkeyIpc } from './studioMicHotkey'
import { setupXiaomiCameraIpc } from './xiaomiCamera'
import { setupPlatformSessionIpc } from './platformSession'
import { setupAnalysisRoomIpcHandlers } from './analysisRoom'
import { setupAppIpcHandlers } from './app'
import { setupAuditIpcHandlers } from './audit'
import { setupAutoMessageIpcHandlers } from './autoMessage'
import { setupAutoPopUpIpcHandlers } from './autoPopUp'
import { setupBrowserIpcHandlers } from './browser'
import { setupCodexDraftIpcHandlers } from './codexDraft'
import { setupAutoReplyIpcHandlers } from './commentListener'
import { setupLiveControlIpcHandlers } from './connection'
import { setupDeepSeekAutoIpcHandlers } from './deepSeekAuto'
import { setupDirectorIpcHandlers } from './director'
import { setupDirectorExperimentIpc } from './directorExperiment'
import { setupHookIpcHandlers } from './hooks'
import { setupEffectGroupIpc } from './effectGroups'
import { setupObsEffectIpcHandlers } from './obsEffect'
import { setupPinCommentIpcHandler } from './pinComment'
import { setupRedPacketIpcHandlers } from './redPacket'
import { setupUpdateIpcHandlers } from './update'

export async function setupIpcHandlers() {
  // Registration is synchronous; retained Analysis data is activated explicitly.
  void setupAnalysisRoomIpcHandlers()
  setupLiveControlIpcHandlers()
  setupAuditIpcHandlers()
  setupObsEffectIpcHandlers()
  setupHookIpcHandlers()
  setupDirectorIpcHandlers()
  setupDirectorExperimentIpc()
  setupDeepSeekAutoIpcHandlers()
  setupPlatformSessionIpc()
  setupAssistantDeskIpc()
  setupMockAssistantIpc()
  setupAssistantMobileIpc()
  setupAssistantVoiceIpc()
  setupStudioMicHotkeyIpc()
  setupXiaomiCameraIpc()
  setupEffectGroupIpc()
  setupAIChatIpcHandlers()
  setupCodexDraftIpcHandlers()
  setupAutoPopUpIpcHandlers()
  setupAutoReplyIpcHandlers()
  setupAutoMessageIpcHandlers()
  setupBrowserIpcHandlers()
  setupAppIpcHandlers()
  setupUpdateIpcHandlers()
  setupPinCommentIpcHandler()
  setupRedPacketIpcHandlers()
}
