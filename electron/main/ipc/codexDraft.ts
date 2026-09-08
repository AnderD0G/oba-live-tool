import { IPC_CHANNELS } from 'shared/ipcChannels'
import { CodexDraftService } from '#/services/CodexDraftService'
import { typedIpcMainHandle } from '#/utils'

export function setupCodexDraftIpcHandlers() {
  const service = new CodexDraftService()
  const owners = new Set<number>()
  typedIpcMainHandle(IPC_CHANNELS.codexDraft.status, () => service.status())
  typedIpcMainHandle(IPC_CHANNELS.codexDraft.generate, (event, request) => {
    const owner = event.sender.id
    if (!owners.has(owner)) {
      owners.add(owner)
      event.sender.once('destroyed', () => {
        service.cancel(owner)
        owners.delete(owner)
      })
    }
    return service.generate(owner, request)
  })
  typedIpcMainHandle(IPC_CHANNELS.codexDraft.cancel, (event, id) =>
    service.cancel(event.sender.id, id),
  )
}
