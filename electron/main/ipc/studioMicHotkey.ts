import { IPC_CHANNELS } from '../../../shared/ipcChannels'
import type { StudioMicHotkeyCommand, StudioMicHotkeyResult } from '../../../shared/studioMicHotkey'
import { StudioMicApi } from '../services/StudioMicApi'
import { VoiceMicRouter } from '../services/VoiceMicRouter'
import { typedIpcMainHandle } from '../utils/ipc'

let service: StudioMicApi | undefined
let router: VoiceMicRouter | undefined

/** Desktop, phone and dictation share one API write boundary. No native fallback is automatic. */
function studioMicApi() {
  service ??= new StudioMicApi()
  return service
}

export function getVoiceMicRouter() {
  router ??= new VoiceMicRouter({
    toggle: () => studioMicApi().execute({ action: 'toggle' }),
    setMuted: muted => studioMicApi().setMuted(muted),
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
      result = await studioMicApi().execute({ action: 'status' })
      if (!result.ok) return result
      const aligned = routing.alignOpen()
      if (!aligned.ok) return aligned
    } else if (action === 'toggle') result = await routing.manualToggle()
    else if (action === 'request-access') {
      // Kept for older renderers: the API needs no keyboard permission prompt.
      result = await studioMicApi().execute({ action: 'status' })
    } else result = await studioMicApi().execute(command)
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
