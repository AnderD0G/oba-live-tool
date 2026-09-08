export interface CodexDraftRequest {
  requestId: string
  comment: string
  instructions: string
  model?: string
}

export type CodexDraftResult = { ok: true; text: string } | { ok: false; error: string }
export type CodexStatus =
  | { available: true; path: string; version: string }
  | { available: false; error: string }
