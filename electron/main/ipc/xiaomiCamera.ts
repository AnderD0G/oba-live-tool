import path from 'node:path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { XiaomiCameraCommand, XiaomiCameraResult } from '../../../shared/xiaomiCamera'
import { XiaomiCameraFileConfig } from '../services/XiaomiCameraConfig'
import { XiaomiCameraService } from '../services/XiaomiCameraService'
import { typedIpcMainHandle } from '../utils/ipc'

let service: XiaomiCameraService | undefined
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
): Promise<XiaomiCameraResult> {
  return cameraService().execute(command)
}

export function setupXiaomiCameraIpc() {
  typedIpcMainHandle(IPC_CHANNELS.xiaomiCamera.request, (_event, command) =>
    executeXiaomiCameraCommand(command),
  )
}
