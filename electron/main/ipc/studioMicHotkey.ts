import path from 'node:path'
import { app } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { StudioMicHotkeyCommand, StudioMicHotkeyResult } from '../../../shared/studioMicHotkey'
import { StudioMicHotkey } from '../services/StudioMicHotkey'
import { VoiceMicRouter } from '../services/VoiceMicRouter'
import { typedIpcMainHandle } from '../utils/ipc'

let service: StudioMicHotkey | undefined
let router: VoiceMicRouter | undefined

/** Desktop and phone share the same single-flight and cooldown boundary. */
function rawStudioMicHotkey() {
  if (service) return service
  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, 'studio-mic-hotkey')
    : path.join(app.getAppPath(), '.cache', 'native', 'studio-mic-hotkey')
  service = new StudioMicHotkey({ helperPath })
  return service
}

export function getVoiceMicRouter() {
  router ??= new VoiceMicRouter({
    toggle: () => rawStudioMicHotkey().execute({ action: 'toggle' }),
  })
  return router
}

const facade = {
  async execute(command: unknown): Promise<StudioMicHotkeyResult> {
    const routing = getVoiceMicRouter()
    const action =
      command &&
      typeof command === 'object' &&
      !Array.isArray(command) &&
      Object.keys(command).length === 1
        ? (command as StudioMicHotkeyCommand).action
        : undefined
    let result: StudioMicHotkeyResult
    if (action === 'align-open') {
      const aligned = routing.alignOpen()
      if (!aligned.ok) return aligned
      result = await rawStudioMicHotkey().execute({ action: 'status' })
    } else
      result =
        action === 'toggle'
          ? await routing.manualToggle()
          : await rawStudioMicHotkey().execute(command)
    return result.ok ? { ok: true, data: { ...result.data, ...routing.state() } } : result
  },
}

export function getStudioMicHotkey() {
  return facade
}

export function setupStudioMicHotkeyIpc() {
  typedIpcMainHandle(IPC_CHANNELS.studioMicHotkey.request, (_event, command) =>
    getStudioMicHotkey().execute(command),
  )
}
