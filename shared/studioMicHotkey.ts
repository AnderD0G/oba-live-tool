export type StudioMicHotkeyCommand = {
  action: 'status' | 'request-access' | 'toggle' | 'align-open' | 'mute' | 'unmute'
}

export interface StudioMicHotkeyState {
  supported: boolean
  running: boolean
  accessGranted: boolean
  hotkey: string
  /** Native hotkeys remain unknown; the local API returns its actual snapshot/acknowledgement. */
  micState: 'muted' | 'unmuted' | 'unknown'
  backend?: 'api' | 'hotkey'
  beforeMuted?: boolean
  sent?: boolean
  message: string
  routeState?: 'live' | 'doubao' | 'unknown'
  linked?: boolean
}

export type StudioMicHotkeyResult =
  | { ok: true; data: StudioMicHotkeyState }
  | { ok: false; error: { code: string; message: string } }
