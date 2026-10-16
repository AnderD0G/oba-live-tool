export type StudioMicHotkeyCommand = { action: 'status' | 'request-access' | 'toggle' | 'align-open' }

export interface StudioMicHotkeyState {
  supported: boolean
  running: boolean
  accessGranted: boolean
  hotkey: string
  /** A sent keyboard event cannot prove the broadcast microphone's state. */
  micState: 'unknown'
  sent?: boolean
  message: string
  routeState?: 'live' | 'doubao' | 'unknown'
  linked?: boolean
}

export type StudioMicHotkeyResult =
  | { ok: true; data: StudioMicHotkeyState }
  | { ok: false; error: { code: string; message: string } }
