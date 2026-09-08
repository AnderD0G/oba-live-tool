import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'

export function setupUpdateIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.updater.checkUpdate, async () => {
    return undefined
  })

  typedIpcMainHandle(IPC_CHANNELS.updater.startDownload, () => {})

  typedIpcMainHandle(IPC_CHANNELS.updater.quitAndInstall, () => {
    return
  })
}
