/** Voice input only fills a local reply draft; it never sends or translates. */
export interface AssistantVoiceCommand {
  action: 'start' | 'stop' | 'cancel'
  accountId: string
  rowId: string
}

export type AssistantVoiceResult =
  | { ok: true; data: { status: 'recording' | 'stopped' | 'cancelled'; rowId: string; text?: string; micWarning?: string; routeState?: 'live' | 'doubao' | 'unknown' } }
  | { ok: false; error: { code: string; message: string } }
