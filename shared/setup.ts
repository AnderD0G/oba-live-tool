export interface SetupStatus {
  version: string
  system: string
  browser: string
  browserError?: string
  codex: {
    available: boolean
    version?: string
    bundled?: boolean
    loggedIn?: boolean
    error?: string
  }
  printers: string[]
  printerError?: string
}
export type SetupAction = 'status' | 'login' | 'cancelLogin' | 'printers' | 'browserDownload'
export type SetupResult =
  | { ok: true; status?: SetupStatus; message?: string }
  | { ok: false; error: string }
