import type { PlatformLiveTarget } from './platformSession'

export interface AssistantBroadcastBinding {
  browserSessionId: string
  target: PlatformLiveTarget
}
export interface AssistantBroadcastRoom {
  ready: boolean
  browserSessionId?: string
  target?: PlatformLiveTarget
}
export interface AssistantBroadcastState {
  accountId: string
  draftId: string
  revision: number
  chinese: string
  targetLanguage: string
  translatedText: string
  translatedRevision?: number
  /** Original text requires the operator's explicit send click, just like translated text. */
  useOriginal: boolean
  finalText: string
  roomReady: boolean
  bindingCurrent: boolean
  binding?: AssistantBroadcastBinding
  translation: { status: 'idle' | 'pending' | 'ready' | 'failed'; requestId?: string; error?: string }
  delivery: { status: 'idle' | 'sending' | 'sent' | 'unconfirmed' | 'failed'; requestId?: string; error?: string; sentAt?: number }
  canSend: boolean
}
export interface AssistantBroadcastPatch {
  chinese?: string
  translatedText?: string
  targetLanguage?: string
  useOriginal?: boolean
}
export type AssistantBroadcastCommand =
  | { action: 'state'; accountId: string }
  | { action: 'edit'; accountId: string; draftId: string; expectedRevision: number; patch: AssistantBroadcastPatch }
  | { action: 'translate'; accountId: string; draftId: string; expectedRevision: number; requestId: string }
  | { action: 'send'; accountId: string; draftId: string; expectedRevision: number; expectedText: string; requestId: string }
  | { action: 'clear'; accountId: string; draftId: string; expectedRevision: number }
export type AssistantBroadcastResult = { ok: true; data: AssistantBroadcastState } | { ok: false; error: { code: string; message: string } }
export interface AssistantBroadcastDependencies {
  room(accountId: string): AssistantBroadcastRoom
  translate(accountId: string, input: { chinese: string; targetLanguage: string; requestId: string }, signal: AbortSignal): Promise<string>
  /** This dependency must validate the expected binding again at the browser's actual send boundary. */
  send(accountId: string, text: string, signal: AbortSignal, binding: AssistantBroadcastBinding): Promise<void>
  /** Maximum final public message length; never an instruction to send automatically. */
  limit?(accountId: string): number
}
