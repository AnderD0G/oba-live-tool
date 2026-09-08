export interface CodexDraftRequest {
  requestId: string
  comment: string
  instructions: string
  model?: string
}

export interface CodexDraftProgress {
  message: string
  text?: string
}
export type CodexDraftResult =
  | { ok: true; text: string; elapsedMs?: number; firstTextMs?: number }
  | { ok: false; error: string }
export type CodexStatus =
  | { available: true; path: string; version: string; pid?: number }
  | { available: false; error: string }
