import path from 'node:path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { XiaomiCameraCommand, XiaomiCameraResult } from '../../../shared/xiaomiCamera'
import { XiaomiCameraFileConfig } from '../services/XiaomiCameraConfig'
import { XiaomiCameraService } from '../services/XiaomiCameraService'
import { typedIpcMainHandle } from '../utils/ipc'
import { XiaomiPreviewOwners } from './XiaomiPreviewOwners'

let service: XiaomiCameraService | undefined
const previewOwners = new XiaomiPreviewOwners()
function cameraService() {
  service ??= new XiaomiCameraService({
    store: new XiaomiCameraFileConfig(
      path.join(app.getPath('userData'), 'private', 'xiaomi-camera.json'),
    ),
  })
  return service
}

/** Shared by desktop IPC and the authenticated mobile controller. No implicit start/stop. */
export function executeXiaomiCameraCommand(
  command: XiaomiCameraCommand,
  signal?: AbortSignal,
): Promise<XiaomiCameraResult> {
  return cameraService().execute(command, signal)
}

export function setupXiaomiCameraIpc() {
  typedIpcMainHandle(
    IPC_CHANNELS.xiaomiCamera.request,
    async (event, command): Promise<XiaomiCameraResult> => {
      if (command?.action === 'preview-cancel') {
        if (Object.keys(command).length !== 1)
          return {
            ok: false,
            error: { code: 'XIAOMI_INVALID_COMMAND', message: '预览取消参数无效' },
          }
        previewOwners.cancel(event.sender.id)
        return { ok: true }
      }
      if (command?.action === 'preview')
        return previewOwners.run(event.sender, signal =>
          executeXiaomiCameraCommand(command, signal),
        )
      return executeXiaomiCameraCommand(command)
    },
  )
}
