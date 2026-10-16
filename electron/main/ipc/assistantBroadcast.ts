import type { AssistantBroadcastCommand, AssistantBroadcastResult, AssistantBroadcastRoom } from '../../../shared/assistantBroadcast'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import { accountManager } from '../managers/AccountManager'
import { AssistantBroadcastService } from '../services/AssistantBroadcastService'
import { typedIpcMainHandle } from '../utils/ipc'
import { registerAnalysisShutdown } from './analysisRoom'
import { getAssistantDesk } from './assistantDesk'
import { getMockRuntime, isMockAssistantSelected } from './mockAssistant'

const rooms = new Map<string, AssistantBroadcastRoom>()
let service: AssistantBroadcastService | undefined
let closing = false

async function refreshRoom(accountId: string) {
  const account = accountManager.accountSessions.get(accountId)
  try {
    const state = await account?.getPlatformSessionState()
    if (accountManager.accountSessions.get(accountId) !== account || !state || state.busy || state.loginStatus !== 'authenticated' || !state.roomReady || !state.sessionId || !state.target)
      rooms.set(accountId, { ready: false })
    else rooms.set(accountId, { ready: true, browserSessionId: state.sessionId, target: state.target })
  } catch { rooms.set(accountId, { ready: false }) }
}

function getBroadcast() {
  service ??= new AssistantBroadcastService({
    room: accountId => rooms.get(accountId) ?? { ready: false },
    translate: async (accountId, input, signal) => {
      const desk = isMockAssistantSelected(accountId) ? await getMockRuntime().serviceFor(accountId) : getAssistantDesk()
      const result = await desk.translateFreeformDraft(accountId, input, signal)
      await refreshRoom(accountId)
      return result
    },
    send: async (accountId, text, signal, binding) => {
      const account = accountManager.accountSessions.get(accountId)
      if (!account || !(await account.sendManualAssistantReply(text, signal, { sessionId: binding.browserSessionId, target: binding.target })))
        throw new Error('平台未确认公屏发送，请在直播间核对')
      await refreshRoom(accountId)
    },
  })
  return service
}

function validate(command: AssistantBroadcastCommand) {
  if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.accountId !== 'string' || command.accountId.length < 1 || command.accountId.length > 256 || /\s/.test(command.accountId))
    throw new Error('自由发言账号参数无效')
  const fields = {
    state: ['action', 'accountId'],
    edit: ['action', 'accountId', 'draftId', 'expectedRevision', 'patch'],
    translate: ['action', 'accountId', 'draftId', 'expectedRevision', 'requestId'],
    send: ['action', 'accountId', 'draftId', 'expectedRevision', 'expectedText', 'requestId'],
    clear: ['action', 'accountId', 'draftId', 'expectedRevision'],
  }
  const allowed = Object.hasOwn(fields, command.action) ? fields[command.action] : undefined
  if (!allowed || Object.keys(command).length !== allowed.length || Object.keys(command).some(key => !allowed.includes(key)))
    throw new Error('自由发言操作参数无效')
}

export async function executeAssistantBroadcast(command: AssistantBroadcastCommand): Promise<AssistantBroadcastResult> {
  try {
    validate(command)
    if (closing) throw new Error('应用正在关闭，自由发言已停止接收操作')
    await refreshRoom(command.accountId)
    const composer = getBroadcast()
    let data
    switch (command.action) {
      case 'state': data = composer.state(command.accountId); break
      case 'edit': data = composer.edit(command.accountId, command.draftId, command.expectedRevision, command.patch); break
      case 'translate': data = await composer.translate(command.accountId, command.draftId, command.expectedRevision, command.requestId); break
      case 'send': data = await composer.send(command.accountId, command.draftId, command.expectedRevision, command.expectedText, command.requestId); break
      case 'clear': data = composer.clear(command.accountId, command.draftId, command.expectedRevision); break
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROADCAST_INVALID_COMMAND', message: error instanceof Error ? error.message : '自由发言操作失败' } }
  }
}

/** A separate draft owner shares the existing microphone lease without inventing a viewer row. */
export async function resolveAssistantBroadcastVoiceScope(accountId: string, rowId: string) {
  if (!rowId.startsWith('broadcast:')) return undefined
  if (closing) return null
  await refreshRoom(accountId)
  try { return getBroadcast().voiceScope(accountId, rowId.slice('broadcast:'.length)) }
  catch { return null }
}

export function setupAssistantBroadcastIpc() {
  typedIpcMainHandle(IPC_CHANNELS.assistantBroadcast.request, (_event, command) => executeAssistantBroadcast(command))
  registerAnalysisShutdown(async () => {
    closing = true
    await service?.dispose()
    rooms.clear()
  })
}
