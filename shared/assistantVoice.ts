/** Voice input only fills a local reply draft; it never sends or translates. */
export interface AssistantVoiceCommand {
  action: 'start' | 'stop' | 'cancel'
  accountId: string
  rowId: string
}

export type AssistantVoiceResult =
  | { ok: true; data: { status: 'recording' | 'stopped' | 'cancelled'; rowId: string; text?: string } }
  | { ok: false; error: { code: string; message: string } }
